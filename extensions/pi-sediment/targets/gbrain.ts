/**
 * pi-sediment gbrain target — write to gbrain via CLI.
 *
 * Uses `gbrain put <slug> --content <frontmatter+body>` to avoid
 * Bun's /dev/stdin reliability issues in headless/pipe environments.
 * Throttle/rate-limit → silent downgrade (deferred).
 * gbrain unavailable → silent skip.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isNonLatin, sanitizeSlug } from "../utils.js";
import type { GbrainEntry } from "../types.js";

// ── Constants ─────────────────────────────────────────────────

/** Be defensive about ARG_MAX; cap content at 96 KB. */
const MAX_CONTENT_BYTES = 96 * 1024;

// ── Helpers ────────────────────────────────────────────────────

function throttleErr(stderr: string): boolean {
  const kw = ["throttle", "rate limit", "capacity", "busy"];
  return kw.some((k) => stderr.toLowerCase().includes(k));
}

function logLine(projectRoot: string, line: string): void {
  try {
    const dir = path.join(projectRoot, ".pi-sediment");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "sidecar.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* silent */ }
}

/** Wrap body content with minimal YAML frontmatter (gbrain --content requires it). */
function wrapFrontmatter(entry: GbrainEntry): string {
  const tags = entry.tags.map((t) => JSON.stringify(t)).join(", ");
  return [
    "---",
    `title: ${JSON.stringify(entry.title)}`,
    `tags: [${tags}]`,
    "---",
    "",
    entry.content,
  ].join("\n");
}

// ── Retry ──────────────────────────────────────────────────────

/**
 * Callback for regenerating a gbrain entry (e.g. translating to English).
 * Called when first write fails and content is predominantly non-Latin.
 */
export type GbrainTranslateFn = (
  entry: GbrainEntry,
  attempt: number,
) => Promise<GbrainEntry | null>;

/**
 * Write to gbrain with retry logic.
 *
 * Strategy:
 *   Attempt 1: write original entry
 *   If failed + non-Latin content + translateFn available:
 *     Attempt 2-3: call translateFn, write translated entry (1s / 2s backoff)
 *   If failed + Latin content (or no translateFn):
 *     Attempt 2-3: retry original entry with backoff (1s / 2s)
 *
 * Returns true if any attempt succeeded.
 */
export async function writeToGbrainWithRetry(
  entry: GbrainEntry,
  projectRoot: string,
  translateFn?: GbrainTranslateFn,
  maxAttempts: number = 3,
): Promise<boolean> {
  // Attempt 1: original
  const firstOk = await writeToGbrain(entry, projectRoot);
  if (firstOk) return true;

  const needsTranslate =
    translateFn &&
    (isNonLatin(entry.title) || isNonLatin(entry.content));

  let current = entry;

  for (let attempt = 2; attempt <= maxAttempts; attempt++) {
    const delayMs = 1000 * (attempt - 1);
    await sleep(delayMs);

    if (needsTranslate) {
      const translated = await translateFn(current, attempt);
      if (translated) {
        current = translated;
        logLine(projectRoot, `gbrain retry:translated attempt=${attempt} slug=${sanitizeSlug(current.title)}`);
      } else {
        logLine(projectRoot, `gbrain retry:translate_failed attempt=${attempt}`);
        continue;
      }
    }

    const ok = await writeToGbrain(current, projectRoot);
    if (ok) {
      logLine(projectRoot, `gbrain retry:ok attempt=${attempt}`);
      return true;
    }
  }

  logLine(projectRoot, `gbrain retry:exhausted attempts=${maxAttempts}`);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Public (bare) ───────────────────────────────────────────────

export async function writeToGbrain(
  entry: GbrainEntry,
  projectRoot: string,
): Promise<boolean> {
  const slug = sanitizeSlug(entry.title);
  if (!slug) {
    logLine(projectRoot, `gbrain write:skip slug=empty title="${entry.title.slice(0, 80)}"`);
    return false;
  }

  const fullContent = wrapFrontmatter(entry);
  const contentBytes = Buffer.byteLength(fullContent, "utf8");

  // Guard against ARG_MAX on platforms with low limits.
  if (contentBytes > MAX_CONTENT_BYTES) {
    logLine(projectRoot, `gbrain write:skip slug=${slug} reason=content_too_large bytes=${contentBytes}`);
    return false;
  }

  const args = [
    "put", slug,
    "--title", entry.title,
    "--tags", entry.tags.join(","),
    "--content", fullContent,
  ];

  return new Promise((resolve) => {
    const child = spawn("gbrain", args, {
      cwd: path.join(os.homedir(), "gbrain"),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      logLine(projectRoot, `gbrain write:timeout slug=${slug}`);
      resolve(false);
    }, 15_000);

    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.stdout.on("data", () => {});

    child.on("error", (e) => {
      clearTimeout(timer);
      logLine(projectRoot, `gbrain write:error slug=${slug} ${e.message}`);
      resolve(false);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logLine(projectRoot, `gbrain write:ok slug=${slug}`);
        resolve(true);
      } else if (throttleErr(stderr)) {
        logLine(projectRoot, `gbrain write:throttle slug=${slug} → deferred`);
        resolve(true);
      } else {
        logLine(projectRoot, `gbrain write:fail slug=${slug} code=${code} ${stderr.slice(0, 200)}`);
        resolve(false);
      }
    });
  });
}
