/**
 * Review targets (experimental "persistent-comments"), through the server's
 * real doors: a chat message or a file the person drops for a live session
 * lands in that session's review thread, as the session's agent's message,
 * once; the agent's own sends stay apart; the copy is never the agent's
 * answer; a comment on it and its Send reach that session. Every test has its
 * own temp data dir; the session is a plain bridge poll, never a real agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxHostMessage, InboxListRow, InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSION = "ses-review";
const TAG = `claude-code:${SESSION}`;
const TEXT = "I moved the retry loop into the client.\n\nThe backoff is now 2, 4 and 8 seconds.";

async function setup(options: { persistentComments?: boolean; readHostMessages?: (host: string, session: string) => Promise<readonly InboxHostMessage[] | null> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-review-targets-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Notes\n\nShip on Friday.\n");
  writeFileSync(join(project, "plan.md"), "# Plan\n\nOne store first.\n");
  const server = await startInboxServer({ dataDir: join(root, "data"), persistentComments: options.persistentComments ?? true, ...(options.readHostMessages ? { readHostMessages: options.readHostMessages } : {}) });
  servers.push(server);
  return { server, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

/** One poll from the session's connection: live for 30 s after it; answers what it was handed. */
async function poll(server: InboxServer, project: string) {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session: SESSION, host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false }),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

function post(server: InboxServer, path: string, body: Record<string, unknown>) {
  return fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

let keys = 0;
/** A drop as `plannotator inbox review` makes it: no Origin, a fresh key each time unless given. */
async function drop(server: InboxServer, target: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const response = await post(server, "/api/inbox/review-targets", { session: TAG, target, idempotency_key: `k-${++keys}`, ...extra });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread & { row: InboxListRow }> {
  const body = (await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread; row: InboxListRow };
  return { ...body.thread, row: body.row };
}

async function threadCount(server: InboxServer): Promise<number> {
  const list = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: unknown[] }[] };
  return list.sections.reduce((total, section) => total + section.threads.length, 0);
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-review-targets-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base(server)}/mcp`)));
  clients.push(client);
  return client;
}

async function send(client: Client, project: string, body: string): Promise<Record<string, any>> {
  const result = (await client.callTool({ name: "send_message", arguments: { project_path: project, body, agent_session: SESSION, agent_host: "claude-code", agent_name: "Claude Code" } })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

describe("refused, nothing written", () => {
  test("with sent comments off", async () => {
    const { server, project } = await setup({ persistentComments: false });
    await poll(server, project);
    const answer = await drop(server, { kind: "chat_message", text: TEXT });
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe("persistent_comments_off");
    expect(await threadCount(server)).toBe(0);
  });

  test("for a session that is not live", async () => {
    const { server } = await setup();
    const answer = await drop(server, { kind: "chat_message", text: TEXT });
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe("session_not_live");
    expect(await threadCount(server)).toBe(0);
  });
});

describe("a chat message", () => {
  test("lands as the session's agent's message, marked, in a thread of its own that is no news; the agent's own sends stay apart", async () => {
    const { server, project } = await setup();
    await poll(server, project);
    const client = await agent(server);
    const own = await send(client, project, "Started on the retry loop.");

    // A question block in the chat's words asks the person nothing here.
    const answer = await drop(server, { kind: "chat_message", text: `${TEXT}\n\n:::question\nShip it?\n- [ ] Yes\n- [ ] No\n:::`, host_message_id: "msg_01A" });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ created: true, verified: false });
    expect(answer.body.thread_id).not.toBe(own.thread_id);
    const url = new URL(answer.body.url);
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toEqual({ thread: answer.body.thread_id, msg: answer.body.message_id });

    const review = await thread(server, answer.body.thread_id);
    const message = review.messages[0]!;
    expect(message.author).toEqual({ kind: "agent", host: "claude-code", session: SESSION, name: "Claude Code" });
    expect(message.imported).toMatchObject({ from: "transcript", host_message_id: "msg_01A", by: { kind: "cli" } });
    expect(message.imported!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(message.questions ?? []).toEqual([]);
    expect(review.row).toMatchObject({ unseen: 0, section: "quiet", unread: false, waiting_on_person: false, last_agent_at: null });
    // Nor is it the session's activity: compose still names its own thread as its last.
    const live = (await (await fetch(`${base(server)}/api/inbox/sessions`)).json()) as { projects: { sessions: { session: string; last_thread: { id: string } | null }[] }[] };
    expect(live.projects.flatMap((group) => group.sessions).find((entry) => entry.session === SESSION)?.last_thread?.id).toBe(own.thread_id);

    // The agent's next send without a thread name joins its own thread, never the review thread.
    expect((await send(client, project, "Retry loop done.")).thread_id).toBe(own.thread_id);
    // It takes comments like any message of the agent.
    const comment = { id: "c-1", blockId: "block-1", startOffset: 0, endOffset: 4, type: "COMMENT", text: "Why here?", originalText: "I moved", createdA: 1 };
    expect((await post(server, `/api/inbox/messages/${message.id}/annotations`, { annotation: comment })).status).toBe(200);
  });

  test("dropped again writes nothing; new words are a new message of the same thread; once resolved, a new thread", async () => {
    const { server, project } = await setup();
    await poll(server, project);
    const first = (await drop(server, { kind: "chat_message", text: TEXT, host_message_id: "msg_01A" })).body;

    // The same id and words, or the same words without an id (spaced otherwise): the message already there.
    const again = (await drop(server, { kind: "chat_message", text: TEXT, host_message_id: "msg_01A" })).body;
    const respaced = (await drop(server, { kind: "chat_message", text: TEXT.replace("\n\n", "\n") })).body;
    for (const answer of [again, respaced]) expect(answer).toMatchObject({ created: false, thread_id: first.thread_id, message_id: first.message_id });
    expect((await thread(server, first.thread_id)).messages).toHaveLength(1);

    // The agent's next message: the same thread, the next target.
    const next = (await drop(server, { kind: "chat_message", text: "Now capped at 30 seconds in all." })).body;
    expect(next).toMatchObject({ created: true, thread_id: first.thread_id });
    expect(next.message_id).not.toBe(first.message_id);

    // A retried call (the same key) answers what it answered; the key used for another target is refused.
    const key = `k-${keys}`;
    const retried = (await drop(server, { kind: "chat_message", text: "Now capped at 30 seconds in all." }, { idempotency_key: key })).body;
    expect(retried).toMatchObject({ created: false, message_id: next.message_id });
    const reused = await drop(server, { kind: "chat_message", text: "Other words." }, { idempotency_key: key });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("idempotency_key_reused");

    // Another host id with the same words as the last one: the agent said them again, a new message.
    const said = (await drop(server, { kind: "chat_message", text: "Same words.", host_message_id: "msg_02A" })).body;
    const saidAgain = (await drop(server, { kind: "chat_message", text: "Same words.", host_message_id: "msg_02B" })).body;
    expect(saidAgain.created).toBe(true);
    expect(saidAgain.message_id).not.toBe(said.message_id);

    expect((await post(server, `/api/inbox/messages/${first.thread_id}/resolve`, { resolved: true })).status).toBe(200);
    const fresh = (await drop(server, { kind: "chat_message", text: "Now capped at 30 seconds in all." })).body;
    expect(fresh.created).toBe(true);
    expect(fresh.thread_id).not.toBe(first.thread_id);
  });

  test("is checked against the session's transcript when the Inbox can read it", async () => {
    const asked: string[] = [];
    const { server, project } = await setup({
      readHostMessages: async (host, session) => {
        asked.push(`${host}:${session}`);
        return [{ id: "msg_01A", text: "I moved the retry loop into the client." }, { id: "msg_01B", text: "The backoff is now 2, 4 and 8 seconds." }];
      },
    });
    await poll(server, project);
    // Two transcript messages that are one turn's words.
    expect((await drop(server, { kind: "chat_message", text: TEXT })).body.verified).toBe(true);
    expect((await drop(server, { kind: "chat_message", text: "Words the agent never said." })).body.verified).toBe(false);
    expect(asked).toEqual([TAG, TAG]);
  });
  test("two first drops at once make one thread", async () => {
    // A transcript read that takes a while: both drops are on their way before either writes.
    const { server, project } = await setup({ readHostMessages: async () => (await Bun.sleep(100), null) });
    await poll(server, project);
    const [one, two] = await Promise.all([drop(server, { kind: "chat_message", text: TEXT }), drop(server, { kind: "chat_message", text: TEXT })]);
    expect(two.body.thread_id).toBe(one.body.thread_id);
    expect([one.body.created, two.body.created].sort()).toEqual([false, true]);
    expect(await threadCount(server)).toBe(1);
  });

  test("a thread the person resolved while a drop was on its way: the drop starts a new one", async () => {
    const { server, project } = await setup();
    await poll(server, project);
    const first = (await drop(server, { kind: "chat_message", text: TEXT })).body;
    expect((await post(server, `/api/inbox/messages/${first.thread_id}/resolve`, { resolved: true })).status).toBe(200);
    const root = server.store.message(first.thread_id)!;
    const late = server.store.sendMessage({
      project_id: root.project_id,
      author: { kind: "agent", host: "claude-code", session: SESSION, name: "Claude Code" },
      body: "Late words.",
      imported: { record: { from: "transcript", sha256: "b".repeat(64), by: { kind: "cli" } }, thread_id: first.thread_id },
    });
    expect(late.message.thread_id).toBe(late.message.id);
  });
});

describe("a file", () => {
  test("is attached by path under a short message of the agent, once, in a thread per file", async () => {
    const { server, project } = await setup();
    await poll(server, project);
    const notes = (await drop(server, { kind: "file", path: join(project, "notes.md") })).body;
    expect(notes).toMatchObject({ created: true });
    expect(notes.attachment_id).toMatch(/^att_/);
    expect(Object.fromEntries(new URLSearchParams(new URL(notes.url).hash.slice(1)))).toEqual({ thread: notes.thread_id, file: notes.attachment_id });
    const message = (await thread(server, notes.thread_id)).messages[0]!;
    expect(message.attachments?.map((a) => a.path)).toEqual([join(project, "notes.md")]);
    expect(message.body).toContain("notes.md");
    expect(message.imported).toMatchObject({ from: "file", path: join(project, "notes.md") });

    // Again, by a path relative to the caller's folder: the same message and file.
    const again = (await drop(server, { kind: "file", path: "notes.md" }, { project_path: project })).body;
    expect(again).toMatchObject({ created: false, thread_id: notes.thread_id, attachment_id: notes.attachment_id });
    // Another file: its own thread.
    const plan = (await drop(server, { kind: "file", path: join(project, "plan.md") })).body;
    expect(plan.thread_id).not.toBe(notes.thread_id);

    const missing = await drop(server, { kind: "file", path: join(project, "gone.md") });
    expect(missing.status).toBe(422);
    expect(missing.body.field).toBe("target.path");
  });
});

test("a copy is not the agent's answer: the person's reply stays Sent, and it reaches the session", async () => {
  const { server, project } = await setup();
  await poll(server, project);
  const first = (await drop(server, { kind: "chat_message", text: TEXT })).body;
  const comment = { id: "c-1", blockId: "block-1", startOffset: 0, endOffset: 7, type: "COMMENT", text: "Why in the client?", originalText: "I moved", createdA: 1 };
  expect((await post(server, `/api/inbox/messages/${first.message_id}/annotations`, { annotation: comment })).status).toBe(200);
  const reply = await post(server, `/api/inbox/messages/${first.message_id}/reply`, { idempotency_key: "r-1", feedback: "# Feedback", annotation_ids: ["c-1"] });
  expect(reply.status).toBe(200);
  expect((await thread(server, first.thread_id)).row.section).toBe("sent");

  // The agent's next chat message, dropped before it read the reply: the reply still waits on it.
  await drop(server, { kind: "chat_message", text: "Moved it back to the server." });
  expect((await thread(server, first.thread_id)).row).toMatchObject({ section: "sent", unseen: 0 });

  // The session that wrote the copied message is the one handed the reply.
  const commands = await poll(server, project);
  expect(commands.map((command) => command.type)).toContain("reply");
});
