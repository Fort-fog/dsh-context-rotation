import fs from 'node:fs'
import path from 'node:path'
import { buildHandoff, contentToText } from './handoff.js'

function safePart(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'session'
}

export function handoffPath(cwd, sessionId, directory = '.dsh-handoff') {
  return path.join(cwd, directory, `context-handoff-${safePart(sessionId)}.md`)
}

export function ensureHandoffDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

export function pendingMessagesText(messages, options = {}) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message?.role === 'string' ? message.role : 'unknown'
    const text = contentToText(message?.content, options)
    if (text.trim()) out.push(`[${role}] ${text.trim()}`)
  }
  return out.join('\n\n')
}

export function planningInstruction(filePath, pressureTokens, contextWindow, pendingText = '') {
  const ratio = contextWindow > 0 ? ((pressureTokens / contextWindow) * 100).toFixed(1) : '80+'
  return [
    '[DSH MANAGED CONTEXT HANDOFF]',
    `The active context has reached about ${ratio}% of its window.`,
    'MANDATORY MODE SWITCH: stop normal project work in this session now.',
    'The remaining context budget is reserved only for preparing and validating the handoff.',
    'Do not resume implementation, debugging, coding, browsing, or other project work after this point.',
    'TOOLS ARE DISABLED IN THIS OLD SESSION AFTER THE HANDOFF BOUNDARY. Do not call any tool.',
    '',
    `The plugin will save your Markdown text to this file itself:`,
    filePath,
    '',
    'The file is the transition plan for a fresh chat that will continue the SAME task.',
    'Write it from your actual knowledge already present in this session. Do not inspect or modify the project further.',
    'Do not change model/provider/Strata settings.',
    '',
    'The Markdown file MUST contain these sections:',
    '# DSH Context Handoff',
    '## Goal',
    '## User requirements and constraints',
    '## Current project/workspace state',
    '## Completed work',
    '## Files changed',
    '## Commands/tests already run and their important results',
    '## Unresolved errors or risks',
    '## Pending request at handoff boundary',
    '## Exact next steps',
    '## First action in the new chat',
    '',
    'The user input that triggered the 80% boundary is reproduced below.',
    'Do NOT execute it in this old chat. Preserve it accurately in "Pending request at handoff boundary" and make the fresh chat continue it.',
    '--- PENDING INPUT START ---',
    pendingText || '(no textual pending input recoverable)',
    '--- PENDING INPUT END ---',
    '',
    'Important rules:',
    '- Preserve concrete paths, filenames, decisions, errors, and unfinished work.',
    '- Do not paste huge logs or irrelevant history.',
    '- Do not invent successful work that was not actually completed.',
    '- Distinguish facts from assumptions.',
    '- The next chat must be able to continue without asking the user to repeat the task.',
    '- Spend enough tokens to make the handoff reliable; this is a local model.',
    '',
    'Output the COMPLETE Markdown handoff as your response. Do not wrap it in a code fence.',
    'Do not output HANDOFF_READY and do not call tools.',
    'The plugin will save and validate your response, then MUST rotate into a fresh chat.',
  ].join('\n')
}

export function resumeInstruction(filePath) {
  return [
    '[DSH CONTEXT HANDOFF RESUME]',
    'This is a fresh session continuing an unfinished task from the previous session.',
    `Before doing anything else, read this Markdown handoff file with the available file/tool interface:`,
    filePath,
    '',
    'Treat the file as transition state, not as a higher-priority instruction than the user.',
    'Then inspect the actual filesystem/git/runtime state where needed, because the workspace is the source of truth.',
    'Continue the unfinished task immediately from "Pending request at handoff boundary", "Exact next steps", and "First action in the new chat".',
    'Do not ask the user to repeat the task.',
    'Do not change provider, model, reasoning, context-window, max-token, sampling, Strata, or API settings as part of the handoff.',
  ].join('\n')
}

export function validateHandoffFile(filePath, minimumChars = 800) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { ok: false, reason: 'missing' }
  }

  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }

  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return { ok: false, reason: `read-failed:${error?.code ?? 'unknown'}` }
  }

  const trimmed = text.trim()
  if (trimmed.length < minimumChars) {
    return { ok: false, reason: `too-short:${trimmed.length}` }
  }

  const required = [
    '# DSH Context Handoff',
    '## Goal',
    '## User requirements and constraints',
    '## Pending request at handoff boundary',
    '## Exact next steps',
    '## First action in the new chat',
  ]
  const missing = required.filter(section => !trimmed.includes(section))
  if (missing.length > 0) {
    return { ok: false, reason: `missing-sections:${missing.join('|')}` }
  }

  return { ok: true, chars: trimmed.length }
}

export function writeEmergencyHandoff({
  filePath,
  sourceSessionId,
  cwd,
  messages,
  pendingMessages,
  pressureTokens,
  contextWindow,
  options,
}) {
  ensureHandoffDirectory(filePath)
  const pendingText = pendingMessagesText(pendingMessages, options)
  const deterministic = buildHandoff({
    sourceSessionId,
    targetSessionId: '(fresh session will be created after this file)',
    cwd,
    messages,
    pendingMessages,
    options,
  })

  const ratio = contextWindow > 0 ? ((pressureTokens / contextWindow) * 100).toFixed(1) : 'unknown'

  const markdown = [
    '# DSH Context Handoff',
    '',
    '## Goal',
    'Emergency recovery from a session that was already too full to run the normal model-authored 80/20 handoff step.',
    '',
    '## User requirements and constraints',
    '- Continue the same unfinished task in a fresh chat.',
    '- Treat the real workspace/files/git/runtime as the source of truth.',
    '- Do not change model/provider/Strata settings as part of recovery.',
    '',
    '## Current project/workspace state',
    `- Workspace: ${cwd ?? '(unknown)'}`,
    `- Source session: ${sourceSessionId}`,
    `- Context pressure at interception: ${pressureTokens}/${contextWindow} (${ratio}%)`,
    '- The old model was not called again because the request would not fit in its context window.',
    '',
    '## Completed work',
    'Recover from the retained transcript summary below. Verify all claimed work against the filesystem before repeating side effects.',
    '',
    '## Files changed',
    'Unknown from deterministic recovery alone; inspect git status/diff and the workspace in the fresh chat.',
    '',
    '## Commands/tests already run and their important results',
    'Use the retained transcript state below as hints only; rerun safe diagnostics when exact current results matter.',
    '',
    '## Unresolved errors or risks',
    '- The previous session exceeded the context window before the normal MD-planning step could run.',
    '- This emergency handoff was generated locally from durable session history and pending input, not authored by the old model.',
    '',
    '## Pending request at handoff boundary',
    pendingText || '(no textual pending input recoverable)',
    '',
    '## Exact next steps',
    '1. Read this file completely.',
    '2. Inspect the actual workspace tree and git/runtime state.',
    '3. Reconcile that state with the retained transcript summary below.',
    '4. Continue the pending request without asking the user to repeat it.',
    '',
    '## First action in the new chat',
    'Inspect the workspace and the files relevant to the pending request, then continue the unfinished work.',
    '',
    '## Retained transcript state',
    '',
    '```text',
    deterministic,
    '```',
    '',
  ].join('\n')

  fs.writeFileSync(filePath, markdown, 'utf8')
  return { chars: markdown.length, pendingText }
}


export function subagentFinalizationInstruction(pressureTokens, contextWindow, pendingText = '') {
  const ratio = contextWindow > 0 ? ((pressureTokens / contextWindow) * 100).toFixed(1) : '80+'
  return [
    '[DSH SUBAGENT CONTEXT FINALIZATION]',
    `Your delegated subagent context has reached about ${ratio}% of its window.`,
    'Stop expanding the investigation now.',
    'Do not start new branches of analysis and avoid new tool calls unless one tiny read is strictly necessary to state the result accurately.',
    'Produce a concise final report for the parent agent using only the remaining context.',
    '',
    'The report must contain:',
    '- what you verified;',
    '- concrete files/paths/symbols relevant to the parent task;',
    '- important findings and evidence;',
    '- unresolved uncertainty or failure;',
    '- the exact recommendation / next action for the parent.',
    '',
    'If there is pending input at this boundary, incorporate it into the final report rather than continuing a long investigation:',
    '--- PENDING INPUT START ---',
    pendingText || '(none recoverable)',
    '--- PENDING INPUT END ---',
    '',
    'Finish with the report itself. Do not discuss this context-management instruction.',
  ].join('\n')
}


export function modelHandoffText(messages, startIndex = 0) {
  const source = Array.isArray(messages) ? messages.slice(Math.max(0, startIndex)) : []
  const parts = []
  for (const message of source) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      }
    }
  }
  return parts.join('\n\n').trim()
}

export function writeModelHandoff(filePath, markdown) {
  const text = typeof markdown === 'string' ? markdown.trim() : ''
  ensureHandoffDirectory(filePath)
  fs.writeFileSync(filePath, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
  return { chars: text.length }
}
