//! The bundled Hundredfold shell shared by desktop, iOS, and Android.

mod commands;
mod credentials;
mod deep_link;
#[cfg(desktop)]
mod display;
#[cfg(desktop)]
mod menu;
mod navigation;
mod origin;
#[cfg(desktop)]
mod probe;
mod stream;

#[cfg(desktop)]
use tauri::webview::PageLoadEvent;
use tauri::{
    utils::config::WebviewUrl,
    webview::{NewWindowResponse, WebviewWindowBuilder},
};
use tauri_plugin_opener::OpenerExt;

const MAIN_WINDOW: &str = "main";

const BRIDGE_SCRIPT: &str = r#"
(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || window.__JINN_NATIVE__) return;
  class Channel {
    constructor(onmessage) {
      this.id = internals.transformCallback((event) => {
        if (Object.prototype.hasOwnProperty.call(event, 'message')) onmessage(event.message);
        if (Object.prototype.hasOwnProperty.call(event, 'end')) internals.unregisterCallback(this.id);
      });
    }
    toJSON() { return `__CHANNEL__:${this.id}`; }
  }
  const invoke = (command, input) => internals.invoke(command, { input });
  Object.defineProperty(window, '__JINN_NATIVE__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      runtime: 'tauri',
      pair: (input) => invoke('pair', input),
      request: (input) => invoke('request', input),
      stream: (input, onEvent) => {
        const on_event = new Channel(onEvent);
        return internals.invoke('stream', { input, onEvent: on_event });
      },
      forget: (input) => invoke('forget', input),
    }),
  });
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let native_state =
        commands::NativeState::new().expect("the native gateway client could not be initialized");
    let builder = tauri::Builder::default()
        .manage(native_state)
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::pair,
        commands::request,
        stream::stream,
        commands::forget,
        probe::report
    ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::pair,
        commands::request,
        stream::stream,
        commands::forget
    ]);

    builder
        .on_page_load(|window, payload| {
            #[cfg(desktop)]
            match payload.event() {
                PageLoadEvent::Started => display::announce_refresh_rate(window),
                PageLoadEvent::Finished if window.label() == probe::LABEL => probe::run(window),
                PageLoadEvent::Finished => {}
            }
            #[cfg(mobile)]
            let _ = (window, payload);
        })
        .setup(|app| {
            let navigation_handle = app.handle().clone();
            let popup_handle = app.handle().clone();
            let window =
                WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                    .title("Hundredfold")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(390.0, 480.0)
                    .initialization_script(BRIDGE_SCRIPT)
                    .on_navigation(move |url| match navigation::decide(url) {
                        navigation::NavigationDecision::Local => true,
                        navigation::NavigationDecision::External => {
                            let _ = navigation_handle
                                .opener()
                                .open_url(url.as_str(), None::<&str>);
                            false
                        }
                        navigation::NavigationDecision::Deny => false,
                    })
                    .on_new_window(move |url, _| {
                        if navigation::decide(&url) == navigation::NavigationDecision::External {
                            let _ = popup_handle.opener().open_url(url.as_str(), None::<&str>);
                        }
                        NewWindowResponse::Deny
                    })
                    .build()?;
            #[cfg(desktop)]
            {
                menu::install(app.handle(), &window)?;
                if probe::requested() {
                    probe::open(app.handle())?;
                }
            }
            deep_link::route_into(app.handle(), window);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Hundredfold shell failed to start");
}
