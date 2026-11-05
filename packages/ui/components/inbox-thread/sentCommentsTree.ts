/**
 * What the comment thread boxes (`SentThreads`) draw, and where: the pure
 * side of the boxes, moved here unchanged from packages/inbox/sentComments.ts
 * and packages/inbox/components/SentComments.tsx. A host builds the boxes'
 * `SentCommentsTree` from core: the replies, sub-threads and passages from
 * the thread view (`sentCommentsParts` over `inboxCommentThreadView`), the
 * rounds from `inboxCommentRounds`, the resolved ids from `inboxCommentState`
 * (with `inboxCommentLastReplies`) and the messages with an open sub-thread under them from
 * `inboxOpenSubThreadPaths`; `placeThreads` names the block each thread goes
 * under (`Viewer`'s `belowBlock`).
 */

import type { InboxCommentThreadNode, InboxCommentThreadView } from '@plannotator/core/inbox-comment-sends';
import type { TextPassage } from '@plannotator/core/passage';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';

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
export interface SentCommentsTree {
  rounds: ReadonlyMap<string, number>;
  resolved: ReadonlySet<string>;
  /** The replies under each comment or sub-thread. */
  replies: ReadonlyMap<string, readonly SentReplyRow[]>;
  /** The sub-threads on each message (drafts too). */
  subThreads: ReadonlyMap<string, readonly InboxAnnotationRecord[]>;
  /** The messages with an open sub-thread under them. */
  openBelow: ReadonlySet<string>;
  /** The passages to mark in each message's words. */
  passages: ReadonlyMap<string, readonly TextPassage[]>;
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
