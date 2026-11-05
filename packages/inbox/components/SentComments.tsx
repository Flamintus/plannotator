/**
 * Comments that stay after Send (experimental "persistent-comments"), as the
 * window draws them: the thread's part (`useSentComments`), the file pane's
 * part (`useSentFileComments`) and the list under an agent's message
 * (`SentComments`). The rules are in sentComments.ts and
 * packages/core/inbox-comment-threads.ts. With the switch off the thread's
 * files carry no `sent_comments`, and every part here is a no-op.
 *
 * The person resolves a sent comment, or opens it again, from its card in the
 * file's panel or its row under the message (not on a linked machine's
 * thread: the device door does not forward it). A resolved comment leaves
 * the highlights and folds: its card keeps its header (its round, Resolved)
 * and Reopen, and under the message it waits behind "N resolved".
 *
 * Replies sit under their comment, one flat list each, as crit's: the
 * agents' (`comment_replies`, written with their message) and the person's,
 * a draft until the next Send carries it. The person replies from a sent
 * comment's card (ui `AnnotationPanel`'s `onReply`) or its row under the
 * message; a reply newer than a resolution opens the comment again. A reply
 * is never painted on the file or the message: its comment's highlight is
 * its place.
 *
 * Sub-threads, as crit's: words selected in one message of a thread (the
 * comment, a reply, the agent's or the person's, or a sub-thread) offer ui's
 * selection toolbar, and Comment opens a box under that message, the passage
 * at its head. The comment is a draft until the next Send, then a thread of
 * its own under that message, its passage marked in the message's words:
 * replies, Resolve (its own, whatever its parent's) and sub-threads, at any
 * depth, at the same indent at each level. A resolved comment or sub-thread
 * stays unfolded while a sub-thread under it is open. Like a reply, a
 * sub-thread is never painted on the file or the message.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  inboxCommentLastReplies,
  inboxCommentMessages,
  inboxCommentRounds,
  inboxCommentState,
  inboxOpenSubThreadPaths,
  isInboxCommentReply,
  isInboxCommentUnderAnother,
  isInboxSubThread,
  type InboxCommentMessage,
  type InboxCommentThreadMessage,
} from '@plannotator/core/inbox-comment-threads';
import type { TextPassage } from '@plannotator/core/passage';
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from '@plannotator/core/inbox-types';
import { useConfigValue } from '@plannotator/ui/config';
import type { Annotation } from '@plannotator/ui/types';
import { PassageToolbar } from '@plannotator/ui/components/PassageToolbar';
import { PASSAGE_BODY_ATTRIBUTE, passageRanges, selectedPassage, splitByRanges, type SelectedPassage } from '@plannotator/ui/utils/passageSelection';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';
import { InboxApiError, inboxApi, type AttachmentsModel } from '../api';
import { annotationOf, annotationQuote, isFileComment, shortLabel } from '../attachments';
import {
  agentReplyAnnotation,
  commentOfCard,
  followCodeLines,
  hiddenUnderFolded,
  openPassagesByParent,
  sentReplyRounds,
  sentReplyRows,
  sentUnanchoredChanges,
  sitsUnder,
  subThreadsByParent,
  withSentWrites,
  type SentReplyRow,
} from '../sentComments';
import { newUuid } from '../uuid';

const NO_RECORDS: readonly InboxAnnotationRecord[] = [];
const NO_REPLIES: readonly InboxCommentReplyRecord[] = [];
const NO_WRITES: ReadonlyMap<string, InboxAnnotationRecord> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();
const NO_PASSAGES: readonly TextPassage[] = [];

type UnanchoredReport = { attempted: readonly string[]; unanchored: readonly string[] };

/** The person's reply under a comment, or comment on a passage, as the composer hands it. */
type ReplyInput = { text: string; mentions?: readonly string[] };

/** The person's sub-thread on a passage of a message, true once saved. */
type SubThreadSave = (parentId: string, passage: TextPassage, comment: ReplyInput) => Promise<boolean>;

/** What the file pane gets of a thread's sent comments. */
export interface SentFileComments {
  /** The thread's file comments a Send carried (the person's replies and sub-threads under them included). */
  records: readonly InboxAnnotationRecord[];
  /** Each reply that carried comments, by id, with its round. */
  rounds: ReadonlyMap<string, number>;
  /** The agents' replies under the thread's comments. */
  agentReplies: readonly InboxCommentReplyRecord[];
  /** Each reply's round (the person's sent ones and the agents'), by id. */
  replyRounds: ReadonlyMap<string, number>;
  /** The comments and sub-threads the person resolved (a newer reply opens one again). */
  resolved: ReadonlySet<string>;
  /** The messages with an open sub-thread under them: a resolved one among them stays unfolded. */
  openBelow: ReadonlySet<string>;
  /** What the pane found of their words. */
  onUnanchoredReport: (report: UnanchoredReport) => void;
  /** The person resolves one, or opens it again (absent: no Resolve, a linked machine's thread). */
  onResolve?: (record: InboxAnnotationRecord, resolved: boolean) => void;
  /** The person replies under one, true once saved (absent: no Reply, a linked machine's thread). */
  onReply?: (commentId: string, reply: ReplyInput) => Promise<boolean>;
  /** The person comments on a passage of one (absent: no offer, a linked machine's thread). */
  onSubThread?: SubThreadSave;
}

/** What the list under a message draws of the thread's comments, beyond its own rows. */
export interface SentCommentsTree {
  rounds: ReadonlyMap<string, number>;
  resolved: ReadonlySet<string>;
  /** The replies under each comment or sub-thread. */
  replies: ReadonlyMap<string, readonly SentReplyRow[]>;
  /** The sub-threads on each message (drafts too). */
  subThreads: ReadonlyMap<string, readonly InboxAnnotationRecord[]>;
  /** The messages with an open sub-thread under them. */
  openBelow: ReadonlySet<string>;
  /** The passages to mark in each message's words. */
  passages: ReadonlyMap<string, readonly TextPassage[]>;
}

/**
 * The thread's sent comments, from its files (`sent_comments` and
 * `comment_replies`, present only while the switch is on): their rounds, the
 * open ones (`open`: highlighted in their message), all of them by message,
 * the replies and sub-threads under each (`tree`), the pane's part (`pane`),
 * `report`, which keeps what the window found of their words (the store's
 * event then reads the files again), `resolve`, the person's Resolve or
 * Reopen (drawn as soon as the Inbox answers; a refusal goes to `onError`),
 * `reply` and `subThread`, the person's reply under one and comment on a
 * passage of a message, each saved as a draft with the thread's other drafts
 * (`patchDrafts`, the files' own patch); those three are absent when
 * `canResolve` is false. `drafts`: the thread's comments waiting for a Send
 * (a draft reply under a resolved comment shows it open again).
 * `messages`: every message of the comment threads, by id, for the Send's
 * export of a sub-thread (the words its passage is in).
 */
export function useSentComments(input: {
  messages: readonly InboxCommentThreadMessage[];
  files: AttachmentsModel | null;
  drafts: readonly InboxAnnotationRecord[];
  patchDrafts: (update: (records: InboxAnnotationRecord[]) => InboxAnnotationRecord[]) => void;
  onError: (message: string) => void;
  canResolve: boolean;
}) {
  const { messages, files, drafts, patchDrafts, onError, canResolve } = input;
  const listed = files?.sent_comments ?? NO_RECORDS;
  const agentReplies = files?.comment_replies ?? NO_REPLIES;
  const [written, setWritten] = useState(NO_WRITES);
  const records = useMemo(() => withSentWrites(listed, written), [listed, written]);
  const rounds = useMemo(() => inboxCommentRounds(messages, records), [messages, records]);
  // A reply newer than a resolution opens the comment again (inboxCommentState), the person's draft too.
  const lastReplies = useMemo(() => inboxCommentLastReplies([...records, ...drafts], agentReplies), [records, drafts, agentReplies]);
  // The threads: the comments and the sub-threads (a reply is part of its comment's thread).
  const threads = useMemo(() => records.filter((record) => !isInboxCommentReply(record)), [records]);
  const resolved = useMemo(
    () => new Set(threads.filter((record) => inboxCommentState(record, lastReplies.get(record.id) ?? null) === 'resolved').map((record) => record.id)),
    [threads, lastReplies],
  );
  const comments = useMemo(() => threads.filter((record) => !isInboxSubThread(record)), [threads]);
  const open = useMemo(() => comments.filter((record) => !resolved.has(record.id)), [comments, resolved]);
  const byMessage = useMemo(() => {
    const out = new Map<string, InboxAnnotationRecord[]>();
    for (const record of comments) if (record.message) out.set(record.message_id, [...(out.get(record.message_id) ?? []), record]);
    return out;
  }, [comments]);
  const replyRounds = useMemo(() => sentReplyRounds(messages, rounds, records, agentReplies), [messages, rounds, records, agentReplies]);
  const replies = useMemo(() => sentReplyRows([...records, ...drafts], agentReplies, replyRounds), [records, drafts, agentReplies, replyRounds]);
  const subThreads = useMemo(() => subThreadsByParent([...records, ...drafts]), [records, drafts]);
  // A draft sub-thread is open too: what it is under stays unfolded so the person sees it.
  const openBelow = useMemo(() => inboxOpenSubThreadPaths([...records, ...drafts], agentReplies, (id) => !resolved.has(id)), [records, drafts, agentReplies, resolved]);
  const passages = useMemo(() => openPassagesByParent(subThreads, resolved), [subThreads, resolved]);
  const commentMessages = useMemo<ReadonlyMap<string, InboxCommentMessage>>(() => inboxCommentMessages(records, agentReplies), [records, agentReplies]);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const report = useCallback((found: UnanchoredReport) => {
    for (const change of sentUnanchoredChanges(recordsRef.current, found)) void inboxApi.markUnanchored(change.id, change.unanchored).catch(() => {});
  }, []);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const resolve = useCallback((record: InboxAnnotationRecord, resolved: boolean) => {
    void inboxApi.resolveComment(record.id, resolved).then(
      ({ annotation }) => setWritten((current) => new Map(current).set(annotation.id, annotation)),
      (cause: unknown) => onErrorRef.current(cause instanceof InboxApiError ? cause.message : 'The comment did not change.'),
    );
  }, []);
  const patchRef = useRef(patchDrafts);
  patchRef.current = patchDrafts;
  const keepDraft = (annotation: InboxAnnotationRecord) => patchRef.current((list) => [...list.filter((record) => record.id !== annotation.id), annotation]);
  /** The person's reply under a comment: a draft, with the thread's others (true once saved). */
  const reply = useCallback(async (commentId: string, { text, mentions }: ReplyInput): Promise<boolean> => {
    try {
      const { annotation } = await inboxApi.saveCommentReply(commentId, { id: newUuid(), text, ...(mentions && mentions.length > 0 ? { mentions } : {}) });
      keepDraft(annotation);
      return true;
    } catch (cause) {
      onErrorRef.current(cause instanceof InboxApiError ? cause.message : 'The reply was not saved.');
      return false;
    }
  }, []);
  /** The person's comment on a passage of a message of a thread: a draft sub-thread, with the thread's others (true once saved). */
  const subThread = useCallback<SubThreadSave>(async (parentId, passage, { text, mentions }) => {
    try {
      const { annotation } = await inboxApi.saveSubThread(parentId, {
        id: newUuid(),
        text,
        quote: passage.quote,
        quote_offset: passage.offset,
        ...(mentions && mentions.length > 0 ? { mentions } : {}),
      });
      keepDraft(annotation);
      return true;
    } catch (cause) {
      onErrorRef.current(cause instanceof InboxApiError ? cause.message : 'The comment was not saved.');
      return false;
    }
  }, []);
  const fileRecords = useMemo(() => records.filter(isFileComment), [records]);
  const pane = useMemo<SentFileComments | undefined>(
    () =>
      files?.sent_comments
        ? {
            records: fileRecords,
            rounds,
            agentReplies,
            replyRounds,
            resolved,
            openBelow,
            onUnanchoredReport: report,
            ...(canResolve ? { onResolve: resolve, onReply: reply, onSubThread: subThread } : {}),
          }
        : undefined,
    [files?.sent_comments, fileRecords, rounds, agentReplies, replyRounds, resolved, openBelow, report, resolve, reply, subThread, canResolve],
  );
  const tree = useMemo<SentCommentsTree>(() => ({ rounds, resolved, replies, subThreads, openBelow, passages }), [rounds, resolved, replies, subThreads, openBelow, passages]);
  return {
    records,
    open,
    rounds,
    byMessage,
    replies,
    resolved,
    tree,
    commentMessages,
    report,
    resolve: canResolve ? resolve : undefined,
    reply: canResolve ? reply : undefined,
    subThread: canResolve ? subThread : undefined,
    pane,
  };
}

/**
 * The file pane's part: its records are the drafts plus this file's sent
 * comments; a sent code comment follows its lines on the file shown; a sent
 * card has its round, no edit or delete, Reply, and Resolve (Reopen once
 * resolved, when the card folds to its header and what is under it folds
 * with it, unless a sub-thread under it is open); a resolved comment is not
 * painted on the file (`annotations`) but stays in the panel
 * (`panelAnnotations`), and one opened again is painted again (`repaint`);
 * replies, the agents' and the person's, and sub-threads are cards under the
 * message they are on, never painted; words selected in a sent card offer a
 * comment on that passage (`onCommentPassage`), and its open sub-threads'
 * passages are marked in its words (`cardPassages`); and what the pane finds
 * of their words is reported once per comment and file read (`view.key`), so
 * a reload of the records never sends it again.
 */
export function useSentFileComments(input: {
  sent: SentFileComments | undefined;
  drafts: readonly InboxAnnotationRecord[];
  path: string;
  version: string;
  isCode: boolean;
  /** The file's text as shown, and a key that changes with each read of it. */
  view: { text: string; key: string } | null;
  setUnanchored: (ids: ReadonlySet<string>) => void;
  /** No Resolve or Reopen (the pane takes no comments). */
  readOnly: boolean;
  /** Paint comments on the file shown (the viewer's `applySharedAnnotations`; it skips one already painted). */
  repaint: (annotations: Annotation[]) => void;
}) {
  const { sent, drafts, path, version, isCode, view, setUnanchored, readOnly, repaint } = input;
  const sentRecords = sent?.records;
  const fileRecords = useMemo(
    () => [...drafts, ...(sentRecords ?? NO_RECORDS)].filter((r) => r.path === path && r.version === version),
    [drafts, sentRecords, path, version],
  );
  const sentById = useMemo(() => new Map((sentRecords ?? NO_RECORDS).map((r) => [r.id, r])), [sentRecords]);
  const sentIds = useMemo(() => new Set(sentById.keys()), [sentById]);
  const draftIds = useMemo(() => new Set(drafts.map((r) => r.id)), [drafts]);
  const resolvedIds = sent?.resolved ?? NO_IDS;
  const openBelow = sent?.openBelow ?? NO_IDS;
  /** The resolved ones that fold: nothing open under them. */
  const foldedIds = useMemo(() => new Set([...resolvedIds].filter((id) => !openBelow.has(id))), [resolvedIds, openBelow]);
  /** This file's sent comments (the panel's "All files" groups list them with its drafts). */
  const sentHere = useMemo(() => fileRecords.filter((r) => sentIds.has(r.id)), [fileRecords, sentIds]);
  /** The agents' replies under this file's comments (this version's: another file's, or the other version's, are not here). */
  const agentHere = useMemo(() => {
    const here = new Set(sentHere.map((record) => record.id));
    return (sent?.agentReplies ?? NO_REPLIES).filter((reply) => here.has(reply.re));
  }, [sent?.agentReplies, sentHere]);
  /** Every card here under another message (the person's replies and sub-threads, sent or drafts, and the agents' replies): never painted. */
  const replyIds = useMemo(() => new Set([...fileRecords.filter(isInboxCommentUnderAnother).map((r) => r.id), ...agentHere.map((reply) => reply.id)]), [fileRecords, agentHere]);
  /** The cards a folded comment or sub-thread hides. */
  const folded = useMemo(() => hiddenUnderFolded(replyIds, sitsUnder(fileRecords, agentHere), foldedIds), [replyIds, fileRecords, agentHere, foldedIds]);
  /** The passages marked in each card's words: its sub-threads still open. */
  const passagesOn = useMemo(() => openPassagesByParent(subThreadsByParent(fileRecords), resolvedIds), [fileRecords, resolvedIds]);
  const text = view?.text;
  const codeLines = useMemo(() => (isCode && text !== undefined && sentIds.size > 0 ? text.split('\n') : null), [isCode, text, sentIds]);
  const panelAnnotations = useMemo(
    () => [
      ...fileRecords.filter((r) => !folded.has(r.id)).map((r) => (codeLines && sentIds.has(r.id) && !replyIds.has(r.id) ? followCodeLines(annotationOf(r), codeLines) : annotationOf(r))),
      ...agentHere.filter((reply) => !folded.has(reply.id)).map((reply) => agentReplyAnnotation(sentById.get(reply.re)!, reply)),
    ],
    [fileRecords, agentHere, folded, codeLines, sentIds, replyIds, sentById],
  );
  // What the file paints and counts: a resolved comment leaves its words, and a reply's or sub-thread's place is its comment's.
  const annotations = useMemo(
    () => (resolvedIds.size === 0 && replyIds.size === 0 ? panelAnnotations : panelAnnotations.filter((a) => !resolvedIds.has(a.id) && !replyIds.has(a.id))),
    [panelAnnotations, resolvedIds, replyIds],
  );
  // The image and video views draw their own remove controls: a sent comment is in the panel only.
  const ownAnnotations = useMemo(() => (sentIds.size === 0 ? annotations : annotations.filter((a) => !sentIds.has(a.id))), [annotations, sentIds]);
  // A comment opened again is painted again, once the viewer has it (a resolved one left the page with `annotations`).
  const latestAnnotations = useRef(annotations);
  latestAnnotations.current = annotations;
  const repaintRef = useRef(repaint);
  repaintRef.current = repaint;
  const wasResolved = useRef(resolvedIds);
  useEffect(() => {
    const before = wasResolved.current;
    wasResolved.current = resolvedIds;
    const reopened = new Set([...before].filter((id) => !resolvedIds.has(id)));
    if (reopened.size === 0) return;
    requestAnimationFrame(() => {
      const list = latestAnnotations.current.filter((a) => reopened.has(a.id));
      if (list.length > 0) repaintRef.current(list);
    });
  }, [resolvedIds]);
  const rounds = useMemo(() => {
    const out = new Map<string, number>(sent?.replyRounds ?? []);
    for (const record of sentRecords ?? NO_RECORDS) {
      const round = record.sent_reply_id ? sent?.rounds.get(record.sent_reply_id) : undefined;
      if (round !== undefined) out.set(record.id, round);
    }
    return out;
  }, [sentRecords, sent?.rounds, sent?.replyRounds]);

  /** A sent card: its round (and Resolved) after the card's own header. */
  const withSentRound = (header: ((annotation: Annotation) => ReactNode) | undefined) =>
    sentIds.size === 0
      ? header
      : (annotation: Annotation) => {
          const own = header?.(annotation) ?? null;
          const round = rounds.get(annotation.id);
          if (round === undefined) return own;
          return (
            <>
              {own}
              <span className="ib-sentc-chip" data-sent-round={round}>
                Round {round}
              </span>
              {resolvedIds.has(annotation.id) && (
                <span className="ib-sentc-chip" data-sent-resolved="">
                  Resolved
                </span>
              )}
            </>
          );
        };
  /**
   * A sent card (and an agent's reply): no edit or delete; resolved with
   * nothing open under it, folded to its header. A draft is edited and
   * removed, and no passage of it is commented on; only a reply draft takes
   * a Reply (it goes under its comment).
   */
  const withSentParts =
    <T extends object>(parts: (annotation: Annotation) => T) =>
    (annotation: Annotation) => {
      const id = annotation.id;
      if (sentIds.size === 0) return parts(annotation);
      if (draftIds.has(id)) {
        const draft = fileRecords.find((r) => r.id === id);
        return draft && isInboxCommentReply(draft) ? { ...parts(annotation), passage: false } : { ...parts(annotation), reply: false, passage: false };
      }
      if (!sentIds.has(id) && !replyIds.has(id)) return parts(annotation);
      return foldedIds.has(id) ? { ...parts(annotation), actions: false, quote: false, text: false, images: false } : { ...parts(annotation), actions: false };
    };
  /** A folded card draws no body of its own either (a drawing's picture). */
  const withSentBody = (body: (annotation: Annotation) => ReactNode) => (annotation: Annotation) => (foldedIds.has(annotation.id) ? null : body(annotation));
  /** A sent card's foot (a comment's or a sub-thread's): Resolve, or Reopen once resolved. */
  const onResolve = sent?.onResolve;
  const sentFooter =
    sentIds.size === 0 || readOnly || !onResolve
      ? undefined
      : (annotation: Annotation) => {
          const record = sentById.get(annotation.id);
          if (!record || isInboxCommentReply(record)) return null;
          const resolved = resolvedIds.has(record.id);
          return (
            <button type="button" className="ib-sentc-act" data-sent-resolve={record.id} onClick={() => onResolve(record, !resolved)}>
              {resolved ? 'Reopen' : 'Resolve'}
            </button>
          );
        };

  const latest = useRef({ sent, sentIds, viewKey: view?.key ?? '' });
  latest.current = { sent, sentIds, viewKey: view?.key ?? '' };
  const reported = useRef<{ key: string; ids: Set<string> }>({ key: '', ids: new Set() });
  /** What the pane found of the comments' words: shown as Unanchored, and kept for a sent comment, once per file read. */
  const reportUnanchored = useCallback(
    (attempted: readonly string[], ids: Iterable<string>) => {
      const lost = new Set(ids);
      setUnanchored(lost);
      const { sent: now, sentIds: ofSent, viewKey } = latest.current;
      if (!now) return;
      if (reported.current.key !== viewKey) reported.current = { key: viewKey, ids: new Set() };
      const fresh = attempted.filter((id) => ofSent.has(id) && !reported.current.ids.has(id));
      if (fresh.length === 0) return;
      for (const id of fresh) reported.current.ids.add(id);
      now.onUnanchoredReport({ attempted: fresh, unanchored: fresh.filter((id) => lost.has(id)) });
    },
    [setUnanchored],
  );

  /** The person's Reply on a card here: under the card's comment or sub-thread (a reply's own: one list per comment); a failed save keeps the box's words. */
  const onReply = sent?.onReply;
  const replyAt =
    sentIds.size === 0 || readOnly || !onReply
      ? undefined
      : (parentId: string, reply: ReplyInput) => onReply(commentOfCard(parentId, fileRecords, agentHere), reply);
  /** The person's comment on a passage of a card's words: a sub-thread under that card. */
  const onSubThread = sent?.onSubThread;
  const onCommentPassage = sentIds.size === 0 || readOnly || !onSubThread ? undefined : onSubThread;
  const cardPassages = (annotation: Annotation) => passagesOn.get(annotation.id) ?? NO_PASSAGES;

  return {
    sentHere,
    sentIds,
    annotations,
    panelAnnotations,
    ownAnnotations,
    withSentRound,
    withSentParts,
    withSentBody,
    sentFooter,
    reportUnanchored,
    onReply: replyAt,
    onCommentPassage,
    cardPassages: sentIds.size > 0 ? cardPassages : undefined,
  };
}

/** A message's words, with its open sub-threads' passages marked; `bodyOf`: words a passage can be selected in. */
function Said({ text, bodyOf, passages, className = 'ib-sentc-said' }: { text: string; bodyOf?: string; passages?: readonly TextPassage[]; className?: string }) {
  const ranges = useMemo(() => (passages && passages.length > 0 ? passageRanges(text, passages) : []), [text, passages]);
  return (
    <p className={className} data-sent-body="" {...(bodyOf !== undefined ? { [PASSAGE_BODY_ATTRIBUTE]: bodyOf } : {})}>
      {ranges.length === 0
        ? text
        : splitByRanges(text, 0, ranges).map((piece, index) =>
            piece.marked ? (
              <mark key={index} className="ib-sentc-mark" data-passage-mark="">
                {piece.text}
              </mark>
            ) : (
              <span key={index}>{piece.text}</span>
            ),
          )}
    </p>
  );
}

/** The box open in the list: a reply under a comment or sub-thread, or a comment on a passage of a message (`passage`). */
type ListBox = { at: string; text: string; opened: number; passage?: TextPassage };

/**
 * The comments the person sent on an agent's message, under it, each with its
 * round and its words. The open ones' passages stay highlighted in the
 * message; a row brings its passage into view. Each has Resolve
 * (`onResolve`; absent: none); the resolved ones wait behind "N resolved",
 * each with Reopen, unless a sub-thread under one is open. Under a comment,
 * its sub-threads (`tree.subThreads`), then its replies (`tree.replies`: the
 * agent's, the person's, a draft marked so), each reply followed by the
 * sub-threads on its words; a sub-thread is drawn as a comment is, at the
 * same indent at each level. Reply (`onReply`; absent: none) opens a box
 * under the replies; words selected in a sent message's body offer ui's
 * selection toolbar, whose Comment opens a box under that message with the
 * passage at its head (`onSubThread`; absent: no offer). One box at a time:
 * another opens in its place and keeps the words. A draft goes with the next
 * Send.
 */
export function SentComments({
  records,
  tree,
  onOpen,
  onResolve,
  onReply,
  onSubThread,
}: {
  records: readonly InboxAnnotationRecord[];
  tree: SentCommentsTree;
  onOpen: (record: InboxAnnotationRecord) => void;
  onResolve?: (record: InboxAnnotationRecord, resolved: boolean) => void;
  onReply?: (commentId: string, reply: ReplyInput) => Promise<boolean>;
  onSubThread?: SubThreadSave;
}) {
  const { rounds, resolved, replies, subThreads, openBelow, passages } = tree;
  const [showResolved, setShowResolved] = useState(false);
  const [box, setBox] = useState<ListBox | null>(null);
  const [offer, setOffer] = useState<SelectedPassage | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const closeOffer = useCallback(() => setOffer(null), []);
  // A selection let go that holds one sent message's words offers to comment on that passage; let go anywhere, since a
  // drag past the last line ends outside the list.
  const offering = !!onSubThread && records.length > 0;
  useEffect(() => {
    if (!offering) return;
    const doc = listRef.current?.ownerDocument ?? document;
    const offerPassage = () => setOffer(listRef.current ? selectedPassage(listRef.current) : null);
    doc.addEventListener('mouseup', offerPassage);
    return () => doc.removeEventListener('mouseup', offerPassage);
  }, [offering]);
  if (records.length === 0) return null;
  const folded = (id: string) => resolved.has(id) && !openBelow.has(id);
  const shown = records.filter((record) => !folded(record.id));
  const resolvedRows = records.filter((record) => folded(record.id));
  const save = async (current: ListBox, text: string) => {
    const done = current.passage ? await onSubThread!(current.at, current.passage, { text }) : await onReply!(current.at, { text });
    if (done) setBox((open) => (open?.opened === current.opened ? null : open));
  };
  const boxFor = (at: string, passage: boolean) =>
    box && box.at === at && !!box.passage === passage && (passage ? onSubThread : onReply) ? (
      <SentReplyBox
        key={box.opened}
        value={box.text}
        quote={box.passage?.quote}
        onChange={(text) => setBox((open) => (open ? { ...open, text } : open))}
        onSave={(text) => save(box, text)}
        onCancel={() => setBox(null)}
      />
    ) : null;
  /** The sub-threads on a message's words, and the box commenting on a passage of them; `root`: their thread's first comment. */
  const subThreadsOf = (id: string, root: InboxAnnotationRecord) => {
    const list = subThreads.get(id) ?? NO_RECORDS;
    const composer = boxFor(id, true);
    if (list.length === 0 && !composer) return null;
    return (
      <div className="ib-sentc-thread" data-sent-subthreads={id}>
        {list.length > 0 && <ul aria-label="Comments on passages">{list.map((record) => thread(record, false, root))}</ul>}
        {composer}
      </div>
    );
  };
  /** A sent comment, or a sub-thread (`root`: its thread's first comment, whose passage a press brings into view): its row, its words, then what is under it. */
  const thread = (record: InboxAnnotationRecord, isResolvedRow: boolean, root: InboxAnnotationRecord = record): ReactNode => {
    const annotation = annotationOf(record);
    const draft = record.sent_reply_id === null;
    const round = record.sent_reply_id ? rounds.get(record.sent_reply_id) : undefined;
    const isResolved = resolved.has(record.id);
    const closed = folded(record.id);
    const under = closed ? [] : (replies.get(record.id) ?? []);
    // A folded row keeps its Reply: a reply under a resolved comment opens it again.
    const replyBox = boxFor(record.id, false);
    const isSub = isInboxSubThread(record);
    return (
      <li key={record.id} className="ib-sentc-item" data-sent-comment={record.id} data-sent-subthread={isSub ? '' : undefined} data-sent-resolved={isResolved || isResolvedRow ? '' : undefined}>
        <div className="ib-sentc-head">
          <button type="button" className="ib-sentc-row" onClick={() => onOpen(root)}>
            {draft ? <span className="ib-sentc-chip">Not sent</span> : round !== undefined && <span className="ib-sentc-chip" data-sent-round={round}>Round {round}</span>}
            {typeof record.unanchored_at === 'string' && <span className="ib-sentc-chip" data-sent-unanchored="">Unanchored</span>}
            <span className="ib-sentc-quote">“{shortLabel(annotationQuote(annotation))}”</span>
            {(closed || !onSubThread) && <span className="ib-sentc-text">{annotation.text}</span>}
          </button>
          {onReply && !draft && (
            <button
              type="button"
              className="ib-sentc-act"
              data-sent-reply-to={record.id}
              aria-expanded={box?.at === record.id && !box.passage}
              onClick={() => setBox((open) => (open?.at === record.id && !open.passage ? null : { at: record.id, text: open?.text ?? '', opened: (open?.opened ?? 0) + 1 }))}
            >
              Reply
            </button>
          )}
          {onResolve && !draft && (
            <button type="button" className="ib-sentc-act" data-sent-resolve={record.id} onClick={() => onResolve(record, !isResolved)}>
              {isResolved ? 'Reopen' : 'Resolve'}
            </button>
          )}
        </div>
        {/* Its words whole, where a passage of them can be selected (a live thread of this machine). */}
        {!closed && onSubThread && <Said text={annotation.text ?? ''} bodyOf={draft ? undefined : record.id} passages={passages.get(record.id)} />}
        {!closed && subThreadsOf(record.id, root)}
        {(under.length > 0 || replyBox) && (
          <div className="ib-sentc-thread" data-sent-replies={record.id}>
            {under.length > 0 && (
              <ul aria-label="Replies">
                {under.map((reply) => (
                  <li key={reply.id} className="ib-sentc-reply" data-sent-reply={reply.id} data-sent-reply-draft={reply.draft ? '' : undefined}>
                    <span className="ib-sentc-who">{reply.who}</span>
                    {reply.draft ? <span className="ib-sentc-chip">Not sent</span> : reply.round !== undefined && <span className="ib-sentc-chip">Round {reply.round}</span>}
                    <Said text={reply.text} bodyOf={reply.draft || !onSubThread ? undefined : reply.id} passages={passages.get(reply.id)} />
                    {subThreadsOf(reply.id, root)}
                  </li>
                ))}
              </ul>
            )}
            {replyBox}
          </div>
        )}
      </li>
    );
  };
  const commentOn = (passage: SelectedPassage, initialChar?: string) => {
    setOffer(null);
    listRef.current?.ownerDocument.getSelection()?.removeAllRanges();
    setBox((open) => ({ at: passage.parentId, text: `${open?.text ?? ''}${initialChar ?? ''}`, opened: (open?.opened ?? 0) + 1, passage: { quote: passage.quote, offset: passage.offset } }));
  };
  return (
    <>
      <ul ref={listRef} className="ib-sentc" data-sent-comments="" aria-label="Comments you sent">
        {shown.map((record) => thread(record, false))}
        {resolvedRows.length > 0 && (
          <li>
            <button type="button" className="ib-sentc-more" aria-expanded={showResolved} data-sent-resolved-toggle="" onClick={() => setShowResolved((on) => !on)}>
              {resolvedRows.length} resolved
            </button>
          </li>
        )}
        {showResolved && resolvedRows.map((record) => thread(record, true))}
      </ul>
      {offer && onSubThread && <PassageToolbar passage={offer} onComment={(initialChar) => commentOn(offer, initialChar)} onClose={closeOffer} />}
    </>
  );
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
