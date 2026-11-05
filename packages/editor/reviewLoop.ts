/**
 * The review loop on a screen's page (`/plannotator-last`,
 * `/plannotator-annotate`, plan review; #1116, experimental
 * "persistent-comments"): what the page reads of its review's thread view
 * (`GET /api/threads`, the `review-threads` event, packages/shared/review-loop.ts)
 * and what it sends back (`POST /api/threads/send`). Pure: the hook is
 * hooks/useReviewLoop.ts, the panel components/ReviewLoopPanel.tsx.
 *
 * The page keeps its annotations as they are: a sent comment stays on the
 * page (highlighted, in the panel), and the thread view says which ones went
 * (`sent`); every other element of the review (the agent's replies, and a
 * sent comment the page does not hold, written by another client) is a card
 * drawn from the view. The person's replies and sub-threads are annotations
 * of the page like any comment until a send carries them: a reply threads
 * under its card (`inReplyTo`), a sub-thread on a passage of a card's words
 * is one whose id starts with `PASSAGE_ANNOTATION_PREFIX`, never painted on
 * the document, of any kind a comment on the document is (a comment, a
 * deletion, a quick label's).
 */
import type { ReviewThreadsState } from '@plannotator/core/external-annotation';
import type { ReviewAnchor, ReviewReplyNode, ReviewThreadNode, ReviewThreadView } from '@plannotator/core/review-threads';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import { PASSAGE_ANNOTATION_PREFIX } from '@plannotator/ui/utils/annotationOwnsHighlight';
import type { PassageMark } from '@plannotator/ui/utils/passageSelection';

/** The loop as the page reads it while it is available. */
export type ReviewLoopState = Extract<ReviewThreadsState, { available: true }>;

/** A body of `GET /api/threads` (or the event, or a write's answer) when the loop is available and its view is one this page reads; else null. */
export function readReviewLoopState(value: unknown): ReviewLoopState | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (body.available !== true || typeof body.review !== 'string') return null;
  const view = body.view as Partial<ReviewThreadView> | undefined;
  if (!view || view.v !== 1 || !Array.isArray(view.threads) || typeof view.round !== 'number') return null;
  return value as ReviewLoopState;
}

/** One element of the review: a thread (a comment or a sub-thread) or a reply under one. */
export interface ReviewLoopElement {
  kind: 'thread' | 'reply';
  node: ReviewThreadNode | ReviewReplyNode;
  /** The thread it belongs to: itself for a thread, the one it is under for a reply. */
  thread: ReviewThreadNode;
  /** The top-level thread it sits in. */
  top: ReviewThreadNode;
  /** The element it is drawn under: null for a top-level thread; a reply's thread; a sub-thread's message. */
  under: string | null;
  /** A thread above it is folded (resolved, nothing open under it): not drawn. */
  hidden: boolean;
}

export interface ReviewLoopIndex {
  elements: ReadonlyMap<string, ReviewLoopElement>;
  /** What a send carried, and every agent's reply: no longer the page's drafts. */
  sent: ReadonlySet<string>;
  /** The header's count ("Round 2 · 3 open"): the round under way and the sent threads still open; null until something was sent. */
  count: { round: number; open: number } | null;
}

export const EMPTY_REVIEW_LOOP_INDEX: ReviewLoopIndex = { elements: new Map(), sent: new Set(), count: null };

/** Every element of a thread view, by id, with where it is drawn. */
export function indexReviewLoop(view: ReviewThreadView | null | undefined): ReviewLoopIndex {
  if (!view) return EMPTY_REVIEW_LOOP_INDEX;
  const elements = new Map<string, ReviewLoopElement>();
  const sent = new Set<string>();
  let open = 0;
  let anySent = false;
  const visit = (thread: ReviewThreadNode, top: ReviewThreadNode, under: string | null, hidden: boolean) => {
    elements.set(thread.id, { kind: 'thread', node: thread, thread, top, under, hidden });
    if (!thread.draft) {
      sent.add(thread.id);
      anySent = true;
      if (thread.state === 'open') open += 1;
    }
    const below = hidden || thread.folded;
    for (const reply of thread.replies) {
      elements.set(reply.id, { kind: 'reply', node: reply, thread, top, under: thread.id, hidden: below });
      if (!reply.draft) sent.add(reply.id);
      for (const sub of reply.sub_threads) visit(sub, top, reply.id, below);
    }
    for (const sub of thread.sub_threads) visit(sub, top, thread.id, below);
  };
  for (const thread of view.threads) visit(thread, thread, null, false);
  return { elements, sent, count: anySent ? { round: view.round, open } : null };
}

/** The sent comment threads still open (comments and sub-threads, at any depth), by id, in the view's order. */
export function reviewLoopOpenThreads(index: ReviewLoopIndex): string[] {
  const open: string[] = [];
  for (const element of index.elements.values()) {
    if (element.kind === 'thread' && !element.node.draft && (element.node as ReviewThreadNode).state === 'open') open.push(element.node.id);
  }
  return open;
}

/**
 * How the review ended, in a line the agent reads with the decision (the
 * bench's R6: the agent always learns the end state, even from Done): every
 * comment thread resolved, or the ids still open. Null when nothing was ever
 * sent in the loop (today's decision says it all).
 */
export function reviewLoopEndState(index: ReviewLoopIndex, ending: 'approved' | 'done' | 'closed'): string | null {
  if (index.count === null) return null;
  const open = reviewLoopOpenThreads(index);
  const threads = open.length === 0 ? 'every comment thread is resolved' : `${open.length === 1 ? '1 comment thread stays' : `${open.length} comment threads stay`} open: ${open.join(', ')}`;
  const lead = ending === 'approved' ? 'Review approved' : ending === 'done' ? 'Review ended (Done)' : 'Review closed';
  // The host gives it as a line of its own (`reviewEnd`), outside any feedback prompt.
  const rest = ending === 'approved' ? '' : ' Nothing more is asked.';
  return `${lead}${open.length === 0 ? ':' : ';'} ${threads}.${rest}`;
}

/** An annotation not yet sent: the page's own, minus what the loop says went. The same list when nothing went (the loop off). */
export function withoutSent<T extends { id: string }>(list: T[], sent: ReadonlySet<string>): T[] {
  if (sent.size === 0 || !list.some((item) => sent.has(item.id))) return list;
  return list.filter((item) => !sent.has(item.id));
}

/** A sub-thread draft of the page's: a comment on a passage of a card's words. */
export function isPassageAnnotation(annotation: Pick<Annotation, 'id'>): boolean {
  return annotation.id.startsWith(PASSAGE_ANNOTATION_PREFIX);
}

/**
 * The thread an answer on a card goes under: the card's own thread when the
 * card is an element of the review (a reply's or an agent's reply's thread),
 * or, for the page's reply draft, the thread its card is under. Null when
 * the card is a draft that is not under a sent thread, or a sub-thread not
 * sent yet (a thread of its own, without an id the agent knows).
 */
export function reviewLoopThreadOf(id: string, index: ReviewLoopIndex, byId: ReadonlyMap<string, Pick<Annotation, 'id' | 'inReplyTo'>>): string | null {
  const seen = new Set<string>();
  for (let at: string | undefined = id; at !== undefined && !seen.has(at); ) {
    seen.add(at);
    const element = index.elements.get(at);
    if (element && !element.node.draft) return element.thread.id;
    if (isPassageAnnotation({ id: at })) return null;
    at = byId.get(at)?.inReplyTo;
  }
  return null;
}

/** The milliseconds a send's or a reply's id was minted at (`snd_<ulid>`), or null. */
function idTime(id: string): number | null {
  const match = /^[a-z]+_([0-9A-HJKMNP-TV-Z]{10})/.exec(id);
  if (!match) return null;
  const digits = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = 0;
  for (const ch of match[1]!) time = time * 32 + digits.indexOf(ch);
  return time;
}

/** The anchor fields a card drawn from the view takes from its thread's annotation on the page, so a reply to it lands where its thread is. */
function placeOf(annotation: Annotation | undefined): Pick<Annotation, 'blockId' | 'startOffset' | 'endOffset'> & Partial<Annotation> {
  if (!annotation) return { blockId: '', startOffset: 0, endOffset: 0 };
  return {
    blockId: annotation.blockId,
    startOffset: annotation.startOffset,
    endOffset: annotation.endOffset,
    ...(annotation.startMeta ? { startMeta: annotation.startMeta } : {}),
    ...(annotation.endMeta ? { endMeta: annotation.endMeta } : {}),
    ...(annotation.htmlAnchor ? { htmlAnchor: annotation.htmlAnchor } : {}),
    ...(annotation.diagramAnchor ? { diagramAnchor: annotation.diagramAnchor } : {}),
    ...(annotation.pageUrl ? { pageUrl: annotation.pageUrl } : {}),
  };
}

/**
 * The cards the panel draws from the view, beside the page's annotations:
 * every sent element the page does not hold (the agent's replies; a comment,
 * reply or sub-thread another client sent), on what the page shows now
 * (`here`, by its top thread), not hidden under a folded thread. A reply
 * threads under its thread, a sub-thread under the message it is on.
 */
export function reviewLoopCards(input: {
  index: ReviewLoopIndex;
  /** The page's annotations, every document's: a sent one keeps its own card. */
  held: ReadonlyMap<string, Annotation>;
  /** Whether a top-level thread is on what the page shows now. */
  here: (top: ReviewThreadNode) => boolean;
  /** The person's name, on the person's cards. */
  person?: string;
}): Annotation[] {
  const out: Annotation[] = [];
  for (const [id, element] of input.index.elements) {
    if (input.held.has(id) || element.node.draft || element.hidden || !input.here(element.top)) continue;
    const thread = element.thread;
    const place = placeOf(input.held.get(element.top.id));
    const replyNode = element.kind === 'reply' ? (element.node as ReviewReplyNode) : null;
    const agent = replyNode?.author.kind === 'agent';
    const at = replyNode ? Date.parse(replyNode.at) : idTime(thread.reply_id) ?? idTime(thread.replies[0]?.id ?? '') ?? 1;
    const author = agent ? (replyNode?.author_name ?? undefined) : input.person;
    const quote = element.kind === 'reply' ? thread.quote : (element.node as ReviewThreadNode).quote;
    const deletion = element.kind === 'thread' && (element.node as ReviewThreadNode).type === 'deletion';
    out.push({
      ...place,
      id,
      type: deletion ? AnnotationType.DELETION : element.kind === 'thread' && element.under === null && quote === '' ? AnnotationType.GLOBAL_COMMENT : AnnotationType.COMMENT,
      text: element.node.text,
      originalText: quote,
      createdA: Number.isFinite(at) ? at : 1,
      ...(author ? { author } : {}),
      ...(element.under !== null ? { inReplyTo: element.under } : {}),
    });
  }
  return out;
}

/** The passages to mark in a card's words: the open sub-threads on it, sent (the view) or the page's drafts; a deletion's as one. */
export function reviewLoopPassages(input: {
  index: ReviewLoopIndex;
  /** The page's sub-thread drafts. */
  drafts: readonly Annotation[];
  /** Where a draft's passage starts, when the page knows it. */
  offsets: ReadonlyMap<string, number>;
  /** A card's words, to find a draft's passage in when its offset is not known. */
  wordsOf: (id: string) => string | undefined;
}): Map<string, PassageMark[]> {
  const out = new Map<string, PassageMark[]>();
  const add = (on: string, passage: PassageMark) => out.set(on, [...(out.get(on) ?? []), passage]);
  for (const element of input.index.elements.values()) {
    const node = element.node as ReviewThreadNode;
    if (element.kind !== 'thread' || element.under === null || node.state !== 'open' || !node.parent) continue;
    add(element.under, { quote: node.quote, offset: node.parent.quote_offset, ...(node.type === 'deletion' ? { deletion: true } : {}) });
  }
  for (const draft of input.drafts) {
    if (!draft.inReplyTo || !isPassageAnnotation(draft)) continue;
    const known = input.offsets.get(draft.id);
    const words = input.wordsOf(draft.inReplyTo) ?? '';
    const found = words.indexOf(draft.originalText);
    // An offset counts whitespace runs as one and drops the leading run (@plannotator/core/passage).
    const offset = found >= 0 ? words.slice(0, found).replace(/^\s+/, '').replace(/\s+/g, ' ').length : 0;
    add(draft.inReplyTo, { quote: draft.originalText, offset: known ?? offset, ...(draft.type === AnnotationType.DELETION ? { deletion: true } : {}) });
  }
  return out;
}

/** What a send carries of one of the person's comments (packages/shared/review-journal.ts `ReviewCommentInput`, with `notes`). */
export interface ReviewLoopCommentInput {
  id: string;
  on?: ReviewAnchor;
  quote?: string;
  text: string;
  type?: 'comment' | 'deletion';
  re?: string;
  parent?: string;
  quote_offset?: number;
  annotation?: Record<string, unknown>;
  /** Lines under its heading in the agent's text (attached images). */
  notes?: string[];
}

/** The lines an annotation's images add under its entry, as today's feedback lists them. */
export function reviewLoopImageNotes(annotation: Pick<Annotation, 'images'>): string[] {
  const images = annotation.images ?? [];
  if (images.length === 0) return [];
  return ['Attached images:', ...images.map((image) => `- [${image.name}] \`${image.path}\``)];
}

/** An annotation whose entry in today's feedback says more than its words and quote (an answer, a label's tip, an element, an image region, a diagram part, the plan diff). */
function carriesContext(annotation: Annotation): boolean {
  return annotation.questionAnswer != null
    || (annotation.isQuickLabel === true && !!annotation.quickLabelTip)
    || annotation.imageRegion != null
    || annotation.elementContext != null
    || (annotation.htmlAdditionalTargets?.length ?? 0) > 0
    || annotation.diagramAnchor != null
    || annotation.diffContext != null;
}

/** The most of a quote and of a comment's words a record holds (packages/shared/review-journal.ts): longer ones are cut here, never refused for the whole round. */
const QUOTE_MAX = 20_000;
const TEXT_MAX = 10_000;
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The document lines a block spans, as the journal's anchor names them (`lines`), when the block is known. */
function blockLines(blocks: readonly { id: string; startLine?: number; content?: string }[] | undefined, blockId: string): [number, number] | null {
  const block = blocks?.find((entry) => entry.id === blockId);
  if (!block || typeof block.startLine !== 'number' || block.startLine < 1) return null;
  const span = (block.content ?? '').replace(/\n+$/, '').split('\n').length;
  return [block.startLine, block.startLine + Math.max(0, span - 1)];
}

/**
 * The person's drafts as a send carries them, in order: a reply under a sent
 * thread (`re`, a comment), a sub-thread on a passage of a sent message
 * (`parent`), and any other annotation as a comment on the place it is on
 * (`on`, its words; a general comment has no words). A sub-thread and a
 * comment on the place are of the kind the toolbar made, one rule for both:
 * a deletion (`type`, its words optional) or a comment. Images become lines
 * under the entry.
 */
export function reviewLoopCommentInputs(
  groups: readonly { on: ReviewAnchor; annotations: readonly Annotation[]; blocks?: readonly { id: string; startLine?: number; content?: string }[] }[],
  context: {
    index: ReviewLoopIndex;
    /** The page's annotations and the panel's cards, by id (to walk a reply draft up to its thread). */
    byId: ReadonlyMap<string, Pick<Annotation, 'id' | 'inReplyTo'>>;
    offsets: ReadonlyMap<string, number>;
    /** Today's feedback entry of an annotation (`exportAnnotationEntry`): its lines go under the entry when it says more than the words. */
    entry?: (annotation: Annotation) => string;
  },
): ReviewLoopCommentInput[] {
  const out: ReviewLoopCommentInput[] = [];
  for (const group of groups) {
    for (const annotation of group.annotations) {
      const images = reviewLoopImageNotes(annotation);
      const entryLines = context.entry && carriesContext(annotation)
        ? context.entry(annotation).split('\n').filter((line) => line.trim() !== '' && !line.startsWith('**Attached images:**') && !/^- \[[^\]]*\] `/.test(line))
        : [];
      const words = clip(annotation.text?.trim() ? annotation.text : images.length > 0 ? 'See the attached images.' : '(no words)', TEXT_MAX);
      const thread = annotation.inReplyTo ? reviewLoopThreadOf(annotation.inReplyTo, context.index, context.byId) : null;
      const parentSent = annotation.inReplyTo ? context.index.sent.has(annotation.inReplyTo) : false;
      // A reply to a comment the same round carries, which has no id the agent knows yet: a comment of its own, said so.
      const replyTo = annotation.inReplyTo && thread === null && !(isPassageAnnotation(annotation) && parentSent) ? [`In reply to comment ${annotation.inReplyTo}.`] : [];
      const notes = [...replyTo, ...entryLines, ...images];
      const base = { id: annotation.id, ...(notes.length > 0 ? { notes } : {}) };
      const deletion = annotation.type === AnnotationType.DELETION;
      /** Its kind and words: a deletion's words are its own or none; a comment always has some. */
      const kind = deletion ? { type: 'deletion' as const, text: clip(annotation.text ?? '', TEXT_MAX) } : { text: words };
      if (annotation.inReplyTo && isPassageAnnotation(annotation) && parentSent) {
        const offset = context.offsets.get(annotation.id);
        out.push({ ...base, parent: annotation.inReplyTo, quote: clip(annotation.originalText, QUOTE_MAX), ...kind, ...(offset !== undefined ? { quote_offset: offset } : {}) });
        continue;
      }
      if (thread !== null) {
        out.push({ ...base, re: thread, text: words });
        continue;
      }
      const on = group.on;
      const lines = on.kind !== 'message' && !on.lines && annotation.type !== AnnotationType.GLOBAL_COMMENT ? blockLines(group.blocks, annotation.blockId) : null;
      out.push({
        ...base,
        on: lines && on.kind !== 'message' ? { ...on, lines } : on,
        quote: annotation.type === AnnotationType.GLOBAL_COMMENT ? '' : clip(annotation.originalText ?? '', QUOTE_MAX),
        ...kind,
        annotation: annotation as unknown as Record<string, unknown>,
      });
    }
  }
  return out;
}

/** A message of `last`'s picker. */
export interface ReviewLoopMessage {
  messageId: string;
  text: string;
  timestamp?: string;
}

function isPickerMessage(value: unknown): value is ReviewLoopMessage {
  const message = value as Partial<ReviewLoopMessage> | null;
  return !!message && typeof message.messageId === 'string' && message.messageId !== '' && typeof message.text === 'string' && (message.timestamp === undefined || typeof message.timestamp === 'string');
}

/**
 * `last`'s picker with the agent's next messages (`hostMessages` of
 * `/api/plan`, the `messages` event; the session's latest, newest first, then
 * the screen's own): the ones the picker lacks join it in that order, a
 * message it shows keeps its words, and the selection does not move. A
 * screen opened on one message with no list (`shown` empty) keeps it
 * selected: the incoming message with its words is named as that one
 * (`opened`); when none has them, the list is left as it is. Null: nothing
 * to add.
 */
export function mergeHostMessages<M extends ReviewLoopMessage>(shown: readonly M[], incoming: unknown, opened: string | null): { messages: ReviewLoopMessage[]; opened?: string } | null {
  if (!Array.isArray(incoming)) return null;
  const valid = incoming.filter(isPickerMessage);
  const known = new Map(shown.map((message) => [message.messageId, message]));
  if (valid.every((message) => known.has(message.messageId))) return null;
  if (shown.length === 0) {
    const words = opened?.trim();
    const same = words ? valid.find((message) => message.text.trim() === words) : undefined;
    return same ? { messages: valid, opened: same.messageId } : null;
  }
  const merged: ReviewLoopMessage[] = valid.map((message) => known.get(message.messageId) ?? message);
  const listed = new Set(merged.map((message) => message.messageId));
  for (const message of shown) if (!listed.has(message.messageId)) merged.push(message);
  return { messages: merged };
}
