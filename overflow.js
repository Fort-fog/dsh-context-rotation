export function isContextOverflowFailure(failure) {
  if (!failure || typeof failure !== 'object') return false
  const code = String(failure.code ?? '').toUpperCase()
  if (
    code === 'CONTEXT_WINDOW_EXCEEDED'
    || code === 'CONTEXT_LENGTH'
    || code === 'CONTEXT_LENGTH_EXCEEDED'
  ) return true

  if (code === 'INVALID_REQUEST' || code === 'PI_AI_ERROR' || code === '') {
    const message = String(failure.message ?? '')
    return (
      /request exceeds the context window/i.test(message)
      || /prompt exceeds the context window/i.test(message)
      || /context[_ -]?length[_ -]?exceeded/i.test(message)
      || /maximum context length/i.test(message)
      || /leaves no room to answer in the context/i.test(message)
      || /input token(?:s)? exceed(?:s|ed)? the limit/i.test(message)
    )
  }
  return false
}
