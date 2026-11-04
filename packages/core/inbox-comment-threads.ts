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
 *   two Sends before the agent answered) are one round;
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
 *   agent gets what is still open, as crit sends every unresolved thread.
 *
 * Browser-safe and zero-dep. Built to grow: the agent's replies under a
 * comment and a comment on a passage of another comment are fields of
 * `InboxCommentThread` the record does not carry yet.
 */

import { readInboxVideoTime, type InboxAnnotationRecord } from "./inbox-attachments";
import { formatInboxVideoTime } from "./inbox-types";

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

/** One comment of a thread once sent. */
export interface InboxCommentThread {
  /** The comment's id: the one its feedback heading names (` (id …)`). */
  id: string;
  /** The person's reply that carried it to the agent. */
  reply_id: string;
  /** The round it was sent in, from 1. */
  round: number;
  state: InboxCommentState;
  on: InboxCommentAnchor;
  /** The words, lines or part it is on, as the person selected them. */
  quote: string;
  /** The comment. */
  text: string;
  /** Its words were not found in the file the last time the window showed it. */
  unanchored: boolean;
}

/** A sent comment is open until the person resolves it. */
export type InboxCommentState = "open" | "resolved";

/**
 * A sent comment's state: resolved from when the person resolved it
 * (`resolved_at`) until they reopen it, or until a reply lands under it: a
 * reply newer than `resolved_at` (`lastReplyAt`, the newest reply's time)
 * opens it again, as a reply does in crit, with nothing written. The replies
 * under a comment pass their newest time here; until then none is passed.
 * Three readers ask it, and each must pass that time once replies exist:
 * `inboxCommentThreads` (read_thread and what a reply sends again), the
 * store's `resolveAnnotation` (whether a press changes anything) and the
 * window's `isResolved` (packages/inbox/components/SentComments.tsx).
 */
export function inboxCommentState(record: Pick<InboxAnnotationRecord, "resolved_at">, lastReplyAt: string | null = null): InboxCommentState {
  const resolved = record.resolved_at;
  if (typeof resolved !== "string") return "open";
  return lastReplyAt !== null && lastReplyAt > resolved ? "open" : "resolved";
}

/** What a round needs of a message: its id and who wrote it. */
export interface InboxCommentRoundMessage {
  id: string;
  author: { kind: string };
}

/** Whether a record is a comment the person sent (not a draft, not removed). */
export function isInboxCommentSent(record: Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at">): boolean {
  return record.sent_reply_id !== null && record.removed_at === null;
}

/**
 * Each reply that carried comments, by id, with its round (from 1), in the
 * thread's order. A round ends when an agent writes in the thread: the
 * person's replies before that answer (one Send to two sessions writes two)
 * share their round.
 */
export function inboxCommentRounds(
  messages: readonly InboxCommentRoundMessage[],
  records: readonly Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at">[],
): Map<string, number> {
  const carriers = new Set<string>();
  for (const record of records) if (isInboxCommentSent(record)) carriers.add(record.sent_reply_id!);
  const rounds = new Map<string, number>();
  let round = 0;
  let answered = true;
  for (const message of messages) {
    if (message.author.kind !== "person") {
      answered = true;
      continue;
    }
    if (!carriers.has(message.id)) continue;
    if (answered) {
      round += 1;
      answered = false;
    }
    rounds.set(message.id, round);
  }
  return rounds;
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
 * made), each with its round, anchor and state. A record whose reply is not
 * in `messages` (a Send that never landed) is left out.
 */
export function inboxCommentThreads(messages: readonly InboxCommentRoundMessage[], records: readonly InboxAnnotationRecord[]): InboxCommentThread[] {
  const rounds = inboxCommentRounds(messages, records);
  const out: (InboxCommentThread & { created_at: string })[] = [];
  for (const record of records) {
    if (!isInboxCommentSent(record)) continue;
    const round = rounds.get(record.sent_reply_id!);
    if (round === undefined) continue;
    const annotation = record.annotation;
    out.push({
      id: record.id,
      reply_id: record.sent_reply_id!,
      round,
      state: inboxCommentState(record),
      on: inboxCommentAnchor(record),
      quote: text(annotation.originalText) || text(annotation.selectedText) || text(annotation.originalCode),
      text: text(annotation.text),
      unanchored: typeof record.unanchored_at === "string",
      created_at: record.created_at,
    });
  }
  out.sort((a, b) => a.round - b.round || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return out.map(({ created_at: _created, ...thread }) => thread);
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
    return thread.state === "open" && thread.on.kind !== "guide" && index !== undefined && index < last && sentTo(messages[index]!) === session;
  });
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
    const place = `${inboxCommentPlace(thread.on, root)}${thread.unanchored ? ", unanchored (its words were not in the file when the person last opened it)" : ""}`;
    const quote = thread.quote.replace(/\s+/g, " ").trim();
    const comment = (thread.text.trim() || "(no words)").split(/\r\n?|\n/).map((line) => `> ${line}`.trimEnd());
    return [`### ${index + 1}. Round ${thread.round}, ${place}${quote ? `: "${quote}"` : ""} (id ${thread.id})`, ...comment].join("\n");
  });
  const intro = "The person has not resolved these comments from earlier rounds yet.";
  const rest = older > 0 ? [`${older} older open comment${older === 1 ? " is" : "s are"} not repeated here: read_thread lists every comment.`] : [];
  return [`# ${INBOX_OPEN_COMMENTS_TITLE}`, intro, ...entries, ...rest].join("\n\n");
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
