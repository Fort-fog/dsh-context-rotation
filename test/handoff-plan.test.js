import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  handoffPath,
  planningInstruction,
  resumeInstruction,
  validateHandoffFile,
} from '../handoff-plan.js'

test('handoff path is inside the workspace and uses markdown', () => {
  const p = handoffPath('/tmp/project', 'session/with unsafe chars')
  assert.equal(path.dirname(p), '/tmp/project/.dsh-handoff')
  assert.match(path.basename(p), /^context-handoff-.*\.md$/)
})

test('planning instruction requires a durable MD and stop boundary', () => {
  const p = '/work/.dsh-handoff/context-handoff-s1.md'
  const text = planningInstruction(p, 53000, 65536, 'finish the current feature')
  assert.match(text, /plugin will save your Markdown text to this file itself/i)
  assert.match(text, /Do not output HANDOFF_READY/)
  assert.match(text, /Exact next steps/)
  assert.match(text, /MANDATORY MODE SWITCH: stop normal project work/)
})

test('resume instruction requires reading the file before continuing', () => {
  const p = '/work/.dsh-handoff/context-handoff-s1.md'
  const text = resumeInstruction(p)
  assert.match(text, /Before doing anything else, read this Markdown handoff file/)
  assert.match(text, /Continue the unfinished task immediately/)
})

test('validator accepts a complete handoff and rejects incomplete files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handoff-test-'))
  const p = path.join(dir, 'handoff.md')

  fs.writeFileSync(p, '# DSH Context Handoff\n## Goal\nx\n')
  assert.equal(validateHandoffFile(p, 100).ok, false)

  fs.writeFileSync(p, [
    '# DSH Context Handoff',
    '## Goal',
    'Continue project.',
    '## User requirements and constraints',
    'Keep settings unchanged.',
    '## Current project/workspace state',
    'State.',
    '## Completed work',
    'Done.',
    '## Files changed',
    'file.js',
    '## Commands/tests already run and their important results',
    'tests pass',
    '## Unresolved errors or risks',
    'none',
    '## Pending request at handoff boundary',
    'finish the current feature',
    '## Exact next steps',
    'Do next.',
    '## First action in the new chat',
    'Read file.js.',
    'x'.repeat(1000),
  ].join('\n'))

  const result = validateHandoffFile(p, 800)
  assert.equal(result.ok, true)
  assert.ok(result.chars >= 800)
})

test('missing handoff file is rejected', () => {
  const p = path.join(os.tmpdir(), `missing-${Date.now()}.md`)
  assert.deepEqual(validateHandoffFile(p), {ok: false, reason: 'missing'})
})
