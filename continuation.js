export function continuationKey(sessionId, turn) {
  return `${String(sessionId)}:${Number(turn)}`
}

export function continuationInstruction(attempt, limit) {
  return [
    '[DSH AUTOMATIC MAX-TOKENS CONTINUATION]',
    `The previous model step reached its output-token ceiling. Automatic continuation ${attempt}/${limit}.`,
    'Continue the same unfinished work from the exact point where the previous response was truncated.',
    'Do not restart the task and do not repeat already completed side effects.',
    'If the previous response was cut while constructing a tool call and that call was not actually executed by Harness, issue the complete tool call again from scratch.',
    'If a tool call already executed and has a recorded result, do not execute it again unless the task itself requires a retry.',
    'Use tools normally when needed. Finish the pending task rather than explaining this continuation notice.',
  ].join('\n')
}


export function subagentFinalizationContinuationInstruction(attempt, limit) {
  return [
    '[DSH SUBAGENT MAX-TOKENS FINALIZATION CONTINUATION]',
    `The previous subagent finalization step reached its output-token ceiling. Automatic continuation ${attempt}/${limit}.`,
    'Continue the SAME concise final report for the parent agent from the exact point where it was truncated.',
    'Do not restart the delegated investigation.',
    'Do not open new analysis branches.',
    'Do not call tools.',
    'Do not repeat already reported findings.',
    'Finish the final report and return control to the parent agent.',
  ].join('\n')
}

export function createFinishTracker() {
  const attempts = new Map()
  const latest = new Map()

  return {
    observe(sessionId, frame) {
      if (!frame || typeof frame !== 'object') return

      const attemptId = String(frame.attemptId ?? '')
      if (frame.type === 'start') {
        attempts.set(attemptId, {
          sessionId: String(sessionId),
          turn: Number(frame.turn),
          step: Number(frame.step),
          finish: undefined,
        })
        return
      }

      const attempt = attempts.get(attemptId)
      if (!attempt) return

      if (frame.type === 'chunk') {
        const chunk = frame.chunk
        if (chunk?.type === 'finish' && typeof chunk.reason?.kind === 'string') {
          attempt.finish = chunk.reason.kind
        }
        return
      }

      if (frame.type === 'end') {
        if (frame.outcome?.kind === 'committed' && attempt.finish) {
          const key = continuationKey(attempt.sessionId, attempt.turn)
          const previous = latest.get(key)
          if (!previous || attempt.step >= previous.step) {
            latest.set(key, { step: attempt.step, kind: attempt.finish })
          }
        }
        attempts.delete(attemptId)
      }
    },

    latest(sessionId, turn) {
      return latest.get(continuationKey(sessionId, turn))
    },

    clearTurn(sessionId, turn) {
      latest.delete(continuationKey(sessionId, turn))
    },

    clearSession(sessionId) {
      const prefix = `${String(sessionId)}:`
      for (const key of latest.keys()) {
        if (key.startsWith(prefix)) latest.delete(key)
      }
      for (const [attemptId, attempt] of attempts.entries()) {
        if (attempt.sessionId === String(sessionId)) attempts.delete(attemptId)
      }
    },
  }
}
