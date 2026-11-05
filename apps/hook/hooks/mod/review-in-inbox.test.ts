import { describe, expect, test } from 'bun:test'
import { PlannotatorMod } from './controller'
import type { ProcessResult } from './host'
import { fakeHost, type FakeHost } from './testing/fake-host'

// `/plannotator-last` and `/plannotator-annotate <one file>` through the
// person's Inbox (review-in-inbox.ts). The failures these catch: a drop for
// the wrong session or with the wrong text; the screen opening as well as the
// Inbox; the screen not opening when the Inbox refuses (each refusal, an older
// CLI, a run that fails); a folder, a URL, several words or a flag sent to the
// Inbox; a session with no Inbox connection asking it at all; the model not
// told where the comments come from. Against a real Inbox: inbox-review.test.ts.

const SESSION = { sessionId: 'session-1', dataDir: '/data', interactive: true }
/** A session connected to the Inbox (the tool registered at session start). */
const CONNECTED = { ...SESSION, inboxTools: [] }
const DROPPED = 'http://127.0.0.1:19432/#thread=th_01REVIEW&msg=msg_01COPY'

interface Run {
  argv: readonly string[]
  env?: Record<string, string>
  stdin?: string
}

/** A host whose CLI comes up for every screen launch and answers `plannotator inbox review` with `drop`. */
function world(drop: (run: Run) => ProcessResult) {
  const host: FakeHost = fakeHost()
  const reviews: Run[] = []
  const run = host.run
  host.run = async (argv, init) => {
    if (argv[0] === 'plannotator' && argv[1] === 'inbox' && argv[2] === 'review') {
      const call = { argv, ...(init?.env ? { env: init.env } : {}), ...(init?.stdin !== undefined ? { stdin: init.stdin } : {}) }
      reviews.push(call)
      return drop(call)
    }
    return run(argv, init)
  }
  host.onRun = (call) => {
    if (call.argv[3] === 'plannotator-launch') {
      host.files.set(`${call.argv[4]}/ready`, `${JSON.stringify({ url: 'http://localhost:4321', isRemote: false, port: 4321 })}\n`)
    }
  }
  host.transcript = [
    { role: 'user', text: 'Plan the refund retry fix.' },
    { role: 'assistant', text: 'Here is the plan, part one.' },
    { role: 'user', text: '' }, // a tool result
    { role: 'assistant', text: 'Part two: retry with the same key.' },
    { role: 'assistant', text: 'Part three: alert after five.' },
  ]
  const screens = () => host.runs.filter((call) => call.argv[3] === 'plannotator-launch').map((call) => call.argv.slice(5))
  return { host, reviews, screens }
}

const taken = (): ProcessResult => ({ exitCode: 0, stdout: `${DROPPED}\n`, stderr: '' })
const refused = (code: string): ProcessResult => ({ exitCode: 1, stdout: '', stderr: `${code}: refused.\n` })

describe('the review commands through the Inbox', () => {
  test("/plannotator-last drops the newest message for this session and opens the window on it; the screen does not open", async () => {
    const w = world(taken)
    const mod = new PlannotatorMod(w.host, CONNECTED)

    const answer = await mod.answerCommand('last', '')

    expect(w.reviews).toHaveLength(1)
    const [review] = w.reviews
    expect(review?.argv).toEqual(['plannotator', 'inbox', 'review', '--message', '-', '--session', 'claude-code:session-1', '--open'])
    // The newest response (its rows since the last tool result), as the screen would show it.
    expect(review?.stdin).toBe('Part two: retry with the same key.\nPart three: alert after five.')
    // This session, whatever an older shell variable says, in the mod's data dir.
    expect(review?.env).toMatchObject({ PLANNOTATOR_SESSION_TAG: 'claude-code:session-1', PLANNOTATOR_DATA_DIR: '/data' })
    expect(answer.text).toContain(DROPPED)
    expect(answer.text).toContain('Inbox')
    expect(answer.context).toHaveLength(1)
    expect(answer.context?.[0]).toContain('th_01REVIEW')
    expect(w.screens()).toEqual([])
  })

  test('/plannotator-annotate <one file> drops the file, a mention without its @; the screen does not open', async () => {
    for (const [words, path] of [
      ['notes.md', 'notes.md'],
      ['@docs/plan.md', 'docs/plan.md'],
      ['"my notes.md"', 'my notes.md'],
    ] as const) {
      const w = world(taken)
      const mod = new PlannotatorMod(w.host, CONNECTED)

      const answer = await mod.answerCommand('annotate', words)

      expect(w.reviews.map((review) => review.argv)).toEqual([['plannotator', 'inbox', 'review', '--file', path, '--session', 'claude-code:session-1', '--open']])
      expect(w.reviews[0]?.stdin).toBeUndefined()
      expect(answer.text).toContain(DROPPED)
      expect(answer.context?.[0]).toContain(path.split('/').pop()!)
      expect(w.screens()).toEqual([])
    }
  })

  test('the Inbox refuses (each refusal, an older CLI, bad usage, a failed run): the screen opens as before, and the model gets nothing extra', async () => {
    const outcomes: ProcessResult[] = [
      refused('persistent_comments_off'),
      refused('session_not_live'),
      refused('inbox_not_running'),
      refused('inbox_too_old'),
      // A folder or a missing file: the Inbox's own refusal.
      refused('validation_error'),
      // A CLI from before `inbox review`.
      { exitCode: 1, stdout: '', stderr: "Unknown inbox option: review\nRun 'plannotator inbox --help' for usage.\n" },
      { exitCode: 2, stdout: '', stderr: 'usage: inbox review needs --message - or --file <path>.\n' },
      // Exit 0 without an address is no drop.
      { exitCode: 0, stdout: '', stderr: '' },
    ]
    for (const outcome of outcomes) {
      for (const [kind, words, screen] of [
        ['last', '', ['plannotator', 'annotate-last', '--stdin']],
        ['annotate', 'notes.md', ['plannotator', 'annotate', 'notes.md']],
      ] as const) {
        const w = world(() => outcome)
        const mod = new PlannotatorMod(w.host, CONNECTED)

        const answer = await mod.answerCommand(kind, words)

        expect(w.reviews).toHaveLength(1)
        expect(w.screens()).toEqual([[...screen]])
        expect(answer.text).toContain('http://localhost:4321')
        expect(answer.context).toBeUndefined()
      }
    }
    // A run that throws (a timeout, the engine refusing it).
    const w = world(() => {
      throw new Error('process.run timed out')
    })
    const answer = await new PlannotatorMod(w.host, CONNECTED).answerCommand('last', '')
    expect(w.screens()).toEqual([['plannotator', 'annotate-last', '--stdin']])
    expect(answer.context).toBeUndefined()
  })

  test('a URL, several words, any flag, /plannotator-review and a tailnet /plannotator-last keep the screen without asking the Inbox', async () => {
    for (const [kind, words] of [
      ['annotate', 'https://example.com/spec'],
      ['annotate', 'a.md b.md'],
      ['annotate', 'notes.md --gate'],
      ['annotate', '--markdown notes.md'],
      ['annotate', '--help'],
      ['annotate', ''],
      ['review', ''],
      ['review', 'notes.md'],
      ['last', '--tailscale'],
    ] as const) {
      const w = world(taken)
      const mod = new PlannotatorMod(w.host, CONNECTED)

      const answer = await mod.answerCommand(kind, words)

      expect(w.reviews).toEqual([])
      expect(w.screens()).toHaveLength(1)
      expect(answer.context).toBeUndefined()
    }
  })

  test('a session with no Inbox connection (the inbox tool off) never asks the Inbox: nothing would wake it', async () => {
    const w = world(taken)
    const mod = new PlannotatorMod(w.host, SESSION)

    const answer = await mod.answerCommand('last', '')

    expect(w.reviews).toEqual([])
    expect(w.screens()).toEqual([['plannotator', 'annotate-last', '--stdin']])
    expect(answer.context).toBeUndefined()
  })

  test('no assistant message yet: the screen\'s answer, no drop', async () => {
    const w = world(taken)
    w.host.transcript = [{ role: 'user', text: 'hi' }]
    const mod = new PlannotatorMod(w.host, CONNECTED)

    const answer = await mod.answerCommand('last', '')

    expect(w.reviews).toEqual([])
    expect(answer.text).toBe('There is no assistant message to annotate yet.')
  })

  test("a remote session's note from the CLI (no browser opened) reaches the person", async () => {
    const w = world(() => ({ exitCode: 0, stdout: `${DROPPED}\n`, stderr: 'No browser opened: this is a remote session. Forward the port.\n' }))
    const answer = await new PlannotatorMod(w.host, CONNECTED).answerCommand('last', '')

    expect(answer.text).toContain(DROPPED)
    expect(answer.text).toContain('No browser opened')
  })
})
