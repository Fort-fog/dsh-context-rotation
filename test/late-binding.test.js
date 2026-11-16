import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('plugin has no hard inject export that can leave it pending', () => {
  assert.doesNotMatch(source, /export const inject\s*=/)
})

test('plugin uses tokenMeter contextPressure before compatibility fallback', () => {
  assert.match(source, /tokenMeter\.contextPressure\(session\)/)
})

test('plugin emits a deterministic startup log', () => {
  assert.match(source, /dsh-context-rotation: loaded v0\.5\.7/)
})
