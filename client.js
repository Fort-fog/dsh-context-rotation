window.__ModuleLoader__.load({
  id: 'dsh-context-rotation',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const ROTATION_PREFIX = 'dsh-rotate-'
    const inject = ['sessions', 'uiWorkspace']

    function idsFromSnapshot(snapshot) {
      if (!snapshot || !snapshot.byId) return new Set()
      return new Set(Object.keys(snapshot.byId))
    }

    function mainSessionId(snapshot) {
      if (!snapshot || !snapshot.byId) return undefined
      for (const summary of Object.values(snapshot.byId)) {
        if ((summary && summary.retainedBy && summary.retainedBy.mainView || 0) > 0) return summary.id
      }
      return undefined
    }

    function decodeBase64UrlUtf8(value) {
      try {
        const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
        const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
        const binary = atob(padded)
        const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0))
        return new TextDecoder().decode(bytes)
      } catch {
        return undefined
      }
    }

    function sourceIdFromRotationId(id) {
      if (typeof id !== 'string' || !id.startsWith(ROTATION_PREFIX)) return undefined
      const rest = id.slice(ROTATION_PREFIX.length)
      const separator = rest.indexOf('-')
      if (separator <= 0) return undefined

      const encodedLength = Number(rest.slice(0, separator))
      if (!Number.isSafeInteger(encodedLength) || encodedLength <= 0) return undefined

      const encodedStart = separator + 1
      const encodedEnd = encodedStart + encodedLength
      if (encodedEnd >= rest.length || rest[encodedEnd] !== '-') return undefined

      return decodeBase64UrlUtf8(rest.slice(encodedStart, encodedEnd))
    }

    function apply(ctx) {
      let baselineReady = false
      let known = new Set()

      ctx.effect(() => {
        const inspect = () => {
          const snapshot = ctx.sessions.list.getSnapshot()
          const current = idsFromSnapshot(snapshot)

          if (!baselineReady) {
            // Do not jump to historical rollover sessions after refresh. The
            // first ready list becomes a baseline only.
            known = current
            if (snapshot && snapshot.phase === 'ready') baselineReady = true
            return
          }

          const viewedSource = mainSessionId(snapshot)
          for (const id of current) {
            if (known.has(id)) continue
            const sourceId = sourceIdFromRotationId(id)
            if (sourceId === undefined || sourceId !== viewedSource) continue

            try {
              // Only follow a rollover when the user is still viewing the exact
              // source session. Background rotations never steal the main view.
              ctx.uiWorkspace.openSession(id)
            } catch (error) {
              console.warn('[dsh-context-rotation] automatic navigation failed', error)
            }
          }

          known = current
        }

        inspect()
        return ctx.sessions.list.subscribe(inspect)
      }, 'dsh-context-rotation: follow rotated session')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
