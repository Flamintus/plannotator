/**
 * An agent's replies under the person's comments sent alone, with no message
 * (experimental "persistent-comments": send_message's `comment_replies` and
 * no body), proved through the server's real doors: a running Inbox on
 * loopback, the MCP SDK client for the agents and `fetch` for the window.
 * Each test has its own temp data dir. Nothing is written in the thread, and
 * the person is still told: the row is unread until a look passes the
 * replies, and the event stream names the call the window notifies once for
 * (packages/inbox/notifyHook.test.tsx).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxCommentReplyRecord, InboxListRow, InboxListSection } from "@plannotator/core/inbox-types";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-replies-alone-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Notes\n\nShip on Friday.\n");
  return { project, dataDir: join(root, "data") };
}

async function start(dataDir: string, persistentComments = true, steps = false): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, persistentComments, steps });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-replies-alone-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

async function raw(client: Client, args: Record<string, unknown>, name = "send_message"): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; structured: Record<string, any> }> {
  const result = await raw(client, args, name);
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;

function post(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

const SESSION = { agent_session: "ses_review", agent_name: "Claude Code", agent_host: "claude-code" };
const OTHER = { agent_session: "ses_other", agent_name: "Claude Code", agent_host: "claude-code" };
const READER = { agent_session: "ses_review" };

function words(id: string, originalText: string, text: string) {
  return { id, blockId: "block-1", startOffset: 0, endOffset: originalText.length, type: "COMMENT", text, originalText, createdA: 1 };
}

/** The agent's message, two comments on its words, both sent now (comment sends: no message of the person's). */
async function sentNow(server: InboxServer, client: Client, project: string) {
  const sent = (await call(client, "send_message", { project_path: project, body: "The plan: ship on Friday, all stores at once, with a press release.", ...SESSION })).structured as { message_id: string; thread_id: string };
  for (const [id, quote, text] of [
    ["c-1", "all stores at once", "One store first."],
    ["c-2", "a press release", "No press release yet."],
  ] as const) {
    expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words(id, quote, text) })).status).toBe(200);
  }
  const press = await post(server, `/api/inbox/threads/${sent.thread_id}/comment-sends`, { mode: "now", comment_ids: ["c-1", "c-2"], idempotency_key: "p-1" });
  expect(press.status).toBe(200);
  const { sends } = (await press.json()) as { sends: { id: string }[] };
  return { ...sent, sendId: sends[0]!.id };
}

async function replies(server: InboxServer, threadId: string): Promise<InboxCommentReplyRecord[]> {
  return ((await (await fetch(url(server, `/api/inbox/threads/${threadId}/attachments`))).json()) as { comment_replies: InboxCommentReplyRecord[] }).comment_replies;
}

async function messageCount(client: Client, threadId: string): Promise<number> {
  return (await call(client, "read_thread", { thread_id: threadId, format: "full", ...READER })).structured.thread.messages.length;
}

async function rowOf(server: InboxServer, threadId: string, query = ""): Promise<InboxListRow> {
  const model = (await (await fetch(url(server, `/api/inbox/threads${query}`))).json()) as { sections: InboxListSection[] };
  return model.sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
}

async function windowThread(server: InboxServer, threadId: string): Promise<{ agent_replies_seq?: number; messages: { author: { kind: string }; seq: number }[] }> {
  return ((await (await fetch(url(server, `/api/inbox/threads/${threadId}`))).json()) as { thread: never }).thread;
}

async function events(server: InboxServer, cursor: number): Promise<Record<string, any>[]> {
  const text = await (await fetch(url(server, `/api/inbox/events?cursor=${cursor}&once=1`))).text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("event: record"))
    .map((block) => JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as Record<string, any>);
}

const alone = (comment_replies: { comment_id: string; text: string }[], extra: Record<string, unknown> = {}) => ({ comment_replies, ...SESSION, ...extra });

test("off: send_message's body is required, and a send without one writes nothing", async () => {
  const { project, dataDir } = world();
  const required = async (on: boolean) => {
    const server = await start(join(dataDir, String(on)), on);
    const send = (await (await agent(server)).listTools()).tools.find((tool) => tool.name === "send_message")!;
    return (send.inputSchema as { required?: string[] }).required ?? [];
  };
  expect(await required(false)).toContain("body");
  expect(await required(true)).not.toContain("body");
  const server = await start(join(dataDir, "off"), false);
  const client = await agent(server);
  const sent = (await call(client, "send_message", { project_path: project, body: "The plan.", ...SESSION })).structured;
  expect((await raw(client, { project_path: project, reply_to: sent.message_id, ...SESSION })).isError).toBe(true);
  expect(await messageCount(client, sent.thread_id)).toBe(1);
});

test("on: replies with no body land under their comments with no message in the thread, without reply_to", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id } = await sentNow(server, client, project);
  const before = await messageCount(client, thread_id);
  const cursor = (await call(client, "read_thread", { thread_id, ...READER })).structured.cursor as number;

  const answer = await call(client, "send_message", alone([
    { comment_id: "c-1", text: "Lyon first, for a week." },
    { comment_id: "c-2", text: "Dropped the press release." },
  ]));
  expect(answer.structured).toMatchObject({ thread_id, replayed: false });
  expect(answer.structured.message_id).toBeUndefined();
  expect(answer.structured.comment_replies.map((r: { comment_id: string }) => r.comment_id)).toEqual(["c-1", "c-2"]);
  expect(answer.text).toStartWith("Replied under 2 comments");
  expect(await messageCount(client, thread_id)).toBe(before);

  // Stored as replies of one call, with no message.
  const stored = await replies(server, thread_id);
  expect(stored.map((r) => [r.re, r.message_id, r.from.session])).toEqual([
    ["c-1", undefined, "ses_review"],
    ["c-2", undefined, "ses_review"],
  ]);
  expect(stored[0]!.call).toMatch(/^call_/);
  expect(stored[1]!.call).toBe(stored[0]!.call);

  // read_thread: under each comment, "you" for the reader's own; a ranged read keeps the comments they answered.
  const ranged = await call(client, "read_thread", { thread_id, after: cursor, ...READER });
  expect(ranged.structured.comments.map((c: { id: string }) => c.id)).toEqual(["c-1", "c-2"]);
  expect(ranged.text).toContain('· you: "Lyon first, for a week."');

  // The event stream names the call and the agent on each (the window's one notice); a reply with a message names neither.
  const lines = (await events(server, cursor)).filter((e) => e.kind === "comment_reply");
  expect(lines.map((e) => [e.call, e.from?.name])).toEqual([
    [stored[0]!.call, "Claude Code"],
    [stored[0]!.call, "Claude Code"],
  ]);
  const withMessage = await call(client, "send_message", { body: "And a word on the launch.", reply_to: answer.structured.thread_id, comment_replies: [{ comment_id: "c-1", text: "Monday is fine too." }], ...SESSION });
  const after = (await events(server, withMessage.structured.cursor - 1)).filter((e) => e.kind === "comment_reply");
  expect(after.map((e) => [e.call, e.from])).toEqual([[undefined, undefined]]);
  expect(await messageCount(client, thread_id)).toBe(before + 1);
});

test("on: with neither a body nor replies, or with what goes with a message, the send is refused and writes nothing", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id, message_id } = await sentNow(server, client, project);
  const before = await messageCount(client, thread_id);
  const refused = async (args: Record<string, unknown>) => {
    const result = await raw(client, args);
    return [result.isError, result.content[0]!.text.split(":")[0]];
  };
  expect(await refused({ reply_to: message_id, ...SESSION })).toEqual([true, "validation_error"]);
  // A blank body is none.
  expect(await refused({ body: "  ", reply_to: message_id, ...SESSION })).toEqual([true, "validation_error"]);
  for (const extra of [{ attachments: ["notes.md"], project_path: project }, { supersedes: [message_id] }, { done: [message_id] }]) {
    const result = await raw(client, alone([{ comment_id: "c-1", text: "Done." }], extra));
    expect([result.isError, result.content[0]!.text.startsWith(`validation_error: ${Object.keys(extra)[0]}:`)]).toEqual([true, true]);
  }
  expect(await messageCount(client, thread_id)).toBe(before);
  expect(await replies(server, thread_id)).toEqual([]);
});

test("on: the comments name their thread; replies across two threads, or a reply_to of another thread, are refused", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id, sendId } = await sentNow(server, client, project);
  const other = (await call(client, "send_message", { project_path: project, thread: "other work", body: "Something else.", ...SESSION })).structured;
  expect((await post(server, `/api/inbox/messages/${other.message_id}/annotations`, { annotation: words("c-else", "Something", "Elsewhere.") })).status).toBe(200);
  expect((await post(server, `/api/inbox/threads/${other.thread_id}/comment-sends`, { mode: "now", comment_ids: ["c-else"], idempotency_key: "p-else" })).status).toBe(200);

  const across = await raw(client, alone([{ comment_id: "c-1", text: "Fine." }, { comment_id: "c-else", text: "Fine." }]));
  expect([across.isError, across.content[0]!.text.startsWith("validation_error: comment_replies[1].comment_id")]).toEqual([true, true]);
  const elsewhere = await raw(client, alone([{ comment_id: "c-1", text: "Fine." }], { reply_to: other.message_id }));
  expect([elsewhere.isError, elsewhere.content[0]!.text.startsWith("validation_error: comment_replies[0].comment_id")]).toEqual([true, true]);
  expect(await replies(server, thread_id)).toEqual([]);
  // The id a wake names (a comment send's) is a reply_to too.
  expect((await call(client, "send_message", alone([{ comment_id: "c-1", text: "Fine." }], { reply_to: sendId }))).structured.thread_id).toBe(thread_id);
});

test("on: a retry under the same key answers the first call's replies; other replies, or a key a message has, are refused", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id, message_id } = await sentNow(server, client, project);
  const first = await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }], { idempotency_key: "k-1" }));
  const again = await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }], { idempotency_key: "k-1" }));
  expect(again.structured.comment_replies).toEqual(first.structured.comment_replies);
  expect([again.structured.replayed, again.text.startsWith("Already replied under 1 comment ")]).toEqual([true, true]);
  const other = await raw(client, alone([{ comment_id: "c-1", text: "Nantes first." }], { idempotency_key: "k-1" }));
  expect([other.isError, other.content[0]!.text.startsWith("idempotency_key_reused:")]).toEqual([true, true]);
  await call(client, "send_message", { body: "A word.", reply_to: message_id, idempotency_key: "k-msg", ...SESSION });
  const reused = await raw(client, alone([{ comment_id: "c-2", text: "No release." }], { idempotency_key: "k-msg" }));
  expect([reused.isError, reused.content[0]!.text.startsWith("idempotency_key_reused:")]).toEqual([true, true]);
  // Nothing was written; a retry of a call that stopped partway writes the rest, under the same call.
  const more = await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }, { comment_id: "c-2", text: "No release." }], { idempotency_key: "k-1" }));
  expect(more.structured.replayed).toBe(false);
  const stored = await replies(server, thread_id);
  expect(stored.map((r) => [r.re, r.text, r.idempotency_key])).toEqual([
    ["c-1", "Lyon first.", "k-1"],
    ["c-2", "No release.", "k-1"],
  ]);
  expect(stored[1]!.call).toBe(stored[0]!.call);
});

test("on: without a key, the same session's words already last under a comment are not written again", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id } = await sentNow(server, client, project);
  const first = await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }]));
  // A retry whose answer was lost: the same words, nothing written, the first reply answered.
  const retry = await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }, { comment_id: "c-2", text: "No release." }]));
  expect(retry.structured.comment_replies[0]).toEqual(first.structured.comment_replies[0]);
  expect(retry.structured.replayed).toBe(false);
  expect((await replies(server, thread_id)).map((r) => r.text)).toEqual(["Lyon first.", "No release."]);
  expect((await call(client, "send_message", alone([{ comment_id: "c-2", text: "No release." }]))).structured.replayed).toBe(true);
  // Another session's same words are its own reply.
  await call(client, "send_message", { ...alone([{ comment_id: "c-2", text: "No release." }]), ...OTHER });
  // Once the person replied under the comment (a live thread sends it on its own), the same words again are a new reply.
  const saved = await post(server, "/api/inbox/annotations/c-1/replies", { annotation: { id: "r-person", text: "Why Lyon?" } });
  expect(saved.status).toBe(200);
  if (!((await saved.json()) as { sends?: unknown[] }).sends?.length) {
    expect((await post(server, `/api/inbox/threads/${thread_id}/comment-sends`, { mode: "now", comment_ids: ["r-person"], idempotency_key: "p-2" })).status).toBe(200);
  }
  await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }]));
  expect((await replies(server, thread_id)).map((r) => [r.re, r.from.session, r.text])).toEqual([
    ["c-1", "ses_review", "Lyon first."],
    ["c-2", "ses_review", "No release."],
    ["c-2", "ses_other", "No release."],
    ["c-1", "ses_review", "Lyon first."],
  ]);
});

test("on: replies sent alone are the round's: the round of the newest send the session received", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id } = await sentNow(server, client, project);
  // The agent reads the thread (the send is read), then answers.
  await call(client, "read_thread", { thread_id, ...READER });
  await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }]));
  const read = await call(client, "read_thread", { thread_id, ...READER });
  expect(read.text).toMatch(/^ {2}- reply rep_\w+ · round 1 · you: "Lyon first\."$/m);
  expect(read.text).toContain("round 1 still open");
  // The person finishes round 1 and sends a comment of round 2: a reply before the agent read it is still round 1's, one after it round 2's.
  expect((await post(server, `/api/inbox/threads/${thread_id}/comment-sends`, { mode: "round", idempotency_key: "f-1" })).status).toBe(200);
  const sent = (await call(client, "read_thread", { thread_id, format: "full", ...READER })).structured.thread.messages[0].id as string;
  expect((await post(server, `/api/inbox/messages/${sent}/annotations`, { annotation: words("c-3", "ship on Friday", "Not a Friday.") })).status).toBe(200);
  expect((await post(server, `/api/inbox/threads/${thread_id}/comment-sends`, { mode: "now", comment_ids: ["c-3"], idempotency_key: "p-2" })).status).toBe(200);
  await call(client, "send_message", alone([{ comment_id: "c-2", text: "Dropped it." }]));
  await call(client, "read_thread", { thread_id, ...READER });
  await call(client, "send_message", alone([{ comment_id: "c-3", text: "Moved to Tuesday." }]));
  const comments = (await call(client, "read_thread", { thread_id, ...READER })).structured.comments as { id: string; round: number; replies: { round: number }[] }[];
  expect(comments.map((c) => [c.id, c.round, c.replies.map((r) => r.round)])).toEqual([
    ["c-1", 1, [1]],
    ["c-2", 1, [1]],
    ["c-3", 2, [2]],
  ]);
});

test("on: replies sent alone answer a reply that carried comments as a message does: its round ends, the open ones go again", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = (await call(client, "send_message", { project_path: project, body: "The plan: ship on Friday, all stores at once, with a press release.", ...SESSION })).structured;
  const reply = async (key: string, ids: string[]) => {
    const messages = (await call(client, "read_thread", { thread_id: sent.thread_id, format: "full", agent_session: "ses_reader" })).structured.thread.messages;
    const last = [...messages].reverse().find((m: { author: { kind: string } }) => m.author.kind === "agent");
    const answer = await post(server, `/api/inbox/messages/${last.id}/reply`, { idempotency_key: key, feedback: "# Feedback", annotation_ids: ids });
    expect(answer.status).toBe(200);
    return ((await answer.json()) as { reply: { id: string; body: string } }).reply;
  };
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words("c-1", "all stores at once", "One store first.") })).status).toBe(200);
  await reply("r-1", ["c-1"]);
  await call(client, "send_message", alone([{ comment_id: "c-1", text: "Is Lyon fine?" }]));
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words("c-2", "a press release", "No press release.") })).status).toBe(200);
  const second = await reply("r-2", ["c-2"]);
  const read = (await call(client, "read_thread", { thread_id: sent.thread_id, ...READER })).structured.comments;
  expect(read.map((c: { id: string; round: number }) => [c.id, c.round])).toEqual([
    ["c-1", 1],
    ["c-2", 2],
  ]);
  // The session wrote since round 1: its open comment goes again with the next reply.
  expect(second.body).toContain("(id c-1)");
});

test("on: replies sent alone make the row unread until a look passes them; Mark unread and Mark read count them", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id } = await sentNow(server, client, project);
  const seen = (through?: number) => post(server, `/api/inbox/threads/${thread_id}/seen`, through === undefined ? {} : { through_seq: through });
  expect((await seen()).status).toBe(200);
  expect((await rowOf(server, thread_id)).unread).toBe(false);
  expect((await windowThread(server, thread_id)).agent_replies_seq).toBeUndefined();

  // One call, two replies: one piece of news.
  await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }, { comment_id: "c-2", text: "No release." }]));
  expect(await rowOf(server, thread_id)).toMatchObject({ section: "new", unread: true, unseen: 1 });
  const thread = await windowThread(server, thread_id);
  const lastMessage = Math.max(...thread.messages.filter((m) => m.author.kind === "agent").map((m) => m.seq));
  expect(thread.agent_replies_seq).toBeGreaterThan(lastMessage);
  // A look the window took before the replies (capped at the agent's last message) leaves them new.
  await seen(lastMessage);
  expect((await rowOf(server, thread_id)).unread).toBe(true);
  await seen(thread.agent_replies_seq);
  expect(await rowOf(server, thread_id)).toMatchObject({ unread: false, unseen: 0 });

  const unread = (await (await post(server, `/api/inbox/threads/${thread_id}/mark-unread`, {})).json()) as { wrote: boolean; through_seq: number; thread: InboxListRow };
  expect([unread.wrote, unread.through_seq, unread.thread.unseen]).toEqual([true, thread.agent_replies_seq, 1]);
  expect((await post(server, `/api/inbox/threads/${thread_id}/read`, {})).status).toBe(200);
  expect(await rowOf(server, thread_id)).toMatchObject({ section: "quiet", unread: false, unseen: 0 });
  // A second call after the Mark read is news again.
  await call(client, "send_message", alone([{ comment_id: "c-2", text: "Not even a post." }]));
  expect(await rowOf(server, thread_id)).toMatchObject({ section: "new", unread: true, unseen: 1 });
});

test("on: replies sent alone hold across a restart, their call and the row's news with them", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id } = await sentNow(server, client, project);
  await post(server, `/api/inbox/threads/${thread_id}/seen`, {});
  await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }], { idempotency_key: "k-1" }));
  const before = await replies(server, thread_id);
  server.stop();
  servers.splice(servers.indexOf(server), 1);
  const again = await start(dataDir);
  expect(await replies(again, thread_id)).toEqual(before);
  expect(await rowOf(again, thread_id)).toMatchObject({ unread: true, unseen: 1 });
  // The key still answers the first call.
  const retried = await call(await agent(again), "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }], { idempotency_key: "k-1" }));
  expect(retried.structured.replayed).toBe(true);
});

test("on: a reply alone into an archived thread brings it back, unread; a Mark read before it no longer stands", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id } = await sentNow(server, client, project);
  expect((await post(server, `/api/inbox/threads/${thread_id}/read`, {})).status).toBe(200);
  expect((await rowOf(server, thread_id)).read_at).not.toBeNull();
  await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }]));
  expect(await rowOf(server, thread_id)).toMatchObject({ section: "new", unread: true, read_at: null });
  expect((await post(server, `/api/inbox/messages/${thread_id}/resolve`, { resolved: true })).status).toBe(200);
  expect(await rowOf(server, thread_id, "?archived=exclude")).toBeUndefined();
  await call(client, "send_message", alone([{ comment_id: "c-2", text: "No release." }]));
  expect(await rowOf(server, thread_id, "?archived=exclude")).toMatchObject({ back_from_archive: true, unread: true });
});

test("on: without a key, the same words after the person wrote again are a new reply, and a retry keeps its own steps", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true, true);
  const client = await agent(server);
  const { thread_id } = await sentNow(server, client, project);
  await call(client, "send_message", alone([{ comment_id: "c-1", text: "Done." }]));
  // A retry that brings steps: nothing written, the steps saved.
  const steps = [{ step: "Pilot in Lyon", status: "doing" }];
  const retried = await call(client, "send_message", alone([{ comment_id: "c-1", text: "Done." }], { steps }));
  expect([retried.structured.replayed, retried.text.includes("Steps saved")]).toEqual([true, true]);
  // The person finishes the round, c-1 still open: the same words are the next round's answer.
  expect((await post(server, `/api/inbox/threads/${thread_id}/comment-sends`, { mode: "round", idempotency_key: "f-1" })).status).toBe(200);
  expect((await call(client, "send_message", alone([{ comment_id: "c-1", text: "Done." }]))).structured.replayed).toBe(false);
  expect((await replies(server, thread_id)).map((r) => r.text)).toEqual(["Done.", "Done."]);
});

test("on: replies are counted by comment, and a message under a key replies sent alone have is refused", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const { thread_id, message_id } = await sentNow(server, client, project);
  const two = await call(client, "send_message", alone([{ comment_id: "c-1", text: "Lyon first." }, { comment_id: "c-1", text: "Then Nantes." }], { idempotency_key: "k-1" }));
  expect(two.text).toStartWith("Replied under 1 comment ");
  const refused = await raw(client, { body: "A word.", reply_to: message_id, idempotency_key: "k-1", comment_replies: [{ comment_id: "c-2", text: "No release." }], ...SESSION });
  expect([refused.isError, refused.content[0]!.text.startsWith("idempotency_key_reused:")]).toEqual([true, true]);
  expect(await messageCount(client, thread_id)).toBe(1);
});
