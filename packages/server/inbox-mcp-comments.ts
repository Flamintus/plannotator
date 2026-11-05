/**
 * The comments the person sent (experimental "persistent-comments"), as
 * agents reach them:
 *
 *  - read_thread's comments: the comments the person sent in a thread, each
 *    named by the id their feedback gave it, with its round, where it is,
 *    whether its words are gone from the file, its state and the replies
 *    under it (each with its author and round), as lines of the transcript
 *    and as a list (`InboxCommentThread`, packages/core/inbox-comment-threads.ts).
 *    A sub-thread names the message whose passage it is on and gives the
 *    words around the passage, so the agent never has to look them up.
 *    Quotes, comments and replies are clipped: the person's reply that
 *    carried each one (`reply`) has it whole. A comment a comment send
 *    carried (inbox-comment-sends.ts) names that send instead (`send`), and
 *    the list says whether the round it went in is still open.
 *  - send_message's `comment_replies`: the agent's reply under each comment,
 *    by the comment's id, whoever wrote it, with its message or alone: with
 *    no body, no message is written in the thread, which keeps the
 *    conversation's own messages only, and the person is told of the replies
 *    (the row unread, one notification per call). Nothing resolves or
 *    removes one: only the person does. A field, not an action of its own:
 *    the agent tool's description has no room left for one under Claude
 *    Code's 2,048 characters (with the Board and steps on). Served only while
 *    the person has the switch on.
 */

import * as z from "zod";
import { inboxStoredAgentName } from "@plannotator/core/inbox-format";
import { inboxAgentName, type InboxCommentReplyRecord } from "@plannotator/core/inbox-types";
import { isInboxCommentSendId, type InboxCommentSend } from "@plannotator/core/inbox-comment-sends";
import {
  INBOX_COMMENT_REPLY_TEXT_MAX,
  inboxCommentReplyCallId,
  inboxCommentReplyText,
  inboxCommentThreadPlace,
  inboxCommentThreads,
  inboxSubThreadWindow,
  type InboxCommentReply,
  type InboxCommentThread,
} from "@plannotator/core/inbox-comment-threads";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { clip } from "./inbox-mcp-read";

/** A comment's quote and words in the transcript, at most this many characters each. */
export const INBOX_COMMENT_QUOTE_CHARS = 160;
export const INBOX_COMMENT_TEXT_CHARS = 400;
/** A windowed read lists at most this many comments, the newest. */
export const INBOX_COMMENTS_SHOWN = 50;

/**
 * The comment sends a read covers, by id: those written inside its range of
 * seqs (`after`, `before`; every one without a bound), as its messages are.
 * The agents' replies sent alone in that range too, which no message of the
 * range carried.
 */
export function commentSendsShown(store: InboxStore, threadId: string, range: { after: number | null; before: number | null } = { after: null, before: null }): Set<string> {
  const inRange = (seq: number) => (range.after === null || seq > range.after) && (range.before === null || seq < range.before);
  const alone = store.commentReplies(threadId).filter((reply) => reply.call && inRange(store.commentReplyCursor(reply.id) ?? 0));
  return new Set([...store.commentSends(threadId).filter((send) => inRange(store.commentSendCursor(send.id) ?? 0)).map((send) => send.id), ...alone.map((reply) => reply.id)]);
}

/** What read_thread says of a comment send: never its delivery, which is the person's to see. */
export type InboxCommentSendRead = Pick<InboxCommentSend, "id" | "round" | "mode" | "to" | "comments" | "with_message" | "created_at">;

/**
 * The thread's sent comments, clipped, with the replies under them. A ranged
 * read (`replies`: its messages, its comment sends and the replies sent alone
 * in it, commentSendsShown) keeps those its replies or sends carried, those a
 * Finish among its sends named, those with a reply that came with one of
 * them or alone in it, and every unanchored one, and counts the others (`elsewhere`). `sends`: the comment sends among
 * them (all of the thread's for a read without a range).
 */
export function threadComments(
  store: InboxStore,
  threadId: string,
  replies: ReadonlySet<string> | null = null,
): { comments: InboxCommentThread[]; elsewhere: number; sends: InboxCommentSendRead[] } {
  const messages = store.thread(threadId)?.messages ?? [];
  const thread = store.commentSends(threadId);
  const all = inboxCommentThreads(messages, store.sentAnnotations(threadId), store.commentReplies(threadId), thread);
  const sends = thread.filter((send) => replies === null || replies.has(send.id));
  const named = new Set(sends.flatMap((send) => send.comments));
  const comments = all
    .filter((comment) => replies === null || replies.has(comment.reply_id) || named.has(comment.id) || comment.unanchored || comment.replies.some((reply) => replies.has(reply.message_id) || replies.has(reply.id)))
    .map((comment) => {
      // A sub-thread's parent: the words around the passage and its offset there (computed before the quote is clipped).
      const around = inboxSubThreadWindow(comment, INBOX_COMMENT_TEXT_CHARS);
      return {
        ...comment,
        quote: clip(comment.quote, INBOX_COMMENT_QUOTE_CHARS),
        text: clip(comment.text, INBOX_COMMENT_TEXT_CHARS),
        replies: comment.replies.map((reply) => ({ ...reply, text: clip(reply.text, INBOX_COMMENT_TEXT_CHARS) })),
        ...(comment.parent ? { parent: { ...comment.parent, ...(around !== null ? { text: around.text, quote_offset: around.offset } : {}) } } : {}),
      };
    });
  return {
    comments,
    elsewhere: all.length - comments.length,
    sends: sends.map(({ id, round, mode, to, comments: carried, with_message, created_at }) => ({ id, round, mode, to, comments: carried, with_message, created_at })),
  };
}

/** Who wrote a reply, as its reader reads it: the person, you (the reader's own session), or the agent by name. */
function replyAuthor(reply: InboxCommentReply, reader: string | null): string {
  if (reply.author.kind === "person") return "the person";
  if (reader !== null && reply.author.session === reader) return "you";
  return reply.author.session ? `${inboxAgentName(reply.author)} (${reply.author.session})` : inboxAgentName(reply.author);
}

/**
 * The comments as lines of the transcript, each reply indented under its
 * comment: none when the read has none to show. After comment sends, the
 * head says whether the round of the newest is still open (the person may
 * send more) or finished.
 */
export function threadCommentsText(
  { comments, elsewhere, sends = [] }: { comments: readonly InboxCommentThread[]; elsewhere: number; sends?: readonly Pick<InboxCommentSend, "round" | "mode">[] },
  root: string,
  reader: string | null = null,
): string[] {
  if (comments.length === 0) return elsewhere > 0 ? [`Comments the person sent: ${elsewhere} from other rounds; read_thread without after or before lists them.`] : [];
  const shown = comments.slice(-INBOX_COMMENTS_SHOWN);
  const newest = sends.at(-1);
  const notes = [
    ...(shown.length < comments.length ? [`the ${shown.length} newest of ${comments.length}; read_thread format: "full" lists every one`] : [`${comments.length}`]),
    ...(newest ? [newest.mode === "now" ? `round ${newest.round} still open: the person may send more` : `round ${newest.round} finished`] : []),
    ...(elsewhere > 0 ? [`${elsewhere} more from other rounds: read_thread without after or before lists them`] : []),
  ];
  const head = `Comments the person sent (${notes.join("; ")}):`;
  return [
    head,
    ...shown.flatMap((c) => [
      [
        `- ${c.id}`,
        `round ${c.round} (${isInboxCommentSendId(c.reply_id) ? "send" : "reply"} ${c.reply_id})`,
        c.state,
        inboxCommentThreadPlace(c, root),
        ...(c.parent?.text !== undefined ? [`in ${JSON.stringify(c.parent.text)}`] : []),
        ...(c.unanchored ? ["unanchored: its words were not in the file when the person last opened it"] : []),
        `${JSON.stringify(c.quote)} → ${JSON.stringify(c.text)}`,
      ].join(" · "),
      ...c.replies.map((reply) => `  - reply ${reply.id} · round ${reply.round} · ${replyAuthor(reply, reader)}: ${JSON.stringify(reply.text)}`),
    ]),
  ];
}

/** The most replies one send_message carries. */
export const INBOX_COMMENT_REPLIES_MAX = 100;

/**
 * send_message's `comment_replies`, as an agent reads it (a field description
 * reaches the model whole; Claude Code cuts the tool's own description at
 * 2,048 characters, which an action of its own would pass).
 */
export const COMMENT_REPLIES_DESCRIPTION =
  'Your reply under each comment the person sent: `[{ "comment_id": "…", "text": "…" }]`, one per comment. comment_id is the `(id …)` ending the comment\'s heading (read_thread lists them too; the id of a reply under a comment answers that comment). Each text shows under its comment: what you changed for it, your answer, or why you did not do it. Leave `body` out when the replies say it all: nothing is posted in the thread, and the person is told. Write a body only for what is not about a comment, with reply_to into their thread. Only the person resolves a comment.';

/** The `comment_replies` field: send_message's, only while sent comments stay in view. */
export const COMMENT_REPLIES_FIELD = z
  .array(
    z
      .object({
        comment_id: z.string(),
        text: z.string().min(1).max(INBOX_COMMENT_REPLY_TEXT_MAX),
      })
      .strict(),
  )
  .max(INBOX_COMMENT_REPLIES_MAX)
  .describe(COMMENT_REPLIES_DESCRIPTION);

/**
 * The replies a send_message carries, checked before anything is sent, so a
 * message never lands without them: each under a sent comment of the thread
 * `reply_to` lands in (an id of a reply under a comment answers that
 * comment), with words. A refusal names the entry. Replies sent alone
 * (`alone`, no body) need no reply_to: they land in their first comment's
 * thread, and a reply_to may also be a comment send's id (as a wake names
 * one), which names its thread. With a message, a `key` replies sent alone
 * already have in that thread is refused, as the other way round
 * (writeCommentRepliesAlone).
 */
export function planCommentReplies(
  store: InboxStore,
  replies: readonly { comment_id: string; text: string }[] | undefined,
  replyTo: string | undefined,
  options: { alone?: boolean; key?: string } = {},
): { comment: string; text: string }[] {
  if (!replies || replies.length === 0) return [];
  const alone = options.alone === true;
  let thread = replyTo ? (store.message(replyTo)?.thread_id ?? (alone ? store.commentSend(replyTo)?.thread_id : undefined)) : undefined;
  if (!thread && (replyTo || !alone)) throw new InboxError("validation_error", "comment_replies: send with reply_to into the thread of the comments.", { field: "comment_replies" });
  const landsIn = replyTo ? "the one reply_to lands in" : "comment_replies[0]'s";
  const planned = replies.map((reply, index) => {
    const field = `comment_replies[${index}]`;
    const text = inboxCommentReplyText(reply.text);
    if (text === null) throw new InboxError("validation_error", `${field}.text: your reply, 1 to ${INBOX_COMMENT_REPLY_TEXT_MAX} characters.`, { field });
    let comment;
    try {
      comment = store.sentComment(reply.comment_id);
    } catch (error) {
      if (error instanceof InboxError) throw new InboxError(error.code, `${field}.comment_id: ${error.message} read_thread lists the comments of the thread.`, { field });
      throw error;
    }
    thread ??= comment.thread_id;
    if (comment.thread_id !== thread) {
      throw new InboxError("validation_error", `${field}.comment_id: ${reply.comment_id} is in thread ${comment.thread_id}, not ${landsIn} (${thread}).`, { field });
    }
    return { comment: comment.id, text };
  });
  const key = options.key?.trim();
  if (!alone && key && store.commentReplies(thread!).some((reply) => reply.call && reply.idempotency_key === key)) {
    throw new InboxError("idempotency_key_reused", "This idempotency_key was already used for replies sent alone.");
  }
  return planned;
}

/** What goes only with a message: refused on a send of replies alone, before anything is written. */
export function checkCommentRepliesAlone(planned: readonly unknown[], input: { attachments?: readonly string[]; supersedes?: readonly string[]; done?: readonly string[] }): void {
  if (planned.length === 0) throw new InboxError("validation_error", "body: write the message, or send comment_replies alone.", { field: "body" });
  for (const field of ["attachments", "supersedes", "done"] as const) {
    if (input[field]?.length) throw new InboxError("validation_error", `${field}: goes with a message; write a body.`, { field });
  }
}

/** The result's line for replies sent alone (writeCommentRepliesAlone), counted by comment. */
export function commentRepliesAloneLine(done: { thread_id: string; replies: readonly { comment_id: string }[]; replayed: boolean }, url: string): string {
  const comments = new Set(done.replies.map((reply) => reply.comment_id)).size;
  return `${done.replayed ? "Already replied" : "Replied"} under ${comments} comment${comments === 1 ? "" : "s"} (thread ${done.thread_id}, ${url}); the person sees each under its comment, with nothing posted in the thread.`;
}

/** The agent session that writes a send_message's replies, as a reply's `from`. */
function replyAuthorOf(input: { agent_session?: string; agent_host?: string; agent_name?: string }): InboxCommentReplyRecord["from"] {
  return { kind: "agent", host: input.agent_host?.trim() || null, session: input.agent_session?.trim() || null, name: inboxStoredAgentName(input.agent_name) };
}

/** The same agent session wrote both (its name may differ from one call to the next). */
function sameAgent(a: Pick<InboxCommentReplyRecord["from"], "host" | "session">, b: Pick<InboxCommentReplyRecord["from"], "host" | "session">): boolean {
  return a.session === b.session && a.host === b.host;
}

/**
 * Write the replies a sent message carries (planCommentReplies), as the
 * session that sent it, with that message. A replay of the send (the same
 * idempotency key) answers with the replies the first call wrote, and writes
 * those it did not get to (a process that stopped between the message and
 * them); a replay with other replies is refused, as one with another body is.
 */
export function writeCommentReplies(
  store: InboxStore,
  planned: readonly { comment: string; text: string }[],
  sent: { message_id: string; thread_id: string; replayed: boolean },
  input: { agent_session?: string; agent_host?: string; agent_name?: string },
): { reply_id: string; comment_id: string }[] {
  const written = sent.replayed ? store.commentReplies(sent.thread_id).filter((reply) => reply.message_id === sent.message_id) : [];
  if (written.length > planned.length || written.some((reply, index) => reply.re !== planned[index]!.comment || reply.text !== planned[index]!.text)) {
    throw new InboxError("idempotency_key_reused", "This idempotency_key was already used with other comment_replies.", { message_id: sent.message_id });
  }
  const from = replyAuthorOf(input);
  const fresh = planned.slice(written.length).map(({ comment, text }) => store.replyToComment(comment, { text, from, message_id: sent.message_id }));
  return [...written, ...fresh].map((reply) => ({ reply_id: reply.id, comment_id: reply.re }));
}

/**
 * Write replies sent alone (planCommentReplies with `alone`: send_message's
 * `comment_replies` with no body): no message in the thread, the replies of
 * the call sharing one `call`, by which the person is told of them once. A
 * retry under the call's idempotency key (the same session's, in that
 * thread) answers with the replies the first call wrote and writes those it
 * did not get to; one with other replies, or under a key a message of the
 * thread already has, is refused. Without a key, a reply the same session
 * already left last under its comment, word for word, with nothing from the
 * person in the thread since (a message, a comment send), is not written
 * again: that is a retry whose answer was lost. `replayed`: nothing was
 * written; `keyed`: by the key (a retry that writes nothing else either).
 */
export function writeCommentRepliesAlone(
  store: InboxStore,
  planned: readonly { comment: string; text: string }[],
  input: { idempotency_key?: string; agent_session?: string; agent_host?: string; agent_name?: string },
): { thread_id: string; replies: { reply_id: string; comment_id: string }[]; replayed: boolean; keyed: boolean } {
  const threadId = store.sentComment(planned[0]!.comment).thread_id;
  const from = replyAuthorOf(input);
  const key = input.idempotency_key?.trim() || null;
  const answer = (replies: readonly InboxCommentReplyRecord[], replayed: boolean) => ({ thread_id: threadId, replies: replies.map((reply) => ({ reply_id: reply.id, comment_id: reply.re })), replayed, keyed: key !== null });
  if (key) {
    if (store.thread(threadId)?.messages.some((message) => message.author.kind === "agent" && message.idempotency_key === key)) {
      throw new InboxError("idempotency_key_reused", "This idempotency_key was already used for a message.");
    }
    const written = store.commentReplies(threadId).filter((reply) => reply.call && reply.idempotency_key === key && sameAgent(reply.from, from));
    if (written.length > planned.length || written.some((reply, index) => reply.re !== planned[index]!.comment || reply.text !== planned[index]!.text)) {
      throw new InboxError("idempotency_key_reused", "This idempotency_key was already used with other comment_replies.");
    }
    const call = written[0]?.call ?? inboxCommentReplyCallId();
    const fresh = planned.slice(written.length).map(({ comment, text }) => store.replyToComment(comment, { text, from, call, idempotency_key: key }));
    return answer([...written, ...fresh], fresh.length === 0);
  }
  const messages = store.thread(threadId)?.messages ?? [];
  const sends = store.commentSends(threadId);
  const lastReply = new Map(inboxCommentThreads(messages, store.sentAnnotations(threadId), store.commentReplies(threadId), sends).map((comment) => [comment.id, comment.replies.at(-1)]));
  const records = new Map(store.commentReplies(threadId).map((reply) => [reply.id, reply]));
  // The person wrote since `at`: a new round, so the same words are an answer of their own.
  const personSince = (at: string) => messages.some((message) => message.author.kind === "person" && message.created_at > at) || sends.some((send) => send.created_at > at);
  const call = inboxCommentReplyCallId();
  let wrote = false;
  const replies = planned.map(({ comment, text }) => {
    const last = lastReply.get(comment);
    const repeated = last && last.author.kind === "agent" && sameAgent(last.author, from) && last.text === text && !personSince(last.at) ? records.get(last.id) : undefined;
    if (repeated) return repeated;
    wrote = true;
    return store.replyToComment(comment, { text, from, call });
  });
  return answer(replies, !wrote);
}
