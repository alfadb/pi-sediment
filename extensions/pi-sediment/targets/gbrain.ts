/**
 * pi-sediment gbrain target — write to gbrain via CLI.
 *
 * Uses `gbrain put <slug> --title <title> --tags <tags>` with content on stdin.
 * Throttle/rate-limit → silent downgrade (deferred).
 * gbrain unavailable → silent skip.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeSlug } from "../utils.js";
import type { GbrainEntry } from "../types.js";

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

// ── Public ─────────────────────────────────────────────────────

export async function writeToGbrain(
  entry: GbrainEntry,
  projectRoot: string,
): Promise<boolean> {
  const slug = sanitizeSlug(entry.title);
  if (!slug) return false;

  const args = [
    "put", slug,
    "--title", entry.title,
    "--tags", entry.tags.join(","),
  ];

  return new Promise((resolve) => {
    const child = execFile("gbrain", args, {
      cwd: `${process.env.HOME}/gbrain`,
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      if (err) {
        const code = (err as any).code ?? 1;
        const msg = stderr?.trim() ?? err.message;
        if (throttleErr(msg)) {
          logLine(projectRoot, `gbrain write:throttle slug=${slug} → deferred`);
          resolve(true); // not a hard failure
        } else {
          logLine(projectRoot, `gbrain write:fail slug=${slug} code=${code} ${msg.slice(0, 200)}`);
          resolve(false);
        }
        return;
      }
      logLine(projectRoot, `gbrain write:ok slug=${slug}`);
      resolve(true);
    });

    if (child.stdin) {
      child.stdin.write(entry.content);
      child.stdin.end();
    }

    child.on("error", (e) => {
      logLine(projectRoot, `gbrain write:error slug=${slug} ${e.message}`);
      resolve(false);
    });
  });
}
