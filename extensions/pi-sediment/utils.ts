/**
 * Shared utilities for pi-sediment.
 */

/** Slugify a string for use as a Pensieve/GBrain page slug. */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80);
}
