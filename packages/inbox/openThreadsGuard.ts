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

/** How long a file's thread box is waited for: the file opens, then its words are read and its threads drawn. */
const FILE_BOX_WAIT_MS = 3000;

/** A thread's box where the window draws it (SentComments.tsx `SentThreads`): in an agent's message, or in a Markdown or text file's document. */
const boxOf = (root: ParentNode | null | undefined, id: string) => root?.querySelector<HTMLElement>(`[data-sent-comments] [data-sent-comment="${CSS.escape(id)}"]`) ?? null;

/** A thread's box brought into view and rung, as a jump to a question is, with focus on its Resolve (its head's, before any sub-thread's). */
function ringBox(box: HTMLElement): void {
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' });
  // After the menu gives focus back to its trigger.
  requestAnimationFrame(() => (box.querySelector<HTMLElement>('[data-sent-resolve]') ?? box.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true }));
  box.classList.remove('ib-q-target-out');
  box.classList.add('ib-q-target');
  setTimeout(() => {
    box.classList.add('ib-q-target-out');
    box.classList.remove('ib-q-target');
    setTimeout(() => box.classList.remove('ib-q-target-out'), 700);
  }, 1400);
}

/**
 * The Archive item's press while comment threads are open (`open`, oldest
 * first): the oldest brought into view, its box rung with focus on its
 * Resolve. Under its agent's message, the box under the block its passage
 * is in (the message unfolded first); one whose box is not drawn opens where
 * a press on it does (`openRecord`). A file's comment opens the file at its
 * card (`openRecord`), then, in a Markdown or text file, its box under the
 * block its words are in, once drawn; a code, HTML, image or video file has
 * no box, the card is where it is. On another machine's thread, also where
 * to resolve them.
 */
export function leadToOpenThreads(open: readonly InboxAnnotationRecord[], lead: OpenThreadsLead): void {
  const record = open[0];
  if (!record) return;
  if (lead.elsewhere) lead.onError(`${inboxOpenCommentThreadsLabel(open.length)}: resolve ${open.length === 1 ? 'it' : 'them'} on ${lead.elsewhere} to archive the thread.`);
  if (!record.message) {
    lead.openRecord(record);
    const until = Date.now() + FILE_BOX_WAIT_MS;
    const look = () => {
      // The file's pane sits beside the thread's body, outside it.
      const box = boxOf(document, record.id);
      if (box) ringBox(box);
      else if (Date.now() < until) setTimeout(look, 50);
    };
    return look();
  }
  const show = () => {
    const box = boxOf(lead.body, record.id);
    if (box) ringBox(box);
    else lead.openRecord(record);
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
