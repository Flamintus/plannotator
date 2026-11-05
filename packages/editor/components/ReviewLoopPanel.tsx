/**
 * The review loop in a screen's annotations panel (#1116, experimental
 * "persistent-comments"; the rules are ../reviewLoop.ts, the state
 * ../hooks/useReviewLoop.ts). With the loop available, the panel's cards are
 * the review's threads, as cards (crit's rounds and sub-threads, drawn the way
 * the Inbox's file pane draws its sent comments):
 *
 * - a sent card keeps its place and its highlight, takes no edit or delete,
 *   says its round and what became of its send (Queued, Delivered, Read,
 *   Working, Replied; "Not delivered" with Retry when the host could not put
 *   it in the session), and Resolve, or Reopen once resolved (folded to its
 *   header with what is under it, unless something under it is open);
 * - the agent's replies are cards under their comment, "New" until the person
 *   looks at their thread;
 * - Reply under a sent card, or under an agent's reply, writes the person's
 *   reply under that thread: a draft, sent with the next Send Feedback, or at
 *   once when the thread is live (a single send reached it);
 * - words selected in a sent card offer a comment on that passage, a
 *   sub-thread: a draft card under it, its passage marked in the card's words;
 * - a draft has Send, which sends it alone at once and leaves the round open;
 *   Reply under a draft is today's (the reply goes as a comment of its own,
 *   naming the one it answers), except under a sub-thread not sent yet.
 */
import React, { useCallback, useMemo } from 'react';
import type { TextPassage } from '@plannotator/core/passage';
import type { ReviewThreadNode, ReviewReplyNode } from '@plannotator/core/review-threads';
import { SENT_STATUS_WORDS } from '@plannotator/ui/components/inbox-thread/SentThreads';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import { annotationOwnsHighlight, PASSAGE_ANNOTATION_PREFIX } from '@plannotator/ui/utils/annotationOwnsHighlight';
import { buildReplyAnnotation } from '@plannotator/ui/utils/annotationReply';
import { generateId } from '@plannotator/ui/utils/generateId';
import type { ReviewLoop, ReviewLoopSendResult } from '../hooks/useReviewLoop';
import { isPassageAnnotation, reviewLoopCards, reviewLoopPassages, reviewLoopThreadOf, type ReviewLoopElement } from '../reviewLoop';

const CHIP = 'ml-1 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium';
const MUTED_CHIP = `${CHIP} bg-muted text-muted-foreground`;
const ACTION = 'rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-50';
const NO_PASSAGES: readonly TextPassage[] = [];

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
  /** Tells the person a write did not go. */
  notify: (message: string) => void;
}

export interface ReviewLoopPanelProps {
  annotations: Annotation[];
  onSelect: (id: string) => void;
  onReply?: (parentId: string, reply: Reply) => boolean;
  onCommentPassage?: (parentId: string, passage: TextPassage, comment: Reply) => boolean;
  cardPassages: (annotation: Annotation) => readonly TextPassage[];
  cardParts: (annotation: Annotation) => CardParts;
  renderCardHeader: (annotation: Annotation) => React.ReactNode;
  renderCardFooter: (annotation: Annotation) => React.ReactNode;
}

/** The panel's props under the loop; null while it is not available (the panel is today's). */
export function useReviewLoopPanel(input: ReviewLoopPanelInput): ReviewLoopPanelProps | null {
  const { loop, annotations, here, person, readOnly, addDraft, sendNow, select, reply, notify } = input;
  const { index, state } = loop;
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
  const folded = useCallback((element: ReviewLoopElement) => element.kind === 'thread' && (element.node as ReviewThreadNode).folded && !draftThreads.has(element.node.id), [draftThreads]);
  /** Under a folded thread (not itself): not drawn. */
  const hidden = useCallback((id: string) => {
    const element = index.elements.get(id);
    for (let up = element?.under ? index.elements.get(element.under) : undefined; up; up = up.under ? index.elements.get(up.under) : undefined) {
      if (folded(up)) return true;
    }
    return false;
  }, [index, folded]);

  const cards = useMemo(
    () => (loop.available ? reviewLoopCards({ index: { ...index, elements: new Map([...index.elements].map(([id, element]) => [id, { ...element, hidden: hidden(id) }])) }, held, here, person }) : []),
    [loop.available, index, held, here, person, hidden],
  );
  const panelAnnotations = useMemo(() => {
    if (!loop.available) return annotations;
    const own = annotations.filter((annotation) => !(index.elements.has(annotation.id) && hidden(annotation.id)));
    return [...own, ...cards];
  }, [loop.available, annotations, cards, index, hidden]);
  const byId = useMemo(() => new Map(panelAnnotations.map((annotation) => [annotation.id, annotation])), [panelAnnotations]);
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

  const onCommentPassage = useCallback((parentId: string, passage: TextPassage, words: Reply): boolean => {
    const parent = byId.get(parentId);
    if (!parent || !index.sent.has(parentId)) return false;
    const annotation: Annotation = {
      ...buildReplyAnnotation(parent, { id: generateId(PASSAGE_ANNOTATION_PREFIX.slice(0, -1)), text: words.text, createdA: Date.now(), author: person, mentions: words.mentions }),
      type: AnnotationType.COMMENT,
      originalText: passage.quote,
    };
    loop.rememberOffset(annotation.id, passage.offset);
    addDraft(annotation, false);
    lookAt(parentId);
    return true;
  }, [byId, index, person, loop, addDraft, lookAt]);

  const cardParts = useCallback((annotation: Annotation): CardParts => {
    const element = index.elements.get(annotation.id);
    if (element && !element.node.draft) {
      if (folded(element)) return { actions: false, quote: false, text: false, images: false, reply: false, passage: false };
      return { actions: false };
    }
    // A draft: edited, removed and replied to as today; no sub-thread on its words until it is sent, and no reply
    // under a sub-thread not sent yet (its reply would land under the thread it is on).
    return isPassageAnnotation(annotation) ? { passage: false, reply: false } : { passage: false };
  }, [index, folded]);

  const renderCardHeader = useCallback((annotation: Annotation): React.ReactNode => {
    const element = index.elements.get(annotation.id);
    if (!element || element.node.draft) return null;
    const node = element.node as ReviewThreadNode & ReviewReplyNode;
    const agent = element.kind === 'reply' && (node as ReviewReplyNode).author.kind === 'agent';
    const carrier = element.kind === 'thread' ? (node as ReviewThreadNode).reply_id : (node as ReviewReplyNode).message_id;
    const notDelivered = !agent && failed.has(carrier);
    return (
      <>
        <span className={MUTED_CHIP} data-review-loop-chip="round">Round {node.round}</span>
        {agent && loop.isNew(node.id) && <span className={`${CHIP} bg-primary/15 text-primary`} data-review-loop-chip="new">New</span>}
        {!agent && notDelivered && (
          <span className={`${CHIP} bg-destructive/15 text-destructive`} data-review-loop-chip="failed" title={failed.get(carrier) ?? undefined}>
            Not delivered
          </span>
        )}
        {!agent && !notDelivered && node.status && <span className={MUTED_CHIP} data-review-loop-chip="status" data-review-loop-status={node.status}>{SENT_STATUS_WORDS[node.status]}</span>}
        {element.kind === 'thread' && node.state === 'resolved' && <span className={MUTED_CHIP} data-review-loop-chip="resolved">Resolved</span>}
      </>
    );
  }, [index, failed, loop]);

  const renderCardFooter = useCallback((annotation: Annotation): React.ReactNode => {
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
  }, [readOnly, index, failed, loop, notify, sendDrafts, lookAt]);

  const cardPassages = useCallback((annotation: Annotation) => passages.get(annotation.id) ?? NO_PASSAGES, [passages]);

  if (!loop.available) return null;
  return {
    annotations: panelAnnotations,
    onSelect,
    ...(readOnly ? {} : { onReply, onCommentPassage }),
    cardPassages,
    cardParts,
    renderCardHeader,
    renderCardFooter,
  };
}
