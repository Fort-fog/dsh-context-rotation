import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { resolveConfig } from '../handoff.js'

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('default absolute rotation ceiling is 52k tokens', () => {
  const config = resolveConfig({})
  assert.equal(config.thresholdTokens, 52000)
})

test('pre-step gate uses the earlier absolute-or-ratio token threshold', () => {
  assert.match(source, /rotationThresholdTokens\(config, pressure\.contextWindow\)/)
  assert.match(source, /Math\.min\(ratioThreshold, config\.thresholdTokens\)/)
  assert.match(source, /projectedTokens < thresholdTokens/)
})

test('generated checkpoint and failed-compaction text is filtered from recovery transcript', () => {
  assert.match(source, /filterGeneratedCheckpointMessages/)
  assert.match(source, /automatically generated checkpoint condensing an earlier span/i)
  assert.match(source, /summary is not smaller than the shadowed content/i)
  assert.match(source, /summarization produced no text summary content/i)
})
