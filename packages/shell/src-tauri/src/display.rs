//! The display's own maximum frame rate, published to the page.
//!
//! `scripts/refresh-rate-probe.js` measures how fast `requestAnimationFrame`
//! runs. That number alone cannot say whether the webview is capped, because a
//! 60Hz display and a webview pinned to 60 read identically. The comparison
//! needs the display's rate, and no web API exposes it — `screen` carries
//! geometry and colour depth and nothing about timing. AppKit does, so the
//! shell hands it over.

use tauri::{Runtime, Webview};

/// Read by the probe, written by nothing else. `null` when the platform
/// declines to answer, which the probe reports as an unanswerable run rather
/// than as a pass.
const GLOBAL: &str = "__hundredfoldDisplayHz";

pub fn announce_refresh_rate<R: Runtime>(webview: &Webview<R>) {
    let value = match max_frames_per_second() {
        Some(hz) => hz.to_string(),
        None => "null".to_string(),
    };

    if let Err(error) = webview.eval(format!("window.{GLOBAL} = {value}")) {
        eprintln!("could not publish {GLOBAL} to the page, so the probe cannot judge its own reading: {error}");
    }
}

#[cfg(target_os = "macos")]
fn max_frames_per_second() -> Option<i64> {
    use objc2_app_kit::NSScreen;
    use objc2_foundation::MainThreadMarker;

    let screen = NSScreen::mainScreen(MainThreadMarker::new()?)?;

    // AppKit returns 0 when it has no answer. That is a missing reading, not a
    // display that never refreshes, so it must not reach the probe as a number.
    match screen.maximumFramesPerSecond() {
        0 => None,
        rate => Some(rate as i64),
    }
}

#[cfg(not(target_os = "macos"))]
fn max_frames_per_second() -> Option<i64> {
    None
}
