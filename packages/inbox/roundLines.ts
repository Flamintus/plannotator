/**
 * The thread kept for the conversation (experimental "persistent-comments"),
 * as crit's: the comments, replies and sub-threads a Send carries live in
 * their boxes (SentComments.tsx), so in the thread the Send is the end of a
 * round, one line, and the text the agent got is there on a press
 * (components/RoundLine.tsx).
 *
 *  - A Send with nothing else (no words of the person's, no answer, action
 *    item, file, verdict or guided review comment) is that line alone:
 *    "Round 5 · 2 comments, 1 reply, 1 sub-thread sent · 4 open threads sent again".
 *  - With any of those, the message stays as it is, and the sections the
 *    boxes hold fold into the line under it.
 *  - An agent's message with no body (send_message's `comment_replies`
 *    alone) is one line, "Replied under 2 comments": its replies are in the boxes.
 *
 * Display only: the stored body and what the agent gets do not change. The
 * line's counts are read from the text the agent got, so it says what was sent.
 */

import { INBOX_COMMENT_REPLIES_TITLE, INBOX_OPEN_COMMENTS_TITLE, inboxCommentRepliesCount, inboxOpenCommentsCount } from '@plannotator/core/inbox-comment-threads';
import { splitInboxReplyBody } from '@plannotator/core/inbox-questions';
import { isInboxActionReport, isInboxNote, type InboxMessageWire } from '@plannotator/core/inbox-types';
import { withoutInboxSkillsBlock } from '@plannotator/core/skill-reference-block';
import { ATTACHMENT_FEEDBACK_HEADING, MESSAGE_FEEDBACK_HEADING } from './attachments';
import { feedbackSections, splitReplyFeedback } from './replyFeedback';

/**
 * The feedback sections whose every entry lives in a box: comments on agents'
 * messages and on files, replies and sub-threads, the open comments sent
 * again. A guided review's comments are drawn nowhere else, so they stay.
 */
const IN_BOXES = new Set([MESSAGE_FEEDBACK_HEADING.title, ATTACHMENT_FEEDBACK_HEADING.title, INBOX_COMMENT_REPLIES_TITLE, INBOX_OPEN_COMMENTS_TITLE]);

/** A comment's entry heading in the comments sections, which ends with its id (ui's `commentIdSuffix`). */
const COMMENT_ENTRY = /^#{2,4} .* \(id [A-Za-z0-9_.:-]{1,200}\)$/;

/** What a Send's boxed sections carried. */
export interface RoundCounts {
  /** New comments, on agents' messages and on files. */
  comments: number;
  /** The person's replies under earlier comments. */
  replies: number;
  /** The person's comments on a passage of a thread's message. */
  subThreads: number;
  /** Open comments of earlier rounds, sent again. */
  open: number;
}

/**
 * A Send's feedback split for the line: the sections the boxes hold
 * (`boxed`, as sent), the others (`rest`, the guided review's), and what the
 * boxed ones carried.
 */
export function splitRoundFeedback(feedback: string): { boxed: string; rest: string; counts: RoundCounts } {
  const boxed: string[] = [];
  const rest: string[] = [];
  const counts: RoundCounts = { comments: 0, replies: 0, subThreads: 0, open: 0 };
  for (const section of feedbackSections(feedback)) {
    if (!IN_BOXES.has(section.title)) {
      rest.push(section.text);
      continue;
    }
    boxed.push(section.text);
    if (section.title === INBOX_OPEN_COMMENTS_TITLE) counts.open += inboxOpenCommentsCount(section.text);
    else if (section.title === INBOX_COMMENT_REPLIES_TITLE) {
      const under = inboxCommentRepliesCount(section.text);
      counts.replies += under.replies;
      counts.subThreads += under.subThreads;
    } else counts.comments += section.text.split('\n').filter((line) => COMMENT_ENTRY.test(line)).length;
  }
  return { boxed: boxed.join('\n\n'), rest: rest.join('\n\n'), counts };
}

/** A person's Send, as its line reads it: what its boxed sections carried, and whether its text holds nothing else. */
export interface SendRound {
  counts: RoundCounts;
  /** Its text is the boxed sections alone, with what the store writes for the agent (the reply's first line, the line on questions still open). */
  boxedOnly: boolean;
}

/**
 * A person's Send that carried a section the boxes hold, or null (an agent's
 * message, the Inbox's notes, an action item's report, a Re-ask, a Send
 * with none).
 */
export function sendRound(message: InboxMessageWire): SendRound | null {
  if (message.author.kind !== 'person' || isInboxNote(message) || isInboxActionReport(message) || (message.reask?.length ?? 0) > 0 || message.tidy) return null;
  const split = splitReplyFeedback(withoutInboxSkillsBlock(message.body));
  if (!split) return null;
  const round = splitRoundFeedback(split.feedback);
  if (!round.boxed) return null;
  // What comes before the feedback, without the parts the store writes for the agent.
  const before = splitInboxReplyBody(split.words);
  return { counts: round.counts, boxedOnly: round.rest === '' && before.words === '' && before.rest === '' && !before.answers };
}

/**
 * Whether a Send is its line alone: nothing but boxed sections, and no
 * answer or action item (`sent`, as the window lists them from the
 * questions), file or verdict.
 */
export function isRoundAlone(message: InboxMessageWire, round: SendRound, sent: { answers: number; actions: number }): boolean {
  return round.boxedOnly && sent.answers === 0 && sent.actions === 0 && (message.attachments?.length ?? 0) === 0 && !message.review_verdict;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The line's words: "Round 5 · 2 comments, 1 reply, 1 sub-thread sent · 4 open threads sent again", the round when known. */
export function roundLineWords(counts: RoundCounts, round: number | undefined): string {
  const sent = [
    counts.comments > 0 ? count(counts.comments, 'comment') : '',
    counts.replies > 0 ? count(counts.replies, 'reply', 'replies') : '',
    counts.subThreads > 0 ? count(counts.subThreads, 'sub-thread') : '',
  ].filter(Boolean);
  return [round !== undefined ? `Round ${round}` : '', sent.length > 0 ? `${sent.join(', ')} sent` : '', counts.open > 0 ? `${count(counts.open, 'open thread')} sent again` : '']
    .filter(Boolean)
    .join(' · ');
}

/** Whether an agent's message is only its replies under comments: send_message's `comment_replies` with no body. */
export function isRepliesOnly(message: InboxMessageWire): boolean {
  return message.author.kind === 'agent' && message.body.trim() === '' && !message.guide && !message.tidy;
}

/** Such a message's line: "Replied under 2 comments" (the comments its replies are under, when known). */
export function repliedUnderWords(comments: number): string {
  return comments > 0 ? `Replied under ${count(comments, 'comment')}` : 'Replied under comments';
}
