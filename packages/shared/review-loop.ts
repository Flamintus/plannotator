/**
 * The review loop on a screen (`/plannotator-last`, `/plannotator-annotate`,
 * plan review; #1116, experimental "persistent-comments"): the screen's
 * server side of the review journal (review-journal.ts), so a review goes on
 * for several rounds in the same tab.
 *
 * - Available only with the setting on, a target the journal names (the agent
 *   session's last messages, a local file or folder, a plan's history chain),
 *   the agent session it goes to, and a host that carries sends to that
 *   session (the session bridge's `send` command, which the Claude Code mod
 *   takes). Otherwise every page route answers `{ available: false }` and the
 *   screen keeps today's single decision.
 * - The page (`/api/threads`): reads the review (`v: 1` thread view), sends
 *   the person's comments (`now`, or the end of a round), resolves and
 *   reopens. A send is written to the journal and handed to the host as one
 *   line (a round is not a message): the shared core's wake, saying how the
 *   agent reads the round and answers (the `plannotator` tool when the host
 *   says its agent has it, else the CLI); the host's report marks it
 *   delivered.
 * - The host (`/api/host/threads`, guarded like host control): the agent's
 *   replies under ids and its read of the threads, which mark the sends read
 *   and carries what the review is on, what the sends it has not answered say
 *   (each comment with the lines the page added under it, the round's
 *   words), then the threads;
 *   and for `last`, the agent's next messages, which join the picker's list
 *   (`/api/host/messages`).
 * - Live: a timer compares the journal's stamp and the host's state each
 *   second and pushes `review-threads` to the page on the external-annotation
 *   stream when either moved (another process's write: the CLI, a terminal
 *   client), and at once after the server's own writes.
 * - Writes never block the event loop: each gives up at once on a held lock
 *   and is retried on timers (`retryReviewJournalWrite`).
 * - Approving the review ends it (`approved`): the journal goes.
 * - Ending it on the screen (Approve, Done, Close; `ended`), where the server
 *   takes decisions again (`onReopen`) and the host keeps watching the review
 *   (`reopen`), leaves it reopenable while the page is open and the host
 *   there: the decision goes to the agent at once, `POST /api/threads/reopen`
 *   takes the review up again and tells the agent, and an approval's journal
 *   goes only once that is over (`afterEnd`).
 *
 * Runtime-agnostic (vendored to Pi): plain data in and out.
 */

import type { ExternalAnnotationEvent, ReviewThreadsState } from "./external-annotation";
import { hostRequestRefusal, type HostControlAnswer } from "./host-control";
import { readHostMessagesValue, type HostMessage } from "./host-messages";
import { plannotatorToolReplyHow } from "./plannotator-tool";
import {
  ReviewJournalError,
  closeReviewJournal,
  markReviewSendsDelivered,
  markReviewSendsRead,
  readReviewJournal,
  replyInReview,
  resolveReviewComment,
  retryReviewJournalWrite,
  reviewCliHow,
  reviewJournalAgentRead,
  reviewJournalKey,
  reviewJournalStamp,
  reviewJournalView,
  reviewJournalWakeText,
  reviewTargetLine,
  normalizeReviewTarget,
  sendReviewComments,
  writeReviewComment,
  type ReviewCommentInput,
  type ReviewTarget,
} from "./review-journal";
import type { ReviewAgent, ReviewReplyHow, ReviewSend, ReviewSendMode } from "@plannotator/core/review-threads";

export const REVIEW_THREADS_PATH = "/api/threads";
export const REVIEW_THREADS_SEND_PATH = "/api/threads/send";
export const REVIEW_THREADS_RESOLVE_PATH = "/api/threads/resolve";
export const REVIEW_THREADS_REOPEN_PATH = "/api/threads/reopen";
export const HOST_THREADS_PATH = "/api/host/threads";
export const HOST_THREADS_REPLY_PATH = "/api/host/threads/reply";
export const HOST_MESSAGES_PATH = "/api/host/messages";
/** The `code` of the 404 the host paths answer while the loop is off for this review. */
export const REVIEW_LOOP_OFF_CODE = "review_loop_off";
/** The `code` of the 409 a page write gets while the loop is unavailable. */
export const REVIEW_LOOP_UNAVAILABLE_CODE = "review_loop_unavailable";
/** The `code` of the 409 a page write gets while the person has ended the review (until they reopen it). */
export const REVIEW_LOOP_ENDED_CODE = "review_ended";
/** The `code` of the 409 a reopen gets when the review is not ended here, or can no longer be reopened. */
export const REVIEW_LOOP_NOT_REOPENABLE_CODE = "not_reopenable";
/** How long an ended review stays reopenable with no page open or no host watching (a reload, a host restarting). */
export const REVIEW_LOOP_END_GRACE_MS = 30_000;

/**
 * What the agent reads when the person reopens a review they had ended (the
 * host heads it with the review and "Reopened"): one line, as a round's wake.
 */
export const REVIEW_REOPENED_TEXT =
  "The person reopened this review after ending it: it goes on, and their next comments come here as a round. End your turn without a message in chat.";

const PATHS: ReadonlySet<string> = new Set([
  REVIEW_THREADS_PATH,
  REVIEW_THREADS_SEND_PATH,
  REVIEW_THREADS_RESOLVE_PATH,
  REVIEW_THREADS_REOPEN_PATH,
  HOST_THREADS_PATH,
  HOST_THREADS_REPLY_PATH,
  HOST_MESSAGES_PATH,
]);

/** The most a decision's `reviewEnd` holds (the line the page writes of how a review under the loop ended). */
export const REVIEW_END_MAX = 2000;

/**
 * A decision body's `reviewEnd`: how the review ended (every comment thread
 * resolved, or the ids still open), which the page adds to Approve, Done and
 * Close once the loop ran in its tab, and the host's result gives the agent
 * as a line of its own. Undefined when absent, empty, not a string or too long.
 */
export function readReviewEnd(body: unknown): string | undefined {
  const value = body && typeof body === "object" ? (body as { reviewEnd?: unknown }).reviewEnd : undefined;
  if (typeof value !== "string") return undefined;
  const line = value.trim();
  return line && line.length <= REVIEW_END_MAX ? line : undefined;
}

/** Whether a path is the review loop's (its body, for a POST, is JSON). */
export function isReviewLoopPath(pathname: string): boolean {
  return PATHS.has(pathname);
}

/**
 * The host that carries sends to the agent's session: the pull bridge's
 * sends (packages/ai/session-bridge-pull.ts), read each time.
 */
export interface ReviewLoopCarrier {
  readonly ready: boolean;
  readonly busy: boolean;
  /** The agent answers with the `plannotator` tool's `reply` action. */
  readonly toolReply: boolean;
  /** The host keeps watching a review the person ended, so it can be reopened. */
  readonly reopen?: boolean;
  deliver(
    sendId: string,
    text: string,
    info: { mode: ReviewSendMode | "reopen"; round: number; comments: number },
    report: { delivered(): void; failed(message?: string): void },
  ): void;
}

/** `PLANNOTATOR_SESSION_TAG` (`claude-code:<session id>`) as the session a review's sends go to; null when it is not one. */
export function reviewLoopSessionOf(tag: string | undefined | null): { host: string; session: string } | null {
  const value = tag?.trim() ?? "";
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return null;
  return { host: value.slice(0, colon), session: value.slice(colon + 1) };
}

export interface ReviewLoopOptions {
  dataDir: string;
  /** experimental "persistent-comments" (`resolveExperimental`). */
  enabled: boolean;
  /** What the review is on; null: no journal for it (a URL, a bundle, a live app). */
  target: ReviewTarget | null;
  /** The agent session the sends go to; null: none known (no host tagged it). */
  to: { host: string; session: string } | null;
  /** The id the host gave this review (`pn-…`), which the tool's way to answer names. */
  reviewId?: string;
  /** Where a file's place is shown from in the agent's text. */
  root: string;
  /** The host's carrier, read each time; null: none. */
  carrier: () => ReviewLoopCarrier | null;
  /** Push an event to every open page (the external-annotation stream). */
  broadcast: (event: ExternalAnnotationEvent<never>) => void;
  /** The host-only paths' token (the host control token); undefined turns them off. */
  hostToken: () => string | undefined;
  getServerPort: () => number | undefined;
  /**
   * `last` only: the picker's messages the screen started with (newest
   * first; empty when it started with one message and no list). Absent: not
   * a `last` screen.
   */
  messages?: readonly HostMessage[];
  /** How an agent is named on its replies ("Claude Code"); the core's plain name by default. */
  agentName?: (author: ReviewAgent) => string;
  /** How often the journal and the host are looked at (default 1000 ms). */
  pollMs?: number;
  /** A write that failed after the answer went (a delivery's mark, an approval's close). */
  log?: (message: string) => void;
  /**
   * The server takes the person's decisions again (a reopen). Absent: an
   * ended review is never reopenable here (its CLI stops at the decision).
   */
  onReopen?: () => void;
  /** A page is open on this review (default: always). */
  pageOpen?: () => boolean;
  /** How long an ended review waits for a page or the host to come back (default `REVIEW_LOOP_END_GRACE_MS`). */
  endGraceMs?: number;
}

/** A request to one of the loop's paths, as plain data. */
export interface ReviewLoopRequest {
  method: string;
  pathname: string;
  host: string | null;
  origin: string | null;
  authorization: string | null;
  /** The JSON body of a POST; undefined when it had none or did not parse. */
  body: unknown;
}

export interface ReviewLoop {
  /** The page may use the loop now. */
  available(): boolean;
  /** Answer a loop path, or null when the path is not one. */
  handle(request: ReviewLoopRequest): Promise<HostControlAnswer | null>;
  /** `last`: the picker's list with the host's newer messages, or null when none came. */
  messages(): HostMessage[] | null;
  /** The person approved the review: it ends, and its journal goes. */
  approved(): Promise<void>;
  /**
   * The person ended the review on this screen (Approve, Done, Close). True:
   * it stays reopenable (the loop available, the host watching, the server
   * taking decisions again), until `afterEnd` says it is over; an approval's
   * journal goes then. False: it ends now, as `approved` does.
   */
  ended(how: { approved: boolean }): boolean;
  /**
   * After an `ended` that returned true, once: `reopened` when the person
   * takes the review up again (the server is taking decisions), `over` when
   * no page or no host stayed for the grace. Null when nothing ended so.
   */
  afterEnd(): Promise<"reopened" | "over"> | null;
  dispose(): void;
}

type SendCommentInput = ReviewCommentInput & { notes?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function journalRefusal(error: unknown): HostControlAnswer {
  if (error instanceof ReviewJournalError) {
    const status = error.code === "invalid" ? 400 : error.code === "not_found" ? 404 : error.code === "locked" ? 503 : 409;
    return { status, body: { error: error.message, code: error.code } };
  }
  throw error;
}

export function createReviewLoop(options: ReviewLoopOptions): ReviewLoop {
  const { dataDir, to, root } = options;
  // Named once: a file renamed or gone later does not move the review's writes to another journal.
  const target = options.enabled && options.target && to ? normalizeReviewTarget(options.target) : null;
  const key = target ? reviewJournalKey(target) : null;
  const ref = target ? { target } : null;
  // Writes give up at once on a held lock; the retry waits on timers.
  const writing = { dataDir, lockWaitMs: 0 };
  const log = options.log ?? ((message: string) => console.error(`[plannotator] ${message}`));
  let pushedMessages: HostMessage[] | null = null;
  let disposed = false;
  /** The loop was available here once: only then does an approval end the review's journal. */
  let used = false;
  /** Sends the host could not put in the session, until one is handed over again or delivered: the page shows them and may retry. */
  const failed = new Map<string, string | null>();
  /** The person ended the review here and may still reopen it: how it ended, and what `afterEnd` resolves. */
  let ending: { approved: boolean; resolve: (how: "reopened" | "over") => void; watch: ReturnType<typeof setInterval> } | null = null;
  /** The last reopenable end, until the caller takes it (`afterEnd`). */
  let endPending: Promise<"reopened" | "over"> | null = null;

  const available = (): boolean => {
    const on = key !== null && options.carrier()?.ready === true;
    if (on) used = true;
    return on;
  };
  const busy = (): boolean => options.carrier()?.busy === true;
  const how = (): ReviewReplyHow => (options.carrier()?.toolReply && options.reviewId ? plannotatorToolReplyHow(options.reviewId) : reviewCliHow(key!));

  const state = (): ReviewThreadsState => {
    if (!available()) return { available: false };
    const journal = readReviewJournal(dataDir, { key: key! });
    const view = reviewJournalView(journal, {
      busy: (session) => session === to!.session && busy(),
      ...(options.agentName ? { agentName: options.agentName } : {}),
    });
    return {
      available: true,
      review: key!,
      round: view.round,
      busy: busy(),
      view,
      ...(failed.size > 0 ? { failed: [...failed].map(([send, message]) => ({ send, message })) } : {}),
    };
  };

  // What the page was last told; the timer pushes again when it moves.
  const signature = (): string => (available() ? `on:${busy()}:${failed.size}:${reviewJournalStamp(dataDir, { key: key! })}` : "off");
  let told = signature();
  const push = () => {
    if (disposed) return;
    try {
      told = signature();
      options.broadcast({ type: "review-threads", ...state() });
    } catch (error) {
      log(`review loop: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = key
    ? setInterval(() => {
        try {
          if (signature() !== told) push();
        } catch {
          // A journal read that failed now is read again next tick.
        }
      }, options.pollMs ?? 1_000)
    : null;
  (timer as { unref?: () => void } | null)?.unref?.();

  const deliver = (send: ReviewSend, text: string, comments: number) => {
    failed.delete(send.id);
    options.carrier()?.deliver(send.id, text, { mode: send.mode, round: send.round, comments }, {
      delivered: () => {
        failed.delete(send.id);
        retryReviewJournalWrite(() => markReviewSendsDelivered(writing, { key: key! }, [send.id]))
          .then(push)
          .catch((error) => log(`review loop: could not mark ${send.id} delivered: ${error instanceof Error ? error.message : String(error)}`));
      },
      failed: (message) => {
        log(`review loop: ${send.id} did not reach the agent session${message ? ` (${message})` : ""}.`);
        failed.set(send.id, message ?? null);
        push();
      },
    });
  };

  const unavailable = (): HostControlAnswer => ({ status: 409, body: { error: "The review loop is not available for this review.", code: REVIEW_LOOP_UNAVAILABLE_CODE } });
  const endedRefusal = (): HostControlAnswer => ({ status: 409, body: { error: "This review was ended: reopen it to go on.", code: REVIEW_LOOP_ENDED_CODE } });

  const closeJournal = async () => {
    // Only a review this screen carried: a screen that kept today's single decision leaves the journal to whoever wrote it.
    if (key === null || !used) return;
    await retryReviewJournalWrite(() => closeReviewJournal(writing, { key })).catch((error) => {
      log(`review loop: could not close the journal of ${key}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const finishEnd = (how: "reopened" | "over") => {
    const end = ending;
    if (!end) return;
    ending = null;
    clearInterval(end.watch);
    if (how === "over" && end.approved) void closeJournal();
    end.resolve(how);
  };
  /** Still reopenable now: the loop available, and the host watching the review. */
  const reopenable = () => available() && options.carrier()?.reopen === true;

  const handleReopen = (): HostControlAnswer => {
    if (!ending) return { status: 409, body: { error: "This review is not ended here, or can no longer be reopened.", code: REVIEW_LOOP_NOT_REOPENABLE_CODE } };
    if (!reopenable()) return { status: 409, body: { error: "The agent session is not watching this review now: try again in a moment.", code: REVIEW_LOOP_UNAVAILABLE_CODE } };
    options.onReopen?.();
    finishEnd("reopened");
    const round = state();
    // The agent was told the review ended: it is told it goes on, in one line headed by the host.
    options.carrier()?.deliver(`reopen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, REVIEW_REOPENED_TEXT, { mode: "reopen", round: round.available ? round.round : 1, comments: 0 }, {
      delivered: () => {},
      failed: (message) => log(`review loop: the agent was not told the review was reopened${message ? ` (${message})` : ""}.`),
    });
    push();
    return { status: 200, body: { reopened: true, ...state() } };
  };

  const handleSend = async (body: unknown): Promise<HostControlAnswer> => {
    if (!available()) return unavailable();
    if (ending) return endedRefusal();
    if (!isRecord(body)) return { status: 400, body: { error: "Expected a JSON object." } };
    const mode = body.mode;
    if (mode !== "now" && mode !== "round") return { status: 400, body: { error: 'mode: "now" or "round".' } };
    const comments = body.comments === undefined ? [] : body.comments;
    if (!Array.isArray(comments) || !comments.every(isRecord)) return { status: 400, body: { error: "comments: a list of comments." } };
    if (body.ids !== undefined && (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string"))) return { status: 400, body: { error: "ids: a list of draft ids." } };
    if (body.words !== undefined && typeof body.words !== "string") return { status: 400, body: { error: "words: a string." } };
    if (body.idempotency_key !== undefined && typeof body.idempotency_key !== "string") return { status: 400, body: { error: "idempotency_key: a string." } };
    const idempotencyKey = (body.idempotency_key as string | undefined)?.trim() || undefined;
    // The lines a caller adds under a comment's heading (images, an element): kept on the comment for the agent's read of the round.
    const noteLines = (lines: unknown) => (Array.isArray(lines) ? lines.filter((line): line is string => typeof line === "string" && line.trim() !== "") : []);
    try {
      // A retry of the same press: nothing is written again, and a send not yet delivered is handed over again.
      const before = idempotencyKey ? readReviewJournal(dataDir, { key: key! }) : null;
      const replay = before?.sends.find((send) => send.idempotency_key === idempotencyKey);
      if (replay && before) {
        if (!replay.delivery) deliver(replay, reviewJournalWakeText(before, [replay.id], how()), before.comments.filter((record) => record.sent_reply_id === replay.id).length);
        return { status: 200, body: { send: replay, replayed: true, ...state() } };
      }
      // The person's drafts this press carries.
      const written: string[] = [];
      for (const raw of comments as unknown as SendCommentInput[]) {
        const { notes: lines, ...input } = raw;
        const comment = await retryReviewJournalWrite(() => writeReviewComment(writing, ref!, { ...input, ...(noteLines(lines).length > 0 ? { notes: noteLines(lines) } : {}) }));
        written.push(comment.id);
      }
      const ids = (body.ids as string[] | undefined) ?? written;
      const done = await retryReviewJournalWrite(() =>
        sendReviewComments(writing, ref!, {
          mode,
          ...(mode === "now" ? { ids } : {}),
          to: { host: to!.host, session: to!.session },
          ...(typeof body.words === "string" ? { words: body.words } : {}),
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        }),
      );
      const journal = readReviewJournal(dataDir, { key: key! })!;
      const text = reviewJournalWakeText(journal, [done.send.id], how());
      deliver(done.send, text, journal.comments.filter((record) => record.sent_reply_id === done.send.id).length);
      push();
      return { status: 200, body: { send: done.send, replayed: done.replayed, ...state() } };
    } catch (error) {
      push();
      return journalRefusal(error);
    }
  };

  const handleResolve = async (body: unknown): Promise<HostControlAnswer> => {
    if (!available()) return unavailable();
    if (ending) return endedRefusal();
    if (!isRecord(body) || typeof body.id !== "string" || !body.id) return { status: 400, body: { error: "id: the comment or sub-thread to resolve." } };
    if (body.resolved !== undefined && typeof body.resolved !== "boolean") return { status: 400, body: { error: "resolved: true, or false to reopen." } };
    const id = body.id;
    try {
      const comment = await retryReviewJournalWrite(() => resolveReviewComment(writing, { key: key! }, id, body.resolved !== false));
      push();
      return { status: 200, body: { comment, ...state() } };
    } catch (error) {
      return journalRefusal(error);
    }
  };

  // ── The host's side ──

  const handleHost = async (request: ReviewLoopRequest): Promise<HostControlAnswer> => {
    const refused = hostRequestRefusal(request, options.hostToken(), options.getServerPort());
    if (refused) return refused;
    if (request.pathname === HOST_MESSAGES_PATH) {
      if (request.method !== "POST") return { status: 405, body: { error: "Use POST." } };
      if (options.messages === undefined || key === null) return { status: 404, body: { error: "This review takes no messages.", code: REVIEW_LOOP_OFF_CODE } };
      const parsed = readHostMessagesValue(request.body);
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
      // The session's latest (at most 25), newest first, then the screen's own messages not among them:
      // the list never loses one the screen opened with, and stays bounded.
      const shown = pushedMessages ?? [...options.messages];
      const incoming = new Set(parsed.messages.map((message) => message.messageId));
      const merged = [...parsed.messages, ...options.messages.filter((message) => !incoming.has(message.messageId))];
      const changed = merged.length !== shown.length || merged.some((message, index) => message.messageId !== shown[index]?.messageId || message.text !== shown[index]?.text);
      if (changed) {
        pushedMessages = merged;
        options.broadcast({ type: "messages", messages: merged });
      }
      return { status: 200, body: { messages: merged.length, changed } };
    }
    if (key === null) return { status: 404, body: { error: "This review has no comment threads.", code: REVIEW_LOOP_OFF_CODE } };
    if (request.pathname === HOST_THREADS_PATH) {
      if (request.method !== "GET") return { status: 405, body: { error: "Use GET." } };
      try {
        // The agent read the threads: what reached it is read now.
        const read = await retryReviewJournalWrite(() => markReviewSendsRead(writing, { key }, to!.session)).catch((error) => {
          if (error instanceof ReviewJournalError && error.code === "not_found") return [];
          throw error;
        });
        if (read.length > 0) push();
        const journal = readReviewJournal(dataDir, { key });
        // What was sent: the person's drafts stay theirs until a send carries them.
        const view = reviewJournalView(journal, { sent: true, ...(options.agentName ? { agentName: options.agentName } : {}) });
        // What it is on, then the sends it has not answered (a send's wake is one line that points here), then every thread.
        const text = `On ${reviewTargetLine(journal?.target ?? target)}\n${reviewJournalAgentRead(journal, { root, how: how(), ...(options.agentName ? { agentName: options.agentName } : {}) })}`;
        return { status: 200, body: { review: key, round: view.round, text, view } };
      } catch (error) {
        return journalRefusal(error);
      }
    }
    // HOST_THREADS_REPLY_PATH
    if (request.method !== "POST") return { status: 405, body: { error: "Use POST." } };
    const body = request.body;
    if (!isRecord(body) || !Array.isArray(body.replies) || body.replies.length === 0) return { status: 400, body: { error: "replies: a list of { id, text }." } };
    const replies = body.replies.map((reply) => (isRecord(reply) ? { id: String(reply.id ?? ""), text: reply.text as string } : { id: "", text: "" }));
    const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : undefined;
    try {
      const done = await retryReviewJournalWrite(() => replyInReview(writing, { key }, replies, idempotencyKey ? { idempotency_key: idempotencyKey } : {}));
      push();
      return { status: 200, body: { review: key, replies: done.replies, replayed: done.replayed } };
    } catch (error) {
      return journalRefusal(error);
    }
  };

  return {
    available,
    async handle(request) {
      if (!isReviewLoopPath(request.pathname)) return null;
      if (request.pathname.startsWith("/api/host/")) return handleHost(request);
      if (request.pathname === REVIEW_THREADS_PATH) {
        if (request.method !== "GET") return { status: 405, body: { error: "Use GET." } };
        try {
          return { status: 200, body: state() };
        } catch (error) {
          return journalRefusal(error);
        }
      }
      if (request.method !== "POST") return { status: 405, body: { error: "Use POST." } };
      if (request.pathname === REVIEW_THREADS_REOPEN_PATH) return handleReopen();
      return request.pathname === REVIEW_THREADS_SEND_PATH ? handleSend(request.body) : handleResolve(request.body);
    },
    messages: () => (pushedMessages ? [...pushedMessages] : null),
    approved: closeJournal,
    ended(how) {
      if (ending || disposed || !options.onReopen || !reopenable()) {
        if (how.approved) void closeJournal();
        return false;
      }
      let resolve!: (how: "reopened" | "over") => void;
      endPending = new Promise((settle) => {
        resolve = settle;
      });
      // Over once no page is open, or the host stopped watching, for the whole grace (a reload, a host restarting).
      let awaySince: number | null = null;
      const watch = setInterval(() => {
        if (reopenable() && (options.pageOpen?.() ?? true)) {
          awaySince = null;
          return;
        }
        const now = Date.now();
        awaySince ??= now;
        if (now - awaySince >= (options.endGraceMs ?? REVIEW_LOOP_END_GRACE_MS)) finishEnd("over");
      }, options.pollMs ?? 1_000);
      ending = { approved: how.approved, resolve, watch };
      return true;
    },
    afterEnd() {
      const pending = endPending;
      endPending = null;
      return pending;
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      // Stopping: whoever waits on the end hears it is over (the journal is left as it is).
      const end = ending;
      if (end) {
        ending = null;
        clearInterval(end.watch);
        end.resolve("over");
      }
    },
  };
}

/**
 * What an annotate screen's journal names: the agent session's last messages
 * (`annotate-last`, from the host's session tag), a folder, or one local file;
 * null for a URL, a bundle, a live app.
 */
export function annotateReviewTarget(input: { mode: string | undefined; filePath: string; folderPath?: string; hostSession?: string }): ReviewTarget | null {
  if (input.mode === "annotate-last") {
    const session = reviewLoopSessionOf(input.hostSession);
    return session ? { kind: "last", host: session.host, session: session.session } : null;
  }
  if (input.mode === "annotate-folder") return input.folderPath ? { kind: "file", path: input.folderPath } : null;
  if ((input.mode ?? "annotate") === "annotate" && input.filePath && !/^https?:\/\//i.test(input.filePath)) return { kind: "file", path: input.filePath };
  return null;
}
