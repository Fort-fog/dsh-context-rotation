import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHandoff, contentToText, resolveConfig } from '../handoff.js'

test('clamps large tool output instead of copying it into the handoff', () => {
  const text = contentToText([{ type: 'tool-result', content: 'x'.repeat(10000) }], {
    toolResultExcerptChars: 400,
  })
  assert.ok(text.length < 500)
  assert.match(text, /truncated for context rotation/)
})

test('handoff preserves early user requirement, recent state and boundary input', () => {
  const handoff = buildHandoff({
    sourceSessionId: 'old',
    targetSessionId: 'new',
    cwd: '/tmp/project',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Never change model settings.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Working on parser.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Keep existing tests.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Parser now passes unit tests.' }] },
    ],
    pendingMessages: [
      { role: 'user', content: [{ type: 'text', text: 'Now finish integration test.' }] },
    ],
  })

  assert.match(handoff, /Never change model settings/)
  assert.match(handoff, /Parser now passes unit tests/)
  assert.match(handoff, /Now finish integration test/)
  assert.match(handoff, /Current session: new/)
})

test('handoff stays inside its configured hard character budget', () => {
  const handoff = buildHandoff({
    sourceSessionId: 'old',
    targetSessionId: 'new',
    cwd: '/tmp/project',
    messages: Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: [{ type: 'text', text: `${i}: ${'z'.repeat(3000)}` }],
    })),
    options: { handoffMaxChars: 6000 },
  })

  assert.ok(handoff.length <= 6000)
})

test('config defaults rotate before stock 80 percent pressure', () => {
  const config = resolveConfig({})
  assert.equal(config.thresholdRatio, 0.8)
  assert.equal(config.handoffMaxChars, 24000)
})
