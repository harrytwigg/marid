//! `jinn://` URLs, translated into routes inside the bundled dashboard.

use tauri::{AppHandle, Runtime, Url, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

pub fn route_into<R: Runtime>(app: &AppHandle<R>, window: WebviewWindow<R>) {
    // A cold start delivers the URL before any handler can exist, so the
    // pending one is asked for as well as subscribed to.
    match app.deep_link().get_current() {
        Ok(Some(urls)) => navigate(&window, &urls),
        Ok(None) => {}
        Err(error) => eprintln!("could not read the deep link that started the shell: {error}"),
    }

    app.deep_link()
        .on_open_url(move |event| navigate(&window, &event.urls()));
}

fn navigate<R: Runtime>(window: &WebviewWindow<R>, urls: &[Url]) {
    let Some(link) = urls.first() else { return };

    let current = match window.url() {
        Ok(url) => url,
        Err(error) => {
            eprintln!("could not read the bundled window URL, so {link} cannot open: {error}");
            return;
        }
    };

    let Some(target) = route_on(&current, link) else {
        eprintln!("{link} names no route — expected jinn://<route>, e.g. jinn://org");
        return;
    };

    if let Err(error) = window.navigate(target) {
        eprintln!("could not follow {link}: {error}");
    }
}

/// `jinn://todos/ABC-1` on `tauri://localhost/chat` becomes
/// `tauri://localhost/todos/ABC-1`.
///
/// A custom scheme has no meaningful authority, so the first segment after
/// `//` parses as the host and the rest as the path. Rejoining them is what
/// turns the link back into the route the operator typed.
fn route_on(gateway: &Url, link: &Url) -> Option<Url> {
    let route = link.host_str()?;
    let mut target = gateway.clone();
    target.set_path(&format!("/{route}{}", link.path()));
    target.set_query(link.query());
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::route_on;
    use tauri::Url;

    fn route(link: &str) -> Option<String> {
        let app = Url::parse("tauri://localhost/chat").expect("app URL");
        route_on(&app, &Url::parse(link).expect("link URL")).map(|url| url.to_string())
    }

    #[test]
    fn a_bare_route_becomes_a_path() {
        assert_eq!(
            route("jinn://org").as_deref(),
            Some("tauri://localhost/org")
        );
    }

    #[test]
    fn a_nested_route_keeps_its_segments() {
        assert_eq!(
            route("jinn://todos/ISS-1").as_deref(),
            Some("tauri://localhost/todos/ISS-1")
        );
    }

    #[test]
    fn a_query_survives() {
        assert_eq!(
            route("jinn://logs?level=error").as_deref(),
            Some("tauri://localhost/logs?level=error")
        );
    }

    #[test]
    fn a_link_with_no_route_is_rejected_rather_than_sent_to_the_default() {
        assert_eq!(route("jinn://"), None);
    }
}
