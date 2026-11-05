/**
 * Comments that stay after Send (experimental "persistent-comments"), proved
 * through the server's real doors: a running Inbox on loopback, the MCP SDK
 * client for the agent (send_message, read_thread) and `fetch` for the
 * window. Each test has its own temp data dir. The rules (rounds, anchors,
 * moved lines) are proved in packages/core/inbox-comment-threads.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAnnotationRecord } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-persistent-comments-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Notes\n\nShip on Friday.\n");
  return { project, dataDir: join(root, "data") };
}

async function start(dataDir: string, persistentComments?: boolean): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, ...(persistentComments === undefined ? {} : { persistentComments }) });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-persistent-comments-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; structured: Record<string, any> }> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

function post(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function files(server: InboxServer, threadId: string): Promise<{ annotations: InboxAnnotationRecord[]; sent_comments?: InboxAnnotationRecord[] }> {
  return (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}/attachments`)).json()) as never;
}

const SESSION = { agent_session: "ses_review", agent_name: "Claude Code", agent_host: "claude-code" };
const READER = { agent_session: "ses_review" };

/** A comment on selected words, as the window's viewer makes it. */
function words(id: string, originalText: string, text: string) {
  return { id, blockId: "block-1", startOffset: 0, endOffset: originalText.length, type: "COMMENT", text, originalText, createdA: 1 };
}

/** The agent's message with notes.md, a comment on its words and one on the file, sent as round 1. */
async function roundOne(server: InboxServer, client: Client, project: string) {
  const sent = (await call(client, "send_message", { project_path: project, body: "The plan: ship on Friday, all stores at once.", attachments: ["notes.md"], ...SESSION })).structured;
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words("c-msg", "all stores at once", "One store first.") })).status).toBe(200);
  const onFile = await post(server, "/api/inbox/annotations", { attachment_id: sent.attachments[0].id, version: "current", annotation: words("c-file", "Ship on Friday.", "Not on a Friday.") });
  expect(onFile.status).toBe(200);
  const reply = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "r-1", feedback: "# Feedback", annotation_ids: ["c-msg", "c-file"] });
  expect(reply.status).toBe(200);
  return { sent, replyId: ((await reply.json()) as { reply: { id: string } }).reply.id };
}

test("off by default: a sent comment leaves the window, read_thread lists none, and nothing marks it", async () => {
  const { project, dataDir } = world();
  // The Inbox reads config.json through PLANNOTATOR_DATA_DIR: this test's own, with no switch, and no variable deciding.
  const before = { data: process.env.PLANNOTATOR_DATA_DIR, experimental: process.env.PLANNOTATOR_EXPERIMENTAL };
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_EXPERIMENTAL;
  try {
    const server = await start(dataDir);
    const client = await agent(server);
    const { sent } = await roundOne(server, client, project);

    const settings = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()) as { experimental: unknown };
    expect(settings.experimental).toEqual({ decision_mode: { on: false, env: null }, persistent_comments: { on: false, env: null } });
    const model = await files(server, sent.thread_id);
    expect(model.annotations).toEqual([]);
    expect(model.sent_comments).toBeUndefined();
    const read = await call(client, "read_thread", { thread_id: sent.thread_id, ...READER });
    expect(read.structured.comments).toBeUndefined();
    expect(read.text).not.toContain("c-file");
    const mark = await post(server, "/api/inbox/annotations/c-file/unanchored", { unanchored: true });
    expect([mark.status, ((await mark.json()) as { code: string }).code]).toEqual([409, "persistent_comments_off"]);
    const resolve = await post(server, "/api/inbox/annotations/c-file/resolve", { resolved: true });
    expect([resolve.status, ((await resolve.json()) as { code: string }).code]).toEqual([409, "persistent_comments_off"]);
  } finally {
    if (before.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before.data;
    if (before.experimental !== undefined) process.env.PLANNOTATOR_EXPERIMENTAL = before.experimental;
  }
});

test("on: sent comments stay with their round, read_thread names each by id, and an unanchored mark is kept across a restart", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);
  const cursor = (await call(client, "read_thread", { thread_id: sent.thread_id, ...READER })).structured.cursor as number;

  // The agent answers: the person's next Send is round 2.
  const answer = (await call(client, "send_message", { project_path: project, body: "Tuesday then, one store first.", reply_to: replyId, ...SESSION })).structured;
  expect((await post(server, `/api/inbox/messages/${answer.message_id}/annotations`, { annotation: words("c-two", "one store first", "Which one?") })).status).toBe(200);
  expect((await post(server, `/api/inbox/messages/${answer.message_id}/reply`, { idempotency_key: "r-2", feedback: "# Feedback", annotation_ids: ["c-two"] })).status).toBe(200);

  // The window keeps them in view, apart from the drafts that ride the next Send.
  const model = await files(server, sent.thread_id);
  expect(model.annotations).toEqual([]);
  expect(model.sent_comments!.map((r) => r.id).sort()).toEqual(["c-file", "c-msg", "c-two"]);

  // read_thread: every one by its id, round, state and where it is.
  const read = await call(client, "read_thread", { thread_id: sent.thread_id, ...READER });
  // Round by round (two comments made in the same millisecond keep no order of their own).
  expect(read.structured.comments.map((c: { id: string; round: number; state: string }) => [c.id, c.round, c.state]).sort()).toEqual([
    ["c-file", 1, "open"],
    ["c-msg", 1, "open"],
    ["c-two", 2, "open"],
  ]);
  expect(read.structured.comments.at(-1).id).toBe("c-two");
  const line = (id: string) => read.text.split("\n").find((l) => l.startsWith(`- ${id} `)) ?? "";
  expect(line("c-msg")).toContain(`round 1 (reply ${replyId})`);
  expect(line("c-msg")).toContain(`on message ${sent.message_id}`);
  expect(line("c-file")).toContain("on notes.md");
  expect(line("c-file")).toContain('"Ship on Friday." → "Not on a Friday."');
  expect(line("c-two")).toContain("round 2");
  // A read of what is new lists only the comments its replies carried.
  const newer = await call(client, "read_thread", { thread_id: sent.thread_id, after: cursor, ...READER });
  expect(newer.structured.comments.map((c: { id: string }) => c.id)).toEqual(["c-two"]);
  expect(newer.text).toContain("2 more from other rounds");

  // The window found the file comment's words gone: kept once, and read by the agent.
  const projectDir = join(dataDir, "inbox", "projects", readdirSync(join(dataDir, "inbox", "projects"))[0]!);
  const lines = () => readFileSync(join(projectDir, "annotations.jsonl"), "utf8").trim().split("\n").length;
  const marked = await post(server, "/api/inbox/annotations/c-file/unanchored", { unanchored: true });
  expect(marked.status).toBe(200);
  expect(typeof ((await marked.json()) as { annotation: InboxAnnotationRecord }).annotation.unanchored_at).toBe("string");
  const written = lines();
  expect((await post(server, "/api/inbox/annotations/c-file/unanchored", { unanchored: true })).status).toBe(200);
  expect(lines()).toBe(written);
  // A read of what is new still lists an unanchored comment from an earlier round.
  const later = await call(client, "read_thread", { thread_id: sent.thread_id, after: cursor, ...READER });
  expect(later.structured.comments.map((c: { id: string }) => c.id)).toEqual(["c-file", "c-two"]);

  server.stop();
  servers.splice(servers.indexOf(server), 1);
  const again = await start(dataDir, true);
  const reader = await agent(again);
  expect((await files(again, sent.thread_id)).sent_comments!.find((r) => r.id === "c-file")!.unanchored_at).toEqual(expect.any(String));
  const after = await call(reader, "read_thread", { thread_id: sent.thread_id, ...READER });
  expect(after.text.split("\n").find((l) => l.startsWith("- c-file "))).toContain("unanchored");
  expect(after.structured.comments.find((c: { id: string }) => c.id === "c-file").unanchored).toBe(true);

  // Found again: cleared.
  expect((await post(again, "/api/inbox/annotations/c-file/unanchored", { unanchored: false })).status).toBe(200);
  expect((await files(again, sent.thread_id)).sent_comments!.find((r) => r.id === "c-file")!.unanchored_at).toBeNull();
});

/** The body of the person's reply to `messageId` (words only): what the agent gets. */
async function replyBody(server: InboxServer, messageId: string, key: string): Promise<string> {
  const reply = await post(server, `/api/inbox/messages/${messageId}/reply`, { idempotency_key: key, words: "Next round." });
  expect(reply.status).toBe(200);
  return ((await reply.json()) as { reply: { body: string } }).reply.body;
}

test("the person resolves a sent comment and opens it again: read_thread shows it, and it holds across a restart", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent } = await roundOne(server, client, project);
  const projectDir = join(dataDir, "inbox", "projects", readdirSync(join(dataDir, "inbox", "projects"))[0]!);
  const lines = () => readFileSync(join(projectDir, "annotations.jsonl"), "utf8").trim().split("\n").length;

  const resolved = await post(server, "/api/inbox/annotations/c-file/resolve", { resolved: true });
  expect(resolved.status).toBe(200);
  expect(typeof ((await resolved.json()) as { annotation: InboxAnnotationRecord }).annotation.resolved_at).toBe("string");
  // Already resolved: nothing written again.
  const written = lines();
  expect((await post(server, "/api/inbox/annotations/c-file/resolve", { resolved: true })).status).toBe(200);
  expect(lines()).toBe(written);
  const read = await call(client, "read_thread", { thread_id: sent.thread_id, ...READER });
  expect(Object.fromEntries(read.structured.comments.map((c: { id: string; state: string }) => [c.id, c.state]))).toEqual({ "c-file": "resolved", "c-msg": "open" });
  expect(read.text.split("\n").find((l) => l.startsWith("- c-file "))).toContain(" · resolved · ");

  server.stop();
  servers.splice(servers.indexOf(server), 1);
  const again = await start(dataDir, true);
  expect((await files(again, sent.thread_id)).sent_comments!.find((r) => r.id === "c-file")!.resolved_at).toEqual(expect.any(String));
  expect((await post(again, "/api/inbox/annotations/c-file/resolve", { resolved: false })).status).toBe(200);
  expect((await files(again, sent.thread_id)).sent_comments!.find((r) => r.id === "c-file")!.resolved_at).toBeNull();
});

test("a reply never carries the comments still open: a comment send's Finish names them instead", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);
  const answer = (await call(client, "send_message", { project_path: project, body: "Tuesday then.", reply_to: replyId, ...SESSION })).structured;
  // Both comments are open and went to that session in round 1: the person's next words carry neither.
  const body = await replyBody(server, answer.message_id, "r-2");
  expect(body).toBe("Next round.");
  const read = await call(client, "read_thread", { thread_id: sent.thread_id, format: "full", ...READER });
  expect(read.structured.thread.messages.at(-1).body).not.toContain("(id c-");
});

test("only a sent comment is marked or resolved, with a boolean", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const sent = (await call(client, "send_message", { project_path: project, body: "Ship on Friday.", ...SESSION })).structured;
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words("c-draft", "Friday", "Not then.") })).status).toBe(200);
  const refused = async (path: string, body: unknown, status: number, code: string) => {
    const answer = await post(server, path, body);
    expect([path, answer.status, ((await answer.json()) as { code: string }).code]).toEqual([path, status, code]);
  };
  await refused("/api/inbox/annotations/c-draft/unanchored", { unanchored: true }, 422, "validation_error");
  await refused("/api/inbox/annotations/c-none/unanchored", { unanchored: true }, 404, "annotation_not_found");
  await refused("/api/inbox/annotations/c-draft/unanchored", { unanchored: "yes" }, 422, "validation_error");
  expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/annotations/c-draft/unanchored`)).status).toBe(405);
  // Resolved the same way: a draft is removed instead.
  await refused("/api/inbox/annotations/c-draft/resolve", { resolved: true }, 422, "validation_error");
  await refused("/api/inbox/annotations/c-none/resolve", { resolved: true }, 404, "annotation_not_found");
  await refused("/api/inbox/annotations/c-draft/resolve", { resolved: "yes" }, 422, "validation_error");
  expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/annotations/c-draft/resolve`)).status).toBe(405);
});

test("Settings → Experimental turns it on and off at once, and keeps the other experimental switches", async () => {
  const { project, dataDir } = world();
  // The Inbox reads config.json through PLANNOTATOR_DATA_DIR, even when given dataDir.
  const before = { data: process.env.PLANNOTATOR_DATA_DIR, experimental: process.env.PLANNOTATOR_EXPERIMENTAL };
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_EXPERIMENTAL;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ experimental: { decisionMode: true } }));
    const server = await start(dataDir);
    const client = await agent(server);
    const { sent } = await roundOne(server, client, project);
    expect((await files(server, sent.thread_id)).sent_comments).toBeUndefined();

    const on = await post(server, "/api/inbox/settings", { experimental: { persistent_comments: true } });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { experimental: unknown }).experimental).toEqual({ decision_mode: { on: true, env: null }, persistent_comments: { on: true, env: null } });
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).experimental).toEqual({ decisionMode: true, persistentComments: true });
    // The comments the earlier Send carried come back into view.
    expect((await files(server, sent.thread_id)).sent_comments!.map((r) => r.id).sort()).toEqual(["c-file", "c-msg"]);

    expect((await post(server, "/api/inbox/settings", { experimental: { persistent_comments: false } })).status).toBe(200);
    expect((await files(server, sent.thread_id)).sent_comments).toBeUndefined();
    expect((await post(server, "/api/inbox/settings", { experimental: { persistent_comments: true, decision_mode: true } })).status).toBe(422);
  } finally {
    if (before.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before.data;
    if (before.experimental !== undefined) process.env.PLANNOTATOR_EXPERIMENTAL = before.experimental;
  }
});

test("PLANNOTATOR_EXPERIMENTAL decides over config.json, both ways, and Settings cannot save over it", async () => {
  const { dataDir } = world();
  const before = { data: process.env.PLANNOTATOR_DATA_DIR, experimental: process.env.PLANNOTATOR_EXPERIMENTAL };
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ experimental: { persistentComments: true } }));
    process.env.PLANNOTATOR_EXPERIMENTAL = "decision-mode, -persistent-comments";
    const server = await start(dataDir);
    const experimental = async () => ((await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()) as { experimental: unknown }).experimental;
    expect(await experimental()).toEqual({ decision_mode: { on: true, env: true }, persistent_comments: { on: false, env: false } });
    expect((await post(server, "/api/inbox/annotations/c-any/unanchored", { unanchored: true })).status).toBe(409);
    // Saved off in config.json, so "on" can come from the variable alone.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ experimental: { persistentComments: false } }));
    process.env.PLANNOTATOR_EXPERIMENTAL = " Persistent-Comments ";
    expect(await experimental()).toEqual({ decision_mode: { on: false, env: null }, persistent_comments: { on: true, env: true } });
    expect((await post(server, "/api/inbox/annotations/c-any/unanchored", { unanchored: true })).status).toBe(404);
    // While the variable decides, the switch is locked: a save is refused and writes nothing.
    const config = readFileSync(join(dataDir, "config.json"), "utf8");
    const locked = await post(server, "/api/inbox/settings", { experimental: { persistent_comments: false } });
    expect([locked.status, ((await locked.json()) as { code: string }).code]).toEqual([409, "experimental_env_decides"]);
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(config);
    expect(await experimental()).toEqual({ decision_mode: { on: false, env: null }, persistent_comments: { on: true, env: true } });
  } finally {
    if (before.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before.data;
    if (before.experimental === undefined) delete process.env.PLANNOTATOR_EXPERIMENTAL;
    else process.env.PLANNOTATOR_EXPERIMENTAL = before.experimental;
  }
});
