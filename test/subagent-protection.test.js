import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const plan = fs.readFileSync(new URL('../handoff-plan.js', import.meta.url), 'utf8')

test('subagents are not skipped by the pre-step gate', () => {
  assert.doesNotMatch(source, /origin === 'subagent'\) return await next\(\)/)
})

test('subagent threshold switches to a final parent report', () => {
  assert.match(source, /subagent finalization started/)
  assert.match(source, /subagentFinalizationInstruction/)
  assert.match(plan, /Produce a concise final report for the parent agent/)
})

test('overfull subagent is rejected before provider', () => {
  assert.match(source, /stopping overfull subagent/)
})

test('request-error has root recovery and subagent stop', () => {
  assert.match(source, /ctx\.on\('agent\/request-error'/)
  assert.match(source, /request-error emergency handoff/)
  assert.match(source, /subagent context overflow stopped/)
})


test('max-token continuation runs before the subagent root-handoff return', () => {
  const turnStopping = source.slice(source.indexOf("ctx.on('agent/turn-stopping'"))
  const maxTokens = turnStopping.indexOf("last?.kind === 'max-tokens'")
  const subagentReturn = turnStopping.indexOf("if (isSubagent) return")
  assert.ok(maxTokens >= 0)
  assert.ok(subagentReturn > maxTokens)
})

test('runtime probe records max-token detection, origin and queued follow-up', () => {
  assert.match(source, /max-tokens-detected/)
  assert.match(source, /max-tokens-subagent/)
  assert.match(source, /max-tokens-root/)
  assert.match(source, /max-tokens-followup-queued/)
})

test('max-token continuation uses a fresh follow-up turn, not same-turn steer', () => {
  const turnStopping = source.slice(source.indexOf("ctx.on('agent/turn-stopping'"))
  const maxTokensBlock = turnStopping.slice(
    turnStopping.indexOf("last?.kind === 'max-tokens'"),
    turnStopping.indexOf("if (isSubagent) return"),
  )
  assert.match(maxTokensBlock, /agent\.followup\(pluginMessage\(notice\)\)/)
  assert.doesNotMatch(maxTokensBlock, /agent\.steer\(pluginMessage\(notice\)\)/)
})
