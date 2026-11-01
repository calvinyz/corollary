//! One OpenAI-compatible client for every model: the on-device helper, Ollama, a custom
//! server (e.g. a GPU box over Tailscale) and BYO-key cloud APIs.

use crate::fm;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

pub const APPLE_MODEL: &str = "apple-on-device";
pub const OLLAMA_URL: &str = "http://127.0.0.1:11434";
const KEYCHAIN_SERVICE: &str = "io.github.calvinyz.corollary";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Provider {
    #[default]
    Apple,
    /// Any OpenAI-compatible server; `base_url` ends in `/v1`.
    #[serde(rename_all = "camelCase")]
    Openai { label: String, base_url: String, model: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ChatEvent {
    Delta { text: String },
}

pub struct Target {
    pub url: String,
    pub model: String,
    pub key: Option<String>,
}

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).read_timeout(timeout).build().unwrap()
}

fn key_account(base_url: &str) -> String {
    reqwest::Url::parse(base_url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| base_url.to_string())
}

pub fn get_key(base_url: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &key_account(base_url)).ok()?.get_password().ok()
}

/// HTTPS, this Mac, or a Tailscale address (WireGuard-encrypted).
fn private_channel(base_url: &str) -> bool {
    use std::net::IpAddr;
    let Ok(u) = reqwest::Url::parse(base_url) else { return false };
    let host = u.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']');
    u.scheme() == "https"
        || host == "localhost"
        || host.ends_with(".ts.net")
        || match host.parse::<IpAddr>() {
            Ok(IpAddr::V4(ip)) => ip.is_loopback() || (ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1])),
            Ok(IpAddr::V6(ip)) => ip.is_loopback(),
            Err(_) => false,
        }
}

/// The saved key for `base_url`, refusing to send it where it could be read in transit.
fn key_for(base_url: &str) -> Result<Option<String>, String> {
    match get_key(base_url) {
        Some(_) if !private_channel(base_url) => Err("Your API key is only sent over https. Change the server address to https://.".into()),
        k => Ok(k),
    }
}

pub fn set_key(base_url: &str, key: Option<&str>) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key_account(base_url)).map_err(|e| e.to_string())?;
    match key.filter(|k| !k.is_empty()) {
        Some(k) => entry.set_password(k).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

pub fn target(provider: &Provider, helper: &fm::Helper, models_dir: &Path) -> Result<Target, String> {
    Ok(match provider {
        Provider::Apple => {
            let ep = helper.endpoint(models_dir)?;
            Target { url: format!("{}/v1", ep.base), model: APPLE_MODEL.into(), key: Some(ep.token) }
        }
        Provider::Openai { base_url, model, .. } => {
            Target { url: base_url.trim_end_matches('/').to_string(), model: model.clone(), key: key_for(base_url)? }
        }
    })
}

fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let msg = v["error"]["message"].as_str().or_else(|| v["error"].as_str()).or_else(|| v["message"].as_str());
    match msg {
        Some(m) => m.to_string(),
        None if body.trim().is_empty() => format!("HTTP {status}"),
        None => format!("HTTP {status}: {}", body.chars().take(300).collect::<String>()),
    }
}

/// Streams the reply through `on_delta` and returns the full text.
pub async fn chat(t: &Target, messages: &[Message], max_tokens: u32, on_delta: impl Fn(&str)) -> Result<String, String> {
    let body = json!({
        "model": t.model,
        "messages": messages,
        "stream": true,
        "temperature": 0.2,
        "max_tokens": max_tokens,
    });
    let mut req = client(Duration::from_secs(300)).post(format!("{}/chat/completions", t.url)).json(&body);
    if let Some(k) = &t.key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(|e| format!("Couldn't reach the model server: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(error_message(status, &resp.text().await.unwrap_or_default()));
    }
    let mut full = String::new();
    let mut buf = Vec::<u8>::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&buf[..nl]).trim().to_string();
            buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                return Ok(full);
            }
            let v: Value = serde_json::from_str(data).map_err(|e| format!("Bad stream data: {e}"))?;
            if let Some(err) = v.get("error") {
                return Err(err["message"].as_str().unwrap_or("The model returned an error").to_string());
            }
            if let Some(text) = v["choices"][0]["delta"]["content"].as_str().filter(|s| !s.is_empty()) {
                full.push_str(text);
                on_delta(text);
            }
        }
    }
    Ok(full)
}

pub async fn list_models(base_url: &str) -> Result<Vec<String>, String> {
    let mut req = client(Duration::from_secs(10)).get(format!("{}/models", base_url.trim_end_matches('/')));
    if let Some(k) = key_for(base_url)? {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_message(status, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
    ids.sort();
    Ok(ids)
}

/// Models pulled into a local Ollama, or `None` when it isn't running.
pub async fn ollama_models(base: &str) -> Option<Vec<String>> {
    let resp = client(Duration::from_secs(2)).get(format!("{base}/api/tags")).send().await.ok()?;
    let v: Value = resp.json().await.ok()?;
    Some(v["models"].as_array()?.iter().filter_map(|m| m["name"].as_str().map(str::to_string)).collect())
}

pub async fn helper_get(ep: &fm::Endpoint, path: &str) -> Result<Value, String> {
    let resp = client(Duration::from_secs(10)).get(format!("{}{path}", ep.base)).bearer_auth(&ep.token).send().await.map_err(|e| e.to_string())?;
    resp.json().await.map_err(|e| e.to_string())
}

pub async fn helper_post(ep: &fm::Endpoint, path: &str, body: &Value) -> Result<Value, String> {
    let resp = client(Duration::from_secs(120)).post(format!("{}{path}", ep.base)).bearer_auth(&ep.token).json(body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_message(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub const OLLAMA_OCR_MODEL: &str = "glm-ocr";

/// Image → LaTeX through an Ollama vision model, for machines without the on-device helper.
pub async fn ollama_ocr(base: &str, model: &str, image_b64: &str) -> Result<String, String> {
    let body = json!({
        "model": model,
        "stream": false,
        "options": { "temperature": 0 },
        "messages": [{ "role": "user", "content": "Formula Recognition:", "images": [image_b64] }],
    });
    let resp = client(Duration::from_secs(180)).post(format!("{base}/api/chat")).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_message(status, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["message"]["content"].as_str().unwrap_or_default().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_json_shape() {
        let p: Provider = serde_json::from_str(r#"{"kind":"openai","label":"Ollama","baseUrl":"http://127.0.0.1:11434/v1","model":"qwen3"}"#).unwrap();
        assert_eq!(p, Provider::Openai { label: "Ollama".into(), base_url: "http://127.0.0.1:11434/v1".into(), model: "qwen3".into() });
        assert_eq!(serde_json::to_string(&Provider::Apple).unwrap(), r#"{"kind":"apple"}"#);
    }

    #[test]
    fn error_messages() {
        let s = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(error_message(s, r#"{"error":{"message":"too long","code":"x"}}"#), "too long");
        assert_eq!(error_message(s, r#"{"error":"model not found"}"#), "model not found");
        assert_eq!(error_message(s, ""), "HTTP 400 Bad Request");
    }

    #[test]
    fn keychain_account_is_host() {
        assert_eq!(key_account("https://api.anthropic.com/v1"), "api.anthropic.com");
    }

    #[test]
    fn keys_only_over_private_channels() {
        assert!(private_channel("https://api.openai.com/v1"));
        assert!(private_channel("http://127.0.0.1:11434/v1"));
        assert!(private_channel("http://[::1]:8000/v1"));
        assert!(private_channel("http://100.101.1.2:8000/v1"));
        assert!(private_channel("http://gpu.tail1234.ts.net:8000/v1"));
        assert!(!private_channel("http://api.openai.com/v1"));
        assert!(!private_channel("http://192.168.1.20:8000/v1"));
    }

    /// Streams from a fake OpenAI server, including a chunk split across reads.
    #[test]
    fn streams_sse() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
            s.write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\ndata: {\"choices\":[{\"del").unwrap();
            s.flush().unwrap();
            std::thread::sleep(Duration::from_millis(50));
            s.write_all(b"ta\":{\"content\":\"lo\"}}]}\n\ndata: [DONE]\n\n").unwrap();
        });
        let t = Target { url: format!("http://127.0.0.1:{port}/v1"), model: "m".into(), key: None };
        let seen = std::sync::Mutex::new(Vec::new());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let out = rt.block_on(chat(&t, &[Message { role: "user".into(), content: "hi".into() }], 64, |d| seen.lock().unwrap().push(d.to_string())));
        assert_eq!(out.unwrap(), "Hello");
        assert_eq!(*seen.lock().unwrap(), vec!["Hel", "lo"]);
    }

    /// Streams a real edit through the app's client:
    /// `COROLLARY_LIVE_URL=http://127.0.0.1:8765/v1 COROLLARY_LIVE_KEY=… cargo test -- --ignored live_chat --nocapture`
    #[test]
    #[ignore]
    fn live_chat() {
        let url = std::env::var("COROLLARY_LIVE_URL").expect("COROLLARY_LIVE_URL");
        let t = Target { url, model: APPLE_MODEL.into(), key: std::env::var("COROLLARY_LIVE_KEY").ok() };
        let msgs = [
            Message { role: "system".into(), content: "Rewrite the LaTeX you're given more concisely. Keep every command and citation. Reply with the text only.".into() },
            Message { role: "user".into(), content: "Writing assistants based on large language models have become common in research workflows~\\citep{smith2024}.".into() },
        ];
        let chunks = std::sync::Mutex::new(0);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let out = rt.block_on(chat(&t, &msgs, 256, |_| *chunks.lock().unwrap() += 1)).unwrap();
        eprintln!("{} chunks: {out}", chunks.lock().unwrap());
        assert!(out.contains("\\citep{smith2024}"));
    }
}
