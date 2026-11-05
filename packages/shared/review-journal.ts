/**
 * The review journal: the state of one review of the review loop (#1116), on
 * disk, by target, as crit keeps a review in its `review.json`: the person's
 * comments, replies and sub-threads, their resolutions, the sends that carry
 * them to the agent session, and the agent's replies under them by id. The
 * rules that read it are packages/core/review-threads.ts.
 *
 * - One folder per review under the data directory,
 *   `reviews/<key>/journal.jsonl`. The key comes from the target alone
 *   (`reviewJournalKey`): the host and session for an agent's last messages,
 *   the real path for a file or folder, the history chain (project and slug)
 *   for a plan. So any client finds the same review: a screen's server, a
 *   terminal client through the CLI, the agent through the CLI.
 * - Append only: one line per write, `{ v, at, kind, id, record }`, the last
 *   line of an id holding its record. A torn last line (a crash mid-write) is
 *   skipped. A comment whose send never landed reads as a draft again.
 * - Every write takes the review's lock (`.lock`, created exclusively, so it
 *   holds on Windows too), reads, checks the whole write, then appends its
 *   lines at once; a lock older than `LOCK_STALE_MS` is broken. Reads take no
 *   lock.
 * - Only the person resolves: the agent's side writes replies, never a
 *   resolution. Approving the review removes its folder
 *   (`closeReviewJournal`).
 *
 * Synchronous and runtime-agnostic (node:fs and node:crypto only), so the Bun
 * server, the CLI and the Pi server (vendored) share it.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  REVIEW_COMMENT_READING,
  REVIEW_TEXT_MAX,
  isReviewCommentReply,
  isReviewCommentSent,
  isReviewReplyId,
  isReviewSendId,
  reviewCommentId,
  reviewReplyId,
  reviewRoundNow,
  reviewSendId,
  reviewSendText,
  reviewText,
  reviewThreadView,
  reviewThreads,
  type ReviewAgent,
  type ReviewAgentReply,
  type ReviewAnchor,
  type ReviewComment,
  type ReviewEntryDetail,
  type ReviewReplyHow,
  type ReviewSend,
  type ReviewSendMode,
  type ReviewThreadView,
} from "@plannotator/core/review-threads";
import { passageOffset } from "@plannotator/core/passage";

/** What a review is on, which names its journal. */
export type ReviewTarget =
  /** An agent session's last messages (`/plannotator-last`, a terminal client's reply review). */
  | { kind: "last"; host: string; session: string }
  /** A file or a folder, by its real path (`/plannotator-annotate`, a terminal client's file review). */
  | { kind: "file"; path: string }
  /** A plan, by its history chain (plan review: `resolveHistoryChain`'s project and slug). */
  | { kind: "plan"; project: string; slug: string };

/** The journal's line format. */
export const REVIEW_JOURNAL_VERSION = 1;

/** Each review's folder lives here, under the data directory. */
export const REVIEW_JOURNALS_DIR = "reviews";

const JOURNAL_FILE = "journal.jsonl";
const LOCK_FILE = ".lock";
/** A write takes milliseconds: a lock this old was left by a process that died. */
const LOCK_STALE_MS = 5_000;
/** How long a write waits for the lock before it gives up. */
const LOCK_WAIT_MS = 8_000;
const KEY_RE = /^(last|file|plan)-[0-9a-f]{24}$/;
const COMMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
/** The most words a comment can be on, in characters. */
const QUOTE_MAX = 20_000;

/** A refusal: `code` for a program, `message` for a person or an agent. */
export class ReviewJournalError extends Error {
  readonly code: "not_found" | "invalid" | "conflict" | "locked";
  constructor(code: ReviewJournalError["code"], message: string) {
    super(message);
    this.name = "ReviewJournalError";
    this.code = code;
  }
}

/** One review as its journal holds it. */
export interface ReviewJournalState {
  key: string;
  /** What the review is on; null when its first line was lost. */
  target: ReviewTarget | null;
  /** The person's comments, replies and sub-threads, in the order first written. */
  comments: ReviewComment[];
  /** The agent's replies. */
  replies: ReviewAgentReply[];
  sends: ReviewSend[];
  /** When it was last written. */
  updated_at: string | null;
}

/** Where to find a review: its key, or its target (which a write creates when it has no journal yet). */
export type ReviewJournalRef = { key: string } | { target: ReviewTarget };

export interface ReviewJournalOptions {
  dataDir: string;
  /**
   * How long a write waits for the review's lock, blocking the thread
   * (`LOCK_WAIT_MS` by default, for the CLI). A server passes 0 and retries
   * with `retryReviewJournalWrite`, which waits on timers instead.
   */
  lockWaitMs?: number;
  /** Tests: the clock. */
  now?: () => number;
}

// ──────────── Keys and folders ────────────

/** The target as every writer names it: a file by its real path when it exists, else its absolute path. */
export function normalizeReviewTarget(target: ReviewTarget): ReviewTarget {
  if (target.kind !== "file") return target;
  const absolute = resolve(target.path);
  try {
    return { kind: "file", path: realpathSync(absolute) };
  } catch {
    return { kind: "file", path: absolute };
  }
}

/** A review's key: its target's kind and a hash of what names it. */
export function reviewJournalKey(target: ReviewTarget): string {
  const named = normalizeReviewTarget(target);
  const parts = named.kind === "last" ? [named.host, named.session] : named.kind === "file" ? [named.path] : [named.project, named.slug];
  return `${named.kind}-${createHash("sha256").update(["v1", named.kind, ...parts].join("\0")).digest("hex").slice(0, 24)}`;
}

/** Whether a string reads as a review's key (a caller's `--review`). */
export function isReviewJournalKey(value: unknown): value is string {
  return typeof value === "string" && KEY_RE.test(value);
}

/** A review's folder. */
export function reviewJournalDir(dataDir: string, key: string): string {
  if (!isReviewJournalKey(key)) throw new ReviewJournalError("invalid", `Not a review key: ${key}.`);
  return join(dataDir, REVIEW_JOURNALS_DIR, key);
}

function isTarget(value: unknown): value is ReviewTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string" && field.trim() !== "";
  if (target.kind === "last") return text(target.host) && text(target.session);
  if (target.kind === "file") return text(target.path);
  if (target.kind === "plan") return text(target.project) && text(target.slug);
  return false;
}

/** A caller's target, checked: what a client gives in JSON. */
export function readReviewTarget(value: unknown): ReviewTarget {
  if (!isTarget(value)) {
    throw new ReviewJournalError("invalid", 'target: {"kind":"last","host":…,"session":…}, {"kind":"file","path":…} or {"kind":"plan","project":…,"slug":…}.');
  }
  return value;
}

function keyOf(ref: ReviewJournalRef): string {
  if ("key" in ref) {
    if (!isReviewJournalKey(ref.key)) throw new ReviewJournalError("invalid", `Not a review key: ${ref.key}.`);
    return ref.key;
  }
  return reviewJournalKey(readReviewTarget(ref.target));
}

// ──────────── Lines ────────────

type JournalLine =
  | { v: number; at: string; kind: "review"; id: string; record: { key: string; target: ReviewTarget; created_at: string } }
  | { v: number; at: string; kind: "comment"; id: string; record: ReviewComment }
  | { v: number; at: string; kind: "reply"; id: string; record: ReviewAgentReply }
  | { v: number; at: string; kind: "send"; id: string; record: ReviewSend };

const nullableText = (field: unknown) => field === null || typeof field === "string";
const optionalNullableText = (field: unknown) => field === undefined || nullableText(field);
const isLines = (field: unknown) => field === undefined || (Array.isArray(field) && field.length === 2 && field.every((n) => Number.isInteger(n) && n >= 1) && field[1] >= field[0]);

function isAnchor(value: unknown): value is ReviewAnchor {
  if (!value || typeof value !== "object") return false;
  const on = value as Record<string, unknown>;
  if (on.kind === "message") return typeof on.message_id === "string";
  if (on.kind === "file") return typeof on.path === "string" && on.path !== "" && isLines(on.lines);
  if (on.kind === "plan") return (on.version === undefined || (Number.isInteger(on.version) && (on.version as number) >= 1)) && isLines(on.lines);
  return false;
}

function isComment(value: unknown): value is ReviewComment {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    isAnchor(record.on) &&
    [record.quote, record.text, record.created_at, record.updated_at].every((field) => typeof field === "string") &&
    nullableText(record.removed_at) &&
    nullableText(record.sent_reply_id) &&
    optionalNullableText(record.resolved_at) &&
    optionalNullableText(record.unanchored_at) &&
    (record.re === undefined || typeof record.re === "string") &&
    (record.parent === undefined || typeof record.parent === "string")
  );
}

function isAgent(value: unknown): value is ReviewAgent {
  if (!value || typeof value !== "object") return false;
  const from = value as Record<string, unknown>;
  return from.kind === "agent" && nullableText(from.host) && nullableText(from.session) && nullableText(from.name);
}

function isAgentReply(value: unknown): value is ReviewAgentReply {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isReviewReplyId(record.id) && [record.re, record.text, record.created_at].every((field) => typeof field === "string") && isAgent(record.from);
}

function isSend(value: unknown): value is ReviewSend {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const to = record.to as Record<string, unknown> | null | undefined;
  return (
    isReviewSendId(record.id) &&
    [record.batch, record.created_at].every((field) => typeof field === "string") &&
    !!to &&
    typeof to.session === "string" &&
    nullableText(to.host) &&
    Number.isInteger(record.round) &&
    (record.round as number) >= 1 &&
    (record.mode === "now" || record.mode === "round") &&
    Array.isArray(record.comments) &&
    record.comments.every((id) => typeof id === "string") &&
    nullableText(record.words) &&
    nullableText(record.idempotency_key)
  );
}

function readLines(path: string): JournalLine[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: JournalLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalLine;
      if (parsed && typeof parsed === "object" && typeof parsed.id === "string") out.push(parsed);
    } catch {
      // A torn line from a crash mid-append: skipped.
    }
  }
  return out;
}

function stateOf(key: string, lines: readonly JournalLine[]): ReviewJournalState {
  let target: ReviewTarget | null = null;
  const comments = new Map<string, ReviewComment>();
  const replies = new Map<string, ReviewAgentReply>();
  const sends = new Map<string, ReviewSend>();
  for (const line of lines) {
    if (line.kind === "review" && isTarget(line.record?.target)) target = line.record.target;
    else if (line.kind === "comment" && isComment(line.record)) comments.set(line.id, line.record);
    else if (line.kind === "reply" && isAgentReply(line.record)) replies.set(line.id, line.record);
    else if (line.kind === "send" && isSend(line.record)) sends.set(line.id, line.record);
  }
  // A comment marked sent by a send whose own line never landed is a draft again.
  const landed = (record: ReviewComment) => (record.sent_reply_id !== null && !sends.has(record.sent_reply_id) ? { ...record, sent_reply_id: null } : record);
  return { key, target, comments: [...comments.values()].map(landed), replies: [...replies.values()], sends: [...sends.values()], updated_at: lines.at(-1)?.at ?? null };
}

/** A review as its journal holds it, or null when it has none. Takes no lock. */
export function readReviewJournal(dataDir: string, ref: ReviewJournalRef): ReviewJournalState | null {
  const key = keyOf(ref);
  const lines = readLines(join(reviewJournalDir(dataDir, key), JOURNAL_FILE));
  return lines.length === 0 ? null : stateOf(key, lines);
}

/**
 * What changes when the journal is written: its size and time, or null when
 * it has none. A server compares it on a timer and reads the journal again
 * when it moved, as crit's daemon reads its review file.
 */
export function reviewJournalStamp(dataDir: string, ref: ReviewJournalRef): string | null {
  try {
    const stat = statSync(join(reviewJournalDir(dataDir, keyOf(ref)), JOURNAL_FILE));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/** One review in the list: what it is on, its round, its open threads and drafts. */
export interface ReviewJournalSummary {
  key: string;
  target: ReviewTarget | null;
  updated_at: string | null;
  round: number;
  open: number;
  drafts: number;
}

/** Every review with a journal, newest first. */
export function listReviewJournals(dataDir: string): ReviewJournalSummary[] {
  let keys: string[];
  try {
    keys = readdirSync(join(dataDir, REVIEW_JOURNALS_DIR)).filter(isReviewJournalKey);
  } catch {
    return [];
  }
  const out: ReviewJournalSummary[] = [];
  for (const key of keys) {
    const state = readReviewJournal(dataDir, { key });
    if (!state) continue;
    const threads = reviewThreads(REVIEW_COMMENT_READING, state.comments, state.replies, state.sends);
    out.push({
      key,
      target: state.target,
      updated_at: state.updated_at,
      round: reviewRoundNow(state.comments, state.sends),
      open: threads.filter((thread) => thread.state === "open").length,
      drafts: state.comments.filter((record) => record.sent_reply_id === null && record.removed_at === null).length,
    });
  }
  return out.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.key.localeCompare(b.key));
}

// ──────────── The lock ────────────

/** Blocks the thread for `ms`: a write waits for the lock without turning async. */
function sleep(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // spin: no Atomics.wait on this runtime
    }
  }
}

function ageOf(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Breaks a lock older than LOCK_STALE_MS, one breaker at a time. */
function breakIfStale(lock: string): void {
  if ((ageOf(lock) ?? 0) <= LOCK_STALE_MS) return;
  const breaker = `${lock}.break`;
  let fd: number;
  try {
    fd = openSync(breaker, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
    // A breaker that died mid-break: its own file goes the same way, later.
    if ((ageOf(breaker) ?? 0) > LOCK_STALE_MS) rmSync(breaker, { force: true });
    return;
  }
  try {
    if ((ageOf(lock) ?? 0) > LOCK_STALE_MS) rmSync(lock, { force: true });
  } finally {
    closeSync(fd);
    rmSync(breaker, { force: true });
  }
}

/** Runs `fn` holding the review folder's lock, waiting for it at most `waitMs`. */
function withLock<T>(dir: string, waitMs: number, fn: () => T): T {
  const lock = join(dir, LOCK_FILE);
  const token = `${process.pid}.${randomUUID()}`;
  const start = Date.now();
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new ReviewJournalError("not_found", "This review has no journal (it was closed).");
      if (code !== "EEXIST") throw error;
      breakIfStale(lock);
      if (Date.now() - start >= waitMs) throw new ReviewJournalError("locked", `The review stayed locked for ${waitMs} ms; try again.`);
      sleep(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
    } catch {
      // Broken as stale while held, or the folder went with the review (close).
    }
  }
}

/**
 * Runs a write that gives up at once on a held lock (`lockWaitMs: 0`) again
 * until it gets the lock, waiting on timers between tries, so a server's
 * event loop is never blocked by another process's write (the CLI's,
 * a terminal client's). Gives up as the CLI does, after `LOCK_WAIT_MS`.
 */
export async function retryReviewJournalWrite<T>(write: () => T, waitMs: number = LOCK_WAIT_MS): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      return write();
    } catch (error) {
      if (!(error instanceof ReviewJournalError) || error.code !== "locked" || Date.now() - start >= waitMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

/** Whether a file is empty or ends with a newline: a torn last line gets one first, so both lines stay readable. */
function endsClean(path: string): boolean {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return true;
    fd = openSync(path, "r");
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * One write: under the review's lock, `change` reads the review (null when it
 * has no journal yet) and returns the lines to append and its result. A
 * review with no journal is created only from its target.
 */
function write<T>(options: ReviewJournalOptions, ref: ReviewJournalRef, change: (state: ReviewJournalState | null, at: string) => { lines: Omit<JournalLine, "v" | "at">[]; result: T }): T {
  const key = keyOf(ref);
  const dir = reviewJournalDir(options.dataDir, key);
  const path = join(dir, JOURNAL_FILE);
  if ("target" in ref) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else if (!existsSync(dir)) throw new ReviewJournalError("not_found", `No review ${key}: \`plannotator threads\` lists the reviews.`);
  try {
    return locked(options, ref, key, dir, path, change);
  } finally {
    // A first write refused leaves no empty folder behind (rmdir keeps one that holds anything).
    if (!existsSync(path)) {
      try {
        rmdirSync(dir);
      } catch {
        // not empty, or already gone
      }
    }
  }
}

function locked<T>(
  options: ReviewJournalOptions,
  ref: ReviewJournalRef,
  key: string,
  dir: string,
  path: string,
  change: (state: ReviewJournalState | null, at: string) => { lines: Omit<JournalLine, "v" | "at">[]; result: T },
): T {
  return withLock(dir, options.lockWaitMs ?? LOCK_WAIT_MS, () => {
    const lines = readLines(path);
    const at = new Date((options.now ?? Date.now)()).toISOString();
    const state = lines.length === 0 ? null : stateOf(key, lines);
    const { lines: added, result } = change(state, at);
    const header =
      state === null && "target" in ref && added.length > 0
        ? [{ kind: "review" as const, id: key, record: { key, target: normalizeReviewTarget(readReviewTarget(ref.target)), created_at: at } }]
        : [];
    const out = [...header, ...added].map((line) => JSON.stringify({ v: REVIEW_JOURNAL_VERSION, at, ...line }));
    if (out.length > 0) appendFileSync(path, `${endsClean(path) ? "" : "\n"}${out.join("\n")}\n`, { mode: 0o600 });
    return result;
  });
}

function empty(key: string): ReviewJournalState {
  return { key, target: null, comments: [], replies: [], sends: [], updated_at: null };
}

// ──────────── The person's side ────────────

/** What a comment of the person's says: on the target, under a comment (`re`), or on a passage (`parent`). */
export interface ReviewCommentInput {
  /** The client's own id (a Plannotator annotation's); minted when absent. Writing an id again edits that draft. */
  id?: string;
  /** Where it is: needed for a comment on the target; a reply or a sub-thread is where its thread is. */
  on?: ReviewAnchor;
  /** The words it is on; a sub-thread's passage. */
  quote?: string;
  text: string;
  type?: "comment" | "deletion";
  /** A reply under this comment (a reply's id answers the comment it is under). */
  re?: string;
  /** A sub-thread on a passage of this message (a comment, a reply, an agent's reply, a sub-thread). */
  parent?: string;
  /** Where the passage starts in that message's words; found from `quote` when absent. */
  quote_offset?: number;
  /** The client's own drawing data, kept as it is. */
  annotation?: Record<string, unknown>;
}

/** The person's sent comment, reply or sub-thread a reply or a sub-thread can be under, by id, with the thread it belongs to. */
function sentMessage(state: ReviewJournalState, id: string): { thread: ReviewComment; words: string } | null {
  const record = state.comments.find((comment) => comment.id === id && isReviewCommentSent(comment));
  if (record) {
    const thread = isReviewCommentReply(record) ? state.comments.find((comment) => comment.id === record.re) : record;
    return thread ? { thread, words: record.text } : null;
  }
  const reply = state.replies.find((agentReply) => agentReply.id === id);
  if (!reply) return null;
  const thread = state.comments.find((comment) => comment.id === reply.re);
  return thread ? { thread, words: reply.text } : null;
}

/** The thread an id answers: a sent comment or sub-thread, or the one a sent reply of the person's is under. */
function threadOf(state: ReviewJournalState, id: string): ReviewComment | null {
  const record = state.comments.find((comment) => comment.id === id && comment.removed_at === null);
  if (!record || !isReviewCommentSent(record)) return null;
  if (!isReviewCommentReply(record)) return record;
  const thread = state.comments.find((comment) => comment.id === record.re && isReviewCommentSent(comment));
  return thread ?? null;
}

function checkedText(value: unknown, field: string, deletion: boolean): string {
  if (deletion && (value === undefined || value === "")) return "";
  const text = reviewText(value, REVIEW_TEXT_MAX);
  if (text === null) throw new ReviewJournalError("invalid", `${field}: 1 to ${REVIEW_TEXT_MAX} characters.`);
  return text;
}

/**
 * Writes the person's comment, reply under a comment, or sub-thread on a
 * passage, as a draft (a send carries it). A reply or a sub-thread is where
 * its thread is; a reply is on its comment's words. Writing an id again edits
 * that draft; a sent one is not edited.
 */
export function writeReviewComment(options: ReviewJournalOptions, ref: ReviewJournalRef, input: ReviewCommentInput): ReviewComment {
  return write(options, ref, (state, at) => {
    const review = state ?? empty(keyOf(ref));
    const id = input.id ?? reviewCommentId((options.now ?? Date.now)());
    if (typeof id !== "string" || !COMMENT_ID_RE.test(id)) throw new ReviewJournalError("invalid", "id: letters, digits, _ . : - (at most 200).");
    for (const field of ["re", "parent", "quote"] as const) {
      if (input[field] !== undefined && typeof input[field] !== "string") throw new ReviewJournalError("invalid", `${field}: a string.`);
    }
    if (input.type !== undefined && input.type !== "comment" && input.type !== "deletion") throw new ReviewJournalError("invalid", 'type: "comment" or "deletion".');
    if (input.annotation !== undefined && (!input.annotation || typeof input.annotation !== "object" || Array.isArray(input.annotation))) throw new ReviewJournalError("invalid", "annotation: an object.");
    const known = review.comments.find((comment) => comment.id === id);
    if (known && known.sent_reply_id !== null) throw new ReviewJournalError("conflict", `${id} was sent: it is not edited.`);
    if (known && known.removed_at !== null) throw new ReviewJournalError("conflict", `${id} was removed.`);
    if (review.replies.some((reply) => reply.id === id) || review.sends.some((send) => send.id === id)) throw new ReviewJournalError("conflict", `${id} is taken.`);
    if (input.re !== undefined && input.parent !== undefined) throw new ReviewJournalError("invalid", "re or parent, not both.");
    const deletion = input.type === "deletion";
    const text = checkedText(input.text, "text", deletion);
    const quote = typeof input.quote === "string" ? input.quote : "";
    if (quote.length > QUOTE_MAX) throw new ReviewJournalError("invalid", `quote: at most ${QUOTE_MAX} characters.`);
    let record: ReviewComment;
    const base = {
      id,
      text,
      ...(deletion ? { type: "deletion" as const } : {}),
      created_at: known?.created_at ?? at,
      updated_at: at,
      removed_at: null,
      sent_reply_id: null,
      ...(input.annotation && typeof input.annotation === "object" ? { annotation: input.annotation } : {}),
    };
    if (input.re !== undefined) {
      const thread = threadOf(review, input.re);
      if (!thread) throw new ReviewJournalError("not_found", `re: no sent comment ${input.re}.`);
      record = { ...base, on: thread.on, quote: thread.quote, re: thread.id };
    } else if (input.parent !== undefined) {
      const parent = sentMessage(review, input.parent);
      if (!parent) throw new ReviewJournalError("not_found", `parent: no sent message ${input.parent}.`);
      if (!quote.trim()) throw new ReviewJournalError("invalid", "quote: the passage of the parent's words.");
      const found = parent.words.indexOf(quote);
      // An offset counts whitespace runs as one (passage.ts), never a raw index.
      const offset = Number.isInteger(input.quote_offset) && (input.quote_offset as number) >= 0 ? (input.quote_offset as number) : found >= 0 ? passageOffset(parent.words, found) : 0;
      record = { ...base, on: parent.thread.on, quote, parent: input.parent, quote_offset: offset };
    } else {
      if (!isAnchor(input.on)) throw new ReviewJournalError("invalid", 'on: {"kind":"message","message_id":…}, {"kind":"file","path":…,"lines"?:[a,b]} or {"kind":"plan","version"?:n,"lines"?:[a,b]}.');
      record = { ...base, on: input.on, quote };
    }
    return { lines: [{ kind: "comment", id, record }], result: record };
  });
}

/**
 * Removes the person's comment, reply or sub-thread, and everything of the
 * person's under it (replies, sub-threads, at any depth). The agent's replies
 * under it stay written, with nothing to show them under.
 */
export function removeReviewComment(options: ReviewJournalOptions, ref: ReviewJournalRef, id: string): string[] {
  return write(options, ref, (state, at) => {
    const review = state ?? empty(keyOf(ref));
    const root = review.comments.find((comment) => comment.id === id && comment.removed_at === null);
    if (!root) throw new ReviewJournalError("not_found", `No comment ${id}.`);
    const gone = new Set([id]);
    const under = (record: ReviewComment) => (record.re !== undefined && gone.has(record.re)) || (record.parent !== undefined && (gone.has(record.parent) || review.replies.some((reply) => reply.id === record.parent && gone.has(reply.re))));
    for (let grew = true; grew; ) {
      grew = false;
      for (const record of review.comments) {
        if (!gone.has(record.id) && record.removed_at === null && under(record)) {
          gone.add(record.id);
          grew = true;
        }
      }
    }
    const removed = review.comments.filter((record) => gone.has(record.id));
    return { lines: removed.map((record) => ({ kind: "comment" as const, id: record.id, record: { ...record, removed_at: at, updated_at: at } })), result: removed.map((record) => record.id) };
  });
}

/** The person resolves a sent comment or sub-thread (`resolved`), or reopens it. Only the person: no agent's command writes this. */
export function resolveReviewComment(options: ReviewJournalOptions, ref: ReviewJournalRef, id: string, resolved: boolean): ReviewComment {
  return write(options, ref, (state, at) => {
    const review = state ?? empty(keyOf(ref));
    const record = review.comments.find((comment) => comment.id === id && comment.removed_at === null);
    if (!record || !isReviewCommentSent(record) || isReviewCommentReply(record)) throw new ReviewJournalError("not_found", `No sent comment or sub-thread ${id}.`);
    const next = { ...record, resolved_at: resolved ? at : null, updated_at: at };
    return { lines: [{ kind: "comment", id, record: next }], result: next };
  });
}

/**
 * Where a comment's words are now, as the client that shows the target found
 * them after an edit (the anchors follow the text from one round to the
 * next): its new place (`on`, the same kind), and whether its words are gone
 * (`unanchored`, kept from one round to the next until they are found
 * again). A comment or sub-thread, sent or not; a reply is where its thread is.
 */
export function anchorReviewComment(options: ReviewJournalOptions, ref: ReviewJournalRef, id: string, input: { on?: ReviewAnchor; unanchored: boolean }): ReviewComment {
  return write(options, ref, (state, at) => {
    const review = state ?? empty(keyOf(ref));
    const record = review.comments.find((comment) => comment.id === id && comment.removed_at === null);
    if (!record || isReviewCommentReply(record)) throw new ReviewJournalError("not_found", `No comment or sub-thread ${id}.`);
    if (input.on !== undefined && (!isAnchor(input.on) || input.on.kind !== record.on.kind)) throw new ReviewJournalError("invalid", `on: a place of the same kind (${record.on.kind}).`);
    const unanchored_at = input.unanchored ? (record.unanchored_at ?? at) : null;
    const next = { ...record, ...(input.on ? { on: input.on } : {}), unanchored_at, updated_at: at };
    return { lines: [{ kind: "comment", id, record: next }], result: next };
  });
}

/** What a send says: its mode, the drafts it carries (`now`), where it goes, the person's words. */
export interface ReviewSendInput {
  mode: ReviewSendMode;
  /** `now`: the drafts to send (at least one). A Finish (`round`) carries every draft left. */
  ids?: readonly string[];
  /** The agent session; a review of a session's last messages goes to that session by default. */
  to?: { host: string | null; session: string };
  /** The person's own words, before the comments. */
  words?: string;
  /** A retry with the same key writes nothing and gives the first send back. */
  idempotency_key?: string;
}

/**
 * Sends the person's drafts to the agent session: `now` the drafts named,
 * the round staying open; `round` (the person's Finish) every draft left,
 * ending the round, and naming the threads still open that went to that
 * session before (their words are not sent again). Each draft is marked sent
 * before the send's line, in the same write.
 */
export function sendReviewComments(options: ReviewJournalOptions, ref: ReviewJournalRef, input: ReviewSendInput): { send: ReviewSend; replayed: boolean } {
  return write<{ send: ReviewSend; replayed: boolean }>(options, ref, (state, at) => {
    const review = state ?? empty(keyOf(ref));
    const key = input.idempotency_key?.trim() || null;
    const replay = key ? review.sends.find((send) => send.idempotency_key === key) : undefined;
    if (replay) return { lines: [], result: { send: replay, replayed: true } };
    if (input.mode !== "now" && input.mode !== "round") throw new ReviewJournalError("invalid", 'mode: "now" or "round".');
    const target = review.target ?? ("target" in ref ? readReviewTarget(ref.target) : null);
    const to = input.to ?? (target?.kind === "last" ? { host: target.host, session: target.session } : null);
    if (!to || typeof to !== "object" || typeof to.session !== "string" || !to.session.trim() || !(to.host === undefined || to.host === null || typeof to.host === "string")) {
      throw new ReviewJournalError("invalid", "to: the agent session it goes to ({ host, session }).");
    }
    const drafts = review.comments.filter((record) => record.sent_reply_id === null && record.removed_at === null);
    let carried: ReviewComment[];
    if (input.mode === "now") {
      const ids = [...new Set(input.ids ?? [])];
      if (ids.length === 0) throw new ReviewJournalError("invalid", "ids: the drafts to send now.");
      carried = ids.map((id) => {
        const draft = drafts.find((record) => record.id === id);
        if (!draft) throw new ReviewJournalError("not_found", `No draft ${id}.`);
        return draft;
      });
    } else {
      carried = drafts;
    }
    const words = input.words?.trim() || null;
    // Sends count rounds in time order: a new one sorts after the newest, even in the same millisecond or after a clock step back.
    const newest = review.sends.reduce((latest, send) => (send.created_at > latest ? send.created_at : latest), "");
    const createdAt = at > newest ? at : new Date(Date.parse(newest) + 1).toISOString();
    const id = reviewSendId(Date.parse(createdAt));
    const carriedIds = new Set(carried.map((record) => record.id));
    const sentTo = new Map(review.sends.map((send) => [send.id, send.to.session]));
    const named =
      input.mode === "round"
        ? reviewThreads(REVIEW_COMMENT_READING, review.comments, review.replies, review.sends)
            .filter((thread) => thread.state === "open" && !carriedIds.has(thread.id) && sentTo.get(thread.reply_id) === to.session)
            .map((thread) => thread.id)
        : [];
    const send: ReviewSend = {
      id,
      batch: id,
      to: { host: to.host ?? null, session: to.session },
      round: reviewRoundNow(review.comments, review.sends),
      mode: input.mode,
      comments: [...carried.map((record) => record.id), ...named],
      words,
      idempotency_key: key,
      created_at: createdAt,
    };
    const marked = carried.map((record) => ({ kind: "comment" as const, id: record.id, record: { ...record, sent_reply_id: id, updated_at: at } }));
    return { lines: [...marked, { kind: "send", id, record: send }], result: { send, replayed: false } };
  });
}

/** The client handed these sends to the agent session (it delivered them itself). */
export function markReviewSendsDelivered(options: ReviewJournalOptions, ref: ReviewJournalRef, ids: readonly string[]): ReviewSend[] {
  return write(options, ref, (state, at) => {
    const review = state ?? empty(keyOf(ref));
    const marked = ids.map((id) => {
      const send = review.sends.find((known) => known.id === id);
      if (!send) throw new ReviewJournalError("not_found", `No send ${id}.`);
      return send;
    });
    const fresh = marked.filter((send) => !send.delivery).map((send) => ({ ...send, delivery: { at } }));
    return { lines: fresh.map((send) => ({ kind: "send" as const, id: send.id, record: send })), result: marked.map((send) => fresh.find((done) => done.id === send.id) ?? send) };
  });
}

/** The agent session read the threads: each send that reached it and that it had not read is read now. */
export function markReviewSendsRead(options: ReviewJournalOptions, ref: ReviewJournalRef, session: string): ReviewSend[] {
  return write(options, ref, (state, at) => {
    const fresh = (state?.sends ?? []).filter((send) => send.to.session === session && !send.read_at).map((send) => ({ ...send, read_at: at }));
    return { lines: fresh.map((send) => ({ kind: "send" as const, id: send.id, record: send })), result: fresh };
  });
}

/** Approving the review ends it: its folder goes. True when there was one. */
export function closeReviewJournal(options: Pick<ReviewJournalOptions, "dataDir" | "lockWaitMs">, ref: ReviewJournalRef): boolean {
  const dir = reviewJournalDir(options.dataDir, keyOf(ref));
  if (!existsSync(dir)) return false;
  return withLock(dir, options.lockWaitMs ?? LOCK_WAIT_MS, () => {
    rmSync(dir, { recursive: true, force: true });
    return true;
  });
}

// ──────────── The agent's side ────────────

/** One reply of the agent's: under the comment `id` (a reply's id answers the comment it is under). */
export interface ReviewReplyInput {
  id: string;
  text: string;
}

/**
 * The agent's replies under the person's sent comments, checked as a whole
 * before any is written: each under a sent comment or sub-thread (a sent
 * reply's id answers the comment it is under). `from` defaults to the session
 * the send that carried the id went to. A reply shows its send reached that
 * session: a send not yet marked delivered or read is marked read just
 * before it. A retry with the same `idempotency_key` writes nothing and gives
 * the first replies back. Never a resolution: only the person resolves.
 */
export function replyInReview(
  options: ReviewJournalOptions,
  ref: ReviewJournalRef,
  replies: readonly ReviewReplyInput[],
  extra: { from?: ReviewAgent; idempotency_key?: string } = {},
): { replies: ReviewAgentReply[]; replayed: boolean } {
  return write<{ replies: ReviewAgentReply[]; replayed: boolean }>(options, ref, (state, at) => {
    const review = state ?? empty(keyOf(ref));
    const key = extra.idempotency_key?.trim() || undefined;
    const replayed = key ? review.replies.filter((reply) => reply.idempotency_key === key) : [];
    if (replayed.length > 0) return { lines: [], result: { replies: replayed, replayed: true } };
    if (replies.length === 0) throw new ReviewJournalError("invalid", "replies: at least one.");
    const now = (options.now ?? Date.now)();
    const sendsById = new Map(review.sends.map((send) => [send.id, send]));
    const reached = new Map<string, ReviewSend>();
    const written = replies.map((reply, index): ReviewAgentReply => {
      const thread = threadOf(review, reply.id);
      if (!thread) {
        const draft = review.comments.some((comment) => comment.id === reply.id && comment.removed_at === null);
        throw new ReviewJournalError("not_found", draft ? `${reply.id} is not sent yet.` : `No comment ${reply.id}: \`plannotator threads --review ${review.key}\` lists them.`);
      }
      const text = checkedText(reply.text, "text", false);
      const carrier = sendsById.get(review.comments.find((comment) => comment.id === reply.id)!.sent_reply_id!);
      const from: ReviewAgent = extra.from ?? { kind: "agent", host: carrier?.to.host ?? null, session: carrier?.to.session ?? null, name: null };
      if (carrier && !carrier.delivery && !carrier.read_at && carrier.to.session === from.session) reached.set(carrier.id, carrier);
      return { id: reviewReplyId(now + index), re: thread.id, from, text, created_at: at, ...(key ? { idempotency_key: key } : {}) };
    });
    // Read just before the reply, so the reply counts as an answer to it (`replied`, and the send's round).
    const readAt = new Date(Date.parse(at) - 1).toISOString();
    const read = [...reached.values()].map((send) => ({ ...send, read_at: send.created_at > readAt ? send.created_at : readAt }));
    return {
      lines: [...read.map((send) => ({ kind: "send" as const, id: send.id, record: send })), ...written.map((reply) => ({ kind: "reply" as const, id: reply.id, record: reply }))],
      result: { replies: written, replayed: false },
    };
  });
}

// ──────────── What clients read ────────────

/**
 * The review's thread view (`v: 1`), as any client draws it: the person's
 * drafts included, or, `sent` (what an agent reads), only what was sent.
 */
export function reviewJournalView(
  state: ReviewJournalState | null,
  options: { sent?: boolean; busy?: (session: string) => boolean; agentName?: (author: ReviewAgent) => string } = {},
): ReviewThreadView {
  const review = state ?? empty("");
  const { sent, ...view } = options;
  const records = sent ? review.comments.filter((record) => record.sent_reply_id !== null) : review.comments;
  return reviewThreadView(REVIEW_COMMENT_READING, { records, agentReplies: review.replies, sends: review.sends, ...view });
}

/** What the agent reads of these sends (oldest first), the person's words first, then how to answer (`how`). */
export function reviewJournalSendText(state: ReviewJournalState, sendIds: readonly string[], options: { root: string; how: ReviewReplyHow; detail?: (record: ReviewComment) => ReviewEntryDetail }): string {
  const sends = state.sends.filter((send) => sendIds.includes(send.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const words = sends.flatMap((send) => (send.words ? [send.words] : [])).join("\n\n");
  return reviewSendText(REVIEW_COMMENT_READING, { sends, records: state.comments, agentReplies: state.replies, root: options.root, words, detail: options.detail, how: options.how });
}

/** How an agent answers a review through the CLI (`plannotator reply`, `plannotator threads`). */
export function reviewCliHow(key: string): ReviewReplyHow {
  return {
    read: `\`plannotator threads --review ${key}\` shows their words and replies.`,
    reply: [
      "Reply under each id in Plannotator, not in chat: what you changed, your answer, or why you did not do it. Only the person resolves a comment.",
      `    plannotator reply --review ${key} <id> <<'END'`,
      "    your reply",
      "    END",
    ].join("\n"),
  };
}
