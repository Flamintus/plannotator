/**
 * Comments that stay after Send (experimental "persistent-comments"): what
 * the window does with the comments a Send carried, which the thread's files
 * list as `sent_comments` while the switch is on. They stay on the file and
 * the message, read-only, each with its round (packages/core/inbox-comment-threads.ts);
 * a code comment follows its lines when the agent adds or removes lines above
 * them; what the window finds of their words is kept, so an agent reads
 * which ones lost their place; the person resolves them, or opens them
 * again; replies sit under them, the agents' and the person's, in one flat
 * list per comment; and sub-threads, the person's comments on a passage of
 * one of those messages, sit under the message they are on, each a thread
 * of its own. Who is under what, the rounds and the fold are the core's
 * (packages/core/inbox-comment-threads.ts, and the thread view of
 * packages/core/inbox-comment-sends.ts, which `sentCommentsParts` reads).
 */

import type { InboxCommentThreadNode, InboxCommentThreadView } from '@plannotator/core/inbox-comment-sends';
import { inboxCommentReplyAnnotation, inboxMovedLines, isInboxCommentReply } from '@plannotator/core/inbox-comment-threads';
import type { TextPassage } from '@plannotator/core/passage';
import { inboxAgentName, type InboxAnnotationRecord, type InboxCommentReplyRecord } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';
import { codeRangeMatches, codeRangeOf } from './attachments';

/**
 * The sent comments whose kept state differs from what the window just found:
 * each one it tried to place (`attempted`), unanchored or found again. A
 * comment it did not try (another file, a draft) is left as it is.
 */
export function sentUnanchoredChanges(
  sent: readonly InboxAnnotationRecord[],
  report: { attempted: readonly string[]; unanchored: readonly string[] },
): { id: string; unanchored: boolean }[] {
  const attempted = new Set(report.attempted);
  const unanchored = new Set(report.unanchored);
  return sent.filter((record) => attempted.has(record.id) && (typeof record.unanchored_at === 'string') !== unanchored.has(record.id)).map((record) => ({ id: record.id, unanchored: unanchored.has(record.id) }));
}

/**
 * A sent code comment where its lines are now: the same lines moved by lines
 * added or removed above them (the nearest run that reads as it did), or as
 * it is when they still read so or are gone (then it is unanchored).
 */
export function followCodeLines(annotation: Annotation, lines: readonly string[]): Annotation {
  const range = codeRangeOf(annotation);
  if (!range) return annotation;
  const count = range.lineEnd - range.lineStart + 1;
  const start = inboxMovedLines(lines, range.lineStart, count, (text) => codeRangeMatches(range, text));
  if (start === null || start === range.lineStart) return annotation;
  const lineEnd = start + count - 1;
  return { ...annotation, blockId: `code-L${start}-${lineEnd}`, inboxCode: { ...range, lineStart: start, lineEnd } } as Annotation;
}

/**
 * The sent comments as listed, with what this window's own Resolve or Reopen
 * wrote since (`written`, by id), drawn as soon as the Inbox answered: the
 * files' next read carries the same record, and a newer one (another
 * window's change) wins over it.
 */
export function withSentWrites(listed: readonly InboxAnnotationRecord[], written: ReadonlyMap<string, InboxAnnotationRecord>): readonly InboxAnnotationRecord[] {
  if (written.size === 0) return listed;
  return listed.map((record) => {
    const mine = written.get(record.id);
    return mine && mine.updated_at >= record.updated_at ? mine : record;
  });
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

/** What the window draws of a thread's comments beyond the records themselves (`sentCommentsParts`). */
export interface SentCommentsParts {
  /** The replies under each comment or sub-thread, by its id, oldest first: the agents', the person's sent ones and their drafts. */
  replies: Map<string, SentReplyRow[]>;
  /** The sub-threads on each message (a comment, a reply or a sub-thread), by its id, as records: the sent ones, then the drafts. */
  subThreads: Map<string, InboxAnnotationRecord[]>;
  /** The passages to mark in each message's words: its sub-threads still open (a draft too); a resolved one is not marked. */
  passages: Map<string, TextPassage[]>;
  /** Each sent reply's round, by id: the person's, its send's; an agent's, the round under way when it wrote. */
  replyRounds: Map<string, number>;
}

/**
 * The parts of a thread's comments as the window draws them, read from the
 * thread view (`inboxCommentThreadView`, built on the thread's records, its
 * drafts included): one assembly of the thread for the window, `read_thread`
 * and any other client. `records` gives each sub-thread's record back.
 */
export function sentCommentsParts(view: InboxCommentThreadView, records: readonly InboxAnnotationRecord[]): SentCommentsParts {
  const byId = new Map(records.map((record) => [record.id, record]));
  const parts: SentCommentsParts = { replies: new Map(), subThreads: new Map(), passages: new Map(), replyRounds: new Map() };
  const subThreadsOn = (host: string, subs: readonly InboxCommentThreadNode[]) => {
    const list = subs.flatMap((sub) => byId.get(sub.id) ?? []);
    if (list.length > 0) parts.subThreads.set(host, list);
    const open = subs.filter((sub) => sub.state !== 'resolved').map((sub) => ({ quote: sub.quote, offset: sub.parent?.quote_offset ?? 0 }));
    if (open.length > 0) parts.passages.set(host, open);
    for (const sub of subs) walk(sub);
  };
  const walk = (node: InboxCommentThreadNode) => {
    if (node.replies.length > 0) {
      parts.replies.set(
        node.id,
        node.replies.map((reply) => ({ id: reply.id, who: reply.author_name ?? 'You', round: reply.draft ? undefined : reply.round, text: reply.text, at: reply.at, draft: reply.draft })),
      );
    }
    for (const reply of node.replies) {
      if (!reply.draft) parts.replyRounds.set(reply.id, reply.round);
      subThreadsOn(reply.id, reply.sub_threads);
    }
    subThreadsOn(node.id, node.sub_threads);
  };
  for (const node of view.threads) walk(node);
  return parts;
}

/** An agent's reply as a card of the file's panel: in its comment's place, threaded under it (`inReplyTo`), by the agent. */
export function agentReplyAnnotation(comment: Pick<InboxAnnotationRecord, 'id' | 'annotation'>, reply: InboxCommentReplyRecord): Annotation {
  const annotation = inboxCommentReplyAnnotation(comment, { id: reply.id, text: reply.text, createdA: Date.parse(reply.created_at) });
  return { ...annotation, author: inboxAgentName(reply.from) } as unknown as Annotation;
}

/** The comment a reply under a card goes under: a reply's own comment (one list per comment), else the card itself. */
export function commentOfCard(id: string, records: readonly InboxAnnotationRecord[], agentReplies: readonly InboxCommentReplyRecord[]): string {
  const agent = agentReplies.find((reply) => reply.id === id);
  if (agent) return agent.re;
  const record = records.find((r) => r.id === id);
  return record && isInboxCommentReply(record) ? record.re! : id;
}

/**
 * Where the threads on a document (a message, or a file) are drawn: each
 * under the block its passage starts in (`annotation.blockId`, or where the
 * viewer found its words since, `moved`), several on one block in the order
 * given; a thread whose block is not drawn, or whose words were not found
 * (`unanchored`, or its kept `unanchored_at`), at the document's end.
 */
export function placeThreads(
  records: readonly InboxAnnotationRecord[],
  blockIds: ReadonlySet<string>,
  found: { moved?: ReadonlyMap<string, string>; unanchored?: ReadonlySet<string> } = {},
): { byBlock: Map<string, InboxAnnotationRecord[]>; rest: InboxAnnotationRecord[] } {
  const byBlock = new Map<string, InboxAnnotationRecord[]>();
  const rest: InboxAnnotationRecord[] = [];
  for (const record of records) {
    const stored = record.annotation.blockId;
    const block = found.moved?.get(record.id) ?? (typeof stored === 'string' ? stored : '');
    const lost = found.unanchored ? found.unanchored.has(record.id) : typeof record.unanchored_at === 'string';
    if (lost || !blockIds.has(block)) rest.push(record);
    else byBlock.set(block, [...(byBlock.get(block) ?? []), record]);
  }
  return { byBlock, rest };
}

/** A thread's fold (Thread.tsx): its folded messages, the runs behind "N earlier messages" and the ones opened, and the messages already kept open for their threads. */
interface ThreadFold {
  folded: Set<string>;
  hidden: string[][];
  revealed: Set<number>;
  kept?: ReadonlySet<string>;
}

/**
 * A thread's fold once its comments are read: a message that holds a comment
 * thread still open (`open`) opens unfolded, and out of "N earlier messages"
 * (its run is cut around it). Each message is kept open once (`kept`), so the
 * person can fold it again; every other message stays as it is, and nothing
 * the person opened folds. The same fold when nothing changes.
 */
export function unfoldOpenThreads<F extends ThreadFold>(fold: F, open: ReadonlySet<string>): F {
  const fresh = [...open].filter((id) => !fold.kept?.has(id));
  if (fresh.length === 0) return fold;
  const kept = new Set([...(fold.kept ?? []), ...fresh]);
  const keep = new Set(fresh.filter((id) => fold.folded.has(id)));
  if (keep.size === 0) return { ...fold, kept };
  const hidden: string[][] = [];
  fold.hidden.forEach((run, index) => {
    if (fold.revealed.has(index)) return;
    let part: string[] = [];
    for (const id of run) {
      if (!keep.has(id)) part.push(id);
      else if (part.length > 0) {
        hidden.push(part);
        part = [];
      }
    }
    if (part.length > 0) hidden.push(part);
  });
  return { ...fold, folded: new Set([...fold.folded].filter((id) => !keep.has(id))), hidden, revealed: new Set<number>(), kept };
}
