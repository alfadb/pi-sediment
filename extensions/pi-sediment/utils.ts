/**
 * Shared utilities for pi-sediment.
 */

/** Slugify a string for use as a Pensieve/GBrain page slug. */
export function sanitizeSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80);

  // If all content was stripped (e.g. Chinese-only title), fall back to a
  // short hash so the write doesn't silently vanish.
  if (!slug || slug === "-") {
    return `auto-${hashShort(raw)}`;
  }
  return slug;
}

/** Non-crypto short hash (djb2) for fallback slug generation. */
export function hashShort(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * True when >30% of characters are outside ASCII range.
 * Used to decide whether gbrain content needs English translation.
 */
export function isNonLatin(s: string): boolean {
  if (!s) return false;
  const nonAscii = [...s].filter((c) => c.codePointAt(0)! > 127).length;
  return nonAscii / s.length > 0.3;
}
