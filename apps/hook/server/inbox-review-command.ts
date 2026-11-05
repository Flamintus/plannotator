/**
 * `plannotator inbox review` (experimental "persistent-comments"): drop a
 * message of this agent's chat, or a file, into the session's review thread
 * in the Inbox, so the person comments on it there and a Send wakes the
 * session. A thin client of `POST /api/inbox/review-targets`
 * (packages/server/inbox-review-targets.ts), where the rules live.
 *
 * Who it is for: the session the shell names, as `plannotator inbox call`
 * reads it (`inboxCallerOf`), or `--session <host>:<id>`. stdout: the
 * window's address of the thread, and nothing on failure. `--open` opens it
 * in the browser, as `plannotator inbox --open` does; the Inbox itself never
 * opens a tab.
 *
 * Also here: what the Inbox reads of a session's transcript to check a
 * dropped chat message (`readInboxHostMessages`, Claude Code only), passed to
 * the Inbox at its start (inbox-command.ts).
 */

import { isAbsolute, resolve } from "node:path";
import type { InboxHostMessage } from "@plannotator/core/inbox-types";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { hasHelpFlag } from "./cli";
import { inboxCallerOf } from "./inbox-call-command";
import { inboxSessionProjectFromEnv } from "./inbox-mcp-shim";
import { findClaudeSessionLogById, getRecentRenderedMessages } from "./session-log";

/** One request never waits longer: a wedged Inbox must not hang the command. */
const REQUEST_TIMEOUT_MS = 30_000;

export const INBOX_REVIEW_USAGE = [
  "Usage:",
  "  plannotator inbox review --message - [--session <host>:<id>] [--open]",
  "  plannotator inbox review --file <path> [--session <host>:<id>] [--open]",
  "",
  "Puts a message of this agent session's chat (its text on stdin), or a file, in the",
  "session's review thread in the Plannotator Inbox, for the person to comment on there.",
  "The same message or file again answers the thread it is already in.",
  "",
  "--session <host>:<id>  The agent session it is for. Default: the session this shell names.",
  "--open                 Also open the thread in the browser.",
  "",
  "Needs Settings → Capabilities → Experimental → \"Comments stay after Send\", and the session",
  "connected to the Inbox. stdout is the thread's address, and nothing on failure.",
  "Exit 0 ok, 1 refused or no Inbox (<code>: <message> on stderr), 2 bad usage.",
].join("\n");

export type ParsedReviewCommand =
  | { ok: true; target: { kind: "message" } | { kind: "file"; path: string }; session: string | null; open: boolean }
  | { ok: false; error: string };

export function parseReviewCommand(argv: readonly string[]): ParsedReviewCommand {
  let target: { kind: "message" } | { kind: "file"; path: string } | null = null;
  let session: string | null = null;
  let open = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--message" || arg === "--file") {
      const value = argv[++i];
      if (target !== null) return { ok: false, error: "inbox review takes one of --message - or --file <path>." };
      if (arg === "--message") {
        if (value !== "-") return { ok: false, error: "--message takes -: the message's text comes on stdin." };
        target = { kind: "message" };
      } else {
        if (value === undefined || value === "") return { ok: false, error: "--file takes the file's path." };
        target = { kind: "file", path: value };
      }
    } else if (arg === "--session") {
      const value = argv[++i];
      if (value === undefined) return { ok: false, error: "--session takes <host>:<id>." };
      if (session !== null) return { ok: false, error: "--session given twice." };
      session = value;
    } else if (arg === "--open") open = true;
    else return { ok: false, error: `Unknown inbox review option: ${arg}.` };
  }
  if (target === null) return { ok: false, error: "inbox review needs --message - or --file <path>." };
  return { ok: true, target, session, open };
}

export interface ReviewCommandDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  /** Opens the thread for `--open`: `remote` when nothing could open it here (an SSH session). */
  openUrl: (url: string) => Promise<"opened" | "none" | "remote" | "failed">;
  /** Inside an agent Plannotator's Ask AI started (`isAskAiChild`): the Inbox is off there. */
  askAiChild?: boolean;
  /** Default: this process's stdin. */
  stdin?: () => Promise<string>;
  out?: (text: string) => void | Promise<void>;
  err?: (text: string) => void;
  /** Tests: how long one request may take. */
  timeoutMs?: number;
}

/** Run `plannotator inbox review …`; resolves to the exit code. */
export async function runInboxReviewCommand(argv: readonly string[], deps: ReviewCommandDeps): Promise<number> {
  const out = deps.out ?? ((text: string) => new Promise<void>((done) => void process.stdout.write(text, () => done())));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const refused = (code: string, message: string, exit = 1) => {
    err(`${code}: ${message}\n`);
    return exit;
  };
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_REVIEW_USAGE}\n`);
    return 0;
  }
  const parsed = parseReviewCommand(argv);
  if (!parsed.ok) {
    err(`usage: ${parsed.error}\n${INBOX_REVIEW_USAGE}\n`);
    return 2;
  }
  if (deps.askAiChild) return refused("inbox_off", "The Plannotator Inbox is off in an agent that Plannotator's Ask AI started.");
  const caller = inboxCallerOf(parsed.session, deps.env);
  if (!caller.ok) return refused(caller.code, caller.message, caller.usage ? 2 : 1);
  if (!caller.caller) return refused("no_session", "This shell names no agent session: pass --session <host>:<id>.", 2);
  const session = caller.caller.host ? `${caller.caller.host}:${caller.caller.session}` : caller.caller.session;

  let target: Record<string, unknown>;
  if (parsed.target.kind === "message") {
    const text = (await (deps.stdin ?? (() => Bun.stdin.text()))()).replace(/^\uFEFF/, "");
    if (!text.trim()) return refused("usage", "The message on stdin is empty.", 2);
    target = { kind: "chat_message", text };
  } else {
    target = { kind: "file", path: isAbsolute(parsed.target.path) ? parsed.target.path : resolve(deps.cwd, parsed.target.path) };
  }
  // The session's own project when its host says where it is, else where this shell is.
  const project = inboxSessionProjectFromEnv(deps.env);
  const projectPath = project && project.session === caller.caller.session ? project.folder : deps.cwd;
  const body = JSON.stringify({ session, project_path: projectPath, target, idempotency_key: crypto.randomUUID() });

  let entry: InboxRegistryEntry;
  try {
    entry = await deps.ensureRunning();
  } catch (error) {
    return refused("inbox_not_running", `Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}`);
  }
  let status: number;
  let answer: Record<string, unknown>;
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/review-targets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    answer = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return refused("inbox_no_answer", `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (status === 404 && answer.code === "not_found") return refused("inbox_too_old", "The running Inbox takes no review threads: run plannotator inbox restart.");
  if (status !== 200 || typeof answer.url !== "string") {
    return refused(typeof answer.code === "string" ? answer.code : "inbox_error", typeof answer.error === "string" ? answer.error : `The Inbox answered ${status}.`);
  }
  if (parsed.open && (await deps.openUrl(answer.url)) === "remote") {
    err(`No browser opened: this is a remote session. Forward the port (ssh -L ${entry.port}:127.0.0.1:${entry.port} <this host>) and open the address.\n`);
  }
  await out(`${answer.url}\n`);
  return 0;
}

/** How many of a transcript's latest assistant messages a dropped chat message is checked against. */
const TRANSCRIPT_MESSAGES = 200;

/**
 * A session's assistant messages, oldest first, for the Inbox's check of a
 * dropped chat message: Claude Code's transcript by its session id. Null for
 * another host, or when no single transcript has that id.
 */
export async function readInboxHostMessages(host: string, session: string, projectsDir?: string): Promise<InboxHostMessage[] | null> {
  if (host !== "claude-code") return null;
  const log = findClaudeSessionLogById(session, projectsDir);
  if (!log) return null;
  return getRecentRenderedMessages(log, TRANSCRIPT_MESSAGES)
    .reverse()
    .map((message) => ({ id: message.messageId, text: message.text }));
}
