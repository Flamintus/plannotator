/**
 * The line a flat list of comments adds under one comment once comments go
 * to the agent in rounds (#1116, experimental "persistent-comments"): the
 * list stays as it is, one comment per item, with no tree, and each item
 * gains what the rounds give it. Its round ("Round 2", or "Not sent" for a
 * draft), what became of its send (Queued, Delivered, Read, Working,
 * Replied), its resolution ("✓ Resolved", in the success colour the boxes
 * use), a quiet "↳ 2 replies under the passage" (the replies themselves are
 * read in the thread's box, in the text), and its controls: Send for a draft
 * (it goes alone, at once) and Resolve or Reopen for a sent thread.
 *
 * One element for every list: the screens' annotations panel and the Inbox
 * window's comments list, each entry read from the boxes' tree by one
 * mapping (`SentListLine`). Host-neutral (props only); drawn with Tailwind's
 * theme tokens, which both apps compile from ui's components.
 */
import { useState, type ReactNode } from 'react';
import type { InboxCommentSendStatus } from '@plannotator/core/inbox-comment-sends';
import { SENT_STATUS_WORDS } from './SentThreads';
import type { SentCommentsTree, SentThreadRecord } from './sentCommentsTree';

/** "↳ 1 reply under the passage", "↳ 3 replies under the passage". */
export function repliesUnderPassage(count: number): string {
  return `↳ ${count} ${count === 1 ? 'reply' : 'replies'} under the passage`;
}

export interface CommentListMetaProps {
  /** Not sent yet: "Not sent", and Send when `onSend`. */
  draft?: boolean;
  /** The round it went in (a sent one). */
  round?: number;
  status?: InboxCommentSendStatus;
  /** A sent thread's state; absent for an element with no state of its own (a reply). */
  resolved?: boolean;
  /** The replies under it in its box, the agent's and the person's. */
  replies?: number;
  /** Sends this draft alone, at once (the round stays open); true once it went. */
  onSend?: () => Promise<boolean>;
  /** Resolves the thread (true) or opens it again (false). */
  onResolve?: (resolved: boolean) => void;
  /** The host's own controls, after these (a Retry). */
  children?: ReactNode;
}

const CHIP = 'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none';
const ACTION = 'shrink-0 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-50';

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

/** A draft's Send: disabled while it goes, pressable again when it did not go. */
function SendButton({ onSend, className }: { onSend: () => Promise<boolean>; className: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      data-comment-meta-send=""
      disabled={busy}
      onClick={async (event) => {
        event.stopPropagation();
        setBusy(true);
        let went = false;
        try {
          went = await onSend();
        } finally {
          if (!went) setBusy(false);
        }
      }}
    >
      Send
    </button>
  );
}

/** One entry of a flat list as the boxes' tree knows it: a comment or a sub-thread, or a reply (`reply`), and what carried it (null: a draft). */
export interface SentListEntry {
  id: string;
  sent_reply_id: string | null;
  reply?: boolean;
}

/**
 * The line of one entry of a flat list, read from the boxes' tree (`SentCommentsTree`): the one reading of a
 * comment's round, status, resolution and replies for every list (the Inbox's comments list and its file panel, the
 * screens' column), so a list says what the comment's box says. A draft: "Not sent", and Send with `onSend`. A
 * thread (a comment or a sub-thread): its round, its send's status (`withoutStatus`: the host says it did not
 * arrive), "✓ Resolved" with Resolve or Reopen (`onResolve`) and the replies under its passage. A reply: its round
 * and status. `children`: the host's own controls (a Retry).
 */
export function SentListLine({
  entry,
  tree,
  onSend,
  onResolve,
  withoutStatus = false,
  children,
}: {
  entry: SentListEntry;
  tree: Pick<SentCommentsTree<SentThreadRecord>, 'rounds' | 'resolved' | 'replies' | 'statuses'>;
  onSend?: () => Promise<boolean>;
  onResolve?: (resolved: boolean) => void;
  withoutStatus?: boolean;
  children?: ReactNode;
}) {
  if (entry.sent_reply_id === null) {
    return (
      <CommentListMeta draft {...(onSend ? { onSend } : {})}>
        {children}
      </CommentListMeta>
    );
  }
  const thread = entry.reply !== true;
  return (
    <CommentListMeta
      round={tree.rounds.get(entry.sent_reply_id)}
      status={withoutStatus ? undefined : tree.statuses?.get(entry.id)}
      resolved={thread ? tree.resolved.has(entry.id) : undefined}
      replies={thread ? (tree.replies.get(entry.id)?.length ?? 0) : 0}
      {...(thread && onResolve ? { onResolve } : {})}
    >
      {children}
    </CommentListMeta>
  );
}

/** The rounds' line under one comment of a flat list; nothing when there is nothing to say. */
export function CommentListMeta({ draft = false, round, status, resolved, replies = 0, onSend, onResolve, children }: CommentListMetaProps) {
  const chips = draft || round !== undefined || status !== undefined || resolved === true || replies > 0;
  const actions = (draft && onSend) || (!draft && resolved !== undefined && onResolve) || children;
  if (!chips && !actions) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground" data-comment-meta="">
      {draft ? (
        <span className={`${CHIP} bg-muted text-muted-foreground`} data-comment-meta-round="">
          Not sent
        </span>
      ) : (
        round !== undefined && (
          <span className={`${CHIP} bg-muted text-muted-foreground`} data-comment-meta-round={round}>
            Round {round}
          </span>
        )
      )}
      {!draft && status && (
        <span className={`${CHIP} bg-muted text-muted-foreground`} data-comment-meta-status={status}>
          {SENT_STATUS_WORDS[status]}
        </span>
      )}
      {!draft && resolved === true && (
        <span className={`${CHIP} inline-flex items-center gap-0.5 bg-success/15 font-semibold text-success`} data-comment-meta-resolved="">
          <CheckMark />
          Resolved
        </span>
      )}
      {replies > 0 && (
        <span className="min-w-0 truncate" data-comment-meta-replies={replies}>
          {repliesUnderPassage(replies)}
        </span>
      )}
      {actions && (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {draft && onSend && <SendButton onSend={onSend} className={`${ACTION} font-semibold text-primary`} />}
          {!draft && resolved !== undefined && onResolve && (
            <button
              type="button"
              className={`${ACTION} text-muted-foreground hover:text-foreground`}
              data-comment-meta-resolve={resolved ? 'reopen' : 'resolve'}
              onClick={(event) => {
                event.stopPropagation();
                onResolve(!resolved);
              }}
            >
              {resolved ? 'Reopen' : 'Resolve'}
            </button>
          )}
          {children}
        </span>
      )}
    </div>
  );
}
