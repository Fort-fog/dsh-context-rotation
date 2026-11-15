import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')

test('rollover message uses a producer-owned v4 source kind', () => {
  assert.match(source, /source:\s*\{\s*kind:\s*['"]plugin:dsh-context-rotation['"]\s*\}/)
  assert.doesNotMatch(source, /kind:\s*['"]plugin['"]/ )
})
