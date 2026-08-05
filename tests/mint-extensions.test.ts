import { describe, it, expect } from "vitest";
import { parseMintExtensions } from "@/lib/helius";

/**
 * Fixtures are VERBATIM getAccountInfo(jsonParsed) payloads captured from
 * mainnet via Helius on 2026-08-05 (trimmed to the fields we read). They are
 * the contract: if Solana's parser changes shape, these fail loudly instead of
 * the engine silently deciding everything is fine.
 */
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_LEGACY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function response(
  owner: string,
  info: Record<string, unknown>,
  type = "mint"
): unknown {
  return {
    jsonrpc: "2.0",
    result: { value: { owner, data: { program: "spl-token-2022", parsed: { type, info } } } },
  };
}

describe("parseMintExtensions — live mainnet shapes", () => {
  it("PYUSD: permanent delegate set, transfer hook present but INERT", () => {
    // 2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo
    const facts = parseMintExtensions(
      response(TOKEN_2022, {
        decimals: 6,
        freezeAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
        mintAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
        supply: "1",
        extensions: [
          {
            extension: "mintCloseAuthority",
            state: { closeAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk" },
          },
          {
            extension: "permanentDelegate",
            state: { delegate: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk" },
          },
          {
            extension: "transferFeeConfig",
            state: {
              newerTransferFee: { epoch: 605, maximumFee: 0, transferFeeBasisPoints: 0 },
              olderTransferFee: { epoch: 605, maximumFee: 0, transferFeeBasisPoints: 0 },
              withheldAmount: 0,
            },
          },
          {
            extension: "transferHook",
            state: {
              authority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
              programId: null,
            },
          },
          {
            extension: "metadataPointer",
            state: { authority: null, metadataAddress: "2b1kV6Dk" },
          },
        ],
      })
    );
    expect(facts).not.toBeNull();
    expect(facts!.isToken2022).toBe(true);
    // programId null = no hook program installed = nothing can revert a sell.
    expect(facts!.hasTransferHook).toBe(false);
    expect(facts!.permanentDelegate).toBe(
      "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk"
    );
    expect(facts!.transferFeeBps).toBe(0);
    expect(facts!.mintAuthorityActive).toBe(true);
    expect(facts!.freezeAuthorityActive).toBe(true);
    expect(facts!.nonTransferable).toBe(false);
    expect(facts!.defaultAccountFrozen).toBe(false);
  });

  it("reads a real installed transfer hook program", () => {
    // 12AR5yihid9wxUHDf5xKqLpPkRX4nyaSKiAD7LXmLBu
    const facts = parseMintExtensions(
      response(TOKEN_2022, {
        mintAuthority: null,
        freezeAuthority: null,
        extensions: [
          {
            extension: "transferHook",
            state: {
              authority: "6aeaH8q7unhosrg3rn3eqi3pUz1DxDyU2aQvGPF2s6dg",
              programId: "tHookmPkFZDJGkS9us6sVsnYi2EKHCrVtw8zD6oXYPE",
            },
          },
        ],
      })
    );
    expect(facts!.hasTransferHook).toBe(true);
    expect(facts!.mintAuthorityActive).toBe(false);
    expect(facts!.freezeAuthorityActive).toBe(false);
  });

  it("reads defaultAccountState frozen", () => {
    // 15YGYD1afQzrdjuzJBDonV7U5yPyBJs7qT5MQBLP49b
    const facts = parseMintExtensions(
      response(TOKEN_2022, {
        extensions: [
          { extension: "metadataPointer", state: { authority: null, metadataAddress: "x" } },
          { extension: "defaultAccountState", state: { accountState: "frozen" } },
          { extension: "permanentDelegate", state: { delegate: "4cVvbv28Uxvw21y1bHeptCmBeZdymYiukeBT33KPhZ2D" } },
        ],
      })
    );
    expect(facts!.defaultAccountFrozen).toBe(true);
    expect(facts!.permanentDelegate).toBe(
      "4cVvbv28Uxvw21y1bHeptCmBeZdymYiukeBT33KPhZ2D"
    );
  });

  it("an unfrozen default account state is not a finding", () => {
    const facts = parseMintExtensions(
      response(TOKEN_2022, {
        extensions: [
          { extension: "defaultAccountState", state: { accountState: "initialized" } },
        ],
      })
    );
    expect(facts!.defaultAccountFrozen).toBe(false);
  });

  it("reads a live non-zero transfer fee off newerTransferFee", () => {
    const facts = parseMintExtensions(
      response(TOKEN_2022, {
        extensions: [
          {
            extension: "transferFeeConfig",
            state: {
              newerTransferFee: { epoch: 922, transferFeeBasisPoints: 20 },
              olderTransferFee: { epoch: 900, transferFeeBasisPoints: 500 },
              withheldAmount: 96619923,
            },
          },
        ],
      })
    );
    expect(facts!.transferFeeBps).toBe(20);
  });

  it("nonTransferable is detected from the extension name alone", () => {
    // Not observed live (such a token cannot trade on a DEX) — parsed
    // defensively so it holds with or without a state object.
    expect(
      parseMintExtensions(
        response(TOKEN_2022, { extensions: [{ extension: "nonTransferable" }] })
      )!.nonTransferable
    ).toBe(true);
    expect(
      parseMintExtensions(
        response(TOKEN_2022, {
          extensions: [{ extension: "nonTransferable", state: {} }],
        })
      )!.nonTransferable
    ).toBe(true);
  });

  it("a legacy SPL mint is a COMPLETED check with nothing to report", () => {
    const facts = parseMintExtensions(
      response(TOKEN_LEGACY, {
        decimals: 5,
        freezeAuthority: null,
        mintAuthority: null,
        supply: "88888888888888888",
      })
    );
    expect(facts).toEqual({
      hasTransferHook: false,
      nonTransferable: false,
      defaultAccountFrozen: false,
      permanentDelegate: null,
      transferFeeBps: null,
      isToken2022: false,
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
    });
  });

  it("treats the all-ones default pubkey as unset", () => {
    const facts = parseMintExtensions(
      response(TOKEN_2022, {
        mintAuthority: "11111111111111111111111111111111",
        extensions: [
          {
            extension: "permanentDelegate",
            state: { delegate: "11111111111111111111111111111111" },
          },
        ],
      })
    );
    expect(facts!.permanentDelegate).toBeNull();
    expect(facts!.mintAuthorityActive).toBe(false);
  });

  it("returns null (UNKNOWN) for anything unreadable", () => {
    expect(parseMintExtensions({ error: { message: "boom" } })).toBeNull();
    expect(parseMintExtensions({ result: { value: null } })).toBeNull();
    expect(parseMintExtensions(undefined)).toBeNull();
    // Not a token program account
    expect(
      parseMintExtensions(response("11111111111111111111111111111111", {}))
    ).toBeNull();
    // A token account, not a mint
    expect(parseMintExtensions(response(TOKEN_2022, {}, "account"))).toBeNull();
  });

  it("survives junk in the extensions array", () => {
    const facts = parseMintExtensions(
      response(TOKEN_2022, {
        extensions: [null, 7, "transferHook", { state: { programId: "x" } }, {
          extension: "unknownFutureExtension",
          state: { whatever: true },
        }],
      })
    );
    expect(facts!.hasTransferHook).toBe(false);
    expect(facts!.isToken2022).toBe(true);
  });
});
