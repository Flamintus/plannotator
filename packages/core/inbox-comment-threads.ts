/**
 * The comment thread model of the Plannotator Inbox: a comment the person
 * sent stays a thread of the review instead of ending as text in their reply
 * (experimental "persistent-comments", off by default).
 *
 * The store keeps each comment as an `InboxAnnotationRecord`; this module
 * reads what a thread of comments is from those records and the thread's
 * messages, with no state of its own, so the window, `read_thread` and any
 * later reader agree on it:
 *
 * - its round: the rank of the person's reply that carried it, where replies
 *   with no agent message between them (one Send answering two sessions, or
 *   two Sends before the agent answered) are one round; or, once comments
 *   travel as comment sends (inbox-comment-sends.ts), the round of the send
 *   that carried it, where only the person's Finish (a `round` send) ends a
 *   round, one numbering for both (`inboxCommentRounds`);
 * - where it is (`on`): a message's words, a file's lines or moment, or a
 *   guided review's diff;
 * - whether it is unanchored: its words are no longer in the file the window
 *   last showed (the record's `unanchored_at`, kept by the store so it holds
 *   from one round to the next);
 * - its state: `open` once sent, `resolved` once the person resolved it (the
 *   record's `resolved_at`; only the person sets it), open again when they
 *   reopen it or a reply lands under it (`inboxCommentState`);
 * - which open comments a reply sends again (`inboxCommentsToCarry`), as a
 *   section of its feedback (`inboxOpenCommentsFeedback`): each round, the
 *   agent gets what is still open, as crit sends every unresolved thread;
 * - its replies, one flat list under it, as crit's: the agent's
 *   (`InboxCommentReplyRecord`, send_message's `comment_replies`) and the person's
 *   (a comment record whose `re` names it, a draft until a Send carries it,
 *   sent as its own section, `inboxCommentRepliesFeedback`), each with its
 *   author and round;
 * - its sub-threads, as crit's: the person's comment on a passage of one
 *   message of a thread (the comment, a reply under it, or another
 *   sub-thread), a comment record whose `parent` names that message and
 *   whose `quote_offset` places the passage in its words (passage.ts). Once
 *   sent it is a thread of its own, at any depth: replies, resolution (its
 *   own, whatever its parent's), sub-threads. The agent reads the words the
 *   passage is in with it (`parent`), so it never has to look them up.
 *
 * The rules are the review loop's, shared with every other client
 * (review-threads.ts): this module reads the Inbox's records through
 * `INBOX_COMMENT_READING` and keeps the Inbox's names.
 *
 * Browser-safe and zero-dep.
 */

import { INBOX_MESSAGE_COMMENT_TEXT_MAX, readInboxVideoTime, type InboxAnnotationRecord, type InboxCommentReplyRecord } from "./inbox-attachments";
import { formatInboxVideoTime } from "./inbox-types";
import {
  REVIEW_OPEN_THREADS_NAMED,
  REVIEW_SUB_THREAD_WORDS_SENT,
  isReviewCommentReply,
  isReviewCommentSent,
  isReviewCommentUnderAnother,
  isReviewReplyId,
  isReviewSubThread,
  isReviewThreadFolded,
  reviewCommentEntry,
  reviewCommentLastReplies,
  reviewCommentMessages,
  reviewCommentSitsUnder,
  reviewCommentState,
  reviewCommentsHiddenUnderFolded,
  reviewCommentsInOrder,
  reviewFeedbackEntry,
  reviewOpenSubThreadPaths,
  reviewQuoteOffset,
  reviewQuoted,
  reviewReplyId,
  reviewReplyRound,
  reviewRoundNow,
  reviewRounds,
  reviewSendReceivedAt,
  reviewShownPath,
  reviewSubThreadWindow,
  reviewSubThreadWords,
  reviewText,
  reviewThreadPlace,
  reviewThreads,
  type ReviewAuthor,
  type ReviewCommentMessage,
  type ReviewCommentState,
  type ReviewEntryDetail,
  type ReviewRecordReading,
  type ReviewReply,
  type ReviewRoundMessage,
  type ReviewRoundSend,
  type ReviewSubThreadParent,
  type ReviewThread,
  type ReviewThreadMessage,
} from "./review-threads";
import { ulid } from "./ulid";

/** Where a sent comment is. */
export type InboxCommentAnchor =
  | { kind: "message"; message_id: string }
  | {
      kind: "file";
      /** The file's path as it was attached (absolute). */
      path: string;
      /** `current`: the file as it is now; `sent`: the version the agent sent. */
      version: "current" | "sent";
      /** A code comment's lines, as they were when the comment was made. */
      lines?: [number, number];
      /** A video comment's moment, in seconds. */
      at?: number;
    }
  | { kind: "guide"; message_id: string; file: string; side: "old" | "new"; lines: [number, number] };

/**
 * One comment of a thread once sent (or, when asked, a draft of the
 * person's): the review loop's thread (review-threads.ts) on the Inbox's
 * anchors. `reply_id` names what carried it: the person's reply, or a comment
 * send (`snd_…`, inbox-comment-sends.ts).
 */
export type InboxCommentThread = ReviewThread<InboxCommentAnchor>;

/** One message of a comment thread, as a sub-thread on a passage of it reads it. */
export type InboxCommentMessage = ReviewCommentMessage;

/** The message a sub-thread is on: its id, where the passage starts in its words, and the message (absent when it is not found). */
export type InboxSubThreadParent = ReviewSubThreadParent;

/** Who wrote a reply under a comment. */
export type InboxCommentAuthor = ReviewAuthor;

/** One reply under a sent comment: `message_id` is '' for a draft and for the agent's replies sent alone. */
export type InboxCommentReply = ReviewReply;

/** The longest reply under a comment, in characters (a message comment's limit). */
export const INBOX_COMMENT_REPLY_TEXT_MAX = INBOX_MESSAGE_COMMENT_TEXT_MAX;

/** A new id for an agent's reply under a comment. */
export function inboxCommentReplyId(now?: number): string {
  return reviewReplyId(now);
}

export function isInboxCommentReplyId(value: unknown): value is string {
  return isReviewReplyId(value);
}

/** A new id for one send_message's replies sent alone, which they share (`InboxCommentReplyRecord.call`). */
export function inboxCommentReplyCallId(now?: number): string {
  return `call_${ulid(now)}`;
}

/** A reply's words as kept: trimmed, or null when there are none or more than INBOX_COMMENT_REPLY_TEXT_MAX. */
export function inboxCommentReplyText(value: unknown): string | null {
  return reviewText(value, INBOX_COMMENT_REPLY_TEXT_MAX);
}

/** Whether a stored line's record reads as an agent's reply (a reader skips one that does not). */
export function isInboxCommentReplyRecord(value: unknown): value is InboxCommentReplyRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const from = record.from as Record<string, unknown> | null | undefined;
  const nullableText = (field: unknown) => field === null || typeof field === "string";
  const optionalText = (field: unknown) => field === undefined || typeof field === "string";
  return (
    isInboxCommentReplyId(record.id) &&
    [record.project_id, record.thread_id, record.re, record.text, record.created_at].every((field) => typeof field === "string") &&
    // With its message, or sent alone (`call`).
    (typeof record.message_id === "string" || typeof record.call === "string") &&
    [record.message_id, record.call, record.idempotency_key].every(optionalText) &&
    !!from &&
    typeof from === "object" &&
    from.kind === "agent" &&
    nullableText(from.host) &&
    nullableText(from.session) &&
    nullableText(from.name)
  );
}

/** Whether a comment record is the person's reply under another comment (`re`). */
export function isInboxCommentReply(record: Pick<InboxAnnotationRecord, "re">): boolean {
  return isReviewCommentReply(record);
}

/** Whether a comment record is a sub-thread: the person's comment on a passage of a message of a thread (`parent`). */
export function isInboxSubThread(record: Pick<InboxAnnotationRecord, "parent">): boolean {
  return isReviewSubThread(record);
}

/**
 * Whether a comment record sits under another message of a thread, a reply
 * or a sub-thread: never painted on the file or the message, since its place
 * there is its thread's first comment's, and sent in its own section.
 */
export function isInboxCommentUnderAnother(record: Pick<InboxAnnotationRecord, "re" | "parent">): boolean {
  return isReviewCommentUnderAnother(record);
}

/**
 * Every message of the comment threads a sub-thread can be on, by id: the
 * person's sent comments, replies and sub-threads (`records`, drafts left
 * out: a passage is commented once its words reached the agent) and the
 * agents' replies.
 */
export function inboxCommentMessages(records: readonly InboxAnnotationRecord[], agentReplies: readonly InboxCommentReplyRecord[] = []): Map<string, InboxCommentMessage> {
  return reviewCommentMessages(INBOX_COMMENT_READING, records, agentReplies);
}

/**
 * The messages that have an open sub-thread under them, at any depth, by id:
 * the sub-thread's parent, the comment a reply on the way is under, and so on
 * up to the thread's first comment. A resolved comment or sub-thread among
 * them stays unfolded while one is open, as in crit.
 */
export function inboxOpenSubThreadPaths(
  records: readonly Pick<InboxAnnotationRecord, "id" | "re" | "parent">[],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "id" | "re">[],
  isOpen: (id: string) => boolean,
): Set<string> {
  return reviewOpenSubThreadPaths(records, agentReplies, isOpen);
}

/**
 * Whether a thread is folded: resolved, with nothing open under it at any
 * depth (`openBelow`, inboxOpenSubThreadPaths). A resolved thread with an
 * open sub-thread under it stays unfolded, marked resolved, as in crit.
 */
export function isInboxCommentThreadFolded(id: string, resolved: ReadonlySet<string>, openBelow: ReadonlySet<string>): boolean {
  return isReviewThreadFolded(id, resolved, openBelow);
}

/** What each reply or sub-thread sits under, by its id: a reply's comment (the person's or an agent's), a sub-thread's parent. */
export function inboxCommentSitsUnder(
  records: readonly Pick<InboxAnnotationRecord, "id" | "re" | "parent">[],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "id" | "re">[],
): Map<string, string> {
  return reviewCommentSitsUnder(records, agentReplies);
}

/**
 * The messages that a folded thread hides, by id: every reply or sub-thread
 * (`ids`) with a folded comment or sub-thread above it (`up`, what each sits
 * under, inboxCommentSitsUnder). A thread folds when it is resolved with
 * nothing open below it, so an open sub-thread is never hidden.
 */
export function inboxCommentsHiddenUnderFolded(ids: Iterable<string>, up: ReadonlyMap<string, string>, folded: ReadonlySet<string>): Set<string> {
  return reviewCommentsHiddenUnderFolded(ids, up, folded);
}

/** The agents' messages that hold a comment thread still open, it or one under it (not folded): a client opens them unfolded. */
export function inboxMessagesWithOpenThreads(
  comments: readonly Pick<InboxAnnotationRecord, "id" | "message" | "message_id">[],
  resolved: ReadonlySet<string>,
  openBelow: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const record of comments) if (record.message && !isInboxCommentThreadFolded(record.id, resolved, openBelow)) out.add(record.message_id);
  return out;
}

/** A sent comment is open until the person resolves it. */
export type InboxCommentState = ReviewCommentState;

/**
 * A sent comment's state: resolved from when the person resolved it
 * (`resolved_at`) until they reopen it, or until a reply lands under it: a
 * reply newer than `resolved_at` (`lastReplyAt`, the newest reply's time)
 * opens it again, as a reply does in crit, with nothing written. Its three
 * readers pass the newest reply's time (`inboxCommentLastReplies`):
 * `inboxCommentThreads` (read_thread and what a reply sends again), the
 * store's `resolveAnnotation` (whether a press changes anything) and the
 * window's `isResolved` (packages/inbox/components/SentComments.tsx).
 */
export function inboxCommentState(record: Pick<InboxAnnotationRecord, "resolved_at">, lastReplyAt: string | null = null): InboxCommentState {
  return reviewCommentState(record, lastReplyAt);
}

/**
 * The newest reply under each comment, by the comment's id: the agent's, and
 * the person's, a draft too (a draft reply under a resolved comment shows it
 * open again in the window, and the person's Resolve then closes it again).
 * A removed reply counts for nothing.
 */
export function inboxCommentLastReplies(
  records: readonly Pick<InboxAnnotationRecord, "re" | "removed_at" | "created_at">[],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "re" | "created_at">[] = [],
): Map<string, string> {
  return reviewCommentLastReplies(records, agentReplies);
}

/** What a round needs of a message: its id and who wrote it. */
export type InboxCommentRoundMessage = ReviewRoundMessage;

/** What a thread of comments needs of a message: its round's part, and when it was written (the agent's replies' round). */
export type InboxCommentThreadMessage = ReviewThreadMessage;

/**
 * What a round needs of a comment send (`InboxCommentSend`,
 * inbox-comment-sends.ts): its order, its mode and its press (`batch`, shared
 * by the sends one press writes, one per session); and, for an agent's
 * reply's round, when it reached its session or a session it tags.
 */
export type InboxCommentRoundSend = ReviewRoundSend;

/**
 * When a comment send reached `session`: the earliest of its delivery and its
 * read, its own session's (`to`, also when `session` is null) or a tagged
 * session's own; null while it has not.
 */
export function inboxCommentSendReceivedAt(send: Pick<InboxCommentRoundSend, "to" | "delivery" | "read_at" | "tags">, session: string | null = null): string | null {
  return reviewSendReceivedAt(send, session);
}

/**
 * The round under way at `at`, for a reply the agent wrote then: the round of
 * the newest reply of the person's that carried comments by then, or of the
 * newest comment send its session (`session`, when known) had received by
 * then (delivered or read: an agent answers what reached it). 1 at least: a
 * reply is under a comment some round carried.
 */
export function inboxCommentReplyRound(
  messages: readonly InboxCommentThreadMessage[],
  rounds: ReadonlyMap<string, number>,
  at: string,
  sends: readonly InboxCommentRoundSend[] = [],
  session: string | null = null,
): number {
  return reviewReplyRound(messages, rounds, at, sends, session);
}

/** One call of an agent's replies sent alone (`call`, no message), as `inboxCommentWrites` lists it. */
export interface InboxCommentReplyCallWrite {
  /** The call's id (`call_…`). */
  id: string;
  author: { kind: "agent"; session: string | null };
  /** Its first reply's time. */
  created_at: string;
  call: true;
}

/**
 * The thread's messages with each call of an agent's replies sent alone as
 * one entry more, an agent writing, at its first reply's time (after a
 * message of the same instant): for the rules that read who wrote when, an
 * answer of the agent's is a message or such a call (a reply's round ends at
 * the agent's answer; the open comments go again once the session wrote).
 */
export function inboxCommentWrites<M extends { created_at: string }>(
  messages: readonly M[],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "call" | "from" | "created_at">[] = [],
): (M | InboxCommentReplyCallWrite)[] {
  const calls = new Map<string, InboxCommentReplyCallWrite>();
  for (const reply of agentReplies) {
    if (reply.call && !calls.has(reply.call)) calls.set(reply.call, { id: reply.call, author: { kind: "agent", session: reply.from.session }, created_at: reply.created_at, call: true });
  }
  if (calls.size === 0) return [...messages];
  const pending = [...calls.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const out: (M | InboxCommentReplyCallWrite)[] = [];
  let next = 0;
  for (const message of messages) {
    for (; next < pending.length && pending[next]!.created_at < message.created_at; next++) out.push(pending[next]!);
    out.push(message);
  }
  return [...out, ...pending.slice(next)];
}

/** Whether a record is a comment the person sent (not a draft, not removed). */
export function isInboxCommentSent(record: Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at">): boolean {
  return isReviewCommentSent(record);
}

/**
 * Each reply that carried comments, and each comment send (`sends`), by id,
 * with its round (from 1), in the thread's order (messages and comment sends
 * by time), as the review loop counts them (review-threads.ts
 * `reviewRounds`): a `now` send leaves its round open and only the person's
 * Finish ends it; with no sends, a round ends when an agent writes in the
 * thread (a message, or replies sent alone: `agentReplies`), so the person's
 * replies before that answer (one Send to two sessions writes two) share
 * their round.
 */
export function inboxCommentRounds(
  messages: readonly InboxCommentThreadMessage[],
  records: readonly Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at">[],
  sends: readonly InboxCommentRoundSend[] = [],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "call" | "from" | "created_at">[] = [],
): Map<string, number> {
  return reviewRounds(records, sends, inboxCommentWrites(messages, agentReplies));
}

/** The round under way: the one a new comment send is in, and the counter a thread shows (1 before anything was sent). */
export function inboxCommentRoundNow(
  messages: readonly InboxCommentThreadMessage[],
  records: readonly Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at">[],
  sends: readonly InboxCommentRoundSend[] = [],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "call" | "from" | "created_at">[] = [],
): number {
  return reviewRoundNow(records, sends, inboxCommentWrites(messages, agentReplies));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lineRange(start: unknown, end: unknown): [number, number] | null {
  return Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 1 && (end as number) >= (start as number) ? [start as number, end as number] : null;
}

/** Where a record's comment is. */
export function inboxCommentAnchor(record: InboxAnnotationRecord): InboxCommentAnchor {
  if (record.message) return { kind: "message", message_id: record.message_id };
  if (record.guide) {
    const { file, side, line_start, line_end } = record.guide;
    return { kind: "guide", message_id: record.message_id, file, side, lines: [line_start, line_end] };
  }
  const code = record.annotation.inboxCode as { lineStart?: unknown; lineEnd?: unknown } | undefined;
  const lines = code && typeof code === "object" ? lineRange(code.lineStart, code.lineEnd) : null;
  const at = readInboxVideoTime(record.annotation);
  return {
    kind: "file",
    path: record.path,
    version: record.version === "current" ? "current" : "sent",
    ...(lines ? { lines } : {}),
    ...(at !== null ? { at } : {}),
  };
}

/**
 * The thread's sent comments, oldest round first (then by when they were
 * made), each with its round, anchor, state and replies: the person's that a
 * Send carried (a draft is not sent yet, so it is not listed and does not
 * open a comment again here) and the agent's (`agentReplies`). A comment a
 * comment send carried (its `sent_reply_id` is the send's id) has that send's
 * round (`sends`). A record whose reply or send is not given (a Send that
 * never landed) is left out, except from the person's view (`drafts`),
 * where it is one just sent that the reader has not read yet: in the round
 * under way.
 *
 * `drafts`: the person's drafts too (a comment, a reply under a comment, a
 * sub-thread; never a guided review's), marked `draft`, in the round under
 * way after what was sent in it, as the person sees the thread: a draft reply
 * then opens a resolved comment again, as it does in the window. Without it,
 * what an agent reads: what was sent.
 */
export function inboxCommentThreads(
  messages: readonly InboxCommentThreadMessage[],
  records: readonly InboxAnnotationRecord[],
  agentReplies: readonly InboxCommentReplyRecord[] = [],
  sends: readonly InboxCommentRoundSend[] = [],
  options: { drafts?: boolean } = {},
): InboxCommentThread[] {
  return reviewThreads(INBOX_COMMENT_READING, records, agentReplies, sends, { ...options, messages: inboxCommentWrites(messages, agentReplies) });
}

/** A sub-thread's `quote_offset`, 0 when it has none that reads as one. */
export function inboxQuoteOffset(record: Pick<InboxAnnotationRecord, "quote_offset">): number {
  return reviewQuoteOffset(record);
}

/**
 * The fields of a comment's annotation that are its author's own, never a
 * reply's: everything else (its block, offsets, words, lines, moment, part of
 * a diagram, element) is where it is, and a reply takes that place, as
 * `buildReplyAnnotation` does in @plannotator/ui.
 */
const OWN_FIELDS = new Set(["id", "type", "text", "author", "source", "createdA", "mentions", "images", "isQuickLabel", "quickLabelTip", "inReplyTo", "exportLocation", "questionAnswer"]);

/**
 * The annotation of the person's reply under a comment: the comment's place,
 * the reply's own id, words and tags, and `inReplyTo` the comment, so a panel
 * threads it under its card and an older reader sees a comment on the same
 * words. A reply is a comment, even under a deletion.
 */
export function inboxCommentReplyAnnotation(comment: Pick<InboxAnnotationRecord, "id" | "annotation">, reply: { id: string; text: string; createdA: number; mentions?: readonly string[] }): Record<string, unknown> {
  const place = Object.fromEntries(Object.entries(comment.annotation).filter(([key]) => !OWN_FIELDS.has(key)));
  return {
    ...place,
    id: reply.id,
    type: "COMMENT",
    text: reply.text,
    createdA: reply.createdA,
    ...(reply.mentions && reply.mentions.length > 0 ? { mentions: [...reply.mentions] } : {}),
    inReplyTo: comment.id,
  };
}

/**
 * The annotation of the person's sub-thread on a passage of `parent`: its
 * thread's first comment's place (as a reply's), the passage as its words
 * (`originalText`), and `inReplyTo` the parent, so a panel draws it under
 * that message's card with the passage at its head. Its kind is one a
 * document's words take: a comment, a deletion (`type` "DELETION"), or a
 * quick label's comment (`isQuickLabel`, its tip).
 */
export function inboxSubThreadAnnotation(
  comment: Pick<InboxAnnotationRecord, "id" | "annotation">,
  sub: { id: string; parent: string; quote: string; text: string; createdA: number; mentions?: readonly string[]; type?: "COMMENT" | "DELETION"; isQuickLabel?: boolean; quickLabelTip?: string },
): Record<string, unknown> {
  return {
    ...inboxCommentReplyAnnotation(comment, sub),
    originalText: sub.quote,
    inReplyTo: sub.parent,
    ...(sub.type === "DELETION" ? { type: "DELETION" } : {}),
    ...(sub.isQuickLabel ? { isQuickLabel: true } : {}),
    ...(sub.quickLabelTip ? { quickLabelTip: sub.quickLabelTip } : {}),
  };
}

/**
 * Where a sent comment is, in words an agent reads (`read_thread`, and the
 * comments a reply sends again): "on message msg_…", "on notes.md lines
 * 12-14 when commented", "on the guided review in msg_…, src/a.ts (new) line 3".
 * A file's path is shown from the project's `root`.
 */
export function inboxCommentPlace(on: InboxCommentAnchor, root: string): string {
  if (on.kind === "message") return `on message ${on.message_id}`;
  const lines = (range: [number, number]) => (range[0] === range[1] ? `line ${range[0]}` : `lines ${range[0]}-${range[1]}`);
  if (on.kind === "guide") return `on the guided review in ${on.message_id}, ${on.file} (${on.side}) ${lines(on.lines)}`;
  const parts = [`on ${reviewShownPath(on.path, root)}${on.version === "sent" ? " (the version you sent)" : ""}`];
  if (on.lines) parts.push(`${lines(on.lines)} when commented`);
  if (on.at !== undefined) parts.push(`at ${formatInboxVideoTime(on.at)}`);
  return parts.join(" ");
}

/**
 * Where a sent comment is, as `inboxCommentPlace` says it, and for a
 * sub-thread the message whose passage it is on first: "on a passage of
 * reply rep_… under comment c1 (on notes.md lines 3-4 when commented)".
 */
export function inboxCommentThreadPlace(thread: Pick<InboxCommentThread, "on" | "parent">, root: string): string {
  return reviewThreadPlace(inboxCommentPlace, thread, root);
}

/**
 * A sub-thread's passage in the words around it, as an agent reads it: about
 * `max` characters, `…` where cut, and where the passage starts in them.
 */
export function inboxSubThreadWindow(thread: Pick<InboxCommentThread, "parent" | "quote">, max: number): { text: string; offset: number } | null {
  return reviewSubThreadWindow(thread, max);
}

/** `inboxSubThreadWindow`'s words alone. */
export function inboxSubThreadWords(thread: Pick<InboxCommentThread, "parent" | "quote">, max: number): string | null {
  return reviewSubThreadWords(thread, max);
}

/** The most of a passage's surrounding words a feedback entry carries, in characters. */
export const INBOX_SUB_THREAD_WORDS_SENT = REVIEW_SUB_THREAD_WORDS_SENT;

/** What sending comments again needs of a message: who wrote it, and an agent's session. */
export interface InboxCommentCarryMessage extends InboxCommentRoundMessage {
  author: { kind: string; session?: string | null };
}

/**
 * The open comments the person's new reply to the agent session `session`
 * sends again: those that went to that session before it last wrote in the
 * thread, still open, and only when this reply is the person's first to it
 * since then (a second reply before it answers repeats nothing). A comment
 * that went to another session waits for a reply to that one. A comment on a
 * guided review's diff is left out: the window draws none of those, so none
 * can be resolved. `sentTo` names the session a message of the person went
 * to (the store's `recipientOf`), null for one that is not a reply to it.
 */
export function inboxCommentsToCarry<M extends InboxCommentCarryMessage>(
  messages: readonly M[],
  threads: readonly InboxCommentThread[],
  session: string,
  sentTo: (message: M) => string | null,
): InboxCommentThread[] {
  let last = -1;
  messages.forEach((message, index) => {
    if (message.author.kind === "agent" && message.author.session === session) last = index;
  });
  if (last < 0) return [];
  if (messages.slice(last + 1).some((message) => message.author.kind === "person" && sentTo(message) === session)) return [];
  const at = new Map(messages.map((message, index) => [message.id, index]));
  return threads.filter((thread) => {
    const index = at.get(thread.reply_id);
    return isInboxCommentAskedAgain(thread) && index !== undefined && index < last && sentTo(messages[index]!) === session;
  });
}

/**
 * Whether a sent comment is one the agent is asked about again while it is
 * open, each round: any but a comment on a guided review's diff, which the
 * window draws nowhere, so the person could never resolve it.
 */
export function isInboxCommentAskedAgain(thread: Pick<InboxCommentThread, "state" | "on">): boolean {
  return thread.state === "open" && thread.on.kind !== "guide";
}

/**
 * The title of the section that sends open comments again. It is a feedback
 * section of the reply, so the window draws it with the rest of the feedback
 * (packages/inbox/replyFeedback.ts).
 */
export const INBOX_OPEN_COMMENTS_TITLE = "Feedback on comments still open";

/** A reply sends at most this many open comments again, the newest; the rest are counted. */
export const INBOX_OPEN_COMMENTS_SENT = REVIEW_OPEN_THREADS_NAMED;

/**
 * The open comments a reply sends again, as a section of its feedback: one
 * entry per comment with its round, where it is and its words, then the
 * comment; each heading ends with the comment's id, as every entry of a Send
 * does. The newest `INBOX_OPEN_COMMENTS_SENT` only, and a line counting the
 * others. Empty when there is none.
 */
export function inboxOpenCommentsFeedback(threads: readonly InboxCommentThread[], root: string): string {
  if (threads.length === 0) return "";
  const shown = threads.slice(-INBOX_OPEN_COMMENTS_SENT);
  const older = threads.length - shown.length;
  const entries = shown.map((thread, index) => {
    const place = `${inboxCommentThreadPlace(thread, root)}${thread.unanchored ? ", unanchored (its words were not in the file when the person last opened it)" : ""}`;
    return reviewFeedbackEntry(index + 1, `Round ${thread.round}, ${place}${reviewQuoted(thread.quote)}`, thread.id, inboxSubThreadWords(thread, INBOX_SUB_THREAD_WORDS_SENT), thread.text);
  });
  const intro = "The person has not resolved these comments from earlier rounds yet.";
  const rest = older > 0 ? [`${older} older open comment${older === 1 ? " is" : "s are"} not repeated here: read_thread lists every comment.`] : [];
  return [`# ${INBOX_OPEN_COMMENTS_TITLE}`, intro, ...entries, ...rest].join("\n\n");
}

/** Comment records in the order the person wrote them (by time, then id): the order a Send lists them in. */
export function inboxCommentsInOrder<R extends Pick<InboxAnnotationRecord, "id" | "created_at">>(records: readonly R[]): R[] {
  return reviewCommentsInOrder(records);
}

/**
 * One comment record as an entry of what a Send carries, numbered `number`,
 * named by its id, where it is and the words it is on:
 *
 * - a reply under a comment: "Reply under comment <id>, <place>";
 * - a sub-thread: "Comment on a passage of <message> (<place>)", and, when
 *   `messages` holds that message, the words around the passage (`In:`);
 * - any other comment: "Comment <place>", or "Remove this, <place>" for a
 *   deletion (a redline on a file's words).
 */
export function inboxCommentEntry(
  record: InboxAnnotationRecord,
  number: number,
  root: string,
  messages: ReadonlyMap<string, InboxCommentMessage> = new Map(),
  /** What a caller knows beyond the record: a document comment's lines in the version commented, and lines under the heading. */
  detail: InboxCommentEntryDetail = {},
): string {
  return reviewCommentEntry(INBOX_COMMENT_READING, record, number, root, messages, detail);
}

/** What `inboxCommentEntry` may add to a record's entry (a comment send's text); nothing by default, so the Send's sections keep their words. */
export type InboxCommentEntryDetail = ReviewEntryDetail;

/**
 * How the review loop's rules (review-threads.ts) read the Inbox's comment
 * records: the anchor from the record (`inboxCommentAnchor`), the words from
 * Plannotator's annotation, a guided review's draft held back (it goes with
 * the person's verdict), and places as `read_thread` words them.
 */
export const INBOX_COMMENT_READING: ReviewRecordReading<InboxAnnotationRecord, InboxCommentAnchor> = {
  on: inboxCommentAnchor,
  quote: (record) => text(record.annotation.originalText) || text(record.annotation.selectedText) || text(record.annotation.originalCode),
  text: (record) => text(record.annotation.text),
  isDeletion: (record) => record.annotation.type === "DELETION",
  heldBack: (record) => !!record.guide,
  place: inboxCommentPlace,
  withLines: (on, lines) => (on.kind === "file" && !on.lines ? { ...on, lines } : on),
};

/**
 * The title of the section that sends the person's replies under their
 * comments. A feedback section of the reply, as the others (the window draws
 * it with them, packages/inbox/replyFeedback.ts).
 */
export const INBOX_COMMENT_REPLIES_TITLE = "Feedback on comment threads";

/**
 * The person's replies and sub-threads a Send carries, as a section of its
 * feedback, oldest first: a reply under the comment it answers (its id,
 * where it is, its words); a sub-thread under the message whose passage it
 * is on, with the passage and, when `messages` holds that message, the words
 * around it (`In: "…"`); then the person's words. Each heading ends with the
 * entry's own id, as every entry of a Send does. Empty when there is none.
 */
export function inboxCommentRepliesFeedback(records: readonly InboxAnnotationRecord[], root: string, messages: ReadonlyMap<string, InboxCommentMessage> = new Map()): string {
  const under = inboxCommentsInOrder(records.filter(isInboxCommentUnderAnother));
  if (under.length === 0) return "";
  const entries = under.map((record, index) => inboxCommentEntry(record, index + 1, root, messages));
  const intro = under.some(isInboxSubThread)
    ? "My replies under comments I sent earlier, and my comments on a passage of one of their messages; each heading names the message it is under."
    : "My replies under comments I sent earlier; each heading names the comment it is under.";
  return [`# ${INBOX_COMMENT_REPLIES_TITLE}`, intro, ...entries].join("\n\n");
}

/**
 * Where a run of lines moved to: the start (from 1) of the `count` lines of
 * `lines` that `matches` accepts, nearest to `start`, or null when no run
 * reads as it did. A code comment keeps its lines when the agent adds or
 * removes lines above them; the comment's own lines say what "reads as it
 * did" means (its text, or its hash for a long excerpt).
 */
export function inboxMovedLines(lines: readonly string[], start: number, count: number, matches: (text: string) => boolean): number | null {
  if (count < 1 || lines.length < count) return null;
  const at = (first: number) => first >= 1 && first + count - 1 <= lines.length && matches(lines.slice(first - 1, first - 1 + count).join("\n"));
  if (at(start)) return start;
  const last = lines.length - count + 1;
  for (let distance = 1; distance <= Math.max(start - 1, last - start); distance++) {
    if (at(start - distance)) return start - distance;
    if (at(start + distance)) return start + distance;
  }
  return null;
}
