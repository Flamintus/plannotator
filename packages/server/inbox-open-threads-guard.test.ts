/**
 * A comment thread still open holds the archive of its thread (a personal
 * branch, own/open-threads-guard; packages/shared/inbox/open-threads-guard.ts),
 * proved through the server's real doors: a running Inbox on loopback, the
 * MCP SDK client for the agent (resolve_message) and `fetch` for the window
 * (Archive, Archive all, Resolve). Each test has its own temp data dir. Which
 * comment threads hold it is proved in packages/core/inbox-open-threads-guard.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world(persistentComments: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-open-threads-guard-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Notes\n\nShip on Friday.\n");
  const server = await startInboxServer({ dataDir: join(root, "data"), persistentComments });
  servers.push(server);
  const client = new Client({ name: "inbox-open-threads-guard-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { project, server, client };
}

type Called = { isError: boolean; text: string; structured: Record<string, any> };

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<Called> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  return { isError: result.isError === true, text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await tool(client, name, args);
  if (result.isError) throw new Error(result.text);
  return result.structured;
}

async function post(server: InboxServer, path: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const SESSION = { agent_session: "ses_review", agent_name: "Claude Code", agent_host: "claude-code" };

function words(id: string, originalText: string, text: string) {
  return { id, blockId: "block-1", startOffset: 0, endOffset: originalText.length, type: "COMMENT", text, originalText, createdA: 1 };
}

/** The agent's message with notes.md, a comment on each sent in the person's reply, and the agent's answer (with a reply under the message's comment). */
async function reviewed(server: InboxServer, client: Client, project: string) {
  const sent = await call(client, "send_message", { project_path: project, body: "The plan: ship on Friday, all stores at once.", attachments: ["notes.md"], ...SESSION });
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words("c-msg", "all stores at once", "How do we roll back?") })).status).toBe(200);
  expect((await post(server, "/api/inbox/annotations", { attachment_id: sent.attachments[0].id, version: "current", annotation: words("c-file", "Ship on Friday.", "Not on a Friday.") })).status).toBe(200);
  const reply = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "r-1", feedback: "# Feedback", annotation_ids: ["c-msg", "c-file"] });
  expect(reply.status).toBe(200);
  const answered = await call(client, "send_message", {
    project_path: project,
    body: "Both answered.",
    reply_to: reply.body.reply.id,
    comment_replies: [{ comment_id: "c-msg", text: "Step 1 tags the release. Step 2 rolls back through the off switch." }],
    ...SESSION,
  });
  return { thread: sent.thread_id as string, replyId: answered.comment_replies[0].reply_id as string, agentMessage: answered.message_id as string };
}

const archive = (server: InboxServer, thread: string) => post(server, `/api/inbox/messages/${thread}/resolve`, { resolved: true });
const resolveComment = async (server: InboxServer, id: string, resolved = true) => expect((await post(server, `/api/inbox/annotations/${id}/resolve`, { resolved })).status).toBe(200);
const isArchived = (server: InboxServer, thread: string) => server.store.message(thread)?.resolved_at != null;

test("on: resolve_message and the person's Archive are refused while a comment thread is open, naming them; once none is, both archive", async () => {
  const { project, server, client } = await world(true);
  const { thread, agentMessage } = await reviewed(server, client, project);

  // Any message of the thread names it, as resolve_message takes: here the agent's own latest.
  const agent = await tool(client, "resolve_message", { message_id: agentMessage });
  expect(agent.isError).toBe(true);
  // Deliberate: the refusal's code and count, which the agent acts on.
  expect(agent.text.startsWith("comment_threads_open: 2 comment threads are still open")).toBe(true);
  expect(agent.text).toContain("c-msg");
  expect(agent.text).toContain("c-file");
  const person = await archive(server, agentMessage);
  expect([person.status, person.body.code, person.body.comment_ids]).toEqual([409, "comment_threads_open", ["c-msg", "c-file"]]);
  expect(isArchived(server, thread)).toBe(false);

  // One left: it alone is named.
  await resolveComment(server, "c-file");
  const one = await tool(client, "resolve_message", { message_id: thread });
  expect(one.text.startsWith("comment_threads_open: 1 comment thread is still open in this thread: c-msg.")).toBe(true);

  // An agent's reply after the person resolved it opens it again (crit's rule), and it holds again.
  await resolveComment(server, "c-msg");
  await call(client, "send_message", { project_path: project, body: "One more point.", reply_to: thread, comment_replies: [{ comment_id: "c-msg", text: "Also: support hears first." }], ...SESSION });
  expect((await archive(server, thread)).body.comment_ids).toEqual(["c-msg"]);

  await resolveComment(server, "c-msg");
  expect((await call(client, "resolve_message", { message_id: thread })).thread.resolved_at).not.toBeNull();
  // Archived already: nothing to hold, the call is as idempotent as before; reopening is never held.
  expect((await tool(client, "resolve_message", { message_id: thread })).isError).toBe(false);
  expect((await call(client, "resolve_message", { message_id: thread, resolved: false })).thread.resolved_at).toBeNull();
});

test("on: an open sub-thread holds the archive under a resolved comment, and the person's draft reply opens a resolved comment again", async () => {
  const { project, server, client } = await world(true);
  const { thread, replyId } = await reviewed(server, client, project);
  const steps = "Step 1 tags the release. Step 2 rolls back through the off switch.";
  expect((await post(server, `/api/inbox/annotations/${replyId}/subthreads`, { annotation: { id: "s-1", text: "Which off switch?", quote: "off switch", quote_offset: steps.indexOf("off switch") } })).status).toBe(200);
  const messages = (await call(client, "read_thread", { thread_id: thread, format: "full", agent_session: "ses_review" })).thread.messages;
  expect((await post(server, `/api/inbox/messages/${messages.at(-1).id}/reply`, { idempotency_key: "r-2", feedback: "# Feedback on comment threads", annotation_ids: ["s-1"] })).status).toBe(200);

  await resolveComment(server, "c-msg");
  await resolveComment(server, "c-file");
  expect((await archive(server, thread)).body.comment_ids).toEqual(["s-1"]);
  await resolveComment(server, "s-1");

  // A draft reply under a resolved comment shows it open in the window: the archive waits for it too.
  expect((await post(server, "/api/inbox/annotations/c-file/replies", { annotation: { id: "d-1", text: "Wait, one more thing." } })).status).toBe(200);
  expect((await archive(server, thread)).body.comment_ids).toEqual(["c-file"]);
  await resolveComment(server, "c-file");
  expect((await archive(server, thread)).status).toBe(200);
  expect(isArchived(server, thread)).toBe(true);
});

test("on: Archive all leaves a thread with an open comment thread where it is (kept) and archives the others", async () => {
  const { project, server, client } = await world(true);
  const { thread } = await reviewed(server, client, project);
  const other = await call(client, "send_message", { project_path: project, body: "Docs are updated.", ...SESSION, agent_session: "ses_docs" });
  const projectId = server.store.message(thread)!.project_id;

  const batch = await post(server, `/api/inbox/projects/${projectId}/resolve`, { resolved: true, batch_id: "b-1" });
  expect(batch.status).toBe(200);
  expect(batch.body.batch).toMatchObject({ resolved: [other.thread_id], kept: [thread] });
  expect([isArchived(server, thread), isArchived(server, other.thread_id)]).toEqual([false, true]);
});

test("off: open comments hold nothing, for the agent, the person and Archive all", async () => {
  const { project, server, client } = await world(false);
  const sent = await call(client, "send_message", { project_path: project, body: "The plan: ship on Friday.", ...SESSION });
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words("c-off", "ship on Friday", "Not Friday.") })).status).toBe(200);
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "r-off", feedback: "# Feedback", annotation_ids: ["c-off"] })).status).toBe(200);

  expect((await call(client, "resolve_message", { message_id: sent.thread_id })).thread.resolved_at).not.toBeNull();
  await call(client, "resolve_message", { message_id: sent.thread_id, resolved: false });
  expect((await archive(server, sent.thread_id)).status).toBe(200);
  await post(server, `/api/inbox/messages/${sent.thread_id}/resolve`, { resolved: false });
  const batch = await post(server, `/api/inbox/projects/${server.store.message(sent.thread_id)!.project_id}/resolve`, { resolved: true, batch_id: "b-off" });
  expect(batch.body.batch.resolved).toEqual([sent.thread_id]);
  expect(batch.body.batch.kept).toBeUndefined();
});
