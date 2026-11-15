import test from 'node:test'
import assert from 'node:assert/strict'
import { isContextOverflowFailure } from '../overflow.js'

test('canonical overflow codes are recognized', () => {
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'CONTEXT_LENGTH', 'CONTEXT_LENGTH_EXCEEDED']) {
    assert.equal(isContextOverflowFailure({code, message: 'x'}), true)
  }
})

test('Strata overflow wording is recognized when flattened to INVALID_REQUEST', () => {
  assert.equal(isContextOverflowFailure({
    code: 'INVALID_REQUEST',
    message: '400: request exceeds the context window: prompt (65772 tokens) leaves no room to answer in the context (65536)',
  }), true)
})

test('unrelated invalid request is not swallowed', () => {
  assert.equal(isContextOverflowFailure({
    code: 'INVALID_REQUEST',
    message: '400 invalid request: unknown field foo',
  }), false)
})
