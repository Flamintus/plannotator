/**
 * Comments that stay after Send (experimental "persistent-comments"), as the
 * window draws them: the thread's part (`useSentComments`) and the file
 * pane's part (`useSentFileComments`); the threads themselves are ui's
 * shared boxes (`SentThreads`, packages/ui/components/inbox-thread).
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
 * selection toolbar, and Comment opens a box under the block of that
 * message's words the passage starts in, the passage at its head. The comment
 * is a draft until the next Send, then a thread of its own, a box in the box
 * under that block, its passage marked in the message's words: replies,
 * Resolve (its own, whatever its parent's) and sub-threads, at any depth, at
 * the same indent at each level. Like a reply, a sub-thread is never painted
 * on the file or the message.
 *
 * The person resolves a thread, or opens it again, at its head (not on a
 * linked machine's thread: the device door does not forward it). A resolved
 * comment leaves the highlights; its box folds to one "Resolved" line (a
 * press opens it to be read) only once nothing under it, at any depth, is
 * open: until then it stays unfolded, marked Resolved. A message holding a
 * thread still open opens unfolded in its thread (sentComments.ts
 * `unfoldOpenThreads`).
 *
 * Comment sends (this Inbox's thread, `sendsOn`): the person's comments
 * reach the agent as records of their own (packages/core/inbox-comment-sends.ts),
 * never with the words of a Send. A draft (a comment on an agent's message,
 * drawn as a box under its passage too, a reply under a comment, a
 * sub-thread; on a file, its card) has Send, which sends it alone at once
 * and leaves the round open; the thread's Finish round sends every draft
 * left (Thread.tsx). What a send carried says what became of it (Queued,
 * Delivered, Read, Working while its session is in a turn, Replied); a
 * thread a send reached at once is Live, and the person's next reply under
 * it goes on its own (the server's rule); an agent's reply newer than the
 * person's look is New. The header counts the round and the threads still
 * open (`count`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  inboxCommentLastReplies,
  inboxCommentMessages,
  inboxCommentRounds,
  inboxCommentSendReceivedAt,
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
import {
  inboxCommentRoundCount,
  inboxCommentThreadView,
  isInboxCommentSendable,
  type InboxCommentRoundCount,
  type InboxCommentSend,
} from '@plannotator/core/inbox-comment-sends';
import type { TextPassage } from '@plannotator/core/passage';
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from '@plannotator/core/inbox-types';
import type { Annotation, Block } from '@plannotator/ui/types';
import { SentSendButton, SentStatusChip, SentThreads, useSentThreadsView, type ReplyInput, type SubThreadSave } from '@plannotator/ui/components/inbox-thread/SentThreads';
import { CommentListMeta } from '@plannotator/ui/components/inbox-thread/CommentListMeta';
import type { SentCommentsTree } from '@plannotator/ui/components/inbox-thread/sentCommentsTree';
import { Icon } from '@plannotator/ui/components/inbox-thread/icons';
import { InboxApiError, inboxApi, type AttachmentsModel } from '../api';
import { annotationOf, isFileComment } from '../attachments';
import { agentReplyAnnotation, commentOfCard, followCodeLines, placeThreads, sentCommentsParts, sentUnanchoredChanges, withSentWrites } from '../sentComments';
import { newUuid } from '../uuid';
import { useTagConnections } from './TagPicker';

// The thread boxes moved to @plannotator/ui unchanged; this path re-exports them.
export { SentThreads, useSentThreadsView, type SentThreadsView } from '@plannotator/ui/components/inbox-thread/SentThreads';
export type { SentCommentsTree } from '@plannotator/ui/components/inbox-thread/sentCommentsTree';

const NO_RECORDS: readonly InboxAnnotationRecord[] = [];
const NO_REPLIES: readonly (InboxCommentReplyRecord & { seq?: number })[] = [];
const NO_SESSIONS: readonly string[] = [];
const NO_SENDS: readonly InboxCommentSend[] = [];
const NO_WRITES: ReadonlyMap<string, InboxAnnotationRecord> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();
const NO_PASSAGES: readonly TextPassage[] = [];
const NO_TREE: SentCommentsTree = { rounds: new Map(), resolved: NO_IDS, replies: new Map(), subThreads: new Map(), openBelow: NO_IDS, passages: new Map() };

type UnanchoredReport = { attempted: readonly string[]; unanchored: readonly string[] };

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
  /** The person sends one draft alone, at once (comment sends; absent: none, the drafts go with the next Send). */
  onSend?: (id: string) => Promise<boolean>;
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
 *
 * With comment sends (`sendsOn`, see the header): `sendable`, the drafts that
 * go by them; `send`, one draft alone, at once (`reload` reads the files
 * again once it went, as for a reply that went on its own); the boxes carry
 * each sent element's status (its session's connection read while one waits
 * for an answer, for Working), the live threads and the agents' replies newer
 * than `newSince` (New); `count`, the header's round and threads still open.
 */
export function useSentComments(input: {
  threadId: string;
  messages: readonly InboxCommentThreadMessage[];
  files: AttachmentsModel | null;
  drafts: readonly InboxAnnotationRecord[];
  patchDrafts: (update: (records: InboxAnnotationRecord[]) => InboxAnnotationRecord[]) => void;
  onError: (message: string) => void;
  canResolve: boolean;
  /** Comment sends reach this thread: the switch on, this Inbox's own thread (the machine door takes none). */
  sendsOn?: boolean;
  /** Where "new since you looked" starts (the thread's look boundary): an agent's reply after it is New. Null: none. */
  newSince?: number | null;
  /** Read the thread's files again. */
  reload?: () => void;
}) {
  const { threadId, messages, files, drafts, patchDrafts, onError, canResolve, sendsOn = false, newSince = null, reload } = input;
  const listed = files?.sent_comments ?? NO_RECORDS;
  const agentReplies = files?.comment_replies ?? NO_REPLIES;
  const sends = files?.comment_sends ?? NO_SENDS;
  const [written, setWritten] = useState(NO_WRITES);
  const records = useMemo(() => withSentWrites(listed, written), [listed, written]);
  /** The drafts comment sends carry (never a guided review's, which goes with the person's verdict). */
  const sendable = useMemo(() => (sendsOn ? drafts.filter(isInboxCommentSendable) : NO_RECORDS), [sendsOn, drafts]);
  // The sessions a send reached whose elements wait for an answer: their connection says whether they are in a turn (Working).
  // Only what a send carried counts (a Finish's open threads, only named, never make it wait).
  const awaiting = useMemo(() => {
    if (!sendsOn) return NO_SESSIONS;
    const answered = inboxCommentLastReplies([], agentReplies);
    const byId = new Map(records.map((record) => [record.id, record]));
    const out = new Set<string>();
    for (const send of sends) {
      const received = inboxCommentSendReceivedAt(send);
      if (received === null) continue;
      const waits = send.comments.some((id) => {
        const record = byId.get(id);
        return record?.sent_reply_id === send.id && !((answered.get(record.re ?? record.id) ?? '') > received);
      });
      if (waits) out.add(send.to.session);
    }
    return out.size === 0 ? NO_SESSIONS : [...out].sort();
  }, [sendsOn, sends, records, agentReplies]);
  const { connections } = useTagConnections(threadId, awaiting, awaiting.length > 0);
  const rounds = useMemo(() => inboxCommentRounds(messages, records, sends, agentReplies), [messages, records, sends, agentReplies]);
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
  /** The boxes on each message: its sent comments and, with comment sends, its draft comments after them (each with Send). */
  const boxesByMessage = useMemo(() => {
    const own = sendable.filter((record) => record.message && !isInboxCommentUnderAnother(record));
    if (own.length === 0) return byMessage;
    const out = new Map(byMessage);
    for (const record of own) out.set(record.message_id, [...(out.get(record.message_id) ?? []), record]);
    return out;
  }, [byMessage, sendable]);
  // The replies, sub-threads and passages: the thread view's (core), over what was sent and the drafts; with sends, each element's status.
  const { replyRounds, replies, subThreads, passages, statuses, live } = useMemo(() => {
    const all = [...records, ...drafts];
    const busy = (session: string) => connections[session]?.busy === true;
    return sentCommentsParts(inboxCommentThreadView({ messages, records: all, agentReplies, sends, busy }), all);
  }, [messages, records, drafts, agentReplies, sends, connections]);
  /** The agents' replies newer than the person's look (comment sends only: the seqs are this Inbox's). */
  const fresh = useMemo<ReadonlySet<string>>(
    () => (sendsOn && newSince !== null ? new Set(agentReplies.filter((reply) => typeof reply.seq === 'number' && reply.seq > newSince).map((reply) => reply.id)) : NO_IDS),
    [sendsOn, newSince, agentReplies],
  );
  /** The header's count: the round under way and the threads still open (only once something was sent). */
  const count = useMemo<InboxCommentRoundCount | null>(
    () => (files?.sent_comments && (records.length > 0 || sends.length > 0) ? inboxCommentRoundCount({ messages, records, agentReplies, sends }) : null),
    [files?.sent_comments, messages, records, agentReplies, sends],
  );
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
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const keepDraft = (annotation: InboxAnnotationRecord) => patchRef.current((list) => [...list.filter((record) => record.id !== annotation.id), annotation]);
  /**
   * The person's reply under a comment: a draft, with the thread's others (true once saved). Under a live thread
   * it went on its own (the server's rule): the files read again show it sent; a refused send leaves it a draft, said so.
   */
  const reply = useCallback(async (commentId: string, { text, mentions }: ReplyInput): Promise<boolean> => {
    try {
      const answer = await inboxApi.saveCommentReply(commentId, { id: newUuid(), text, ...(mentions && mentions.length > 0 ? { mentions } : {}) });
      if (answer.sends && answer.sends.length > 0) {
        reloadRef.current?.();
        return true;
      }
      keepDraft(answer.annotation);
      if (answer.send_refused) onErrorRef.current(`Your reply is saved but did not go: ${answer.send_refused.message}`);
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
  /** One draft sent alone, at once, the round left open (a comment, a reply under one, a sub-thread); true once it went. */
  const send = useCallback(async (id: string): Promise<boolean> => {
    try {
      // One key per draft: a retry of a press whose answer was lost answers what it wrote.
      await inboxApi.sendComments(threadRef.current, { mode: 'now', comment_ids: [id], idempotency_key: `now:${id}` });
      reloadRef.current?.();
      return true;
    } catch (cause) {
      onErrorRef.current(cause instanceof InboxApiError ? cause.message : 'The comment was not sent. Press Send again.');
      return false;
    }
  }, []);
  const fileRecords = useMemo(() => records.filter(isFileComment), [records]);
  const tree = useMemo<SentCommentsTree>(
    () => ({ rounds, resolved, replies, subThreads, openBelow, passages, statuses, live, fresh }),
    [rounds, resolved, replies, subThreads, openBelow, passages, statuses, live, fresh],
  );
  const sendAction = sendsOn && canResolve ? send : undefined;
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
            ...(sendAction ? { onSend: sendAction } : {}),
          }
        : undefined,
    [files?.sent_comments, fileRecords, rounds, agentReplies, replyRounds, resolved, openBelow, tree, report, resolve, reply, subThread, canResolve, sendAction],
  );
  const foldedIds = useMemo(() => new Set(threads.filter((record) => isInboxCommentThreadFolded(record.id, resolved, openBelow)).map((record) => record.id)), [threads, resolved, openBelow]);
  const view = useSentThreadsView(canResolve && boxesByMessage.size > 0, foldedIds);
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
    const list = boxesByMessage.get(messageId);
    if (!list) return undefined;
    const actions = live && canResolve ? { onResolve: resolve, onReply: reply, onSubThread: subThread, ...(sendAction ? { onSend: sendAction } : {}) } : {};
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
    sendable,
    send: sendAction,
    count,
    sends,
    agentReplies,
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
  /**
   * The file draws its threads in its text (a Markdown or text file, `slotsFor`): the panel is then a flat list
   * (R7), each of the person's comments alone, a reply or a sub-thread too, with ui's `CommentListMeta` line,
   * no agent's card, no fold and no tree. Absent: the threads as cards, as before (a code, HTML, image or video file).
   */
  inFlow?: boolean;
}) {
  const { sent, drafts, path, version, isCode, view, setUnanchored, readOnly, repaint, inFlow = false } = input;
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
  const cardAnnotations = useMemo(
    () => [
      ...fileRecords.filter((r) => !folded.has(r.id)).map((r) => (codeLines && sentIds.has(r.id) && !replyIds.has(r.id) ? followCodeLines(annotationOf(r), codeLines) : annotationOf(r))),
      ...agentHere.filter((reply) => !folded.has(reply.id)).map((reply) => agentReplyAnnotation(sentById.get(reply.re)!, reply)),
    ],
    [fileRecords, agentHere, folded, codeLines, sentIds, replyIds, sentById],
  );
  /** The list is flat where the threads are in the text, with the switch on (a draft gets the same line as what was sent). */
  const flat = inFlow && sent !== undefined;
  const panelAnnotations = useMemo(
    () => (flat ? fileRecords.map((r) => { const a = annotationOf(r); return a.inReplyTo ? { ...a, inReplyTo: undefined } : a; }) : cardAnnotations),
    [flat, fileRecords, cardAnnotations],
  );
  // What the file paints and counts: a resolved comment leaves its words, and a reply's or sub-thread's place is its comment's.
  const annotations = useMemo(
    () => (resolvedIds.size === 0 && replyIds.size === 0 ? cardAnnotations : cardAnnotations.filter((a) => !resolvedIds.has(a.id) && !replyIds.has(a.id))),
    [cardAnnotations, resolvedIds, replyIds],
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

  const statuses = sent?.tree.statuses;
  /** A sent card: its round, what became of it (comment sends) and Resolved, after the card's own header. */
  const withSentRound = (header: ((annotation: Annotation) => ReactNode) | undefined) =>
    sentIds.size === 0 || flat
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
              <SentStatusChip status={statuses?.get(annotation.id)} />
              {resolvedIds.has(annotation.id) && (
                // As the boxes': "✓ Resolved" in the success colour.
                <span className="ib-sentc-chip ib-sentb-resolved" data-sent-resolved="">
                  <Icon name="check" size={11} />
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
      // Flat, a sub-thread starts from a box in the text, and nothing folds here.
      if (flat) return { ...parts(annotation), actions: false, passage: false };
      return foldedIds.has(id) ? { ...parts(annotation), actions: false, quote: false, text: false, images: false } : { ...parts(annotation), actions: false };
    };
  /** A folded card draws no body of its own either (a drawing's picture). */
  const withSentBody = (body: (annotation: Annotation) => ReactNode) => (annotation: Annotation) => (!flat && foldedIds.has(annotation.id) ? null : body(annotation));
  /**
   * A sent card's foot (a comment's or a sub-thread's): Resolve, or Reopen once resolved. With comment sends, a
   * draft card's foot (a comment, a reply under one, a sub-thread): Send, which sends it alone at once.
   */
  const onResolve = sent?.onResolve;
  const onSend = readOnly ? undefined : sent?.onSend;
  const sendableHere = useMemo(() => new Set(onSend ? drafts.filter((r) => r.path === path && r.version === version && isInboxCommentSendable(r)).map((r) => r.id) : []), [onSend, drafts, path, version]);
  /** Flat: ui's `CommentListMeta` under each comment, as the screens' panel and the comments list. */
  const flatFooter = (annotation: Annotation): ReactNode => {
    const record = sentById.get(annotation.id);
    if (!record) {
      if (!draftIds.has(annotation.id)) return null;
      return <CommentListMeta draft {...(!readOnly && onSend && sendableHere.has(annotation.id) ? { onSend: () => onSend(annotation.id) } : {})} />;
    }
    const thread = !isInboxCommentReply(record);
    return (
      <CommentListMeta
        round={rounds.get(record.id)}
        status={statuses?.get(record.id)}
        resolved={thread ? resolvedIds.has(record.id) : undefined}
        replies={thread ? (sent?.tree.replies.get(record.id)?.length ?? 0) : 0}
        {...(thread && !readOnly && onResolve ? { onResolve: (resolved: boolean) => onResolve(record, resolved) } : {})}
      />
    );
  };
  const sentFooter = flat
    ? flatFooter
    : (sentIds.size === 0 && sendableHere.size === 0) || readOnly || (!onResolve && !onSend)
      ? undefined
      : (annotation: Annotation) => {
          if (onSend && sendableHere.has(annotation.id)) return <SentSendButton id={annotation.id} onSend={onSend} />;
          const record = sentById.get(annotation.id);
          if (!record || isInboxCommentReply(record) || !onResolve) return null;
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
  const onCommentPassage = sentIds.size === 0 || readOnly || !onSubThread || flat ? undefined : onSubThread;
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
    const actions = live ? { onResolve, onReply: sent?.onReply, onSubThread, ...(onSend ? { onSend } : {}) } : {};
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
    cardPassages: sentIds.size > 0 && !flat ? cardPassages : undefined,
    reportRestore,
    slotsFor,
  };
}
