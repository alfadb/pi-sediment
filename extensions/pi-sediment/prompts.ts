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

Given an engineering insight, produce TWO outputs using markdown sections.

Format:

## PENSIEVE
kind: knowledge
slug: lowercase-hyphenated-slug
label: <= 60 char headline
__CONTENT__
full markdown body with frontmatter

## GBRAIN
title: headline
tags: engineering, pattern-name
__CONTENT__
full markdown body (universal principle, no file paths)

If an output is not applicable, write ONLY the word NULL under its header:

## PENSIEVE
NULL

RULES:
- Pensieve answers "how to fix it HERE" (project-specific file paths, modules)
- gbrain answers "how to avoid it EVERYWHERE" (distilled principle)
- Content MUST be different between the two`;

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

Produce the Pensieve and gbrain entries using the markdown section format above.`;
}
