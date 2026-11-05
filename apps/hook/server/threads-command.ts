/**
 * `plannotator threads` and `plannotator reply`: the review journal
 * (packages/shared/review-journal.ts) from a shell, with no server and no
 * Inbox, as `crit comment` writes crit's review file.
 *
 * - The agent: `threads --review <key>` reads a review's threads (`--json`:
 *   the thread view, v: 1); `reply --review <key> <id>` writes its reply
 *   under a comment. No command of the agent's resolves: only the person does.
 * - A client with no server of its own (a terminal client): `threads <action>
 *   [<json> | -]` writes the person's side (comments, replies, sub-threads,
 *   resolutions, sends, deliveries, the close on approval) and reads the view;
 *   `send` gives back the text to hand the agent, composed by the shared core
 *   with the CLI's way to answer (`reviewCliHow`); given a send's `id`, that
 *   send's text again, nothing written (a client that closed before handing it
 *   over). A Finish with nothing to carry writes no round (`empty`).
 *
 * Unreleased (HIDDEN_SUBCOMMANDS): nothing calls them until a client does.
 * stdout carries the result only (one JSON value for a client's action); a
 * refusal goes to stderr as `<code>: <message>`. Exit 0 ok, 1 refused, 2 bad usage.
 */

import { inboxAgentName } from "@plannotator/core/inbox-types";
import { reviewAnchorPlace, reviewThreadViewText, type ReviewAnchor } from "@plannotator/core/review-threads";
import {
  ReviewJournalError,
  anchorReviewComment,
  closeReviewJournal,
  isReviewJournalKey,
  listReviewJournals,
  markReviewSendsDelivered,
  readReviewJournal,
  readReviewTarget,
  removeReviewComment,
  replyInReview,
  resolveReviewComment,
  reviewCliHow,
  reviewJournalKey,
  reviewJournalSendText,
  reviewJournalView,
  sendReviewComments,
  writeReviewComment,
  type ReviewCommentInput,
  type ReviewJournalRef,
  type ReviewTarget,
} from "@plannotator/shared/review-journal";
import { resolve } from "node:path";
import { THREADS_COMMAND_USAGE } from "./cli";

/** The actions a client calls: `plannotator threads <action> [<json> | -]`. */
export const THREADS_CLIENT_ACTIONS = ["view", "comment", "remove", "resolve", "reopen", "anchor", "send", "delivered", "close"] as const;
type ThreadsAction = (typeof THREADS_CLIENT_ACTIONS)[number];

/** The most read from stdin: a reply, or a client's JSON with its drawing data. */
const STDIN_MAX_BYTES = 4 * 1024 * 1024;

export interface ThreadsCommandDeps {
  dataDir: string;
  /** Where file paths are shown from. */
  cwd: string;
  stdin?: ReadableStream<Uint8Array>;
  /** Whether stdin is a terminal (nothing piped in). Default: the process's. */
  stdinIsTTY?: boolean;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Tests: the clock. */
  now?: () => number;
}

async function readStdin(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > STDIN_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** How a review's target reads in a list or a heading. */
function targetLine(target: ReviewTarget | null): string {
  if (!target) return "(target unknown)";
  if (target.kind === "last") return `the last messages of ${target.host} session ${target.session}`;
  if (target.kind === "file") return target.path;
  return `plan ${target.slug} (${target.project})`;
}

class Usage extends Error {}

/**
 * `--help` or `-h` in a flag's place: before the first word that is not an
 * option (an id, a reply's words, a client's JSON) and before `--`, so a
 * reply that says "-h" is written, never read as a call for help.
 */
function helpAsked(argv: readonly string[], valued: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") return true;
    if (arg === "--" || !arg.startsWith("-")) return false;
    if (valued.includes(arg)) index++;
  }
  return false;
}

function flagValue(argv: readonly string[], index: number, flag: string): string {
  const arg = argv[index]!;
  if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Usage(`${flag} needs a value.`);
  return value;
}

/** `plannotator threads …`. */
export async function runThreadsCommand(argv: readonly string[], deps: ThreadsCommandDeps): Promise<number> {
  return run(deps, async (io) => {
    if (helpAsked(argv, ["--review"])) {
      io.out(THREADS_COMMAND_USAGE);
      return 0;
    }
    if ((THREADS_CLIENT_ACTIONS as readonly string[]).includes(argv[0] ?? "")) return clientAction(argv[0] as ThreadsAction, argv.slice(1), deps, io);
    let key: string | null = null;
    let json = false;
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index]!;
      if (arg === "--json") json = true;
      else if (arg === "--review" || arg.startsWith("--review=")) {
        key = flagValue(argv, index, "--review");
        if (!arg.includes("=")) index++;
      } else throw new Usage(`Unknown argument: ${arg}`);
    }
    if (key === null) {
      const reviews = listReviewJournals(deps.dataDir);
      if (json) io.out(JSON.stringify(reviews));
      else if (reviews.length === 0) io.out("No review has threads.");
      else for (const review of reviews) io.out(`${review.key}  ${targetLine(review.target)}: round ${review.round}, ${review.open} open, ${review.drafts} draft${review.drafts === 1 ? "" : "s"}`);
      return 0;
    }
    if (!isReviewJournalKey(key)) throw new ReviewJournalError("invalid", `Not a review key: ${key}. \`plannotator threads\` lists the reviews.`);
    const state = readReviewJournal(deps.dataDir, { key });
    if (!state) throw new ReviewJournalError("not_found", `No review ${key}: \`plannotator threads\` lists the reviews.`);
    // What was sent: the person's drafts are theirs until a send carries them.
    const view = reviewJournalView(state, { sent: true, agentName: inboxAgentName });
    if (json) io.out(JSON.stringify({ review: key, target: state.target, ...view }));
    else io.out(`Review ${key}, on ${targetLine(state.target)}\n${reviewThreadViewText(view, reviewAnchorPlace, deps.cwd)}`);
    return 0;
  });
}

/** `plannotator reply --review <key> <id> [<reply> | -]`. */
export async function runReplyCommand(argv: readonly string[], deps: ThreadsCommandDeps): Promise<number> {
  return run(deps, async (io) => {
    if (helpAsked(argv, ["--review"])) {
      io.out(THREADS_COMMAND_USAGE);
      return 0;
    }
    let key: string | null = null;
    const words: string[] = [];
    let flagsDone = false;
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index]!;
      if (!flagsDone && arg === "--") flagsDone = true;
      else if (!flagsDone && (arg === "--review" || arg.startsWith("--review="))) {
        key = flagValue(argv, index, "--review");
        if (!arg.includes("=")) index++;
      } else if (!flagsDone && arg.startsWith("--")) throw new Usage(`Unknown option: ${arg}`);
      else words.push(arg);
    }
    if (key === null) throw new Usage("--review <key>: the review, as the comments you were sent name it.");
    const [id, ...rest] = words;
    if (!id) throw new Usage("<id>: the comment you reply under.");
    let text = rest.join(" ");
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "-")) {
      if (deps.stdinIsTTY ?? process.stdin.isTTY === true) throw new Usage("Give your reply after <id>, or on stdin (a quoted heredoc: <<'END').");
      const read = await readStdin(deps.stdin ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>));
      if (read === null) throw new Usage("The reply on stdin is too long.");
      text = read;
    }
    const done = replyInReview({ dataDir: deps.dataDir, now: deps.now }, { key }, [{ id, text }]);
    const reply = done.replies[0]!;
    io.out(`Replied under ${reply.re} in review ${key}${reply.re !== id ? ` (${id} is under it)` : ""}.`);
    return 0;
  });
}

function refOf(args: Record<string, unknown>, cwd: string): ReviewJournalRef {
  const key = args.review;
  if (args.target !== undefined) {
    const named = readReviewTarget(args.target);
    // A relative path is the caller's, from the folder it runs in (PLANNOTATOR_CWD), as a screen names its file.
    const target: ReviewTarget = named.kind === "file" ? { kind: "file", path: resolve(cwd, named.path) } : named;
    if (key !== undefined && key !== reviewJournalKey(target)) throw new ReviewJournalError("invalid", "review and target name two reviews: give one.");
    return { target };
  }
  if (typeof key !== "string") throw new ReviewJournalError("invalid", 'Name the review: "review": <key>, or "target": {...}.');
  return { key };
}

function keyOfRef(ref: ReviewJournalRef): string {
  return "key" in ref ? ref.key : reviewJournalKey(ref.target);
}

function idOf(args: Record<string, unknown>): string {
  if (typeof args.id !== "string" || !args.id) throw new ReviewJournalError("invalid", "id: the comment's id.");
  return args.id;
}

async function clientAction(action: ThreadsAction, argv: readonly string[], deps: ThreadsCommandDeps, io: Io): Promise<number> {
  if (argv.length > 1) throw new Usage(`One JSON argument after ${action} (or - for stdin).`);
  let raw = argv[0];
  if (raw === undefined || raw === "-") {
    if (raw === undefined && (deps.stdinIsTTY ?? process.stdin.isTTY === true)) throw new Usage(`Give ${action}'s JSON, or - to read it from stdin.`);
    const read = await readStdin(deps.stdin ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>));
    if (read === null) throw new Usage("The JSON on stdin is too long.");
    raw = read;
  }
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    args = parsed as Record<string, unknown>;
  } catch {
    throw new Usage(`${action}: one JSON object.`);
  }
  const ref = refOf(args, deps.cwd);
  const review = keyOfRef(ref);
  const options = { dataDir: deps.dataDir, now: deps.now };
  const result = ((): Record<string, unknown> => {
    switch (action) {
      case "view": {
        const state = readReviewJournal(deps.dataDir, ref);
        return { review, target: state?.target ?? ("target" in ref ? ref.target : null), view: reviewJournalView(state, { agentName: inboxAgentName }) };
      }
      case "comment":
        return { review, comment: writeReviewComment(options, ref, args as unknown as ReviewCommentInput) };
      case "remove":
        return { review, removed: removeReviewComment(options, ref, idOf(args)) };
      case "resolve":
      case "reopen":
        return { review, comment: resolveReviewComment(options, ref, idOf(args), action === "resolve") };
      case "anchor":
        return { review, comment: anchorReviewComment(options, ref, idOf(args), { ...(args.on !== undefined ? { on: args.on as ReviewAnchor } : {}), unanchored: args.unanchored === true }) };
      case "send": {
        const root = typeof args.root === "string" && args.root ? args.root : deps.cwd;
        if (args.id !== undefined) {
          // A send already written, its text composed again: a client that closed before handing it over.
          const state = readReviewJournal(deps.dataDir, ref);
          const send = state?.sends.find((known) => known.id === args.id);
          if (!state || !send) throw new ReviewJournalError("not_found", `No send ${String(args.id)}.`);
          return { review, send, replayed: true, text: reviewJournalSendText(state, [send.id], { root, how: reviewCliHow(review) }) };
        }
        const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : undefined;
        const to = args.to as { host: string | null; session: string } | undefined;
        const done = sendReviewComments(options, ref, {
          mode: args.mode as "now" | "round",
          ...(ids ? { ids } : {}),
          ...(to !== undefined ? { to } : {}),
          ...(typeof args.words === "string" ? { words: args.words } : {}),
          ...(typeof args.idempotency_key === "string" ? { idempotency_key: args.idempotency_key } : {}),
          refuse_empty: true,
        });
        const state = readReviewJournal(deps.dataDir, { key: review })!;
        return { review, send: done.send, replayed: done.replayed, text: reviewJournalSendText(state, [done.send.id], { root, how: reviewCliHow(review) }) };
      }
      case "delivered": {
        const ids = Array.isArray(args.sends) ? args.sends.filter((id): id is string => typeof id === "string") : [];
        if (ids.length === 0) throw new ReviewJournalError("invalid", "sends: the sends handed to the agent, by id.");
        return { review, sends: markReviewSendsDelivered(options, ref, ids) };
      }
      case "close":
        return { review, closed: closeReviewJournal(options, ref) };
    }
  })();
  io.out(JSON.stringify(result));
  return 0;
}

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

async function run(deps: ThreadsCommandDeps, body: (io: Io) => Promise<number>): Promise<number> {
  const io: Io = { out: deps.out ?? ((text) => console.log(text)), err: deps.err ?? ((text) => console.error(text)) };
  try {
    return await body(io);
  } catch (error) {
    if (error instanceof Usage) {
      io.err(error.message);
      io.err("Run 'plannotator threads --help' for usage.");
      return 2;
    }
    if (error instanceof ReviewJournalError) {
      io.err(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
