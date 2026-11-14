/**
 * Refresh-rate probe for the desktop shell spike.
 *
 * The question it answers: does the shell's webview drive requestAnimationFrame
 * at the display's native rate, or is it pinned to 60Hz the way iOS WKWebView
 * was? The research note behind this spike says macOS 26 lifted that cap. This
 * measures it instead of repeating it.
 *
 * A measured rate on its own cannot answer that, because a 60Hz display and a
 * webview pinned to 60 read identically. So the probe refuses to guess: it
 * compares its reading against the display's own maximum, which the shell
 * publishes as `window.__hundredfoldDisplayHz` (see src-tauri/src/display.rs), and says
 * `indeterminate` whenever the two cannot be told apart.
 *
 * This is not `scripts/frame-probe.js`. That one asks whether a
 * WebView scrolls worse than a PWA, against a fixed 60Hz baseline, on the chat
 * transcript. Here 60Hz is the assumption under test, there is nothing to
 * compare against, and no scrolling is involved — the subject is the frame
 * clock, not jank.
 *
 * Usage: run the shell, open the Web Inspector on it from Safari's Develop
 * menu, paste this whole file into the console, and copy the single JSON line
 * it prints.
 */
;(() => {
  const DURATION_MS = 2000
  // Below this fraction of the display's rate, the webview is not keeping up
  // with the panel. At or above it, it is.
  const KEEPING_UP = 0.9
  const CAPPED_HZ = 60
  // A display at or under 60Hz makes the two answers identical, so no run on
  // one can distinguish them however clean its numbers are.
  const DISCRIMINATING_HZ = 61

  function round(value) {
    return Math.round(value * 100) / 100
  }

  /**
   * The verdict, and why. Every branch that cannot separate an uncapped webview
   * from a capped one returns `indeterminate` with the reason, rather than a
   * pass that reads like a measurement.
   */
  function judge(measuredHz, displayHz) {
    if (displayHz === null) {
      return {
        verdict: 'indeterminate',
        reason:
          'the shell published no display rate, so there is nothing to compare the reading against',
      }
    }

    if (displayHz < DISCRIMINATING_HZ) {
      return {
        verdict: 'indeterminate',
        reason: `the display runs at ${displayHz}Hz, so a webview pinned to ${CAPPED_HZ}Hz and one at the display's native rate produce the same reading — this machine cannot answer the question`,
      }
    }

    if (measuredHz >= displayHz * KEEPING_UP) {
      return {
        verdict: 'uncapped',
        reason: `the webview tracked the display's ${displayHz}Hz`,
      }
    }

    if (measuredHz <= CAPPED_HZ * (2 - KEEPING_UP)) {
      return {
        verdict: 'capped',
        reason: `the display offers ${displayHz}Hz and the webview delivered about ${CAPPED_HZ}Hz`,
      }
    }

    return {
      verdict: 'indeterminate',
      reason: `the reading sits between ${CAPPED_HZ}Hz and the display's ${displayHz}Hz, which is neither cap nor native rate — something else was throttling the run`,
    }
  }

  // A requestAnimationFrame loop that changes nothing can legitimately be
  // throttled, which would measure the idle path rather than the drawing one.
  // A one-pixel element moved every frame keeps the compositor honest.
  const marker = document.createElement('div')
  marker.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none'
  document.body.appendChild(marker)

  const intervals = []
  let startTimestamp = null
  let previousTimestamp = null

  function step(timestamp) {
    if (startTimestamp === null) {
      startTimestamp = timestamp
      previousTimestamp = timestamp
      requestAnimationFrame(step)
      return
    }

    intervals.push(timestamp - previousTimestamp)
    previousTimestamp = timestamp

    const elapsed = timestamp - startTimestamp
    marker.style.transform = `translateX(${intervals.length % 2}px)`

    if (elapsed < DURATION_MS) {
      requestAnimationFrame(step)
      return
    }

    report(elapsed)
  }

  function report(elapsed) {
    marker.remove()

    const measuredHz = (intervals.length / elapsed) * 1000
    const displayHz = typeof window.__hundredfoldDisplayHz === 'number' ? window.__hundredfoldDisplayHz : null
    const sorted = intervals.slice().sort((a, b) => a - b)
    const { verdict, reason } = judge(measuredHz, displayHz)

    console.log(
      JSON.stringify({
        probe: 'refresh-rate-probe',
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        measuredRafHz: round(measuredHz),
        displayHz,
        verdict,
        reason,
        frames: intervals.length,
        durationMs: round(elapsed),
        medianIntervalMs: round(sorted[Math.floor(sorted.length / 2)]),
        maxIntervalMs: round(sorted[sorted.length - 1]),
      }),
    )
  }

  requestAnimationFrame(step)
})()
