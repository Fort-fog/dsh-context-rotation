import test from 'node:test'
import assert from 'node:assert/strict'
import {
  continuationInstruction,
  subagentFinalizationContinuationInstruction,
  continuationKey,
  createFinishTracker,
} from '../continuation.js'

test('finish tracker commits max-tokens for the latest step of a turn', () => {
  const t = createFinishTracker()
  t.observe('s1', {type: 'start', attemptId: 'a1', turn: 3, step: 1})
  t.observe('s1', {type: 'chunk', attemptId: 'a1', chunk: {type: 'finish', reason: {kind: 'max-tokens'}}})
  t.observe('s1', {type: 'end', attemptId: 'a1', outcome: {kind: 'committed', eventType: 'assistant/message', seq: 10}})
  assert.deepEqual(t.latest('s1', 3), {step: 1, kind: 'max-tokens'})
})

test('a later normal stop replaces an earlier max-tokens finish for stop-boundary decisions', () => {
  const t = createFinishTracker()
  t.observe('s1', {type: 'start', attemptId: 'a1', turn: 1, step: 1})
  t.observe('s1', {type: 'chunk', attemptId: 'a1', chunk: {type: 'finish', reason: {kind: 'max-tokens'}}})
  t.observe('s1', {type: 'end', attemptId: 'a1', outcome: {kind: 'committed', eventType: 'assistant/message', seq: 1}})
  t.observe('s1', {type: 'start', attemptId: 'a2', turn: 1, step: 2})
  t.observe('s1', {type: 'chunk', attemptId: 'a2', chunk: {type: 'finish', reason: {kind: 'stop'}}})
  t.observe('s1', {type: 'end', attemptId: 'a2', outcome: {kind: 'committed', eventType: 'assistant/message', seq: 2}})
  assert.deepEqual(t.latest('s1', 1), {step: 2, kind: 'stop'})
})

test('abandoned attempts do not trigger continuation', () => {
  const t = createFinishTracker()
  t.observe('s1', {type: 'start', attemptId: 'a1', turn: 1, step: 1})
  t.observe('s1', {type: 'chunk', attemptId: 'a1', chunk: {type: 'finish', reason: {kind: 'max-tokens'}}})
  t.observe('s1', {type: 'end', attemptId: 'a1', outcome: {kind: 'abandoned'}})
  assert.equal(t.latest('s1', 1), undefined)
})

test('continuation notice explicitly protects against replaying side effects', () => {
  const text = continuationInstruction(2, 6)
  assert.match(text, /2\/6/)
  assert.match(text, /do not repeat already completed side effects/i)
  assert.match(text, /tool call/i)
})

test('continuation keys separate turns', () => {
  assert.notEqual(continuationKey('s', 1), continuationKey('s', 2))
})


test('subagent finalization continuation forbids new tools and analysis branches', () => {
  const text = subagentFinalizationContinuationInstruction(1, 6)
  assert.match(text, /1\/6/)
  assert.match(text, /do not call tools/i)
  assert.match(text, /do not open new analysis branches/i)
  assert.match(text, /return control to the parent agent/i)
})


test('max-output policy is documented as a fresh-turn continuation', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
  )
  assert.match(source, /max-tokens sticky for the entire turn/i)
  assert.match(source, /agent\.followup\(pluginMessage\(notice\)\)/)
  assert.match(source, /continuationChains/)
})


test('continuation chain is not cleared from session/event turn/end', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
  )
  const eventStart = source.indexOf("ctx.on('session/event'")
  const disposedStart = source.indexOf("ctx.on('agent/disposed'", eventStart)
  const eventBlock = source.slice(eventStart, disposedStart)
  assert.doesNotMatch(eventBlock, /continuationChains\.delete\(session\.id\)/)
})

test('default max-output continuation cap is three', async () => {
  const { resolveConfig } = await import('../handoff.js')
  assert.equal(resolveConfig({}).maxOutputContinuations, 3)
})
