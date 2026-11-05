/**
 * `plannotator inbox review` (experimental "persistent-comments") against a
 * real sandbox Inbox in this process, and the transcript the Inbox reads to
 * check a dropped chat message.
 *
 * What can regress: the drop landing as another session's, stdout carrying
 * more than the address (a caller opens or prints it), `--open` opening
 * nothing or another address, a refusal read as a success, a relative file
 * path resolved elsewhere than the shell's folder, an Inbox started only to
 * refuse, and the transcript read out of order (a turn split into messages
 * would no longer match). No
 * process is spawned, no browser opens and no real transcript is read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { readInboxHostMessages, runInboxReviewCommand, type ReviewCommandDeps } from "./inbox-review-command";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const ENV = { PLANNOTATOR_SESSION_TAG: "claude-code:ses_cli" };

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-review-cli-")));
  roots.push(root);
  return root;
}

async function world(options: { persistentComments?: boolean; live?: boolean } = {}) {
  const root = scratch();
  const dataDir = join(root, "data");
  const project = join(root, "app");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Notes\n\nShip on Friday.\n");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false, persistentComments: options.persistentComments ?? true });
  servers.push(server);
  if (options.live ?? true) {
    const response = await fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: "ses_cli", host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false }),
    });
    expect(response.status).toBe(200);
  }
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const deps = (extra: Partial<ReviewCommandDeps> = {}): ReviewCommandDeps => ({
    cwd: project,
    env: ENV,
    running: async () => ({ port: server.port }) as Awaited<ReturnType<ReviewCommandDeps["running"]>>,
    openUrl: async (url) => {
      opened.push(url);
      return "opened";
    },
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    ...extra,
  });
  return { server, project, out, err, opened, deps };
}

describe("plannotator inbox review", () => {
  test("the message on stdin lands in the shell's session's review thread; stdout is its address alone; --open opens that address", async () => {
    const w = await world();
    const code = await runInboxReviewCommand(["--message", "-", "--open"], w.deps({ stdin: async () => "The backoff is now 2, 4 and 8 seconds." }));
    expect(w.err.join("")).toBe("");
    expect(code).toBe(0);
    const url = w.out.join("").trim();
    expect(w.out.join("")).toBe(`${url}\n`);
    expect(w.opened).toEqual([url]);
    const params = new URLSearchParams(new URL(url).hash.slice(1));
    const message = w.server.store.message(params.get("msg")!)!;
    expect(message.author).toMatchObject({ kind: "agent", host: "claude-code", session: "ses_cli" });
    expect(message.imported).toMatchObject({ from: "transcript", by: { kind: "cli" } });
    expect(message.thread_id).toBe(params.get("thread")!);
  });

  test("a file relative to the shell's folder, for the session --session names", async () => {
    const w = await world();
    const code = await runInboxReviewCommand(["--file", "notes.md", "--session", "claude-code:ses_cli"], w.deps({ env: {} }));
    expect(w.err.join("")).toBe("");
    expect(code).toBe(0);
    expect(w.opened).toEqual([]);
    const params = new URLSearchParams(new URL(w.out.join("").trim()).hash.slice(1));
    const root = w.server.store.message(params.get("thread")!)!;
    expect(root.attachments?.map((a) => [a.id, a.path])).toEqual([[params.get("file")!, join(w.project, "notes.md")]]);
  });

  test("a refusal: exit 1, its code on stderr, nothing on stdout, nothing opened, no Inbox started", async () => {
    const off = await world({ persistentComments: false });
    expect(await runInboxReviewCommand(["--message", "-", "--open"], off.deps({ stdin: async () => "Done." }))).toBe(1);
    expect(off.err.join("")).toStartWith("persistent_comments_off: ");
    expect(off.out).toEqual([]);
    expect(off.opened).toEqual([]);

    const gone = await world({ live: false });
    expect(await runInboxReviewCommand(["--message", "-"], gone.deps({ stdin: async () => "Done." }))).toBe(1);
    expect(gone.err.join("")).toStartWith("session_not_live: ");
    expect(gone.out).toEqual([]);

    // No Inbox running: refused at once, none started (no session is connected to a new one yet).
    const stopped = await world();
    expect(await runInboxReviewCommand(["--message", "-"], stopped.deps({ running: async () => null, stdin: async () => "Done." }))).toBe(1);
    expect(stopped.err.join("")).toStartWith("inbox_not_running: ");
    expect(stopped.out).toEqual([]);
  });

  test("bad usage exits 2 before any call: no target, two targets, --message without -, an empty message, no session", async () => {
    const w = await world();
    let called = 0;
    const deps = w.deps({ running: async () => ((called += 1), { port: w.server.port }) as Awaited<ReturnType<ReviewCommandDeps["running"]>>, stdin: async () => "  \n" });
    for (const argv of [[], ["--message", "-", "--file", "notes.md"], ["--message", "hello"], ["--message", "-"]]) {
      expect(await runInboxReviewCommand(argv, deps)).toBe(2);
    }
    expect(await runInboxReviewCommand(["--file", "notes.md"], { ...deps, env: {} })).toBe(2);
    expect(w.err.at(-1)).toStartWith("no_session: ");
    expect(called).toBe(0);
    expect(w.out).toEqual([]);
  });
});

describe("the transcript the Inbox reads", () => {
  test("a Claude Code session's assistant messages, oldest first, chunks of one message joined; none for another host or an unknown session", async () => {
    const projects = join(scratch(), "projects");
    mkdirSync(join(projects, "-work-app"), { recursive: true });
    const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
    writeFileSync(
      join(projects, "-work-app", "ses_cli.jsonl"),
      [
        line({ type: "user", message: { role: "user", content: "Fix the retry loop." } }),
        line({ type: "assistant", message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "I moved the retry loop." }] } }),
        line({ type: "assistant", message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "The backoff is now" }] } }),
        line({ type: "assistant", message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "2, 4 and 8 seconds." }] } }),
      ].join("\n"),
    );
    expect(await readInboxHostMessages("claude-code", "ses_cli", projects)).toEqual([
      { id: "msg_1", text: "I moved the retry loop." },
      { id: "msg_2", text: "The backoff is now\n2, 4 and 8 seconds." },
    ]);
    expect(await readInboxHostMessages("pi", "ses_cli", projects)).toBeNull();
    expect(await readInboxHostMessages("claude-code", "ses_other", projects)).toBeNull();
  });
});
