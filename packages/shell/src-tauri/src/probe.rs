//! Running `scripts/refresh-rate-probe.js` inside the shell, without a debugger.
//!
//! The probe prints through `console.log`, which needs the Web Inspector
//! attached to read — fine for a person sitting in front of it, useless as a
//! repeatable measurement. When `HUNDREDFOLD_SHELL_PROBE` is set the shell opens a
//! second window, runs the probe in it, prints what the probe printed to
//! stdout, and quits.
//!
//! That window is a local one rather than the gateway's, for two reasons. A
//! remote page is given no Tauri IPC unless a capability names its origin, and
//! that is not a hole worth opening for an instrument. And the frame clock is a
//! property of the webview, not of the page, so a document with nothing else
//! drawing on it is the cleaner subject.

use tauri::{AppHandle, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const ENV_VAR: &str = "HUNDREDFOLD_SHELL_PROBE";

pub const LABEL: &str = "probe";

/// Compiled in rather than read from disk so the measurement cannot silently
/// run a different file from the one in the repository.
const SOURCE: &str = include_str!("../../scripts/refresh-rate-probe.js");

pub fn requested() -> bool {
    std::env::var_os(ENV_VAR).is_some()
}

pub fn open<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("probe.html".into()))
        .title("Refresh-rate probe")
        .inner_size(480.0, 260.0)
        .build()?;
    Ok(())
}

/// Reporting through the console is what keeps `refresh-rate-probe.js` free of
/// any knowledge of Tauri — it prints, exactly as it would under a debugger,
/// and this wrapper forwards whatever it printed.
pub fn run<R: Runtime>(webview: &tauri::Webview<R>) {
    let mut script = String::from(
        "(() => { const printed = console.log; \
         console.log = (line) => { printed(line); \
         window.__TAURI_INTERNALS__.invoke('report', { line }); };\n",
    );
    script.push_str(SOURCE);
    script.push_str("\n})()");

    if let Err(error) = webview.eval(&script) {
        eprintln!("the probe could not be started: {error}");
    }
}

pub fn trusted_probe_document(label: &str, url: &Url) -> bool {
    label == LABEL
        && matches!(
            (url.scheme(), url.host_str()),
            ("tauri", Some("localhost"))
                | ("http", Some("tauri.localhost"))
                | ("https", Some("tauri.localhost"))
        )
}

#[tauri::command]
pub fn report<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    line: String,
) -> Result<(), &'static str> {
    let url = window.url().map_err(|_| "probe document unavailable")?;
    if !trusted_probe_document(window.label(), &url) {
        return Err("only the local probe document can report");
    }
    println!("{line}");
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::trusted_probe_document;
    use tauri::Url;

    #[test]
    fn only_the_local_probe_document_can_report_and_exit() {
        assert!(trusted_probe_document(
            "probe",
            &Url::parse("tauri://localhost/probe.html").unwrap()
        ));
        assert!(!trusted_probe_document(
            "main",
            &Url::parse("tauri://localhost/probe.html").unwrap()
        ));
        assert!(!trusted_probe_document(
            "probe",
            &Url::parse("https://example.com/probe.html").unwrap()
        ));
    }
}
