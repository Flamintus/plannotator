/**
 * The Plannotator Inbox's comment threads as boxes in a document's flow, as
 * crit's (its comments that stay after Send, experimental
 * "persistent-comments"), moved here unchanged from
 * packages/inbox/components/SentComments.tsx so a host of the shared thread
 * parts draws the same boxes. The host draws a group of threads under the
 * block their passage starts in (`placeThreads`, `Viewer`'s `belowBlock`) and
 * passes what it shows: the threads as core's records, their replies,
 * sub-threads and passages (`SentCommentsTree`, sentCommentsTree.ts), and the person's actions,
 * each absent when the person cannot take it. The look is the Inbox's
 * `ib-sentb-*` and `ib-sentc-*` rules, which stay in packages/inbox/inbox.css
 * and ship in @plannotator/ui/inbox-thread.css.
 *
 * At a box's head the passage and its round, Reply and Resolve; then its
 * messages: the comment, and the replies under it, each with who wrote it
 * and its round (a draft says Not sent). A sub-thread is a box in the box,
 * in the message whose passage it is on, under the block (paragraph) of its
 * words where the passage starts, as a thread sits under its block in the
 * document; its passage marked in those words. A resolved thread folds to
 * one "Resolved" line (a press opens it to be read) only once nothing under
 * it, at any depth, is open.
 *
 * A sub-thread is a comment like one on the document's words: words selected
 * in a message offer the document's selection toolbar (`passageToolbar`, the
 * host's `Viewer` options: Delete, Comment, the quick labels, 👍 Looks good),
 * and each action makes the same kind of comment (`PassageComment`); a
 * deletion says so at its head ("Deletion", its passage struck through, as
 * the document strikes a deletion's words), on the document's threads too.
 *
 * With comment sends (the host passes `onSend` and the tree's `statuses`,
 * `live` and `fresh`): a draft, the comment, a reply under one or a
 * sub-thread, has Send, which sends it alone at once without ending the
 * round; what a send carried says what became of it (Queued, Delivered,
 * Read, Working, Replied); a thread a send reached at once is Live (the
 * person's next replies in it go on their own); and an agent's reply the
 * person has not seen yet is New.
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { isInboxCommentThreadFolded, isInboxSubThread } from '@plannotator/core/inbox-comment-threads';
import type { TextPassage } from '@plannotator/core/passage';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import type { InboxCommentSendStatus } from '@plannotator/core/inbox-comment-sends';
import { useConfigValue } from '../../config';
import { AnnotationType, type Annotation } from '../../types';
import { PassageToolbar, type PassageToolbarOptions } from '../PassageToolbar';
import { PASSAGE_BODY_ATTRIBUTE, PASSAGE_PIECE_ATTRIBUTE, passageRanges, selectedPassage, splitByRanges, type PassageComment, type PassageMark, type SelectedPassage } from '../../utils/passageSelection';
import { isCommentSubmitKey } from '../../utils/commentSubmitKey';
import { Icon } from './icons';
import { shortLabel } from './shortLabel';
import { placeOnMessage, subThreadPassage, type SentCommentsTree, type SentReplyRow, type SentThreadRecord } from './sentCommentsTree';

const NO_RECORDS: readonly SentThreadRecord[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** The person's reply under a comment, or comment on a passage, as the composer hands it. */
export type ReplyInput = { text: string; mentions?: readonly string[] };

/** The person's sub-thread on a passage of a message, as the selection toolbar made it (a comment, a deletion, a quick label), true once saved. */
export type SubThreadSave = (parentId: string, passage: TextPassage, comment: PassageComment) => Promise<boolean>;

/**
 * A message's words, with its sub-threads' passages marked; `bodyOf`: words a passage can be selected in.
 * `from` and `to`: the piece of them drawn here, when the message is drawn in pieces (`piece`), its sub-threads' boxes
 * between its blocks (`placeOnMessage`).
 */
function Said({
  text,
  from = 0,
  to = text.length,
  piece = false,
  bodyOf,
  passages,
  className = 'ib-sentc-said',
}: {
  text: string;
  from?: number;
  to?: number;
  piece?: boolean;
  bodyOf?: string;
  passages?: readonly PassageMark[];
  className?: string;
}) {
  const ranges = useMemo(() => (passages && passages.length > 0 ? passageRanges(text, passages) : []), [text, passages]);
  const words = from === 0 && to === text.length ? text : text.slice(from, to);
  return (
    <p className={className} data-sent-body="" {...(bodyOf !== undefined ? { [PASSAGE_BODY_ATTRIBUTE]: bodyOf } : {})} {...(piece ? { [PASSAGE_PIECE_ATTRIBUTE]: '' } : {})}>
      {ranges.length === 0
        ? words
        : splitByRanges(words, from, ranges).map((part, index) =>
            part.marked ? (
              <mark key={index} className="ib-sentc-mark" data-passage-mark="" data-passage-deletion={part.deletion ? '' : undefined}>
                {part.text}
              </mark>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
    </p>
  );
}

/** The box open on a surface: a reply under a comment or sub-thread, or a comment on a passage of a message (`passage`). */
type ListBox = { at: string; text: string; opened: number; passage?: TextPassage };

/**
 * What the person has open among one surface's threads (a thread's messages,
 * or a file's document): the one box (another opens in its place and keeps
 * the words), the passage offered for a comment (`offer`, with the group of
 * threads its words are in), and the folded threads opened to be read
 * (`shown`; a thread that folds again later starts folded). `surface` names
 * the groups this view draws (`data-sent-threads`), so a selection in another
 * surface's threads, or anywhere else, offers nothing here.
 */
export interface SentThreadsView {
  surface: string;
  box: ListBox | null;
  setBox: Dispatch<SetStateAction<ListBox | null>>;
  offer: { passage: SelectedPassage; group: string } | null;
  closeOffer: () => void;
  shown: ReadonlySet<string>;
  toggleShown: (id: string) => void;
}

const THREADS_ATTRIBUTE = 'data-sent-threads';

/**
 * One surface's view of its threads (see `SentThreadsView`). While `offering`
 * (a thread there takes comments on its passages), a selection let go that
 * holds one sent message's words offers to comment on that passage; it
 * listens on the document, since a drag past the last line ends outside the
 * threads. `folded`: the threads folded now, so one opened to be read and
 * then opened again (a Reopen, a reply) leaves `shown`.
 */
export function useSentThreadsView(offering: boolean, folded: ReadonlySet<string>): SentThreadsView {
  const surface = useId();
  const [box, setBox] = useState<ListBox | null>(null);
  const [offer, setOffer] = useState<SentThreadsView['offer']>(null);
  const [shownIds, setShown] = useState<ReadonlySet<string>>(NO_IDS);
  const closeOffer = useCallback(() => setOffer(null), []);
  useEffect(() => {
    if (!offering) return;
    const offerPassage = () => {
      const selection = document.getSelection();
      const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null;
      const groupOf = (node: Node | null) => (node instanceof Element ? node : (node?.parentElement ?? null))?.closest<HTMLElement>(`[${THREADS_ATTRIBUTE}]`) ?? null;
      const group = range ? (groupOf(range.startContainer) ?? groupOf(range.endContainer)) : null;
      const key = group?.getAttribute(THREADS_ATTRIBUTE) ?? '';
      const passage = group && key.startsWith(`${surface}:`) ? selectedPassage(group, selection) : null;
      setOffer(passage ? { passage, group: key } : null);
    };
    document.addEventListener('mouseup', offerPassage);
    return () => document.removeEventListener('mouseup', offerPassage);
  }, [offering, surface]);
  // Opened to be read while folded: a thread that unfolds on its own (opened again) leaves it.
  const shown = useMemo(() => {
    const kept = [...shownIds].filter((id) => folded.has(id));
    return kept.length === shownIds.size ? shownIds : new Set(kept);
  }, [shownIds, folded]);
  const toggleShown = useCallback((id: string) => {
    setShown((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  return useMemo(() => ({ surface, box, setBox, offer, closeOffer, shown, toggleShown }), [surface, box, offer, closeOffer, shown, toggleShown]);
}

/**
 * What a group of threads does: bring a thread's passage into view (absent: its quote is words), and the person's
 * Resolve, Reply, comment on a passage and Send of one draft (each absent: none).
 */
interface SentThreadsActions<R extends SentThreadRecord = InboxAnnotationRecord> {
  onOpen?: (record: R) => void;
  onResolve?: (record: R, resolved: boolean) => void;
  onReply?: (commentId: string, reply: ReplyInput) => Promise<boolean>;
  onSubThread?: SubThreadSave;
  /** Send one draft (a comment, a reply under one, a sub-thread, by id) alone, at once, the round left open; true once it went. */
  onSend?: (id: string) => Promise<boolean>;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** What became of an element a comment send carried, as its chip says it. */
export const SENT_STATUS_WORDS: Record<InboxCommentSendStatus, string> = {
  pending: 'Queued',
  delivered: 'Delivered',
  read: 'Read',
  working: 'Working',
  replied: 'Replied',
};

/** An element's status chip (none without a status): the boxes' own, and a host's card (the file's panel). */
export function SentStatusChip({ status }: { status: InboxCommentSendStatus | undefined }) {
  if (!status) return null;
  return (
    <span className="ib-sentc-chip" data-sent-status={status}>
      {SENT_STATUS_WORDS[status]}
    </span>
  );
}

/** A draft's Send: it goes alone, at once; disabled while it goes, and again only when it did not. The boxes' own, and a host's card. */
export function SentSendButton({ id, onSend }: { id: string; onSend: (id: string) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="ib-sentc-act ib-sentb-send"
      data-sent-send={id}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        let went = false;
        try {
          went = await onSend(id);
        } finally {
          // Not sent (refused, or the host threw): it can be pressed again.
          if (!went) setBusy(false);
        }
      }}
    >
      Send
    </button>
  );
}

/**
 * The threads on one block of a document (or, `lost`, the ones whose
 * passage was not found, at its end), each a box of its own, as crit's:
 * at its head the passage and the round, Reply and Resolve; then its
 * messages, the comment and each reply under it (who, round, words); a
 * sub-thread is a box in the box, in the message whose passage it is on,
 * under the block of its words the passage starts in (`placeOnMessage`),
 * at the same indent at each level, at any depth. A resolved thread folds to
 * one line ("Resolved", a press opens it to be read) only when nothing under
 * it, at any depth, is open; until then it stays unfolded, marked Resolved,
 * its open sub-threads in view. Reply opens a box at the thread's foot;
 * words selected in a sent message offer ui's selection toolbar, whose
 * Comment opens a box under the passage's block with the passage at its head. A
 * draft goes with the next Send, or alone by its own Send (`onSend`).
 *
 * The records are any client's (`SentThreadRecord`): the Inbox's own, or the
 * ones a host builds from the neutral thread view (`sentThreadsFromView`).
 * A resolved thread says so plainly: its passage's bar and its frame take
 * the success colour, a "✓ Resolved" chip at its head, its words dimmed.
 */
export function SentThreads<R extends SentThreadRecord = InboxAnnotationRecord>({
  group,
  records,
  tree,
  view,
  lost = false,
  passageToolbar,
  ...actions
}: {
  /** This group's key, inside its view's surface. */
  group: string;
  records: readonly R[];
  tree: SentCommentsTree<R>;
  view: SentThreadsView;
  lost?: boolean;
  /**
   * The options of the document's own selection toolbar here (the host's `Viewer`'s): a passage of a message offers
   * the same actions, Delete and the labels making their sub-thread at once. Absent: Comment only, as before.
   */
  passageToolbar?: PassageToolbarOptions;
} & SentThreadsActions<R>) {
  if (records.length === 0) return null;
  const key = `${view.surface}:${group}`;
  const { onSubThread } = actions;
  return (
    <div className="ib-sentb" data-sent-threads={key} data-sent-comments="" data-sent-lost={lost ? '' : undefined} role="group" aria-label={lost ? 'Comments whose passage was not found' : 'Comments on this passage'}>
      {lost && <p className="ib-sentb-lost">Passage not found</p>}
      {records.map((record) => (
        <SentThreadBox key={record.id} record={record} root={record} tree={tree} view={view} actions={actions} />
      ))}
      {view.offer?.group === key && onSubThread && (
        <PassageToolbar
          passage={view.offer.passage}
          options={passageToolbar}
          onComment={(initialChar) => {
            const passage = view.offer!.passage;
            view.closeOffer();
            document.getSelection()?.removeAllRanges();
            view.setBox((open) => ({ at: passage.parentId, text: `${open?.text ?? ''}${initialChar ?? ''}`, opened: (open?.opened ?? 0) + 1, passage: { quote: passage.quote, offset: passage.offset } }));
          }}
          // Delete or a label: the comment is made at once, as on the document's words (a refusal is the host's to say).
          onPreset={
            passageToolbar
              ? (comment) => {
                  const passage = view.offer!.passage;
                  view.closeOffer();
                  document.getSelection()?.removeAllRanges();
                  void onSubThread(passage.parentId, { quote: passage.quote, offset: passage.offset }, comment);
                }
              : undefined
          }
          onClose={view.closeOffer}
        />
      )}
    </div>
  );
}

/** One thread (a comment, or a sub-thread; `root`: its thread's first comment), as a box. */
function SentThreadBox<R extends SentThreadRecord>({ record, root, tree, view, actions }: { record: R; root: R; tree: SentCommentsTree<R>; view: SentThreadsView; actions: SentThreadsActions<R> }) {
  const { rounds, resolved, replies, subThreads, openBelow, passages, statuses, live, fresh } = tree;
  const { onOpen, onResolve, onReply, onSubThread, onSend } = actions;
  const { box, setBox } = view;
  const id = record.id;
  const annotation = record.annotation as unknown as Annotation;
  const quote = annotation.originalText ?? '';
  /** A comment on the whole document: no passage (never one on part of an image or an element, which has no words either). */
  const general = quote === '' && !isInboxSubThread(record) && (annotation.type === undefined || annotation.type === AnnotationType.GLOBAL_COMMENT);
  /** The person asks for the words to go: a deletion, on the document or on a passage of a message. */
  const deletion = annotation.type === AnnotationType.DELETION;
  const words = annotation.text ?? '';
  const draft = record.sent_reply_id === null;
  const round = record.sent_reply_id ? rounds.get(record.sent_reply_id) : undefined;
  const isSub = isInboxSubThread(record);
  const isResolved = resolved.has(id);
  const foldable = isInboxCommentThreadFolded(id, resolved, openBelow);
  const folded = foldable && !view.shown.has(id);
  const under = replies.get(id) ?? [];
  const roundChip = draft ? <span className="ib-sentc-chip">Not sent</span> : round !== undefined ? <span className="ib-sentc-chip" data-sent-round={round}>Round {round}</span> : null;
  const marks = {
    'data-sent-comment': id,
    'data-sent-subthread': isSub ? '' : undefined,
    'data-sent-deletion': deletion ? '' : undefined,
    'data-sent-resolved': isResolved ? '' : undefined,
    'data-sent-folded': folded ? '' : undefined,
  };
  if (folded) {
    const subs = countSubThreads(id, replies, subThreads);
    return (
      <div className="ib-sentb-card" {...marks}>
        <button type="button" className="ib-sentb-fold" aria-expanded={false} data-sent-unfold={id} onClick={() => view.toggleShown(id)}>
          <Icon name="chevR" size={12} />
          <span className="ib-sentb-state" data-sent-resolved-chip="">
            <Icon name="check" size={12} />
            Resolved
          </span>
          <span className="ib-sentb-fquote">{general ? 'General comment' : `“${shortLabel(quote)}”`}</span>
          {roundChip}
          <span className="ib-sentb-count" data-sent-messages={1 + under.length} data-sent-subthreads={subs}>
            {plural(1 + under.length, 'message')}
            {subs > 0 ? `, ${plural(subs, 'sub-thread')}` : ''}
          </span>
        </button>
      </div>
    );
  }
  const boxFor = (at: string, passage: boolean) =>
    box && box.at === at && !!box.passage === passage && (passage ? onSubThread : onReply) ? (
      <SentReplyBox
        key={box.opened}
        value={box.text}
        quote={box.passage?.quote}
        onChange={(text) => setBox((open) => (open ? { ...open, text } : open))}
        onSave={async (text) => {
          const current = box;
          const done = current.passage ? await onSubThread!(current.at, current.passage, { text }) : await onReply!(current.at, { text });
          if (done) setBox((open) => (open?.opened === current.opened ? null : open));
        }}
        onCancel={() => setBox(null)}
      />
    ) : null;
  /**
   * A message's words (`selectable`: a passage of them can be commented on), with the sub-threads on them, each a box
   * in this box under the block of the words its passage starts in, as a thread sits under its block in the document,
   * several on one block in their passages' order; the box commenting on a passage of them, under that passage's block,
   * after the sub-threads there. A message whose sub-threads all sit under its last block is drawn whole, then them.
   */
  const saidWithSubThreads = (messageId: string, text: string, selectable: boolean) => {
    const list: readonly R[] = subThreads.get(messageId) ?? [];
    const composer = boxFor(messageId, true);
    const items: readonly (R | null)[] = composer ? [...list, null] : list;
    const pieces = placeOnMessage(text, items, (item) => (item ? subThreadPassage(item) : box?.passage));
    return pieces.map((piece, index) => {
      const subs = piece.under.filter((item): item is R => item !== null);
      const composerHere = piece.under.includes(null) ? composer : null;
      // The last piece keeps its key, so what sits at the message's end stays as it is when a block above gets a box.
      return (
        <Fragment key={index === pieces.length - 1 ? 'end' : piece.to}>
          <Said text={text} from={piece.from} to={piece.to} piece={pieces.length > 1} bodyOf={selectable ? messageId : undefined} passages={passages.get(messageId)} />
          {(subs.length > 0 || composerHere) && (
            <div className="ib-sentb-subs" data-sent-subthreads={messageId}>
              {subs.map((sub) => (
                <SentThreadBox key={sub.id} record={sub} root={root} tree={tree} view={view} actions={actions} />
              ))}
              {composerHere}
            </div>
          )}
        </Fragment>
      );
    });
  };
  const replyBox = boxFor(id, false);
  // A sub-thread's passage is in the message just above it; a thread's first comment's is in the document, a press brings it into view.
  // A comment on the whole document has no passage: its head says so.
  const quoteText = general ? <span className="ib-sentb-qt ib-sentb-general">General comment</span> : <span className="ib-sentb-qt">“{quote}”</span>;
  return (
    <div className="ib-sentb-card" {...marks} data-sent-draft={draft ? '' : undefined}>
      <div className="ib-sentb-head">
        {foldable && (
          <button type="button" className="ib-sentb-chev" aria-expanded={true} aria-label="Fold the resolved comment" data-sent-unfold={id} onClick={() => view.toggleShown(id)}>
            <Icon name="chevD" size={12} />
          </button>
        )}
        {!isSub && onOpen ? (
          <button type="button" className="ib-sentb-quote" onClick={() => onOpen(root)} title="Show the passage">
            {quoteText}
          </button>
        ) : (
          <span className="ib-sentb-quote">{quoteText}</span>
        )}
        <span className="ib-sentb-chips">
          {deletion && (
            <span className="ib-sentc-chip ib-sentb-deletion" data-sent-deletion-chip="">
              Deletion
            </span>
          )}
          {roundChip}
          <SentStatusChip status={statuses?.get(id)} />
          {live?.has(id) && !isResolved && (
            <span className="ib-sentc-chip ib-sentb-live" data-sent-live="" title="Your replies here go to the agent as you save them">
              Live
            </span>
          )}
          {isResolved && (
            <span className="ib-sentc-chip ib-sentb-resolved" data-sent-resolved-chip="">
              <Icon name="check" size={11} />
              Resolved
            </span>
          )}
          {typeof record.unanchored_at === 'string' && (
            <span className="ib-sentc-chip" data-sent-unanchored="">
              Unanchored
            </span>
          )}
        </span>
        {draft && onSend && (
          <span className="ib-sentb-acts">
            <SentSendButton id={id} onSend={onSend} />
          </span>
        )}
        {!draft && (onReply || onResolve) && (
          <span className="ib-sentb-acts">
            {onReply && (
              <button
                type="button"
                className="ib-sentc-act"
                data-sent-reply-to={id}
                aria-expanded={box?.at === id && !box.passage}
                onClick={() => setBox((open) => (open?.at === id && !open.passage ? null : { at: id, text: open?.text ?? '', opened: (open?.opened ?? 0) + 1 }))}
              >
                Reply
              </button>
            )}
            {onResolve && (
              <button type="button" className="ib-sentc-act" data-sent-resolve={id} onClick={() => onResolve(record, !isResolved)}>
                {isResolved ? 'Reopen' : 'Resolve'}
              </button>
            )}
          </span>
        )}
      </div>
      {/* A deletion with no words says it all at its head. */}
      {!(deletion && words.trim() === '') && (
        <div className="ib-sentb-msg" data-sent-message={id}>
          <div className="ib-sentb-meta">
            <span className="ib-sentc-who">You</span>
          </div>
          {saidWithSubThreads(id, words, !draft && !!onSubThread)}
        </div>
      )}
      {(under.length > 0 || replyBox) && (
        <div className="ib-sentb-replies" data-sent-replies={id}>
          {under.map((reply) => (
            <div
              key={reply.id}
              className="ib-sentb-msg"
              data-sent-reply={reply.id}
              data-sent-reply-draft={reply.draft ? '' : undefined}
              data-sent-new={fresh?.has(reply.id) ? '' : undefined}
            >
              <div className="ib-sentb-meta">
                <span className="ib-sentc-who">{reply.who}</span>
                <SentStatusChip status={statuses?.get(reply.id)} />
                {fresh?.has(reply.id) && <span className="ib-sentc-chip ib-sentb-new">New</span>}
                {reply.draft && onSend && <SentSendButton id={reply.id} onSend={onSend} />}
              </div>
              {saidWithSubThreads(reply.id, reply.text, !reply.draft && !!onSubThread)}
            </div>
          ))}
          {replyBox && <div className="ib-sentb-boxrow">{replyBox}</div>}
        </div>
      )}
    </div>
  );
}

/** The sub-threads under a thread, on its messages and theirs, at any depth (what its folded line counts). */
function countSubThreads(id: string, replies: ReadonlyMap<string, readonly SentReplyRow[]>, subThreads: ReadonlyMap<string, readonly SentThreadRecord[]>): number {
  const seen = new Set<string>();
  const walk = (threadId: string) => {
    for (const messageId of [threadId, ...(replies.get(threadId) ?? []).map((reply) => reply.id)]) {
      for (const sub of subThreads.get(messageId) ?? NO_RECORDS) {
        if (seen.has(sub.id)) continue;
        seen.add(sub.id);
        walk(sub.id);
      }
    }
  };
  walk(id);
  return seen.size;
}

/**
 * The box a reply, or a comment on a passage (`quote`, drawn at its head), is
 * written in under a message's comment: Reply or Comment (or the comment
 * composers' key, `isCommentSubmitKey`: ⌘/Ctrl+Enter, and Enter with "Enter
 * saves a comment") saves it as a draft; Escape or Cancel closes it. That key
 * here never reaches the thread's Send. The words are the list's, so a box
 * opened elsewhere keeps them.
 */
function SentReplyBox({
  value,
  quote,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  quote?: string;
  onChange: (text: string) => void;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const enterSavesComment = useConfigValue('enterSavesComment');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = area.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);
  const save = async () => {
    const words = value.trim();
    if (!words || busy) return;
    setBusy(true);
    await onSave(words);
    setBusy(false);
  };
  const label = quote === undefined ? 'Reply' : 'Comment on passage';
  return (
    <div className="ib-sentc-box" data-sent-passage-box={quote === undefined ? undefined : ''}>
      {quote !== undefined && <p className="ib-sentc-boxquote">“{shortLabel(quote)}”</p>}
      <textarea
        ref={area}
        className="ib-sentc-area"
        aria-label={label}
        placeholder={quote === undefined ? 'Reply...' : 'Comment on this passage...'}
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (isCommentSubmitKey(event, enterSavesComment)) {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }
        }}
      />
      <div className="ib-sentc-acts">
        <button type="button" className="ib-btn ib-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ib-btn ib-sm ib-pri" data-sent-reply-save="" disabled={busy || value.trim() === ''} onClick={() => void save()}>
          {quote === undefined ? 'Reply' : 'Comment'}
        </button>
      </div>
    </div>
  );
}
