/**
 * The comments the person sent (experimental "persistent-comments"), as
 * agents reach them:
 *
 *  - read_thread's comments: the comments the person sent in a thread, each
 *    named by the id their feedback gave it, with its round, where it is,
 *    whether its words are gone from the file, its state and the replies
 *    under it (each with its author and round), as lines of the transcript
 *    and as a list (`InboxCommentThread`, packages/core/inbox-comment-threads.ts).
 *    Quotes, comments and replies are clipped: the person's reply that
 *    carried each one (`reply`) has it whole.
 *  - send_message's `comment_replies`: with its message, the agent's reply
 *    under each comment, by the comment's id, whoever wrote it. Nothing
 *    resolves or removes one: only the person does. A field, not an action
 *    of its own: the agent tool's description has no room left for one under
 *    Claude Code's 2,048 characters (with the Board and steps on), and the
 *    message is how the round ends, as crit's agent ends its round. Served
 *    only while the person has the switch on.
 */

import * as z from "zod";
import { inboxStoredAgentName } from "@plannotator/core/inbox-format";
import { inboxAgentName } from "@plannotator/core/inbox-types";
import { INBOX_COMMENT_REPLY_TEXT_MAX, inboxCommentPlace, inboxCommentReplyText, inboxCommentThreads, type InboxCommentReply, type InboxCommentThread } from "@plannotator/core/inbox-comment-threads";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { clip } from "./inbox-mcp-read";

/** A comment's quote and words in the transcript, at most this many characters each. */
export const INBOX_COMMENT_QUOTE_CHARS = 160;
export const INBOX_COMMENT_TEXT_CHARS = 400;
/** A windowed read lists at most this many comments, the newest. */
export const INBOX_COMMENTS_SHOWN = 50;

/**
 * The thread's sent comments, clipped, with the replies under them. A ranged
 * read (`replies`: its messages) keeps those its replies carried, those with
 * a reply that came with one of its messages, and every unanchored one, and
 * counts the others (`elsewhere`).
 */
export function threadComments(store: InboxStore, threadId: string, replies: ReadonlySet<string> | null = null): { comments: InboxCommentThread[]; elsewhere: number } {
  const messages = store.thread(threadId)?.messages ?? [];
  const all = inboxCommentThreads(messages, store.sentAnnotations(threadId), store.commentReplies(threadId));
  const comments = all
    .filter((comment) => replies === null || replies.has(comment.reply_id) || comment.unanchored || comment.replies.some((reply) => replies.has(reply.message_id)))
    .map((comment) => ({
      ...comment,
      quote: clip(comment.quote, INBOX_COMMENT_QUOTE_CHARS),
      text: clip(comment.text, INBOX_COMMENT_TEXT_CHARS),
      replies: comment.replies.map((reply) => ({ ...reply, text: clip(reply.text, INBOX_COMMENT_TEXT_CHARS) })),
    }));
  return { comments, elsewhere: all.length - comments.length };
}

/** Who wrote a reply, as its reader reads it: the person, you (the reader's own session), or the agent by name. */
function replyAuthor(reply: InboxCommentReply, reader: string | null): string {
  if (reply.author.kind === "person") return "the person";
  if (reader !== null && reply.author.session === reader) return "you";
  return reply.author.session ? `${inboxAgentName(reply.author)} (${reply.author.session})` : inboxAgentName(reply.author);
}

/** The comments as lines of the transcript, each reply indented under its comment: none when the read has none to show. */
export function threadCommentsText({ comments, elsewhere }: { comments: readonly InboxCommentThread[]; elsewhere: number }, root: string, reader: string | null = null): string[] {
  if (comments.length === 0) return elsewhere > 0 ? [`Comments the person sent: ${elsewhere} from other rounds; read_thread without after or before lists them.`] : [];
  const shown = comments.slice(-INBOX_COMMENTS_SHOWN);
  const notes = [
    ...(shown.length < comments.length ? [`the ${shown.length} newest of ${comments.length}; read_thread format: "full" lists every one`] : [`${comments.length}`]),
    ...(elsewhere > 0 ? [`${elsewhere} more from other rounds: read_thread without after or before lists them`] : []),
  ];
  const head = `Comments the person sent (${notes.join("; ")}):`;
  return [
    head,
    ...shown.flatMap((c) => [
      [
        `- ${c.id}`,
        `round ${c.round} (reply ${c.reply_id})`,
        c.state,
        inboxCommentPlace(c.on, root),
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
  'With this message, your reply under each comment the person sent: `[{ "comment_id": "…", "text": "…" }]`, one per comment. comment_id is the `(id …)` ending the comment\'s heading in their reply (read_thread lists them too; the id of a reply under a comment answers that comment). Each text shows under its comment: what you changed for it, your answer, or why you did not do it; keep `body` to the round\'s summary. Send with reply_to into their thread. Only the person resolves a comment.';

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
 * comment), with words. A refusal names the entry.
 */
export function planCommentReplies(store: InboxStore, replies: readonly { comment_id: string; text: string }[] | undefined, replyTo: string | undefined): { comment: string; text: string }[] {
  if (!replies || replies.length === 0) return [];
  const thread = replyTo ? store.message(replyTo)?.thread_id : undefined;
  if (!thread) throw new InboxError("validation_error", "comment_replies: send with reply_to into the thread of the comments.", { field: "comment_replies" });
  return replies.map((reply, index) => {
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
    if (comment.thread_id !== thread) {
      throw new InboxError("validation_error", `${field}.comment_id: ${reply.comment_id} is in thread ${comment.thread_id}, not the one reply_to lands in (${thread}).`, { field });
    }
    return { comment: comment.id, text };
  });
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
  const from = { kind: "agent" as const, host: input.agent_host?.trim() || null, session: input.agent_session?.trim() || null, name: inboxStoredAgentName(input.agent_name) };
  const fresh = planned.slice(written.length).map(({ comment, text }) => store.replyToComment(comment, { text, from, message_id: sent.message_id }));
  return [...written, ...fresh].map((reply) => ({ reply_id: reply.id, comment_id: reply.re }));
}
