/**
 * The window's side of the open comment threads that hold a thread's archive
 * (a personal branch, `own/open-threads-guard`, never sent upstream; the rule
 * is packages/core/inbox-open-threads-guard.ts, the server's doors
 * packages/shared/inbox/open-threads-guard.ts). While one is open, the
 * thread header's ⋯ Archive item says how many and leads to the oldest
 * instead of archiving: there is nothing to force. With the switch off the
 * thread's files carry no sent comments, so nothing holds.
 */
import { useMemo } from 'react';
import { inboxOpenCommentThreads } from '@plannotator/core/inbox-open-threads-guard';
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from '@plannotator/core/inbox-types';

const NO_REPLIES: readonly InboxCommentReplyRecord[] = [];

/** The thread's comment threads still open, oldest first, as the window draws them (`sent` with the window's own writes, `drafts`). */
export function useOpenCommentThreads(
  sent: readonly InboxAnnotationRecord[],
  drafts: readonly InboxAnnotationRecord[],
  agentReplies: readonly InboxCommentReplyRecord[] | undefined,
): InboxAnnotationRecord[] {
  const replies = agentReplies ?? NO_REPLIES;
  return useMemo(() => inboxOpenCommentThreads(sent, drafts, replies), [sent, drafts, replies]);
}

/**
 * Brings an open comment thread into view: under its agent's message, its
 * row in the list there (the message unfolded first), rung as a jump to a
 * question is; a file's comment, or one whose row is not drawn, opens where
 * a press on it does (`openRecord`: the file at its card).
 */
export function revealCommentThread(
  record: InboxAnnotationRecord,
  body: HTMLElement | null,
  unfold: (messageId: string) => boolean,
  openRecord: (record: InboxAnnotationRecord) => void,
): void {
  if (!record.message) return openRecord(record);
  const show = () => {
    const row = body?.querySelector<HTMLElement>(`[data-sent-comments] [data-sent-comment="${CSS.escape(record.id)}"]`);
    if (!row) return openRecord(record);
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    row.classList.remove('ib-q-target-out');
    row.classList.add('ib-q-target');
    setTimeout(() => {
      row.classList.add('ib-q-target-out');
      row.classList.remove('ib-q-target');
      setTimeout(() => row.classList.remove('ib-q-target-out'), 700);
    }, 1400);
  };
  if (unfold(record.message_id)) requestAnimationFrame(() => requestAnimationFrame(show));
  else show();
}

/** What Archive all's toast says of the threads it left (`held`). */
export function keptByOpenThreads(count: number): string {
  return `Kept ${count} thread${count === 1 ? '' : 's'}: comment threads still open`;
}
