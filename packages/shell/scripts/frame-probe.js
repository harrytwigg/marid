/**
 * Frame-timing probe for the bundled native shell.
 *
 * The question it answers: does the same build, served by the same gateway, scroll
 * worse inside the native WebView than it does in the installed PWA? Community
 * reports say yes; this measures it instead of repeating them.
 *
 * Run it unmodified in both. Anything that differs between the two runs other than
 * the WebView invalidates the comparison, which is why this file takes no options
 * and reads nothing from the environment.
 *
 * Usage: attach Safari Web Inspector to the device, open the chat surface, paste
 * this whole file into the console, and copy the single JSON line it prints.
 */
(() => {
  // The chat transcript is the surface the comparison is about, and it is the
  // one element the chat route scrolls. Naming it keeps both runs on the same
  // element instead of whichever overflowing container happens to be mounted.
  const SCROLLER_SELECTOR = '.chat-messages-scroll';
  const DISTANCE_PX = 4000;
  const DURATION_MS = 3000;
  const BASELINE_HZ = 60;
  const BASELINE_INTERVAL_MS = 1000 / BASELINE_HZ;

  function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const rank = (p / 100) * (sorted.length - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  const scroller = document.querySelector(SCROLLER_SELECTOR);

  if (!scroller) {
    console.log(
      JSON.stringify({
        probe: 'frame-probe',
        error: 'no chat transcript on this page',
        selector: SCROLLER_SELECTOR,
        fix: 'open a chat with a long transcript, then run the probe again',
      }),
    );
    return;
  }

  const overflow = scroller.scrollHeight - scroller.clientHeight;

  // A short scroller cannot travel DISTANCE_PX, so the two runs would cover
  // different distances and the numbers would not be comparable. Refuse instead.
  if (overflow < DISTANCE_PX) {
    console.log(
      JSON.stringify({
        probe: 'frame-probe',
        error: 'scroller too short to run a comparable pass',
        needScrollablePx: DISTANCE_PX,
        haveScrollablePx: overflow,
        fix: 'open a longer transcript, then run the probe again',
      }),
    );
    return;
  }

  const startTop = scroller.scrollTop;
  const intervals = [];
  let previousTimestamp = null;
  let startTimestamp = null;

  function step(timestamp) {
    if (startTimestamp === null) {
      startTimestamp = timestamp;
      previousTimestamp = timestamp;
      requestAnimationFrame(step);
      return;
    }

    intervals.push(timestamp - previousTimestamp);
    previousTimestamp = timestamp;

    const elapsed = timestamp - startTimestamp;
    const progress = Math.min(elapsed / DURATION_MS, 1);
    scroller.scrollTop = startTop + DISTANCE_PX * progress;

    if (progress < 1) {
      requestAnimationFrame(step);
      return;
    }

    report(elapsed);
  }

  function report(elapsed) {
    const sorted = intervals.slice().sort((a, b) => a - b);
    // A frame that took longer than one baseline interval displaced the frames
    // that should have filled that gap; count those, not the long frame itself.
    const dropped = intervals.reduce(
      (total, interval) => total + Math.max(0, Math.round(interval / BASELINE_INTERVAL_MS) - 1),
      0,
    );

    console.log(
      JSON.stringify({
        probe: 'frame-probe',
        userAgent: navigator.userAgent,
        // The shell injects this global; the PWA does not. It is how the two runs
        // are told apart after the fact.
        nativeShell: window.__HUNDREDFOLD_NATIVE__?.runtime === 'tauri',
        devicePixelRatio: window.devicePixelRatio,
        distancePx: DISTANCE_PX,
        targetDurationMs: DURATION_MS,
        actualDurationMs: round(elapsed),
        frames: intervals.length,
        p50IntervalMs: round(percentile(sorted, 50)),
        p95IntervalMs: round(percentile(sorted, 95)),
        maxIntervalMs: round(sorted[sorted.length - 1]),
        droppedFrames: dropped,
        baselineHz: BASELINE_HZ,
      }),
    );

    scroller.scrollTop = startTop;
  }

  requestAnimationFrame(step);
})();
