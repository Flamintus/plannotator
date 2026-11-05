/**
 * `/plannotator-last` and `/plannotator-annotate <one file>` through the
 * person's Plannotator Inbox: the target is dropped in the session's review
 * thread (`plannotator inbox review`, apps/hook/server/inbox-review-command.ts)
 * and the window opens on it, so the person comments there, round after
 * round, and a Send wakes this session. The screen stays the way whenever
 * the Inbox does not take the drop: the switch off (experimental
 * "persistent-comments"), no Inbox running, this session not connected to it,
 * an Inbox too old, a CLI without the command, or any other refusal.
 *
 * Kept on the screen, never tried in the Inbox: `/plannotator-annotate`
 * with a URL, several words, any flag (`--gate`, `--markdown`, ...: screen
 * options) or a `~` path (the screen expands it; the mod knows no HOME);
 * `/plannotator-last --tailscale`; `/plannotator-review`. A word that is not
 * a file of the session's folder (a folder too) is refused by the Inbox, and
 * the screen then resolves it its own way (a bare name found elsewhere in
 * the project).
 *
 * The person's answer names the Inbox; the model gets one line of hidden
 * context saying what is under review and where the comments will come from.
 */

import type { ProcessResult } from './host'
import type { SessionKind } from './delivery'

/** What a command drops in the Inbox: the newest assistant message (its text on stdin), or one file. */
export type InboxReviewDrop = { kind: 'message' } | { kind: 'file'; path: string }

/**
 * The most a drop holds the command before the screen opens instead: past
 * the CLI's own bound on its request (30 s, inbox-review-command.ts) and its
 * start, so the CLI answers first (`inbox_no_answer`) and never opens the
 * window after the screen did.
 */
export const INBOX_REVIEW_TIMEOUT_MS = 40_000

/**
 * What `/plannotator-last` or `/plannotator-annotate` drops in the Inbox, or
 * null to keep the screen. `words`: the command's arguments, split as the
 * skill's shell line splits them.
 */
export function inboxReviewDropOf(kind: SessionKind, words: readonly string[]): InboxReviewDrop | null {
  if (kind === 'last') return words.includes('--tailscale') ? null : { kind: 'message' }
  if (kind !== 'annotate' || words.length !== 1) return null
  const word = words[0] as string
  if (word === '' || word.startsWith('-') || word.startsWith('~') || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return null
  // Claude Code's file mention (`@notes.md`): the `@` is not part of the name.
  const path = word.startsWith('@') && word.length > 1 ? word.slice(1) : word
  return { kind: 'file', path }
}

/** The CLI argv of a drop for `sessionId` (a Claude Code session), opening the window on it. */
export function inboxReviewArgv(drop: InboxReviewDrop, sessionId: string): string[] {
  const target = drop.kind === 'message' ? ['--message', '-'] : ['--file', drop.path]
  return ['plannotator', 'inbox', 'review', ...target, '--session', `claude-code:${sessionId}`, '--open']
}

/**
 * The drop's outcome: its address in the Inbox (and what the CLI said beside
 * it, a remote session's "no browser opened"), or why it was not taken, for
 * the debug log. Only an exit 0 with an address is a drop.
 */
export function inboxReviewOutcome(
  result: ProcessResult,
): { dropped: true; url: string; threadId: string | null; note: string } | { dropped: false; why: string } {
  const url = /https?:\/\/\S+/.exec(result.stdout)?.[0]
  if (result.exitCode === 0 && url) {
    return { dropped: true, url, threadId: /[#&]thread=([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null, note: result.stderr.trim() }
  }
  const why = result.stderr.trim().split('\n')[0] || result.stdout.trim().split('\n')[0] || ''
  return { dropped: false, why: `exit ${result.exitCode}${why ? `: ${why.slice(0, 300)}` : ''}` }
}

/** The command's answer to the person once the target is in their Inbox. */
export function inboxReviewOpenedText(subject: string, url: string, note = ''): string {
  return `Opened ${subject} in your Plannotator Inbox · ${url}${note ? `\n${note}` : ''}\nYour comments reach Claude from the Inbox when you send them.`
}

/**
 * The hidden line the model gets: what is under review (a file by the path
 * the person typed, never a bare name that could be another file), where, and
 * where the comments come from.
 */
export function inboxReviewAgentLine(drop: InboxReviewDrop, threadId: string | null): string {
  const what = drop.kind === 'message' ? 'your last message' : drop.path
  return `The person is reviewing ${what} in their Plannotator Inbox${threadId ? ` (thread ${threadId})` : ''}; their comments will reach you from the Inbox.`
}
