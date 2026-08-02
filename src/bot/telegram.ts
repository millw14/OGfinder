import {
  TgUpdate,
  TgUser,
  TgMessage,
  TgSendMessageParams,
  TgInlineKeyboard,
  TgInlineQueryResultArticle,
  TgBotCommand,
  TgChatMember,
} from "./bot-types";

/**
 * Minimal dependency-free Telegram Bot API client (plain fetch).
 * Handles 429 retry_after, transient network retries, and group→supergroup
 * chat id migration.
 */

const API_BASE = "https://api.telegram.org";

/** Long poll wait (server side); fetch timeout must exceed it. */
export const POLL_TIMEOUT_SEC = 50;

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    public readonly description: string,
    public readonly retryAfterSec?: number,
    public readonly migrateToChatId?: number
  ) {
    super(`${method}: ${code} ${description}`);
    this.name = "TelegramApiError";
  }
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TelegramClient {
  private readonly base: string;
  /** Called when Telegram reports a group upgraded to a supergroup. */
  onChatMigrated: ((oldId: number, newId: number) => void) | null = null;

  constructor(token: string) {
    this.base = `${API_BASE}/bot${token}`;
  }

  /**
   * Core call. Retries transient network errors and 429s (bounded); throws
   * TelegramApiError for API-level failures.
   */
  async call<T>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number; maxRetries?: number }
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const maxRetries = opts?.maxRetries ?? 3;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params ?? {}),
          signal: controller.signal,
        });
        const data = (await res.json()) as TgResponse<T>;

        if (data.ok) return data.result as T;

        const code = data.error_code ?? res.status;
        const desc = data.description ?? "unknown error";
        const retryAfter = data.parameters?.retry_after;

        if (code === 429 && attempt < maxRetries) {
          await sleep(Math.min((retryAfter ?? 3) * 1000, 30_000));
          continue;
        }
        throw new TelegramApiError(
          method,
          code,
          desc,
          retryAfter,
          data.parameters?.migrate_to_chat_id
        );
      } catch (err) {
        if (err instanceof TelegramApiError) throw err;
        // Network / abort / JSON error — retry with backoff.
        lastErr = err;
        if (attempt < maxRetries) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`${method}: network failure`);
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe");
  }

  getUpdates(
    offset: number | undefined,
    allowedUpdates: string[]
  ): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      {
        ...(offset !== undefined ? { offset } : {}),
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: allowedUpdates,
      },
      { timeoutMs: (POLL_TIMEOUT_SEC + 10) * 1000, maxRetries: 0 }
    );
  }

  /**
   * sendMessage with two safety nets:
   *  - group→supergroup migration: retries once with the new chat id
   *  - HTML parse errors (weird token names): retries without parse_mode
   */
  async sendMessage(params: TgSendMessageParams): Promise<TgMessage> {
    try {
      return await this.call<TgMessage>("sendMessage", { ...params });
    } catch (err) {
      if (err instanceof TelegramApiError) {
        if (err.migrateToChatId) {
          const newId = err.migrateToChatId;
          if (typeof params.chat_id === "number") {
            this.onChatMigrated?.(params.chat_id, newId);
          }
          return await this.call<TgMessage>("sendMessage", {
            ...params,
            chat_id: newId,
          });
        }
        if (
          params.parse_mode &&
          err.code === 400 &&
          /parse entities/i.test(err.description)
        ) {
          const { parse_mode: _pm, ...rest } = params;
          return await this.call<TgMessage>("sendMessage", { ...rest });
        }
      }
      throw err;
    }
  }

  async editMessageText(params: {
    chat_id: number;
    message_id: number;
    text: string;
    parse_mode?: "HTML";
    link_preview_options?: { is_disabled?: boolean };
    reply_markup?: { inline_keyboard: TgInlineKeyboard };
  }): Promise<void> {
    try {
      await this.call("editMessageText", { ...params });
    } catch (err) {
      if (err instanceof TelegramApiError && err.code === 400) {
        if (/parse entities/i.test(err.description) && params.parse_mode) {
          const { parse_mode: _pm, ...rest } = params;
          await this.call("editMessageText", { ...rest });
          return;
        }
        // "message is not modified" / message deleted — non-fatal.
        if (/not modified|message to edit not found/i.test(err.description)) {
          return;
        }
      }
      throw err;
    }
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  answerCallbackQuery(
    id: string,
    text?: string,
    showAlert = false
  ): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text, show_alert: showAlert } : {}),
    });
  }

  answerInlineQuery(
    id: string,
    results: TgInlineQueryResultArticle[],
    cacheTimeSec = 300
  ): Promise<boolean> {
    return this.call<boolean>("answerInlineQuery", {
      inline_query_id: id,
      results,
      cache_time: cacheTimeSec,
    });
  }

  setMyCommands(
    commands: TgBotCommand[],
    scope?: { type: string }
  ): Promise<boolean> {
    return this.call<boolean>("setMyCommands", {
      commands,
      ...(scope ? { scope } : {}),
    });
  }

  getChatMember(chatId: number, userId: number): Promise<TgChatMember> {
    return this.call<TgChatMember>("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
  }

  sendChatAction(chatId: number, action = "typing"): Promise<boolean> {
    return this.call<boolean>("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  setWebhook(
    url: string,
    secretToken: string,
    allowedUpdates: string[]
  ): Promise<boolean> {
    return this.call<boolean>("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: allowedUpdates,
      drop_pending_updates: false,
    });
  }

  deleteWebhook(): Promise<boolean> {
    return this.call<boolean>("deleteWebhook", {
      drop_pending_updates: false,
    });
  }
}
