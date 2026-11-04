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
import { INBOX_COMMENT_THREADS_OPEN, inboxOpenCommentThreads, inboxOpenCommentThreadsLabel } from '@plannotator/core/inbox-open-threads-guard';
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from '@plannotator/core/inbox-types';
import { InboxApiError } from './api';

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

/** What the Archive item's press needs of the thread pane. */
export interface OpenThreadsLead {
  body: HTMLElement | null;
  unfold: (messageId: string) => boolean;
  openRecord: (record: InboxAnnotationRecord) => void;
  /** Another machine's thread takes no Resolve here: its name, said with the count (`onError`). */
  elsewhere: string | null;
  onError: (message: string) => void;
}

/**
 * The Archive item's press while comment threads are open (`open`, oldest
 * first): the oldest brought into view. Under its agent's message, its row
 * in the list there (the message unfolded first), rung as a jump to a
 * question is, with focus on its Resolve; a file's comment, or one whose row
 * is not drawn, opens where a press on it does (`openRecord`: the file at
 * its card). On another machine's thread, also where to resolve them.
 */
export function leadToOpenThreads(open: readonly InboxAnnotationRecord[], lead: OpenThreadsLead): void {
  const record = open[0];
  if (!record) return;
  if (lead.elsewhere) lead.onError(`${inboxOpenCommentThreadsLabel(open.length)}: resolve ${open.length === 1 ? 'it' : 'them'} on ${lead.elsewhere} to archive the thread.`);
  if (!record.message) return lead.openRecord(record);
  const show = () => {
    const row = lead.body?.querySelector<HTMLElement>(`[data-sent-comments] [data-sent-comment="${CSS.escape(record.id)}"]`);
    if (!row) return lead.openRecord(record);
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    // After the menu gives focus back to its trigger.
    requestAnimationFrame(() => (row.querySelector<HTMLElement>('[data-sent-resolve]') ?? row.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true }));
    row.classList.remove('ib-q-target-out');
    row.classList.add('ib-q-target');
    setTimeout(() => {
      row.classList.add('ib-q-target-out');
      row.classList.remove('ib-q-target');
      setTimeout(() => row.classList.remove('ib-q-target-out'), 700);
    }, 1400);
  };
  if (lead.unfold(record.message_id)) requestAnimationFrame(() => requestAnimationFrame(show));
  else show();
}

/** A refused Archive that an open comment thread held (the list row's: the window then opens the thread). */
export function heldByOpenThreads(cause: unknown): boolean {
  return cause instanceof InboxApiError && cause.code === INBOX_COMMENT_THREADS_OPEN;
}

/** What Archive all's toast says of the threads it left as they are (its batch's `kept`). */
export function keptByOpenThreads(count: number): string {
  return `Kept ${count} thread${count === 1 ? '' : 's'}: comment threads still open`;
}

/** Archive all's toast with the kept threads added to what it says (its detail, or the project when it has none to say). */
export function withKept(toast: { detail: string; speech: string }, project: string, kept: number): { detail: string; phoneDetail: undefined; speech: string; wrap: true } {
  const note = keptByOpenThreads(kept);
  return { detail: toast.detail === project ? note : `${toast.detail} · ${note}`, phoneDetail: undefined, speech: `${toast.speech} ${note}.`, wrap: true };
}
