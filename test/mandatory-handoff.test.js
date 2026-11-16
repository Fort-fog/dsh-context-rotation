import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const plan = fs.readFileSync(new URL('../handoff-plan.js', import.meta.url), 'utf8')

test('configured context handoff is described as mandatory', () => {
  assert.match(index, /mandatory context handoff started/)
  assert.match(plan, /MANDATORY MODE SWITCH/)
})

test('invalid handoff never deletes planning state and falls back to normal work', () => {
  assert.doesNotMatch(index, /handoffs\.delete\(session\.id\)\s*\n\s*return\s*\n\s*}\s*\n\s*ctx\.logger\.error\(\s*`dsh-context-rotation: handoff aborted/)
  assert.match(index, /MANDATORY HANDOFF RECOVERY/)
})

test('startup identifies current version', () => {
  assert.match(index, /loaded v0\.5\.7/)
})
