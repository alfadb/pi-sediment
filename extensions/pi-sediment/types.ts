/**
 * pi-sediment shared types.
 */

import type { Model, Api } from "@mariozechner/pi-ai";

// ── Target descriptors ──────────────────────────────────────────

export interface TargetStatus {
  /** Pensieve available (`.pensieve/` dir exists in project root). */
  pensieve: boolean;
  /** gbrain available (`gbrain doctor --json` exits 0). */
  gbrain: boolean;
  /** gbrain page count, if available (for cold-start logic). */
  gbrainPageCount: number | null;
}

// ── Per-target evaluator I/O ────────────────────────────────────

export interface GbrainEvalResult {
  decision: "skip" | "sediment";
  /** One-sentence summary of the insight (only meaningful when sediment). */
  summary: string;
}

// ── gbrain writer I/O ───────────────────────────────────────────

export interface GbrainSearchResult {
  slug: string;
  title: string;
  snippet: string;
}

export interface GbrainWriteInput {
  summary: string;
  dateIso: string;
  lastAssistantMessage: string;
  /** Related gbrain pages used for frontmatter auto-link extraction. */
  relatedPages: GbrainSearchResult[];
  /** Format error feedback for retry (undefined on first attempt). */
  formatError?: string;
}

export interface GbrainWriteOutput {
  title: string;
  tags: string[];
  content: string; // markdown body
  /** Related page titles for gbrain frontmatter auto-link extraction. */
  related?: string[];
  /**
   * Set when the writer chose to UPDATE an existing page in place.
   * gbrain put is upsert by slug, so passing this overrides the
   * sanitizeSlug(title) derivation and overwrites the existing page
   * (preserving its identity and inbound graph links).
   */
  updateSlug?: string;
}

// ── Resolved model ─────────────────────────────────────────────

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  display: string;
}
