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
 * Browser-safe and zero-dep.
 */

import { INBOX_MESSAGE_COMMENT_TEXT_MAX, readInboxVideoTime, type InboxAnnotationRecord, type InboxCommentReplyRecord } from "./inbox-attachments";
import { formatInboxVideoTime } from "./inbox-types";
import { passageWindow } from "./passage";
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

/** One comment of a thread once sent (or, when asked, a draft of the person's). */
export interface InboxCommentThread {
  /** The comment's id: the one its feedback heading names (` (id …)`). */
  id: string;
  /** What carried it to the agent: the person's reply, or a comment send (`snd_…`, inbox-comment-sends.ts); '' for a draft. */
  reply_id: string;
  /** The round it was sent in, from 1; a draft's, the round under way, which its Send goes in. */
  round: number;
  /** A draft of the person's, listed only when asked (`inboxCommentThreads`' `drafts`): not sent yet. */
  draft?: true;
  state: InboxCommentState;
  on: InboxCommentAnchor;
  /** The words, lines or part it is on, as the person selected them. */
  quote: string;
  /** The comment. */
  text: string;
  /** Its words were not found in the file the last time the window showed it. */
  unanchored: boolean;
  /** The replies under it, oldest first: the agent's, and the person's that a Send carried. */
  replies: InboxCommentReply[];
  /** A sub-thread: the message whose passage it is on (`quote` is the passage); absent on a comment on a file, a message or a guided review. */
  parent?: InboxSubThreadParent;
}

/** One message of a comment thread, as a sub-thread on a passage of it reads it. */
export interface InboxCommentMessage {
  /** `comment`: a comment or a sub-thread (a thread of its own); `reply`: a reply under one (`under`). */
  kind: "comment" | "reply";
  under?: string;
  author: InboxCommentAuthor;
  /** Its words, whole. */
  text: string;
}

/** The message a sub-thread is on: its id, where the passage starts in its words, and the message (absent when it is not found). */
export interface InboxSubThreadParent extends Partial<InboxCommentMessage> {
  id: string;
  quote_offset: number;
}

/** Who wrote a reply under a comment. */
export type InboxCommentAuthor = { kind: "person" } | InboxCommentReplyRecord["from"];

/** One reply under a sent comment. */
export interface InboxCommentReply {
  /** `rep_…` for the agent's; the person's is a comment record's id, as its feedback heading names it. */
  id: string;
  author: InboxCommentAuthor;
  /** The round it was written in: the person's, the round of the Send that carried it; the agent's, the round under way then (`inboxCommentReplyRound`). */
  round: number;
  /** What it came with: the person's Send (their reply, or a comment send), or the agent's message; '' for a draft and for the agent's replies sent alone. */
  message_id: string;
  text: string;
  at: string;
  /** The person's draft, listed only when asked (`drafts`): its round is the one under way. */
  draft?: true;
}

/** The longest reply under a comment, in characters (a message comment's limit). */
export const INBOX_COMMENT_REPLY_TEXT_MAX = INBOX_MESSAGE_COMMENT_TEXT_MAX;

const REPLY_ID_RE = /^rep_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A new id for an agent's reply under a comment. */
export function inboxCommentReplyId(now?: number): string {
  return `rep_${ulid(now)}`;
}

export function isInboxCommentReplyId(value: unknown): value is string {
  return typeof value === "string" && REPLY_ID_RE.test(value);
}

/** A new id for one send_message's replies sent alone, which they share (`InboxCommentReplyRecord.call`). */
export function inboxCommentReplyCallId(now?: number): string {
  return `call_${ulid(now)}`;
}

/** A reply's words as kept: trimmed, or null when there are none or more than INBOX_COMMENT_REPLY_TEXT_MAX. */
export function inboxCommentReplyText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || text.length > INBOX_COMMENT_REPLY_TEXT_MAX ? null : text;
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
  return typeof record.re === "string" && record.re !== "";
}

/** Whether a comment record is a sub-thread: the person's comment on a passage of a message of a thread (`parent`). */
export function isInboxSubThread(record: Pick<InboxAnnotationRecord, "parent">): boolean {
  return typeof record.parent === "string" && record.parent !== "";
}

/**
 * Whether a comment record sits under another message of a thread, a reply
 * or a sub-thread: never painted on the file or the message, since its place
 * there is its thread's first comment's, and sent in its own section.
 */
export function isInboxCommentUnderAnother(record: Pick<InboxAnnotationRecord, "re" | "parent">): boolean {
  return isInboxCommentReply(record) || isInboxSubThread(record);
}

/**
 * Every message of the comment threads a sub-thread can be on, by id: the
 * person's sent comments, replies and sub-threads (`records`, drafts left
 * out: a passage is commented once its words reached the agent) and the
 * agents' replies.
 */
export function inboxCommentMessages(records: readonly InboxAnnotationRecord[], agentReplies: readonly InboxCommentReplyRecord[] = []): Map<string, InboxCommentMessage> {
  const out = new Map<string, InboxCommentMessage>();
  for (const record of records) {
    if (!isInboxCommentSent(record)) continue;
    const words = text(record.annotation.text);
    out.set(record.id, isInboxCommentReply(record) ? { kind: "reply", under: record.re!, author: { kind: "person" }, text: words } : { kind: "comment", author: { kind: "person" }, text: words });
  }
  for (const reply of agentReplies) out.set(reply.id, { kind: "reply", under: reply.re, author: reply.from, text: reply.text });
  return out;
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
  const up = new Map<string, string>();
  for (const record of records) {
    const above = isInboxCommentReply(record) ? record.re : isInboxSubThread(record) ? record.parent : undefined;
    if (above) up.set(record.id, above);
  }
  for (const reply of agentReplies) up.set(reply.id, reply.re);
  const out = new Set<string>();
  for (const record of records) {
    if (!isInboxSubThread(record) || !isOpen(record.id)) continue;
    for (let id: string | undefined = record.parent; id !== undefined && !out.has(id); id = up.get(id)) out.add(id);
  }
  return out;
}

/**
 * Whether a thread is folded: resolved, with nothing open under it at any
 * depth (`openBelow`, inboxOpenSubThreadPaths). A resolved thread with an
 * open sub-thread under it stays unfolded, marked resolved, as in crit.
 */
export function isInboxCommentThreadFolded(id: string, resolved: ReadonlySet<string>, openBelow: ReadonlySet<string>): boolean {
  return resolved.has(id) && !openBelow.has(id);
}

/** What each reply or sub-thread sits under, by its id: a reply's comment (the person's or an agent's), a sub-thread's parent. */
export function inboxCommentSitsUnder(
  records: readonly Pick<InboxAnnotationRecord, "id" | "re" | "parent">[],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "id" | "re">[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const record of records) {
    if (isInboxCommentReply(record)) out.set(record.id, record.re!);
    else if (isInboxSubThread(record)) out.set(record.id, record.parent!);
  }
  for (const reply of agentReplies) out.set(reply.id, reply.re);
  return out;
}

/**
 * The messages that a folded thread hides, by id: every reply or sub-thread
 * (`ids`) with a folded comment or sub-thread above it (`up`, what each sits
 * under, inboxCommentSitsUnder). A thread folds when it is resolved with
 * nothing open below it, so an open sub-thread is never hidden.
 */
export function inboxCommentsHiddenUnderFolded(ids: Iterable<string>, up: ReadonlyMap<string, string>, folded: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (folded.size === 0) return out;
  for (const id of ids) {
    const seen = new Set<string>();
    for (let above = up.get(id); above !== undefined && !seen.has(above); above = up.get(above)) {
      seen.add(above);
      if (folded.has(above)) {
        out.add(id);
        break;
      }
    }
  }
  return out;
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
export type InboxCommentState = "open" | "resolved";

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
  const resolved = record.resolved_at;
  if (typeof resolved !== "string") return "open";
  return lastReplyAt !== null && lastReplyAt > resolved ? "open" : "resolved";
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
  const out = new Map<string, string>();
  const note = (id: string, at: string) => {
    const known = out.get(id);
    if (known === undefined || at > known) out.set(id, at);
  };
  for (const record of records) if (isInboxCommentReply(record) && record.removed_at === null) note(record.re!, record.created_at);
  for (const reply of agentReplies) note(reply.re, reply.created_at);
  return out;
}

/** What a round needs of a message: its id and who wrote it. */
export interface InboxCommentRoundMessage {
  id: string;
  author: { kind: string };
}

/** What a thread of comments needs of a message: its round's part, and when it was written (the agent's replies' round). */
export interface InboxCommentThreadMessage extends InboxCommentRoundMessage {
  created_at: string;
}

/**
 * What a round needs of a comment send (`InboxCommentSend`,
 * inbox-comment-sends.ts): its order, its mode and its press (`batch`, shared
 * by the sends one press writes, one per session); and, for an agent's
 * reply's round, when it reached its session or a session it tags.
 */
export interface InboxCommentRoundSend {
  id: string;
  batch: string;
  mode: "now" | "round";
  created_at: string;
  to?: { session: string };
  delivery?: { at: string } | null;
  read_at?: string | null;
  tags?: readonly { session: string; delivery?: { at: string } | null; read_at?: string | null }[];
}

/**
 * When a comment send reached `session`: the earliest of its delivery and its
 * read, its own session's (`to`, also when `session` is null) or a tagged
 * session's own; null while it has not.
 */
export function inboxCommentSendReceivedAt(send: Pick<InboxCommentRoundSend, "to" | "delivery" | "read_at" | "tags">, session: string | null = null): string | null {
  const own = session === null || send.to?.session === session;
  const tag = own ? undefined : send.tags?.find((tagged) => tagged.session === session);
  const times = own ? [send.delivery?.at, send.read_at] : tag ? [tag.delivery?.at, tag.read_at] : [];
  return times.filter((time): time is string => typeof time === "string").sort()[0] ?? null;
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
  let round = 1;
  for (const message of messages) {
    const of = rounds.get(message.id);
    if (of !== undefined && message.created_at <= at && of > round) round = of;
  }
  for (const send of sends) {
    const of = rounds.get(send.id);
    const received = inboxCommentSendReceivedAt(send, session);
    if (of !== undefined && received !== null && received <= at && of > round) round = of;
  }
  return round;
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
  return record.sent_reply_id !== null && record.removed_at === null;
}

/**
 * The rounds of a thread, one numbering in the thread's order (messages and
 * comment sends by time; a send after a message of the same instant):
 *
 * - a reply of the person's that carried comments (written before comment
 *   sends, or by a client without them): a round ends when an agent writes in
 *   the thread, so the person's replies before that answer (one Send to two
 *   sessions writes two) share their round;
 * - a comment send (inbox-comment-sends.ts): a `now` send leaves its round
 *   open, whoever writes after it, and a `round` send (the person's Finish)
 *   ends it, so the round is the count of Finishes before it, plus one; the
 *   sends of one press (`batch`, one per session) are one step.
 *
 * `now`: the round a new send is in.
 */
function walkRounds(
  thread: readonly InboxCommentThreadMessage[],
  records: readonly Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at">[],
  sends: readonly InboxCommentRoundSend[],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "call" | "from" | "created_at">[] = [],
): { rounds: Map<string, number>; now: number } {
  // The agent's replies sent alone answer as its messages do.
  const messages = inboxCommentWrites(thread, agentReplies);
  const carriers = new Set<string>();
  for (const record of records) if (isInboxCommentSent(record)) carriers.add(record.sent_reply_id!);
  const rounds = new Map<string, number>();
  let round = 0;
  // closed: the next carrier opens a round; replies: a reply that carried comments opened it, and an agent's message ends it; sends: only a Finish ends it.
  let state: "closed" | "replies" | "sends" = "closed";
  const ordered = [...sends].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const presses = new Map<string, number>();
  let next = 0;
  const sendsBefore = (at: string | null) => {
    for (; next < ordered.length && (at === null || ordered[next]!.created_at < at); next++) {
      const send = ordered[next]!;
      const pressed = presses.get(send.batch);
      if (pressed !== undefined) {
        rounds.set(send.id, pressed);
        continue;
      }
      if (state === "closed") round += 1;
      rounds.set(send.id, round);
      presses.set(send.batch, round);
      state = send.mode === "round" ? "closed" : "sends";
    }
  };
  for (const message of messages) {
    sendsBefore(message.created_at);
    if (message.author.kind !== "person") {
      if (state === "replies") state = "closed";
      continue;
    }
    if (!carriers.has(message.id)) continue;
    if (state === "closed") round += 1;
    // A reply that carried comments waits for the agent's answer, as such replies always did, even inside a round sends opened.
    state = "replies";
    rounds.set(message.id, round);
  }
  sendsBefore(null);
  return { rounds, now: state === "closed" ? round + 1 : round };
}

/**
 * Each reply that carried comments, and each comment send (`sends`), by id,
 * with its round (from 1), in the thread's order (`walkRounds`). With no
 * sends, a round ends when an agent writes in the thread (a message, or
 * replies sent alone: `agentReplies`): the person's replies before that
 * answer (one Send to two sessions writes two) share their round.
 */
export function inboxCommentRounds(
  messages: readonly InboxCommentThreadMessage[],
  records: readonly Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at">[],
  sends: readonly InboxCommentRoundSend[] = [],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "call" | "from" | "created_at">[] = [],
): Map<string, number> {
  return walkRounds(messages, records, sends, agentReplies).rounds;
}

/** The round under way: the one a new comment send is in, and the counter a thread shows (1 before anything was sent). */
export function inboxCommentRoundNow(
  messages: readonly InboxCommentThreadMessage[],
  records: readonly Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at">[],
  sends: readonly InboxCommentRoundSend[] = [],
  agentReplies: readonly Pick<InboxCommentReplyRecord, "call" | "from" | "created_at">[] = [],
): number {
  return walkRounds(messages, records, sends, agentReplies).now;
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
  const { rounds, now } = walkRounds(messages, records, sends, agentReplies);
  const replies = new Map<string, InboxCommentReply[]>();
  const add = (id: string, reply: InboxCommentReply) => replies.set(id, [...(replies.get(id) ?? []), reply]);
  const listed: { record: InboxAnnotationRecord; carrier: string; round: number; draft: boolean }[] = [];
  for (const record of records) {
    // A guided review's draft is the review app's to show, with the person's verdict.
    const draft = options.drafts === true && record.sent_reply_id === null && record.removed_at === null && !record.guide;
    // The person's view (`drafts`) also lists a comment whose carrier it has not read yet (a Send just made): in the round under way.
    const round = draft ? now : isInboxCommentSent(record) ? (rounds.get(record.sent_reply_id!) ?? (options.drafts === true ? now : undefined)) : undefined;
    if (round === undefined) continue;
    const carrier = draft ? "" : record.sent_reply_id!;
    const mark = draft ? { draft: true as const } : {};
    if (isInboxCommentReply(record)) add(record.re!, { id: record.id, author: { kind: "person" }, round, message_id: carrier, text: text(record.annotation.text), at: record.created_at, ...mark });
    listed.push({ record, carrier, round, draft });
  }
  for (const reply of agentReplies) {
    const round = inboxCommentReplyRound(messages, rounds, reply.created_at, sends, reply.from.session);
    add(reply.re, { id: reply.id, author: reply.from, round, message_id: reply.message_id ?? "", text: reply.text, at: reply.created_at });
  }
  const last = inboxCommentLastReplies(
    records.filter((record) => isInboxCommentSent(record) || (options.drafts === true && record.sent_reply_id === null)),
    agentReplies,
  );
  const messagesById = inboxCommentMessages(records, agentReplies);
  const out: (InboxCommentThread & { created_at: string })[] = listed
    .filter(({ record }) => !isInboxCommentReply(record))
    .map(({ record, carrier, round, draft }) => {
      const annotation = record.annotation;
      const parent = isInboxSubThread(record) ? { id: record.parent!, quote_offset: inboxQuoteOffset(record), ...messagesById.get(record.parent!) } : null;
      return {
        id: record.id,
        reply_id: carrier,
        round,
        ...(draft ? { draft: true as const } : {}),
        state: inboxCommentState(record, last.get(record.id) ?? null),
        on: inboxCommentAnchor(record),
        quote: text(annotation.originalText) || text(annotation.selectedText) || text(annotation.originalCode),
        text: text(annotation.text),
        unanchored: typeof record.unanchored_at === "string",
        // By time; replies written in the same millisecond keep the order they were written in (a stable sort).
        replies: (replies.get(record.id) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
        ...(parent ? { parent } : {}),
        created_at: record.created_at,
      };
    });
  // Oldest round first; in the round under way, what was sent before the drafts.
  out.sort((a, b) => a.round - b.round || Number(a.draft === true) - Number(b.draft === true) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return out.map(({ created_at: _created, ...thread }) => thread);
}

/** A sub-thread's `quote_offset`, 0 when it has none that reads as one. */
export function inboxQuoteOffset(record: Pick<InboxAnnotationRecord, "quote_offset">): number {
  const offset = record.quote_offset;
  return Number.isInteger(offset) && (offset as number) >= 0 ? (offset as number) : 0;
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
 * that message's card with the passage at its head.
 */
export function inboxSubThreadAnnotation(
  comment: Pick<InboxAnnotationRecord, "id" | "annotation">,
  sub: { id: string; parent: string; quote: string; text: string; createdA: number; mentions?: readonly string[] },
): Record<string, unknown> {
  return { ...inboxCommentReplyAnnotation(comment, sub), originalText: sub.quote, inReplyTo: sub.parent };
}

function shownPath(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, "");
  return base !== "" && (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)) ? path.slice(base.length + 1) : path;
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
  const parts = [`on ${shownPath(on.path, root)}${on.version === "sent" ? " (the version you sent)" : ""}`];
  if (on.lines) parts.push(`${lines(on.lines)} when commented`);
  if (on.at !== undefined) parts.push(`at ${formatInboxVideoTime(on.at)}`);
  return parts.join(" ");
}

/** How a message a passage is on is named: "comment <id>", or "reply <id> under comment <id>". */
function messageName(parent: InboxSubThreadParent): string {
  if (parent.kind === "reply") return `reply ${parent.id}${parent.under ? ` under comment ${parent.under}` : ""}`;
  return parent.kind === "comment" ? `comment ${parent.id}` : parent.id;
}

/**
 * Where a sent comment is, as `inboxCommentPlace` says it, and for a
 * sub-thread the message whose passage it is on first: "on a passage of
 * reply rep_… under comment c1 (on notes.md lines 3-4 when commented)".
 */
export function inboxCommentThreadPlace(thread: Pick<InboxCommentThread, "on" | "parent">, root: string): string {
  const place = inboxCommentPlace(thread.on, root);
  return thread.parent ? `on a passage of ${messageName(thread.parent)} (${place})` : place;
}

/**
 * A sub-thread's passage in the words around it, as an agent reads it: about
 * `max` characters, `…` where cut, and where the passage starts in them.
 */
export function inboxSubThreadWindow(thread: Pick<InboxCommentThread, "parent" | "quote">, max: number): { text: string; offset: number } | null {
  const parent = thread.parent;
  if (!parent || parent.text === undefined) return null;
  return passageWindow(parent.text, { quote: thread.quote, offset: parent.quote_offset }, max);
}

/** `inboxSubThreadWindow`'s words alone. */
export function inboxSubThreadWords(thread: Pick<InboxCommentThread, "parent" | "quote">, max: number): string | null {
  return inboxSubThreadWindow(thread, max)?.text ?? null;
}

/** The most of a passage's surrounding words a feedback entry carries, in characters. */
export const INBOX_SUB_THREAD_WORDS_SENT = 600;

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
export const INBOX_OPEN_COMMENTS_SENT = 20;

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
    return feedbackEntry(index + 1, `Round ${thread.round}, ${place}${quoted(thread.quote)}`, thread.id, inboxSubThreadWords(thread, INBOX_SUB_THREAD_WORDS_SENT), thread.text);
  });
  const intro = "The person has not resolved these comments from earlier rounds yet.";
  const rest = older > 0 ? [`${older} older open comment${older === 1 ? " is" : "s are"} not repeated here: read_thread lists every comment.`] : [];
  return [`# ${INBOX_OPEN_COMMENTS_TITLE}`, intro, ...entries, ...rest].join("\n\n");
}

/** A quote as an entry's heading ends: `: "…"` on one line, or nothing when there is none. */
function quoted(quote: string): string {
  const line = quote.replace(/\s+/g, " ").trim();
  return line ? `: "${line}"` : "";
}

/**
 * One entry of a feedback section an agent reads: its heading, ending with
 * the entry's id as every entry of a Send does; the words a sub-thread's
 * passage is in (`In: "…"`); then the person's words, every line quoted, so
 * the next heading starts a new entry.
 */
function feedbackEntry(number: number, heading: string, id: string, around: string | null, words: string): string {
  const lines = (words.trim() || "(no words)").split(/\r\n?|\n/).map((line) => `> ${line}`.trimEnd());
  return [`### ${number}. ${heading} (id ${id})`, ...(around ? [`In: "${around}"`] : []), ...lines].join("\n");
}

/** Comment records in the order the person wrote them (by time, then id): the order a Send lists them in. */
export function inboxCommentsInOrder<R extends Pick<InboxAnnotationRecord, "id" | "created_at">>(records: readonly R[]): R[] {
  return [...records].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
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
export function inboxCommentEntry(record: InboxAnnotationRecord, number: number, root: string, messages: ReadonlyMap<string, InboxCommentMessage> = new Map()): string {
  const quote = text(record.annotation.originalText) || text(record.annotation.selectedText) || text(record.annotation.originalCode);
  const words = text(record.annotation.text);
  if (isInboxCommentReply(record)) return feedbackEntry(number, `Reply under comment ${record.re}, ${inboxCommentPlace(inboxCommentAnchor(record), root)}${quoted(quote)}`, record.id, null, words);
  if (isInboxSubThread(record)) {
    const sub = { on: inboxCommentAnchor(record), quote: quote.replace(/\s+/g, " ").trim(), parent: { id: record.parent!, quote_offset: inboxQuoteOffset(record), ...messages.get(record.parent!) } };
    return feedbackEntry(number, `Comment ${inboxCommentThreadPlace(sub, root)}${quoted(quote)}`, record.id, inboxSubThreadWords(sub, INBOX_SUB_THREAD_WORDS_SENT), words);
  }
  const place = inboxCommentPlace(inboxCommentAnchor(record), root);
  if (record.annotation.type === "DELETION") return feedbackEntry(number, `Remove this, ${place}${quoted(quote)}`, record.id, null, words);
  return feedbackEntry(number, `Comment ${place}${quoted(quote)}`, record.id, null, words);
}

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
