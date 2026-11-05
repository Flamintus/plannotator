import { describe, expect, test } from 'bun:test'
import {
  parsePlannotatorToolInput,
  parsePlannotatorToolLoopInput,
  plannotatorSendOutcome,
  plannotatorToolLoopDescription,
  plannotatorToolLoopInputSchema,
  PLANNOTATOR_TOOL_LOOP_LINES,
  PLANNOTATOR_TOOL_TAILSCALE_DESCRIPTION,
  PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA,
} from './plannotator-tool'

// The review loop's actions: only a host that carries sends registers them,
// on top of its own schema; every other host's schema and description stay
// byte for byte (pinned by plannotator-tool-tailscale.test.ts).
describe('plannotator tool: reply and threads (review loop)', () => {
  test('the variant adds the two actions and their lines to the schema and description it is given', () => {
    const schema = plannotatorToolLoopInputSchema(PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA)
    expect(schema.properties.action.enum).toEqual(['annotate', 'review', 'last', 'list', 'close', 'reply', 'threads'])
    expect(Object.keys(schema.properties)).toContain('tailscale')
    expect(Object.keys(schema.properties)).toContain('replies')
    // The schema it was given is left as it was.
    expect(PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA.properties.action.enum).toEqual(['annotate', 'review', 'last', 'list', 'close'])
    const description = plannotatorToolLoopDescription(PLANNOTATOR_TOOL_TAILSCALE_DESCRIPTION)
    const lines = description.split('\n')
    // With the other actions, before the tailscale option's line and the closing paragraph.
    const first = lines.indexOf(PLANNOTATOR_TOOL_LOOP_LINES[0]!)
    expect(lines[first - 1]!.startsWith('- action "close"')).toBe(true)
    expect(lines[first + 2]!.includes('`tailscale: true`')).toBe(true)
  })

  test('reply takes a review id and replies under ids; threads takes the id alone', () => {
    expect(parsePlannotatorToolLoopInput({ action: 'reply', session: 'PN-3F2A9C', replies: [{ id: 'c1', text: 'Done: moved to Tuesday.' }] })).toEqual({
      ok: true,
      input: { action: 'reply', session: 'pn-3f2a9c', replies: [{ id: 'c1', text: 'Done: moved to Tuesday.' }] },
    })
    expect(parsePlannotatorToolLoopInput({ action: 'threads', session: 'pn-3f2a9c', replies: [] })).toEqual({ ok: true, input: { action: 'threads', session: 'pn-3f2a9c' } })
  })

  test('refuses what the loop does not take: no resolution, no unknown field, no empty reply, no review id', () => {
    const refused = (value: unknown) => {
      const parsed = parsePlannotatorToolLoopInput(value)
      expect(parsed?.ok).toBe(false)
    }
    refused({ action: 'reply', session: 'pn-3f2a9c', replies: [{ id: 'c1', text: 'ok', resolve: true }] })
    refused({ action: 'reply', session: 'pn-3f2a9c', resolve: ['c1'], replies: [{ id: 'c1', text: 'ok' }] })
    refused({ action: 'reply', session: 'pn-3f2a9c', replies: [{ id: 'c1', text: '  ' }] })
    refused({ action: 'reply', session: 'all', replies: [{ id: 'c1', text: 'ok' }] })
    refused({ action: 'reply', replies: [{ id: 'c1', text: 'ok' }] })
    refused({ action: 'threads', session: 'pn-3f2a9c', target: 'notes.md' })
  })

  test('other actions are left to the plain parser, which still refuses reply and threads', () => {
    expect(parsePlannotatorToolLoopInput({ action: 'list' })).toBeNull()
    expect(parsePlannotatorToolInput({ action: 'reply', session: 'pn-3f2a9c' }).ok).toBe(false)
  })

  // Pinned on purpose: the heading every host gives a send, which the agent reads as it reads a decision's.
  test('a send is headed with its round, whether it ended it, and what it carries', () => {
    expect(plannotatorSendOutcome('round', 2, 3)).toBe('Round 2 done · 3 comments')
    expect(plannotatorSendOutcome('now', 1, 1)).toBe('Round 1 still open · 1 comment')
    expect(plannotatorSendOutcome('round', 3, 0)).toBe('Round 3 done · no new comment')
  })
})
