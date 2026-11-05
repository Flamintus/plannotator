/**
 * The review loop on a screen (#1116, experimental "persistent-comments"; the
 * rules are ../reviewLoop.ts, the state ../hooks/useReviewLoop.ts), drawn as
 * every web client draws it (the bench's R1, R2, R7 to R9):
 *
 * - The threads are boxes in the text, under the passage they are on (ui's
 *   `SentThreads`, the Inbox window's boxes, placed by `sentThreadSlots` as
 *   the Inbox places them, through the Viewer's `belowBlock`): the comment,
 *   the agent's replies and the person's, "New" until the person presses in
 *   the box (at any depth), sub-threads as boxes in the box (words
 *   selected in a sent message offer the document's selection toolbar, and
 *   each action makes the same comment on that passage as on the document:
 *   a comment, a deletion, a quick label), Reply,
 *   Resolve and Reopen at a thread's head, any box folded to one line and
 *   opened again by hand (a resolved thread folded by default once nothing
 *   under it is open), and Send on a draft (it goes alone,
 *   at once, and the round stays open). The person's drafts are boxes too,
 *   "Not sent", after the sent ones on their block.
 * - The annotations panel stays today's list, one comment per card with its
 *   controls, flat (a reply or a sub-thread is a card of its own, no tree):
 *   the page's own annotations only (a sent one takes no edit or delete),
 *   each with one more line (ui's `SentListLine`, read from the boxes' tree
 *   as the Inbox's lists read theirs): its round or "Not sent", what became of its send,
 *   "✓ Resolved" with Resolve or Reopen, Send for a draft, and
 *   "↳ N replies under the passage" (the replies are read in the box).
 *
 * A document the viewer does not draw in blocks (an HTML page) has nowhere
 * to put a box: there the panel keeps the threads as cards, as before
 * (`threadsInText` false): a sent card keeps its place and its highlight,
 * says what a box's head says, in the same chips (ui's `SentCardChips`: its
 * kind, its round or Not sent, its send's status, Live, ✓ Resolved; "Not
 * delivered" with Retry, New on the agent's reply), and
 * Resolve or Reopen (folded to its header once resolved, unless something
 * under it is open); the agent's replies are cards under their comment;
 * words selected in a sent card offer a sub-thread on that passage.
 */
import React, { useCallback, useMemo } from 'react';
import type { TextPassage } from '@plannotator/core/passage';
import type { ReviewThreadNode, ReviewReplyNode } from '@plannotator/core/review-threads';
import { SentListLine } from '@plannotator/ui/components/inbox-thread/CommentListMeta';
import { SentCardChips, sentThreadSlots, useSentThreadsView } from '@plannotator/ui/components/inbox-thread/SentThreads';
import type { PassageToolbarOptions } from '@plannotator/ui/components/PassageToolbar';
import { sentThreadsFromView, type SentCommentsTree, type SentReplyRow, type SentThreadRecord } from '@plannotator/ui/components/inbox-thread/sentCommentsTree';
import { AnnotationType, type Annotation, type Block } from '@plannotator/ui/types';
import { annotationOwnsHighlight, PASSAGE_ANNOTATION_PREFIX } from '@plannotator/ui/utils/annotationOwnsHighlight';
import { buildReplyAnnotation } from '@plannotator/ui/utils/annotationReply';
import { passageCommentFields, type PassageComment, type PassageMark } from '@plannotator/ui/utils/passageSelection';
import { generateId } from '@plannotator/ui/utils/generateId';
import type { ReviewLoop, ReviewLoopSendResult } from '../hooks/useReviewLoop';
import { EMPTY_REVIEW_LOOP_INDEX, isPassageAnnotation, reviewLoopCards, reviewLoopPassages, reviewLoopThreadOf, type ReviewLoopElement } from '../reviewLoop';

const CHIP = 'ml-1 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium';
const ACTION = 'rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-50';
const NO_PASSAGES: readonly PassageMark[] = [];
/** The screens' document selection toolbar (the `Viewer`'s, every action): a passage of a box's message offers the same. */
const DOCUMENT_TOOLBAR: PassageToolbarOptions = {};
const NO_TREE: SentCommentsTree<SentThreadRecord> = { rounds: new Map(), resolved: new Set(), replies: new Map(), subThreads: new Map(), openBelow: new Set(), passages: new Map() };

type CardParts = { quote?: boolean; images?: boolean; text?: boolean; actions?: boolean; reply?: boolean; passage?: boolean };
type Reply = { text: string; mentions?: readonly string[] };

/** A button that waits on its press: disabled while it goes, pressable again when it did not. */
function PressButton({ action, id, className, onPress, children, title }: { action: string; id: string; className?: string; onPress: () => Promise<boolean>; children: React.ReactNode; title?: string }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      data-review-loop-action={action}
      data-review-loop-id={id}
      className={className ?? ACTION}
      disabled={busy}
      title={title}
      onClick={async () => {
        setBusy(true);
        let done = false;
        try {
          done = await onPress();
        } finally {
          if (!done) setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}

export interface ReviewLoopPanelInput {
  loop: ReviewLoop;
  /** The page's annotations on what it shows now (the panel's list without the loop). */
  annotations: Annotation[];
  /** Whether a top-level thread is on what the page shows now. */
  here: (top: ReviewThreadNode) => boolean;
  /** The person's name on the cards they write. */
  person: string;
  readOnly: boolean;
  /** Adds the person's draft to the page (a reply or a sub-thread), painted when `paint`. */
  addDraft: (annotation: Annotation, paint: boolean) => void;
  /** Sends these drafts alone, at once (the round stays open). */
  sendNow: (drafts: readonly Annotation[]) => Promise<ReviewLoopSendResult | null>;
  /** The panel's selection without the loop. */
  select: (id: string) => void;
  /** Reply without the loop (a draft's card). */
  reply: (parentId: string, reply: Reply) => void;
  /** The panel's Edit of the person's comment: a draft's box edits it the same way. */
  edit: (id: string, updates: Partial<Annotation>) => void;
  /** Tells the person a write did not go. */
  notify: (message: string) => void;
  /** The document is drawn in blocks (the Markdown viewer): the threads are boxes under their passage and the panel a flat list. */
  threadsInText: boolean;
  /** The blocks of the document shown, where the boxes go. */
  blocks: readonly Block[];
  /** The comment selected on the page (its card, its highlight): its box is where the person is. */
  selected?: string | null;
}

export interface ReviewLoopPanelProps {
  annotations: Annotation[];
  onSelect: (id: string) => void;
  onReply?: (parentId: string, reply: Reply) => boolean;
  onCommentPassage?: (parentId: string, passage: TextPassage, comment: PassageComment) => boolean;
  cardPassages: (annotation: Annotation) => readonly PassageMark[];
  cardParts: (annotation: Annotation) => CardParts;
  renderCardHeader: (annotation: Annotation) => React.ReactNode;
  renderCardFooter: (annotation: Annotation) => React.ReactNode;
  /** The boxes under each block of the document shown (the Viewer's `belowBlock`); absent: the threads are the panel's cards. */
  belowBlock?: (block: Block) => React.ReactNode;
}

/** The panel's props under the loop; null while it is not available (the panel is today's). */
export function useReviewLoopPanel(input: ReviewLoopPanelInput): ReviewLoopPanelProps | null {
  const { loop, annotations, here, person, readOnly, addDraft, sendNow, select, reply, edit, notify, blocks, selected = null } = input;
  const { index, state } = loop;
  const inText = input.threadsInText;
  const held = useMemo(() => new Map(annotations.map((annotation) => [annotation.id, annotation])), [annotations]);
  /** The threads the page's drafts are under: drawn unfolded, the draft in view. */
  const draftThreads = useMemo(() => {
    const out = new Set<string>();
    for (const annotation of annotations) {
      if (index.sent.has(annotation.id) || !annotation.inReplyTo) continue;
      const at = index.elements.get(annotation.inReplyTo);
      for (let up: ReviewLoopElement | undefined = at; up; up = up.under ? index.elements.get(up.under) : undefined) out.add(up.thread.id);
    }
    return out;
  }, [annotations, index]);
  const folded = useCallback((element: ReviewLoopElement) => !inText && element.kind === 'thread' && (element.node as ReviewThreadNode).folded && !draftThreads.has(element.node.id), [inText, draftThreads]);
  /** Under a folded thread (not itself): not drawn. */
  const hidden = useCallback((id: string) => {
    const element = index.elements.get(id);
    for (let up = element?.under ? index.elements.get(element.under) : undefined; up; up = up.under ? index.elements.get(up.under) : undefined) {
      if (folded(up)) return true;
    }
    return false;
  }, [index, folded]);

  const cards = useMemo(
    () => (loop.available && !inText ? reviewLoopCards({ index: { ...index, elements: new Map([...index.elements].map(([id, element]) => [id, { ...element, hidden: hidden(id) }])) }, held, here, person }) : []),
    [loop.available, inText, index, held, here, person, hidden],
  );
  // In the text, every element of the review stands for what an answer on it goes under: the page's own, else drawn from the view.
  const drawn = useMemo(
    () => (loop.available && inText ? reviewLoopCards({ index: { ...index, elements: new Map([...index.elements].map(([id, element]) => [id, { ...element, hidden: false }])) }, held, here: () => true, person }) : []),
    [loop.available, inText, index, held, person],
  );
  const panelAnnotations = useMemo(() => {
    if (!loop.available) return annotations;
    // In the text, the list is flat (R7): each comment alone, a reply or a sub-thread too, no tree; the tree is the boxes'.
    if (inText) return annotations.some((annotation) => annotation.inReplyTo) ? annotations.map((annotation) => (annotation.inReplyTo ? { ...annotation, inReplyTo: undefined } : annotation)) : annotations;
    const own = annotations.filter((annotation) => !(index.elements.has(annotation.id) && hidden(annotation.id)));
    return [...own, ...cards];
  }, [loop.available, inText, annotations, cards, index, hidden]);
  // What an answer on a card goes under is read from the page's own annotations (a flat card keeps its thread).
  const byId = useMemo(() => new Map([...drawn, ...(inText ? annotations : panelAnnotations)].map((annotation) => [annotation.id, annotation])), [drawn, inText, annotations, panelAnnotations]);
  const failed = useMemo(() => new Map((state?.failed ?? []).map((entry) => [entry.send, entry.message])), [state?.failed]);
  const passages = useMemo(
    () =>
      reviewLoopPassages({
        index,
        drafts: annotations.filter((annotation) => isPassageAnnotation(annotation) && !index.sent.has(annotation.id)),
        offsets: loop.offsets,
        wordsOf: (id) => byId.get(id)?.text,
      }),
    [index, annotations, loop.offsets, byId],
  );

  /** The agent's replies of the thread a card is in: the person looked at them. */
  const lookAt = useCallback((id: string) => {
    const thread = reviewLoopThreadOf(id, index, byId);
    const element = thread ? index.elements.get(thread) : undefined;
    if (!element) return;
    const node = element.node as ReviewThreadNode;
    loop.markSeen(node.replies.filter((entry) => entry.author.kind === 'agent').map((entry) => entry.id));
  }, [index, byId, loop]);

  const onSelect = useCallback((id: string) => {
    lookAt(id);
    // A card drawn from the view has no highlight of its own: its thread's comment, when the page holds it, is its place.
    if (held.has(id)) {
      select(id);
      return;
    }
    const top = index.elements.get(id)?.top.id;
    if (top && held.has(top)) select(top);
  }, [lookAt, held, index, select]);

  const sendDrafts = useCallback(async (drafts: readonly Annotation[]): Promise<boolean> => {
    const result = await sendNow(drafts);
    if (result && !result.ok) notify(`Not sent: ${result.error}`);
    return result?.ok === true;
  }, [sendNow, notify]);

  const onReply = useCallback((parentId: string, words: Reply): boolean => {
    const thread = reviewLoopThreadOf(parentId, index, byId);
    const parent = byId.get(parentId);
    if (thread === null || !parent) {
      reply(parentId, words);
      return true;
    }
    const annotation = buildReplyAnnotation(parent, { id: generateId('reply'), text: words.text, createdA: Date.now(), author: person, mentions: words.mentions });
    const top = index.elements.get(thread)?.top.id;
    addDraft(annotation, !!top && held.has(top) && annotationOwnsHighlight(annotation));
    lookAt(parentId);
    // A live thread (a single send reached it): the person's next replies in it go on their own.
    const node = index.elements.get(thread)?.node as ReviewThreadNode | undefined;
    if (node?.live) void sendDrafts([annotation]);
    return true;
  }, [index, byId, reply, person, addDraft, held, lookAt, sendDrafts]);

  /** A comment on a passage of a sent message, as the selection toolbar made it: a comment, a deletion (no words), a quick label. */
  const onCommentPassage = useCallback((parentId: string, passage: TextPassage, comment: PassageComment): boolean => {
    const parent = byId.get(parentId);
    if (!parent || !index.sent.has(parentId)) return false;
    const reply = buildReplyAnnotation(parent, { id: generateId(PASSAGE_ANNOTATION_PREFIX.slice(0, -1)), text: comment.text, createdA: Date.now(), author: person, mentions: comment.mentions });
    const annotation: Annotation = {
      ...reply,
      ...passageCommentFields(comment),
      // A deletion has no words of its own, as on the document.
      text: comment.text === '' ? undefined : comment.text,
      originalText: passage.quote,
    };
    loop.rememberOffset(annotation.id, passage.offset);
    addDraft(annotation, false);
    lookAt(parentId);
    return true;
  }, [byId, index, person, loop, addDraft, lookAt]);

  /** Resolve or Reopen a thread; said when it did not go. */
  const resolveThread = useCallback(async (id: string, resolved: boolean) => {
    const result = await loop.resolve(id, resolved);
    if (!result.ok) notify(result.error ?? 'The comment did not change.');
    lookAt(id);
  }, [loop, notify, lookAt]);

  const cardParts = useCallback((annotation: Annotation): CardParts => {
    const element = index.elements.get(annotation.id);
    if (element && !element.node.draft) {
      if (folded(element)) return { actions: false, quote: false, text: false, images: false, reply: false, passage: false };
      // In the text, a sub-thread starts from a box: the list's card offers none.
      return inText ? { actions: false, passage: false } : { actions: false };
    }
    // A draft: edited, removed and replied to as today; no sub-thread on its words until it is sent, and no reply
    // under a sub-thread not sent yet (its reply would land under the thread it is on).
    return isPassageAnnotation(annotation) ? { passage: false, reply: false } : { passage: false };
  }, [index, folded, inText]);

  // ── In the text: the threads as boxes under their passage ──
  /** The review's thread view, while its threads are boxes in the text. */
  const textView = loop.available && inText ? (state?.view ?? null) : null;
  /**
   * The person's drafts the view does not hold yet (the page's own): a reply under a sent thread (in its box, "Not
   * sent"), a sub-thread on a passage of a sent message (a box in the box), and any other comment on a passage or on
   * the whole document (a box of its own, after the sent ones on its block). Never an agent's comment on the page,
   * a plan diff's, or a checkbox's or an answer's (they have no passage to sit under until they are sent).
   */
  const ownDrafts = useMemo(() => {
    if (!textView) return null;
    const top: Annotation[] = [];
    const replies = new Map<string, SentReplyRow[]>();
    const subThreads = new Map<string, SentThreadRecord[]>();
    const subDrafts: Annotation[] = [];
    for (const annotation of annotations) {
      if (index.elements.has(annotation.id) || index.sent.has(annotation.id) || annotation.source || annotation.diffContext) continue;
      if (isPassageAnnotation(annotation)) {
        const on = annotation.inReplyTo;
        if (on && index.sent.has(on)) {
          const offset = loop.offsets.get(annotation.id);
          const record: SentThreadRecord = { id: annotation.id, annotation: annotation as unknown as Record<string, unknown>, sent_reply_id: null, parent: on, ...(offset !== undefined ? { quote_offset: offset } : {}) };
          subThreads.set(on, [...(subThreads.get(on) ?? []), record]);
          subDrafts.push(annotation);
        }
        continue;
      }
      const thread = annotation.inReplyTo ? reviewLoopThreadOf(annotation.inReplyTo, index, byId) : null;
      if (thread !== null) {
        const row: SentReplyRow = { id: annotation.id, who: 'You', round: undefined, text: annotation.text ?? '', at: new Date(annotation.createdA).toISOString(), draft: true };
        replies.set(thread, [...(replies.get(thread) ?? []), row]);
        continue;
      }
      if (annotation.type === AnnotationType.GLOBAL_COMMENT || annotationOwnsHighlight(annotation)) top.push(annotation);
    }
    const passages = reviewLoopPassages({ index: EMPTY_REVIEW_LOOP_INDEX, drafts: subDrafts, offsets: loop.offsets, wordsOf: (id) => byId.get(id)?.text });
    return { top, replies, subThreads, passages };
  }, [textView, annotations, index, byId, loop.offsets]);
  /** A thread's drawing data: the page's annotation when it holds it (its block); else its words, under the block they are found in. */
  const annotationOf = useCallback((id: string): Record<string, unknown> | undefined => {
    const own = held.get(id);
    if (own) return own as unknown as Record<string, unknown>;
    const element = index.elements.get(id);
    if (!element || element.kind !== 'thread' || element.under !== null) return undefined;
    const node = element.node as ReviewThreadNode;
    const block = node.quote ? blocks.find((entry) => entry.content.includes(node.quote))?.id : undefined;
    return { originalText: node.quote, text: node.text, ...(block ? { blockId: block } : {}) };
  }, [held, index, blocks]);
  /**
   * The boxes' tree, read from the whole view with the page's drafts (the boxes and the panel's list read it), and the
   * threads on what the page shows now, the page's own drafts after the sent ones.
   */
  const boxes = useMemo(() => {
    if (!textView || !ownDrafts) return null;
    const fresh = new Set<string>();
    for (const [id, element] of index.elements) {
      if (element.kind === 'reply' && (element.node as ReviewReplyNode).author.kind === 'agent' && loop.isNew(id)) fresh.add(id);
    }
    const built = sentThreadsFromView(textView, {
      annotationOf,
      drafts: { replies: ownDrafts.replies, subThreads: ownDrafts.subThreads, passages: ownDrafts.passages },
      fresh,
      person: 'You',
    });
    const shown = new Set(textView.threads.filter((thread) => here(thread)).map((thread) => thread.id));
    const drafts: SentThreadRecord[] = ownDrafts.top.map((annotation) => ({ id: annotation.id, annotation: annotation as unknown as Record<string, unknown>, sent_reply_id: null }));
    return { tree: built.tree, roots: [...built.threads.filter((record) => shown.has(record.id)), ...drafts] };
  }, [textView, ownDrafts, index, loop, annotationOf, here]);
  const foldedIds = useMemo(() => new Set(boxes ? [...boxes.tree.resolved].filter((id) => !boxes.tree.openBelow.has(id)) : []), [boxes]);
  const threadsView = useSentThreadsView(!!boxes && boxes.roots.length > 0 && !readOnly, foldedIds);
  const boxActions = useMemo(
    () => ({
      onOpen: (record: SentThreadRecord) => onSelect(record.id),
      // A press in a box is a look at it: its agent's replies are no longer New.
      onLook: (record: SentThreadRecord) => lookAt(record.id),
      passageToolbar: DOCUMENT_TOOLBAR,
      ...(readOnly
        ? {}
        : {
            onResolve: (record: SentThreadRecord, resolved: boolean) => void resolveThread(record.id, resolved),
            onReply: async (commentId: string, words: Reply) => onReply(commentId, words),
            onSubThread: async (parentId: string, passage: TextPassage, comment: PassageComment) => onCommentPassage(parentId, passage, comment),
            onSend: async (id: string) => {
              const draft = held.get(id);
              return draft ? sendDrafts([draft]) : false;
            },
            // What the panel's card offers Edit on (its actions, never a deletion's), edited in its box by the panel's own Edit.
            canEdit: (id: string) => {
              const annotation = held.get(id);
              return !!annotation && annotation.type !== AnnotationType.DELETION && cardParts(annotation).actions !== false;
            },
            onEdit: (id: string, text: string) => edit(id, { text }),
          }),
    }),
    [readOnly, onSelect, lookAt, resolveThread, onReply, onCommentPassage, held, sendDrafts, cardParts, edit],
  );
  const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1]!.id : null;
  const belowBlock = useMemo(() => {
    if (!boxes || boxes.roots.length === 0) return undefined;
    const slots = sentThreadSlots(boxes.roots, blocks, { group: 'doc', tree: boxes.tree, view: threadsView, selected, ...boxActions });
    // The screens' viewer has no slot after the document: what goes at its end goes under its last block.
    return (block: Block): React.ReactNode => {
      const below = slots.below(block);
      const after = block.id === lastBlock ? slots.after : null;
      if (!below && !after) return null;
      return (
        <div className="pn-review-boxes" data-review-loop-boxes={block.id}>
          {below}
          {after}
        </div>
      );
    };
  }, [boxes, blocks, lastBlock, threadsView, selected, boxActions]);

  // ── In the text: the panel's flat list, one more line per comment ──
  const listLine = useCallback((annotation: Annotation): React.ReactNode => {
    const element = index.elements.get(annotation.id);
    const draft = !element || element.node.draft;
    // A draft of the person's own only (never an agent's comment on the page); never an agent's reply.
    if (draft && (annotation.source || index.sent.has(annotation.id) || annotation.diffContext)) return null;
    if (element?.kind === 'reply' && (element.node as ReviewReplyNode).author.kind === 'agent') return null;
    const reply = element?.kind === 'reply';
    const carrier = draft ? null : reply ? (element.node as ReviewReplyNode).message_id : (element!.node as ReviewThreadNode).reply_id;
    const notDelivered = carrier !== null && failed.has(carrier);
    const retry = carrier !== null && !readOnly && notDelivered && loop.canRetry(carrier);
    return (
      <SentListLine
        entry={{ id: annotation.id, sent_reply_id: carrier, reply }}
        tree={boxes?.tree ?? NO_TREE}
        withoutStatus={notDelivered}
        {...(readOnly ? {} : { onSend: () => sendDrafts([annotation]), onResolve: (resolved: boolean) => void resolveThread(annotation.id, resolved) })}
      >
        {notDelivered && (
          <span className={`${CHIP} bg-destructive/15 text-destructive`} data-review-loop-chip="failed" title={failed.get(carrier) ?? undefined}>
            Not delivered
          </span>
        )}
        {retry && (
          <PressButton
            action="retry"
            id={carrier}
            onPress={async () => {
              const result = await loop.retry(carrier);
              if (result && !result.ok) notify(`Not sent: ${result.error}`);
              return result?.ok === true;
            }}
          >
            Retry
          </PressButton>
        )}
      </SentListLine>
    );
  }, [index, readOnly, sendDrafts, failed, loop, resolveThread, notify, boxes]);

  /** A card's state, as a box's head says it (ui's `SentCardChips`), plus the screens' own: New, Not delivered. */
  const renderCardHeader = useCallback((annotation: Annotation): React.ReactNode => {
    if (inText) return null;
    const element = index.elements.get(annotation.id);
    if (!element || element.node.draft) {
      // A draft of the person's own (never an agent's comment on the page): Not sent, as its box says.
      return annotation.source || index.sent.has(annotation.id) ? null : <SentCardChips draft />;
    }
    const thread = element.kind === 'thread';
    const node = element.node as ReviewThreadNode & ReviewReplyNode;
    const agent = !thread && node.author.kind === 'agent';
    const carrier = thread ? node.reply_id : node.message_id;
    const notDelivered = !agent && failed.has(carrier);
    return (
      <>
        <SentCardChips
          annotation={thread ? annotation : undefined}
          round={node.round}
          status={notDelivered ? undefined : node.status}
          live={thread && node.live}
          resolved={thread && node.state === 'resolved'}
        />
        {agent && loop.isNew(node.id) && (
          <span className="ib-sentc-chip ib-sentb-new" data-review-loop-chip="new">
            New
          </span>
        )}
        {notDelivered && (
          <span className={`${CHIP} bg-destructive/15 text-destructive`} data-review-loop-chip="failed" title={failed.get(carrier) ?? undefined}>
            Not delivered
          </span>
        )}
      </>
    );
  }, [index, failed, loop, inText]);

  const renderCardFooter = useCallback((annotation: Annotation): React.ReactNode => {
    if (inText) return listLine(annotation);
    if (readOnly) return null;
    const element = index.elements.get(annotation.id);
    if (!element || element.node.draft) {
      // A draft of the person's own (never an agent's comment on the page): Send, alone, at once.
      if (annotation.source || index.sent.has(annotation.id)) return null;
      return (
        <div className="flex justify-end">
          <PressButton action="send" id={annotation.id} className={`${ACTION} font-medium text-primary`} onPress={() => sendDrafts([annotation])}>
            Send
          </PressButton>
        </div>
      );
    }
    const node = element.node as ReviewThreadNode & ReviewReplyNode;
    const carrier = element.kind === 'thread' ? node.reply_id : node.message_id;
    const agent = element.kind === 'reply' && node.author.kind === 'agent';
    const retry = !agent && failed.has(carrier) && loop.canRetry(carrier);
    if (element.kind !== 'thread' && !retry) return null;
    const resolved = element.kind === 'thread' && node.state === 'resolved';
    return (
      <div className="flex justify-end gap-1">
        {retry && (
          <PressButton
            action="retry"
            id={carrier}
            onPress={async () => {
              const result = await loop.retry(carrier);
              if (result && !result.ok) notify(`Not sent: ${result.error}`);
              return result?.ok === true;
            }}
          >
            Retry
          </PressButton>
        )}
        {element.kind === 'thread' && (
          <PressButton
            action={resolved ? 'reopen' : 'resolve'}
            id={annotation.id}
            onPress={async () => {
              const result = await loop.resolve(annotation.id, !resolved);
              if (!result.ok) notify(result.error);
              lookAt(annotation.id);
              // The button is drawn again with the new state: never left disabled.
              return false;
            }}
          >
            {resolved ? 'Reopen' : 'Resolve'}
          </PressButton>
        )}
      </div>
    );
  }, [inText, listLine, readOnly, index, failed, loop, notify, sendDrafts, lookAt]);

  const cardPassages = useCallback((annotation: Annotation) => (inText ? NO_PASSAGES : (passages.get(annotation.id) ?? NO_PASSAGES)), [inText, passages]);

  if (!loop.available) return null;
  return {
    annotations: panelAnnotations,
    onSelect,
    ...(readOnly ? {} : inText ? { onReply } : { onReply, onCommentPassage }),
    cardPassages,
    cardParts,
    renderCardHeader,
    renderCardFooter,
    ...(belowBlock ? { belowBlock } : {}),
  };
}
