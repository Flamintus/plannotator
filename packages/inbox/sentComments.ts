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
 * of its own.
 */

import { inboxCommentReplyAnnotation, inboxCommentReplyRound, inboxMovedLines, inboxQuoteOffset, isInboxCommentReply, isInboxSubThread, type InboxCommentThreadMessage } from '@plannotator/core/inbox-comment-threads';
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

/**
 * Each reply's round, by id: the person's sent reply, the round of the Send
 * that carried it; an agent's, the round under way when it wrote.
 */
export function sentReplyRounds(
  messages: readonly InboxCommentThreadMessage[],
  rounds: ReadonlyMap<string, number>,
  sent: readonly InboxAnnotationRecord[],
  agentReplies: readonly InboxCommentReplyRecord[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const record of sent) {
    const round = isInboxCommentReply(record) && record.sent_reply_id ? rounds.get(record.sent_reply_id) : undefined;
    if (round !== undefined) out.set(record.id, round);
  }
  for (const reply of agentReplies) out.set(reply.id, inboxCommentReplyRound(messages, rounds, reply.created_at));
  return out;
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

/** The replies under each sent comment, by the comment's id, oldest first: the agents', the person's sent ones and their drafts. */
export function sentReplyRows(
  records: readonly InboxAnnotationRecord[],
  agentReplies: readonly InboxCommentReplyRecord[],
  rounds: ReadonlyMap<string, number>,
): Map<string, SentReplyRow[]> {
  const out = new Map<string, SentReplyRow[]>();
  const add = (comment: string, row: SentReplyRow) => out.set(comment, [...(out.get(comment) ?? []), row]);
  for (const record of records) {
    if (!isInboxCommentReply(record) || record.removed_at !== null) continue;
    add(record.re!, { id: record.id, who: 'You', round: rounds.get(record.id), text: typeof record.annotation.text === 'string' ? record.annotation.text : '', at: record.created_at, draft: record.sent_reply_id === null });
  }
  for (const reply of agentReplies) add(reply.re, { id: reply.id, who: inboxAgentName(reply.from), round: rounds.get(reply.id), text: reply.text, at: reply.created_at, draft: false });
  // By time; replies written in the same millisecond keep the order they were written in (a stable sort).
  for (const list of out.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return out;
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

/** The sub-threads on each message (a comment, a reply or a sub-thread), by its id, oldest first: the person's sent ones and their drafts. */
export function subThreadsByParent(records: readonly InboxAnnotationRecord[]): Map<string, InboxAnnotationRecord[]> {
  const out = new Map<string, InboxAnnotationRecord[]>();
  for (const record of records) {
    if (!isInboxSubThread(record) || record.removed_at !== null) continue;
    out.set(record.parent!, [...(out.get(record.parent!) ?? []), record]);
  }
  for (const list of out.values()) list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return out;
}

/** A sub-thread's passage, as its parent's words mark it. */
export function subThreadPassage(record: InboxAnnotationRecord): TextPassage {
  const quote = record.annotation.originalText;
  return { quote: typeof quote === 'string' ? quote : '', offset: inboxQuoteOffset(record) };
}

/** The passages to mark in each message's words, by its id: its sub-threads still open (a draft too); a resolved one is not marked. */
export function openPassagesByParent(subThreads: ReadonlyMap<string, readonly InboxAnnotationRecord[]>, resolved: ReadonlySet<string>): Map<string, TextPassage[]> {
  const out = new Map<string, TextPassage[]>();
  for (const [parent, list] of subThreads) {
    const open = list.filter((record) => !resolved.has(record.id)).map(subThreadPassage);
    if (open.length > 0) out.set(parent, open);
  }
  return out;
}

/**
 * The cards that a folded thread hides, by id: every reply or sub-thread
 * with a folded comment or sub-thread above it (`up` names what each sits
 * under: a reply's comment, a sub-thread's parent). A thread folds when it is
 * resolved with nothing open below it, so an open sub-thread is never hidden.
 */
export function hiddenUnderFolded(ids: Iterable<string>, up: ReadonlyMap<string, string>, folded: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (folded.size === 0) return out;
  for (const id of ids) {
    const seen = new Set<string>();
    for (let above = up.get(id); above !== undefined && !seen.has(above); above = up.get(above)) {
      seen.add(above);
      if (folded.has(above)) {
        out.add(id);
        break;
      }
    }
  }
  return out;
}

/** What each reply or sub-thread sits under, by its id: a reply's comment, a sub-thread's parent. */
export function sitsUnder(records: readonly InboxAnnotationRecord[], agentReplies: readonly InboxCommentReplyRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const record of records) {
    if (isInboxCommentReply(record)) out.set(record.id, record.re!);
    else if (isInboxSubThread(record)) out.set(record.id, record.parent!);
  }
  for (const reply of agentReplies) out.set(reply.id, reply.re);
  return out;
}
