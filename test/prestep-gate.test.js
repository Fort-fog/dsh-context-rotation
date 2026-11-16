import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('primary early-rotation gate lives in agent/pre-step', () => {
  assert.match(index, /ctx\.on\('agent\/pre-step'/)
  assert.match(index, /rotationThresholdTokens\(config, pressure\.contextWindow, modelSelection\?\.provider\)/)
  assert.match(index, /projectedTokens < thresholdTokens/)
})

test('normal threshold replaces claimed user input with planning step', () => {
  assert.match(index, /planningInstruction\(/)
  assert.match(index, /startsRequestSeries:\s*true/)
})

test('overfull sessions have emergency handoff before provider', () => {
  assert.match(index, /writeEmergencyHandoff\(/)
  assert.match(index, /projectedTokens >= pressure\.contextWindow/)
  assert.match(index, /return \{ kind: 'reject' \}/)
})

test('pending claimed input is preserved for the handoff', () => {
  assert.match(index, /pendingMessagesText\(messages/)
  assert.match(index, /pendingText/)
})
