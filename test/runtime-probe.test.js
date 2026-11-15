import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeProbe } from '../runtime-probe.js'

test('runtime probe writes apply marker and hook counters atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-probe-'))
  const filePath = path.join(dir, 'runtime.json')
  const probe = createRuntimeProbe({filePath, version: 'test'})
  probe.hit('agent/pre-step', {sessionId: 's1'})
  probe.hit('agent/pre-step', {sessionId: 's1'})
  probe.hit('agent/request-error', {code: 'X'})
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(state.apply, true)
  assert.equal(state.version, 'test')
  assert.equal(state.events['agent/pre-step'], 2)
  assert.equal(state.events['agent/request-error'], 1)
  assert.equal(state.lastEvent, 'agent/request-error')
})
