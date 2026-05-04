/**
 * pi-sediment prompts — per-target evaluator + writer.
 *
 * Pensieve: delegated to /skill:pensieve self-improve (no custom prompt needed).
 * gbrain:   dedicated evaluator + writer with timeline support.
 */

import type { GbrainSearchResult } from "./types.js";

// ── Injection filter patterns ────────────────────────────────

// Last-line defense before sediment writes pensieve / gbrain. Threat:
// indirect prompt injection — a coding-agent turn may quote untrusted data
// (web pages, tool output, pasted text) containing instructions which a
// downstream sediment LLM could be persuaded by, leading sediment to
// permanently install poisoned content into long-term memory.
//
// Defense layers (sediment is already hardened by all three):
//   1. lookup tools are read-only — no write tools exposed to the model
//   2. final writes go through a parsed protocol (## PENSIEVE / ## GBRAIN),
//      not arbitrary tool calls
//   3. this content sanitize — last-line catch of the most overt patterns
//
// Originally we copied a wide pattern set from pi-gstack including bare
// '\bsystem:' / '\buser:' / '\bassistant:'. Those are vocabulary that
// appears constantly in normal technical writing about prompt design and
// agent loops; they produced 100% false-positive rate during meta-discussion
// of pi-sediment itself (3 hits in one session, all on legitimate prose).
// The remaining patterns target unambiguous imperative phrasings that have
// no natural use in engineering prose.
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+(instructions|context|rules)/i,
  /you\s+are\s+now\s+/i,
  /always\s+output\s+no\s+findings/i,
  /skip\s+(all\s+)?(security|review|checks)/i,
  /override[:\s]/i,
  /do\s+not\s+(report|flag|mention)/i,
  /approve\s+(all|every|this)/i,
];

/**
 * Sanitize LLM-generated content against prompt injection patterns.
 * Returns null if a pattern matches (content rejected).
 */
export function sanitizeContent(content: string): string | null {
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(content)) return null;
  }
  return content;
}

// ── gbrain evaluator ────────────────────────────────────────────

// ── gbrain agent (eval + write combined, with lookup tools) ────────

/**
 * Combined evaluator + writer for gbrain. Used with the agent-loop runner
 * so the model can call read-only lookup tools (gbrain_search, gbrain_get,
 * pensieve_grep, pensieve_read, pensieve_list) before producing a single
 * terminal output.
 *
 * The terminal grammar adds mode + update_slug fields so the writer can
 * choose UPDATE vs NEW vs SKIP_DUPLICATE. gbrain put is upsert by slug, so
 * UPDATE is achieved by emitting the exact existing slug.
 */
export const GBRAIN_AGENT_PROMPT = `You are the pi-sediment gbrain curator.

Your job: decide whether a coding-agent turn produced a UNIVERSAL
engineering principle worth persisting to gbrain (cross-project knowledge),
and if so, AVOID DUPLICATING what's already there.

gbrain stores patterns, anti-patterns, principles, and pitfalls that apply
beyond any single codebase. Do NOT store project-specific paths/modules
(those go to Pensieve, not gbrain). All output MUST be in English.

WORKFLOW:
  1. Read the assistant turn provided by the user.
  2. Use the read-only tools to check existing memory:
       - gbrain_search, gbrain_get — find/inspect candidate gbrain pages
       - pensieve_grep, pensieve_read, pensieve_list — cross-reference
         the project's Pensieve to inform the principle
     Call them as many times as you need. Be thorough: a page on the same
     topic should be UPDATEd, not duplicated.
  3. Emit ONE final terminal output. After emitting it, stop.

FOUR POSSIBLE TERMINAL OUTPUTS (English only):

A. No durable principle — emit exactly:
SKIP

B. An existing gbrain page already states this principle accurately:
SKIP_DUPLICATE: <existing-slug> — <one-sentence reason>

C. UPDATE an existing page (same topic, refined / contradicted / extended).
   gbrain put is upsert by slug, so emit the EXISTING slug as update_slug;
   PRESERVE every prior timeline bullet from the existing page and APPEND
   a new bullet for today.

## GBRAIN
mode: update
update_slug: <existing-slug, do NOT rename>
title: Present-Tense Imperative Headline (<= 100 chars)
tags: engineering, topic
__CONTENT__
# Title (same as headline)

## Principle
One sentence.

## Guidance
- bullet 1
- bullet 2

## When this applies
- scenario

## Boundaries
- when NOT to apply

## Timeline
- **{prior-date}** | pi-sediment — ... (copy verbatim from existing page)
- **{today}** | pi-sediment — One-line summary of the new insight

D. NEW page (genuinely a different topic):

## GBRAIN
mode: new
title: Present-Tense Imperative Headline (<= 100 chars)
tags: engineering, topic
__CONTENT__
# Title (same as headline)

## Principle
One sentence.

## Guidance
- bullet 1
- bullet 2

## When this applies
- scenario

## Boundaries
- when NOT to apply

## Timeline
- **{today}** | pi-sediment — One-line summary

FORMAT RULES (NON-NEGOTIABLE):
1. The first non-blank line of output MUST be one of: SKIP, SKIP_DUPLICATE: ...,
   or "## GBRAIN".
2. Do NOT wrap the output in \`\`\` code fences.
3. Title must be present-tense imperative form.
4. No file paths, module names, or project specifics anywhere in the body.
5. Tags must include at least one specific topic tag beyond "engineering".
6. For mode=update: COPY every existing timeline bullet verbatim, then append.
7. For mode=new: include exactly one timeline bullet for today.
8. Body (when mode=update or new) must be >= 200 words of original synthesis.
9. The Timeline section MUST be the FINAL section; no prose after the bullets.
10. ALL text MUST be in English regardless of source language.

Default to UPDATE when an existing page is on the same topic. Default to
SKIP_DUPLICATE when adding nothing new. NEW only for genuinely new topics.
Churn is worse than gaps.`;

export function buildGbrainAgentPrompt(args: {
  dateIso: string;
  lastAssistantMessage: string;
  gbrainColdStart: boolean;
}): string {
  const coldStartNote = args.gbrainColdStart
    ? "\n\nNOTE: The gbrain knowledge base is nearly empty (< 10 pages). " +
      "If you find ANY insight with cross-project engineering value, " +
      "lean toward NEW."
    : "";
  return `Date: ${args.dateIso}\n\n` +
    `Use the read-only tools to investigate existing memory before deciding. ` +
    `Then emit your terminal output.${coldStartNote}\n\n` +
    `Assistant turn:\n\n<message>\n${args.lastAssistantMessage}\n</message>`;
}

// ── Legacy two-stage prompts (kept for compatibility / fallback) ──────

export const GBRAIN_EVAL_PROMPT = `You are the pi-sediment gbrain evaluator.

ALL output MUST be in English — regardless of the source message language.

Read the FINAL assistant message of a coding-agent turn and decide whether
it contains a UNIVERSAL engineering principle worth saving to gbrain.

gbrain stores cross-project knowledge — patterns, anti-patterns, principles,
and pitfalls that apply beyond the current codebase. Do NOT store
project-specific details (file paths, module names, repo conventions).

Output ONLY a JSON block, nothing else:

{
  "decision": "skip" | "sediment",
  "summary": "one-sentence principle in English (empty if skip)"
}

CRITICAL: The summary field MUST be in English. Even if the source material
is in another language, you MUST output the summary in English.

Sediment when:
- A bug root cause reveals a pattern others would hit
- An architectural tradeoff settles a general design question
- A non-obvious pitfall or anti-pattern is discovered
- An API/library behavior is documented with a workaround
- A cross-cutting engineering principle is articulated

Skip when:
- The insight is project-specific (file paths, internal module names)
- The turn is routine execution (formatting, renaming, dependency bumps)
- The content is obvious or already well-known
- Status updates, user questions, or exploration without conclusion

Be conservative. False positives pollute memory. When in doubt, skip.`;

export function buildGbrainEvalPrompt(args: {
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

// ── gbrain writer ───────────────────────────────────────────────

export const GBRAIN_WRITE_PROMPT = `You are the pi-sediment gbrain writer.

Given an engineering insight, produce a gbrain page: a universal principle
distilled from the source material. The output must be self-contained and
readable without referencing the original conversation.

CRITICAL — OUTPUT FORMAT (parseable, no deviation):

## GBRAIN
title: Present-Tense Imperative Headline (<= 100 chars)
tags: engineering, topic
__CONTENT__
# Title (same as headline above)

## Principle
One sentence.

## Guidance
- bullet 1
- bullet 2

## When this applies
- scenario

## Boundaries
- when NOT to apply

## Timeline
- **{date}** | pi-sediment — One-line summary

FORMAT RULES (NON-NEGOTIABLE):
1. The FIRST LINE of output MUST be exactly "## GBRAIN" (no code fences, no preamble)
2. The second line MUST be "title: ..."
3. The third line MUST be "tags: ..."
4. The fourth line MUST be "__CONTENT__"
5. After __CONTENT__, a blank line, then the markdown body
6. Do NOT wrap the output in \`\`\` code fences
7. ALL text MUST be in English

CONTENT RULES:
- Title must be in present-tense imperative form
- No file paths, module names, or project specifics anywhere
- Related pages are added to frontmatter automatically; mention related concepts by title when useful
- The Timeline section MUST include the provided date
- The Timeline section MUST be the FINAL section; put no prose after the timeline bullet
- Put all explanatory synthesis before ## Timeline, never after it
- Tags must include at least one specific topic tag beyond "engineering"
- Body must be >= 200 words of original synthesis`;

export function buildGbrainWritePrompt(args: {
  summary: string;
  dateIso: string;
  lastAssistantMessage: string;
  relatedPages: GbrainSearchResult[];
  formatError?: string;
}): string {
  let relatedSection = "";
  if (args.relatedPages.length > 0) {
    const lines = args.relatedPages.map(
      (p) => `- ${p.title} (${p.slug})`
    );
    relatedSection =
      "\n\nExisting related pages in gbrain (for conceptual context; links are added via frontmatter automatically):\n" +
      lines.join("\n");
  }

  let formatErrorSection = "";
  if (args.formatError) {
    formatErrorSection =
      `\n\n⚠️  PREVIOUS ATTEMPT FAILED — FORMAT ERROR:\n${args.formatError}\n\nCRITICAL: Fix the format error above. Follow the output format EXACTLY as specified.`;
  }

  return `Insight summary: ${args.summary}

Date: ${args.dateIso}

Source material (full assistant message):

<source>
${args.lastAssistantMessage}
</source>${relatedSection}${formatErrorSection}

Produce the gbrain entry using the markdown section format above.`;
}
