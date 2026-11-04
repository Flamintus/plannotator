/**
 * The Inbox's doors that archive a thread, held while one of its comment
 * threads is open (a personal branch, `own/open-threads-guard`, never sent
 * upstream; the rule is packages/core/inbox-open-threads-guard.ts): an
 * agent's resolve_message, the person's Archive (the window, a phone, a
 * linked machine's forward) and the project menu's Archive all, which leaves
 * such a thread where it is. The callers apply it only while sent comments
 * stay in view (experimental "persistent-comments"). Reopening a thread is
 * never held.
 */

import { INBOX_COMMENT_THREADS_OPEN, inboxOpenCommentThreads, inboxOpenCommentThreadsLabel } from "@plannotator/core/inbox-open-threads-guard";
import type { InboxAnnotationRecord } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import type { InboxStore } from "./store";

/**
 * The comment threads that hold the archive of the thread `messageId` is in,
 * oldest first; none once it is archived (archiving it again changes
 * nothing) or for an unknown message (the archive answers that).
 */
export function commentThreadsHoldingArchive(store: InboxStore, messageId: string): InboxAnnotationRecord[] {
  const message = store.message(messageId);
  const root = message ? store.message(message.thread_id) : null;
  if (!root || root.resolved_at !== null) return [];
  return inboxOpenCommentThreads(store.sentAnnotations(root.id), store.pendingAnnotations(root.id), store.commentReplies(root.id));
}

/**
 * Refuses the archive while a comment thread is open, with
 * `comment_threads_open` and the open ones' ids (`comment_ids`). The agent's
 * words name them and who resolves them; the person's say how many, as the
 * window's Archive item does.
 */
export function refuseArchiveWhileCommentThreadsOpen(store: InboxStore, messageId: string, by: "person" | "agent"): void {
  const ids = commentThreadsHoldingArchive(store, messageId).map((record) => record.id);
  if (ids.length === 0) return;
  const one = ids.length === 1;
  const words =
    by === "agent"
      ? `${ids.length} comment thread${one ? " is" : "s are"} still open in this thread: ${ids.join(", ")}. Only the person resolves a comment thread; leave this thread open, the person archives it once none is open.`
      : `${inboxOpenCommentThreadsLabel(ids.length)}: resolve ${one ? "it" : "them"} to archive the thread.`;
  throw new InboxError(INBOX_COMMENT_THREADS_OPEN, words, { comment_ids: ids });
}
