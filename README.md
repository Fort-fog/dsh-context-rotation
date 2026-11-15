# dsh-context-rotation 0.4.1

DeepSeek Harness Desktop context protection for root sessions and local subagents.

## Root sessions

At projected 80% context load, normal project work stops and the old root session prepares a durable Markdown handoff. A fresh root session reads it first and continues.

The primary gate is `agent/pre-step`.

## Provider-side overflow fallback

The final provider prompt can be larger than token-meter pressure because of system prompt, tool schemas, runtime context, and adapter construction.

0.4.1 therefore also handles `agent/request-error`.

For a real context-capacity failure it does not retry the same oversized request. It writes an emergency handoff Markdown from the durable transcript, preserves the latest admitted user request, creates a fresh root session, and lets the old failed turn close.

Recognized canonical codes:
- `CONTEXT_WINDOW_EXCEEDED`
- `CONTEXT_LENGTH`
- `CONTEXT_LENGTH_EXCEEDED`

For `llm-pi-ai`, explicit context-overflow wording is also recognized when a thrown OpenAI-compatible 400 was flattened to `INVALID_REQUEST`. Arbitrary 400 errors are not swallowed.

## Local subagents

Subagents do not create new user-visible chats.

At projected 80%, the child's next long investigation step is replaced with a finalization instruction. It stops expanding analysis and returns a concise report to its parent with verified findings, concrete paths/symbols, uncertainties, and the exact next action.

If a child is already too close to the hard wall, the doomed request is rejected before provider dispatch. If final provider construction still overflows, `agent/request-error` stops the child instead of retrying the same oversized prompt. Normal subagent settlement then reports the child outcome to its parent.

## Model settings

No provider/model/reasoning/context/max-token/sampling/Strata/API settings are changed.

## Logs

```text
dsh-context-rotation: loaded v0.4.1; handoffThreshold=80.0%; emergencyRatio=95.0%
dsh-context-rotation: subagent finalization started ...
dsh-context-rotation: stopping overfull subagent ... before provider
dsh-context-rotation: request-error emergency handoff OLD -> NEW ...
```

MIT.


## 0.4.2 runtime probe

0.4.2 does not change the rotation policy from 0.4.1. It adds one diagnostic file:

```text
/tmp/dsh-context-rotation-runtime.json
```

It is written atomically as soon as `apply()` runs and then updated with counters for:
- `agent/pre-step`
- `agent/assistant-stream`
- `agent/request-error`
- `agent/turn-stopping`
- `session/event`
- `agent/disposed`

Example:

```json
{
  "version": "0.4.2",
  "pid": 12345,
  "apply": true,
  "events": {
    "agent/pre-step": 4,
    "agent/assistant-stream": 28
  },
  "lastEvent": "agent/turn-stopping"
}
```

Probe failures are swallowed and can never change Harness behavior.


## 0.4.3 hard handoff boundary

At the root-session 80% boundary, the old session is now technically frozen:

- `agent/pre-step` never delegates later claimed work back to the normal flow while `phase=planning`;
- `tools/pre-execute` denies every tool call from that old planning session before tool-body execution;
- the model outputs the handoff Markdown as plain text only;
- the plugin collects assistant text, writes `.dsh-handoff/context-handoff-*.md` itself, validates it, then creates the fresh session;
- if the model attempts any tool anyway, that tool is denied and the next pre-step performs deterministic emergency handoff + immediate rotation rather than allowing more old-session work.

This prevents the old chat from "finishing one more code change" after the boundary.


## 0.4.4 — max-output continuation for root and subagents

`agent/turn-stopping` now handles `max-tokens` before the root/subagent split.

This fixes a 0.4.3 bug where local subagents returned early from the hook and therefore never received automatic continuation after an output-token ceiling.

Behavior:
- root `max-tokens` -> automatic `agent.steer()` continuation;
- subagent `max-tokens` -> automatic `agent.steer()` continuation;
- subagent already in 80% finalization -> continuation is restricted to finishing the concise parent report, with no tools or new analysis branches;
- root 80/20 handoff logic remains unchanged.

Runtime probe counters:
- `max-tokens-detected`
- `max-tokens-root`
- `max-tokens-subagent`
- `max-tokens-steered`
- `max-tokens-limit-reached`


## 0.4.5 — max-output continuation moves to a fresh turn

DeepSeek Harness deliberately keeps `max-tokens` sticky for an entire turn:
once any step reaches the output ceiling, later same-turn steps cannot downgrade
that turn's final reason to `completed`.

0.4.4 used `agent.steer()`, which correctly produced more steps but kept them
inside the same sticky turn. 0.4.5 instead queues the continuation with
`agent.followup()`. Harness closes the max-token turn, observes pending
next-turn work, and immediately opens a fresh turn without requiring the user
to type `continue`.

The configured `maxOutputContinuations` limit is tracked across the consecutive
auto-follow-up chain for a session rather than resetting merely because the
continuation moved to another turn.

Runtime probe:
- `max-tokens-detected`
- `max-tokens-root`
- `max-tokens-subagent`
- `max-tokens-followup-queued`
- `max-tokens-limit-reached`
