/**
 * Minimal Telegram Bot API types — only the fields this bot reads.
 * https://core.telegram.org/bots/api
 */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  reply_to_message?: TgMessage;
  new_chat_members?: TgUser[];
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgInlineQuery {
  id: string;
  from: TgUser;
  query: string;
  offset: string;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  new_chat_member?: { status?: string; user?: TgUser };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
  inline_query?: TgInlineQuery;
  my_chat_member?: TgChatMemberUpdated;
}

export interface TgInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export type TgInlineKeyboard = TgInlineKeyboardButton[][];

export interface TgSendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: "HTML";
  link_preview_options?: { is_disabled?: boolean };
  reply_parameters?: {
    message_id: number;
    allow_sending_without_reply?: boolean;
  };
  reply_markup?: { inline_keyboard: TgInlineKeyboard };
  disable_notification?: boolean;
}

export interface TgInlineQueryResultArticle {
  type: "article";
  id: string;
  title: string;
  description?: string;
  thumbnail_url?: string;
  input_message_content: {
    message_text: string;
    parse_mode?: "HTML";
    link_preview_options?: { is_disabled?: boolean };
  };
  reply_markup?: { inline_keyboard: TgInlineKeyboard };
}

export interface TgBotCommand {
  command: string;
  description: string;
}

export interface TgChatMember {
  status:
    | "creator"
    | "administrator"
    | "member"
    | "restricted"
    | "left"
    | "kicked";
  user: TgUser;
}
