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

// ── Evaluator I/O ──────────────────────────────────────────────

export interface EvalResult {
  decision: "skip" | "sediment";
  /** One-sentence summary of the insight (only meaningful when sediment). */
  summary: string;
}

// ── Writer I/O ─────────────────────────────────────────────────

export interface WriterOutput {
  /** Pensieve entry (null if insight is purely universal, no project specifics). */
  pensieve: PensieveEntry | null;
  /** gbrain entry (null if insight is purely project-specific). */
  gbrain: GbrainEntry | null;
}

export interface PensieveEntry {
  kind: "maxim" | "decision" | "knowledge";
  slug: string;
  label: string;
  content: string; // full markdown with frontmatter
}

export interface GbrainEntry {
  title: string;
  tags: string[];
  content: string; // markdown body
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
