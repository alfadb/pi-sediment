/**
 * pi-sediment prompts — evaluator + writer.
 *
 * Two stages, two prompts:
 *   EVAL  → decide skip/sediment + one-line summary
 *   WRITE → produce Pensieve + gbrain markdown (dual output, single call)
 *
 * Cold-start hint: appended when gbrain has < 10 pages.
 */

// ── Evaluator ──────────────────────────────────────────────────

export const EVAL_SYSTEM_PROMPT = `You are the pi-sediment evaluator.

Read the FINAL assistant message of a coding-agent turn and decide whether
it contains a durable engineering insight worth saving.

Output ONLY a JSON block, nothing else:

{
  "decision": "skip" | "sediment",
  "summary": "one sentence describing the insight (empty if skip)"
}

Sediment when:
- An explicit architectural choice was made between alternatives
- A bug root cause was definitively identified (symptom → root → fix chain)
- A non-obvious pattern, anti-pattern, or pitfall was discovered
- An exploration produced reusable knowledge (call chain, module boundary, constraint)
- A design tradeoff was settled with reasoning

Skip when:
- The turn is pure execution of a previously-decided plan
- Routine implementation: formatting, renaming, dependency bumps, simple fixes
- Status updates, asking user questions, or exploration without conclusion
- The content is obvious or already well-known

Be conservative. False positives pollute memory. When in doubt, skip.`;

export function buildEvalPrompt(args: {
  lastAssistantMessage: string;
  gbrainColdStart: boolean;
}): string {
  let extra = "";
  if (args.gbrainColdStart) {
    extra =
      "\n\nNOTE: Your gbrain knowledge base is nearly empty (< 10 pages). " +
      "If you discover ANY insight with cross-project engineering value, " +
      "lean toward sediment.";
  }
  return `Evaluate this assistant message and emit the JSON decision.${extra}

<assistant-message>
${args.lastAssistantMessage}
</assistant-message>`;
}

// ── Writer ─────────────────────────────────────────────────────

export const WRITE_SYSTEM_PROMPT = `You are the pi-sediment writer.

Given an engineering insight from a coding-agent turn, produce TWO outputs:

1. A Pensieve entry — project-level knowledge.
   How to fix it in THIS project. Include file paths, module names, specific
   code patterns. Output as a complete markdown file with frontmatter:
     - type: "knowledge" | "decision" | "maxim"
     - id, title, status: "active", created (ISO date), tags
     - Body follows Pensieve reference format

2. A gbrain entry — cross-project engineering principle.
   How to AVOID this in ANY project. Distill the universal pattern, not the
   project specifics. Output as a complete markdown page:
     - title (concise headline)
     - tags (2-4 comma-separated keywords including "engineering")
     - Body explains: what pattern, why it happens, how to detect it,
       how to fix/avoid it, when it applies

CRITICAL: The Pensieve entry and gbrain entry MUST be different content.
- Pensieve answers "how to fix it HERE"
- gbrain answers "how to avoid it EVERYWHERE"

If the insight is purely project-specific (no universal principle), output
null for gbrain. If the insight is purely universal (no project file paths),
output null for Pensieve.

Output ONLY a JSON block:

{
  "pensieve": {
    "kind": "knowledge" | "decision" | "maxim",
    "slug": "lowercase-hyphenated",
    "label": "<= 60 char headline",
    "content": "full markdown with frontmatter"
  } | null,
  "gbrain": {
    "title": "headline",
    "tags": ["engineering", "..."],
    "content": "full markdown body"
  } | null
}`;

export function buildWritePrompt(args: {
  summary: string;
  lastAssistantMessage: string;
  dateIso: string;
}): string {
  return `Insight summary: ${args.summary}

Date: ${args.dateIso}

Source material (full assistant message):

<source>
${args.lastAssistantMessage}
</source>

Produce the Pensieve and gbrain entries now.`;
}
