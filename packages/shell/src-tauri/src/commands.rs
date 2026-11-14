use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use reqwest::{header, Method};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{State, WebviewWindow};
use url::Url;

use crate::{
    credentials::{GatewayCredential, OsCredentialStore, SharedCredentialStore},
    origin::{CanonicalOrigin, GatewayTarget},
    stream::{close_origin_streams, StreamRegistry},
};

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

fn append_bounded(body: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), NativeError> {
    if body
        .len()
        .checked_add(chunk.len())
        .is_none_or(|next| next > limit)
    {
        return Err(NativeError::response_too_large());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

async fn read_response_bounded(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, NativeError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(NativeError::response_too_large());
    }
    let mut body = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| NativeError::transport())?;
        append_bounded(&mut body, &chunk, limit)?;
    }
    Ok(body)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub code: &'static str,
    pub message: &'static str,
}

impl NativeError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
    pub fn invalid_origin() -> Self {
        Self::new("invalid-origin", "The gateway origin is invalid")
    }
    pub fn insecure_origin() -> Self {
        Self::new(
            "insecure-origin",
            "HTTP gateways are allowed only on literal loopback addresses",
        )
    }
    pub fn invalid_path() -> Self {
        Self::new(
            "invalid-path",
            "Gateway paths must be safe and root-relative",
        )
    }
    pub fn credential_store() -> Self {
        Self::new("credential-store", "The OS credential store is unavailable")
    }
    pub(crate) fn not_paired() -> Self {
        Self::new("not-paired", "This gateway profile is not paired")
    }
    pub(crate) fn transport() -> Self {
        Self::new("transport-failed", "The gateway request failed")
    }
    pub(crate) fn denied() -> Self {
        Self::new(
            "denied",
            "This document cannot use the native gateway bridge",
        )
    }
    pub(crate) fn invalid_request() -> Self {
        Self::new("invalid-request", "The gateway request is not allowed")
    }
    fn response_too_large() -> Self {
        Self::new(
            "response-too-large",
            "The gateway response exceeded the native limit",
        )
    }
    fn pair_failed() -> Self {
        Self::new(
            "pair-failed",
            "The gateway did not return a valid pairing receipt",
        )
    }
    fn redirect_denied() -> Self {
        Self::new("redirect-denied", "Gateway redirects are not followed")
    }
    pub(crate) fn unknown_stream() -> Self {
        Self::new("unknown-stream", "The native gateway stream is not open")
    }
}

pub struct NativeState {
    pub client: reqwest::Client,
    pub credentials: SharedCredentialStore,
    pub streams: StreamRegistry,
}

impl NativeState {
    pub fn new() -> Result<Self, NativeError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|_| NativeError::transport())?;
        Ok(Self {
            client,
            credentials: Arc::new(OsCredentialStore),
            streams: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairInput {
    pub target: GatewayTarget,
    pub code: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairReceipt {
    pub origin: String,
    pub device: DeviceSummary,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestInput {
    pub target: GatewayTarget,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: Vec<HeaderPair>,
    pub body_base64: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsePayload {
    pub status: u16,
    pub headers: Vec<HeaderPair>,
    pub body_base64: String,
}

#[derive(Deserialize)]
pub struct ForgetInput {
    pub target: GatewayTarget,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetReceipt {
    pub local_removed: bool,
    pub remote_revoked: bool,
}

pub fn trusted_document(label: &str, url: &Url) -> bool {
    if label != "main" {
        return false;
    }
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost"))
            | ("http", Some("tauri.localhost"))
            | ("https", Some("tauri.localhost"))
    )
}

fn confine(window: &WebviewWindow) -> Result<(), NativeError> {
    let url = window.url().map_err(|_| NativeError::denied())?;
    trusted_document(window.label(), &url)
        .then_some(())
        .ok_or_else(NativeError::denied)
}

#[tauri::command]
pub async fn pair(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: PairInput,
) -> Result<PairReceipt, NativeError> {
    confine(&window)?;
    let origin = CanonicalOrigin::parse(&input.target.origin)?;
    if input.code.trim().is_empty() || input.code.len() > 256 {
        return Err(NativeError::invalid_request());
    }
    let response = state
        .client
        .post(origin.request_url("/api/auth/pair")?)
        .header(header::CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({ "code": input.code.trim() }))
        .send()
        .await
        .map_err(|_| NativeError::transport())?;
    if response.status().is_redirection() {
        return Err(NativeError::redirect_denied());
    }
    if !response.status().is_success() {
        return Err(NativeError::pair_failed());
    }
    let headers = response.headers().clone();
    let body = read_response_bounded(response, MAX_RESPONSE_BYTES).await?;
    // Preserve the parsing rule in one helper without retaining the response.
    let (credential, device) = parse_pair_parts(&headers, &body)?;
    if state.credentials.put(&origin, &credential).is_err() {
        let _ = revoke_with_credential(&state.client, &origin, &credential).await;
        return Err(NativeError::credential_store());
    }
    Ok(PairReceipt {
        origin: origin.as_str().to_owned(),
        device,
    })
}

fn parse_pair_parts(
    headers: &header::HeaderMap,
    body: &[u8],
) -> Result<(GatewayCredential, DeviceSummary), NativeError> {
    let mut cookies = Vec::new();
    for value in headers.get_all(header::SET_COOKIE) {
        let raw = value.to_str().map_err(|_| NativeError::pair_failed())?;
        let cookie =
            cookie::Cookie::parse(raw.to_owned()).map_err(|_| NativeError::pair_failed())?;
        if cookie.http_only() == Some(true) && !cookie.value().is_empty() {
            cookies.push(format!("{}={}", cookie.name(), cookie.value()));
        }
    }
    cookies.sort();
    cookies.dedup();
    if cookies.len() != 2 {
        return Err(NativeError::pair_failed());
    }
    #[derive(Deserialize)]
    struct PairBody {
        device: DeviceSummary,
    }
    let pair: PairBody = serde_json::from_slice(body).map_err(|_| NativeError::pair_failed())?;
    Ok((
        GatewayCredential {
            cookie_header: cookies.join("; "),
            device_id: pair.device.id.clone(),
        },
        pair.device,
    ))
}

fn decode_request(input: &RequestInput) -> Result<(Method, Vec<u8>), NativeError> {
    let method =
        Method::from_bytes(input.method.as_bytes()).map_err(|_| NativeError::invalid_request())?;
    if !matches!(
        method,
        Method::GET | Method::HEAD | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return Err(NativeError::invalid_request());
    }
    let body = input
        .body_base64
        .as_deref()
        .map(|value| {
            BASE64
                .decode(value)
                .map_err(|_| NativeError::invalid_request())
        })
        .transpose()?
        .unwrap_or_default();
    if body.len() > MAX_REQUEST_BYTES {
        return Err(NativeError::invalid_request());
    }
    Ok((method, body))
}

fn forbidden_header(name: &str) -> bool {
    matches!(
        name,
        "authorization" | "cookie" | "host" | "origin" | "referer" | "connection" | "upgrade"
    ) || name.starts_with("proxy-")
        || name.starts_with("sec-")
}

#[tauri::command]
pub async fn request(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: RequestInput,
) -> Result<ResponsePayload, NativeError> {
    confine(&window)?;
    let origin = CanonicalOrigin::parse(&input.target.origin)?;
    let credential = state
        .credentials
        .get(&origin)?
        .ok_or_else(NativeError::not_paired)?;
    let (method, body) = decode_request(&input)?;
    let mut request = state
        .client
        .request(method, origin.request_url(&input.path)?)
        .header(header::COOKIE, credential.cookie_header);
    for pair in input.headers {
        let name = pair.name.to_ascii_lowercase();
        if forbidden_header(&name) {
            return Err(NativeError::invalid_request());
        }
        let parsed_name = header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| NativeError::invalid_request())?;
        let parsed_value = header::HeaderValue::from_str(&pair.value)
            .map_err(|_| NativeError::invalid_request())?;
        request = request.header(parsed_name, parsed_value);
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|_| NativeError::transport())?;
    if response.status().is_redirection() {
        return Err(NativeError::redirect_denied());
    }
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter(|(name, _)| *name != header::SET_COOKIE)
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| HeaderPair {
                name: name.as_str().to_owned(),
                value: value.to_owned(),
            })
        })
        .collect();
    let body = read_response_bounded(response, MAX_RESPONSE_BYTES).await?;
    Ok(ResponsePayload {
        status,
        headers,
        body_base64: BASE64.encode(body),
    })
}

async fn revoke_with_credential(
    client: &reqwest::Client,
    origin: &CanonicalOrigin,
    credential: &GatewayCredential,
) -> bool {
    let Ok(url) = origin.request_url(&format!(
        "/api/auth/devices/{}",
        url::form_urlencoded::byte_serialize(credential.device_id.as_bytes()).collect::<String>()
    )) else {
        return false;
    };
    client
        .delete(url)
        .header(header::COOKIE, &credential.cookie_header)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

#[tauri::command]
pub async fn forget(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: ForgetInput,
) -> Result<ForgetReceipt, NativeError> {
    confine(&window)?;
    let origin = CanonicalOrigin::parse(&input.target.origin)?;
    close_origin_streams(&state.streams, &origin);
    // Local removal is the authoritative operation. An unreachable gateway
    // must not retain a keychain credential merely because best-effort remote
    // revocation could not finish.
    let credential = state.credentials.get(&origin)?;
    let local_removed = state.credentials.delete(&origin)?;
    let remote_revoked = match credential {
        Some(credential) => revoke_with_credential(&state.client, &origin, &credential).await,
        None => false,
    };
    Ok(ForgetReceipt {
        local_removed,
        remote_revoked,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        append_bounded, decode_request, forbidden_header, parse_pair_parts, trusted_document,
        HeaderPair, RequestInput,
    };
    use crate::origin::GatewayTarget;
    use reqwest::header::{HeaderMap, HeaderValue, SET_COOKIE};
    use url::Url;

    #[test]
    fn only_the_local_main_document_can_call_native_commands() {
        assert!(trusted_document(
            "main",
            &Url::parse("tauri://localhost/todos").unwrap()
        ));
        assert!(trusted_document(
            "main",
            &Url::parse("http://tauri.localhost/settings").unwrap()
        ));
        assert!(!trusted_document(
            "probe",
            &Url::parse("tauri://localhost/probe.html").unwrap()
        ));
        assert!(!trusted_document(
            "main",
            &Url::parse("http://127.0.0.1:7779/todos").unwrap()
        ));
        assert!(!trusted_document(
            "main",
            &Url::parse("https://example.com/").unwrap()
        ));
    }

    #[test]
    fn pair_receipts_require_two_http_only_cookies_and_never_expose_them() {
        let mut headers = HeaderMap::new();
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("hundredfold_auth=secret; Path=/; HttpOnly; SameSite=Lax"),
        );
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("hundredfold_device=device-1; Path=/; HttpOnly; SameSite=Lax"),
        );
        let body = br#"{"device":{"id":"device-1","name":"Mac app"}}"#;
        let (credential, receipt) = parse_pair_parts(&headers, body).unwrap();
        assert!(credential.cookie_header.contains("secret"));
        assert_eq!(receipt.id, "device-1");
        assert!(!serde_json::to_string(&receipt).unwrap().contains("secret"));
    }

    #[test]
    fn requests_reject_privileged_headers_and_oversized_or_unknown_methods() {
        for name in [
            "cookie",
            "authorization",
            "origin",
            "sec-fetch-site",
            "proxy-authenticate",
        ] {
            assert!(forbidden_header(name));
        }
        let request = |method: &str, body_base64: Option<String>| RequestInput {
            target: GatewayTarget {
                origin: "http://127.0.0.1:7779".into(),
            },
            method: method.into(),
            path: "/api/sessions".into(),
            headers: vec![HeaderPair {
                name: "accept".into(),
                value: "application/json".into(),
            }],
            body_base64,
        };
        assert!(decode_request(&request("GET", None)).is_ok());
        assert!(decode_request(&request("CONNECT", None)).is_err());
        assert!(decode_request(&request("POST", Some("not-base64".into()))).is_err());
    }

    #[test]
    fn response_chunks_are_rejected_before_the_buffer_exceeds_its_limit() {
        let mut body = b"1234".to_vec();
        append_bounded(&mut body, b"56", 6).unwrap();
        assert_eq!(body, b"123456");
        assert!(append_bounded(&mut body, b"7", 6).is_err());
        assert_eq!(body, b"123456");
    }
}
