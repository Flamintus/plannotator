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

import { inboxCommentReplyAnnotation, inboxMovedLines, isInboxCommentReply } from '@plannotator/core/inbox-comment-threads';
import { inboxAgentName, type InboxAnnotationRecord, type InboxCommentReplyRecord } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';
import { codeRangeMatches, codeRangeOf } from './attachments';

/**
 * Moved to @plannotator/ui (packages/ui/components/inbox-thread/sentCommentsTree.ts) unchanged,
 * with the thread boxes that draw them: the parts read from the thread view, and where each
 * thread is drawn. This path re-exports them so every existing import and test keeps working.
 */
export { placeThreads, sentCommentsParts, type SentCommentsParts, type SentReplyRow } from '@plannotator/ui/components/inbox-thread/sentCommentsTree';

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
