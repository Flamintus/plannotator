/**
 * The "Skills referenced" block of what the person sends through the Inbox
 * (approval "inbox-skill-references", Option B as amended): the window's Send
 * (packages/inbox/skills.ts reads the catalog and the SKILL.md bodies from its
 * routes) and the server's text for a comment send
 * (packages/server/inbox-comment-send-delivery.ts reads them from disk) compose
 * it with the same rules. Browser-safe, no dependencies.
 *
 * - a model-invocable skill is named, and the agent invokes it itself;
 * - a human-only skill (`disable-model-invocation: true`) has its SKILL.md
 *   text pasted between BEGIN/END markers, with its folder named, because a
 *   person referencing it IS the invocation the agent cannot make;
 * - one block per message, at its end, at most
 *   `INBOX_SKILL_INSTRUCTIONS_BUDGET` characters of instructions; a skill
 *   past it is named with its folder.
 */
import type { SkillBlockAudience } from "./skill-reference-block";
import { inboxReviewSkill } from "./inbox-review";
import { shapeSkill } from "./shape-skill";
import { extractSkillReferences, renderSkillReferencesBlock, type SkillCatalogEntry, type SkillExportContent } from "./skill-references";

/** The most SKILL.md text one message pastes, over all its human-only skills. */
export const INBOX_SKILL_INSTRUCTIONS_BUDGET = 40_000;

/** Every skill the texts reference, in first-appearance order across them, once each. */
export function inboxSkillReferences(texts: readonly string[], catalog: readonly SkillCatalogEntry[]): SkillCatalogEntry[] {
  const seen = new Set<string>();
  const refs: SkillCatalogEntry[] = [];
  for (const text of texts) {
    for (const ref of extractSkillReferences(text, [...catalog])) {
      if (seen.has(ref.name)) continue;
      seen.add(ref.name);
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * The block for these references: `contents` holds the SKILL.md of the
 * human-only ones that could be read. '' with no references.
 */
export function composeInboxSkillsBlock(
  refs: readonly SkillCatalogEntry[],
  contents: ReadonlyMap<string, SkillExportContent>,
  audience: SkillBlockAudience,
  budget = INBOX_SKILL_INSTRUCTIONS_BUDGET,
): string {
  if (refs.length === 0) return "";
  // In reference order, while the budget lasts; a skill past it is named with its folder.
  const pasted = new Map<string, SkillExportContent>();
  let spent = 0;
  for (const ref of refs) {
    const content = ref.humanOnly ? contents.get(ref.name) : undefined;
    if (!content || spent + content.content.length > budget) continue;
    pasted.set(ref.name, content);
    spent += content.content.length;
  }
  return renderSkillReferencesBlock(refs, { contentOf: (name) => pasted.get(name), audience }).trimEnd();
}

/**
 * A Plannotator skill's instructions (root `plannotator`: the review skills the
 * Inbox lists while Code review is on, and `/shape` while Shape is on), from
 * Plannotator's own text, never read from disk. Undefined for any other skill.
 */
export function builtinSkillContent(ref: SkillCatalogEntry): SkillExportContent | undefined {
  if (ref.root !== "plannotator") return undefined;
  const skill = inboxReviewSkill(ref.name) ?? shapeSkill(ref.name);
  return skill ? { content: skill.body, truncated: false, dir: "", path: "" } : undefined;
}

/**
 * What may be matched in this thread: `/review-recheck` only where a review
 * already happened (`reviewed`), every other entry as listed.
 */
export function inboxSkillFilter(reviewed: boolean): (entry: SkillCatalogEntry) => boolean {
  return (entry) => reviewed || entry.root !== "plannotator" || inboxReviewSkill(entry.name)?.afterReview !== true;
}
