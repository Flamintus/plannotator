/**
 * Replies under the person's sent comments (experimental
 * "persistent-comments"), proved through the server's real doors: a running
 * Inbox on loopback, the MCP SDK client for the agent (send_message's
 * `comment_replies`, read_thread) and `fetch` for the window. Each test has
 * its own temp data dir. The rules (rounds of replies, reopening) are proved
 * in packages/core/inbox-comment-threads.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from "@plannotator/core/inbox-types";
import { inboxAgentTool, parseInboxToolList } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { COMMENT_REPLIES_DESCRIPTION } from "./inbox-mcp";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-comment-replies-")));
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
  const client = new Client({ name: "inbox-comment-replies-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

async function raw(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; structured: Record<string, any> }> {
  const result = await raw(client, name, args);
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

function post(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function files(server: InboxServer, threadId: string): Promise<{ annotations: InboxAnnotationRecord[]; sent_comments?: InboxAnnotationRecord[]; comment_replies?: InboxCommentReplyRecord[] }> {
  return (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}/attachments`)).json()) as never;
}

const SESSION = { agent_session: "ses_review", agent_name: "Claude Code", agent_host: "claude-code" };
const READER = { agent_session: "ses_review" };

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

async function messageCount(client: Client, threadId: string): Promise<number> {
  return (await call(client, "read_thread", { thread_id: threadId, format: "full", ...READER })).structured.thread.messages.length;
}

test("off: send_message takes no comment_replies, and the person's reply route is refused", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, false);
  const client = await agent(server);
  const send = (await client.listTools()).tools.find((tool) => tool.name === "send_message")!;
  expect(Object.keys((send.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain("comment_replies");
  // Off, a message still needs its body.
  expect((send.inputSchema as { required?: string[] }).required).toContain("body");
  const { sent, replyId } = await roundOne(server, client, project);
  const refused = await raw(client, "send_message", { project_path: project, body: "Done.", reply_to: replyId, comment_replies: [{ comment_id: "c-msg", text: "Done." }], ...SESSION });
  expect(refused.isError).toBe(true);
  expect(await messageCount(client, sent.thread_id)).toBe(2);
  const reply = await post(server, "/api/inbox/annotations/c-msg/replies", { annotation: { id: "r-off", text: "Tuesday?" } });
  expect([reply.status, ((await reply.json()) as { code: string }).code]).toEqual([409, "persistent_comments_off"]);
});

test("on: the agent's message carries a reply under each comment; the window lists them, read_thread shows each under its comment", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);

  const answer = await call(client, "send_message", {
    project_path: project,
    body: "Round 1 done.",
    reply_to: replyId,
    comment_replies: [
      { comment_id: "c-msg", text: "One store first: Lyon, for a week." },
      { comment_id: "c-file", text: "Moved it to Tuesday in notes.md." },
    ],
    ...SESSION,
  });
  expect(answer.structured.comment_replies.map((r: { comment_id: string }) => r.comment_id)).toEqual(["c-msg", "c-file"]);

  // The window: each reply under its comment, by the agent's session; nothing changes the comment itself.
  const model = await files(server, sent.thread_id);
  expect(model.comment_replies!.map((r) => [r.re, r.from.session, r.text])).toEqual([
    ["c-msg", "ses_review", "One store first: Lyon, for a week."],
    ["c-file", "ses_review", "Moved it to Tuesday in notes.md."],
  ]);
  expect(model.sent_comments!.every((r) => r.resolved_at == null)).toBe(true);

  // read_thread: under each comment, with its author and round; "you" for the reader's own session.
  const read = await call(client, "read_thread", { thread_id: sent.thread_id, ...READER });
  const byId = new Map(read.structured.comments.map((c: { id: string }) => [c.id, c]));
  expect((byId.get("c-msg") as { replies: unknown[] }).replies).toEqual([
    expect.objectContaining({ author: expect.objectContaining({ kind: "agent", session: "ses_review", name: "Claude Code" }), round: 1, text: "One store first: Lyon, for a week." }),
  ]);
  const lines = read.text.split("\n");
  const at = lines.findIndex((line) => line.startsWith("- c-msg "));
  expect(lines[at + 1]).toMatch(/^ {2}- reply rep_\w+ · round 1 · you: "One store first: Lyon, for a week\."$/);
  const other = await call(client, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_other" });
  expect(other.text).toContain('· Claude Code (ses_review): "Moved it to Tuesday in notes.md."');
});

// What regresses: an agent that only answers under comments has to write a body nobody needs, which fills the thread
// (the window draws a message with none as one line, roundLines.ts); or a send with neither lands an empty message.
test("on: replies alone are a message with no body; with neither a body nor replies nothing is sent", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);
  const send = (await client.listTools()).tools.find((tool) => tool.name === "send_message")!;
  expect((send.inputSchema as { required?: string[] }).required ?? []).not.toContain("body");

  const answer = await call(client, "send_message", { reply_to: replyId, comment_replies: [{ comment_id: "c-msg", text: "Lyon first, for a week." }], ...SESSION });
  const landed = (await call(client, "read_thread", { thread_id: sent.thread_id, format: "full", ...READER })).structured.thread.messages.at(-1);
  expect([landed.id, landed.body]).toEqual([answer.structured.message_id, ""]);
  expect((await files(server, sent.thread_id)).comment_replies!.map((r) => [r.re, r.message_id])).toEqual([["c-msg", answer.structured.message_id]]);
  // A blank body with replies is no body either.
  const blank = await call(client, "send_message", { reply_to: replyId, body: "  \n", comment_replies: [{ comment_id: "c-file", text: "Tuesday now." }], ...SESSION });
  expect((await call(client, "read_thread", { thread_id: sent.thread_id, format: "full", ...READER })).structured.thread.messages.at(-1)).toMatchObject({ id: blank.structured.message_id, body: "" });

  for (const body of [undefined, "  "]) {
    const refused = await raw(client, "send_message", { reply_to: replyId, ...(body === undefined ? {} : { body }), comment_replies: [], ...SESSION });
    expect([refused.isError, refused.content[0]!.text]).toEqual([true, expect.stringContaining("body")]);
  }
  expect(await messageCount(client, sent.thread_id)).toBe(4);
});

test("a reply's id answers its comment; a draft, an unknown id or another thread's comment refuses the whole send", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);
  const other = (await call(client, "send_message", { project_path: project, thread: "other work", body: "Something else.", ...SESSION })).structured;
  expect((await post(server, `/api/inbox/messages/${other.message_id}/annotations`, { annotation: words("c-else", "Something", "Elsewhere.") })).status).toBe(200);
  expect((await post(server, `/api/inbox/messages/${other.message_id}/reply`, { idempotency_key: "r-else", feedback: "# Feedback", annotation_ids: ["c-else"] })).status).toBe(200);
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words("c-draft", "Friday", "Not then.") })).status).toBe(200);
  const before = await messageCount(client, sent.thread_id);

  for (const [comment_id, code] of [
    ["c-draft", "annotation_not_sent"],
    ["c-none", "annotation_not_found"],
    ["c-else", "validation_error"],
  ] as const) {
    const refused = await raw(client, "send_message", { project_path: project, body: "Done.", reply_to: replyId, comment_replies: [{ comment_id: "c-msg", text: "Fine." }, { comment_id, text: "Fine." }], ...SESSION });
    expect([comment_id, refused.isError, refused.content[0]!.text.startsWith(`${code}: comment_replies[1].comment_id`)]).toEqual([comment_id, true, true]);
  }
  // Without reply_to, the thread is not known yet: refused too.
  expect((await raw(client, "send_message", { project_path: project, body: "Done.", comment_replies: [{ comment_id: "c-msg", text: "Fine." }], ...SESSION })).isError).toBe(true);
  expect(await messageCount(client, sent.thread_id)).toBe(before);
  expect((await files(server, sent.thread_id)).comment_replies).toEqual([]);

  // An agent's reply id, a second time, goes under the same comment.
  const first = (await call(client, "send_message", { project_path: project, body: "Done.", reply_to: replyId, comment_replies: [{ comment_id: "c-msg", text: "Lyon first." }], ...SESSION })).structured;
  const again = (await call(client, "send_message", { project_path: project, body: "More.", reply_to: replyId, comment_replies: [{ comment_id: first.comment_replies[0].reply_id, text: "And Paris after." }], ...SESSION })).structured;
  expect(again.comment_replies[0].comment_id).toBe("c-msg");
});

test("a retry of the send answers with the replies the first call wrote, writes those it did not get to, and refuses other ones", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);
  const send = (key: string, comment_replies: { comment_id: string; text: string }[]) => ({ project_path: project, body: "Done.", reply_to: replyId, idempotency_key: key, comment_replies, ...SESSION });
  const stored = async () => (await files(server, sent.thread_id)).comment_replies!.map((r) => [r.re, r.text]);

  const first = (await call(client, "send_message", send("k-1", [{ comment_id: "c-file", text: "Tuesday." }]))).structured;
  const again = await call(client, "send_message", send("k-1", [{ comment_id: "c-file", text: "Tuesday." }]));
  expect(again.structured.comment_replies).toEqual(first.comment_replies);
  expect(await stored()).toEqual([["c-file", "Tuesday."]]);
  // Other replies under the same key: refused, nothing written.
  const other = await raw(client, "send_message", send("k-1", [{ comment_id: "c-file", text: "Wednesday." }]));
  expect([other.isError, other.content[0]!.text.startsWith("idempotency_key_reused:")]).toEqual([true, true]);
  // A first call that wrote its message but not its replies (the process stopped between): the retry writes them, once.
  await call(client, "send_message", send("k-2", []));
  const written = (await call(client, "send_message", send("k-2", [{ comment_id: "c-msg", text: "Lyon first." }]))).structured;
  expect(written.comment_replies.map((r: { comment_id: string }) => r.comment_id)).toEqual(["c-msg"]);
  await call(client, "send_message", send("k-2", [{ comment_id: "c-msg", text: "Lyon first." }]));
  expect(await stored()).toEqual([
    ["c-file", "Tuesday."],
    ["c-msg", "Lyon first."],
  ]);
  // Each reply names the message it came with.
  expect((await files(server, sent.thread_id)).comment_replies!.map((r) => r.message_id)).toEqual([first.message_id, written.message_id]);
});

test("a ranged read_thread keeps an older comment with a reply that came with one of its messages", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);
  const cursor = (await call(client, "read_thread", { thread_id: sent.thread_id, ...READER })).structured.cursor as number;
  await call(client, "send_message", { project_path: project, body: "Done.", reply_to: replyId, comment_replies: [{ comment_id: "c-file", text: "Tuesday." }], ...SESSION });
  const ranged = await call(client, "read_thread", { thread_id: sent.thread_id, after: cursor, ...READER });
  expect(ranged.structured.comments.map((c: { id: string }) => c.id)).toEqual(["c-file"]);
  expect(ranged.text).toContain('· you: "Tuesday."');
});

test("the person's reply under a sent comment is a draft until the next Send carries it, and an edit keeps it a reply", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);
  await call(client, "send_message", { project_path: project, body: "Done.", reply_to: replyId, comment_replies: [{ comment_id: "c-msg", text: "Lyon first?" }], ...SESSION });

  const saved = await post(server, "/api/inbox/annotations/c-msg/replies", { annotation: { id: "r-person", text: "Yes, Lyon." } });
  expect(saved.status).toBe(200);
  const draft = ((await saved.json()) as { annotation: InboxAnnotationRecord }).annotation;
  // Its place is the comment's: the same message and words, threaded under it.
  expect(draft).toMatchObject({ re: "c-msg", message_id: sent.message_id, sent_reply_id: null, annotation: { inReplyTo: "c-msg", originalText: "all stores at once", text: "Yes, Lyon." } });
  // The window's list saves an edit through the comment's own route: it stays a reply.
  const edited = await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: { ...draft.annotation, text: "Yes, Lyon, for a week." } });
  expect(edited.status).toBe(200);
  expect(((await edited.json()) as { annotation: InboxAnnotationRecord }).annotation).toMatchObject({ re: "c-msg", annotation: { text: "Yes, Lyon, for a week." } });
  expect((await files(server, sent.thread_id)).annotations.map((r) => r.id)).toEqual(["r-person"]);
  // A draft is not read by the agent yet.
  expect((await call(client, "read_thread", { thread_id: sent.thread_id, ...READER })).text).not.toContain("Yes, Lyon");

  // No reply under a draft, or under a comment that does not exist.
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/annotations`, { annotation: words("c-draft", "Friday", "Not then.") })).status).toBe(200);
  const underDraft = await post(server, "/api/inbox/annotations/c-draft/replies", { annotation: { id: "r-2", text: "?" } });
  expect([underDraft.status, ((await underDraft.json()) as { code: string }).code]).toEqual([409, "annotation_not_sent"]);
  expect((await post(server, "/api/inbox/annotations/c-msg/replies", { annotation: { id: "r-3", text: "  " } })).status).toBe(422);

  // The Send carries it: round 2, by the person, under its comment.
  const messages = (await call(client, "read_thread", { thread_id: sent.thread_id, format: "full", ...READER })).structured.thread.messages;
  const reply = await post(server, `/api/inbox/messages/${messages.at(-1).id}/reply`, { idempotency_key: "r-2", feedback: "# Feedback on comment threads", annotation_ids: ["r-person"] });
  expect(reply.status).toBe(200);
  const read = await call(client, "read_thread", { thread_id: sent.thread_id, ...READER });
  const comment = read.structured.comments.find((c: { id: string }) => c.id === "c-msg");
  // Each with its author and round (two written in the same millisecond keep no order of their own).
  expect(comment.replies.map((r: { author: { kind: string }; round: number; text: string }) => [r.author.kind, r.round, r.text]).sort()).toEqual([
    ["agent", 1, "Lyon first?"],
    ["person", 2, "Yes, Lyon, for a week."],
  ]);
  // A reply is not a comment of its own.
  expect(read.structured.comments.map((c: { id: string }) => c.id).sort()).toEqual(["c-file", "c-msg"]);
});

test("a reply opens a resolved comment again, and Resolve closes it again", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);
  const state = async (id: string) => (await call(client, "read_thread", { thread_id: sent.thread_id, ...READER })).structured.comments.find((c: { id: string }) => c.id === id).state;

  expect((await post(server, "/api/inbox/annotations/c-msg/resolve", { resolved: true })).status).toBe(200);
  expect(await state("c-msg")).toBe("resolved");
  // Newer than the resolution (the clock moves on between the two).
  await Bun.sleep(2);
  await call(client, "send_message", { project_path: project, body: "One more word.", reply_to: replyId, comment_replies: [{ comment_id: "c-msg", text: "Lyon is closed on Mondays." }], ...SESSION });
  expect(await state("c-msg")).toBe("open");
  // The press resolves it anew (the reply is older than this resolution), and a reply is resolved with its comment only.
  const pressed = await post(server, "/api/inbox/annotations/c-msg/resolve", { resolved: true });
  expect(pressed.status).toBe(200);
  expect(await state("c-msg")).toBe("resolved");

  // The person's draft reply under a resolved comment shows it open in the window; Resolve then writes again.
  expect((await post(server, "/api/inbox/annotations/c-file/resolve", { resolved: true })).status).toBe(200);
  await Bun.sleep(2);
  expect((await post(server, "/api/inbox/annotations/c-file/replies", { annotation: { id: "r-again", text: "Still Friday?" } })).status).toBe(200);
  const first = ((await files(server, sent.thread_id)).sent_comments!.find((r) => r.id === "c-file")!).resolved_at!;
  await Bun.sleep(2);
  const again = await post(server, "/api/inbox/annotations/c-file/resolve", { resolved: true });
  expect(((await again.json()) as { annotation: InboxAnnotationRecord }).annotation.resolved_at! > first).toBe(true);
  const onReply = await post(server, "/api/inbox/annotations/r-again/resolve", { resolved: true });
  expect(onReply.status).toBe(422);
});

test("an agent's reply holds across a restart, and deleting the thread takes it", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir, true);
  const client = await agent(server);
  const { sent, replyId } = await roundOne(server, client, project);
  await call(client, "send_message", { project_path: project, body: "Done.", reply_to: replyId, comment_replies: [{ comment_id: "c-file", text: "Tuesday." }], ...SESSION });
  const projectDir = join(dataDir, "inbox", "projects", readdirSync(join(dataDir, "inbox", "projects"))[0]!);
  expect(readFileSync(join(projectDir, "comment-replies.jsonl"), "utf8")).toContain('"kind":"comment_reply"');

  server.stop();
  servers.splice(servers.indexOf(server), 1);
  const again = await start(dataDir, true);
  expect((await files(again, sent.thread_id)).comment_replies!.map((r) => r.text)).toEqual(["Tuesday."]);
  expect((await post(again, `/api/inbox/threads/${sent.thread_id}/delete`, {})).status).toBe(200);
  expect(readFileSync(join(projectDir, "comment-replies.jsonl"), "utf8")).toBe("");
});

// What regresses: Claude Code cuts the agent tool's description at 2,048 characters (with the Board and steps on,
// no action line fits), which would drop the wake note and the help pointer at its end. The replies ride a field, whose
// description reaches the model whole: the description stays exactly as it is.
test("on, the agent tool's description is unchanged: the replies are a send_message field, described on the field", async () => {
  const described = async (persistentComments: boolean) => {
    const { dataDir } = world();
    const server = await startInboxServer({ dataDir, persistentComments, board: true, steps: true });
    servers.push(server);
    return inboxAgentTool(parseInboxToolList(await (await agent(server)).listTools()))!;
  };
  const [off, on] = [await described(false), await described(true)];
  expect(on.description).toBe(off.description);
  expect(on.description.length).toBeLessThan(2_048);
  const field = (on.inputSchema.properties as Record<string, { description: string }>).comment_replies!;
  expect(field.description).toBe(`(send_message) ${COMMENT_REPLIES_DESCRIPTION}`);
  expect((off.inputSchema.properties as Record<string, unknown>).comment_replies).toBeUndefined();
});
