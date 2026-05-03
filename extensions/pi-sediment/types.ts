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
  /** Related gbrain pages to cross-reference via [[wikilink]]. */
  relatedPages: GbrainSearchResult[];
}

export interface GbrainWriteOutput {
  title: string;
  tags: string[];
  content: string; // markdown body
}

// ── Pensieve entry (kept for reference, now written by skill) ───

export interface PensieveEntry {
  kind: "maxim" | "decision" | "knowledge";
  slug: string;
  label: string;
  content: string; // full markdown with frontmatter
}

// ── Resolved model ─────────────────────────────────────────────

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  display: string;
}

// ── Queue item ─────────────────────────────────────────────────

export interface QueueItem {
  sessionId: string;
  lastAssistantMessage: string;
  projectRoot: string;
  targets: TargetStatus;
  cwd: string;
  signal: AbortSignal | undefined;
}
