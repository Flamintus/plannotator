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
 * - its state: `open` once sent.
 *
 * Browser-safe and zero-dep. Built to grow: a resolved state, the agent's
 * replies under a comment and a comment on a passage of another comment are
 * fields of `InboxCommentThread` the record does not carry yet.
 */

import { readInboxVideoTime, type InboxAnnotationRecord } from "./inbox-attachments";

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
  /** Sent and kept: nothing closes a comment yet. */
  state: "open";
  on: InboxCommentAnchor;
  /** The words, lines or part it is on, as the person selected them. */
  quote: string;
  /** The comment. */
  text: string;
  /** Its words were not found in the file the last time the window showed it. */
  unanchored: boolean;
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
      state: "open",
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
