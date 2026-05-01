/**
 * pi-sediment Pensieve target — write to .pensieve/short-term/
 *
 * Knowledge:  short-term/knowledge/<slug>/content.md
 * Decision:   short-term/decisions/<date>-<slug>.md
 * Maxim:      short-term/maxims/<slug>.md
 *
 * After writing, spawns maintain-project-state.sh to refresh state/graph.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { sanitizeSlug } from "../utils.js";
import type { PensieveEntry } from "../types.js";

// ── Locate skill root ──────────────────────────────────────────

function locateSkillRoot(): string | null {
  const candidates = [
    process.env.PENSIEVE_SKILL_ROOT,
    path.join(os.homedir(), ".pi", "agent", "skills", "pensieve"),
    path.join(os.homedir(), ".claude", "skills", "pensieve"),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".src", "manifest.json"))) return c;
  }
  return null;
}

const SKILL_ROOT = locateSkillRoot();

// ── Write ──────────────────────────────────────────────────────

export async function writeToPensieve(
  entry: PensieveEntry,
  projectRoot: string,
): Promise<boolean> {
  const pensieveDir = path.join(projectRoot, ".pensieve");
  if (!fs.existsSync(pensieveDir)) return false;

  const slug = sanitizeSlug(entry.slug);
  if (!slug) return false;

  const dateIso = new Date().toISOString().slice(0, 10);

  let target: string;
  if (entry.kind === "knowledge") {
    const dir = path.join(pensieveDir, "short-term", "knowledge", slug);
    fs.mkdirSync(dir, { recursive: true });
    target = path.join(dir, "content.md");
  } else if (entry.kind === "decision") {
    const dir = path.join(pensieveDir, "short-term", "decisions");
    fs.mkdirSync(dir, { recursive: true });
    target = path.join(dir, `${dateIso}-${slug}.md`);
  } else {
    const dir = path.join(pensieveDir, "short-term", "maxims");
    fs.mkdirSync(dir, { recursive: true });
    target = path.join(dir, `${slug}.md`);
  }

  // Avoid overwriting: append -N suffix on collision
  let final = target;
  let i = 2;
  while (fs.existsSync(final)) {
    const ext = path.extname(target);
    const base = target.slice(0, -ext.length);
    final = `${base}-${i}${ext}`;
    i++;
    if (i > 50) break;
  }

  fs.writeFileSync(final, entry.content, "utf8");

  // Refresh project state
  if (SKILL_ROOT) {
    const script = path.join(SKILL_ROOT, ".src", "scripts", "maintain-project-state.sh");
    if (fs.existsSync(script)) {
      const proc = spawn("bash", [script, "--event", "self-improve", "--note", `pi-sediment: ${entry.label}`], {
        cwd: projectRoot,
        env: {
          ...process.env,
          PENSIEVE_SKILL_ROOT: SKILL_ROOT,
          PENSIEVE_PROJECT_ROOT: projectRoot,
          PENSIEVE_HARNESS: "pi",
        },
        stdio: "ignore",
        detached: true,
      });
      proc.on("error", () => {});
      proc.unref();
    }
  }

  return true;
}
