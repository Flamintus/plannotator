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
 * passage is not found, at the message's end, Unanchored. Any box folds and
 * unfolds by hand, at any depth and of any kind or state: its head's `▾`
 * folds it to one line (`▸`, its passage, what its head says, what it holds,
 * a draft's Send), and a press on that line opens it. By default only a
 * resolved thread folds, once nothing under it, at any depth, is open.
 *
 * A sub-thread is a comment like one on the document's words: words selected
 * in a message offer the document's selection toolbar (`PassageToolbar`, the
 * one way to comment on a passage of a message, with the host's `Viewer`
 * options: Delete, Comment, the quick labels, 👍 Looks good), and each action
 * makes the same kind of comment (`PassageComment`); a deletion says so at
 * its head ("Deletion", its passage struck through, as the document strikes
 * a deletion's words), on the document's threads too.
 *
 * A comment the person can still change (a draft, a reply under a comment or
 * a sub-thread not sent: the host's `canEdit`, the rule its list or panel
 * offers Edit by) has Edit, at its box's head (and on its folded line) or on
 * its reply's line: the reply's field, prefilled, takes the place of its
 * words, and Save (the host's `onEdit`, its list's or panel's own save) or
 * Cancel shows its words again.
 *
 * With comment sends (the host passes `onSend` and the tree's `statuses`,
 * `live` and `fresh`): a draft, the comment, a reply under one or a
 * sub-thread, has Send, which sends it alone at once without ending the
 * round; what a send carried says what became of it (Queued, Delivered,
 * Read, Working, Replied); a thread the person turned Live on is Live (their
 * next replies in it go on their own as they are saved); and an agent's
 * reply the person has not seen yet is New. With `onLive`, a sent box, at
 * any depth, has Live at its head, which turns it on or off (pressed while
 * on, in the Live mark's look); a draft has none.
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
const NO_FLIPS: ReadonlyMap<string, boolean> = new Map();

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

/** A comment the person can still change, edited in its box (`at`, its id): the words in the field, prefilled with its own. */
type EditBox = { at: string; text: string; opened: number };

/**
 * What the person has open among one surface's threads (a thread's messages,
 * or a file's document): the one box (another opens in its place and keeps
 * the words), the comment edited in its box (`edit`, one at a time), the
 * passage offered for a comment (`offer`, with the group of
 * threads its words are in), and the boxes folded or unfolded by hand, any
 * box at any depth (`isFolded`, `toggleFold`; `byDefault`: whether the box is
 * folded by default, a resolved thread with nothing open under it). `surface`
 * names the groups this view draws (`data-sent-threads`), so a selection in
 * another surface's threads, or anywhere else, offers nothing here.
 */
export interface SentThreadsView {
  surface: string;
  box: ListBox | null;
  setBox: Dispatch<SetStateAction<ListBox | null>>;
  edit: EditBox | null;
  setEdit: Dispatch<SetStateAction<EditBox | null>>;
  offer: { passage: SelectedPassage; group: string } | null;
  closeOffer: () => void;
  isFolded: (id: string, byDefault: boolean) => boolean;
  toggleFold: (id: string, byDefault: boolean) => void;
}

const THREADS_ATTRIBUTE = 'data-sent-threads';

/**
 * One surface's view of its threads (see `SentThreadsView`). While `offering`
 * (a thread there takes comments on its passages), a selection let go that
 * holds one sent message's words offers to comment on that passage; it
 * listens on the document, since a drag past the last line ends outside the
 * threads. `folded`: the threads folded by default now, so a box folded or
 * unfolded by hand whose default changed since (a resolved thread opened
 * again by a Reopen or a reply, an open one resolved) is back to its default:
 * a thread opened to be read starts folded when it folds again.
 */
export function useSentThreadsView(offering: boolean, folded: ReadonlySet<string>): SentThreadsView {
  const surface = useId();
  const [box, setBox] = useState<ListBox | null>(null);
  const [edit, setEdit] = useState<EditBox | null>(null);
  // The boxes the person folded or unfolded by hand, each with its default then (folded or not).
  const [flips, setFlips] = useState<ReadonlyMap<string, boolean>>(NO_FLIPS);
  // The passage offered: one message's words inside a group of this surface's (the one way a passage is offered, ../PassageToolbar).
  const { offer, close: closeOffer } = usePassageOffer<NonNullable<SentThreadsView['offer']>>(offering, (selection) => {
    const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null;
    const groupOf = (node: Node | null) => (node instanceof Element ? node : (node?.parentElement ?? null))?.closest<HTMLElement>(`[${THREADS_ATTRIBUTE}]`) ?? null;
    const group = range ? (groupOf(range.startContainer) ?? groupOf(range.endContainer)) : null;
    const key = group?.getAttribute(THREADS_ATTRIBUTE) ?? '';
    const passage = group && key.startsWith(`${surface}:`) ? selectedPassage(group, selection) : null;
    return passage ? { passage, group: key } : null;
  });
  // A box whose default changed since the person flipped it is back to its default, for good.
  const kept = useMemo(() => {
    const still = [...flips].filter(([id, byDefault]) => folded.has(id) === byDefault);
    return still.length === flips.size ? flips : new Map(still);
  }, [flips, folded]);
  useEffect(() => {
    if (kept !== flips) setFlips(kept);
  }, [kept, flips]);
  const isFolded = useCallback((id: string, byDefault: boolean) => (kept.get(id) === byDefault ? !byDefault : byDefault), [kept]);
  const toggleFold = useCallback((id: string, byDefault: boolean) => {
    setFlips((current) => {
      const next = new Map(current);
      if (next.get(id) === byDefault) next.delete(id);
      else next.set(id, byDefault);
      return next;
    });
  }, []);
  return useMemo(() => ({ surface, box, setBox, edit, setEdit, offer, closeOffer, isFolded, toggleFold }), [surface, box, edit, offer, closeOffer, isFolded, toggleFold]);
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
  /** Turn Live on (`live`) or off on a sent thread (a comment or a sub-thread, at any depth): under it the person's replies go on their own. Absent: no Live button. */
  onLive?: (record: R, live: boolean) => void;
  /**
   * Whether the person can still change a comment (a comment, a reply under one, a sub-thread, by id): the host's own
   * rule, the one its list or panel offers Edit by (a draft, never what was sent). With `onEdit`, its box has Edit.
   */
  canEdit?: (id: string) => boolean;
  /** Save a comment's new words by the host's own way (its list's or its panel's Edit); the box shows its words again after. */
  onEdit?: (id: string, text: string) => void | Promise<unknown>;
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
  /**
   * The comment selected on the page (its card in the panel, its entry in the list, its highlight pressed): the box
   * drawn that holds it, the innermost, is where the person is (`data-sent-selected`), as the box under the pointer
   * or holding the keyboard's focus is. Absent: none.
   */
  selected?: string | null;
} & SentThreadsActions<R>;

/**
 * The threads on one block of a document (or, `lost`, the ones whose
 * passage was not found, at its end, each Unanchored), each a box of its own,
 * as crit's: at its head the passage and what the head says of it, Reply and
 * Resolve; then its messages, the comment and each reply under it (who,
 * words); a sub-thread is a box in the box, in the message whose passage it
 * is on, under the block of its words the passage starts in
 * (`placeOnMessage`), in a group like this one (`BoxGroup`), at the same
 * indent at each level, at any depth. Any box folds by hand to one line (its
 * head's `▾`; a press on the line opens it); by default a resolved thread is
 * folded only when nothing under it, at any depth, is open; until then it
 * stays unfolded, marked Resolved, its open sub-threads in view. Reply opens
 * a box at the thread's foot; words selected
 * in a sent message offer ui's selection toolbar (`PassageToolbar`), whose
 * Comment opens a box under the passage's block with the passage at its
 * head. A draft goes with the next Send, or alone by its own Send (`onSend`).
 *
 * The records are any client's (`SentThreadRecord`): the Inbox's own, or the
 * ones a host builds from the neutral thread view (`sentThreadsFromView`).
 * A resolved thread says so plainly: its passage's bar takes the success
 * colour, a "✓ Resolved" chip at its head, its words dimmed. Every box's frame
 * is grey; only the box where the person is, the innermost (`selected`, or
 * under the pointer, or holding the focus), takes a colour, the comments'
 * own, or the success colour once resolved.
 */
export function SentThreads<R extends SentThreadRecord = InboxAnnotationRecord>({ group, records, tree, view, lost = false, passageToolbar, selected = null, ...actions }: SentThreadsProps<R>) {
  if (records.length === 0) return null;
  const key = `${view.surface}:${group}`;
  const { onSubThread } = actions;
  const offer = view.offer?.group === key ? view.offer.passage : null;
  return (
    <BoxGroup
      items={records.map((record) => ({ record, lost }))}
      context={{ tree, view, actions, selected }}
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

/**
 * What every box of a surface shares: the tree its threads are read from, the surface's view, the person's actions
 * and the comment selected on the page.
 */
interface BoxContext<R extends SentThreadRecord> {
  tree: SentCommentsTree<R>;
  view: SentThreadsView;
  actions: SentThreadsActions<R>;
  selected: string | null;
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
function SentThreadBox<R extends SentThreadRecord>({ record, root, lost, tree, view, actions, selected }: { record: R; root: R; lost: boolean } & BoxContext<R>) {
  const { rounds, resolved, replies, subThreads, openBelow, passages, statuses, live, fresh } = tree;
  const { onOpen, onLook, onResolve, onReply, onSubThread, onSend, onLive, canEdit, onEdit } = actions;
  const { box, setBox, edit, setEdit } = view;
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
  const isLive = live?.has(id) === true;
  // Folded by default: a resolved thread with nothing open under it; any box folds and unfolds by hand.
  const byDefault = isInboxCommentThreadFolded(id, resolved, openBelow);
  const folded = view.isFolded(id, byDefault);
  const toggleFold = () => view.toggleFold(id, byDefault);
  const under = replies.get(id) ?? [];
  const context: BoxContext<R> = { tree, view, actions, selected };
  // Folded, what it hides that its line says (and whether the comment selected is in there).
  const held = folded ? heldUnder(id, replies, subThreads, fresh, selected) : null;
  // The comment selected is one of this box's messages (or, folded, anything under it): the person is here.
  const here = selected !== null && (selected === id || under.some((reply) => reply.id === selected) || held?.selected === true);
  const marks = {
    'data-sent-comment': id,
    'data-sent-subthread': isSub ? '' : undefined,
    'data-sent-deletion': deletion ? '' : undefined,
    'data-sent-resolved': isResolved ? '' : undefined,
    'data-sent-draft': draft ? '' : undefined,
    'data-sent-folded': folded ? '' : undefined,
    'data-sent-selected': here ? '' : undefined,
  };
  // A press in a box is a look at it (and, the press being in them too, at the boxes around it).
  const look = onLook ? () => onLook(record) : undefined;
  /** Live at the head of a sent box: pressed while on, in the Live mark's look, which it then stands for. */
  const liveButton = !draft && onLive ? (
    <button
      type="button"
      className={`ib-sentc-act${isLive ? ' ib-sentb-live' : ''}`}
      aria-pressed={isLive}
      data-sent-live-toggle={id}
      data-sent-live={isLive ? '' : undefined}
      title={isLive ? 'Live: your replies here go to the agent as you save them. Press to turn it off.' : 'Turn Live on: your replies here go to the agent as you save them.'}
      onClick={() => onLive(record, !isLive)}
    >
      Live
    </button>
  ) : null;
  // What the head says, folded or not: its kind, its round or Not sent, its send's status, Live, ✓ Resolved, Unanchored.
  // Open, a box with the Live button says Live by it, not twice.
  const chipsWith = (withLive: boolean) => (
    <SentChips
      kind={commentKind(annotation)}
      draft={draft}
      round={round}
      status={statuses?.get(id)}
      live={withLive && isLive}
      resolved={isResolved}
      unanchored={lost || typeof record.unanchored_at === 'string'}
    />
  );
  const chips = chipsWith(true);
  /** A comment of this box the person can still change (the host's rule) is being edited: the field in place of its words. */
  const editable = (messageId: string) => !!onEdit && canEdit?.(messageId) === true;
  const editing = (messageId: string) => edit?.at === messageId && editable(messageId);
  /** Edit on a comment the person can still change (`open`: what opens its box first, on a folded line). */
  const editButton = (messageId: string, text: string, open?: () => void) =>
    editable(messageId) && !editing(messageId) ? (
      <button
        type="button"
        className="ib-sentc-act ib-sentb-edit"
        data-sent-edit={messageId}
        onClick={() => {
          open?.();
          setEdit((current) => ({ at: messageId, text, opened: (current?.opened ?? 0) + 1 }));
        }}
      >
        Edit
      </button>
    ) : null;
  /** The field a comment's words are edited in, in their place: prefilled, the reply's field and keys; Save or Cancel shows its words again. */
  const editField = (messageId: string) =>
    edit && editing(messageId) ? (
      <SentReplyBox
        key={edit.opened}
        edit
        value={edit.text}
        onChange={(text) => setEdit((current) => (current ? { ...current, text } : current))}
        onSave={async (text) => {
          const current = edit;
          await onEdit!(messageId, text);
          setEdit((open) => (open?.opened === current.opened ? null : open));
        }}
        onCancel={() => setEdit(null)}
      />
    ) : null;
  // A draft's Edit and Send, at its head and on its folded line alike (Edit there opens the box at its words).
  const headEdit = editButton(id, words, folded ? toggleFold : undefined);
  const send = (headEdit || (draft && onSend)) && (
    <span className="ib-sentb-acts">
      {headEdit}
      {draft && onSend && <SentSendButton id={id} onSend={onSend} />}
    </span>
  );
  if (held) {
    return (
      <div className="ib-sentb-card" {...marks} onClickCapture={look}>
        <button type="button" className="ib-sentb-fold" aria-expanded={false} data-sent-unfold={id} onClick={toggleFold}>
          <Icon name="chevR" size={12} />
          <span className="ib-sentb-fquote">{general ? 'General comment' : `“${shortLabel(quote)}”`}</span>
          <span className="ib-sentb-chips">
            {chips}
            {held.fresh && (
              <span className="ib-sentc-chip ib-sentb-new" data-sent-new="">
                New
              </span>
            )}
          </span>
          <span className="ib-sentb-count" data-sent-messages={1 + under.length} data-sent-subthreads={held.subs}>
            {plural(1 + under.length, 'message')}
            {held.subs > 0 ? `, ${plural(held.subs, 'sub-thread')}` : ''}
          </span>
        </button>
        {send}
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
    <div className="ib-sentb-card" {...marks} onClickCapture={look}>
      <div className="ib-sentb-head">
        <button type="button" className="ib-sentb-chev" aria-expanded={true} aria-label="Fold the comment" data-sent-unfold={id} onClick={toggleFold}>
          <Icon name="chevD" size={12} />
        </button>
        {!isSub && onOpen ? (
          <button type="button" className="ib-sentb-quote" onClick={() => onOpen(root)} title="Show the passage">
            {quoteText}
          </button>
        ) : (
          <span className="ib-sentb-quote">{quoteText}</span>
        )}
        <span className="ib-sentb-chips">{chipsWith(!liveButton)}</span>
        {send}
        {!draft && (onReply || onResolve || liveButton) && (
          <span className="ib-sentb-acts">
            {liveButton}
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
      {/* A deletion with no words says it all at its head (unless its words are being written). */}
      {(!(deletion && words.trim() === '') || editing(id)) && (
        <div className="ib-sentb-msg" data-sent-message={id}>
          <div className="ib-sentb-meta">
            <span className="ib-sentc-who">You</span>
          </div>
          {editField(id) ?? saidWithSubThreads(id, words, !draft && !!onSubThread)}
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
                {editButton(reply.id, reply.text)}
                {reply.draft && onSend && <SentSendButton id={reply.id} onSend={onSend} />}
              </div>
              {editField(reply.id) ?? saidWithSubThreads(reply.id, reply.text, !reply.draft && !!onSubThread)}
            </div>
          ))}
          {replyBox && <div className="ib-sentb-boxrow">{replyBox}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * What a folded box hides that its line says: the sub-threads under it, on its messages and theirs, at any depth
 * (`subs`, counted), and whether an agent's reply among them, at any depth, is New (`fresh`); and whether the comment
 * selected on the page is one of the messages under it, at any depth (`selected`).
 */
function heldUnder(
  id: string,
  replies: ReadonlyMap<string, readonly SentReplyRow[]>,
  subThreads: ReadonlyMap<string, readonly SentThreadRecord[]>,
  fresh: ReadonlySet<string> | undefined,
  selected: string | null,
): { subs: number; fresh: boolean; selected: boolean } {
  const seen = new Set<string>();
  let isNew = false;
  let holds = false;
  const walk = (threadId: string) => {
    const under = replies.get(threadId) ?? [];
    if (fresh && under.some((reply) => fresh.has(reply.id))) isNew = true;
    if (selected !== null && under.some((reply) => reply.id === selected)) holds = true;
    for (const messageId of [threadId, ...under.map((reply) => reply.id)]) {
      for (const sub of subThreads.get(messageId) ?? NO_RECORDS) {
        if (seen.has(sub.id)) continue;
        seen.add(sub.id);
        if (sub.id === selected) holds = true;
        walk(sub.id);
      }
    }
  };
  walk(id);
  return { subs: seen.size, fresh: isNew, selected: holds };
}

/**
 * The box a reply, or a comment on a passage (`quote`, drawn at its head), is
 * written in under a message's comment, and the one a comment's words are
 * edited in, in their place (`edit`): Reply, Comment or Save (or the comment
 * composers' key, `isCommentSubmitKey`: ⌘/Ctrl+Enter, and Enter with "Enter
 * saves a comment") saves it as a draft; Escape or Cancel closes it. That key
 * here never reaches the thread's Send. The words are the list's, so a box
 * opened elsewhere keeps them.
 */
function SentReplyBox({
  value,
  quote,
  edit = false,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  quote?: string;
  edit?: boolean;
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
  const label = edit ? 'Edit the comment' : quote === undefined ? 'Reply' : 'Comment on passage';
  return (
    <div className="ib-sentc-box" data-sent-passage-box={quote === undefined ? undefined : ''} data-sent-edit-box={edit ? '' : undefined}>
      {quote !== undefined && <p className="ib-sentc-boxquote">“{shortLabel(quote)}”</p>}
      <textarea
        ref={area}
        className="ib-sentc-area"
        aria-label={label}
        placeholder={edit ? undefined : quote === undefined ? 'Reply...' : 'Comment on this passage...'}
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
          {edit ? 'Save' : quote === undefined ? 'Reply' : 'Comment'}
        </button>
      </div>
    </div>
  );
}
