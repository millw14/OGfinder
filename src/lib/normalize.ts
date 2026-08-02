export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Invisible characters used to disguise names: zero-width space/joiners,
 *  word joiner, BOM, and variation selectors. */
const INVISIBLES_RE = /[\u200B-\u200D\u2060\uFEFF\uFE00-\uFE0F]/g;

/** Emoji / pictographs (padding like "🔥Bonk🔥"). Needs ES2018+ target. */
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/**
 * Lookalike → Latin twin table for skeleton(). Small and curated: Cyrillic and
 * Greek homoglyphs commonly used to impersonate token names. Keys are exact
 * codepoints (matched before normalize() lowercases). Extend here as new
 * tricks appear — one entry per confusable codepoint.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic lowercase → Latin
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y",
  "і": "i", "ј": "j", "ѕ": "s",
  // Cyrillic uppercase → Latin
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O",
  "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y", "І": "I", "Ј": "J",
  "Ѕ": "S",
  // Greek → Latin
  "α": "a", "Α": "A", "ο": "o", "Ο": "O", "ν": "v", "Ν": "N", "ι": "i",
  "Ι": "I", "κ": "k", "Κ": "K", "ρ": "p", "Ρ": "P", "τ": "t", "Τ": "T",
  "υ": "u", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Μ": "M", "Χ": "X",
};

const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

/**
 * Impersonation-resistant form of a name: strips invisibles and emoji, folds
 * fullwidth/compatibility forms (NFKC) and Cyrillic/Greek lookalikes to their
 * Latin twins, then applies normalize(). skeleton("Воnk") === skeleton("Bonk").
 * Never use for cache keys — normalize() stays the canonical key form.
 */
export function skeleton(s: string): string {
  const folded = s
    .replace(INVISIBLES_RE, "")
    .replace(EMOJI_RE, "")
    .normalize("NFKC")
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
  return normalize(folded);
}

/** Remove invisible disguise characters (zero-width, word joiner, BOM, VS). */
export function stripInvisibles(s: string): string {
  return s.replace(INVISIBLES_RE, "");
}

/**
 * True when the string only reads "normal" after lookalike folding — it
 * contains invisibles, confusable Cyrillic/Greek twins, or NFKC-foldable
 * disguise chars. Emoji alone (common and legitimate) never triggers this.
 */
export function hasLookalikeChars(s: string): boolean {
  return skeleton(s) !== normalize(s.replace(EMOJI_RE, ""));
}

/** DexScreener pairCreatedAt is ms; if mis-serialized as Unix seconds, normalize to ms. */
export function dexPairCreatedMs(t: number | undefined): number | undefined {
  if (t == null || !Number.isFinite(t)) return undefined;
  if (t > 0 && t < 1e12) return Math.round(t * 1000);
  return t;
}
