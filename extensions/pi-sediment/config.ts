/**
 * pi-sediment config — model resolution.
 *
 * Default model: deepseek/deepseek-v4-pro
 * Override priority (high → low):
 *   1. env: PI_SEDIMENT_MODEL
 *   2. project: .pi-sediment/config.json → model
 *   3. default: deepseek/deepseek-v4-pro
 *
 * Hot-reloaded on every agent_end so users can tweak without restart.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface SedimentConfig {
  model: ModelRef;
  evalTimeoutMs: number;
  writeTimeoutMs: number;
}

const DEFAULT_MODEL: ModelRef = {
  provider: "deepseek",
  modelId: "deepseek-v4-pro",
};

// ── Helpers ────────────────────────────────────────────────────

function parseModelRef(s: string | undefined | null): ModelRef | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function readJsonSafe(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

// ── Public ─────────────────────────────────────────────────────

export function formatModelRef(r: ModelRef): string {
  return `${r.provider}/${r.modelId}`;
}

export function loadConfig(projectRoot: string): SedimentConfig {
  // 1. env
  const envRef = parseModelRef(process.env.PI_SEDIMENT_MODEL);

  // 2. project config
  const projectConfig = readJsonSafe(path.join(projectRoot, ".pi-sediment", "config.json"));
  const projectRef = parseModelRef(projectConfig?.model);

  // 3. default
  const model = envRef ?? projectRef ?? DEFAULT_MODEL;

  return {
    model,
    evalTimeoutMs: 30_000,
    writeTimeoutMs: 90_000,
  };
}
