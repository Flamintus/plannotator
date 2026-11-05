/**
 * What the comment thread boxes (`SentThreads`) draw, and where: the pure
 * side of the boxes, moved here unchanged from packages/inbox/sentComments.ts
 * and packages/inbox/components/SentComments.tsx. A host builds the boxes'
 * `SentCommentsTree` from core: the replies, sub-threads and passages from
 * the thread view (`sentCommentsParts` over `inboxCommentThreadView`), the
 * rounds from `inboxCommentRounds`, the resolved ids from `inboxCommentState`
 * (with `inboxCommentLastReplies`) and the messages with an open sub-thread under them from
 * `inboxOpenSubThreadPaths`; `placeThreads` names the block each thread goes
 * under (`Viewer`'s `belowBlock`; `isGeneralThread`, a comment on the whole
 * document, at its end), and `placeOnMessage` the block of a message's words
 * each sub-thread goes under: one placement at every depth.
 *
 * A host that keeps no records of its own (the screens' review loop, any
 * client of the neutral thread view of `@plannotator/core/review-threads`)
 * builds the same props from that view alone, with its own drafts beside it
 * (`sentThreadsFromView`), so every web client draws the same boxes. Both
 * read the view by one walk (`walkThreadView`), and a message's passages are
 * marked by one rule (`subThreadMark`), the screens' cards included.
 */

import type { InboxCommentSendStatus } from '@plannotator/core/inbox-comment-sends';
import { findPassage, type TextPassage } from '@plannotator/core/passage';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import type { ReviewThreadNode, ReviewThreadView } from '@plannotator/core/review-threads';
import { AnnotationType } from '../../types';
import type { PassageMark } from '../../utils/passageSelection';

/**
 * What the boxes read of a thread's record, whichever client keeps it: the
 * Inbox's `InboxAnnotationRecord`, or one a host builds from the neutral
 * thread view (`sentThreadsFromView`).
 */
export interface SentThreadRecord {
  id: string;
  /** Its drawing data: the passage (`originalText`), its words (`text`), the block it starts in (`blockId`). */
  annotation: Record<string, unknown>;
  /** What carried it to the agent (its round is `SentCommentsTree.rounds`'); null while a draft. */
  sent_reply_id: string | null;
  /** A sub-thread: the message whose passage it is on. */
  parent?: string;
  /** A sub-thread's passage: where it starts in its parent's words (core's passage.ts); absent, its quote's first place there. */
  quote_offset?: number;
  /** Its words were not found where it was made. */
  unanchored_at?: string | null;
}

/** One reply under a sent comment, as the list under a message draws it. */
export interface SentReplyRow {
  id: string;
  /** The agent's name, or `You`. */
  who: string;
  round: number | undefined;
  text: string;
  at: string;
  /** The person's reply that the next Send carries. */
  draft: boolean;
}

/** What the list under a message draws of the thread's comments, beyond its own rows. */
export interface SentCommentsTree<R extends SentThreadRecord = InboxAnnotationRecord> {
  rounds: ReadonlyMap<string, number>;
  resolved: ReadonlySet<string>;
  /** The replies under each comment or sub-thread. */
  replies: ReadonlyMap<string, readonly SentReplyRow[]>;
  /** The sub-threads on each message (drafts too). */
  subThreads: ReadonlyMap<string, readonly R[]>;
  /** The messages with an open sub-thread under them. */
  openBelow: ReadonlySet<string>;
  /** The passages to mark in each message's words (a deletion's, as one). */
  passages: ReadonlyMap<string, readonly PassageMark[]>;
  /** What became of each element a comment send carried (a thread's comment, the person's reply), by id. Absent: none drawn. */
  statuses?: ReadonlyMap<string, InboxCommentSendStatus>;
  /** The threads a send reached at once: the person's next replies in them go on their own. Absent: none. */
  live?: ReadonlySet<string>;
  /** The agents' replies the person has not seen yet, by id, marked New. Absent: none. */
  fresh?: ReadonlySet<string>;
}

/** What the window draws of a thread's comments beyond the records themselves (`sentCommentsParts`). */
export interface SentCommentsParts<R extends SentThreadRecord = InboxAnnotationRecord> {
  /** The replies under each comment or sub-thread, by its id, oldest first: the agents', the person's sent ones and their drafts. */
  replies: Map<string, SentReplyRow[]>;
  /** The sub-threads on each message (a comment, a reply or a sub-thread), by its id, as records: the sent ones, then the drafts. */
  subThreads: Map<string, R[]>;
  /** The passages to mark in each message's words: all its sub-threads', open, resolved or draft, as the document keeps every comment's highlight (a deletion's, as one). */
  passages: Map<string, PassageMark[]>;
  /** Each sent reply's round, by id: the person's, its send's; an agent's, the round under way when it wrote. */
  replyRounds: Map<string, number>;
  /** What became of each element a comment send carried, by id: a thread's (its comment's), and the person's sent replies'. */
  statuses: Map<string, InboxCommentSendStatus>;
  /** The live threads, by id: a send reached them at once. */
  live: Set<string>;
}

/**
 * The parts of a thread's comments as the window draws them, read from the
 * thread view (`inboxCommentThreadView`, built on the thread's records, its
 * drafts included): one assembly of the thread for the window, `read_thread`
 * and any other client. `records` gives each sub-thread's record back.
 */
export function sentCommentsParts<R extends SentThreadRecord, A>(view: ReviewThreadView<A>, records: readonly R[]): SentCommentsParts<R> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const { replies, subThreads, passages, replyRounds, statuses, live } = walkThreadView(view, (node) => byId.get(node.id));
  return { replies, subThreads, passages, replyRounds, statuses, live };
}

/**
 * The one walk of a thread view that every host's boxes are read from (`sentCommentsParts`, `sentThreadsFromView`),
 * at any depth: each thread's replies (the person's named `person`), the sub-threads on each message (`recordOf`'s
 * records, then the host's drafts), the passages each message marks (every sub-thread's, resolved or not, as the
 * document keeps every comment's highlight, then the host's drafts'), the rounds (a thread's by what carried it, a
 * person's sent reply's by its send too, and each sent reply's by id), what became of each send, the live and the
 * resolved threads, and the threads with something open under them (a sub-thread open, or a draft of the host's).
 */
function walkThreadView<A, R extends SentThreadRecord>(
  view: ReviewThreadView<A>,
  recordOf: (node: ReviewThreadNode<A>) => R | undefined,
  options: { person?: string; drafts?: SentViewDrafts<R> } = {},
) {
  const { person = 'You', drafts = {} } = options;
  const out = {
    replies: new Map<string, SentReplyRow[]>(),
    subThreads: new Map<string, R[]>(),
    passages: new Map<string, PassageMark[]>(),
    replyRounds: new Map<string, number>(),
    rounds: new Map<string, number>(),
    statuses: new Map<string, InboxCommentSendStatus>(),
    live: new Set<string>(),
    resolved: new Set<string>(),
    openBelow: new Set<string>(),
  };
  /** Whether anything under a thread, at any depth, is open. */
  const walk = (node: ReviewThreadNode<A>): boolean => {
    if (!node.draft) out.rounds.set(node.reply_id, node.round);
    if (node.state === 'resolved') out.resolved.add(node.id);
    if (node.status) out.statuses.set(node.id, node.status);
    if (node.live) out.live.add(node.id);
    const own = drafts.replies?.get(node.id) ?? [];
    const rows: SentReplyRow[] = node.replies.map((reply) => ({ id: reply.id, who: reply.author_name ?? person, round: reply.draft ? undefined : reply.round, text: reply.text, at: reply.at, draft: reply.draft }));
    if (rows.length + own.length > 0) out.replies.set(node.id, [...rows, ...own]);
    let open = own.length > 0;
    const on = (message: string, subs: readonly ReviewThreadNode<A>[]) => {
      const added = drafts.subThreads?.get(message) ?? [];
      const list = [...subs.flatMap((sub) => recordOf(sub) ?? []), ...added];
      if (list.length > 0) out.subThreads.set(message, list);
      if (added.length > 0) open = true;
      const marked = [...subs.map(subThreadMark), ...(drafts.passages?.get(message) ?? [])];
      if (marked.length > 0) out.passages.set(message, marked);
      for (const sub of subs) if (walk(sub) || sub.state !== 'resolved') open = true;
    };
    for (const reply of node.replies) {
      if (!reply.draft) {
        out.replyRounds.set(reply.id, reply.round);
        if (reply.author.kind !== 'agent' && reply.message_id !== '') out.rounds.set(reply.message_id, reply.round);
      }
      if (reply.status) out.statuses.set(reply.id, reply.status);
      on(reply.id, reply.sub_threads);
    }
    on(node.id, node.sub_threads);
    if (open) out.openBelow.add(node.id);
    return open;
  };
  for (const node of view.threads) walk(node);
  return out;
}

/**
 * Where the threads on a document (a message, or a file) are drawn: each
 * under the block its passage starts in (`annotation.blockId`, or where the
 * viewer found its words since, `moved`), several on one block in the order
 * given; a thread whose block is not drawn, or whose words were not found
 * (`unanchored`, or its kept `unanchored_at`), at the document's end.
 */
export function placeThreads<R extends SentThreadRecord>(
  records: readonly R[],
  blockIds: ReadonlySet<string>,
  found: { moved?: ReadonlyMap<string, string>; unanchored?: ReadonlySet<string> } = {},
): { byBlock: Map<string, R[]>; rest: R[] } {
  const byBlock = new Map<string, R[]>();
  const rest: R[] = [];
  for (const record of records) {
    const stored = record.annotation.blockId;
    const block = found.moved?.get(record.id) ?? (typeof stored === 'string' ? stored : '');
    const lost = found.unanchored ? found.unanchored.has(record.id) : typeof record.unanchored_at === 'string';
    if (lost || !blockIds.has(block)) rest.push(record);
    else byBlock.set(block, [...(byBlock.get(block) ?? []), record]);
  }
  return { byBlock, rest };
}

/**
 * A comment on the whole document: no passage, and neither a sub-thread (its passage is in a message) nor a comment
 * on part of an image or an element (no words, but a place). It goes at the document's end, never Unanchored.
 */
export function isGeneralThread(record: SentThreadRecord): boolean {
  const { originalText, type } = record.annotation;
  return (originalText ?? '') === '' && typeof record.parent !== 'string' && (type === undefined || type === AnnotationType.GLOBAL_COMMENT);
}

/**
 * The blocks of a message's words as its box draws them (pre-wrapped): its
 * paragraphs, which blank lines part, each from its first line's start to its
 * last line's end in `text`.
 */
export function messageBlocks(text: string): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = [];
  let start = -1;
  let end = 0;
  let at = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (start >= 0) blocks.push({ start, end });
      start = -1;
    } else {
      if (start < 0) start = at;
      end = at + line.length;
    }
    at += line.length + 1;
  }
  if (start >= 0) blocks.push({ start, end });
  return blocks;
}

/** A sub-thread's passage as its message marks it, from the thread view: where it starts, and whether it asks for the words to go. */
export function subThreadMark<A>(sub: Pick<ReviewThreadNode<A>, 'quote' | 'parent' | 'type'>): PassageMark {
  return { quote: sub.quote, offset: sub.parent?.quote_offset ?? 0, ...(sub.type === 'deletion' ? { deletion: true } : {}) };
}

/** A sub-thread's passage in its parent's words: its quote, from where it starts (`quote_offset`); none without a quote. */
export function subThreadPassage(record: SentThreadRecord): TextPassage | undefined {
  const quote = record.annotation.originalText;
  if (typeof quote !== 'string' || quote.trim() === '') return undefined;
  return { quote, offset: typeof record.quote_offset === 'number' && record.quote_offset >= 0 ? record.quote_offset : 0 };
}

/** A piece of a message's words as its box draws it (`from` to `to` in them), and what goes under it (`found`: its passage is in the words). */
export interface MessagePiece<T> {
  from: number;
  to: number;
  under: { item: T; found: boolean }[];
}

/**
 * Where what sits on a message's words goes (its sub-threads, the box
 * commenting on a passage of them), as a thread sits under the block of the
 * document its passage starts in: each under the block of the words
 * (`messageBlocks`) its passage starts in, several on one block in the order
 * of their passages (the order given when two start at the same place); one
 * whose passage is not found, at the message's end, after the others, said
 * so (`found` false: its box is Unanchored, as a thread's at a document's end). The
 * words are cut after each block something goes under, the blank lines that
 * part it from the next left out (the boxes part them); a message whose
 * sub-threads all go under its last block is one piece, its words whole.
 */
export function placeOnMessage<T>(text: string, items: readonly T[], passageOf: (item: T) => TextPassage | undefined): MessagePiece<T>[] {
  const blocks = messageBlocks(text);
  const last = Math.max(0, blocks.length - 1);
  const placed = items.map((item, order) => {
    const passage = passageOf(item);
    const found = passage ? findPassage(text, passage) : null;
    if (!found) return { item, order, block: last, at: Number.POSITIVE_INFINITY, found: false };
    let block = 0;
    while (block < last && blocks[block + 1]!.start <= found[0]) block++;
    return { item, order, block, at: found[0], found: true };
  });
  placed.sort((a, b) => a.block - b.block || (a.at === b.at ? 0 : a.at < b.at ? -1 : 1) || a.order - b.order);
  const under = new Map<number, MessagePiece<T>['under']>();
  for (const entry of placed) under.set(entry.block, [...(under.get(entry.block) ?? []), { item: entry.item, found: entry.found }]);
  const pieces: MessagePiece<T>[] = [];
  let from = 0;
  for (let block = 0; block < last; block++) {
    const here = under.get(block);
    if (!here) continue;
    pieces.push({ from, to: blocks[block]!.end, under: here });
    from = blocks[block + 1]!.start;
  }
  pieces.push({ from, to: text.length, under: under.get(last) ?? [] });
  return pieces;
}

/** The person's drafts a host keeps beside the neutral thread view (its own, not in the view yet). */
export interface SentViewDrafts<R extends SentThreadRecord = SentThreadRecord> {
  /** The person's draft replies under each thread, by the thread's id, oldest first. */
  replies?: ReadonlyMap<string, readonly SentReplyRow[]>;
  /** The person's draft sub-threads on each message (a comment, a reply, a sub-thread), by its id. */
  subThreads?: ReadonlyMap<string, readonly R[]>;
  /** The passages of those draft sub-threads, by the message they are on. */
  passages?: ReadonlyMap<string, readonly PassageMark[]>;
}

/**
 * The boxes' props from the neutral thread view alone (`reviewThreadView`,
 * `GET /api/threads` of a screen, the journal's CLI), for a host that keeps
 * no records of its own: the top-level threads in the view's order
 * (`threads`, the drafts after what was sent), each sub-thread's record and
 * the tree. `annotationOf` gives a thread's drawing data when the host holds
 * it (its block, its passage as painted); else its quote, words and type
 * from the view stand in. A resolved thread stays unfolded while something
 * under it is open, a draft of the host's included, as in the Inbox. `person`
 * names the person on their own replies.
 */
export function sentThreadsFromView<A>(
  view: ReviewThreadView<A>,
  options: {
    annotationOf?: (id: string) => Record<string, unknown> | undefined;
    drafts?: SentViewDrafts;
    /** The agents' replies the person has not seen yet. */
    fresh?: ReadonlySet<string>;
    person?: string;
  } = {},
): { threads: SentThreadRecord[]; tree: SentCommentsTree<SentThreadRecord> } {
  const { annotationOf, drafts, fresh, person } = options;
  const recordOf = (node: ReviewThreadNode<A>): SentThreadRecord => ({
    id: node.id,
    annotation: annotationOf?.(node.id) ?? { originalText: node.quote, text: node.text, ...(node.type === 'deletion' ? { type: AnnotationType.DELETION } : {}) },
    sent_reply_id: node.draft ? null : node.reply_id,
    ...(node.parent ? { parent: node.parent.id, quote_offset: node.parent.quote_offset } : {}),
    ...(node.unanchored ? { unanchored_at: 'unanchored' } : {}),
  });
  const { rounds, resolved, replies, subThreads, openBelow, passages, statuses, live } = walkThreadView(view, recordOf, { person, drafts });
  return {
    threads: view.threads.map(recordOf),
    tree: { rounds, resolved, replies, subThreads, openBelow, passages, statuses, live, ...(fresh ? { fresh } : {}) },
  };
}
