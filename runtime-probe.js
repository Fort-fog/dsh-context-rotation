import fs from 'node:fs'

export const DEFAULT_RUNTIME_PROBE_PATH = '/tmp/dsh-context-rotation-runtime.json'

function nowIso() {
  return new Date().toISOString()
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

function writeAtomic(filePath, state) {
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, filePath)
}

export function createRuntimeProbe({
  filePath = DEFAULT_RUNTIME_PROBE_PATH,
  version = 'unknown',
} = {}) {
  function update(mutator) {
    try {
      const current = readState(filePath)
      const next = {
        ...current,
        version,
        pid: process.pid,
        updatedAt: nowIso(),
      }
      mutator(next)
      writeAtomic(filePath, next)
    } catch {
      // Diagnostics must never affect Harness behavior.
    }
  }

  update(state => {
    state.apply = true
    state.startedAt ??= nowIso()
    state.events ??= {}
  })

  return {
    hit(name, details = undefined) {
      update(state => {
        state.events ??= {}
        state.events[name] = Number(state.events[name] ?? 0) + 1
        state.lastEvent = name
        state.lastEventAt = nowIso()
        if (details !== undefined) state.lastDetails = details
      })
    },
  }
}
