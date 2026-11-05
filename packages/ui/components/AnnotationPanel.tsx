import React, { createContext, useContext, useMemo, useState, useRef, useEffect, useId } from 'react';
import { AnnotationType, type Annotation, type Block, type CodeAnnotation, type EditorAnnotation } from '../types';
import type { MentionSource } from '../utils/mentions';
import { useMentionAutocomplete } from '../hooks/useMentionAutocomplete';
import { MentionAutocompleteMenu, mentionActiveOptionId } from './MentionAutocomplete';
import { buildSectionRefIndex, parseSectionRefs } from '../utils/sectionRefs';
import { isCurrentUser } from '../utils/identity';
import { ImageThumbnail } from './ImageThumbnail';
import { EditorAnnotationCard } from './EditorAnnotationCard';
import { useIsMobile } from '../hooks/useIsMobile';
import { OverlayScrollArea } from './OverlayScrollArea';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { resolveReplyParents } from '@plannotator/core/annotation-threads';
import { basenameFromPath } from '@plannotator/core/source-save';
import { ROOT_DOCUMENT_GROUP_KEY } from '../utils/annotationScope';
import type { AnnotationScope, AnnotationDocumentGroup } from '../utils/annotationScope';
import type { QuestionPanelRow } from '../utils/questionAnswers';
import { QuestionsPanelSection } from './QuestionsPanelSection';
import { HostTitle } from './HostTitle';
import { isCommentSubmitKey } from '../utils/commentSubmitKey';
import { useConfigValue } from '../config/useConfig';
import { imageRegionNumbers, RegionCardInfo, RegionNumber, regionOf } from './ImageRegions';
import { CHECKBOX_ANNOTATION_PREFIX } from '../utils/annotationOwnsHighlight';
import type { TextPassage } from '@plannotator/core/passage';
import { PASSAGE_BODY_ATTRIBUTE, passageRanges, selectedPassage, selectionWithin, splitByRanges, type PassageComment, type PassageMark, type SelectedPassage } from '../utils/passageSelection';
import { PassageToolbar, usePassageOffer, type PassageToolbarOptions } from './PassageToolbar';

/** What a region card (#2100) needs from its panel: each region's number on
 *  its image, and how to load the image for the crop thumbnail. */
const RegionCardContext = createContext<{ numbers: ReadonlyMap<string, number>; thumbSrc?: (src: string) => string | null }>({
  numbers: new Map(),
});

// Card type-word colors. Deletion uses `destructive` (reliably red on every
// theme, matching the in-document .deletion highlight). Comment uses the
// `annotation-comment` token, which defaults to each theme's --accent (so it
// stays consistent with the .comment highlight) but is overridden to a legible
// blue in neutral themes whose accent is a low-contrast gray (e.g. "simple").
// Global has no in-document highlight, so it uses a fixed legible purple.
const TYPE_COLOR: Record<AnnotationType, string> = {
  [AnnotationType.DELETION]: 'text-destructive',
  [AnnotationType.COMMENT]: 'text-annotation-comment',
  [AnnotationType.GLOBAL_COMMENT]: 'text-purple-500',
};

const TYPE_LABEL: Record<AnnotationType, string> = {
  [AnnotationType.DELETION]: 'Deletion',
  [AnnotationType.COMMENT]: 'Comment',
  [AnnotationType.GLOBAL_COMMENT]: 'Global',
};

const PencilIcon = () => (
  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
);

const TrashCardIcon = () => (
  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const ReplyCardIcon = () => (
  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
  </svg>
);

/** One annotation in thread order: how deep it sits (0 for a root) and the
 *  annotation it replies to (null for a root). */
export interface ThreadedAnnotation {
  annotation: Annotation;
  isReply: boolean;
  depth: number;
  parent: Annotation | null;
}

type TimelineEntry =
  | ({ kind: 'plan' } & ThreadedAnnotation)
  | { kind: 'code'; annotation: CodeAnnotation; depth: 0 };

/**
 * Order annotations so every reply follows its parent, depth first: a reply
 * to a reply sits under that reply, before the parent's later replies
 * (replies to one annotation stay in input order). The threading rule is
 * the shared one (resolveReplyParents, also what the export applies): a
 * reply whose parent is absent, a self-reference, and every member of an
 * `inReplyTo` cycle render as top-level cards in input order, so nothing is
 * ever dropped. Without any `inReplyTo` the input order is returned
 * unchanged, so annotations without replies render exactly as before.
 */
export function threadReplies(sorted: Annotation[]): ThreadedAnnotation[] {
  if (!sorted.some((a) => a.inReplyTo)) return sorted.map((annotation) => ({ annotation, isReply: false, depth: 0, parent: null }));
  const parents = resolveReplyParents(sorted);
  const byParent = new Map<string, Annotation[]>();
  for (const a of sorted) {
    const parent = parents.get(a.id);
    if (!parent) continue;
    const list = byParent.get(parent) ?? [];
    list.push(a);
    byParent.set(parent, list);
  }
  // Depth-first, iteratively: a 5,000-deep chain must not recurse 5,000
  // frames deep. The stack holds each node's replies in reverse so they pop
  // in creation order.
  const out: ThreadedAnnotation[] = [];
  const stack: ThreadedAnnotation[] = [];
  const pushReplies = (a: Annotation, depth: number) => {
    const replies = byParent.get(a.id);
    if (!replies) return;
    for (let i = replies.length - 1; i >= 0; i--) stack.push({ annotation: replies[i], isReply: true, depth: depth + 1, parent: a });
  };
  for (const a of sorted) {
    if (parents.get(a.id)) continue;
    out.push({ annotation: a, isReply: false, depth: 0, parent: null });
    pushReplies(a, 0);
    while (stack.length > 0) {
      const next = stack.pop()!;
      out.push(next);
      pushReplies(next.annotation, next.depth);
    }
  }
  return out;
}

/**
 * A reply's indent: one step and one thread line per level, the same at
 * every level, with no rule by depth, so a reply to a reply reads as nested
 * under it and every ancestor's line runs beside it. One element draws all
 * of a card's levels (the lines are its background), so a chain of
 * thousands of replies, which a buggy tool can write, costs one wrapper per
 * card. A level is the 0.75rem margin, 2px line and 0.375rem gap of
 * `ml-3 border-l-2 border-border/40 pl-1.5`.
 */
const REPLY_STEP = 'calc(1.125rem + 2px)';
const REPLY_LINES = `repeating-linear-gradient(to right, transparent 0 0.75rem, color-mix(in oklab, var(--border) 40%, transparent) 0.75rem calc(0.75rem + 2px), transparent calc(0.75rem + 2px) ${REPLY_STEP})`;

const ReplyIndent: React.FC<{ depth: number; composer?: boolean; children: React.ReactNode }> = ({ depth, composer = false, children }) => {
  const indent = `calc(${depth} * ${REPLY_STEP})`;
  return (
    <div
      {...(composer ? { 'data-annotation-reply-composer': 'true' } : { 'data-annotation-reply': 'true' })}
      data-annotation-depth={depth}
      style={{ paddingLeft: indent, backgroundImage: REPLY_LINES, backgroundSize: `${indent} 100%`, backgroundRepeat: 'no-repeat' }}
    >
      {children}
    </div>
  );
};

/**
 * Where the reply box for `parentId` goes in a thread-ordered list: after
 * the parent's whole subtree, which is where the reply will land, one level
 * under the parent. Null when the parent is not in the list.
 */
function replyBoxIndex(
  entries: ReadonlyArray<{ kind?: string; annotation: { id: string }; depth: number }>,
  parentId: string,
): { index: number; depth: number } | null {
  const at = entries.findIndex((entry) => entry.kind !== 'code' && entry.annotation.id === parentId);
  if (at < 0) return null;
  let end = at + 1;
  while (end < entries.length && entries[end].depth > entries[at].depth) end++;
  return { index: end, depth: entries[at].depth + 1 };
}

interface DirectEditsPanelItem {
  id: string;
  title?: string;
  label?: string;
  added: number;
  removed: number;
  diffText: string;
  description?: string;
  onDiscard?: () => void;
}

interface PanelProps {
  /** The second line of the empty state. Default "Select text to annotate"; a host whose document is an image or code says how to comment there. */
  emptyHint?: string;
  isOpen: boolean;
  annotations: Annotation[];
  blocks: Block[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit?: (id: string, updates: Partial<Annotation>) => void;
  selectedId: string | null;
  codeAnnotations?: CodeAnnotation[];
  onSelectCodeAnnotation?: (id: string) => void;
  onDeleteCodeAnnotation?: (id: string) => void;
  onEditCodeAnnotation?: (id: string, updates: Partial<CodeAnnotation>) => void;
  sharingEnabled?: boolean;
  width?: number | string;
  editorAnnotations?: EditorAnnotation[];
  onDeleteEditorAnnotation?: (id: string) => void;
  onClose?: () => void;
  /** Navigate the document to a heading anchor, for `#Heading` references in comment text. */
  onNavigateAnchor?: (hash: string) => void;
  /** Copy the full feedback payload. May resolve a success boolean; resolving
    *  `false` suppresses the "Copied" flash. A void resolution (existing hosts)
    *  is treated as success, preserving the original behavior. */
  onQuickCopy?: () => Promise<void | boolean>;
  onShare?: () => void;
  otherFileAnnotations?: { count: number; files: number };
  onOtherFileAnnotationsClick?: () => void;
  /** Committed direct edits to one or more documents. Rendered as pinned cards
    *  above the annotation timeline with expandable unified diffs. */
  directEdits?: DirectEditsPanelItem[] | null;
  /** Host slot rendered at the foot of each plan-annotation card (e.g. reply/
    *  resolve UI). The panel stays presentation-only; clicks inside the slot
    *  do not select the card. Default: nothing rendered. */
  renderCardFooter?: (annotation: Annotation) => React.ReactNode;
  /** Host slot rendered inside the header row of each plan-annotation card,
    *  after `author · time` and before the built-in edit/delete actions — the
    *  place for a status stamp (resolved, needs reply, a reviewer badge). Twin
    *  of `renderCardFooter`: the panel stays presentation-only, clicks inside
    *  the slot do not select the card, and it renders under `readOnly` too
    *  (a stamp is a read affordance). Default: nothing rendered, and no
    *  wrapper element exists at all. */
  renderCardHeader?: (annotation: Annotation) => React.ReactNode;
  /** Opt-in: the person replies to a plan-annotation card. Supplied (and not
    *  `readOnly`), each card of the open document gets a Reply action that
    *  opens a box after the card's own replies, where the reply will appear;
    *  Reply (or the comment submit key) calls `onReply(parentId, { text,
    *  mentions })` and the host adds the reply (`buildReplyAnnotation` in
    *  `utils/annotationReply`). A host that could not save it answers
    *  `false` (or a promise of it): the box stays open with its words.
    *  `mentions` follows the edit box's rule: only
    *  with a `mentionSource` and a surviving pick. A card whose place is drawn
    *  by something other than a text highlight (a comment on part of an
    *  image, a checkbox toggle, a question's answer) takes no Reply: a reply
    *  would carry a text anchor its parent does not have. Absent: no action
    *  and no box. */
  onReply?: (parentId: string, reply: { text: string; mentions?: readonly string[] }) => void | boolean | Promise<void | boolean>;
  /** Opt-in: the person comments on a passage of a card's words (a
    *  sub-thread, as crit's). Supplied (and not `readOnly`), words selected
    *  inside one card's comment text, on the open document, offer the
    *  package's selection toolbar with the document's options there
    *  (`passageToolbar`; absent, comment-only); Comment, or a letter typed,
    *  opens the panel's one box (the Reply box, with the passage quoted at
    *  its head) where the comment will appear, after the card's own replies;
    *  saving calls `onCommentPassage(parentId, passage, { text, mentions })`.
    *  Delete and a quick label call it at once with their comment
    *  (`PassageComment`: a deletion, a label's words), as on the document.
    *  `passage.offset` is where the words start in the card's text as drawn,
    *  whitespace runs counted as one (`@plannotator/core/passage`). A save
    *  the host could not make answers `false`: the box stays. `cardParts`'
    *  `passage: false` takes the offer off a card. Absent: nothing changes,
    *  and a card's text carries no extra attribute. */
  onCommentPassage?: (
    parentId: string,
    passage: TextPassage,
    comment: PassageComment,
  ) => void | boolean | Promise<void | boolean>;
  /** Opt-in, with `onCommentPassage`: the options of the document's own
    *  selection toolbar (the host's viewer's), so a passage of a card's
    *  words offers the same actions; Delete and a quick label then call
    *  `onCommentPassage` at once. Absent: Comment only, as before. */
  passageToolbar?: PassageToolbarOptions;
  /** The passages to mark in a card's comment text (the host's open
    *  sub-threads on it, a deletion's struck through), found again by their
    *  words and offset. Absent: no marks. */
  cardPassages?: (annotation: Annotation) => readonly PassageMark[];
  /** Opt-in host capability: an `@` mention source for the EDIT box of each
    *  plan-annotation card, the same `MentionSource` `Viewer` and `HtmlViewer`
    *  take for their creation composers. Supplied → the edit textarea grows
    *  the `@` picker and a save that follows a pick carries the surviving ids
    *  as `Annotation.mentions`. Absent → the edit box is exactly what it was:
    *  no listener, no picker, no `mentions` key. */
  mentionSource?: MentionSource;
  /** Hide every built-in mutation affordance (delete/edit, direct-edit
    *  discard). The host footer slot still renders: its contents are
    *  host-owned and may be read affordances (replies, links), so the host
    *  gates what belongs in it. Selection and scrolling still work.
    *  Default false — today's behavior. */
  readOnly?: boolean;
  /** Embed only the timeline body in a host-owned stage. The host owns the
    *  title, close control, visible-viewport geometry, and focus boundary. */
  presentation?: 'panel' | 'embedded';
  /** Ids of annotations with no live location in the document (e.g. the
    *  HTML viewer's onUnanchoredChange report after a refresh). Matching
    *  cards show a small "Unanchored" chip. Absent: no chip, DOM unchanged. */
  unanchoredIds?: ReadonlySet<string>;
  /**
   * Multi-document sessions (annotate folder sessions, and any session whose
   * linked documents carry feedback): which documents the timeline shows.
   * Supplying this together with `onAnnotationScopeChange` turns on the
   * `This file | All files` toggle and the grouped cross-file view. Omitting
   * them — as every host that has not opted in does — leaves the panel exactly
   * as it was, including the legacy `+N in M other files` affordance.
   */
  annotationScope?: AnnotationScope;
  onAnnotationScopeChange?: (scope: AnnotationScope) => void;
  /** One group per document carrying feedback, open document first (see
   *  `groupAnnotationsByDocument`). Only read while the scope is `all`. */
  documentGroups?: readonly AnnotationDocumentGroup[];
  /** Select/jump to an annotation by its owning document. A card in another
   *  document is the host's cue to navigate there first. */
  onSelectInDocument?: (path: string, id: string) => void;
  /** Delete an annotation from its owning document's store. */
  onDeleteInDocument?: (path: string, id: string) => void;
  /** Edit an annotation in its owning document's store. */
  onEditInDocument?: (path: string, id: string, updates: Partial<Annotation>) => void;
  /**
   * `:::question` rows for the open document (`buildQuestionPanelRows`).
   * Supplied, a Questions section renders above a Comments section and the
   * answer annotations (rows carrying `questionAnswer`) leave the comment
   * timeline; a row whose question is gone offers Remove through `onDelete`.
   * Absent, the panel is unchanged and answers list as comment cards.
   */
  questionRows?: readonly QuestionPanelRow[];
  /** A Questions row was clicked (the host scrolls to the card). */
  onSelectQuestion?: (row: QuestionPanelRow) => void;
  /**
   * The order of the comment timeline (and of each document group), for a
   * host whose comments have an order of their own (the Inbox's video
   * comments, by the moment they are at). Ties keep creation order. Absent:
   * creation order, exactly as before.
   */
  compareAnnotations?: (a: Annotation, b: Annotation) => number;
  /**
   * The panel's title (default "Annotations") and a quiet note at the right
   * of its header (the Inbox's "By time" for a video's comments). Absent:
   * the header is exactly as before.
   */
  title?: string;
  titleNote?: string;
  /**
   * Which built-in parts a plan-annotation card draws: its quoted text
   * (`quote`) and its attached images under the comment (`images`). A host
   * that draws them itself (the Inbox's video comments show the moment and
   * the frame in `renderCardHeader`) turns them off per card. `actions:
   * false` draws the card without its edit and delete buttons, as `readOnly`
   * does for every card (the Inbox's comments already sent); its Reply
   * (`onReply`) stays, and `reply: false` takes that off (a draft nobody can
   * answer yet). Absent: all drawn, exactly as before.
   */
  cardParts?: (annotation: Annotation) => { quote?: boolean; images?: boolean; text?: boolean; actions?: boolean; reply?: boolean; passage?: boolean };
  /**
   * Optional: the host's own body for a plan-annotation card, drawn where the
   * comment text goes, inside the card (a click on it selects the card). The
   * Inbox draws a drawing that has no words as its picture, with `cardParts`
   * `text: false` (its stored text is a stand-in for the agent, not the
   * person's words: not drawn, and the edit box starts empty). Absent:
   * nothing extra, exactly as before.
   */
  renderCardBody?: (annotation: Annotation) => React.ReactNode;
  /**
   * Comments on part of an image (`imageRegion`, #2100) draw a crop of their
   * box in place of the quote; this turns an image's src as written into a
   * URL the browser can load (null: no crop, the file and size still show).
   * Absent: no crop.
   */
  imageRegionSrc?: (src: string) => string | null;
}

export const AnnotationPanel: React.FC<PanelProps> = ({
  emptyHint = 'Select text to annotate',
  isOpen,
  annotations,
  blocks,
  onSelect,
  onDelete,
  onEdit,
  selectedId,
  codeAnnotations = [],
  onSelectCodeAnnotation,
  onDeleteCodeAnnotation,
  onEditCodeAnnotation,
  sharingEnabled = true,
  width,
  editorAnnotations,
  onDeleteEditorAnnotation,
  onClose,
  onQuickCopy,
  onShare,
  otherFileAnnotations,
  onOtherFileAnnotationsClick,
  directEdits = null,
  renderCardFooter,
  renderCardHeader,
  onReply,
  onCommentPassage,
  passageToolbar,
  cardPassages,
  mentionSource,
  readOnly = false,
  presentation = 'panel',
  unanchoredIds,
  annotationScope,
  onAnnotationScopeChange,
  documentGroups,
  onSelectInDocument,
  onDeleteInDocument,
  onEditInDocument,
  questionRows,
  onSelectQuestion,
  compareAnnotations,
  title = 'Annotations',
  titleNote,
  cardParts,
  renderCardBody,
  imageRegionSrc,
  onNavigateAnchor,
}) => {
  // `#Heading` links in comment text; nothing is parsed unless the host can navigate.
  const sectionRefs = useMemo(
    () => (onNavigateAnchor ? buildSectionRefIndex(blocks) : undefined),
    [blocks, onNavigateAnchor],
  );
  const regionCards = useMemo(
    () => ({ numbers: imageRegionNumbers(annotations), thumbSrc: imageRegionSrc }),
    [annotations, imageRegionSrc],
  );
  const isMobile = useIsMobile();
  const embedded = presentation === 'embedded';
  const mobilePanel = isMobile && !embedded;
  const [copiedText, setCopiedText] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // The reply being written: the card it answers and its words. One box at a
  // time; Reply on another card moves the box and keeps the words. `opened`
  // counts the Reply presses, so each one puts the caret back in the box.
  // With `passage`, the box comments on that passage of the card's words.
  const [replyDraft, setReplyDraft] = useState<{ parentId: string; text: string; opened: number; passage?: TextPassage } | null>(null);
  const canReply = onReply !== undefined && !readOnly;
  const canCommentPassage = onCommentPassage !== undefined && !readOnly;
  // Words selected in a card's text, let go anywhere (a drag past a card's last line ends outside the list): the
  // toolbar that offers to comment on them, the one way a passage of a message is offered (./PassageToolbar).
  const { offer: passageOffer, close: closePassageOffer } = usePassageOffer(canCommentPassage && isOpen, () =>
    listRef.current ? selectedPassage(listRef.current) : null,
  );
  // The card the box answers is gone (deleted here, removed by an agent):
  // its words go with it, as its box did.
  const replyParentGone = replyDraft !== null && !annotations.some((a) => a.id === replyDraft.parentId);
  useEffect(() => {
    if (replyParentGone) setReplyDraft(null);
  }, [replyParentGone]);
  // With a Questions section, answers are listed there, not as comments.
  const showQuestions = questionRows !== undefined && questionRows.length > 0;
  const timelineAnnotations = questionRows !== undefined
    ? annotations.filter((a) => a.questionAnswer == null)
    : annotations;
  const byCreation = (a: Annotation, b: Annotation) => a.createdA - b.createdA;
  const byHost = compareAnnotations ? (a: Annotation, b: Annotation) => compareAnnotations(a, b) || byCreation(a, b) : byCreation;
  const sortedAnnotations = [...timelineAnnotations].sort(byHost);
  const sortedCodeAnnotations = [...codeAnnotations].sort((a, b) => a.createdAt - b.createdAt);
  // Replies (`inReplyTo`) thread under their parent, depth first: a thread
  // (a root and every reply under it) stays together, in thread order, at
  // the root's place on the timeline. With no replies the order is untouched.
  const threadedAnnotations = threadReplies(sortedAnnotations);
  // The timeline places whole threads and code comments by when each
  // started. Sorting threads as units keeps a reply to a reply under it
  // (sorting cards by their own time hung it under a later sibling) and
  // stays linear in the thread length.
  const timelineUnits: Array<{ ts: number; entries: TimelineEntry[] }> = [];
  for (const item of threadedAnnotations) {
    if (item.depth === 0) timelineUnits.push({ ts: item.annotation.createdA, entries: [] });
    timelineUnits[timelineUnits.length - 1].entries.push({ kind: 'plan', ...item });
  }
  for (const annotation of sortedCodeAnnotations) {
    timelineUnits.push({ ts: annotation.createdAt, entries: [{ kind: 'code', annotation, depth: 0 }] });
  }
  // A host order keeps the plan comments as the host sorted them (code comments after).
  if (!compareAnnotations) timelineUnits.sort((a, b) => a.ts - b.ts);
  const timelineEntries = timelineUnits.flatMap((unit) => unit.entries);
  const totalCount = annotations.length + codeAnnotations.length + (editorAnnotations?.length ?? 0);
  const timelineCount = timelineAnnotations.length + codeAnnotations.length + (editorAnnotations?.length ?? 0);

  // --- Cross-file scope (opt-in: a host that passes neither prop is unchanged) ---
  const scopeEnabled = annotationScope !== undefined && onAnnotationScopeChange !== undefined;
  const scope: AnnotationScope = scopeEnabled ? annotationScope! : 'current';
  const groups = documentGroups ?? [];
  const otherGroups = groups.filter((group) => !group.isCurrent);
  const otherGroupCount = otherGroups.reduce((n, group) => n + group.annotations.length, 0);
  const groupedTotal = groups.reduce((n, group) => n + group.annotations.length, 0);
  const showGroups = scope === 'all' && groups.length > 0;
  const headerCount = showGroups
    ? groupedTotal + codeAnnotations.length + (editorAnnotations?.length ?? 0)
    : totalCount;
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (path: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const scopeToggle = scopeEnabled ? (
    <div
      data-annotation-scope-toggle="true"
      role="group"
      aria-label="Annotation scope"
      className="flex items-center gap-0.5 rounded-md bg-surface-1/60 p-0.5"
    >
      {(['current', 'all'] as const).map((value) => (
        <button
          key={value}
          type="button"
          data-pn-touch-target="true"
          data-annotation-scope={value}
          aria-pressed={scope === value}
          onClick={() => onAnnotationScopeChange!(value)}
          className={cn(
            'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
            scope === value
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {value === 'current' ? 'This file' : 'All files'}
        </button>
      ))}
    </div>
  ) : null;

  // Scroll selected annotation card into view
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const card = listRef.current.querySelector(`[data-annotation-id="${selectedId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedId]);

  if (!isOpen) return null;

  const startReply = (parentId: string) => setReplyDraft((draft) => ({ parentId, text: draft?.text ?? '', opened: (draft?.opened ?? 0) + 1 }));
  // The toolbar closed the offer and let the selection go (the words are quoted in the box now).
  const commentOnPassage = (passage: SelectedPassage, initialChar?: string) => {
    setReplyDraft((draft) => ({
      parentId: passage.parentId,
      text: `${draft?.text ?? ''}${initialChar ?? ''}`,
      opened: (draft?.opened ?? 0) + 1,
      passage: { quote: passage.quote, offset: passage.offset },
    }));
  };
  // A card in a thread: a root as is, a reply inside its indent.
  const inThread = (entry: ThreadedAnnotation, card: React.ReactElement) => (
    entry.depth === 0
      ? <React.Fragment key={entry.annotation.id}>{card}</React.Fragment>
      : <ReplyIndent key={entry.annotation.id} depth={entry.depth}>{card}</ReplyIndent>
  );
  // A reply whose quote is its parent's does not draw it again: the parent
  // above it shows it.
  const threadParts = (entry: ThreadedAnnotation, parts: ReturnType<NonNullable<typeof cardParts>> | undefined) => (
    entry.parent && entry.annotation.originalText === entry.parent.originalText ? { ...parts, quote: false } : parts
  );
  // The reply box, spliced into a thread-ordered list after the parent's
  // subtree, at the depth the reply will have.
  const withReplyBox = (entries: ReadonlyArray<TimelineEntry | ThreadedAnnotation>, nodes: React.ReactNode[]): React.ReactNode[] => {
    if (!replyDraft || !(replyDraft.passage ? canCommentPassage : canReply)) return nodes;
    const at = replyBoxIndex(entries, replyDraft.parentId);
    if (!at) return nodes;
    const passage = replyDraft.passage;
    const box = (
      <ReplyIndent key={`reply-box-${replyDraft.opened}`} depth={at.depth} composer>
        <div className="rounded-lg bg-surface-1 px-3 py-2.5 ring-1 ring-border/50" data-annotation-passage-composer={passage ? 'true' : undefined}>
          {passage && (
            <p className="mb-1.5 line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-muted-foreground/80">
              "{passage.quote}"
            </p>
          )}
          <AnnotationEditComposer
            value={replyDraft.text}
            onChange={(text) => setReplyDraft((draft) => (draft ? { ...draft, text } : draft))}
            onSave={(mentions) => {
              const text = replyDraft.text.trim();
              if (!text) return;
              // The box closes once sent; a host that answers false (its save failed) keeps it, words and all.
              const opened = replyDraft.opened;
              const close = (sent: void | boolean) => {
                if (sent !== false) setReplyDraft((draft) => (draft?.opened === opened ? null : draft));
              };
              const comment = mentionSource && mentions.length > 0 ? { text, mentions } : { text };
              const sent = passage ? onCommentPassage!(replyDraft.parentId, passage, comment) : onReply!(replyDraft.parentId, comment);
              if (sent instanceof Promise) void sent.then(close, () => {});
              else close(sent);
            }}
            onCancel={() => setReplyDraft(null)}
            mentionSource={mentionSource}
            placeholder={passage ? 'Comment on this passage...' : 'Reply...'}
            label={passage ? 'Comment on passage' : 'Reply'}
            submitLabel={passage ? 'Comment' : 'Reply'}
            selectOnOpen={false}
          />
        </div>
      </ReplyIndent>
    );
    return [...nodes.slice(0, at.index), box, ...nodes.slice(at.index)];
  };

  const panel = (
    <aside
      data-annotation-panel="true"
      data-plan-sidebar="right"
      className={`bg-card flex flex-col ${embedded ? 'h-full min-h-0 w-full flex-1' : 'flex-shrink-0 border-l border-border/50'} ${
        mobilePanel ? 'fixed top-12 bottom-0 right-0 z-[60] w-full max-w-sm shadow-2xl bg-card' : ''
      }`}
      style={embedded || mobilePanel ? undefined : { width: width ?? 288 }}
    >
      {/* Header */}
      {!embedded && (
        <div className="border-b border-border/50">
          <div className="flex h-10 items-center justify-between px-3">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-medium text-foreground">
                {title}
              </h2>
              {headerCount > 0 && (
                <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[10px] font-medium tabular-nums text-primary">
                  {headerCount}
                </span>
              )}
            </div>
            {titleNote && <span data-annotation-panel-note="" className="ml-auto mr-1 text-[11px] text-muted-foreground">{titleNote}</span>}
            {mobilePanel && onClose && (
              <HostTitle title="Close panel">
                <button
                  onClick={onClose}
                  className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground md:hidden"
                  aria-label="Close panel"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </HostTitle>
            )}
          </div>
          {scopeEnabled ? (
            <div className="flex items-center justify-between gap-2 px-3 pb-2">
              {scopeToggle}
              {otherGroupCount > 0 && scope === 'current' && (
                <span className="truncate text-[10px] text-muted-foreground/70">
                  +{otherGroupCount} elsewhere
                </span>
              )}
            </div>
          ) : (
            otherFileAnnotations && otherFileAnnotations.count > 0 && (
              <HostTitle title="Show annotated files in sidebar">
                <button
                  onClick={onOtherFileAnnotationsClick}
                  className="px-3 pb-2 text-[10px] text-primary/70 hover:text-primary transition-colors cursor-pointer"
                >
                  +{otherFileAnnotations.count} in {otherFileAnnotations.files} other file{otherFileAnnotations.files === 1 ? '' : 's'}
                </button>
              </HostTitle>
            )
          )}
        </div>
      )}

      {embedded && scopeEnabled && (
        <div className="flex min-h-11 flex-shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3">
          {scopeToggle}
          {otherGroupCount > 0 && scope === 'current' && (
            <span className="truncate text-[10px] text-muted-foreground/70">+{otherGroupCount} elsewhere</span>
          )}
        </div>
      )}

      {embedded && !scopeEnabled && otherFileAnnotations && otherFileAnnotations.count > 0 && (
        <HostTitle title="Show annotated files in navigator">
          <button
            type="button"
            data-pn-touch-target="true"
            onClick={onOtherFileAnnotationsClick}
            className="min-h-11 flex-shrink-0 border-b border-border/50 px-3 text-left text-xs text-primary/80 active:bg-muted"
          >
            {otherFileAnnotations.count} more in {otherFileAnnotations.files} other file{otherFileAnnotations.files === 1 ? '' : 's'}
          </button>
        </HostTitle>
      )}

      {/* List */}
      <OverlayScrollArea className="flex-1 min-h-0">
        <div ref={listRef} className="p-2 flex flex-col gap-1.5">
        {directEdits?.map((item) => (
          <DirectEditsCard key={item.id} {...item} onDiscard={readOnly ? undefined : item.onDiscard} />
        ))}
        {showQuestions && (
          <>
            <QuestionsPanelSection
              rows={questionRows!}
              onSelect={onSelectQuestion}
              onRemoveOrphan={readOnly ? undefined : (row) => { if (row.annotationId) onDelete(row.annotationId); }}
            />
            <div className="mx-0.5 mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
              <span className="flex-1">Comments</span>
              <span className="tabular-nums">{showGroups ? groupedTotal : timelineCount}</span>
            </div>
          </>
        )}
        {showGroups ? (
          <>
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.path);
              // The open document's answers are in the Questions section.
              const groupAnnotations = group.isCurrent && questionRows !== undefined
                ? group.annotations.filter((a) => a.questionAnswer == null)
                : group.annotations;
              const sorted = [...groupAnnotations].sort(byHost);
              const threaded = threadReplies(sorted);
              return (
                <section key={group.path} data-annotation-group={group.path}>
                  <button
                    type="button"
                    data-pn-touch-target="true"
                    onClick={() => toggleGroup(group.path)}
                    aria-expanded={!collapsed}
                    className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-1/50"
                  >
                    <svg
                      className={cn('h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/60 transition-transform', collapsed ? '' : 'rotate-90')}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    {/* The pathless root document (plan review) is keyed by a
                        sentinel, which is not something to show a reader. */}
                    <HostTitle title={group.path === ROOT_DOCUMENT_GROUP_KEY ? group.label : group.path}>
                      <span className={cn('min-w-0 flex-1 truncate font-mono text-[10px]', group.isCurrent ? 'text-foreground' : 'text-muted-foreground')}>
                        {group.label}
                      </span>
                    </HostTitle>
                    {group.isCurrent && (
                      <span className="flex-shrink-0 text-[9px] text-muted-foreground/50">open</span>
                    )}
                    <span className="flex h-[16px] min-w-[16px] flex-shrink-0 items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[9px] font-medium tabular-nums text-primary">
                      {group.annotations.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <div className="mt-0.5 flex flex-col gap-1.5">
                      {withReplyBox(group.isCurrent ? threaded : [], threaded.map((entry) => {
                        const { annotation } = entry;
                        return inThread(entry, (
                          <AnnotationCard
                            annotation={annotation}
                            isSelected={selectedId === annotation.id}
                            isMe={isCurrentUser(annotation.author)}
                            onSelect={() => (group.isCurrent
                              ? onSelect(annotation.id)
                              : onSelectInDocument?.(group.path, annotation.id))}
                            onDelete={() => (group.isCurrent
                              ? onDelete(annotation.id)
                              : onDeleteInDocument?.(group.path, annotation.id))}
                            onEdit={group.isCurrent
                              ? (onEdit ? (updates: Partial<Annotation>) => onEdit(annotation.id, updates) : undefined)
                              : (onEditInDocument ? (updates: Partial<Annotation>) => onEditInDocument(group.path, annotation.id, updates) : undefined)}
                            onReply={group.isCurrent && canReply ? () => startReply(annotation.id) : undefined}
                            passageBody={group.isCurrent && canCommentPassage}
                            passages={group.isCurrent ? cardPassages?.(annotation) : undefined}
                            readOnly={readOnly}
                            footer={group.isCurrent ? renderCardFooter?.(annotation) : undefined}
                            header={group.isCurrent ? renderCardHeader?.(annotation) : undefined}
                            parts={threadParts(entry, group.isCurrent ? cardParts?.(annotation) : undefined)}
                            body={group.isCurrent ? renderCardBody?.(annotation) : undefined}
                            mentionSource={mentionSource}
                            unanchored={group.isCurrent ? (unanchoredIds?.has(annotation.id) ?? false) : false}
                            sectionRefs={group.isCurrent ? sectionRefs : undefined}
                            onNavigateAnchor={onNavigateAnchor}
                          />
                        ));
                      }))}
                    </div>
                  )}
                </section>
              );
            })}
            {sortedCodeAnnotations.length > 0 && (
              <>
                <div className="flex items-center gap-2 pt-2 pb-1">
                  <div className="flex-1 border-t border-border/30" />
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">Code</span>
                  <div className="flex-1 border-t border-border/30" />
                </div>
                {sortedCodeAnnotations.map((annotation) => (
                  <CodeAnnotationCard
                    key={annotation.id}
                    annotation={annotation}
                    isSelected={selectedId === annotation.id}
                    isMe={isCurrentUser(annotation.author)}
                    onSelect={() => onSelectCodeAnnotation?.(annotation.id)}
                    onDelete={() => onDeleteCodeAnnotation?.(annotation.id)}
                    onEdit={onEditCodeAnnotation ? (updates: Partial<CodeAnnotation>) => onEditCodeAnnotation(annotation.id, updates) : undefined}
                    readOnly={readOnly}
                  />
                ))}
              </>
            )}
            {editorAnnotations && editorAnnotations.length > 0 && (
              <>
                <div className="flex items-center gap-2 pt-2 pb-1">
                  <div className="flex-1 border-t border-border/30" />
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">Editor</span>
                  <div className="flex-1 border-t border-border/30" />
                </div>
                {editorAnnotations.map(ann => (
                  <EditorAnnotationCard
                    key={ann.id}
                    annotation={ann}
                    onDelete={readOnly ? undefined : () => onDeleteEditorAnnotation?.(ann.id)}
                  />
                ))}
              </>
            )}
            {otherGroups.length > 0 && onOtherFileAnnotationsClick && (
              <HostTitle title="Show annotated files in the navigator">
                <button
                  type="button"
                  data-pn-touch-target="true"
                  data-annotation-show-in-files="true"
                  onClick={onOtherFileAnnotationsClick}
                  className="mt-1 cursor-pointer self-start px-1.5 text-[10px] text-muted-foreground/60 transition-colors hover:text-primary"
                >
                  Show in files
                </button>
              </HostTitle>
            )}
          </>
        ) : timelineCount === 0 && showQuestions ? (
          <p className="px-1 py-2.5 text-[12.5px] text-muted-foreground">
            Select text in the document to comment. Question and option text is selectable too.
          </p>
        ) : timelineCount === 0 ? (
          (!directEdits || directEdits.length === 0) && (
            <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
              <p className="text-xs text-muted-foreground/60">
                No annotations yet
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/40">
                {emptyHint}
              </p>
              {scopeEnabled && otherGroupCount > 0 && (
                <button
                  type="button"
                  data-pn-touch-target="true"
                  data-annotation-view-all="true"
                  onClick={() => onAnnotationScopeChange!('all')}
                  className="mt-3 cursor-pointer rounded-md px-2 py-1 text-[11px] text-primary/80 transition-colors hover:bg-surface-1 hover:text-primary"
                >
                  View all {otherGroupCount} in {otherGroups.length} other file{otherGroups.length === 1 ? '' : 's'}
                </button>
              )}
            </div>
          )
        ) : (
          <>
            {withReplyBox(timelineEntries, timelineEntries.map(entry => (
              entry.kind === 'plan' ? inThread(entry, (
                <AnnotationCard
                  annotation={entry.annotation}
                  sectionRefs={sectionRefs}
                  onNavigateAnchor={onNavigateAnchor}
                  isSelected={selectedId === entry.annotation.id}
                  isMe={isCurrentUser(entry.annotation.author)}
                  onSelect={() => onSelect(entry.annotation.id)}
                  onDelete={() => onDelete(entry.annotation.id)}
                  onEdit={onEdit ? (updates: Partial<Annotation>) => onEdit(entry.annotation.id, updates) : undefined}
                  onReply={canReply ? () => startReply(entry.annotation.id) : undefined}
                  passageBody={canCommentPassage}
                  passages={cardPassages?.(entry.annotation)}
                  readOnly={readOnly}
                  footer={renderCardFooter?.(entry.annotation)}
                  header={renderCardHeader?.(entry.annotation)}
                  parts={threadParts(entry, cardParts?.(entry.annotation))}
                  body={renderCardBody?.(entry.annotation)}
                  mentionSource={mentionSource}
                  unanchored={unanchoredIds?.has(entry.annotation.id) ?? false}
                />
              )) : (
                <CodeAnnotationCard
                  key={entry.annotation.id}
                  annotation={entry.annotation}
                  isSelected={selectedId === entry.annotation.id}
                  isMe={isCurrentUser(entry.annotation.author)}
                  onSelect={() => onSelectCodeAnnotation?.(entry.annotation.id)}
                  onDelete={() => onDeleteCodeAnnotation?.(entry.annotation.id)}
                  onEdit={onEditCodeAnnotation ? (updates: Partial<CodeAnnotation>) => onEditCodeAnnotation(entry.annotation.id, updates) : undefined}
                  readOnly={readOnly}
                />
              )
            )))}
            {editorAnnotations && editorAnnotations.length > 0 && (
              <>
                {timelineEntries.length > 0 && (
                  <div className="flex items-center gap-2 pt-2 pb-1">
                    <div className="flex-1 border-t border-border/30" />
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">Editor</span>
                    <div className="flex-1 border-t border-border/30" />
                  </div>
                )}
                {editorAnnotations.map(ann => (
                  <EditorAnnotationCard
                    key={ann.id}
                    annotation={ann}
                    onDelete={readOnly ? undefined : () => onDeleteEditorAnnotation?.(ann.id)}
                  />
                ))}
              </>
            )}

          </>
        )}
        </div>
      </OverlayScrollArea>
      {passageOffer && canCommentPassage && (
        <PassageToolbar
          passage={passageOffer}
          options={passageToolbar}
          onComment={commentOnPassage}
          // Delete or a label: made at once, as on the document's words.
          onPreset={passageToolbar ? (passage, comment) => void onCommentPassage!(passage.parentId, { quote: passage.quote, offset: passage.offset }, comment) : undefined}
          onClose={closePassageOffer}
        />
      )}

      {/* Quick Actions Footer */}
      {headerCount > 0 && (onQuickCopy || (sharingEnabled && onShare)) && (
        <div className="border-t border-border/50 px-3 py-2 flex gap-1.5">
          {onQuickCopy && (
            <button
              onClick={async () => {
                const result = await onQuickCopy();
                if (result === false) return;
                setCopiedText(true);
                setTimeout(() => setCopiedText(false), 2000);
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors ${
                copiedText ? 'text-green-500' : 'text-muted-foreground hover:bg-surface-1 hover:text-foreground'
              }`}
            >
              {copiedText ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          )}
          {sharingEnabled && onShare && (
            <button
              onClick={onShare}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors text-muted-foreground hover:bg-surface-1 hover:text-foreground"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              Share
            </button>
          )}
        </div>
      )}
    </aside>
  );

  if (mobilePanel) {
    return (
      <>
        <div
          className="fixed inset-0 z-[59] bg-background/60 backdrop-blur-sm"
          onClick={onClose}
        />
        <RegionCardContext.Provider value={regionCards}>{panel}</RegionCardContext.Provider>
      </>
    );
  }

  return <RegionCardContext.Provider value={regionCards}>{panel}</RegionCardContext.Provider>;
};

function formatTimestamp(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  // An older date names its year: "Oct 20" alone reads as this October.
  const date = new Date(ts);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(
    undefined,
    thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

/**
 * A card's "author · time" line. The author truncates (its full name in the
 * title) while the time never shrinks, so a long name cannot push the time
 * out; `<bdi>` keeps a right-to-left name from reordering the time around it.
 * The text reads exactly as before: "Alice (me) · 5m".
 */
const CardByline: React.FC<{ author?: string; isMe: boolean; timestamp: number }> = ({ author, isMe, timestamp }) => (
  <span data-annotation-byline="true" className="flex min-w-0 items-center text-[10px] text-muted-foreground/50">
    {author ? (
      <>
        <HostTitle title={author} cut>
          <span data-annotation-author="true" className="min-w-0 truncate">
            <bdi>{author}</bdi>
          </span>
        </HostTitle>
        {isMe ? <span data-annotation-me="true" className="shrink-0 whitespace-pre"> (me)</span> : null}
        <span className="shrink-0 whitespace-pre"> · </span>
      </>
    ) : null}
    <span data-annotation-time="true" className="shrink-0">{formatTimestamp(timestamp)}</span>
  </span>
);

/** Pinned card for committed direct edits: +N/−M summary, expandable unified
 *  diff, and a two-step discard. Not part of the annotation timeline — edits
 *  are document state, not a selection-anchored note. */
const DirectEditsCard: React.FC<{
  title?: string;
  label?: string;
  added: number;
  removed: number;
  diffText: string;
  description?: string;
  onDiscard?: () => void;
}> = ({ title = 'Edits', label, added, removed, diffText, description, onDiscard }) => {
  const [expanded, setExpanded] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Auto-cancel the discard confirmation after a beat.
  useEffect(() => {
    if (!confirmDiscard) return;
    const t = setTimeout(() => setConfirmDiscard(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDiscard]);

  // Show from the first hunk header; the ---/+++ preamble is noise here.
  const diffLines = React.useMemo(() => {
    const lines = diffText.split('\n');
    const fileSeparators = lines.filter((l) => l.startsWith('===')).length;
    if (fileSeparators > 1) return lines;
    const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
    return firstHunk === -1 ? lines : lines.slice(firstHunk);
  }, [diffText]);

  return (
    <div className="w-full rounded-lg px-3 py-2.5 bg-surface-1/40 ring-1 ring-border/40">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-primary">{title}</span>
        {label && (
          <HostTitle title={label} cut>
            <span className="min-w-0 truncate text-[10px] text-muted-foreground">{label}</span>
          </HostTitle>
        )}
        <span className="font-mono text-[10px] tabular-nums">
          <span className="text-success">+{added}</span>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-destructive">-{removed}</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-surface-1 hover:text-foreground"
            aria-expanded={expanded}
          >
            {expanded ? 'Hide diff' : 'Diff'}
          </button>
          {onDiscard && (
            <button
              type="button"
              onClick={() => {
                if (confirmDiscard) {
                  setConfirmDiscard(false);
                  onDiscard();
                } else {
                  setConfirmDiscard(true);
                }
              }}
              className={cn(
                'cursor-pointer rounded px-1.5 py-0.5 text-[10px] transition-colors',
                confirmDiscard
                  ? 'bg-destructive/15 text-destructive hover:bg-destructive/25'
                  : 'text-muted-foreground hover:bg-surface-1 hover:text-destructive',
              )}
            >
              {confirmDiscard ? 'Confirm?' : 'Discard'}
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-[10px] leading-snug text-muted-foreground/60">
        {description ?? 'Your text changes — sent with the feedback as a diff.'}
      </p>
      {expanded && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
          {diffLines.map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith('+') ? 'text-success'
                : line.startsWith('-') ? 'text-destructive'
                : line.startsWith('@@') ? 'text-primary/70'
                : 'text-muted-foreground'
              }
            >
              {line.length === 0 ? ' ' : line}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
};

/** Comment text, with each `#Heading text` as a link that scrolls to that heading. */
const AnnotationText: React.FC<{
  text: string;
  className: string;
  sectionRefs?: Map<string, string>;
  onNavigateAnchor?: (hash: string) => void;
  /** The card whose words a passage can be selected in (`onCommentPassage`): marks the element as that card's body. */
  passageBodyOf?: string;
  /** Passages to mark in the words (`cardPassages`). */
  passages?: readonly PassageMark[];
}> = ({ text, className, sectionRefs, onNavigateAnchor, passageBodyOf, passages }) => {
  const parts = React.useMemo(
    () => (sectionRefs && onNavigateAnchor ? parseSectionRefs(text, sectionRefs) : [text]),
    [text, sectionRefs, onNavigateAnchor],
  );
  // The passages' places in the words as drawn (a link draws its label).
  const drawn = React.useMemo(() => parts.map((part) => (typeof part === 'string' ? part : part.label)), [parts]);
  const ranges = React.useMemo(() => (passages && passages.length > 0 ? passageRanges(drawn.join(''), passages) : []), [drawn, passages]);
  let base = 0;

  return (
    <p className={className} {...(passageBodyOf !== undefined ? { [PASSAGE_BODY_ATTRIBUTE]: passageBodyOf } : {})}>
      {parts.map((part, i) => {
        const start = base;
        base += drawn[i]!.length;
        if (typeof part === 'string') {
          if (ranges.length === 0) return part;
          return splitByRanges(part, start, ranges).map((piece, j) =>
            piece.marked ? (
              <mark
                key={`${i}-${j}`}
                data-passage-mark="true"
                data-passage-deletion={piece.deletion ? 'true' : undefined}
                className={piece.deletion ? 'rounded-[2px] bg-destructive/20 text-inherit line-through decoration-destructive' : 'rounded-[2px] bg-annotation-comment/20 text-inherit'}
              >
                {piece.text}
              </mark>
            ) : (
              <React.Fragment key={`${i}-${j}`}>{piece.text}</React.Fragment>
            ),
          );
        }
        return (
          <a
            key={i}
            href={`#${part.anchor}`}
            className="rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={(e) => {
              // The host scrolls; the card's own onSelect would scroll to the
              // annotation instead, and the URL hash stays as it was.
              e.preventDefault();
              e.stopPropagation();
              onNavigateAnchor!(`#${part.anchor}`);
            }}
          >
            {part.label}
          </a>
        );
      })}
    </p>
  );
};

/**
 * The plan-annotation card's edit box, and the panel's reply box (the same
 * box with its own placeholder, name and button, and the caret at the end of
 * the words instead of the words selected).
 *
 * Mounted only while a card is in edit mode, which is also what scopes an
 * `@` pick to ONE edit session: `useMentionAutocomplete`'s tagged-people
 * state lives and dies with this component, so reopening the editor starts
 * with nobody picked and a pick-less save is `{ text }` again.
 *
 * Without a `mentionSource` every mention path here is inert — no listener,
 * no menu state, no picker DOM, and the textarea's attributes are exactly
 * the ones it rendered before the prop existed (all five mention-related
 * ARIA attributes resolve to `undefined`).
 *
 * KNOWN DIFFERENCE from `CommentPopover`: no chip overlay. The token stays
 * plain text here. Chips live in `ComposerTextarea` (mirrored overlay behind
 * a transparent-text textarea) and duplicating that layer is not the way to
 * get them — the follow-up is to make this box use `ComposerTextarea`.
 */
const AnnotationEditComposer: React.FC<{
  value: string;
  onChange: (text: string) => void;
  /** Save with the mention ids the body still tags (empty without a source). */
  onSave: (mentions: readonly string[]) => void;
  onCancel: () => void;
  mentionSource?: MentionSource;
  placeholder?: string;
  /** The field's accessible name. */
  label?: string;
  submitLabel?: string;
  /** Select the text on open (an edit replaces it); otherwise the caret goes to its end. */
  selectOnOpen?: boolean;
}> = ({
  value,
  onChange,
  onSave,
  onCancel,
  mentionSource,
  placeholder = 'Add your comment...',
  label = 'Annotation comment',
  submitLabel = 'Save',
  selectOnOpen = true,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionAutocomplete({ text: value, setText: onChange, textareaRef, source: mentionSource });
  const listboxId = `annotation-card-mentions-${useId().replace(/:/g, '')}`;
  const menuOpen = mention.menu !== null;
  const enterSavesComment = useConfigValue('enterSavesComment');

  // Focus-on-open: this component mounts exactly when editing (or a reply) starts.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    if (selectOnOpen) textarea.select();
    else textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The menu is offered the key FIRST: while it is open Escape closes it
    // (and only a second Escape cancels the edit), and an arrowed-to row
    // takes Enter. Mod+Enter is never consumed by the menu.
    if (mention.onKeyDown(e)) return;
    if (isCommentSubmitKey(e, enterSavesComment)) {
      e.preventDefault();
      onSave(mention.mentionIds);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      <textarea
        data-pn-mobile-editable="true"
        ref={textareaRef}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => { onChange(e.target.value); mention.onSelect(); }}
        onSelect={mention.onSelect}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={label}
        aria-autocomplete={mentionSource ? 'list' : undefined}
        aria-haspopup={mentionSource ? 'listbox' : undefined}
        aria-controls={menuOpen ? listboxId : undefined}
        aria-owns={menuOpen ? listboxId : undefined}
        aria-activedescendant={mentionActiveOptionId(listboxId, mention.menu)}
        className="w-full resize-none rounded-lg border border-border/50 bg-card px-2.5 py-2 text-base leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
        style={{ fieldSizing: 'content', minHeight: 44 } as React.CSSProperties}
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <Button variant="ghost" size="xxs" onClick={onCancel}>Cancel</Button>
        <Button size="xxs" disabled={!value.trim()} onClick={() => onSave(mention.mentionIds)}>{submitLabel}</Button>
      </div>
      <MentionAutocompleteMenu id={listboxId} menu={mention.menu} onSelect={mention.select} />
    </div>
  );
};

const AnnotationCard: React.FC<{
  annotation: Annotation;
  isSelected: boolean;
  isMe: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onEdit?: (updates: Partial<Annotation>) => void;
  /** Open the panel's reply box under this card's thread (see `onReply`). */
  onReply?: () => void;
  /** Words selected in this card's text offer a comment on that passage (see `onCommentPassage`). */
  passageBody?: boolean;
  /** Passages to mark in the card's text (see `cardPassages`). */
  passages?: readonly PassageMark[];
  readOnly?: boolean;
  footer?: React.ReactNode;
  /** Host slot in the card's header row (see `renderCardHeader`). */
  header?: React.ReactNode;
  /** An `@` mention source for the edit box (see `mentionSource`). */
  mentionSource?: MentionSource;
  /** The annotation has no live location in the document (host-reported). */
  unanchored?: boolean;
  /** Built-in parts to draw (see `cardParts`). */
  parts?: { quote?: boolean; images?: boolean; text?: boolean; actions?: boolean; reply?: boolean; passage?: boolean };
  /** Host body, drawn where the comment text goes (see `renderCardBody`). */
  body?: React.ReactNode;
  sectionRefs?: Map<string, string>;
  onNavigateAnchor?: (hash: string) => void;
}> = ({ annotation, isSelected, isMe, onSelect, onDelete, onEdit, onReply, passageBody = false, passages, readOnly = false, footer, header, mentionSource, unanchored = false, parts, body, sectionRefs, onNavigateAnchor }) => {
  // `text: false`: the stored text is the host's stand-in, never the person's words; the edit box starts empty.
  const shownText = parts?.text === false ? '' : annotation.text || '';
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(shownText);
  // A comment on part of an image (#2100): numbered like its box, with the
  // crop, file, size and line in place of the quote.
  const regionCards = useContext(RegionCardContext);
  const region = regionOf(annotation);
  // A card whose place is not a text highlight (a region of an image, a
  // checkbox toggle, a question's answer) takes no reply: the reply would
  // carry a text anchor its parent does not have. `reply: false` (cardParts)
  // turns it off; `actions: false` does not, so a card can take replies
  // without edit or delete (the Inbox's comments already sent).
  const replies = !!onReply && parts?.reply !== false && !region && !annotation.id.startsWith(CHECKBOX_ANNOTATION_PREFIX) && annotation.questionAnswer == null && !isEditing;
  // Its words take a comment on a passage of them (`onCommentPassage`), unless the host turned that off.
  const passageOf = passageBody && parts?.passage !== false && !isEditing ? annotation.id : undefined;
  const regionNumber = region ? regionCards.numbers.get(annotation.id) : undefined;

  // Update editText when annotation.text changes
  useEffect(() => {
    if (!isEditing) {
      setEditText(shownText);
    }
  }, [shownText, isEditing]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditText(shownText);
    setIsEditing(true);
  };

  const handleSaveEdit = (mentions: readonly string[]) => {
    if (onEdit) {
      // The presence rule, same as the creation composers': the key exists
      // only when a source was supplied AND at least one id survived to save,
      // so an untouched or pick-less edit can never wipe tags the annotation
      // already carries.
      if (mentionSource && mentions.length > 0) onEdit({ text: editText, mentions });
      else onEdit({ text: editText });
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditText(shownText);
    setIsEditing(false);
  };

  const typeColor = TYPE_COLOR[annotation.type] ?? 'text-muted-foreground';
  const typeLabel = TYPE_LABEL[annotation.type] ?? 'Note';
  const isGlobal = annotation.type === AnnotationType.GLOBAL_COMMENT;

  // The edit box, mounted only while editing (see AnnotationEditComposer).
  const editComposer = (
    <AnnotationEditComposer
      value={editText}
      onChange={setEditText}
      onSave={handleSaveEdit}
      onCancel={handleCancelEdit}
      mentionSource={mentionSource}
    />
  );

  return (
    <div
      data-annotation-id={annotation.id}
      role="button"
      tabIndex={0}
      // A press that ends a selection of the card's words is no click: it offers a comment on them instead.
      onClick={passageOf !== undefined ? (e: React.MouseEvent<HTMLDivElement>) => { if (!selectionWithin(e.currentTarget)) onSelect(); } : onSelect}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group w-full cursor-pointer rounded-lg px-3 py-2.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        isSelected ? 'bg-surface-1 ring-1 ring-border/50' : 'hover:bg-surface-1/50',
      )}
    >
      {/* Header: type word + author · time + actions */}
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className={cn('text-[11px] font-medium', typeColor)}>{typeLabel}</span>
        {region && regionNumber !== undefined && <RegionNumber n={regionNumber} selected={isSelected} />}
        {region && (
          <span data-annotation-region="true" className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">
            Region
          </span>
        )}
        {annotation.diffContext && (
          <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">
            diff
          </span>
        )}
        {annotation.pageUrl && (
          <HostTitle title={annotation.pageUrl}>
            <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground truncate max-w-[10rem]">
              {annotation.pageUrl}
            </span>
          </HostTitle>
        )}
        {unanchored && (
          <HostTitle title="This comment no longer matches a location in the document">
            <span data-annotation-unanchored="true" className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">
              Unanchored
            </span>
          </HostTitle>
        )}
        <CardByline author={annotation.author} isMe={isMe} timestamp={annotation.createdA} />
        {/* Host header slot (a status stamp etc.) — interactions inside it
            must not toggle card selection, exactly like the footer slot.
            Rendered under readOnly too: its contents are host-owned. */}
        {header != null && header !== false && (
          <div
            data-annotation-card-header="true"
            className="flex min-w-0 items-center"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
          >
            {header}
          </div>
        )}
        {!readOnly && (parts?.actions !== false || replies) && (
          <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            {replies && (
              <HostTitle title="Reply" name>
                <button
                  type="button"
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onReply(); }}
                  className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground"
                >
                  <ReplyCardIcon />
                </button>
              </HostTitle>
            )}
            {parts?.actions !== false && onEdit && annotation.type !== AnnotationType.DELETION && !isEditing && (
              <HostTitle title="Edit annotation" name>
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground"
                >
                  <PencilIcon />
                </button>
              </HostTitle>
            )}
            {parts?.actions !== false && (
              <HostTitle title="Delete annotation" name>
                <button
                  type="button"
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onDelete(); }}
                  className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-destructive"
                >
                  <TrashCardIcon />
                </button>
              </HostTitle>
            )}
          </div>
        )}
      </div>

      {/* Global Comment - show text directly */}
      {isGlobal ? (
        isEditing ? (
          editComposer
        ) : (
          <AnnotationText
            text={annotation.text || ''}
            className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-relaxed text-foreground/90"
            sectionRefs={sectionRefs}
            onNavigateAnchor={onNavigateAnchor}
            passageBodyOf={passageOf}
            passages={passages}
          />
        )
      ) : (
        <>
          {/* A region shows its crop, file, size and line instead of a quote. */}
          {region && parts?.quote !== false && (
            <RegionCardInfo region={region} thumbSrc={regionCards.thumbSrc?.(region.src) ?? null} />
          )}
          {/* Quote — the annotated text */}
          {!region && parts?.quote !== false && (
            <p className="mb-1.5 line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-muted-foreground/80">
              "{annotation.originalText}"
            </p>
          )}

          {/* Comment/Replacement Text */}
          {annotation.type !== AnnotationType.DELETION && (
            isEditing ? (
              editComposer
            ) : (
              shownText && (
                <AnnotationText
                  text={shownText}
                  className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-relaxed text-foreground/90"
                  sectionRefs={sectionRefs}
                  onNavigateAnchor={onNavigateAnchor}
                  passageBodyOf={passageOf}
                  passages={passages}
                />
              )
            )
          )}
          {body != null && body !== false && body}
        </>
      )}

      {/* Attached Images */}
      {parts?.images !== false && annotation.images && annotation.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {annotation.images.map((img, idx) => (
            <div key={idx} className="text-center">
              <ImageThumbnail
                path={img.path}
                size="sm"
                showRemove={false}
              />
              <HostTitle title={img.name} cut>
                <div className="text-[9px] text-muted-foreground truncate max-w-[3rem]">{img.name}</div>
              </HostTitle>
            </div>
          ))}
        </div>
      )}

      {/* Host footer slot (reply/resolve UI etc.) — interactions inside it
          must not toggle card selection. */}
      {footer != null && footer !== false && (
        <div
          data-annotation-card-footer="true"
          className="mt-2"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
        >
          {footer}
        </div>
      )}
    </div>
  );
};

const CodeAnnotationCard: React.FC<{
  annotation: CodeAnnotation;
  isSelected: boolean;
  isMe: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onEdit?: (updates: Partial<CodeAnnotation>) => void;
  readOnly?: boolean;
}> = ({ annotation, isSelected, isMe, onSelect, onDelete, onEdit, readOnly = false }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(annotation.text || '');
  const enterSavesComment = useConfigValue('enterSavesComment');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) setEditText(annotation.text || '');
  }, [annotation.text, isEditing]);

  const handleSaveEdit = () => {
    onEdit?.({ text: editText });
    setIsEditing(false);
  };

  const lineRange = annotation.lineStart === annotation.lineEnd
    ? `line ${annotation.lineStart}`
    : `lines ${annotation.lineStart}-${annotation.lineEnd}`;
  const fileName = basenameFromPath(annotation.filePath);
  // A comment on the whole review (a guided review's global comment): no file, no lines.
  const isGlobal = annotation.scope === 'general';

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditText(annotation.text || '');
  };

  return (
    <div
      data-annotation-id={annotation.id}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group w-full cursor-pointer rounded-lg px-3 py-2.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        isSelected ? 'bg-surface-1 ring-1 ring-border/50' : 'hover:bg-surface-1/50',
      )}
    >
      {/* Header: type word + author · time + actions */}
      <div className="mb-1.5 flex items-center gap-1.5">
        {isGlobal
          ? <span className={cn('text-[11px] font-medium', TYPE_COLOR[AnnotationType.GLOBAL_COMMENT])}>{TYPE_LABEL[AnnotationType.GLOBAL_COMMENT]}</span>
          : <span className="text-[11px] font-medium text-primary">Code</span>}
        <CardByline author={annotation.author} isMe={isMe} timestamp={annotation.createdAt} />
        {!readOnly && (
          <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            {onEdit && !isEditing && (
              <HostTitle title="Edit annotation" name>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
                  className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground"
                >
                  <PencilIcon />
                </button>
              </HostTitle>
            )}
            <HostTitle title="Delete annotation" name>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-destructive"
              >
                <TrashCardIcon />
              </button>
            </HostTitle>
          </div>
        )}
      </div>

      {/* File / line meta (a global comment has neither) */}
      {!isGlobal && (
        <HostTitle title={annotation.filePath}>
          <div className="rounded px-2 py-1 bg-surface-1 font-mono text-[11px] text-muted-foreground truncate">
            {fileName} · {lineRange}
          </div>
        </HostTitle>
      )}

      {annotation.originalCode && (
        <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-muted-foreground/80">
          {annotation.originalCode}
        </p>
      )}

      {isEditing ? (
        <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
          <textarea
            data-pn-mobile-editable="true"
            ref={textareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (isCommentSubmitKey(e, enterSavesComment)) {
                e.preventDefault();
                handleSaveEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                handleCancelEdit();
              }
            }}
            placeholder="Add your comment..."
            aria-label="Annotation comment"
            className="w-full resize-none rounded-lg border border-border/50 bg-card px-2.5 py-2 text-base leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
            style={{ fieldSizing: 'content', minHeight: 44 } as React.CSSProperties}
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button variant="ghost" size="xxs" onClick={handleCancelEdit}>Cancel</Button>
            <Button size="xxs" disabled={!editText.trim()} onClick={handleSaveEdit}>Save</Button>
          </div>
        </div>
      ) : (
        annotation.text && (
          <p className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-relaxed text-foreground/90">
            {annotation.text}
          </p>
        )
      )}

      {annotation.images && annotation.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {annotation.images.map((img) => (
            <div key={img.path} className="text-center">
              <ImageThumbnail path={img.path} size="sm" showRemove={false} />
              <HostTitle title={img.name} cut>
                <div className="text-[9px] text-muted-foreground truncate max-w-[3rem]">{img.name}</div>
              </HostTitle>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
