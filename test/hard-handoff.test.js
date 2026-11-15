import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { modelHandoffText, writeModelHandoff, validateHandoffFile } from '../handoff-plan.js'

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('planning mode does not delegate to normal work', () => {
  const branch = source.slice(source.indexOf("if (existing?.phase === 'planning')"), source.indexOf("if (existing?.phase === 'rotated')"))
  assert.doesNotMatch(branch, /return await next\(\)/)
  assert.match(branch, /DSH HARD HANDOFF MODE/)
})

test('all tools are denied during root planning before execution', () => {
  assert.match(source, /ctx\.on\('tools\/pre-execute'/)
  assert.match(source, /HANDOFF_TOOL_FROZEN/)
  assert.match(source, /toolViolation = true/)
})

test('forbidden tool triggers deterministic immediate rotation path', () => {
  assert.match(source, /if \(existing\.toolViolation\)/)
  assert.match(source, /hard handoff after forbidden tool/)
  assert.match(source, /toolViolationRecovery: true/)
})

test('model-authored assistant text is persisted by the plugin', () => {
  const messages = [
    {role:'user', content:[{type:'text', text:'planning prompt'}]},
    {role:'assistant', content:[{type:'text', text:'# DSH Context Handoff\n## Goal\nA'}]},
    {role:'assistant', content:[{type:'tool-call', name:'bash', arguments:{cmd:'bad'}}, {type:'text', text:'## User requirements and constraints\nB'}]},
  ]
  const text = modelHandoffText(messages, 1)
  assert.match(text, /# DSH Context Handoff/)
  assert.match(text, /## User requirements and constraints/)
  assert.doesNotMatch(text, /tool call|bash|bad/)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-handoff-'))
  const file = path.join(dir, 'handoff.md')
  writeModelHandoff(file, text)
  assert.equal(fs.readFileSync(file, 'utf8').trim(), text)
})
