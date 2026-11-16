import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { resolveConfig } from '../handoff.js'
import { rotationThresholdTokens } from '../index.js'

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('provider-specific threshold defaults are resolved', () => {
  const config = resolveConfig({})
  assert.equal(config.thresholdRatio, 0.8)
  assert.equal(config.thresholdTokens, 52000)
  assert.equal(config.largeContextThresholdTokens, 52000)
  assert.equal(config.largeContextMinWindow, 100000)
  assert.equal(config.strataLargeContextThresholdTokens, 100000)
  assert.equal(config.strataLargeContextMinWindow, 100000)
  assert.equal(config.llamaCppThresholdTokens, 50000)
  assert.equal(config.llamaCppMaxWindow, 62000)
})

test('Strata uses 100K on 128K and 131K contexts', () => {
  const config = resolveConfig({})
  assert.equal(rotationThresholdTokens(config, 128000, 'strata'), 100000)
  assert.equal(rotationThresholdTokens(config, 131072, 'strata'), 100000)
  assert.equal(rotationThresholdTokens(config, 131072, 'Strata Local'), 100000)
})

test('Strata keeps ratio guard when 80 percent is earlier than 100K', () => {
  const config = resolveConfig({})
  assert.equal(rotationThresholdTokens(config, 100000, 'strata'), 80000)
})

test('llama.cpp uses 50K through the <=62K context class', () => {
  const config = resolveConfig({})
  assert.equal(rotationThresholdTokens(config, 62000, 'llama.cpp'), 50000)
  assert.equal(rotationThresholdTokens(config, 62000, 'llamacpp'), 50000)
  assert.equal(rotationThresholdTokens(config, 60000, 'llama_cpp'), 50000)
})

test('llama.cpp falls back to ratio when a window is too small for 50K', () => {
  const config = resolveConfig({})
  assert.equal(rotationThresholdTokens(config, 48000, 'llama.cpp'), Math.floor(48000 * 0.8))
})

test('provider-specific thresholds remain configurable', () => {
  const config = resolveConfig({
    strataLargeContextThresholdTokens: 96000,
    llamaCppThresholdTokens: 48000,
  })
  assert.equal(rotationThresholdTokens(config, 131072, 'strata'), 96000)
  assert.equal(rotationThresholdTokens(config, 62000, 'llama.cpp'), 48000)
})

test('other providers keep the existing generic thresholds', () => {
  const config = resolveConfig({})
  assert.equal(rotationThresholdTokens(config, 65536, 'other'), 52000)
  assert.equal(rotationThresholdTokens(config, 131072, 'other'), 52000)
})

test('pre-step gate passes the active provider into threshold selection', () => {
  assert.match(source, /rotationThresholdTokens\(config, pressure\.contextWindow, modelSelection\?\.provider\)/)
  assert.match(source, /projectedTokens < thresholdTokens/)
})

test('generated checkpoint and failed-compaction text is filtered from recovery transcript', () => {
  assert.match(source, /filterGeneratedCheckpointMessages/)
  assert.match(source, /automatically generated checkpoint condensing an earlier span/i)
  assert.match(source, /summary is not smaller than the shadowed content/i)
  assert.match(source, /summarization produced no text summary content/i)
})
