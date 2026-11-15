import { randomUUID } from 'node:crypto'
import { resolveConfig } from './handoff.js'
import {
  continuationInstruction,
  subagentFinalizationContinuationInstruction,
  continuationKey,
  createFinishTracker,
} from './continuation.js'
import {
  ensureHandoffDirectory,
  handoffPath,
  pendingMessagesText,
  planningInstruction,
  resumeInstruction,
  validateHandoffFile,
  writeEmergencyHandoff,
  subagentFinalizationInstruction,
  modelHandoffText,
  writeModelHandoff,
} from './handoff-plan.js'
import { isContextOverflowFailure } from './overflow.js'
import { createRuntimeProbe } from './runtime-probe.js'

export const name = 'dsh-context-rotation'

const ROTATION_PREFIX = 'dsh-rotate-'

function rotationThresholdTokens(config, contextWindow) {
  const ratioThreshold = Math.floor(contextWindow * config.thresholdRatio)
  return Math.min(ratioThreshold, config.thresholdTokens)
}

function isGeneratedCheckpointText(text) {
  if (typeof text !== 'string') return false
  const value = text.trim()
  if (!value) return false
  return (
    /automatically generated checkpoint condensing an earlier span/i.test(value)
    || /Primary Request and Intent:/i.test(value) && /checkpoint/i.test(value)
    || /summary is not smaller than the shadowed content/i.test(value)
    || /summarization produced no text summary content/i.test(value)
  )
}

function filterGeneratedCheckpointMessages(messages) {
  const source = Array.isArray(messages) ? messages : []
  return source.filter(message => {
    if (message?.role === 'user') return true
    if (!Array.isArray(message?.content)) return true
    const text = message.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
    return !isGeneratedCheckpointText(text)
  })
}

function pluginMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-context-rotation' },
  }
}

function newSessionId(sourceId) {
  const encodedSource = Buffer.from(String(sourceId), 'utf8').toString('base64url')
  return `${ROTATION_PREFIX}${encodedSource.length}-${encodedSource}-${randomUUID()}`
}

function renderError(error) {
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
}

function getService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

async function sourceWorkspace(registry, sourceId, cwd) {
  if (!registry) return undefined
  for (const workspace of registry.list()) {
    if (workspace.sessionIds.includes(sourceId)) return workspace
  }
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  return await registry.resolveByPath(cwd)
}

function currentAgentOptions(agent, modelSelection) {
  const options = { ...agent.options }
  options.provider = modelSelection.provider
  options.model = modelSelection.model

  if (modelSelection.reasoningEffort === undefined) {
    delete options.reasoningEffort
  } else {
    options.reasoningEffort = modelSelection.reasoningEffort
  }

  return options
}

function resolvePreset(agentPresets, agent, session) {
  if (!agentPresets) return session.header?.agentPreset ?? undefined

  try {
    if (typeof agentPresets.composedPreset === 'function') {
      const value = agentPresets.composedPreset(agent.ctx)
      if (value !== undefined && value !== null) return value
    }
  } catch {}

  try {
    if (typeof agentPresets.presetForSession === 'function') {
      const value = agentPresets.presetForSession(session)
      if (value !== undefined && value !== null) return value
    }
  } catch {}

  return session.header?.agentPreset ?? undefined
}

function readPressure(tokenMeter, session) {
  let pressure
  try {
    pressure = tokenMeter.contextPressure(session)
  } catch {
    pressure = undefined
  }

  let contextWindow = Number(pressure?.contextWindow)
  let pressureTokens = Number(pressure?.pressureTokens)

  if (!Number.isFinite(pressureTokens) || pressureTokens < 0) {
    const measurement = tokenMeter.measure(session)
    pressureTokens = Number(measurement.totalTokens)
  }

  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    try {
      contextWindow = Number(session.requestContext?.()?.contextWindow)
    } catch {}
  }

  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  if (!Number.isFinite(pressureTokens) || pressureTokens < 0) return undefined

  return {
    pressureTokens,
    contextWindow,
    ratio: pressureTokens / contextWindow,
  }
}

function estimatePendingTokens(tokenMeter, messages) {
  let total = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    try {
      total += Number(tokenMeter.estimateMessage(message)) || 0
    } catch {}
  }
  return Math.max(0, total)
}

async function createRotatedSession({
  ctx,
  sourceAgent,
  sourceSession,
  modelSelection,
  filePath,
  owned,
  signal,
}) {
  const agents = getService(ctx, 'agents')
  if (!agents) throw new Error('agents service unavailable')

  const cwd = sourceSession.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('session has no cwd')

  const agentPresets = getService(ctx, 'agentPresets')
  const workspaceRegistry = getService(ctx, 'workspaceRegistry')
  const presetId = resolvePreset(agentPresets, sourceAgent, sourceSession)
  const targetId = newSessionId(sourceSession.id)
  const workspace = await sourceWorkspace(workspaceRegistry, sourceSession.id, cwd)

  signal.throwIfAborted()

  const createOptions = {
    sessionId: targetId,
    meta: {
      cwd,
      ...(presetId === undefined ? {} : { agentPreset: presetId }),
    },
    agentOptions: currentAgentOptions(sourceAgent, modelSelection),
    signal,
  }

  if (agentPresets && presetId !== undefined && typeof agentPresets.mount === 'function') {
    createOptions.setup = async (agentCtx) => {
      await agentPresets.mount(agentCtx, presetId)
    }
  }

  const handle = await agents.create(createOptions)
  owned.set(targetId, handle)

  if (workspace !== undefined) {
    try {
      await workspace.attachSession(targetId)
    } catch (error) {
      ctx.logger.warn(
        `dsh-context-rotation: ${targetId} workspace attach failed: ${renderError(error)}`,
      )
    }
  }

  handle.agent.followup(pluginMessage(resumeInstruction(filePath)))
  return { targetId, presetId }
}

export function apply(ctx, rawConfig = {}) {
  const probe = createRuntimeProbe({ version: '0.5.0' })
  const config = resolveConfig(rawConfig)
  const owned = new Map()
  const finishTracker = createFinishTracker()
  const continuationChains = new Map()
  const modelSelectionBySession = new Map()
  const subagentFinalizing = new Set()

  // sourceSessionId -> { phase, filePath, attempts, modelSelection, pressure, pendingText }
  const handoffs = new Map()

  ctx.logger.info(
    `dsh-context-rotation: loaded v0.5.0; `
    + `handoffThreshold=${(config.thresholdRatio * 100).toFixed(1)}%; `
    + `thresholdTokens=${config.thresholdTokens}; `
    + `emergencyRatio=${(config.emergencyRatio * 100).toFixed(1)}%; `
    + `maxOutputContinuations=${config.maxOutputContinuations}`,
  )

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    probe.hit('agent/assistant-stream', { sessionId: agent.session.id, frameType: frame?.type ?? null })
    finishTracker.observe(agent.session.id, frame)
  })

  ctx.on('session/event', (session, event) => {
    probe.hit('session/event', { sessionId: session.id, eventType: event?.type ?? null })
    if (event.type !== 'turn/end') return
    finishTracker.clearTurn(session.id, event.data.turn)

    // Keep the continuation-chain budget across an automatically continued
    // max-token turn. Any other terminal reason ends that chain.
    if (event.data.reason?.kind !== 'max-tokens') {
      continuationChains.delete(session.id)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    probe.hit('agent/disposed', { sessionId: agent?.session?.id ?? null })
    const sessionId = agent?.session?.id
    if (!sessionId) return
    finishTracker.clearSession(sessionId)
    modelSelectionBySession.delete(sessionId)
    subagentFinalizing.delete(sessionId)
    continuationChains.delete(sessionId)
  })

  // Primary rotation gate. This runs before request derivation, so an ordinary user
  // step cannot slip past the handoff boundary and overflow the provider.
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal, modelSelection }, next) => {
    probe.hit('agent/pre-step', { sessionId: agent.session.id, turn, step, pendingMessages: Array.isArray(messages) ? messages.length : 0 })
    const session = agent.session
    modelSelectionBySession.set(session.id, modelSelection)

    const existing = handoffs.get(session.id)
    if (existing?.phase === 'planning') {
      const newlyPending = pendingMessagesText(messages, config)
      if (newlyPending) {
        existing.pendingText = existing.pendingText
          ? `${existing.pendingText}\n\n${newlyPending}`
          : newlyPending
        handoffs.set(session.id, existing)
      }

      // A model that attempts any tool after the rotation boundary has violated the
      // handoff freeze. The tool itself was denied by tools/pre-execute. Do not
      // give the old session another chance to resume work: persist durable
      // recovery state locally and rotate immediately.
      if (existing.toolViolation) {
        try {
          const emergency = writeEmergencyHandoff({
            filePath: existing.filePath,
            sourceSessionId: session.id,
            cwd: session.header?.cwd,
            messages: filterGeneratedCheckpointMessages(session.deriveMessages()),
            pendingMessages: messages,
            pressureTokens: existing.pressure?.projectedTokens ?? existing.pressure?.pressureTokens ?? 0,
            contextWindow: existing.pressure?.contextWindow ?? 65536,
            options: config,
          })
          const rotated = await createRotatedSession({
            ctx,
            sourceAgent: agent,
            sourceSession: session,
            modelSelection: existing.modelSelection ?? modelSelection,
            filePath: existing.filePath,
            owned,
            signal,
          })
          handoffs.set(session.id, {
            ...existing,
            phase: 'rotated',
            targetId: rotated.targetId,
            emergency: true,
            toolViolationRecovery: true,
          })
          ctx.logger.warn(
            `dsh-context-rotation: hard handoff after forbidden tool ${session.id} -> ${rotated.targetId}; `
            + `file=${existing.filePath}; chars=${emergency.chars}`,
          )
          return { kind: 'reject' }
        } catch (error) {
          ctx.logger.error(
            `dsh-context-rotation: forbidden-tool handoff failed for ${session.id}: ${renderError(error)}`,
          )
          return { kind: 'reject' }
        }
      }

      // Never delegate a later claimed user/tool-continuation batch back to the
      // normal agent after the mode switch. Replace it with a text-only planning
      // reminder; tools are independently denied below.
      return {
        kind: 'enter',
        messages: [pluginMessage([
          '[DSH HARD HANDOFF MODE]',
          'The context rotation boundary is already active.',
          'Do not execute project work and do not call tools.',
          `Output the COMPLETE Markdown handoff for: ${existing.filePath}`,
          'The plugin itself will save your text and rotate to a fresh chat.',
          existing.pendingText
            ? `Pending user request to preserve:\n${existing.pendingText}`
            : '',
        ].filter(Boolean).join('\n'))],
        startsRequestSeries: true,
      }
    }
    if (existing?.phase === 'rotated') {
      return { kind: 'reject' }
    }

    const tokenMeter = getService(ctx, 'tokenMeter')
    if (!tokenMeter) {
      ctx.logger.warn(`dsh-context-rotation: skipped ${session.id}: tokenMeter service unavailable`)
      return await next()
    }

    let pressure
    try {
      pressure = readPressure(tokenMeter, session)
    } catch (error) {
      ctx.logger.warn(
        `dsh-context-rotation: pressure read failed for ${session.id}: ${renderError(error)}`,
      )
      return await next()
    }

    if (!pressure) return await next()

    const pendingTokens = estimatePendingTokens(tokenMeter, messages)
    const projectedTokens = pressure.pressureTokens + pendingTokens
    const projectedRatio = projectedTokens / pressure.contextWindow
    const thresholdTokens = rotationThresholdTokens(config, pressure.contextWindow)

    if (projectedTokens < thresholdTokens) return await next()

    if (session.header?.origin === 'subagent') {
      const pendingText = pendingMessagesText(messages, config)

      if (!subagentFinalizing.has(session.id)) {
        if (
          pressure.ratio >= config.emergencyRatio
          || projectedRatio >= 0.985
          || projectedTokens >= pressure.contextWindow
        ) {
          ctx.logger.warn(
            `dsh-context-rotation: stopping overfull subagent ${session.id} before provider; `
            + `projected=${projectedTokens}/${pressure.contextWindow} `
            + `(${(projectedRatio * 100).toFixed(1)}%)`,
          )
          return { kind: 'reject' }
        }

        subagentFinalizing.add(session.id)
        ctx.logger.info(
          `dsh-context-rotation: subagent finalization started for ${session.id}; `
          + `projected=${projectedTokens}/${pressure.contextWindow} `
          + `(${(projectedRatio * 100).toFixed(1)}%)`,
        )

        return {
          kind: 'enter',
          messages: [
            pluginMessage(
              subagentFinalizationInstruction(
                projectedTokens,
                pressure.contextWindow,
                pendingText,
              ),
            ),
          ],
          startsRequestSeries: true,
        }
      }

      if (projectedRatio >= 0.985 || projectedTokens >= pressure.contextWindow) {
        ctx.logger.warn(
          `dsh-context-rotation: finalizing subagent ${session.id} reached hard guard; `
          + `projected=${projectedTokens}/${pressure.contextWindow}`,
        )
        return { kind: 'reject' }
      }

      return await next()
    }

    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      ctx.logger.warn(`dsh-context-rotation: skipped ${session.id}: session has no cwd`)
      return await next()
    }

    const filePath = handoffPath(cwd, session.id, config.handoffDirectory)
    ensureHandoffDirectory(filePath)
    const pendingText = pendingMessagesText(messages, config)

    // Already-overfull or too close to the hard wall: the old model cannot be
    // safely asked to author the handoff. Persist deterministic recovery state
    // and move the claimed user input into the fresh Session via the MD file.
    if (
      pressure.ratio >= config.emergencyRatio
      || projectedRatio >= 0.985
      || projectedTokens >= pressure.contextWindow
    ) {
      try {
        const result = writeEmergencyHandoff({
          filePath,
          sourceSessionId: session.id,
          cwd,
          messages: filterGeneratedCheckpointMessages(session.deriveMessages()),
          pendingMessages: messages,
          pressureTokens: projectedTokens,
          contextWindow: pressure.contextWindow,
          options: config,
        })

        const rotated = await createRotatedSession({
          ctx,
          sourceAgent: agent,
          sourceSession: session,
          modelSelection,
          filePath,
          owned,
          signal,
        })

        handoffs.set(session.id, {
          phase: 'rotated',
          filePath,
          attempts: 0,
          modelSelection,
          pressure,
          pendingText,
          targetId: rotated.targetId,
          emergency: true,
        })

        ctx.logger.warn(
          `dsh-context-rotation: emergency handoff ${session.id} -> ${rotated.targetId}; `
          + `projected=${projectedTokens}/${pressure.contextWindow} `
          + `(${(projectedRatio * 100).toFixed(1)}%); `
          + `file=${filePath}; chars=${result.chars}`,
        )

        // The claimed user input is intentionally not admitted to the old
        // transcript. Its text is durable in the handoff MD and the new Session
        // is already running with an instruction to read that file.
        return { kind: 'reject' }
      } catch (error) {
        ctx.logger.error(
          `dsh-context-rotation: emergency handoff failed for ${session.id}: ${renderError(error)}`,
        )
        // Fail closed near the hard context wall. Sending the original request
        // would merely reproduce a provider 400 and can lose the user's work.
        return { kind: 'reject' }
      }
    }

    // Normal managed handoff path: replace the claimed user batch with a dedicated
    // handoff-planning message. The pending input is embedded verbatim in that
    // instruction so it is not lost when the original claim is not admitted.
    const state = {
      phase: 'planning',
      filePath,
      attempts: 1,
      modelSelection,
      pressure: {
        ...pressure,
        projectedTokens,
        projectedRatio,
      },
      pendingText,
      turn,
      step,
      planningMessageStart: session.deriveMessages().length,
      toolViolation: false,
    }
    handoffs.set(session.id, state)

    ctx.logger.info(
      `dsh-context-rotation: mandatory context handoff started for ${session.id}; `
      + `projected=${projectedTokens}/${pressure.contextWindow} `
      + `(${(projectedRatio * 100).toFixed(1)}%); file=${filePath}`,
    )

    return {
      kind: 'enter',
      messages: [
        pluginMessage(
          planningInstruction(
            filePath,
            projectedTokens,
            pressure.contextWindow,
            pendingText,
          ),
        ),
      ],
      startsRequestSeries: true,
    }
  })

  // Hard freeze: once a root session enters handoff planning, no tool body is
  // allowed to execute in that old session. This is enforcement, not prompting.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = exec?.agent?.session?.id
    if (!sessionId) return await next()

    const state = handoffs.get(sessionId)
    if (state?.phase !== 'planning') return await next()

    state.toolViolation = true
    state.forbiddenTool = exec?.name ?? 'unknown'
    handoffs.set(sessionId, state)
    probe.hit('tools/pre-execute-denied', {
      sessionId,
      tool: exec?.name ?? null,
    })

    ctx.logger.warn(
      `dsh-context-rotation: denied tool during hard handoff ${sessionId}: ${exec?.name ?? 'unknown'}`,
    )

    return {
      kind: 'deny',
      reason: 'Context handoff is mandatory. Project tools are frozen in the old session; output the Markdown handoff as plain text only.',
      info: {
        name: 'dsh-context-rotation',
        code: 'HANDOFF_TOOL_FROZEN',
        reason: 'context rotation boundary is active',
      },
    }
  })

  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    probe.hit('agent/request-error', { sessionId: agent.session.id, code: failure?.code ?? null, message: String(failure?.message ?? '').slice(0, 300) })
    if (!isContextOverflowFailure(failure)) return await next()

    const session = agent.session

    if (session.header?.origin === 'subagent') {
      ctx.logger.warn(
        `dsh-context-rotation: subagent context overflow stopped for ${session.id}; `
        + `code=${failure.code ?? 'unknown'}`,
      )
      return undefined
    }

    if (handoffs.get(session.id)?.phase === 'rotated') return undefined

    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      ctx.logger.error(
        `dsh-context-rotation: request-error overflow recovery skipped ${session.id}: no cwd`,
      )
      return await next()
    }

    const tokenMeter = getService(ctx, 'tokenMeter')
    let pressure
    try {
      pressure = tokenMeter ? readPressure(tokenMeter, session) : undefined
    } catch {
      pressure = undefined
    }

    let contextWindow = Number(pressure?.contextWindow)
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      try {
        contextWindow = Number(session.requestContext?.()?.contextWindow)
      } catch {}
    }
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) contextWindow = 65536

    const pressureTokens = Math.max(
      Number.isFinite(Number(pressure?.pressureTokens)) ? Number(pressure.pressureTokens) : 0,
      contextWindow,
    )

    const filePath = handoffPath(cwd, session.id, config.handoffDirectory)
    const transcript = filterGeneratedCheckpointMessages(session.deriveMessages())
    const lastUser = [...transcript].reverse().find(message => message?.role === 'user')
    const pendingMessages = lastUser ? [lastUser] : []
    const modelSelection = modelSelectionBySession.get(session.id) ?? {
      provider: agent.options?.provider,
      model: agent.options?.model,
      reasoningEffort: agent.options?.reasoningEffort,
    }

    try {
      const emergency = writeEmergencyHandoff({
        filePath,
        sourceSessionId: session.id,
        cwd,
        messages: transcript,
        pendingMessages,
        pressureTokens,
        contextWindow,
        options: config,
      })

      const rotated = await createRotatedSession({
        ctx,
        sourceAgent: agent,
        sourceSession: session,
        modelSelection,
        filePath,
        owned,
        signal,
      })

      handoffs.set(session.id, {
        phase: 'rotated',
        filePath,
        attempts: 0,
        modelSelection,
        pressure,
        pendingText: pendingMessagesText(pendingMessages, config),
        targetId: rotated.targetId,
        emergency: true,
        requestErrorRecovery: true,
      })

      ctx.logger.warn(
        `dsh-context-rotation: request-error emergency handoff ${session.id} -> ${rotated.targetId}; `
        + `code=${failure.code ?? 'unknown'}; file=${filePath}; chars=${emergency.chars}`,
      )

      return undefined
    } catch (error) {
      ctx.logger.error(
        `dsh-context-rotation: request-error emergency handoff failed for `
        + `${session.id}: ${renderError(error)}`,
      )
      return await next()
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    probe.hit('agent/turn-stopping', { sessionId: agent.session.id, turn })
    const session = agent.session
    const isSubagent = session.header?.origin === 'subagent'

    const existing = handoffs.get(session.id)
    const last = finishTracker.latest(session.id, turn)

    if (last?.kind === 'max-tokens') {
      probe.hit('max-tokens-detected', {
        sessionId: session.id,
        turn,
        step: last.step,
        origin: isSubagent ? 'subagent' : 'root',
      })
      probe.hit(
        isSubagent ? 'max-tokens-subagent' : 'max-tokens-root',
        { sessionId: session.id, turn, step: last.step },
      )

      // Harness intentionally keeps max-tokens sticky for the entire turn.
      // Steering another step inside this same turn can continue generation,
      // but it cannot change the final turn/end reason away from max-tokens.
      // Queue a separate follow-up turn instead; the loop closes this sticky
      // turn, sees pending next-turn input, and immediately drives the next one.
      const chain = continuationChains.get(session.id) ?? { count: 0, lastTurn: 0 }
      const used = chain.count

      if (used < config.maxOutputContinuations) {
        signal.throwIfAborted()
        const nextAttempt = used + 1
        continuationChains.set(session.id, { count: nextAttempt, lastTurn: turn })

        const notice = existing?.phase === 'planning'
          ? [
              '[DSH HANDOFF PLAN CONTINUATION]',
              'The previous handoff-planning turn hit the output-token ceiling.',
              `Continue the SAME Markdown handoff for: ${existing.filePath}`,
              'Do not resume project work and do not call tools.',
              'Continue the Markdown text from where it was truncated. The plugin will save it itself.',
            ].join('\n')
          : isSubagent && subagentFinalizing.has(session.id)
            ? subagentFinalizationContinuationInstruction(
                nextAttempt,
                config.maxOutputContinuations,
              )
            : continuationInstruction(nextAttempt, config.maxOutputContinuations)

        agent.followup(pluginMessage(notice))
        probe.hit('max-tokens-followup-queued', {
          sessionId: session.id,
          turn,
          step: last.step,
          continuation: nextAttempt,
          origin: isSubagent ? 'subagent' : 'root',
        })

        ctx.logger.info(
          `dsh-context-rotation: queued next-turn max-tokens continuation for ${session.id}; `
          + `origin=${isSubagent ? 'subagent' : 'root'}; `
          + `turn=${turn}; previousStep=${last.step}; continuation=${nextAttempt}/${config.maxOutputContinuations}`,
        )
        return
      }

      probe.hit('max-tokens-limit-reached', {
        sessionId: session.id,
        turn,
        attempts: used,
        origin: isSubagent ? 'subagent' : 'root',
      })
      ctx.logger.warn(
        `dsh-context-rotation: max-token auto-continuation limit reached for `
        + `${session.id} turn=${turn}; attempts=${used}`,
      )
    } else {
      const chain = continuationChains.get(session.id)
      if (chain && turn > chain.lastTurn) continuationChains.delete(session.id)
    }

    // Subagents use the same max-output continuation path above, but never
    // enter the root-only Markdown handoff / fresh-session rotation path.
    if (isSubagent) return

    if (existing?.phase !== 'planning') return

    const authored = modelHandoffText(
      session.deriveMessages(),
      existing.planningMessageStart ?? 0,
    )
    if (authored) {
      writeModelHandoff(existing.filePath, authored)
    }

    const validation = validateHandoffFile(existing.filePath, config.handoffMinChars)

    if (!validation.ok) {
      existing.attempts += 1
      handoffs.set(session.id, existing)

      const recovery = existing.attempts <= config.handoffPlanAttempts
        ? [
            '[DSH HANDOFF FILE NOT READY]',
            `The required handoff file is not valid yet: ${existing.filePath}`,
            `Validation result: ${validation.reason}`,
            `Attempt ${existing.attempts}/${config.handoffPlanAttempts}.`,
            'MANDATORY HANDOFF MODE IS STILL ACTIVE.',
            'Do not continue project work.',
            'Use the remaining context only to output a COMPLETE corrected Markdown handoff with all required sections.',
            'Do not call tools. The plugin will save the Markdown text itself.',
          ]
        : [
            '[DSH MANDATORY HANDOFF RECOVERY]',
            `The handoff file is still invalid: ${existing.filePath}`,
            `Validation result: ${validation.reason}`,
            'The context rotation boundary has already been crossed, so normal project work MUST NOT resume in this session.',
            'Use this step only to output a minimal but valid COMPLETE Markdown handoff with every required section.',
            'Preserve the pending user request and exact next action.',
            'Do not call tools. The plugin will save the Markdown text itself.',
          ]

      agent.steer(pluginMessage(recovery.join('\n')))

      ctx.logger.warn(
        `dsh-context-rotation: handoff file not ready for ${session.id}; `
        + `reason=${validation.reason}; attempt=${existing.attempts}`,
      )
      return
    }

    try {
      const result = await createRotatedSession({
        ctx,
        sourceAgent: agent,
        sourceSession: session,
        modelSelection: existing.modelSelection,
        filePath: existing.filePath,
        owned,
        signal,
      })

      handoffs.set(session.id, {
        ...existing,
        phase: 'rotated',
        targetId: result.targetId,
      })

      ctx.logger.info(
        `dsh-context-rotation: handoff ready ${session.id}; `
        + `file=${existing.filePath}; chars=${validation.chars}`,
      )
      ctx.logger.info(
        `dsh-context-rotation: rotated ${session.id} -> ${result.targetId}; `
        + `handoffFile=${existing.filePath}; preset=${result.presetId ?? 'none'}`,
      )
    } catch (error) {
      ctx.logger.error(
        `dsh-context-rotation: rotation failed for ${session.id}: ${renderError(error)}`,
      )
      // Keep planning state so a later stop boundary can retry rotation.
    }
  })
}
