/**
 * The Plannotator Inbox's comment threads as boxes in a document's flow, as
 * crit's (its comments that stay after Send, experimental
 * "persistent-comments"), moved here from
 * packages/inbox/components/SentComments.tsx so every web client draws the
 * same boxes (the Inbox window, the screens' review loop). One code draws a
 * box, a group of boxes and what a box's head says, at any depth and for any
 * kind of comment: a thread on the document and a sub-thread on a message's
 * words are the same box, the depth and the kind only parameters. A host
 * places its threads with `sentThreadSlots` (under the block each passage
 * starts in, `Viewer`'s `belowBlock`; at the document's end the general
 * comments, then the Unanchored ones) and passes what it shows: the threads
 * as core's records, their replies, sub-threads and passages
 * (`SentCommentsTree`, sentCommentsTree.ts), and the person's actions, each
 * absent when the person cannot take it. The look is the Inbox's `ib-sentb-*`
 * and `ib-sentc-*` rules, which stay in packages/inbox/inbox.css and ship in
 * @plannotator/ui/inbox-thread.css.
 *
 * At a box's head the passage and what the head says of it (`SentChips`: its
 * kind when not a comment, Deletion, Looks good or its label; its round or
 * Not sent, a draft's Send at any depth; its send's status, Live,
 * ✓ Resolved, Unanchored), Reply and Resolve; then its messages: the comment, and the
 * replies under it, each with who wrote it (a reply its status or New, never
 * the round the head says). A sub-thread is a box in the box, in the message
 * whose passage it is on, under the block (paragraph) of its words where the
 * passage starts, as a thread sits under its block in the document, in a
 * group of boxes like the document's (`BoxGroup`, one rule for the room
 * above and below every box); its passage marked in those words; one whose
 * passage is not found, at the message's end, Unanchored. A resolved thread
 * folds to one "Resolved" line (a press opens it to be read) only once
 * nothing under it, at any depth, is open.
 *
 * A sub-thread is a comment like one on the document's words: words selected
 * in a message offer the document's selection toolbar (`PassageToolbar`, the
 * one way to comment on a passage of a message, with the host's `Viewer`
 * options: Delete, Comment, the quick labels, 👍 Looks good), and each action
 * makes the same kind of comment (`PassageComment`); a deletion says so at
 * its head ("Deletion", its passage struck through, as the document strikes
 * a deletion's words), on the document's threads too.
 *
 * With comment sends (the host passes `onSend` and the tree's `statuses`,
 * `live` and `fresh`): a draft, the comment, a reply under one or a
 * sub-thread, has Send, which sends it alone at once without ending the
 * round; what a send carried says what became of it (Queued, Delivered,
 * Read, Working, Replied); a thread a send reached at once is Live (the
 * person's next replies in it go on their own); and an agent's reply the
 * person has not seen yet is New.
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { isInboxCommentThreadFolded, isInboxSubThread } from '@plannotator/core/inbox-comment-threads';
import type { TextPassage } from '@plannotator/core/passage';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import type { InboxCommentSendStatus } from '@plannotator/core/inbox-comment-sends';
import { useConfigValue } from '../../config';
import { AnnotationType, type Annotation } from '../../types';
import { PassageToolbar, usePassageOffer, type PassageToolbarOptions } from '../PassageToolbar';
import { commentKind, PASSAGE_BODY_ATTRIBUTE, PASSAGE_PIECE_ATTRIBUTE, passageRanges, selectedPassage, splitByRanges, type CommentKind, type PassageComment, type PassageMark, type SelectedPassage } from '../../utils/passageSelection';
import { isCommentSubmitKey } from '../../utils/commentSubmitKey';
import { Icon } from './icons';
import { shortLabel } from './shortLabel';
import { isGeneralThread, placeOnMessage, placeThreads, subThreadPassage, type SentCommentsTree, type SentReplyRow, type SentThreadRecord } from './sentCommentsTree';

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
  const [shownIds, setShown] = useState<ReadonlySet<string>>(NO_IDS);
  // The passage offered: one message's words inside a group of this surface's (the one way a passage is offered, ../PassageToolbar).
  const { offer, close: closeOffer } = usePassageOffer<NonNullable<SentThreadsView['offer']>>(offering, (selection) => {
    const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null;
    const groupOf = (node: Node | null) => (node instanceof Element ? node : (node?.parentElement ?? null))?.closest<HTMLElement>(`[${THREADS_ATTRIBUTE}]`) ?? null;
    const group = range ? (groupOf(range.startContainer) ?? groupOf(range.endContainer)) : null;
    const key = group?.getAttribute(THREADS_ATTRIBUTE) ?? '';
    const passage = group && key.startsWith(`${surface}:`) ? selectedPassage(group, selection) : null;
    return passage ? { passage, group: key } : null;
  });
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
 * What a group of threads does: bring a thread's passage into view (absent: its quote is words), the person's
 * Resolve, Reply, comment on a passage and Send of one draft (each absent: none), and what a press in a box tells
 * the host (`onLook`: it was looked at; called for the box pressed in and each box around it, at any depth).
 */
interface SentThreadsActions<R extends SentThreadRecord = InboxAnnotationRecord> {
  onOpen?: (record: R) => void;
  onLook?: (record: R) => void;
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

/** A thread's round, or Not sent for a draft (none when it has neither). */
function SentRoundChip({ draft, round }: { draft?: boolean; round?: number }) {
  if (draft) return <span className="ib-sentc-chip">Not sent</span>;
  return round === undefined ? null : (
    <span className="ib-sentc-chip" data-sent-round={round}>
      Round {round}
    </span>
  );
}

/** A thread's kind when it is not a comment (`commentKind`): Deletion, Looks good (in the success colour), or its label. */
function SentKindChip({ kind }: { kind: CommentKind }) {
  if (kind.kind === 'comment') return null;
  const words = kind.kind === 'deletion' ? 'Deletion' : kind.kind === 'looks-good' ? 'Looks good' : kind.words;
  const look = kind.kind === 'deletion' ? ' ib-sentb-deletion' : kind.kind === 'looks-good' ? ' ib-sentb-good' : '';
  return (
    <span className={`ib-sentc-chip${look}`} data-sent-kind={kind.kind} data-sent-deletion-chip={kind.kind === 'deletion' ? '' : undefined}>
      {words}
    </span>
  );
}

/**
 * What a thread's head says of it after its passage, at any depth and for any kind (a box's head, and a host's card,
 * the Inbox file panel's): its kind when it is not a comment (Deletion, Looks good, its label), its round or Not sent,
 * what became of its send, Live while open, ✓ Resolved in the success colour, and Unanchored when its passage was not
 * found.
 */
export function SentChips({
  kind,
  draft = false,
  round,
  status,
  live = false,
  resolved = false,
  unanchored = false,
}: {
  kind?: CommentKind;
  draft?: boolean;
  round?: number;
  status?: InboxCommentSendStatus;
  live?: boolean;
  resolved?: boolean;
  unanchored?: boolean;
}) {
  return (
    <>
      {kind && <SentKindChip kind={kind} />}
      <SentRoundChip draft={draft} round={round} />
      <SentStatusChip status={status} />
      {live && !resolved && (
        <span className="ib-sentc-chip ib-sentb-live" data-sent-live="" title="Your replies here go to the agent as you save them">
          Live
        </span>
      )}
      {resolved && (
        <span className="ib-sentc-chip ib-sentb-resolved" data-sent-resolved-chip="">
          <Icon name="check" size={11} />
          Resolved
        </span>
      )}
      {unanchored && (
        <span className="ib-sentc-chip" data-sent-unanchored="">
          Unanchored
        </span>
      )}
    </>
  );
}

/**
 * A card's state in a comments panel, where a thread is a card because there is no text to put its box in (an HTML
 * page, the plan diff, the Markdown edit mode; the Inbox's code, HTML, image and video files): what a box's head says,
 * by the same chips. `annotation`: a thread's (its kind; none for a reply). The card says Deletion in its own type word
 * and Unanchored in its own chip, so neither is said twice here.
 */
export function SentCardChips({
  annotation,
  ...chips
}: { annotation?: { type?: unknown; text?: unknown; isQuickLabel?: unknown } } & Omit<ComponentProps<typeof SentChips>, 'kind' | 'unanchored'>) {
  const kind = annotation ? commentKind(annotation) : undefined;
  return <SentChips {...chips} kind={kind?.kind === 'deletion' ? undefined : kind} />;
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

/** What one group of boxes draws (`SentThreads`), and what a host gives `sentThreadSlots` for its document's groups. */
export type SentThreadsProps<R extends SentThreadRecord = InboxAnnotationRecord> = {
  /** This group's key, inside its view's surface. */
  group: string;
  records: readonly R[];
  tree: SentCommentsTree<R>;
  view: SentThreadsView;
  /** The ones whose passage was not found, at the document's end: each box Unanchored. */
  lost?: boolean;
  /**
   * The options of the document's own selection toolbar here (the host's `Viewer`'s): a passage of a message offers
   * the same actions, Delete and the labels making their sub-thread at once. Absent: Comment only, as before.
   */
  passageToolbar?: PassageToolbarOptions;
} & SentThreadsActions<R>;

/**
 * The threads on one block of a document (or, `lost`, the ones whose
 * passage was not found, at its end, each Unanchored), each a box of its own,
 * as crit's: at its head the passage and what the head says of it, Reply and
 * Resolve; then its messages, the comment and each reply under it (who,
 * words); a sub-thread is a box in the box, in the message whose passage it
 * is on, under the block of its words the passage starts in
 * (`placeOnMessage`), in a group like this one (`BoxGroup`), at the same
 * indent at each level, at any depth. A resolved thread folds to one line
 * ("Resolved", a press opens it to be read) only when nothing under it, at
 * any depth, is open; until then it stays unfolded, marked Resolved, its open
 * sub-threads in view. Reply opens a box at the thread's foot; words selected
 * in a sent message offer ui's selection toolbar (`PassageToolbar`), whose
 * Comment opens a box under the passage's block with the passage at its
 * head. A draft goes with the next Send, or alone by its own Send (`onSend`).
 *
 * The records are any client's (`SentThreadRecord`): the Inbox's own, or the
 * ones a host builds from the neutral thread view (`sentThreadsFromView`).
 * A resolved thread says so plainly: its passage's bar and its frame take
 * the success colour, a "✓ Resolved" chip at its head, its words dimmed.
 */
export function SentThreads<R extends SentThreadRecord = InboxAnnotationRecord>({ group, records, tree, view, lost = false, passageToolbar, ...actions }: SentThreadsProps<R>) {
  if (records.length === 0) return null;
  const key = `${view.surface}:${group}`;
  const { onSubThread } = actions;
  const offer = view.offer?.group === key ? view.offer.passage : null;
  return (
    <BoxGroup
      items={records.map((record) => ({ record, lost }))}
      context={{ tree, view, actions }}
      attributes={{
        [THREADS_ATTRIBUTE]: key,
        'data-sent-comments': '',
        'data-sent-lost': lost ? '' : undefined,
        role: 'group',
        'aria-label': lost ? 'Comments whose passage was not found' : 'Comments on this passage',
      }}
    >
      {offer && onSubThread && (
        <PassageToolbar
          passage={offer}
          options={passageToolbar}
          onComment={(passage, initialChar) =>
            view.setBox((open) => ({ at: passage.parentId, text: `${open?.text ?? ''}${initialChar ?? ''}`, opened: (open?.opened ?? 0) + 1, passage: { quote: passage.quote, offset: passage.offset } }))
          }
          // Delete or a label: the comment is made at once, as on the document's words (a refusal is the host's to say).
          onPreset={passageToolbar ? (passage, comment) => void onSubThread(passage.parentId, { quote: passage.quote, offset: passage.offset }, comment) : undefined}
          onClose={view.closeOffer}
        />
      )}
    </BoxGroup>
  );
}

/**
 * Where a document's threads go, as every host draws them (the Inbox's messages and files, the screens): under the
 * block each one's passage starts in (`below`, for `Viewer`'s `belowBlock`), and at the document's end (`after`) the
 * general comments, then the ones whose passage was not found, Unanchored (`placeThreads`, `isGeneralThread`). `found`:
 * what the viewer found of their words since (`placeThreads`). Each group is `SentThreads` with the host's `props`,
 * its key `<props.group>:<block id | general | end>`.
 */
export function sentThreadSlots<R extends SentThreadRecord>(
  records: readonly R[],
  blocks: readonly { id: string }[],
  props: Omit<SentThreadsProps<R>, 'records' | 'lost'>,
  found?: Parameters<typeof placeThreads>[2],
): { below: (block: { id: string }) => ReactNode; after: ReactNode } {
  const { byBlock, rest } = placeThreads(records, new Set(blocks.map((block) => block.id)), found);
  const general = rest.filter(isGeneralThread);
  const lost = rest.filter((record) => !isGeneralThread(record));
  const groupOf = (key: string, list: readonly R[], unfound?: boolean) => <SentThreads key={key} {...props} group={`${props.group}:${key}`} records={list} lost={unfound} />;
  return {
    below: (block) => {
      const on = byBlock.get(block.id);
      return on ? groupOf(block.id, on) : null;
    },
    after:
      general.length + lost.length > 0 ? (
        <>
          {general.length > 0 && groupOf('general', general)}
          {lost.length > 0 && groupOf('end', lost, true)}
        </>
      ) : null,
  };
}

/** What every box of a surface shares: the tree its threads are read from, the surface's view and the person's actions. */
interface BoxContext<R extends SentThreadRecord> {
  tree: SentCommentsTree<R>;
  view: SentThreadsView;
  actions: SentThreadsActions<R>;
}

/**
 * Boxes drawn together, at any depth: a document block's threads (`ib-sentb`), or the sub-threads under one block of
 * a message's words (`on`, the message; `ib-sentb-subs`, indented). The same element and the same room above and below
 * at every depth and for every kind of box; `children` after the boxes (the box commenting on a passage there, the
 * selection toolbar). `root`: the boxes' thread's first comment, for a sub-thread group.
 */
function BoxGroup<R extends SentThreadRecord>({
  on,
  items,
  root,
  context,
  attributes,
  children,
}: {
  on?: string;
  items: readonly { record: R; lost: boolean }[];
  root?: R;
  context: BoxContext<R>;
  attributes?: Record<string, string | undefined>;
  children?: ReactNode;
}) {
  return (
    <div className={on === undefined ? 'ib-sentb' : 'ib-sentb-subs'} {...(on !== undefined ? { 'data-sent-subthreads': on } : {})} {...attributes}>
      {items.map(({ record, lost }) => (
        <SentThreadBox key={record.id} record={record} root={root ?? record} lost={lost} {...context} />
      ))}
      {children}
    </div>
  );
}

/** One thread (a comment, or a sub-thread; `root`: its thread's first comment), as a box; `lost`: placed where it is because its passage was not found. */
function SentThreadBox<R extends SentThreadRecord>({ record, root, lost, tree, view, actions }: { record: R; root: R; lost: boolean } & BoxContext<R>) {
  const { rounds, resolved, replies, subThreads, openBelow, passages, statuses, live, fresh } = tree;
  const { onOpen, onLook, onResolve, onReply, onSubThread, onSend } = actions;
  const { box, setBox } = view;
  const id = record.id;
  const annotation = record.annotation as unknown as Annotation;
  const quote = annotation.originalText ?? '';
  /** A comment on the whole document: no passage (never one on part of an image or an element, which has no words either). */
  const general = isGeneralThread(record);
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
  const context: BoxContext<R> = { tree, view, actions };
  const marks = {
    'data-sent-comment': id,
    'data-sent-subthread': isSub ? '' : undefined,
    'data-sent-deletion': deletion ? '' : undefined,
    'data-sent-resolved': isResolved ? '' : undefined,
    'data-sent-folded': folded ? '' : undefined,
  };
  // A press in a box is a look at it (and, the press being in them too, at the boxes around it).
  const look = onLook ? () => onLook(record) : undefined;
  if (folded) {
    const subs = countSubThreads(id, replies, subThreads);
    return (
      <div className="ib-sentb-card" {...marks} onClickCapture={look}>
        <button type="button" className="ib-sentb-fold" aria-expanded={false} data-sent-unfold={id} onClick={() => view.toggleShown(id)}>
          <Icon name="chevR" size={12} />
          <span className="ib-sentb-state" data-sent-resolved-chip="">
            <Icon name="check" size={12} />
            Resolved
          </span>
          <span className="ib-sentb-fquote">{general ? 'General comment' : `“${shortLabel(quote)}”`}</span>
          <SentRoundChip draft={draft} round={round} />
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
   * several on one block in their passages' order, one whose passage is not found at the message's end, Unanchored;
   * the box commenting on a passage of them, under that passage's block, after the sub-threads there. A message whose
   * sub-threads all sit under its last block is drawn whole, then them.
   */
  const saidWithSubThreads = (messageId: string, text: string, selectable: boolean) => {
    const list: readonly R[] = subThreads.get(messageId) ?? [];
    const composer = boxFor(messageId, true);
    const items: readonly (R | null)[] = composer ? [...list, null] : list;
    const pieces = placeOnMessage(text, items, (item) => (item ? subThreadPassage(item) : box?.passage));
    return pieces.map((piece, index) => {
      const subs = piece.under.flatMap(({ item, found }) => (item ? [{ record: item, lost: !found }] : []));
      const composerHere = piece.under.some(({ item }) => item === null) ? composer : null;
      // The last piece keeps its key, so what sits at the message's end stays as it is when a block above gets a box.
      return (
        <Fragment key={index === pieces.length - 1 ? 'end' : piece.to}>
          <Said text={text} from={piece.from} to={piece.to} piece={pieces.length > 1} bodyOf={selectable ? messageId : undefined} passages={passages.get(messageId)} />
          {(subs.length > 0 || composerHere) && (
            <BoxGroup on={messageId} items={subs} root={root} context={context}>
              {composerHere}
            </BoxGroup>
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
    <div className="ib-sentb-card" {...marks} data-sent-draft={draft ? '' : undefined} onClickCapture={look}>
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
          <SentChips
            kind={commentKind(annotation)}
            draft={draft}
            round={round}
            status={statuses?.get(id)}
            live={live?.has(id)}
            resolved={isResolved}
            unanchored={lost || typeof record.unanchored_at === 'string'}
          />
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
