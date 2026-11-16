import test from 'node:test'
import assert from 'node:assert/strict'
import { wakeRotatedSession } from '../index.js'

function message() {
  return {
    id: 'resume',
    role: 'user',
    content: [{ type: 'text', text: 'resume' }],
    source: { kind: 'plugin:test' },
  }
}

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('healthy rollover followup runs without an extra wake', async () => {
  const calls = []
  const idle = deferred()
  const resume = message()
  const agent = {
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup(value) {
      calls.push(['followup', value])
      this.inbox.nextTurn.push(value)
      this.status = 'running'
      // Simulate the driver claiming the queued resume before it becomes idle.
      queueMicrotask(() => {
        this.inbox.nextTurn = this.inbox.nextTurn.filter(item => item.id !== value.id)
        this.status = 'idle'
        idle.resolve()
      })
    },
    steer(value) {
      calls.push(['steer', value])
      this.status = 'running'
    },
    whenIdle() { return idle.promise },
  }

  const result = wakeRotatedSession(agent, resume)
  assert.deepEqual(result, { running: true, watchdog: true })
  await idle.promise
  await Promise.resolve()
  assert.deepEqual(calls.map(([kind]) => kind), ['followup'])
})

test('retirement-race watchdog wakes a stranded rollover exactly once', async () => {
  const calls = []
  const idle = deferred()
  const recovered = deferred()
  const resume = message()
  const agent = {
    status: 'running',
    inbox: { nextTurn: [], nextStep: [] },
    followup(value) {
      calls.push(['followup', value])
      // Reproduce the Harness retirement race: the waking message is accepted
      // while status still says running, but the retiring driver never claims it.
      this.inbox.nextTurn.push(value)
    },
    steer(value) {
      calls.push(['steer', value])
      this.inbox.nextStep.push(value)
      this.status = 'running'
    },
    whenIdle() { return idle.promise },
  }

  const result = wakeRotatedSession(agent, resume, recovered.resolve)
  assert.deepEqual(result, { running: true, watchdog: true })
  assert.deepEqual(calls.map(([kind]) => kind), ['followup'])

  agent.status = 'idle'
  idle.resolve()
  const recovery = await recovered.promise
  await Promise.resolve()

  assert.deepEqual(recovery, { recovered: true, reason: 'retirement-race' })
  assert.deepEqual(calls.map(([kind]) => kind), ['followup', 'steer'])
  assert.match(calls[1][1].content[0].text, /HANDOFF WAKE/)
})

test('watchdog does nothing after resume message was already consumed', async () => {
  const calls = []
  const idle = deferred()
  const resume = message()
  const agent = {
    status: 'running',
    inbox: { nextTurn: [], nextStep: [] },
    followup(value) {
      calls.push(['followup', value])
      this.inbox.nextTurn.push(value)
    },
    steer(value) {
      calls.push(['steer', value])
      this.status = 'running'
    },
    whenIdle() { return idle.promise },
  }

  wakeRotatedSession(agent, resume)
  agent.inbox.nextTurn = []
  agent.status = 'idle'
  idle.resolve()
  await idle.promise
  await Promise.resolve()
  assert.deepEqual(calls.map(([kind]) => kind), ['followup'])
})
