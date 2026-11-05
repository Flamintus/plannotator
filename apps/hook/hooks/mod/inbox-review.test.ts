/**
 * `/plannotator-last` and `/plannotator-annotate <one file>` through the
 * Inbox, against a REAL Inbox (`plannotator inbox --background` in a temp
 * world, tests/helpers/inbox-world.ts) and the real `plannotator inbox
 * review`, with the mod's own code on a Host of real processes
 * (testing/claude-session.ts). Only the screen's launch is a stand-in (a
 * ready file, no server), so a fallback is seen without leaving a review
 * server behind. Rules and refusals one by one: review-in-inbox.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInboxWorld, destroyInboxWorld, registry, removeStubbedHtml, startInbox, stubBuiltHtml, thread, waitFor, worldEnv, type InboxWorld } from '../../../../tests/helpers/inbox-world'
import { ClaudeSession } from './testing/claude-session'

const SESSION_ID = '3f0c2a54-7d8e-4b61-9a0f-5e2c1d7b8a90'
/** The answer's two text blocks after a tool call: one message of the transcript, two rows of the engine's conversation. */
const PARTS = ['The refund worker now retries a Stripe 409 three times with the same idempotency key.', 'Then it alerts.']
const ANSWER = PARTS.join('\n')

let stubs: string[] = []
const worlds: InboxWorld[] = []
const sessions: ClaudeSession[] = []

beforeAll(() => {
  stubs = stubBuiltHtml()
})
afterAll(() => {
  removeStubbedHtml(stubs)
})
afterEach(async () => {
  for (const session of sessions.splice(0)) session.quit()
  for (const w of worlds.splice(0)) await destroyInboxWorld(w)
})

/** A world whose Inbox keeps sent comments (the switch on) or not, with a file, a folder and this session's Claude Code transcript. */
function world(name: string, switchOn: boolean): InboxWorld {
  const w = createInboxWorld('plannotator-mod-inbox-review-', name, 'mod-inbox-review')
  worlds.push(w)
  mkdirSync(w.dataDir, { recursive: true })
  if (switchOn) writeFileSync(join(w.dataDir, 'config.json'), JSON.stringify({ experimental: { persistentComments: true } }))
  writeFileSync(join(w.project, 'notes.md'), '# Notes\n\nShip on Friday.\n')
  mkdirSync(join(w.project, 'docs'), { recursive: true })
  writeFileSync(join(w.project, 'docs', 'plan.md'), '# Plan\n')
  // The transcript the Inbox checks a dropped message against (its HOME is the world's).
  const transcripts = join(w.home, '.claude', 'projects', w.project.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(transcripts, { recursive: true })
  const line = (entry: Record<string, unknown>) => `${JSON.stringify({ sessionId: SESSION_ID, cwd: w.project, timestamp: new Date().toISOString(), ...entry })}\n`
  writeFileSync(
    join(transcripts, `${SESSION_ID}.jsonl`),
    line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Fix the refund retries.' } }) +
      line({ type: 'assistant', uuid: 'a0', parentUuid: 'u1', message: { id: 'msg_00', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] } }) +
      line({ type: 'user', uuid: 'u2', parentUuid: 'a0', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } }) +
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u2', message: { id: 'msg_01', role: 'assistant', content: [{ type: 'text', text: PARTS[0] }] } }) +
      line({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { id: 'msg_01', role: 'assistant', content: [{ type: 'text', text: PARTS[1] }] } }),
  )
  return w
}

/** The person starts the world's Inbox; it reads Claude Code transcripts from the world's HOME, whatever this machine sets. */
function startWorldInbox(w: InboxWorld): void {
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(w.home, '.claude')
  try {
    startInbox(w)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  }
}

/** This session in its Claude Code process: the conversation the engine holds, and the screen's launch stood in. */
async function open(w: InboxWorld): Promise<{ session: ClaudeSession; screens: string[][] }> {
  const session = await ClaudeSession.start({ env: worldEnv(w), cwd: w.project, store: new Map(), sessionId: SESSION_ID, dataDir: w.dataDir })
  sessions.push(session)
  // As the engine maps the transcript above (Claude Code 2.1.318): a row per block, the tool result a user row.
  session.host.messages = async () => [
    { role: 'user', text: 'Fix the refund retries.' },
    { role: 'assistant', text: '' },
    { role: 'user', text: '' },
    { role: 'assistant', text: PARTS[0]! },
    { role: 'assistant', text: PARTS[1]! },
  ]
  const screens: string[][] = []
  const run = session.host.run
  session.host.run = async (argv, init) => {
    if (argv[3] !== 'plannotator-launch') return run(argv, init)
    screens.push(argv.slice(5))
    writeFileSync(join(argv[4]!, 'ready'), `${JSON.stringify({ url: 'http://localhost:4321', isRemote: false, port: 4321 })}\n`)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { session, screens }
}

/** The session is connected: its wake has polled the running Inbox. */
async function connected(session: ClaudeSession): Promise<void> {
  await waitFor('the wake to poll', () => session.host.fetches.some((url) => url.endsWith('/api/inbox/bridge/poll')))
}

function addressOf(text: string): { url: string; thread: string; msg: string | null; file: string | null } {
  const url = /http:\/\/(?:127\.0\.0\.1|localhost):\d+\/#\S+/.exec(text)?.[0]
  if (!url) throw new Error(`no Inbox address in: ${text}`)
  const params = new URLSearchParams(url.slice(url.indexOf('#') + 1))
  return { url, thread: params.get('thread')!, msg: params.get('msg'), file: params.get('file') }
}

describe('the review commands through a real Inbox', () => {
  test("/plannotator-last lands the session's last message in its review thread, checked against its transcript; again, nothing new; the person's Send wakes the session", async () => {
    const w = world('last', true)
    startWorldInbox(w)
    const { session, screens } = await open(w)
    await connected(session)

    const answer = await session.mod.answerCommand('last', '')
    w.proof(`> /plannotator-last\n${answer.text}\n[context] ${answer.context?.join('\n')}\n`)

    expect(screens).toEqual([])
    const at = addressOf(answer.text)
    expect(answer.context?.[0]).toContain(at.thread)
    const review = await thread(w, at.thread)
    const dropped = review.messages.find((message) => message.id === at.msg) as (typeof review.messages)[number] & { imported?: { verified?: boolean; by?: { kind: string } } }
    expect(dropped.body).toBe(ANSWER)
    expect(dropped.author).toMatchObject({ kind: 'agent', host: 'claude-code', session: SESSION_ID })
    // The words the mod sent are the transcript's own: the Inbox found them there.
    expect(dropped.imported).toMatchObject({ verified: true, by: { kind: 'cli' } })

    // The same command again: the message already there, nothing written.
    const again = await session.mod.answerCommand('last', '')
    expect(addressOf(again.text)).toEqual(at)
    expect((await thread(w, at.thread)).messages).toHaveLength(review.messages.length)

    // The person answers on the dropped message: this session is woken with it.
    const { port } = registry(w)
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
    const sent = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${at.msg}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: 'window-reply-1', words: 'Make it five retries.' }),
    })
    expect(sent.status).toBe(200)
    const wake = await waitFor('the wake turn', () => session.host.submits.find((text) => text.includes('Make it five retries.')))
    expect(wake).toContain(at.thread)
    w.proof(`> the person replies on the dropped message; the session's turn:\n${wake}\n`)
  }, 60_000)

  test('/plannotator-annotate: one file lands in a thread of its own; a folder keeps the screen', async () => {
    const w = world('annotate', true)
    startWorldInbox(w)
    const { session, screens } = await open(w)
    await connected(session)

    const file = await session.mod.answerCommand('annotate', 'notes.md')
    w.proof(`> /plannotator-annotate notes.md\n${file.text}\n[context] ${file.context?.join('\n')}\n`)
    const at = addressOf(file.text)
    expect(at.file).toStartWith('att_')
    const root = (await thread(w, at.thread)) as Awaited<ReturnType<typeof thread>> & { messages: { attachments?: { path: string }[] }[] }
    expect(root.messages[0]?.attachments?.map((attachment) => attachment.path)).toEqual([join(w.project, 'notes.md')])
    expect(file.context?.[0]).toContain('notes.md')

    const folder = await session.mod.answerCommand('annotate', 'docs')
    expect(folder.text).toContain('http://localhost:4321')
    expect(folder.context).toBeUndefined()
    expect(screens).toEqual([['plannotator', 'annotate', 'docs']])
  }, 60_000)

  test('the switch off, or no Inbox running: the screen, and nothing lands in the Inbox', async () => {
    const off = world('switch-off', false)
    startWorldInbox(off)
    const first = await open(off)
    await connected(first.session)
    const answer = await first.session.mod.answerCommand('last', '')
    expect(first.screens).toEqual([['plannotator', 'annotate-last', '--stdin']])
    expect(answer.context).toBeUndefined()
    const list = (await (await fetch(`http://127.0.0.1:${registry(off).port}/api/inbox/threads`)).json()) as { sections: { threads: unknown[] }[] }
    expect(list.sections.flatMap((section) => section.threads)).toEqual([])

    const stopped = world('no-inbox', true)
    const second = await open(stopped)
    const none = await second.session.mod.answerCommand('annotate', 'notes.md')
    expect(second.screens).toEqual([['plannotator', 'annotate', 'notes.md']])
    expect(none.context).toBeUndefined()
  }, 60_000)
})
