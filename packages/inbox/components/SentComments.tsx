/**
 * Comments that stay after Send (experimental "persistent-comments"), as the
 * window draws them: the thread's part (`useSentComments`), the file pane's
 * part (`useSentFileComments`) and the threads themselves (`SentThreads`).
 * The rules are in sentComments.ts and packages/core/inbox-comment-threads.ts.
 * With the switch off the thread's files carry no `sent_comments`, and every
 * part here is a no-op.
 *
 * Each thread is a box in the document's flow, as crit's: right under the
 * block its passage starts in (ui Viewer `belowBlock`), in an agent's message
 * and in a Markdown or text file; the ones whose passage was not found at
 * the end, said so. At its head the passage and its round, Reply and Resolve;
 * then its messages: the comment, and the replies under it, the agents'
 * (`comment_replies`, written with their message) and the person's (a draft
 * until the next Send carries it), each with who wrote it and its round. A
 * reply newer than a resolution opens the comment again. A reply is never
 * painted on the file or the message: its comment's highlight is its place.
 * The file's panel lists the same comments as cards (Reply, Resolve, its
 * replies and sub-threads as cards under them), and it alone has the threads
 * of a code, HTML, image or video file.
 *
 * Sub-threads, as crit's: words selected in one message of a thread (the
 * comment, a reply, the agent's or the person's, or a sub-thread) offer ui's
 * selection toolbar, and Comment opens a box under that message, the passage
 * at its head. The comment is a draft until the next Send, then a thread of
 * its own, a box in the box under that message, its passage marked in the
 * message's words: replies, Resolve (its own, whatever its parent's) and
 * sub-threads, at any depth, at the same indent at each level. Like a reply,
 * a sub-thread is never painted on the file or the message.
 *
 * The person resolves a thread, or opens it again, at its head (not on a
 * linked machine's thread: the device door does not forward it). A resolved
 * comment leaves the highlights; its box folds to one "Resolved" line (a
 * press opens it to be read) only once nothing under it, at any depth, is
 * open: until then it stays unfolded, marked Resolved. A message holding a
 * thread still open opens unfolded in its thread (sentComments.ts
 * `unfoldOpenThreads`).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
  inboxCommentLastReplies,
  inboxCommentMessages,
  inboxCommentRounds,
  inboxCommentsHiddenUnderFolded,
  inboxCommentSitsUnder,
  inboxCommentState,
  inboxMessagesWithOpenThreads,
  inboxOpenSubThreadPaths,
  isInboxCommentReply,
  isInboxCommentThreadFolded,
  isInboxCommentUnderAnother,
  isInboxSubThread,
  type InboxCommentMessage,
  type InboxCommentThreadMessage,
} from '@plannotator/core/inbox-comment-threads';
import { inboxCommentThreadView, type InboxCommentSend } from '@plannotator/core/inbox-comment-sends';
import type { TextPassage } from '@plannotator/core/passage';
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from '@plannotator/core/inbox-types';
import { useConfigValue } from '@plannotator/ui/config';
import type { Annotation, Block } from '@plannotator/ui/types';
import { PassageToolbar } from '@plannotator/ui/components/PassageToolbar';
import { PASSAGE_BODY_ATTRIBUTE, passageRanges, selectedPassage, splitByRanges, type SelectedPassage } from '@plannotator/ui/utils/passageSelection';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';
import { InboxApiError, inboxApi, type AttachmentsModel } from '../api';
import { Icon } from '../icons';
import { annotationOf, annotationQuote, isFileComment, shortLabel } from '../attachments';
import { agentReplyAnnotation, commentOfCard, followCodeLines, placeThreads, sentCommentsParts, sentUnanchoredChanges, withSentWrites, type SentReplyRow } from '../sentComments';
import { newUuid } from '../uuid';

const NO_RECORDS: readonly InboxAnnotationRecord[] = [];
const NO_REPLIES: readonly InboxCommentReplyRecord[] = [];
const NO_SENDS: readonly InboxCommentSend[] = [];
const NO_WRITES: ReadonlyMap<string, InboxAnnotationRecord> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();
const NO_PASSAGES: readonly TextPassage[] = [];
const NO_TREE: SentCommentsTree = { rounds: new Map(), resolved: NO_IDS, replies: new Map(), subThreads: new Map(), openBelow: NO_IDS, passages: new Map() };

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
  /** The thread's replies, sub-threads and passages (the pane looks its own comments up in it). */
  tree: SentCommentsTree;
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
  const sends = files?.comment_sends ?? NO_SENDS;
  const [written, setWritten] = useState(NO_WRITES);
  const records = useMemo(() => withSentWrites(listed, written), [listed, written]);
  const rounds = useMemo(() => inboxCommentRounds(messages, records, sends), [messages, records, sends]);
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
  // The replies, sub-threads and passages: the thread view's (core), over what was sent and the drafts.
  const { replyRounds, replies, subThreads, passages } = useMemo(() => {
    const all = [...records, ...drafts];
    return sentCommentsParts(inboxCommentThreadView({ messages, records: all, agentReplies, sends }), all);
  }, [messages, records, drafts, agentReplies, sends]);
  // A draft sub-thread is open too: what it is under stays unfolded so the person sees it.
  const openBelow = useMemo(() => inboxOpenSubThreadPaths([...records, ...drafts], agentReplies, (id) => !resolved.has(id)), [records, drafts, agentReplies, resolved]);
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
  const tree = useMemo<SentCommentsTree>(() => ({ rounds, resolved, replies, subThreads, openBelow, passages }), [rounds, resolved, replies, subThreads, openBelow, passages]);
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
            tree,
            onUnanchoredReport: report,
            ...(canResolve ? { onResolve: resolve, onReply: reply, onSubThread: subThread } : {}),
          }
        : undefined,
    [files?.sent_comments, fileRecords, rounds, agentReplies, replyRounds, resolved, openBelow, tree, report, resolve, reply, subThread, canResolve],
  );
  const foldedIds = useMemo(() => new Set(threads.filter((record) => isInboxCommentThreadFolded(record.id, resolved, openBelow)).map((record) => record.id)), [threads, resolved, openBelow]);
  const view = useSentThreadsView(canResolve && byMessage.size > 0, foldedIds);
  // The messages holding a thread still open: they open unfolded (null until the thread's files are read).
  const openMessages = useMemo(() => (files ? inboxMessagesWithOpenThreads(comments, resolved, openBelow) : null), [files, comments, resolved, openBelow]);
  /**
   * The threads on an agent's message, for its body (MessageBody
   * `belowBlocks`): each under the block its passage starts in, the ones
   * whose passage was not found at the end; `live`, a thread of this machine
   * the person can still answer: Resolve, Reply and comments on passages.
   * Undefined: none on it.
   */
  const slotsFor = (messageId: string, { live, onOpen }: { live: boolean; onOpen: (record: InboxAnnotationRecord) => void }) => {
    const list = byMessage.get(messageId);
    if (!list) return undefined;
    const actions = live && canResolve ? { onResolve: resolve, onReply: reply, onSubThread: subThread } : {};
    return (blocks: readonly Block[]) => {
      const { byBlock, rest } = placeThreads(list, new Set(blocks.map((block) => block.id)));
      const threadsOn = (key: string, records: readonly InboxAnnotationRecord[], lost?: boolean) => (
        <SentThreads key={key} group={`${messageId}:${key}`} records={records} tree={tree} view={view} lost={lost} onOpen={onOpen} {...actions} />
      );
      return {
        below: (block: Block) => {
          const on = byBlock.get(block.id);
          return on ? threadsOn(block.id, on) : null;
        },
        after: rest.length > 0 ? threadsOn('end', rest, true) : null,
      };
    };
  };
  return {
    records,
    open,
    rounds,
    byMessage,
    replies,
    resolved,
    tree,
    commentMessages,
    openMessages,
    slotsFor,
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
  const folded = useMemo(() => inboxCommentsHiddenUnderFolded(replyIds, inboxCommentSitsUnder(fileRecords, agentHere), foldedIds), [replyIds, fileRecords, agentHere, foldedIds]);
  /** The thread's replies, sub-threads and passages: this file's are looked up in it by id. */
  const sentTree = sent?.tree ?? NO_TREE;
  /** The passages marked in each card's words: its sub-threads still open. */
  const passagesOn = sentTree.passages;
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

  // The threads in the document's flow (a Markdown or text file): each under the block its passage is in now.
  const roots = useMemo(() => sentHere.filter((record) => !isInboxCommentUnderAnother(record)), [sentHere]);
  const live = !readOnly && !!onResolve;
  const threadsView = useSentThreadsView(live && !!onSubThread && roots.length > 0, foldedIds);
  const [moved, setMoved] = useState<{ key: string; blocks: ReadonlyMap<string, string> }>({ key: '', blocks: new Map() });
  /** What the viewer found of the comments' words: Unanchored as above, and the block each one's words are in now. */
  const reportRestore = useCallback(
    (report: { attempted: readonly string[]; unanchored: readonly string[]; moved?: readonly { id: string; blockId: string }[] }) => {
      reportUnanchored(report.attempted, report.unanchored);
      if (!latest.current.sent) return;
      const key = latest.current.viewKey;
      const found = (report.moved ?? []).filter((anchor) => anchor.blockId !== '');
      setMoved((current) => {
        if (current.key === key && found.every((anchor) => current.blocks.get(anchor.id) === anchor.blockId)) return current;
        const blocks = new Map(current.key === key ? current.blocks : []);
        for (const anchor of found) blocks.set(anchor.id, anchor.blockId);
        return { key, blocks };
      });
    },
    [reportUnanchored],
  );
  const fileTree = sentTree;
  /**
   * The threads on the document drawn (its blocks), for its viewer (`below`,
   * ui Viewer `belowBlock`) and after it (`after`: the ones whose passage was
   * not found). Undefined: no sent comment here.
   */
  const slotsFor = (blocks: readonly Block[]) => {
    if (roots.length === 0) return undefined;
    const movedHere = moved.key === (view?.key ?? '') ? moved.blocks : undefined;
    const { byBlock, rest } = placeThreads(roots, new Set(blocks.map((block) => block.id)), { moved: movedHere });
    const actions = live ? { onResolve, onReply: sent?.onReply, onSubThread } : {};
    const threadsOn = (key: string, records: readonly InboxAnnotationRecord[], lost?: boolean) => (
      <SentThreads key={key} group={`file:${key}`} records={records} tree={fileTree} view={threadsView} lost={lost} {...actions} />
    );
    return {
      below: (block: Block) => {
        const on = byBlock.get(block.id);
        return on ? threadsOn(block.id, on) : null;
      },
      after: rest.length > 0 ? threadsOn('end', rest, true) : null,
    };
  };

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
    reportRestore,
    slotsFor,
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

/** What a group of threads does: bring a thread's passage into view (absent: its quote is words), and the person's Resolve, Reply and comment on a passage (each absent: none). */
interface SentThreadsActions {
  onOpen?: (record: InboxAnnotationRecord) => void;
  onResolve?: (record: InboxAnnotationRecord, resolved: boolean) => void;
  onReply?: (commentId: string, reply: ReplyInput) => Promise<boolean>;
  onSubThread?: SubThreadSave;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The threads on one block of a document (or, `lost`, the ones whose
 * passage was not found, at its end), each a box of its own, as crit's:
 * at its head the passage and the round, Reply and Resolve; then its
 * messages, the comment and each reply under it (who, round, words); a
 * sub-thread is a box in the box, under the message whose passage it is on,
 * at the same indent at each level, at any depth. A resolved thread folds to
 * one line ("Resolved", a press opens it to be read) only when nothing under
 * it, at any depth, is open; until then it stays unfolded, marked Resolved,
 * its open sub-threads in view. Reply opens a box at the thread's foot;
 * words selected in a sent message offer ui's selection toolbar, whose
 * Comment opens a box under that message with the passage at its head. A
 * draft goes with the next Send.
 */
export function SentThreads({
  group,
  records,
  tree,
  view,
  lost = false,
  ...actions
}: {
  /** This group's key, inside its view's surface. */
  group: string;
  records: readonly InboxAnnotationRecord[];
  tree: SentCommentsTree;
  view: SentThreadsView;
  lost?: boolean;
} & SentThreadsActions) {
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
          onComment={(initialChar) => {
            const passage = view.offer!.passage;
            view.closeOffer();
            document.getSelection()?.removeAllRanges();
            view.setBox((open) => ({ at: passage.parentId, text: `${open?.text ?? ''}${initialChar ?? ''}`, opened: (open?.opened ?? 0) + 1, passage: { quote: passage.quote, offset: passage.offset } }));
          }}
          onClose={view.closeOffer}
        />
      )}
    </div>
  );
}

/** One thread (a comment, or a sub-thread; `root`: its thread's first comment), as a box. */
function SentThreadBox({ record, root, tree, view, actions }: { record: InboxAnnotationRecord; root: InboxAnnotationRecord; tree: SentCommentsTree; view: SentThreadsView; actions: SentThreadsActions }) {
  const { rounds, resolved, replies, subThreads, openBelow, passages } = tree;
  const { onOpen, onResolve, onReply, onSubThread } = actions;
  const { box, setBox } = view;
  const id = record.id;
  const annotation = annotationOf(record);
  const quote = annotationQuote(annotation);
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
    'data-sent-resolved': isResolved ? '' : undefined,
    'data-sent-folded': folded ? '' : undefined,
  };
  if (folded) {
    const subs = countSubThreads(id, replies, subThreads);
    return (
      <div className="ib-sentb-card" {...marks}>
        <button type="button" className="ib-sentb-fold" aria-expanded={false} data-sent-unfold={id} onClick={() => view.toggleShown(id)}>
          <Icon name="chevR" size={12} />
          <span className="ib-sentb-state">
            <Icon name="check" size={12} />
            Resolved
          </span>
          <span className="ib-sentb-fquote">“{shortLabel(quote)}”</span>
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
  /** The sub-threads on a message's words, each a box in this box, and the box commenting on a passage of them. */
  const subThreadsOf = (messageId: string) => {
    const list = subThreads.get(messageId) ?? NO_RECORDS;
    const composer = boxFor(messageId, true);
    if (list.length === 0 && !composer) return null;
    return (
      <div className="ib-sentb-subs" data-sent-subthreads={messageId}>
        {list.map((sub) => (
          <SentThreadBox key={sub.id} record={sub} root={root} tree={tree} view={view} actions={actions} />
        ))}
        {composer}
      </div>
    );
  };
  const replyBox = boxFor(id, false);
  // A sub-thread's passage is in the message just above it; a thread's first comment's is in the document, a press brings it into view.
  const quoteText = <span className="ib-sentb-qt">“{quote}”</span>;
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
          {roundChip}
          {isResolved && (
            <span className="ib-sentc-chip ib-sentb-resolved" data-sent-resolved-chip="">
              Resolved
            </span>
          )}
          {typeof record.unanchored_at === 'string' && (
            <span className="ib-sentc-chip" data-sent-unanchored="">
              Unanchored
            </span>
          )}
        </span>
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
      <div className="ib-sentb-msg" data-sent-message={id}>
        <div className="ib-sentb-meta">
          <span className="ib-sentc-who">You</span>
          {roundChip}
        </div>
        <Said text={annotation.text ?? ''} bodyOf={draft || !onSubThread ? undefined : id} passages={passages.get(id)} />
        {subThreadsOf(id)}
      </div>
      {(under.length > 0 || replyBox) && (
        <div className="ib-sentb-replies" data-sent-replies={id}>
          {under.map((reply) => (
            <div key={reply.id} className="ib-sentb-msg" data-sent-reply={reply.id} data-sent-reply-draft={reply.draft ? '' : undefined}>
              <div className="ib-sentb-meta">
                <span className="ib-sentc-who">{reply.who}</span>
                {reply.draft ? <span className="ib-sentc-chip">Not sent</span> : reply.round !== undefined && <span className="ib-sentc-chip">Round {reply.round}</span>}
              </div>
              <Said text={reply.text} bodyOf={reply.draft || !onSubThread ? undefined : reply.id} passages={passages.get(reply.id)} />
              {subThreadsOf(reply.id)}
            </div>
          ))}
          {replyBox && <div className="ib-sentb-boxrow">{replyBox}</div>}
        </div>
      )}
    </div>
  );
}

/** The sub-threads under a thread, on its messages and theirs, at any depth (what its folded line counts). */
function countSubThreads(id: string, replies: ReadonlyMap<string, readonly SentReplyRow[]>, subThreads: ReadonlyMap<string, readonly InboxAnnotationRecord[]>): number {
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
