import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  pendingMessagesText,
  validateHandoffFile,
  writeEmergencyHandoff,
} from '../handoff-plan.js'

function msg(text) {
  return {role: 'user', content: [{type: 'text', text}], source: {kind: 'user'}}
}

test('pending message text survives emergency rollover', () => {
  assert.match(pendingMessagesText([msg('do the unfinished thing')]), /do the unfinished thing/)
})

test('emergency handoff is a valid MD and contains pending input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-emergency-'))
  const filePath = path.join(dir, '.dsh-handoff', 'handoff.md')
  const result = writeEmergencyHandoff({
    filePath,
    sourceSessionId: 'old',
    cwd: dir,
    messages: [msg('original requirement'), {role:'assistant', content:[{type:'text', text:'worked on it'}]}],
    pendingMessages: [msg('continue and finish it')],
    pressureTokens: 65585,
    contextWindow: 65536,
    options: {handoffMaxChars: 24000, handoffMinChars: 800},
  })
  assert.ok(result.chars > 800)
  const text = fs.readFileSync(filePath, 'utf8')
  assert.match(text, /continue and finish it/)
  assert.match(text, /65585\/65536/)
  assert.equal(validateHandoffFile(filePath, 800).ok, true)
})
