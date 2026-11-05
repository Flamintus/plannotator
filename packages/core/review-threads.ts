/**
 * The comment threads of a review, whichever client shows it: the review
 * loop of #1116, on any target (a passage of an agent's message, a file's
 * words or lines, a plan). The person comments; the agent answers under each
 * comment by its id; the person answers back, opens a sub-thread on a
 * passage of any message of a thread, and alone resolves; sends carry the
 * person's drafts to the agent session, one at once (`now`, as crit's "Send
 * to agent") or every draft left at the end of a round (`round`, the
 * person's Finish, as crit's Finish Review).
 *
 * The rules read a client's records and keep no state of their own, so every
 * client and the agent agree on a review:
 *
 * - rounds: a `now` send leaves its round open, a Finish ends it; the round
 *   under way is the count of Finishes, plus one (`reviewRounds`,
 *   `reviewRoundNow`); a comment has its send's round, an agent's reply the
 *   round of the newest send its session had received;
 * - state: open once sent, resolved by the person, open again on a reply
 *   newer than the resolution (`reviewCommentState`);
 * - live threads: a thread a `now` send reached; the person's next replies in
 *   it go on their own (`reviewLiveThreads`);
 * - statuses of what a send carried: pending, delivered, read, working,
 *   replied (`reviewSendStatus`);
 * - the thread model (`reviewThreads`), the text an agent reads of a send
 *   (`reviewSendText`) and the versioned tree any client draws
 *   (`reviewThreadView`, `v: 1`).
 *
 * Two kinds of records follow these rules: the neutral `ReviewComment` of the
 * review journal (packages/shared/review-journal.ts: the screens, terminal
 * clients and the `plannotator threads` CLI), and the Plannotator Inbox's own
 * (inbox-comment-threads.ts, inbox-comment-sends.ts, which keep their types
 * and names). A `ReviewRecordReading` says how to read a client's record:
 * where it is, its words, and how a place is worded.
 *
 * Browser-safe and zero-dep.
 */

import { passageWindow } from "./passage";
import { ulid } from "./ulid";

// ──────────── Records ────────────

/** Where a comment of the review journal is, in its review's target. */
export type ReviewAnchor =
  /** A passage of an agent's message: the message of the session the person picked (`message_id` as the client names it). */
  | { kind: "message"; message_id: string }
  /** A file's words: its path as the client names it, and the lines they are on when known. */
  | { kind: "file"; path: string; lines?: [number, number] }
  /** The plan under review: the version commented and the lines, when known. */
  | { kind: "plan"; version?: number; lines?: [number, number] };

/** The agent session that wrote a reply. */
export interface ReviewAgent {
  kind: "agent";
  host: string | null;
  session: string | null;
  name: string | null;
}

/** Who wrote a message of a thread. */
export type ReviewAuthor = { kind: "person" } | ReviewAgent;

/** What the rules read of a comment record of the person's, whichever client keeps it. */
export interface ReviewCommentFields {
  /** The comment's id: the one an agent answers under. */
  id: string;
  /** The person's reply under a comment: that comment's id. */
  re?: string;
  /** A sub-thread: the message of a thread whose passage it is on (a comment, a reply, a sub-thread). */
  parent?: string;
  /** A sub-thread's passage: where it starts in its parent's words (passage.ts). */
  quote_offset?: number;
  created_at: string;
  removed_at: string | null;
  /** The send that carried it, `snd_…` (the Inbox's name: its carrier was once the person's reply); null while a draft. */
  sent_reply_id: string | null;
  /** Resolved by the person: when; null or absent while open. Only the person sets it. */
  resolved_at?: string | null;
  /** Its words were no longer found in the target the client last showed: when. */
  unanchored_at?: string | null;
}

/**
 * One comment of the person's in a review journal: a comment on the target,
 * a reply under a comment (`re`), or a sub-thread on a passage (`parent`). A
 * reply or a sub-thread is where its thread's first comment is (`on`). A
 * draft until a send carries it.
 */
export interface ReviewComment extends ReviewCommentFields {
  on: ReviewAnchor;
  /** The words it is on, as the person selected them; a sub-thread's passage. Empty for a comment on the whole target. */
  quote: string;
  /** The comment. */
  text: string;
  /** `deletion`: the person asks for the words to go. Absent: a comment. */
  type?: "comment" | "deletion";
  updated_at: string;
  /** The client's own drawing data (a Plannotator annotation, for instance), opaque to the rules. */
  annotation?: Record<string, unknown>;
  /** Lines under the comment's heading in what the agent reads of its round (an attached image's path, an element), as the client wrote them. */
  notes?: string[];
}

/** What the rules read of an agent's reply under a comment. */
export interface ReviewAgentReplyFields {
  /** `rep_…`. */
  id: string;
  /** The comment it is under. */
  re: string;
  from: ReviewAgent;
  text: string;
  created_at: string;
  /** The agent's message it came with, when it came with one (the Inbox's `send_message`). */
  message_id?: string;
}

/** An agent's reply under a comment, in a review journal: written once, never resolved, never the person's. */
export interface ReviewAgentReply extends ReviewAgentReplyFields {
  /** The caller's key: a retry with the same key writes nothing new. */
  idempotency_key?: string;
}

/** `now`: one draft at once, the round stays open; `round`: the person's Finish, every draft left, and the round ends. */
export type ReviewSendMode = "now" | "round";

/**
 * What a round needs of a send: its order, its mode and its press (`batch`,
 * shared by the sends one press writes, one per session); and, for an
 * agent's reply's round, when it reached its session or a session it tags.
 */
export interface ReviewRoundSend {
  id: string;
  batch: string;
  mode: ReviewSendMode;
  created_at: string;
  to?: { session: string };
  delivery?: { at: string } | null;
  read_at?: string | null;
  tags?: readonly { session: string; delivery?: { at: string } | null; read_at?: string | null }[];
}

/** One send of a review journal: what one press sends the agent session. */
export interface ReviewSend extends ReviewRoundSend {
  /** `snd_…`. */
  id: string;
  /** The agent session it goes to. */
  to: { host: string | null; session: string };
  /** The round it was sent in: `reviewRoundNow` when it was written. */
  round: number;
  /** What it carries, by id: the drafts it sent (each record's `sent_reply_id` is this send's id) and, on a Finish, the threads still open that went before, named only. */
  comments: string[];
  /** The person's own words sent with it, before the comments; null without. */
  words: string | null;
  /** The sender's key: a retry of the same press writes nothing new. */
  idempotency_key: string | null;
  /** It reached its session. */
  delivery?: { at: string } | null;
  /** Its session read the threads after it reached it. */
  read_at?: string | null;
}

// ──────────── Ids and words ────────────

const ID = "[0-9A-HJKMNP-TV-Z]{26}";
const SEND_ID_RE = new RegExp(`^snd_${ID}$`);
const REPLY_ID_RE = new RegExp(`^rep_${ID}$`);

/** A new send's id. */
export function reviewSendId(now?: number): string {
  return `snd_${ulid(now)}`;
}

export function isReviewSendId(value: unknown): value is string {
  return typeof value === "string" && SEND_ID_RE.test(value);
}

/** A new id for an agent's reply under a comment. */
export function reviewReplyId(now?: number): string {
  return `rep_${ulid(now)}`;
}

export function isReviewReplyId(value: unknown): value is string {
  return typeof value === "string" && REPLY_ID_RE.test(value);
}

/** A new id for a comment of the person's that a client without its own ids writes. */
export function reviewCommentId(now?: number): string {
  return `cmt_${ulid(now)}`;
}

/** The longest comment or reply, in characters. */
export const REVIEW_TEXT_MAX = 10_000;

/** Words as kept: trimmed, or null when there are none or more than `max`. */
export function reviewText(value: unknown, max = REVIEW_TEXT_MAX): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || text.length > max ? null : text;
}

// ──────────── What a record is ────────────

/** Whether a comment record is the person's reply under another comment (`re`). */
export function isReviewCommentReply(record: Pick<ReviewCommentFields, "re">): boolean {
  return typeof record.re === "string" && record.re !== "";
}

/** Whether a comment record is a sub-thread: the person's comment on a passage of a message of a thread (`parent`). */
export function isReviewSubThread(record: Pick<ReviewCommentFields, "parent">): boolean {
  return typeof record.parent === "string" && record.parent !== "";
}

/** Whether a comment record sits under another message of a thread, a reply or a sub-thread: sent in its own entry, never drawn on the target. */
export function isReviewCommentUnderAnother(record: Pick<ReviewCommentFields, "re" | "parent">): boolean {
  return isReviewCommentReply(record) || isReviewSubThread(record);
}

/** Whether a record is a comment the person sent (not a draft, not removed). */
export function isReviewCommentSent(record: Pick<ReviewCommentFields, "sent_reply_id" | "removed_at">): boolean {
  return record.sent_reply_id !== null && record.removed_at === null;
}

/** A sub-thread's `quote_offset`, 0 when it has none that reads as one. */
export function reviewQuoteOffset(record: Pick<ReviewCommentFields, "quote_offset">): number {
  const offset = record.quote_offset;
  return Number.isInteger(offset) && (offset as number) >= 0 ? (offset as number) : 0;
}

/** Comment records in the order the person wrote them (by time, then id): the order a send lists them in. */
export function reviewCommentsInOrder<R extends Pick<ReviewCommentFields, "id" | "created_at">>(records: readonly R[]): R[] {
  return [...records].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

// ──────────── State, sub-threads and folds ────────────

/** A sent comment is open until the person resolves it. */
export type ReviewCommentState = "open" | "resolved";

/**
 * A sent comment's state: resolved from when the person resolved it
 * (`resolved_at`) until they reopen it, or until a reply lands under it: a
 * reply newer than `resolved_at` (`lastReplyAt`, the newest reply's time,
 * `reviewCommentLastReplies`) opens it again, as a reply does in crit, with
 * nothing written.
 */
export function reviewCommentState(record: Pick<ReviewCommentFields, "resolved_at">, lastReplyAt: string | null = null): ReviewCommentState {
  const resolved = record.resolved_at;
  if (typeof resolved !== "string") return "open";
  return lastReplyAt !== null && lastReplyAt > resolved ? "open" : "resolved";
}

/**
 * The newest reply under each comment, by the comment's id: the agent's, and
 * the person's, a draft too (a draft reply under a resolved comment shows it
 * open again, and the person's Resolve then closes it again). A removed
 * reply counts for nothing.
 */
export function reviewCommentLastReplies(
  records: readonly Pick<ReviewCommentFields, "re" | "removed_at" | "created_at">[],
  agentReplies: readonly Pick<ReviewAgentReplyFields, "re" | "created_at">[] = [],
): Map<string, string> {
  const out = new Map<string, string>();
  const note = (id: string, at: string) => {
    const known = out.get(id);
    if (known === undefined || at > known) out.set(id, at);
  };
  for (const record of records) if (isReviewCommentReply(record) && record.removed_at === null) note(record.re!, record.created_at);
  for (const reply of agentReplies) note(reply.re, reply.created_at);
  return out;
}

/**
 * The messages that have an open sub-thread under them, at any depth, by id:
 * the sub-thread's parent, the comment a reply on the way is under, and so on
 * up to the thread's first comment. A resolved comment or sub-thread among
 * them stays unfolded while one is open, as in crit.
 */
export function reviewOpenSubThreadPaths(
  records: readonly Pick<ReviewCommentFields, "id" | "re" | "parent">[],
  agentReplies: readonly Pick<ReviewAgentReplyFields, "id" | "re">[],
  isOpen: (id: string) => boolean,
): Set<string> {
  const up = new Map<string, string>();
  for (const record of records) {
    const above = isReviewCommentReply(record) ? record.re : isReviewSubThread(record) ? record.parent : undefined;
    if (above) up.set(record.id, above);
  }
  for (const reply of agentReplies) up.set(reply.id, reply.re);
  const out = new Set<string>();
  for (const record of records) {
    if (!isReviewSubThread(record) || !isOpen(record.id)) continue;
    for (let id: string | undefined = record.parent; id !== undefined && !out.has(id); id = up.get(id)) out.add(id);
  }
  return out;
}

/** Whether a thread is folded: resolved, with nothing open under it at any depth (`openBelow`, reviewOpenSubThreadPaths). */
export function isReviewThreadFolded(id: string, resolved: ReadonlySet<string>, openBelow: ReadonlySet<string>): boolean {
  return resolved.has(id) && !openBelow.has(id);
}

/** What each reply or sub-thread sits under, by its id: a reply's comment (the person's or an agent's), a sub-thread's parent. */
export function reviewCommentSitsUnder(
  records: readonly Pick<ReviewCommentFields, "id" | "re" | "parent">[],
  agentReplies: readonly Pick<ReviewAgentReplyFields, "id" | "re">[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const record of records) {
    if (isReviewCommentReply(record)) out.set(record.id, record.re!);
    else if (isReviewSubThread(record)) out.set(record.id, record.parent!);
  }
  for (const reply of agentReplies) out.set(reply.id, reply.re);
  return out;
}

/**
 * The messages that a folded thread hides, by id: every reply or sub-thread
 * (`ids`) with a folded comment or sub-thread above it (`up`, what each sits
 * under, reviewCommentSitsUnder). An open sub-thread is never hidden.
 */
export function reviewCommentsHiddenUnderFolded(ids: Iterable<string>, up: ReadonlyMap<string, string>, folded: ReadonlySet<string>): Set<string> {
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

// ──────────── Rounds ────────────

/** What a round needs of a message of a conversation that carries comments (the Inbox's thread): its id and who wrote it. */
export interface ReviewRoundMessage {
  id: string;
  author: { kind: string };
}

/** What a thread of comments needs of such a message: its round's part, and when it was written. */
export interface ReviewThreadMessage extends ReviewRoundMessage {
  created_at: string;
}

/**
 * When a send reached `session`: the earliest of its delivery and its read,
 * its own session's (`to`, also when `session` is null) or a tagged
 * session's own; null while it has not.
 */
export function reviewSendReceivedAt(send: Pick<ReviewRoundSend, "to" | "delivery" | "read_at" | "tags">, session: string | null = null): string | null {
  const own = session === null || send.to?.session === session;
  const tag = own ? undefined : send.tags?.find((tagged) => tagged.session === session);
  const times = own ? [send.delivery?.at, send.read_at] : tag ? [tag.delivery?.at, tag.read_at] : [];
  return times.filter((time): time is string => typeof time === "string").sort()[0] ?? null;
}

/**
 * The round under way at `at`, for a reply the agent wrote then: the round of
 * the newest message of the person's that carried comments by then, or of the
 * newest send its session (`session`, when known) had received by then
 * (delivered or read: an agent answers what reached it). 1 at least.
 */
export function reviewReplyRound(
  messages: readonly ReviewThreadMessage[],
  rounds: ReadonlyMap<string, number>,
  at: string,
  sends: readonly ReviewRoundSend[] = [],
  session: string | null = null,
): number {
  let round = 1;
  for (const message of messages) {
    const of = rounds.get(message.id);
    if (of !== undefined && message.created_at <= at && of > round) round = of;
  }
  for (const send of sends) {
    const of = rounds.get(send.id);
    const received = reviewSendReceivedAt(send, session);
    if (of !== undefined && received !== null && received <= at && of > round) round = of;
  }
  return round;
}

/**
 * The rounds, one numbering in time order (`messages` and sends by time; a
 * send after a message of the same instant):
 *
 * - a send: a `now` send leaves its round open, whoever writes after it, and
 *   a `round` send (the person's Finish) ends it, so the round is the count
 *   of Finishes before it, plus one; the sends of one press (`batch`, one per
 *   session) are one step;
 * - a message of the person's that carried comments (`messages`: the Inbox's
 *   replies from before its sends; a review journal has none): a round ends
 *   when an agent writes, so the person's messages before that answer share
 *   their round.
 *
 * `now`: the round a new send is in.
 */
function walkRounds(
  messages: readonly ReviewThreadMessage[],
  records: readonly Pick<ReviewCommentFields, "sent_reply_id" | "removed_at">[],
  sends: readonly ReviewRoundSend[],
): { rounds: Map<string, number>; now: number } {
  const carriers = new Set<string>();
  for (const record of records) if (isReviewCommentSent(record)) carriers.add(record.sent_reply_id!);
  const rounds = new Map<string, number>();
  let round = 0;
  // closed: the next carrier opens a round; replies: a message that carried comments opened it, and an agent's message ends it; sends: only a Finish ends it.
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
    // A message that carried comments waits for the agent's answer, as such messages always did, even inside a round sends opened.
    state = "replies";
    rounds.set(message.id, round);
  }
  sendsBefore(null);
  return { rounds, now: state === "closed" ? round + 1 : round };
}

/** Each send, and each message of the person's that carried comments (`messages`), by id, with its round (from 1). */
export function reviewRounds(
  records: readonly Pick<ReviewCommentFields, "sent_reply_id" | "removed_at">[],
  sends: readonly ReviewRoundSend[] = [],
  messages: readonly ReviewThreadMessage[] = [],
): Map<string, number> {
  return walkRounds(messages, records, sends).rounds;
}

/** The round under way: the one a new send is in, and the counter a client shows (1 before anything was sent). */
export function reviewRoundNow(
  records: readonly Pick<ReviewCommentFields, "sent_reply_id" | "removed_at">[],
  sends: readonly ReviewRoundSend[] = [],
  messages: readonly ReviewThreadMessage[] = [],
): number {
  return walkRounds(messages, records, sends).now;
}

// ──────────── Live threads and statuses ────────────

/**
 * The live threads, by id: each a `now` send carried, or carried a reply of
 * the person's under. As crit's live threads, a thread stays live once it is:
 * the person's next replies in it go on their own (`reviewDraftIsLive`). A
 * sub-thread is a thread of its own: live once a `now` send carried it.
 */
export function reviewLiveThreads(
  sends: readonly Pick<ReviewSend, "id" | "mode" | "comments">[],
  records: readonly Pick<ReviewCommentFields, "id" | "re" | "sent_reply_id">[],
): Set<string> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const live = new Set<string>();
  for (const send of sends) {
    if (send.mode !== "now") continue;
    for (const id of send.comments) {
      const record = byId.get(id);
      if (record?.sent_reply_id !== send.id) continue;
      live.add(isReviewCommentReply(record) ? record.re! : record.id);
    }
  }
  return live;
}

/** Whether a draft goes on its own, as a `now` send: a reply of the person's under a live thread. */
export function reviewDraftIsLive(draft: Pick<ReviewCommentFields, "re" | "sent_reply_id" | "removed_at">, live: ReadonlySet<string>): boolean {
  return draft.sent_reply_id === null && draft.removed_at === null && isReviewCommentReply(draft) && live.has(draft.re!);
}

/** What became of an element a send carried, as the person sees it: never words for the agent. */
export type ReviewSendStatus = "pending" | "delivered" | "read" | "working" | "replied";

/**
 * The status a send gives an element it carried: `replied` once an agent
 * replied under its thread after the send reached its session
 * (`lastAgentReplyAt`, the newest agent's reply there; a reply before it
 * answered something else); else `working` while that session is busy
 * (`busy`: the caller knows the session's state); else `read`, `delivered`,
 * or `pending`.
 */
export function reviewSendStatus(send: Pick<ReviewRoundSend, "to" | "delivery" | "read_at">, lastAgentReplyAt: string | null, busy: boolean): ReviewSendStatus {
  const received = reviewSendReceivedAt(send);
  if (received === null) return "pending";
  if (lastAgentReplyAt !== null && lastAgentReplyAt > received) return "replied";
  if (busy) return "working";
  return typeof send.read_at === "string" ? "read" : "delivered";
}

// ──────────── The thread model ────────────

/** One message of a comment thread, as a sub-thread on a passage of it reads it. */
export interface ReviewCommentMessage {
  /** `comment`: a comment or a sub-thread (a thread of its own); `reply`: a reply under one (`under`). */
  kind: "comment" | "reply";
  under?: string;
  author: ReviewAuthor;
  /** Its words, whole. */
  text: string;
}

/** The message a sub-thread is on: its id, where the passage starts in its words, and the message (absent when it is not found). */
export interface ReviewSubThreadParent extends Partial<ReviewCommentMessage> {
  id: string;
  quote_offset: number;
}

/** One reply under a sent comment. */
export interface ReviewReply {
  /** `rep_…` for the agent's; the person's is a comment record's id. */
  id: string;
  author: ReviewAuthor;
  /** The round it was written in: the person's, its send's; the agent's, the round under way then (`reviewReplyRound`). */
  round: number;
  /** What carried the person's (a send), or the agent's message it came with; '' for a draft and for an agent's reply that came alone. */
  message_id: string;
  text: string;
  at: string;
  /** The person's draft, listed only when asked (`drafts`): its round is the one under way. */
  draft?: true;
}

/** One comment of a review once sent (or, when asked, a draft of the person's), on a client's anchor `A`. */
export interface ReviewThread<A = ReviewAnchor> {
  /** The comment's id: the one its entry names (` (id …)`). */
  id: string;
  /** What carried it to the agent: a send (`snd_…`), or a message of the person's that carried comments; '' for a draft. */
  reply_id: string;
  /** The round it was sent in, from 1; a draft's, the round under way. */
  round: number;
  /** A draft of the person's, listed only when asked: not sent yet. */
  draft?: true;
  state: ReviewCommentState;
  on: A;
  /** The words, lines or part it is on, as the person selected them. */
  quote: string;
  /** The comment. */
  text: string;
  /** Its words were not found in the target the last time the client showed it. */
  unanchored: boolean;
  /** The replies under it, oldest first: the agent's, and the person's that a send carried. */
  replies: ReviewReply[];
  /** A sub-thread: the message whose passage it is on (`quote` is the passage). */
  parent?: ReviewSubThreadParent;
}

/**
 * How the rules read a client's comment record `R`, whose anchor is `A`:
 * where it is, its words, what is held back from the person's drafts, and
 * how a place is worded for an agent. `REVIEW_COMMENT_READING` reads the
 * review journal's; the Inbox has its own (`INBOX_COMMENT_READING`).
 */
export interface ReviewRecordReading<R, A> {
  on(record: R): A;
  /** The words it is on, as the person selected them. */
  quote(record: R): string;
  /** The comment's words. */
  text(record: R): string;
  /** The person asks for the words to go: the entry says "Remove this". */
  isDeletion(record: R): boolean;
  /** A draft the person's view does not list. */
  heldBack(record: R): boolean;
  /** Where an anchor is, in words an agent reads ("on notes.md lines 3-4 when commented"); a file's path is shown from `root`. */
  place(on: A, root: string): string;
  /** The anchor with the lines a caller found (`ReviewEntryDetail`), when it names none and can carry them; else as it is. */
  withLines(on: A, lines: [number, number]): A;
}

/**
 * Every message of the comment threads a sub-thread can be on, by id: the
 * person's sent comments, replies and sub-threads (drafts left out: a passage
 * is commented once its words reached the agent) and the agents' replies.
 */
export function reviewCommentMessages<R extends ReviewCommentFields>(
  read: Pick<ReviewRecordReading<R, unknown>, "text">,
  records: readonly R[],
  agentReplies: readonly ReviewAgentReplyFields[] = [],
): Map<string, ReviewCommentMessage> {
  const out = new Map<string, ReviewCommentMessage>();
  for (const record of records) {
    if (!isReviewCommentSent(record)) continue;
    const words = read.text(record);
    out.set(record.id, isReviewCommentReply(record) ? { kind: "reply", under: record.re!, author: { kind: "person" }, text: words } : { kind: "comment", author: { kind: "person" }, text: words });
  }
  for (const reply of agentReplies) out.set(reply.id, { kind: "reply", under: reply.re, author: reply.from, text: reply.text });
  return out;
}

/**
 * The review's sent comments, oldest round first (then by when they were
 * made), each with its round, anchor, state and replies: the person's that a
 * send carried and the agent's (`agentReplies`). A comment has the round of
 * what carried it (`sends`, or a message of the person's among `messages`). A
 * record whose carrier is not given (a send that never landed) is left out,
 * except from the person's view (`drafts`), where it is in the round under way.
 *
 * `drafts`: the person's drafts too (a comment, a reply, a sub-thread; never
 * one the reading holds back), marked `draft`, in the round under way after
 * what was sent in it: a draft reply then opens a resolved comment again, as
 * the person sees it. Without it, what an agent reads: what was sent.
 */
export function reviewThreads<R extends ReviewCommentFields, A>(
  read: ReviewRecordReading<R, A>,
  records: readonly R[],
  agentReplies: readonly ReviewAgentReplyFields[] = [],
  sends: readonly ReviewRoundSend[] = [],
  options: { drafts?: boolean; messages?: readonly ReviewThreadMessage[] } = {},
): ReviewThread<A>[] {
  const messages = options.messages ?? [];
  const { rounds, now } = walkRounds(messages, records, sends);
  const replies = new Map<string, ReviewReply[]>();
  const add = (id: string, reply: ReviewReply) => replies.set(id, [...(replies.get(id) ?? []), reply]);
  const listed: { record: R; carrier: string; round: number; draft: boolean }[] = [];
  for (const record of records) {
    const draft = options.drafts === true && record.sent_reply_id === null && record.removed_at === null && !read.heldBack(record);
    // The person's view (`drafts`) also lists a comment whose carrier it has not read yet (a send just made): in the round under way.
    const round = draft ? now : isReviewCommentSent(record) ? (rounds.get(record.sent_reply_id!) ?? (options.drafts === true ? now : undefined)) : undefined;
    if (round === undefined) continue;
    const carrier = draft ? "" : record.sent_reply_id!;
    const mark = draft ? { draft: true as const } : {};
    if (isReviewCommentReply(record)) add(record.re!, { id: record.id, author: { kind: "person" }, round, message_id: carrier, text: read.text(record), at: record.created_at, ...mark });
    listed.push({ record, carrier, round, draft });
  }
  for (const reply of agentReplies) {
    const round = reviewReplyRound(messages, rounds, reply.created_at, sends, reply.from.session);
    add(reply.re, { id: reply.id, author: reply.from, round, message_id: reply.message_id ?? "", text: reply.text, at: reply.created_at });
  }
  const last = reviewCommentLastReplies(
    records.filter((record) => isReviewCommentSent(record) || (options.drafts === true && record.sent_reply_id === null)),
    agentReplies,
  );
  const messagesById = reviewCommentMessages(read, records, agentReplies);
  const out: (ReviewThread<A> & { created_at: string })[] = listed
    .filter(({ record }) => !isReviewCommentReply(record))
    .map(({ record, carrier, round, draft }) => {
      const parent = isReviewSubThread(record) ? { id: record.parent!, quote_offset: reviewQuoteOffset(record), ...messagesById.get(record.parent!) } : null;
      return {
        id: record.id,
        reply_id: carrier,
        round,
        ...(draft ? { draft: true as const } : {}),
        state: reviewCommentState(record, last.get(record.id) ?? null),
        on: read.on(record),
        quote: read.quote(record),
        text: read.text(record),
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

// ──────────── Words for the agent ────────────

/** How a message a passage is on is named: "comment <id>", or "reply <id> under comment <id>". */
function messageName(parent: ReviewSubThreadParent): string {
  if (parent.kind === "reply") return `reply ${parent.id}${parent.under ? ` under comment ${parent.under}` : ""}`;
  return parent.kind === "comment" ? `comment ${parent.id}` : parent.id;
}

/**
 * Where a sent comment is, as `place` words its anchor, and for a sub-thread
 * the message whose passage it is on first: "on a passage of reply rep_…
 * under comment c1 (on notes.md lines 3-4 when commented)".
 */
export function reviewThreadPlace<A>(place: (on: A, root: string) => string, thread: { on: A; parent?: ReviewSubThreadParent }, root: string): string {
  const where = place(thread.on, root);
  return thread.parent ? `on a passage of ${messageName(thread.parent)} (${where})` : where;
}

/** A sub-thread's passage in the words around it, as an agent reads it: about `max` characters, `…` where cut, and where the passage starts in them. */
export function reviewSubThreadWindow(thread: { quote: string; parent?: ReviewSubThreadParent }, max: number): { text: string; offset: number } | null {
  const parent = thread.parent;
  if (!parent || parent.text === undefined) return null;
  return passageWindow(parent.text, { quote: thread.quote, offset: parent.quote_offset }, max);
}

/** `reviewSubThreadWindow`'s words alone. */
export function reviewSubThreadWords(thread: { quote: string; parent?: ReviewSubThreadParent }, max: number): string | null {
  return reviewSubThreadWindow(thread, max)?.text ?? null;
}

/** The most of a passage's surrounding words an entry carries, in characters. */
export const REVIEW_SUB_THREAD_WORDS_SENT = 600;

/** A quote as an entry's heading ends: `: "…"` on one line, or nothing when there is none. */
export function reviewQuoted(quote: string): string {
  const line = quote.replace(/\s+/g, " ").trim();
  return line ? `: "${line}"` : "";
}

/**
 * One entry of what an agent reads: its heading, ending with the entry's id;
 * the words a sub-thread's passage is in (`In: "…"`); lines a caller adds
 * (`notes`); then the person's words, every line quoted, so the next heading
 * starts a new entry.
 */
export function reviewFeedbackEntry(number: number, heading: string, id: string, around: string | null, words: string, notes: readonly string[] = []): string {
  const lines = (words.trim() || "(no words)").split(/\r\n?|\n/).map((line) => `> ${line}`.trimEnd());
  return [`### ${number}. ${heading} (id ${id})`, ...(around ? [`In: "${around}"`] : []), ...notes, ...lines].join("\n");
}

/** What a caller may add to a record's entry: nothing by default. */
export interface ReviewEntryDetail {
  /** The lines the comment is on, when its anchor names none (a document's, found by the caller). */
  lines?: [number, number];
  /** Lines under the heading, before the person's words (attached images, an element, a diagram part, tags). */
  notes?: readonly string[];
}

/**
 * One comment record as an entry of what a send carries, numbered `number`,
 * named by its id, where it is and the words it is on:
 *
 * - a reply under a comment: "Reply under comment <id>, <place>";
 * - a sub-thread: "Comment on a passage of <message> (<place>)", or "Remove
 *   this, on a passage of …" for a deletion, and, when `messages` holds that
 *   message, the words around the passage (`In:`);
 * - any other comment: "Comment <place>", or "Remove this, <place>" for a
 *   deletion.
 */
export function reviewCommentEntry<R extends ReviewCommentFields, A>(
  read: ReviewRecordReading<R, A>,
  record: R,
  number: number,
  root: string,
  messages: ReadonlyMap<string, ReviewCommentMessage> = new Map(),
  detail: ReviewEntryDetail = {},
): string {
  const quote = read.quote(record);
  const words = read.text(record);
  const notes = detail.notes ?? [];
  const anchor = read.on(record);
  const on = detail.lines ? read.withLines(anchor, detail.lines) : anchor;
  if (isReviewCommentReply(record)) return reviewFeedbackEntry(number, `Reply under comment ${record.re}, ${read.place(on, root)}${reviewQuoted(quote)}`, record.id, null, words, notes);
  if (isReviewSubThread(record)) {
    const sub = { on, quote: quote.replace(/\s+/g, " ").trim(), parent: { id: record.parent!, quote_offset: reviewQuoteOffset(record), ...messages.get(record.parent!) } };
    const lead = read.isDeletion(record) ? "Remove this," : "Comment";
    return reviewFeedbackEntry(number, `${lead} ${reviewThreadPlace(read.place, sub, root)}${reviewQuoted(quote)}`, record.id, reviewSubThreadWords(sub, REVIEW_SUB_THREAD_WORDS_SENT), words, notes);
  }
  const place = read.place(on, root);
  if (read.isDeletion(record)) return reviewFeedbackEntry(number, `Remove this, ${place}${reviewQuoted(quote)}`, record.id, null, words, notes);
  return reviewFeedbackEntry(number, `Comment ${place}${reviewQuoted(quote)}`, record.id, null, words, notes);
}

/** The title of the text a send gives the agent. */
export const REVIEW_SEND_TITLE = "Comments on your work";

/** A send names at most this many threads still open, the newest; the rest are counted. */
export const REVIEW_OPEN_THREADS_NAMED = 20;

/**
 * How the agent that reads a send answers and reads the rest, as its client
 * tells it (the Inbox's `send_message`, the `plannotator` tool, the CLI):
 *
 * - `read`: the sentence that follows the threads still open, named by id,
 *   saying where their words and replies are ("read_thread has their words
 *   and replies.");
 * - `reply`: how to answer under an id, the section's last paragraph when
 *   there is something to answer; none when the agent's own tools already say;
 * - `wake`: the same in one sentence, for the line a send wakes the agent
 *   with (`reviewSendWakeText`): how to read the round and answer under ids.
 */
export interface ReviewReplyHow {
  read: string;
  reply?: string;
  wake?: string;
}

/**
 * What one session reads of its sends, oldest first (one, or the ones not yet
 * delivered that one delivery takes together), composed from the records:
 * after the person's own words (`words`), a section with what the round is,
 * one entry per comment, reply and sub-thread the sends carried, and, after a
 * Finish, the threads still open named by id and counted, their words not
 * repeated; then how to answer (`how`). A `now` send says the round is still open.
 */
export function reviewSendText<R extends ReviewCommentFields, A>(
  read: ReviewRecordReading<R, A>,
  input: {
    sends: readonly Pick<ReviewSend, "id" | "created_at" | "mode" | "round" | "comments">[];
    /** The review's comment records. */
    records: readonly R[];
    agentReplies?: readonly ReviewAgentReplyFields[];
    /** The project's root: a file's place is shown from it. */
    root: string;
    words?: string;
    /** What the caller knows of each entry beyond its record (`reviewCommentEntry`'s `detail`). */
    detail?: (record: R) => ReviewEntryDetail;
    how: ReviewReplyHow;
  },
): string {
  const words = input.words?.trim() ?? "";
  const sends = [...input.sends].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (sends.length === 0) return words;
  const ids = new Set(sends.map((send) => send.id));
  const carried = reviewCommentsInOrder(input.records.filter((record) => record.sent_reply_id !== null && ids.has(record.sent_reply_id) && record.removed_at === null));
  const carriedIds = new Set(carried.map((record) => record.id));
  const named = [...new Set(sends.filter((send) => send.mode === "round").flatMap((send) => send.comments))].filter((id) => !carriedIds.has(id));
  const messages = reviewCommentMessages(read, input.records, input.agentReplies ?? []);
  const entries = carried.map((record, index) => reviewCommentEntry(read, record, index + 1, input.root, messages, input.detail?.(record)));
  const last = sends.at(-1)!;
  const finished = sends.filter((send) => send.mode === "round").reduce<number | null>((round, send) => (round === null || send.round > round ? send.round : round), null);
  const done = finished !== null ? `The person finished round ${finished}.` : "";
  const nothing = entries.length === 0 && named.length === 0;
  const intro =
    last.mode === "now"
      ? `${done ? `${done} ` : ""}Round ${last.round} is still open: the person may send more. Answer under each id now; do not wait for the round to end.`
      : nothing
        ? `${done} No comment is open.`
        : `${done} Answer under each id.`;
  const shown = named.slice(-REVIEW_OPEN_THREADS_NAMED);
  const older = named.length - shown.length;
  const open = named.length > 0 ? [`Still open, already sent to you (${named.length}): ${shown.join(", ")}${older > 0 ? ` and ${older} older` : ""}. ${input.how.read}`] : [];
  const reply = input.how.reply && !nothing ? [input.how.reply] : [];
  const section = [`# ${REVIEW_SEND_TITLE}`, intro, ...entries, ...open, ...reply].join("\n\n");
  return words ? `${words}\n\n${section}` : section;
}

/**
 * The line a send wakes the agent with, after its host's heading
 * (`Plannotator: notes.md (pn-3f2a9c) — Round 2 done · 3 comments.`): a
 * round is not a message (#1116), so the agent's conversation gets one line
 * saying how to read the round and answer under its ids (`how.wake`), and to
 * end the turn with no message in chat. What the round carries (the person's
 * words, each comment, the threads still open) is read with `threads`, where
 * `reviewSendText` composes it. A round with nothing to read says so.
 */
export function reviewSendWakeText(input: { sends: readonly Pick<ReviewSend, "mode" | "comments" | "words">[]; how: { wake: string } }): string {
  const empty = input.sends.every((send) => send.comments.length === 0 && !send.words?.trim());
  if (empty) return "No comment is open: nothing to answer. End your turn without a message in chat.";
  const now = input.sends.at(-1)?.mode === "now" ? " Answer now: the round is still open." : "";
  return `${input.how.wake}${now} Then end your turn without a message in chat: the person reads your replies in Plannotator.`;
}

// ──────────── The thread view ────────────

/** The thread view's shape: a client checks it before it reads the rest. */
export const REVIEW_THREAD_VIEW_VERSION = 1;

/** One reply under a thread in the view, with the sub-threads on its words. */
export interface ReviewReplyNode<A = ReviewAnchor> extends Omit<ReviewReply, "draft"> {
  /** The agent's name as people read it ("Claude Code"); null for the person's, whom a client names itself ("You"). */
  author_name: string | null;
  /** The person's reply not sent yet: its round is the one under way. */
  draft: boolean;
  /** The person's reply a send carried: what became of it. */
  status?: ReviewSendStatus;
  sub_threads: ReviewThreadNode<A>[];
  /**
   * Replies to this reply, for a source whose replies nest (the document
   * editor's `inReplyTo` chains). The rules never fill it: replies are one
   * flat list under their thread, as crit's, and depth comes from
   * sub-threads, each on a passage.
   */
  replies?: ReviewReplyNode<A>[];
}

/** One thread in the view: a comment, or a sub-thread under the message whose passage it is on. */
export interface ReviewThreadNode<A = ReviewAnchor> extends Omit<ReviewThread<A>, "replies" | "parent" | "draft"> {
  /** A sub-thread: the message it is on (its parent node in the tree, or a message no longer found), and where the passage starts in its words. */
  parent?: { id: string; quote_offset: number };
  /** The person's draft, not sent yet (`reply_id` is ''; its round is the one under way). */
  draft: boolean;
  /** `deletion`: the person asks for the words to go (the reading's `isDeletion`); a client that edits or reopens it keeps it. */
  type: "comment" | "deletion";
  /** Drawn folded: resolved, with nothing open under it at any depth (`isReviewThreadFolded`). */
  folded: boolean;
  /** A thread a send carried: what became of it. */
  status?: ReviewSendStatus;
  /** A `now` send reached it: the person's next replies in it go on their own. */
  live: boolean;
  replies: ReviewReplyNode<A>[];
  /** The sub-threads on its own words. */
  sub_threads: ReviewThreadNode<A>[];
}

/** The comment threads of a review, as any client draws them. */
export interface ReviewThreadView<A = ReviewAnchor> {
  v: typeof REVIEW_THREAD_VIEW_VERSION;
  /** The round under way (`reviewRoundNow`). */
  round: number;
  /** The threads, oldest round first (the drafts after what was sent in the round under way), each sub-thread under the message it is on. */
  threads: ReviewThreadNode<A>[];
}

/** An agent's name when the client names none of its own: its stored name, else its host, else "An agent". */
function plainAgentName(author: ReviewAgent): string {
  return author.name || author.host || "An agent";
}

/**
 * The comment threads as a tree, from the thread model (`reviewThreads`,
 * drafts included) plus what the sends give: each element's status (`busy`
 * names the sessions in a turn now) and whether a thread is live; and whether
 * each thread is folded. It shows what it is given: the person's drafts among
 * `records` are listed (`draft`) and open a resolved comment again; without
 * them it is what was sent. A sub-thread sits under the message it is on, at
 * any depth; one whose message is gone, or that a broken writer left in a
 * loop, sits at the top. `agentName` names an agent ("Claude Code").
 */
export function reviewThreadView<R extends ReviewCommentFields, A>(
  read: ReviewRecordReading<R, A>,
  input: {
    records: readonly R[];
    agentReplies?: readonly ReviewAgentReplyFields[];
    sends?: readonly (ReviewRoundSend & Pick<ReviewSend, "to" | "comments">)[];
    messages?: readonly ReviewThreadMessage[];
    busy?: (session: string) => boolean;
    agentName?: (author: ReviewAgent) => string;
  },
): ReviewThreadView<A> {
  const agentReplies = input.agentReplies ?? [];
  const sends = input.sends ?? [];
  const messages = input.messages ?? [];
  const agentName = input.agentName ?? plainAgentName;
  const threads = reviewThreads(read, input.records, agentReplies, sends, { drafts: true, messages });
  const sendsById = new Map(sends.map((send) => [send.id, send]));
  const live = reviewLiveThreads(sends, input.records);
  const answered = reviewCommentLastReplies([], agentReplies);
  const statusOf = (carrier: string, thread: string): { status?: ReviewSendStatus } => {
    const send = sendsById.get(carrier);
    return send ? { status: reviewSendStatus(send, answered.get(thread) ?? null, input.busy?.(send.to.session) ?? false) } : {};
  };
  // What folds, over what is listed (a draft sub-thread is open, and keeps what it is under unfolded).
  const shown = new Set(threads.flatMap((thread) => [thread.id, ...thread.replies.map((reply) => reply.id)]));
  const resolved = new Set(threads.filter((thread) => thread.state === "resolved").map((thread) => thread.id));
  const openBelow = reviewOpenSubThreadPaths(
    input.records.filter((record) => shown.has(record.id)),
    agentReplies,
    (id) => !resolved.has(id),
  );
  const recordsById = new Map(input.records.map((record) => [record.id, record]));
  const nodes = new Map<string, ReviewThreadNode<A>>();
  const replyNodes = new Map<string, ReviewReplyNode<A>>();
  /** The thread each message of a thread belongs to: a thread to itself, a reply to the thread it is under. */
  const owner = new Map<string, string>();
  for (const { replies, parent, draft, ...thread } of threads) {
    const node: ReviewThreadNode<A> = {
      ...thread,
      ...(parent ? { parent: { id: parent.id, quote_offset: parent.quote_offset } } : {}),
      draft: draft === true,
      type: read.isDeletion(recordsById.get(thread.id)!) ? "deletion" : "comment",
      folded: isReviewThreadFolded(thread.id, resolved, openBelow),
      ...statusOf(thread.reply_id, thread.id),
      live: live.has(thread.id),
      replies: replies.map(({ draft: unsent, ...reply }) => {
        const replyNode: ReviewReplyNode<A> = {
          ...reply,
          author_name: reply.author.kind === "agent" ? agentName(reply.author) : null,
          draft: unsent === true,
          ...(reply.author.kind === "person" ? statusOf(reply.message_id, thread.id) : {}),
          sub_threads: [],
        };
        replyNodes.set(reply.id, replyNode);
        owner.set(reply.id, thread.id);
        return replyNode;
      }),
      sub_threads: [],
    };
    nodes.set(thread.id, node);
    owner.set(thread.id, thread.id);
  }
  /** Whether a sub-thread's way up reaches a thread at the top, never itself. */
  const reachesTop = (node: ReviewThreadNode<A>): boolean => {
    const seen = new Set([node.id]);
    for (let at = node.parent ? owner.get(node.parent.id) : undefined; at !== undefined; ) {
      if (seen.has(at)) return false;
      seen.add(at);
      const up = nodes.get(at)!.parent;
      at = up ? owner.get(up.id) : undefined;
    }
    return true;
  };
  const top: ReviewThreadNode<A>[] = [];
  for (const node of nodes.values()) {
    const host = node.parent ? (replyNodes.get(node.parent.id) ?? nodes.get(node.parent.id)) : undefined;
    if (host && reachesTop(node)) host.sub_threads.push(node);
    else top.push(node);
  }
  return { v: REVIEW_THREAD_VIEW_VERSION, round: reviewRoundNow(input.records, sends, messages), threads: top };
}

// ──────────── The review journal's records ────────────

/** A path as an agent reads it: from `root` when it is under it, else whole. */
export function reviewShownPath(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, "");
  return base !== "" && (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)) ? path.slice(base.length + 1) : path;
}

function lineWords(range: [number, number]): string {
  return range[0] === range[1] ? `line ${range[0]}` : `lines ${range[0]}-${range[1]}`;
}

/**
 * Where a comment of a review journal is, in words an agent reads: "on your
 * message msg_…", "on notes.md lines 12-14 when commented", "on the plan
 * (version 3) lines 4-6 when commented". A file's path is shown from `root`.
 */
export function reviewAnchorPlace(on: ReviewAnchor, root: string): string {
  const lines = on.kind !== "message" && on.lines ? ` ${lineWords(on.lines)} when commented` : "";
  if (on.kind === "message") return on.message_id ? `on your message ${on.message_id}` : "on your message";
  if (on.kind === "file") return `on ${reviewShownPath(on.path, root)}${lines}`;
  return `on the plan${on.version !== undefined ? ` (version ${on.version})` : ""}${lines}`;
}

/** How the rules read a comment of a review journal: its own fields. */
export const REVIEW_COMMENT_READING: ReviewRecordReading<ReviewComment, ReviewAnchor> = {
  on: (record) => record.on,
  quote: (record) => record.quote,
  text: (record) => record.text,
  isDeletion: (record) => record.type === "deletion",
  heldBack: () => false,
  place: reviewAnchorPlace,
  withLines: (on, lines) => (on.kind !== "message" && !on.lines ? { ...on, lines } : on),
};

// ──────────── The view as text ────────────

/** The status of a send, as a person or an agent reads it. */
const STATUS_WORDS: Record<ReviewSendStatus, string> = {
  pending: "not delivered yet",
  delivered: "delivered",
  read: "read",
  working: "being worked on",
  replied: "replied",
};

/**
 * The thread view as lines a person or an agent reads: each thread with its
 * id, round, state and place, the words it is on and its words, then each
 * reply (who, round, words) and each sub-thread under what it is on,
 * indented. The person's drafts read "draft"; a folded thread shows its
 * first line only.
 */
export function reviewThreadViewText<A>(view: ReviewThreadView<A>, place: (on: A, root: string) => string, root: string): string {
  const out: string[] = [`Round ${view.round}${view.threads.length === 0 ? ": no comment yet." : ""}`];
  const one = (text: string) => JSON.stringify(text.replace(/\s+/g, " ").trim());
  const thread = (node: ReviewThreadNode<A>, depth: number) => {
    const pad = "  ".repeat(depth);
    const state = node.draft ? "draft" : node.state;
    const where = node.parent ? `on a passage of ${node.parent.id}` : place(node.on, root);
    const marks = [state, `round ${node.round}`, ...(node.status ? [STATUS_WORDS[node.status]] : []), ...(node.unanchored ? ["unanchored"] : [])];
    out.push(`${pad}- ${node.id} (${marks.join(", ")}) ${where}${node.quote.trim() ? `: ${one(node.quote)}` : ""}`);
    if (node.folded) return;
    out.push(`${pad}  ${one(node.text)}`);
    for (const reply of node.replies) {
      const who = reply.author_name ?? "the person";
      out.push(`${pad}  - reply ${reply.id} (${[...(reply.draft ? ["draft"] : []), `round ${reply.round}`].join(", ")}) ${who}: ${one(reply.text)}`);
      for (const sub of reply.sub_threads) thread(sub, depth + 2);
    }
    for (const sub of node.sub_threads) thread(sub, depth + 1);
  };
  for (const node of view.threads) thread(node, 0);
  return out.join("\n");
}
