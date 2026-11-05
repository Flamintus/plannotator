/**
 * Comment sends (experimental "persistent-comments"): the person's comments
 * reach the agent session as records of their own, proved through the
 * server's real doors: a running Inbox on loopback, the MCP SDK client for
 * the agents (send_message, read_thread) and `fetch` for the window. Each
 * test has its own temp data dir. The rules (rounds, live threads, the text)
 * are proved in packages/core/inbox-comment-sends.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxCommentSend } from "@plannotator/core/inbox-comment-sends";
import type { InboxAnnotationRecord, InboxMessage } from "@plannotator/core/inbox-types";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-comment-sends-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Notes\n\nShip on Friday.\n");
  return { project, dataDir: join(root, "data") };
}

async function start(dataDir: string, persistentComments = true): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, persistentComments });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-comment-sends-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; structured: Record<string, any> }> {
  const result = (await client.callTool({ name, arguments: args })) as Result;
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

function post(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

type Sent = { sends: InboxCommentSend[]; message: InboxMessage | null; replayed: boolean };

async function press(server: InboxServer, threadId: string, body: Record<string, unknown>): Promise<Sent> {
  const response = await post(server, `/api/inbox/threads/${threadId}/comment-sends`, body);
  const answer = (await response.json()) as Sent & { code?: string; error?: string };
  if (response.status !== 200) throw new Error(`${response.status} ${answer.code}: ${answer.error}`);
  return answer;
}

async function refusal(server: InboxServer, threadId: string, body: Record<string, unknown>): Promise<[number, string]> {
  const response = await post(server, `/api/inbox/threads/${threadId}/comment-sends`, body);
  return [response.status, ((await response.json()) as { code: string }).code];
}

const A = { agent_session: "ses_alpha", agent_name: "Claude Code", agent_host: "claude-code" };
const B = { agent_session: "ses_beta", agent_name: "Pi", agent_host: "pi" };

function words(id: string, originalText: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, blockId: "block-1", startOffset: 0, endOffset: originalText.length, type: "COMMENT", text, originalText, createdA: 1, ...extra };
}

/** A comment on the words of an agent's message: a draft. */
async function comment(server: InboxServer, messageId: string, id: string, quote: string, text: string, extra: Record<string, unknown> = {}) {
  const saved = await post(server, `/api/inbox/messages/${messageId}/annotations`, { annotation: words(id, quote, text, extra) });
  expect(saved.status).toBe(200);
}

/** The agent's message with notes.md, in a new thread. */
async function opening(client: Client, project: string, session = A) {
  return (await call(client, "send_message", { project_path: project, body: "The plan: ship on Friday, all stores at once, with a press release.", attachments: ["notes.md"], ...session })).structured as {
    message_id: string;
    thread_id: string;
    attachments: { id: string }[];
  };
}

async function files(server: InboxServer, threadId: string): Promise<{ annotations: InboxAnnotationRecord[]; sent_comments?: InboxAnnotationRecord[]; comment_sends?: InboxCommentSend[] }> {
  return (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}/attachments`)).json()) as never;
}

function projectFolder(dataDir: string): string {
  return join(dataDir, "inbox", "projects", readdirSync(join(dataDir, "inbox", "projects"))[0]!);
}

async function events(server: InboxServer, cursor: number): Promise<Record<string, unknown>[]> {
  const text = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=${cursor}&once=1`)).text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("event: record"))
    .map((block) => JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as Record<string, unknown>);
}

test("off: the route is refused and writes nothing", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, false);
  const client = await agent(server);
  const sent = await opening(client, project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  expect(await refusal(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" })).toEqual([409, "persistent_comments_off"]);
  expect(existsSync(join(projectFolder(dataDir), "comment-sends.jsonl"))).toBe(false);
  expect((await files(server, sent.thread_id)).annotations.map((r) => r.id)).toEqual(["c-1"]);
});

test("now: one draft goes to the session that wrote its message, as its own record; the round stays open and the other drafts wait", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await opening(client, project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  await comment(server, sent.message_id, "c-2", "with a press release", "No press release yet.");
  const cursor = server.store.cursor();
  const messagesBefore = server.store.thread(sent.thread_id)!.messages.length;

  const first = await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" });
  expect(first.replayed).toBe(false);
  expect(first.message).toBeNull();
  expect(first.sends).toHaveLength(1);
  const [one] = first.sends;
  expect(one).toMatchObject({ thread_id: sent.thread_id, to: { host: "claude-code", session: "ses_alpha" }, round: 1, mode: "now", comments: ["c-1"], with_message: null, idempotency_key: "k-1" });
  expect(one!.id).toMatch(/^snd_/);
  expect(one!.batch).toBe(one!.id);
  // No message joins the thread; the draft is marked sent by the send, the other still waits.
  expect(server.store.thread(sent.thread_id)!.messages).toHaveLength(messagesBefore);
  const model = await files(server, sent.thread_id);
  expect(model.annotations.map((r) => r.id)).toEqual(["c-2"]);
  expect(model.sent_comments!.map((r) => [r.id, r.sent_reply_id])).toEqual([["c-1", one!.id]]);
  expect(model.comment_sends!.map((s) => s.id)).toEqual([one!.id]);

  // The next `now` send is in the same round: only a Finish ends it.
  const second = await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-2"], idempotency_key: "k-2" });
  expect(second.sends[0]!.round).toBe(1);

  // The event stream carries each send as a silent record of its thread.
  const kinds = (await events(server, cursor)).filter((record) => record.kind === "comment_send");
  expect(kinds.map((record) => [record.id, record.thread_id])).toEqual([
    [one!.id, sent.thread_id],
    [second.sends[0]!.id, sent.thread_id],
  ]);

  // read_thread names the send that carried each comment and says the round is still open.
  const read = await call(client, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_alpha" });
  const line = read.text.split("\n").find((l) => l.startsWith("- c-1 "))!;
  expect(line).toContain(`round 1 (send ${one!.id})`);
  expect(read.text).toContain("round 1 still open");
  expect(read.structured.comment_sends.map((s: { id: string; mode: string }) => [s.id, s.mode])).toEqual([
    [one!.id, "now"],
    [second.sends[0]!.id, "now"],
  ]);
});

test("a press is idempotent on its key; another press under it is refused, and every refusal writes nothing", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await opening(client, project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  const first = await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" });
  const lines = () => readFileSync(join(projectFolder(dataDir), "comment-sends.jsonl"), "utf8").trim().split("\n").length;
  const before = lines();

  const again = await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" });
  expect(again.replayed).toBe(true);
  expect(again.sends.map((s) => s.id)).toEqual(first.sends.map((s) => s.id));
  expect(lines()).toBe(before);
  expect(await refusal(server, sent.thread_id, { mode: "round", idempotency_key: "k-1" })).toEqual([409, "idempotency_key_reused"]);

  // Refused before anything is written: a sent draft, an unknown one, no key, no draft named.
  await comment(server, sent.message_id, "c-2", "with a press release", "No press release yet.");
  expect(await refusal(server, sent.thread_id, { mode: "now", comment_ids: ["c-2", "c-1"], idempotency_key: "k-2" })).toEqual([409, "annotation_closed"]);
  expect(await refusal(server, sent.thread_id, { mode: "now", comment_ids: ["nope"], idempotency_key: "k-3" })).toEqual([404, "annotation_not_found"]);
  expect(await refusal(server, sent.thread_id, { mode: "now", comment_ids: ["c-2"] })).toEqual([422, "validation_error"]);
  expect(await refusal(server, sent.thread_id, { mode: "now", comment_ids: [], idempotency_key: "k-4" })).toEqual([422, "validation_error"]);
  expect(lines()).toBe(before);
  expect((await files(server, sent.thread_id)).annotations.map((r) => r.id)).toEqual(["c-2"]);
});

test("a Finish sends one record per session, linked by its batch, with the tags its comments carry, and ends the round", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const alpha = await agent(server);
  const beta = await agent(server);
  const sent = await opening(alpha, project);
  const other = (await call(beta, "send_message", { project_path: project, body: "I can take the press release.", reply_to: sent.message_id, ...B })).structured;
  await comment(server, sent.message_id, "c-alpha", "all stores at once", "One store first.");
  // A file comment rides with the words' session (the newest agent's), as the window's Send routes it.
  const onFile = await post(server, "/api/inbox/annotations", { attachment_id: sent.attachments[0]!.id, version: "current", annotation: words("c-file", "Ship on Friday.", "Not on a Friday.") });
  expect(onFile.status).toBe(200);
  // A comment that tags the other agent hands it the send too.
  await comment(server, other.message_id, "c-beta", "I can take", "Please do, and loop in alpha.", { mentions: ["ses_alpha"] });

  const finish = await press(server, sent.thread_id, { mode: "round", idempotency_key: "f-1" });
  expect(finish.sends.map((s) => [s.to.session, s.mode, s.round, [...s.comments].sort()])).toEqual([
    ["ses_alpha", "round", 1, ["c-alpha"]],
    ["ses_beta", "round", 1, ["c-beta", "c-file"]],
  ]);
  expect(new Set(finish.sends.map((s) => s.batch)).size).toBe(1);
  expect(finish.sends[1]!.tags?.map((t) => [t.session, t.wakes])).toEqual([["ses_alpha", false]]);
  expect((await files(server, sent.thread_id)).annotations).toEqual([]);

  // The round ended: the next send is in round 2.
  await comment(server, sent.message_id, "c-next", "with a press release", "And the date?");
  const next = await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-next"], idempotency_key: "n-1" });
  expect(next.sends[0]!.round).toBe(2);
});

test("a Finish with no draft still ends the round, naming the threads still open that went to that session", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await opening(client, project);
  await comment(server, sent.message_id, "c-open", "all stores at once", "One store first.");
  await comment(server, sent.message_id, "c-done", "with a press release", "No press release yet.");
  await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-open"], idempotency_key: "k-1" });
  await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-done"], idempotency_key: "k-2" });
  expect((await post(server, "/api/inbox/annotations/c-done/resolve", { resolved: true })).status).toBe(200);

  const finish = await press(server, sent.thread_id, { mode: "round", idempotency_key: "f-1" });
  expect(finish.sends.map((s) => [s.to.session, s.round, s.comments])).toEqual([["ses_alpha", 1, ["c-open"]]]);
  // Nothing was carried, so nothing changed hands; the counter moved on.
  const again = await press(server, sent.thread_id, { mode: "round", idempotency_key: "f-2" });
  expect(again.sends.map((s) => s.round)).toEqual([2]);
  const read = await call(client, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_alpha" });
  expect(read.text).toContain("round 2 finished");
});

test("words go as the person's reply to the message they answer, and the send to that session names it", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await opening(client, project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  const finish = await press(server, sent.thread_id, { mode: "round", words: "Looks close; see my comment.", idempotency_key: "f-1" });
  expect(finish.message).toMatchObject({ author: { kind: "person" }, reply_to: sent.message_id, body: "Looks close; see my comment." });
  expect(finish.sends.map((s) => [s.comments, s.with_message])).toEqual([[["c-1"], finish.message!.id]]);
  const replay = await press(server, sent.thread_id, { mode: "round", words: "Looks close; see my comment.", idempotency_key: "f-1" });
  expect([replay.replayed, replay.message?.id]).toEqual([true, finish.message!.id]);
  expect(server.store.thread(sent.thread_id)!.messages.filter((m) => m.author.kind === "person")).toHaveLength(1);
});

test("live: once a `now` send reached a thread, the person's reply under it goes on its own; under any other it stays a draft", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await opening(client, project);
  await comment(server, sent.message_id, "c-live", "all stores at once", "One store first.");
  await comment(server, sent.message_id, "c-quiet", "with a press release", "No press release yet.");
  await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-live"], idempotency_key: "k-1" });
  await press(server, sent.thread_id, { mode: "round", idempotency_key: "f-1" });

  const live = await post(server, "/api/inbox/annotations/c-live/replies", { annotation: { id: "r-live", text: "Lyon, then?" } });
  const answer = (await live.json()) as { annotation: InboxAnnotationRecord; sends?: InboxCommentSend[] };
  expect(answer.sends!.map((s) => [s.mode, s.comments, s.to.session])).toEqual([["now", ["r-live"], "ses_alpha"]]);
  expect(answer.annotation.sent_reply_id).toBe(answer.sends![0]!.id);

  // c-quiet went with the Finish only: a reply under it waits for the next press.
  const quiet = await post(server, "/api/inbox/annotations/c-quiet/replies", { annotation: { id: "r-quiet", text: "Or a short note?" } });
  const kept = (await quiet.json()) as { annotation: InboxAnnotationRecord; sends?: unknown };
  expect([kept.annotation.sent_reply_id, kept.sends]).toEqual([null, undefined]);
  expect((await files(server, sent.thread_id)).annotations.map((r) => r.id)).toEqual(["r-quiet"]);
});

test("ranged reads keep what the sends of their range carried, and a session's own read marks its sends read, never another's", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const alpha = await agent(server);
  const beta = await agent(server);
  const sent = await opening(alpha, project);
  await call(beta, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_beta" });
  await comment(server, sent.message_id, "c-old", "all stores at once", "One store first.");
  await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-old"], idempotency_key: "k-1" });
  const cursor = server.store.cursor();
  await comment(server, sent.message_id, "c-new", "with a press release", "No press release yet.");
  const fresh = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-new"], idempotency_key: "k-2" })).sends[0]!;

  // Another session's read settles nothing of alpha's.
  await call(beta, "read_thread", { thread_id: sent.thread_id, after: cursor, agent_session: "ses_beta" });
  expect(server.store.commentSend(fresh.id)!.read_at ?? null).toBeNull();

  // What is new after the cursor: no message, but the send of that range and what it carried.
  const read = await call(alpha, "read_thread", { thread_id: sent.thread_id, after: cursor, agent_session: "ses_alpha" });
  expect(read.structured.comments.map((c: { id: string }) => c.id)).toEqual(["c-new"]);
  expect(read.text).toContain("1 more from other rounds");
  const older = server.store.commentSends(sent.thread_id).find((s) => s.id !== fresh.id)!;
  expect(typeof server.store.commentSend(fresh.id)!.read_at).toBe("string");
  expect(older.read_at ?? null).toBeNull();
  // A read of the whole thread takes the rest.
  await call(alpha, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_alpha" });
  expect(typeof server.store.commentSend(older.id)!.read_at).toBe("string");
});

test("the sends hold across a restart with their seq floor; a send whose line never landed leaves its drafts waiting; deleting the thread takes them", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await opening(client, project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  await comment(server, sent.message_id, "c-2", "with a press release", "No press release yet.");
  const kept = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" })).sends[0]!;
  const lost = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-2"], idempotency_key: "k-2" })).sends[0]!;
  const seq = server.store.cursor();
  server.stop();
  servers.splice(servers.indexOf(server), 1);
  // A process that died between the drafts' lines and the send's: the send's line is not there.
  const file = join(projectFolder(dataDir), "comment-sends.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").split("\n").filter((line) => !line.includes(lost.id)).join("\n"));
  expect((JSON.parse(readFileSync(join(dataDir, "inbox", "seq.json"), "utf8")) as { seq: number }).seq).toBeGreaterThanOrEqual(seq);

  const again = await start(dataDir);
  expect(again.store.commentSends(sent.thread_id).map((s) => s.id)).toEqual([kept.id]);
  const model = await files(again, sent.thread_id);
  expect(model.sent_comments!.map((r) => [r.id, r.sent_reply_id])).toEqual([["c-1", kept.id]]);
  expect(model.annotations.map((r) => r.id)).toEqual(["c-2"]);
  expect((await post(again, `/api/inbox/threads/${sent.thread_id}/delete`, {})).status).toBe(200);
  expect(readFileSync(file, "utf8")).not.toContain(kept.id);
});

test("a Finish also ends the round for a session the round's sends reached, though the words now go to another", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const alpha = await agent(server);
  const beta = await agent(server);
  const sent = await opening(alpha, project);
  await comment(server, sent.message_id, "c-alpha", "all stores at once", "One store first.");
  await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-alpha"], idempotency_key: "k-1" });
  await call(beta, "send_message", { project_path: project, body: "I can take the press release.", reply_to: sent.message_id, ...B });
  const finish = await press(server, sent.thread_id, { mode: "round", idempotency_key: "f-1" });
  expect(finish.sends.map((s) => [s.to.session, s.comments])).toEqual([
    ["ses_alpha", ["c-alpha"]],
    ["ses_beta", []],
  ]);
});

test("refusals: no agent session to send to, a resolved thread; a live reply whose tag cannot be reached stays a draft and says why", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const anonymous = (await call(client, "send_message", { project_path: project, body: "A plan with no session: ship on Friday." })).structured;
  await comment(server, anonymous.message_id, "c-nobody", "ship on Friday", "Not on a Friday.");
  expect(await refusal(server, anonymous.thread_id, { mode: "now", comment_ids: ["c-nobody"], idempotency_key: "k-0" })).toEqual([422, "not_addressed"]);

  const sent = await opening(client, project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" });
  const tagged = await post(server, "/api/inbox/annotations/c-1/replies", { annotation: { id: "r-ghost", text: "Ask the other agent too.", mentions: ["ses_ghost"] } });
  const answer = (await tagged.json()) as { annotation: InboxAnnotationRecord; send_refused?: { code: string } };
  expect([answer.annotation.sent_reply_id, answer.send_refused?.code]).toEqual([null, "session_not_live"]);

  await comment(server, sent.message_id, "c-2", "with a press release", "No press release yet.");
  await call(client, "resolve_message", { message_id: sent.message_id });
  expect(await refusal(server, sent.thread_id, { mode: "now", comment_ids: ["c-2"], idempotency_key: "k-2" })).toEqual([409, "thread_resolved"]);
});

test("a live reply saved again (a lost answer) answers what it sent, once", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await opening(client, project);
  await comment(server, sent.message_id, "c-1", "all stores at once", "One store first.");
  await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" });
  const body = { annotation: { id: "r-1", text: "Lyon, then?" } };
  const first = (await (await post(server, "/api/inbox/annotations/c-1/replies", body)).json()) as { sends: InboxCommentSend[] };
  const again = await post(server, "/api/inbox/annotations/c-1/replies", body);
  expect(again.status).toBe(200);
  expect(((await again.json()) as { sends: InboxCommentSend[] }).sends.map((s) => s.id)).toEqual(first.sends.map((s) => s.id));
  expect(server.store.commentSends(sent.thread_id)).toHaveLength(2);
  // Other words under the same id are the store's to refuse: it was sent.
  expect((await post(server, "/api/inbox/annotations/c-1/replies", { annotation: { id: "r-1", text: "Nantes, then?" } })).status).toBe(409);
});

test("a session a send tags marks its own read on the tag; off, nothing of the sends is served or marked", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const alpha = await agent(server);
  const beta = await agent(server);
  const sent = await opening(alpha, project);
  // Beta writes elsewhere, so the Inbox knows it as an agent the person can tag.
  await call(beta, "send_message", { project_path: project, body: "Another thread.", ...B });
  await comment(server, sent.message_id, "c-1", "all stores at once", "Beta, can you check the traffic?", { mentions: ["ses_beta"] });
  const one = (await press(server, sent.thread_id, { mode: "now", comment_ids: ["c-1"], idempotency_key: "k-1" })).sends[0]!;
  expect(one.tags?.map((t) => t.session)).toEqual(["ses_beta"]);
  await call(beta, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_beta" });
  const read = server.store.commentSend(one.id)!;
  expect([typeof read.tags![0]!.read_at, read.read_at ?? null]).toEqual(["string", null]);

  server.stop();
  servers.splice(servers.indexOf(server), 1);
  const off = await start(dataDir, false);
  const client = await agent(off);
  const full = await call(client, "read_thread", { thread_id: sent.thread_id, format: "full", agent_session: "ses_alpha" });
  const windowed = await call(client, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_alpha" });
  expect([full.structured.comment_sends, windowed.structured.comment_sends, (await files(off, sent.thread_id)).comment_sends]).toEqual([undefined, undefined, undefined]);
  expect(off.store.commentSend(one.id)!.read_at ?? null).toBeNull();
});
