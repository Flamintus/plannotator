/**
 * Comment sends on the wake (experimental "persistent-comments"): what the
 * session's connection is handed, how it is settled, and what the agent's
 * tool takes back, through the server's real doors (a running Inbox on
 * loopback, the bridge with its token, the MCP SDK client for the agents).
 * Each test has its own temp data dir. The text's rules are proved in
 * packages/core/inbox-comment-sends.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxCommentSend } from "@plannotator/core/inbox-comment-sends";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_COMMENTS_POLL_FIELD,
  INBOX_WAKE_INSTRUCTION,
  inboxCommentsOnlyWakeLine,
  inboxCommentsWakeLine,
  inboxWakeText,
  parseInboxBridgeCommands,
  type InboxReplyCommand,
} from "@plannotator/shared/inbox/connection";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const restores: (() => void)[] = [];
const SKILL_HOMES = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const fakes: FakeAgents[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const fake of fakes.splice(0)) fake.remove();
  for (const restore of restores.splice(0)) restore();
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-send-delivery-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Notes\n\nShip on Friday.\n");
  return { project, dataDir: join(root, "data") };
}

async function start(dataDir: string, codeReview = false): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, persistentComments: true, codeReview });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer, name = "inbox-send-delivery-test"): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

async function call(client: Client, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<{ text: string; structured: Record<string, any> }> {
  const result = (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as Result;
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

function post(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function bridge(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
}

/** What the session's connection is handed now; `together`: it posts `sends` back with `delivered`. */
async function poll(server: InboxServer, session: string, options: { together?: boolean; sendNow?: boolean } = {}): Promise<InboxReplyCommand[]> {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, {
    session,
    host: "claude-code",
    waitMs: 0,
    tags: true,
    ...(options.together !== false ? { [INBOX_COMMENTS_POLL_FIELD]: true } : {}),
    ...(options.sendNow ? { send_now: true } : {}),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

async function delivered(server: InboxServer, session: string, command: Pick<InboxReplyCommand, "id" | "comments">) {
  const response = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session, host: "claude-code", type: "delivered", id: command.id, ...(command.comments ? { sends: command.comments.sends } : {}) });
  expect(response.status).toBe(200);
}

type Sent = { sends: InboxCommentSend[]; message: InboxMessage | null };

async function press(server: InboxServer, threadId: string, body: Record<string, unknown>): Promise<Sent> {
  const response = await post(server, `/api/inbox/threads/${threadId}/comment-sends`, body);
  const answer = (await response.json()) as Sent & { code?: string; error?: string };
  if (response.status !== 200) throw new Error(`${response.status} ${answer.code}: ${answer.error}`);
  return answer;
}

const A = { agent_session: "ses_alpha", agent_name: "Claude Code", agent_host: "claude-code" };
const B = { agent_session: "ses_beta", agent_name: "Pi", agent_host: "pi" };

function words(id: string, originalText: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, blockId: "block-1", startOffset: 0, endOffset: originalText.length, type: "COMMENT", text, originalText, createdA: 1, ...extra };
}

async function comment(server: InboxServer, messageId: string, id: string, quote: string, text: string) {
  expect((await post(server, `/api/inbox/messages/${messageId}/annotations`, { annotation: words(id, quote, text) })).status).toBe(200);
}

async function opening(client: Client, project: string, session = A) {
  return (await call(client, "send_message", { project_path: project, body: "The plan: ship on Friday, all stores at once, with a press release.", attachments: ["notes.md"], ...session })).structured as {
    message_id: string;
    thread_id: string;
    attachments: { id: string }[];
  };
}

const sendOf = (server: InboxServer, id: string) => server.store.commentSend(id)!;

test("a send now reaches its session on the wake: a reply under the send's id, with `comments` and the server's text; delivered settles it", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await opening(await agent(server), project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  const [send] = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" })).sends;

  const [command, ...rest] = await poll(server, "ses_alpha");
  expect(rest).toEqual([]);
  expect(command).toMatchObject({ type: "reply", id: send!.id, thread_id: sent.thread_id, reply_to: sent.message_id, comments: { sends: [send!.id], round: 1, mode: "now", count: 1 } });
  // The words come from the records: the comment's id, its words and where it is.
  expect(command!.body).toContain("(id c-1)");
  expect(command!.body).toContain("One store first.");
  expect(command!.body).toContain(`on message ${sent.message_id}`);
  // Comments alone: a round is not a message; the wake is one line naming the send, the comments stay out, never "their answer to you".
  const wake = inboxWakeText(command!);
  expect(wake).toContain(inboxCommentsOnlyWakeLine(command!.comments!, send!.id));
  expect(wake).not.toContain("One store first.");
  expect(wake).not.toContain(INBOX_WAKE_INSTRUCTION);
  // No message was written for it.
  expect(server.store.thread(sent.thread_id)!.messages).toHaveLength(1);

  await delivered(server, "ses_alpha", command!);
  expect(sendOf(server, send!.id).delivery).toMatchObject({ state: "delivered", host: "claude-code", session: "ses_alpha" });
  expect(await poll(server, "ses_alpha")).toEqual([]);
});

test("a thread's waiting sends go in one command to a connection that posts them back, one each otherwise; delivered settles the list it names, and a later send goes next", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await opening(await agent(server), project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  await comment(server, sent.message_id, "c-2", "with a press release", "No press release yet.");
  await comment(server, sent.message_id, "c-3", "ship on Friday", "Not on a Friday.");
  const [one] = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" })).sends;
  const [two] = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-2"], idempotency_key: "k-2" })).sends;

  // An older connection (no `comments` on its poll): one send per command, each settled by its own id.
  expect((await poll(server, "ses_alpha", { together: false })).map((c) => c.id)).toEqual([one!.id, two!.id]);

  const [together, ...rest] = await poll(server, "ses_alpha");
  expect(rest).toEqual([]);
  expect(together).toMatchObject({ id: one!.id, comments: { sends: [one!.id, two!.id], count: 2 } });
  expect(together!.body).toContain("(id c-1)");
  expect(together!.body).toContain("(id c-2)");

  // A send after the command was made is not in its list: it goes in the next one, never twice.
  const [three] = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-3"], idempotency_key: "k-3" })).sends;
  await delivered(server, "ses_alpha", together!);
  expect(sendOf(server, one!.id).delivery).toBeTruthy();
  expect(sendOf(server, two!.id).delivery).toBeTruthy();
  expect(sendOf(server, three!.id).delivery ?? null).toBeNull();
  const [next, ...more] = await poll(server, "ses_alpha");
  expect(more).toEqual([]);
  expect(next).toMatchObject({ id: three!.id, comments: { sends: [three!.id] } });
  expect(next!.body).not.toContain("(id c-1)");
});

test("a Finish with words is one command, the person's message's: the comments after the words, and its delivery settles both", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await opening(await agent(server), project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  const { sends, message } = await press(server, sent.thread_id, { mode: "round", words: "Two changes before Friday.", idempotency_key: "k-1" });
  expect(message).toBeTruthy();

  const [command, ...rest] = await poll(server, "ses_alpha");
  expect(rest).toEqual([]);
  expect(command).toMatchObject({ type: "reply", id: message!.id, comments: { sends: [sends[0]!.id], round: 1, mode: "round", count: 1 } });
  expect(command!.body.indexOf("Two changes before Friday.")).toBe(0);
  expect(command!.body).toContain("(id c-1)");
  // Under the person's words: their reply's instruction, then the comments line.
  const wake = inboxWakeText(command!);
  expect(wake.indexOf(INBOX_WAKE_INSTRUCTION)).toBeGreaterThan(-1);
  expect(wake.indexOf(inboxCommentsWakeLine(command!.comments!))).toBeGreaterThan(wake.indexOf(INBOX_WAKE_INSTRUCTION));

  await delivered(server, "ses_alpha", { id: command!.id });
  expect(server.store.message(message!.id)!.delivery).toBeTruthy();
  expect(sendOf(server, sends[0]!.id).delivery).toBeTruthy();
  expect(await poll(server, "ses_alpha")).toEqual([]);
});

test("another agent's read never settles a send, nor the words it rides; the session's own read that showed them does", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const alpha = await agent(server, "alpha");
  const beta = await agent(server, "beta");
  const sent = await opening(alpha, project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  const { sends, message } = await press(server, sent.thread_id, { mode: "round", words: "Two changes before Friday.", idempotency_key: "k-1" });

  // A newcomer's read settles a plain reply to a session no connection wakes yet, never the words a send rides.
  await call(beta, "read_thread", { thread_id: sent.thread_id, agent_session: B.agent_session });
  expect(sendOf(server, sends[0]!.id).read_at ?? null).toBeNull();
  const waiting = await poll(server, "ses_alpha");
  expect(waiting.map((c) => c.id)).toEqual([message!.id]);

  await call(alpha, "read_thread", { thread_id: sent.thread_id, agent_session: A.agent_session });
  expect(await poll(server, "ses_alpha")).toEqual([]);
  const send = sendOf(server, sends[0]!.id);
  expect(send.delivery || send.read_at).toBeTruthy();
});

test("read_thread and reply_to take a send's id: the agent reads its thread and answers under the comments there", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const alpha = await agent(server);
  const sent = await opening(alpha, project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  const [send] = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" })).sends;

  const read = await call(alpha, "read_thread", { message_id: send!.id, agent_session: A.agent_session });
  expect(read.structured.comment_sends.map((s: { id: string }) => s.id)).toEqual([send!.id]);
  // What the send carries comes first, as the wake used to carry it: the entry under its id, with its words.
  const [first] = read.text.split("\n\nThread ");
  expect(first).toContain("(id c-1)");
  expect(first).toContain("One store first.");
  // A read by the thread's id carries no send's text first.
  const byThread = await call(alpha, "read_thread", { thread_id: sent.thread_id, agent_session: A.agent_session });
  expect(byThread.text.startsWith("Thread ")).toBe(true);
  const answer = await call(alpha, "send_message", { reply_to: send!.id, body: "Lyon goes first.", comment_replies: [{ comment_id: "c-1", text: "Lyon goes first, a week alone." }], ...A });
  expect(answer.structured.thread_id).toBe(sent.thread_id);
  expect(server.store.commentReplies(sent.thread_id).map((reply) => reply.re)).toEqual(["c-1"]);
});

test("Send now on a send: the command carries `now` for a connection that can; a failed attempt clears it", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await opening(await agent(server), project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  const [send] = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" })).sends;
  expect((await poll(server, "ses_alpha", { sendNow: true }))[0]!.now).toBeUndefined();

  const pressed = await post(server, `/api/inbox/messages/${send!.id}/send-now`, { serverSession: server.serverSession });
  expect(pressed.status).toBe(200);
  expect((await poll(server, "ses_alpha", { sendNow: true }))[0]).toMatchObject({ id: send!.id, now: true });

  expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses_alpha", host: "claude-code", type: "send_now_failed", id: send!.id })).status).toBe(200);
  expect((await poll(server, "ses_alpha", { sendNow: true }))[0]!.now).toBeUndefined();
});

test("the text says what the server knows: a document comment's lines in the version commented, and a human-only skill's instructions", async () => {
  const { project, dataDir } = world();
  // The skill folders are a scratch home's, never the real ones.
  const home = join(dataDir, "..", "home");
  mkdirSync(home, { recursive: true });
  const before = Object.fromEntries(SKILL_HOMES.map((name) => [name, process.env[name]]));
  restores.push(() => {
    for (const [name, value] of Object.entries(before)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  // Code review on: its built-in skills are in the catalog, human-only, their text Plannotator's own.
  const server = await start(dataDir, true);
  const sent = await opening(await agent(server), project);
  const saved = await post(server, "/api/inbox/annotations", {
    serverSession: server.serverSession,
    attachment_id: sent.attachments[0]!.id,
    version: "current",
    annotation: words("c-file", "Ship on Friday.", "Not on a Friday: run /review-curate first."),
  });
  expect(saved.status).toBe(200);
  const [send] = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-file"], idempotency_key: "k-1" })).sends;
  const [command] = await poll(server, "ses_alpha");
  expect(command!.id).toBe(send!.id);
  expect(command!.body).toContain("on notes.md line 3 when commented");
  // One block for the skills the comments name, the skill's instructions pasted between markers.
  expect(command!.body).toContain("--- BEGIN SKILL INSTRUCTIONS: review-curate ---");
});

test("a send to a Codex thread goes in through codex queue, once, and its id settles it", async () => {
  const fake = createFakeAgents("plannotator-send-delivery-codex-");
  fakes.push(fake);
  fake.install("codex");
  const project = join(fake.root, "ledger");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({
    dataDir: join(fake.root, "data"),
    persistentComments: true,
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env }),
    codexWake: { extraClis: [] },
  });
  servers.push(server);
  const client = new Client({ name: "codex-mcp-client", version: "0.160.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const thread = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5c";
  const meta = { threadId: thread, sessionId: thread, "x-codex-turn-metadata": { thread_id: thread, turn_started_at_unix_ms: Date.now(), turn_trigger: "user", codex_version: "0.160.0" } };
  const sent = (await call(client, "send_message", { project_path: project, body: "The plan: ship on Friday, all stores at once.", agent_session: thread, agent_host: "codex", agent_name: "Codex" }, meta)).structured as {
    message_id: string;
    thread_id: string;
  };
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  const [send] = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" })).sends;
  await server.codexWake.sweep();
  await server.codexWake.sweep();
  const queued = fake.calls().filter((c) => c.name === "codex" && c.args[0] === "queue");
  expect(queued).toHaveLength(1);
  const message = queued[0]!.args.find((a) => a.startsWith("--message="))!.slice("--message=".length);
  expect(message.split("\n")[0]).toContain(`(${send!.id})`);
  // One line, no comment in it: Codex reads them with read_thread by the send's id.
  expect(message).toContain(`read_thread (message_id ${send!.id})`);
  expect(message).not.toContain("(id c-1)");
  // The thread's next turn calls a tool (one that reads nothing): that is the delivery.
  await call(client, "search", { query: "stores", project_path: project }, { ...meta, "x-codex-turn-metadata": { ...meta["x-codex-turn-metadata"], turn_started_at_unix_ms: Date.now() + 5 } });
  for (let waited = 0; waited < 2000 && !sendOf(server, send!.id).delivery; waited += 25) await Bun.sleep(25);
  expect(sendOf(server, send!.id).delivery).toMatchObject({ host: "codex", session: thread });
  expect(sendOf(server, send!.id).read_at ?? null).toBeNull();
});

test("off: a send written while it was on waits untouched: nothing hands it, nothing takes its id, its words go as a plain reply", async () => {
  const { project, dataDir } = world();
  const on = await start(dataDir);
  const sent = await opening(await agent(on), project);
  await comment(on, sent.message_id, "c-1", "all stores at once", "One store first.");
  await comment(on, sent.message_id, "c-2", "with a press release", "No press release yet.");
  const [alone] = (await press(on, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" })).sends;
  const mixed = await press(on, sent.thread_id, { mode: "round", words: "Two changes before Friday.", idempotency_key: "k-2" });
  on.stop();
  servers.splice(servers.indexOf(on), 1);

  const off = await startInboxServer({ dataDir, persistentComments: false });
  servers.push(off);
  const commands = await poll(off, "ses_alpha");
  expect(commands.map((c) => [c.id, c.comments ?? null])).toEqual([[mixed.message!.id, null]]);
  expect(commands[0]!.body).toBe("Two changes before Friday.");
  await delivered(off, "ses_alpha", commands[0]!);
  // Its words went, its comments did not: the send stays as it was.
  expect(off.store.commentSend(mixed.sends.find((s) => s.with_message)!.id)!.delivery ?? null).toBeNull();
  const client = await agent(off);
  await expect(call(client, "read_thread", { message_id: alone!.id, agent_session: A.agent_session })).rejects.toThrow();
  await call(client, "read_thread", { thread_id: sent.thread_id, agent_session: A.agent_session });
  expect(off.store.commentSend(alone!.id)!.read_at ?? null).toBeNull();
  expect((await post(off, `/api/inbox/messages/${alone!.id}/send-now`, { serverSession: off.serverSession })).status).toBe(409);
});
