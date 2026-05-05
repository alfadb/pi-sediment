/**
 * Shared utilities for pi-sediment.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── gbrain CLI launcher ──────────────────────────────────────
//
// We invoke gbrain via `bun <cli.ts>` instead of the `gbrain` shim, because:
//  • The shim is a symlink to the .ts source. It only works when the source
//    file has the executable bit set, but gbrain is an upstream repo we don't
//    control. Local patches (`git apply`) and `git checkout` routinely strip
//    the +x bit, after which the shim fails with EACCES and the entire
//    sediment gbrain pipeline is silently disabled (detector returns false).
//  • Letting bun read the source directly removes the dependency on the file
//    mode, the PATH entry, and the symlink — only the source path matters.
//
// Launcher resolution: $BUN_INSTALL/bin/bun → ~/.bun/bin/bun → "bun" (PATH).

const GBRAIN_CLI_PATH = path.join(os.homedir(), "gbrain", "src", "cli.ts");

function resolveBunBin(): string {
  if (process.env.BUN_INSTALL) {
    return path.join(process.env.BUN_INSTALL, "bin", "bun");
  }
  return path.join(os.homedir(), ".bun", "bin", "bun");
}

/**
 * Returns the [command, leadingArgs] tuple to invoke gbrain.
 * Append the gbrain subcommand and its args after `leadingArgs`.
 *
 * Example:
 *   const [cmd, lead] = gbrainCommand();
 *   spawn(cmd, [...lead, "doctor", "--json"]);
 */
export function gbrainCommand(): [string, string[]] {
  return [resolveBunBin(), [GBRAIN_CLI_PATH]];
}

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


/**
 * Save a rejected/failed write payload to disk for post-mortem inspection.
 *
 * Sediment's writer pipeline can drop content for several reasons (injection
 * filter, malformed protocol output, missing title, etc). Without a trail
 * the only signal we get is one log line and a checkpoint advance — neither
 * tells us WHAT was rejected, so debugging false-positive sanitizer hits or
 * malformed-output regressions becomes guesswork.
 *
 * This helper writes the raw payload to .pi-sediment/parse-failures/ with a
 * timestamped filename keyed on the rejection reason. The directory is
 * gitignore-friendly (already excluded by .gitignore) and bounded in
 * practice — sediment runs once per agent_end so growth is naturally
 * throttled. We also do not rotate the directory; if it grows unbounded
 * over weeks/months that's a feature (full audit log) and the user can
 * clean it manually.
 *
 * Silent on I/O failure: this is observability, not load-bearing logic.
 * If the disk is full or the directory unwritable, we'd rather lose the
 * audit trail than crash sediment itself.
 */
export function saveParseFailure(
  raw: string,
  projectRoot: string,
  reason: string,
  tag: string = "sediment",
): void {
  try {
    const dir = path.join(projectRoot, ".pi-sediment", "parse-failures");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${ts}-${tag}-${reason}.md`);
    fs.writeFileSync(file, raw, "utf8");
  } catch {
    /* observability is best-effort; never block the writer on disk errors */
  }
}
