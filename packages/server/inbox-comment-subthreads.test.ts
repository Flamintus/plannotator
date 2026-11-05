/**
 * Sub-threads on a passage of a message of a comment thread (experimental
 * "persistent-comments"), proved through the server's real doors: a running
 * Inbox on loopback, the MCP SDK client for the agent (send_message's
 * `comment_replies`, read_thread) and `fetch` for the window. Each test has
 * its own temp data dir. The rules (the thread model, what each Send and
 * round carries) are proved in packages/core/inbox-comment-threads.test.ts.
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-comment-subthreads-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Notes\n\nShip on Friday.\n");
  return { project, dataDir: join(root, "data") };
}

async function start(dataDir: string, persistentComments: boolean): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, persistentComments });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-comment-subthreads-test", version: "1.0.0" });
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

async function answer(response: Response): Promise<[number, string | undefined]> {
  return [response.status, ((await response.json()) as { code?: string }).code];
}

async function files(server: InboxServer, threadId: string): Promise<{ annotations: InboxAnnotationRecord[]; sent_comments?: InboxAnnotationRecord[] }> {
  return (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}/attachments`)).json()) as never;
}

const SESSION = { agent_session: "ses_review", agent_name: "Claude Code", agent_host: "claude-code" };
const READER = { agent_session: "ses_review" };
const STEPS = "Step 1 tags the release. Step 2 rolls back through the feature-flag off switch. Step 3 pages support.";

function words(id: string, originalText: string, text: string) {
  return { id, blockId: "block-1", startOffset: 0, endOffset: originalText.length, type: "COMMENT", text, originalText, createdA: 1 };
}

/** A sub-thread as the window saves it: on `quote`, where it starts in `of`. */
function onPassage(id: string, of: string, quote: string, text: string) {
  return { annotation: { id, text, quote, quote_offset: of.indexOf(quote) } };
}

/** Round 1: a comment on the agent's message and one on notes.md; the agent answers both, the message's in three steps. */
async function roundOne(server: InboxServer, client: Client, project: string) {
  const sent = (await call(client, "send_message", { project_path: project, body: "The plan: ship on Friday, all stores at once.", attachments: ["notes.md"], ...SESSION })).structured;
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words("c-msg", "all stores at once", "How do we roll back?") })).status).toBe(200);
  expect((await post(server, "/api/inbox/annotations", { attachment_id: sent.attachments[0].id, version: "current", annotation: words("c-file", "Ship on Friday.", "Not on a Friday.") })).status).toBe(200);
  const reply = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "r-1", feedback: "# Feedback", annotation_ids: ["c-msg", "c-file"] });
  const replyId = ((await reply.json()) as { reply: { id: string } }).reply.id;
  const answered = (
    await call(client, "send_message", {
      project_path: project,
      body: "Both answered.",
      reply_to: replyId,
      comment_replies: [
        { comment_id: "c-msg", text: STEPS },
        { comment_id: "c-file", text: "Moved to Tuesday." },
      ],
      ...SESSION,
    })
  ).structured;
  return { sent, steps: answered.comment_replies[0].reply_id as string, agentMessage: answered.message_id as string };
}

/** The person's next Send, carrying `ids`. */
async function send(server: InboxServer, client: Client, threadId: string, key: string, ids: string[]) {
  const messages = (await call(client, "read_thread", { thread_id: threadId, format: "full", ...READER })).structured.thread.messages;
  const reply = await post(server, `/api/inbox/messages/${messages.at(-1).id}/reply`, { idempotency_key: key, feedback: "# Feedback on comment threads", annotation_ids: ids });
  expect(reply.status).toBe(200);
  return ((await reply.json()) as { reply: { id: string; body: string } }).reply;
}

test("off: no sub-thread is saved", async () => {
  const { dataDir } = world();
  const server = await start(dataDir, false);
  expect(await answer(await post(server, "/api/inbox/annotations/c-msg/subthreads", onPassage("s-off", STEPS, "off switch", "Which?")))).toEqual([409, "persistent_comments_off"]);
});

test("on a passage of the agent's reply: a draft in its thread's place, under that reply, kept on its passage when edited; never on a draft", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, steps } = await roundOne(server, client, project);

  const saved = await post(server, `/api/inbox/annotations/${steps}/subthreads`, onPassage("s1", STEPS, "off switch", "Which off switch? The old one is gone."));
  expect(saved.status).toBe(200);
  const draft = ((await saved.json()) as { annotation: InboxAnnotationRecord }).annotation;
  expect(draft).toMatchObject({
    parent: steps,
    quote_offset: STEPS.indexOf("off switch"),
    message_id: sent.message_id,
    sent_reply_id: null,
    annotation: { originalText: "off switch", text: "Which off switch? The old one is gone.", inReplyTo: steps },
  });
  expect(draft.re).toBeUndefined();
  // The window's list saves an edit through the message's route: it stays on its passage.
  const edited = await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: { ...draft.annotation, text: "Which off switch?" } });
  expect(((await edited.json()) as { annotation: InboxAnnotationRecord }).annotation).toMatchObject({ parent: steps, quote_offset: STEPS.indexOf("off switch"), annotation: { originalText: "off switch", text: "Which off switch?" } });
  // Not the agent's to read yet.
  expect((await call(client, "read_thread", { thread_id: sent.thread_id, ...READER })).text).not.toContain("Which off switch");

  // Refused: on a draft (its own, here), on nothing, with no passage or no place for it, or an id another comment has.
  expect(await answer(await post(server, "/api/inbox/annotations/s1/subthreads", onPassage("s2", "Which off switch?", "off", "?")))).toEqual([409, "annotation_not_sent"]);
  expect(await answer(await post(server, "/api/inbox/annotations/c-none/subthreads", onPassage("s3", STEPS, "Step", "?")))).toEqual([404, "annotation_not_found"]);
  // A draft reply the person removed is drawn nowhere: no message to comment on.
  expect((await post(server, "/api/inbox/annotations/c-msg/replies", { annotation: { id: "r-gone", text: "Never mind." } })).status).toBe(200);
  expect((await post(server, "/api/inbox/annotations/r-gone/remove", {})).status).toBe(200);
  expect(await answer(await post(server, "/api/inbox/annotations/r-gone/subthreads", onPassage("s6", "Never mind.", "mind", "?")))).toEqual([404, "annotation_not_found"]);
  expect((await post(server, `/api/inbox/annotations/${steps}/subthreads`, { annotation: { id: "s4", text: "?", quote: " ", quote_offset: 0 } })).status).toBe(422);
  expect((await post(server, `/api/inbox/annotations/${steps}/subthreads`, { annotation: { id: "s5", text: "?", quote: "Step", quote_offset: -1 } })).status).toBe(422);
  expect((await post(server, "/api/inbox/annotations/c-file/subthreads", onPassage("s1", "Not on a Friday.", "Friday", "?"))).status).toBe(422);
});

test("once sent it is a thread of its own: read_thread gives the words its passage is in, the agent replies under its id, and a sub-thread goes under it", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, steps } = await roundOne(server, client, project);
  expect((await post(server, `/api/inbox/annotations/${steps}/subthreads`, onPassage("s1", STEPS, "off switch", "Which off switch?"))).status).toBe(200);
  // On the file's comment too: there, its place is the file's.
  expect((await post(server, "/api/inbox/annotations/c-file/subthreads", onPassage("s-file", "Not on a Friday.", "Friday", "Nor a Thursday."))).status).toBe(200);
  const carried = await send(server, client, sent.thread_id, "r-2", ["s1", "s-file"]);

  const read = await call(client, "read_thread", { thread_id: sent.thread_id, ...READER });
  const s1 = read.structured.comments.find((c: { id: string }) => c.id === "s1");
  expect(s1).toMatchObject({ round: 2, reply_id: carried.id, state: "open", quote: "off switch", parent: { id: steps, kind: "reply", under: "c-msg", text: STEPS, quote_offset: STEPS.indexOf("off switch") } });
  const line = read.text.split("\n").find((l) => l.startsWith("- s1 "))!;
  expect(line).toContain(`on a passage of reply ${steps} under comment c-msg (on message ${sent.message_id})`);
  expect(line).toContain(`in ${JSON.stringify(STEPS)}`);
  expect((await files(server, sent.thread_id)).sent_comments!.find((r) => r.id === "s-file")).toMatchObject({ attachment_id: sent.attachments[0].id, parent: "c-file" });

  // The agent answers under the sub-thread by its id, as under any comment.
  const answered = (await call(client, "send_message", { project_path: project, body: "Named it.", reply_to: carried.id, comment_replies: [{ comment_id: "s1", text: "The flag service's own off switch." }], ...SESSION })).structured;
  expect(answered.comment_replies.map((r: { comment_id: string }) => r.comment_id)).toEqual(["s1"]);
  const after = (await call(client, "read_thread", { thread_id: sent.thread_id, ...READER })).structured.comments;
  expect(after.find((c: { id: string }) => c.id === "s1").replies.map((r: { text: string }) => r.text)).toEqual(["The flag service's own off switch."]);
  expect(after.find((c: { id: string }) => c.id === "c-msg").replies.map((r: { id: string }) => r.id)).toEqual([steps]);

  // A sub-thread on a passage of the sub-thread, at any depth.
  const nested = await post(server, "/api/inbox/annotations/s1/subthreads", onPassage("s1-1", "Which off switch?", "off switch", "The one in the runbook."));
  expect(((await nested.json()) as { annotation: InboxAnnotationRecord }).annotation).toMatchObject({ parent: "s1", message_id: sent.message_id });
});

test("it resolves on its own: its parent resolved, it stays open and the next Finish names it, not its parent", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, steps } = await roundOne(server, client, project);
  expect((await post(server, `/api/inbox/annotations/${steps}/subthreads`, onPassage("s1", STEPS, "off switch", "Which off switch?"))).status).toBe(200);
  const carried = await send(server, client, sent.thread_id, "r-2", ["s1"]);
  const state = async () => Object.fromEntries((await call(client, "read_thread", { thread_id: sent.thread_id, ...READER })).structured.comments.map((c: { id: string; state: string }) => [c.id, c.state]));

  expect((await post(server, "/api/inbox/annotations/c-msg/resolve", { resolved: true })).status).toBe(200);
  expect(await state()).toMatchObject({ "c-msg": "resolved", s1: "open" });
  // The next round: the agent wrote; the person's Finish names the open sub-thread again, never its resolved parent.
  await call(client, "send_message", { project_path: project, body: "Thinking.", reply_to: carried.id, ...SESSION });
  const finish = await post(server, `/api/inbox/threads/${sent.thread_id}/comment-sends`, { mode: "round", idempotency_key: "f-3" });
  expect(finish.status).toBe(200);
  const named = ((await finish.json()) as { sends: { comments: string[] }[] }).sends.flatMap((s) => s.comments);
  expect(named).toContain("s1");
  expect(named).not.toContain("c-msg");

  // Resolving the sub-thread leaves its parent as it is.
  expect((await post(server, "/api/inbox/annotations/c-msg/resolve", { resolved: false })).status).toBe(200);
  expect((await post(server, "/api/inbox/annotations/s1/resolve", { resolved: true })).status).toBe(200);
  expect(await state()).toMatchObject({ "c-msg": "open", s1: "resolved" });
});

test("a sub-thread holds across a restart, and deleting the thread takes it with every message it was on", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, steps } = await roundOne(server, client, project);
  expect((await post(server, `/api/inbox/annotations/${steps}/subthreads`, onPassage("s1", STEPS, "off switch", "Which?"))).status).toBe(200);
  await send(server, client, sent.thread_id, "r-2", ["s1"]);

  server.stop();
  servers.splice(servers.indexOf(server), 1);
  const again = await start(dataDir, true);
  expect((await files(again, sent.thread_id)).sent_comments!.find((r) => r.id === "s1")).toMatchObject({ parent: steps, quote_offset: STEPS.indexOf("off switch") });
  const projectDir = join(dataDir, "inbox", "projects", readdirSync(join(dataDir, "inbox", "projects"))[0]!);
  expect((await post(again, `/api/inbox/threads/${sent.thread_id}/delete`, {})).status).toBe(200);
  expect(readFileSync(join(projectDir, "annotations.jsonl"), "utf8")).not.toContain('"s1"');
});
