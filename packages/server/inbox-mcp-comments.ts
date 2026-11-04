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

import { inboxCommentPlace, inboxCommentThreads, type InboxCommentThread } from "@plannotator/core/inbox-comment-threads";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { clip } from "./inbox-mcp-read";

/** A comment's quote and words in the transcript, at most this many characters each. */
export const INBOX_COMMENT_QUOTE_CHARS = 160;
export const INBOX_COMMENT_TEXT_CHARS = 400;
/** A windowed read lists at most this many comments, the newest. */
export const INBOX_COMMENTS_SHOWN = 50;

/**
 * The thread's sent comments, clipped. A ranged read (`replies`: its
 * messages) keeps those its replies carried and every unanchored one, and
 * counts the others (`elsewhere`).
 */
export function threadComments(store: InboxStore, threadId: string, replies: ReadonlySet<string> | null = null): { comments: InboxCommentThread[]; elsewhere: number } {
  const messages = store.thread(threadId)?.messages ?? [];
  const all = inboxCommentThreads(messages, store.sentAnnotations(threadId));
  const comments = all
    .filter((comment) => replies === null || replies.has(comment.reply_id) || comment.unanchored)
    .map((comment) => ({ ...comment, quote: clip(comment.quote, INBOX_COMMENT_QUOTE_CHARS), text: clip(comment.text, INBOX_COMMENT_TEXT_CHARS) }));
  return { comments, elsewhere: all.length - comments.length };
}

/** The comments as lines of the transcript: none when the read has none to show. */
export function threadCommentsText({ comments, elsewhere }: { comments: readonly InboxCommentThread[]; elsewhere: number }, root: string): string[] {
  if (comments.length === 0) return elsewhere > 0 ? [`Comments the person sent: ${elsewhere} from other rounds; read_thread without after or before lists them.`] : [];
  const shown = comments.slice(-INBOX_COMMENTS_SHOWN);
  const notes = [
    ...(shown.length < comments.length ? [`the ${shown.length} newest of ${comments.length}; read_thread format: "full" lists every one`] : [`${comments.length}`]),
    ...(elsewhere > 0 ? [`${elsewhere} more from other rounds: read_thread without after or before lists them`] : []),
  ];
  const head = `Comments the person sent (${notes.join("; ")}):`;
  return [
    head,
    ...shown.map((c) =>
      [
        `- ${c.id}`,
        `round ${c.round} (reply ${c.reply_id})`,
        c.state,
        inboxCommentPlace(c.on, root),
        ...(c.unanchored ? ["unanchored: its words were not in the file when the person last opened it"] : []),
        `${JSON.stringify(c.quote)} → ${JSON.stringify(c.text)}`,
      ].join(" · "),
    ),
  ];
}
