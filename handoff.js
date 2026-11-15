function clampText(value, maxChars) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text

  const marker = '\n…[truncated for context rotation]…\n'
  if (maxChars <= marker.length + 2) return text.slice(0, maxChars)

  const usable = maxChars - marker.length
  const head = Math.ceil(usable * 0.72)
  const tail = usable - head
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`
}

function safeJson(value, maxChars) {
  try {
    return clampText(JSON.stringify(value), maxChars)
  } catch {
    return '[unserializable data omitted]'
  }
}

export function contentToText(content, options = {}) {
  const toolLimit = Number.isFinite(options.toolResultExcerptChars)
    ? Math.max(0, Math.floor(options.toolResultExcerptChars))
    : 1200

  if (!Array.isArray(content)) return ''

  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue

    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.trim() !== '') parts.push(block.text)
      continue
    }

    if (block.type === 'tool-call' || block.type === 'tool_use' || block.type === 'tool-call-request') {
      const name = typeof block.name === 'string' ? block.name : 'unknown-tool'
      const args = block.arguments ?? block.input ?? block.args
      const renderedArgs = args === undefined ? '' : ` ${safeJson(args, Math.min(toolLimit, 800))}`
      parts.push(`[tool call: ${name}]${renderedArgs}`)
      continue
    }

    if (block.type === 'tool-result' || block.type === 'tool_result') {
      const name = typeof block.name === 'string' ? block.name : undefined
      const body = block.content ?? block.output ?? block.result ?? block.text
      let rendered = ''
      if (typeof body === 'string') rendered = body
      else if (Array.isArray(body)) rendered = contentToText(body, options)
      else if (body !== undefined) rendered = safeJson(body, toolLimit)
      parts.push(`[tool result${name ? `: ${name}` : ''}] ${clampText(rendered, toolLimit)}`)
      continue
    }

    if (block.type === 'file' || block.type === 'image') {
      const label = typeof block.name === 'string'
        ? block.name
        : typeof block.path === 'string'
          ? block.path
          : block.type
      parts.push(`[${block.type}: ${label}]`)
    }
  }

  return parts.join('\n').trim()
}

function messageText(message, options) {
  if (message === null || typeof message !== 'object') return ''
  return contentToText(message.content, options)
}

function roleOf(message) {
  return typeof message?.role === 'string' ? message.role : 'unknown'
}

function takeNewestWithinBudget(items, budgetChars) {
  const chosen = []
  let used = 0

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.text.length === 0) continue
    const room = budgetChars - used
    if (room <= 0) break
    const text = clampText(item.text, room)
    chosen.push({ ...item, text })
    used += text.length
  }

  chosen.reverse()
  return chosen
}

export function buildHandoff({
  sourceSessionId,
  targetSessionId,
  cwd,
  messages,
  pendingMessages = [],
  options = {},
}) {
  const handoffMaxChars = Number.isFinite(options.handoffMaxChars)
    ? Math.max(4000, Math.floor(options.handoffMaxChars))
    : 24000
  const maxRecentMessages = Number.isFinite(options.maxRecentMessages)
    ? Math.max(4, Math.floor(options.maxRecentMessages))
    : 18
  const userBudgetChars = Number.isFinite(options.userBudgetChars)
    ? Math.max(2000, Math.floor(options.userBudgetChars))
    : 12000
  const recentBudgetChars = Number.isFinite(options.recentBudgetChars)
    ? Math.max(2000, Math.floor(options.recentBudgetChars))
    : 10000

  const visible = Array.isArray(messages) ? messages : []
  const normalized = visible
    .map((message, index) => ({ index, role: roleOf(message), text: messageText(message, options) }))
    .filter(item => item.text.length > 0)

  const users = normalized.filter(item => item.role === 'user')
  const userSelection = takeNewestWithinBudget(users, userBudgetChars)

  // Preserve the very first visible user requirement even when the latest-user
  // budget was consumed by newer instructions.
  if (users.length > 0 && userSelection.every(item => item.index !== users[0].index)) {
    userSelection.unshift({
      ...users[0],
      text: clampText(users[0].text, Math.min(3000, Math.floor(userBudgetChars / 3))),
    })
  }

  const recent = takeNewestWithinBudget(normalized.slice(-maxRecentMessages), recentBudgetChars)
  const pending = (Array.isArray(pendingMessages) ? pendingMessages : [])
    .map((message, index) => ({ index, role: roleOf(message), text: messageText(message, options) }))
    .filter(item => item.text.length > 0)

  const lines = [
    '[DSH CONTEXT ROTATION v1]',
    `Source session: ${sourceSessionId}`,
    `Current session: ${targetSessionId}`,
    `Workspace: ${cwd ?? '(unknown)'}`,
    '',
    'This session is an automatic continuation of the same unfinished task.',
    'Do not restart the project and do not repeat side effects merely because the session id changed.',
    'The filesystem, git status/diff, running processes, and test output are the source of truth. Inspect them before repeating writes, installs, launches, deletes, commits, or other side-effecting operations.',
    'Do not change provider, model, reasoning, context-window, output-token, sampling, Strata, or API settings as part of this rotation.',
    'The handoff is deterministic and intentionally omits bulky historical tool output. Re-read files or rerun safe diagnostics when exact old details are required.',
    '',
    'RETAINED USER REQUIREMENTS:',
  ]

  if (userSelection.length === 0) lines.push('(none recoverable from visible history)')
  for (const item of userSelection) lines.push(`- ${clampText(item.text, 3500)}`)

  lines.push('', 'RECENT WORKING CONTEXT:')
  if (recent.length === 0) lines.push('(none)')
  for (const item of recent) lines.push(`[${item.role}] ${clampText(item.text, 3000)}`)

  if (pending.length > 0) {
    lines.push('', 'INPUT CLAIMED AT THE ROTATION BOUNDARY — HANDLE THIS NOW:')
    for (const item of pending) lines.push(`[${item.role}] ${clampText(item.text, 5000)}`)
  }

  lines.push(
    '',
    'ACTION:',
    'Continue the unfinished work now. Use tools as needed. Do not answer with a recap unless the original task is complete.',
  )

  return clampText(lines.join('\n'), handoffMaxChars)
}

export function resolveConfig(config = {}) {
  const number = (key, fallback, min, max) => {
    const value = Number(config[key])
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }

  return Object.freeze({
    thresholdRatio: number('thresholdRatio', 0.80, 0.25, 0.95),
    thresholdTokens: Math.floor(number('thresholdTokens', 52000, 8000, 1000000)),
    handoffMaxChars: Math.floor(number('handoffMaxChars', 24000, 4000, 100000)),
    maxRecentMessages: Math.floor(number('maxRecentMessages', 18, 4, 100)),
    userBudgetChars: Math.floor(number('userBudgetChars', 12000, 2000, 60000)),
    recentBudgetChars: Math.floor(number('recentBudgetChars', 10000, 2000, 60000)),
    toolResultExcerptChars: Math.floor(number('toolResultExcerptChars', 1200, 0, 10000)),
    maxOutputContinuations: Math.floor(number('maxOutputContinuations', 6, 1, 20)),
    handoffPlanAttempts: Math.floor(number('handoffPlanAttempts', 3, 1, 8)),
    handoffMinChars: Math.floor(number('handoffMinChars', 800, 200, 20000)),
    handoffDirectory: typeof config.handoffDirectory === 'string' && config.handoffDirectory.trim()
      ? config.handoffDirectory.trim()
      : '.dsh-handoff',
    emergencyRatio: number('emergencyRatio', 0.95, 0.82, 1.50),
  })
}
