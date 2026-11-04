/**
 * The feedback a Send wrote after the person's own words, as the window draws
 * it (the owner's ask, 2026-10-31: "Is there a reason the inline comments
 * appear like so big? Like a header? … A little smaller would be nice.").
 *
 * A Send carries the person's comments as Plannotator's feedback text
 * (`attachmentFeedback`): "# Feedback on your messages", "# Feedback on the
 * attached files" and "# Feedback on the guided review", each with `##` file
 * or message headings and `###` comments; with experimental
 * "persistent-comments", the person's replies under their sent comments go
 * under "# Feedback on comment threads", and a reply also sends the comments
 * still open under "# Feedback on comments still open"
 * (packages/core/inbox-comment-threads.ts).
 * That text is what the agent gets and it is kept as it is. When the window draws the person's own reply, the
 * feedback is drawn as a block of its own (`[data-reply-feedback]` in
 * `MessageBody`), whose headings inbox.css sets at text size, so it reads as
 * part of the reply and not as page headings. Display only: an agent's
 * message, and every other surface, draws its headings as before.
 */
import { INBOX_COMMENT_REPLIES_TITLE, INBOX_OPEN_COMMENTS_TITLE } from '@plannotator/core/inbox-comment-threads';
import { ATTACHMENT_FEEDBACK_HEADING, GUIDE_FEEDBACK_TITLE, MESSAGE_FEEDBACK_HEADING } from './attachments';

/** The headings the export opens each feedback section with. */
const FEEDBACK_HEADINGS = new Set([MESSAGE_FEEDBACK_HEADING.title, ATTACHMENT_FEEDBACK_HEADING.title, GUIDE_FEEDBACK_TITLE, INBOX_COMMENT_REPLIES_TITLE, INBOX_OPEN_COMMENTS_TITLE].map((title) => `# ${title}`));
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** The lines that open a feedback section: its heading on a line of its own, after a blank line, outside code fences. */
function feedbackHeadingLines(lines: readonly string[]): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const opener = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener) {
      fence = opener;
      continue;
    }
    if (!FEEDBACK_HEADINGS.has(line.trimEnd())) continue;
    if (index > 0 && lines[index - 1]!.trim() !== '') continue;
    out.push(index);
  }
  return out;
}

/**
 * The person's words and the feedback after them: split at the first
 * feedback section heading (on a line of its own, after a blank line, outside
 * code fences), or null when the text has none.
 */
export function splitReplyFeedback(text: string): { words: string; feedback: string } | null {
  if (!text.includes('# Feedback on ')) return null;
  const lines = text.split('\n');
  const index = feedbackHeadingLines(lines)[0];
  if (index === undefined) return null;
  return { words: lines.slice(0, index).join('\n').trim(), feedback: lines.slice(index).join('\n').trim() };
}

/**
 * The feedback in its sections, in order: each one's title (its heading's
 * words, "Feedback on the guided review") and its text, heading included.
 * Text before the first heading, if any, comes first with the title ''.
 */
export function feedbackSections(feedback: string): { title: string; text: string }[] {
  const lines = feedback.split('\n');
  const starts = feedbackHeadingLines(lines);
  const out: { title: string; text: string }[] = [];
  const head = lines.slice(0, starts[0] ?? lines.length).join('\n').trim();
  if (head) out.push({ title: '', text: head });
  starts.forEach((start, index) => {
    out.push({ title: lines[start]!.trimEnd().slice(2), text: lines.slice(start, starts[index + 1] ?? lines.length).join('\n').trim() });
  });
  return out;
}
