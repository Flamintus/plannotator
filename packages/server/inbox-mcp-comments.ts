/**
 * read_thread's comments (experimental "persistent-comments"): the comments
 * the person sent in a thread, each named by the id their feedback gave it,
 * with its round, where it is, whether its words are gone from the file, and
 * its state, as lines of the transcript and as a list
 * (`InboxCommentThread`, packages/core/inbox-comment-threads.ts).
 *
 * Quotes and comments are clipped: the person's reply that carried each one
 * (`reply`) has it whole.
 */

import { formatInboxVideoTime } from "@plannotator/core/inbox-types";
import { inboxCommentThreads, type InboxCommentAnchor, type InboxCommentThread } from "@plannotator/core/inbox-comment-threads";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { clip } from "./inbox-mcp-read";

/** A comment's quote and words in the transcript, at most this many characters each. */
export const INBOX_COMMENT_QUOTE_CHARS = 160;
export const INBOX_COMMENT_TEXT_CHARS = 400;
/** A windowed read lists at most this many comments, the newest. */
export const INBOX_COMMENTS_SHOWN = 50;

/** The thread's sent comments, clipped; `replies` (a ranged read's messages) keeps those sent in range. */
export function threadComments(store: InboxStore, threadId: string, replies: ReadonlySet<string> | null = null): InboxCommentThread[] {
  const messages = store.thread(threadId)?.messages ?? [];
  return inboxCommentThreads(messages, store.sentAnnotations(threadId))
    .filter((comment) => replies === null || replies.has(comment.reply_id))
    .map((comment) => ({ ...comment, quote: clip(comment.quote, INBOX_COMMENT_QUOTE_CHARS), text: clip(comment.text, INBOX_COMMENT_TEXT_CHARS) }));
}

function shownPath(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`) ? path.slice(base.length + 1) : path;
}

function where(on: InboxCommentAnchor, root: string): string {
  if (on.kind === "message") return `on message ${on.message_id}`;
  const lines = (range: [number, number]) => (range[0] === range[1] ? `line ${range[0]}` : `lines ${range[0]}-${range[1]}`);
  if (on.kind === "guide") return `on the guided review in ${on.message_id}, ${on.file} (${on.side}) ${lines(on.lines)}`;
  const parts = [`on ${shownPath(on.path, root)}${on.version === "sent" ? " (the version you sent)" : ""}`];
  if (on.lines) parts.push(lines(on.lines));
  if (on.at !== undefined) parts.push(`at ${formatInboxVideoTime(on.at)}`);
  return parts.join(" ");
}

/** The comments as lines of the transcript: none when the thread has none. */
export function threadCommentsText(comments: readonly InboxCommentThread[], root: string): string[] {
  if (comments.length === 0) return [];
  const shown = comments.slice(-INBOX_COMMENTS_SHOWN);
  const head =
    shown.length < comments.length
      ? `Comments the person sent (the ${shown.length} newest of ${comments.length}; read_thread format: "full" lists every one):`
      : `Comments the person sent (${comments.length}):`;
  return [
    head,
    ...shown.map((c) =>
      [
        `- ${c.id}`,
        `round ${c.round} (reply ${c.reply_id})`,
        c.state,
        where(c.on, root),
        ...(c.unanchored ? ["unanchored: its words were not in the file when the person last opened it"] : []),
        `${JSON.stringify(c.quote)} → ${JSON.stringify(c.text)}`,
      ].join(" · "),
    ),
  ];
}
