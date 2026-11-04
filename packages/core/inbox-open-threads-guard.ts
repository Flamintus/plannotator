/**
 * The comment threads that hold a thread's archive in the Plannotator Inbox
 * (a personal branch, `own/open-threads-guard`, never sent upstream:
 * AGENTS.md rules out gates there).
 *
 * crit's rule: a review is approved only once every thread and sub-thread
 * in it is resolved. In the Inbox, a review ends when its thread is archived
 * (the person's Archive, or an agent's resolve_message), so while sent
 * comments stay in view (experimental "persistent-comments") a comment or
 * sub-thread still open holds the archive. Open means what the person sees:
 * a reply newer than a resolution opens a comment again, the person's draft
 * reply too, as the window draws it (packages/inbox/components/SentComments.tsx).
 * A comment on a guided review's diff never holds: the window draws none of
 * those, so none can be resolved. A reply is part of its comment's thread,
 * never a thread of its own.
 *
 * Browser-safe and zero-dep.
 */

import type { InboxAnnotationRecord, InboxCommentReplyRecord } from "./inbox-attachments";
import { inboxCommentLastReplies, inboxCommentState, isInboxCommentReply, isInboxCommentSent } from "./inbox-comment-threads";

/** The refusal's code, for an agent's resolve_message and the person's Archive alike. */
export const INBOX_COMMENT_THREADS_OPEN = "comment_threads_open";

/**
 * The thread's comments and sub-threads still open, in the order of `sent`:
 * `sent`, the comments a Send carried; `drafts`, those waiting for one (a
 * draft reply under a resolved comment opens it again); `agentReplies`, the
 * agents' replies under them.
 */
export function inboxOpenCommentThreads(
  sent: readonly InboxAnnotationRecord[],
  drafts: readonly InboxAnnotationRecord[],
  agentReplies: readonly InboxCommentReplyRecord[] = [],
): InboxAnnotationRecord[] {
  const last = inboxCommentLastReplies([...sent, ...drafts], agentReplies);
  return sent.filter(
    (record) => isInboxCommentSent(record) && !isInboxCommentReply(record) && !record.guide && inboxCommentState(record, last.get(record.id) ?? null) === "open",
  );
}

/** How many hold it, as the window's Archive item and the person's refusal say it. */
export function inboxOpenCommentThreadsLabel(count: number): string {
  return `${count} comment thread${count === 1 ? "" : "s"} still open`;
}
