//! Lifecycle of the `corollary-fm` sidecar (Apple's on-device model and GLM-OCR).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[derive(Clone)]
pub struct Endpoint {
    pub base: String,
    pub token: String,
}

#[derive(Default)]
pub struct Helper {
    inner: Mutex<Option<(Child, Endpoint)>>,
}

/// `COROLLARY_FM`, then the helper's own build folder in debug builds (it has the MLX shader
/// bundle next to it; the sidecar copy in `target/` doesn't), then next to the app binary.
pub fn binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("COROLLARY_FM").map(PathBuf::from) {
        return p.is_file().then_some(p);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../helpers/corollary-fm/.build/release-xc/corollary-fm");
    if cfg!(debug_assertions) && dev.is_file() {
        return Some(dev);
    }
    let bundled = std::env::current_exe().ok()?.parent()?.join("corollary-fm");
    bundled.is_file().then_some(bundled)
}

fn random_token() -> String {
    let mut buf = [0u8; 24];
    getrandom::fill(&mut buf).expect("system RNG");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

impl Helper {
    /// Starts the helper on first use and restarts it if it exited.
    pub fn endpoint(&self, models_dir: &std::path::Path) -> Result<Endpoint, String> {
        let mut guard = self.inner.lock().unwrap();
        if let Some((child, ep)) = guard.as_mut()
            && matches!(child.try_wait(), Ok(None))
        {
            return Ok(ep.clone());
        }
        let bin = binary().ok_or("The on-device AI helper (corollary-fm) isn't installed with this build.")?;
        let token = random_token();
        let mut child = Command::new(&bin)
            .arg("--models-dir")
            .arg(models_dir)
            .arg("--exit-with-stdin")
            .env("COROLLARY_FM_TOKEN", &token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Couldn't start corollary-fm: {e}"))?;
        // A helper that hangs before printing its port mustn't hold the lock forever.
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(line);
        });
        let Ok(line) = rx.recv_timeout(std::time::Duration::from_secs(15)) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The on-device AI helper didn't start in time.".into());
        };
        let port = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|v| v["port"].as_u64())
            .ok_or_else(|| format!("corollary-fm didn't start: {line}"))?;
        let ep = Endpoint { base: format!("http://127.0.0.1:{port}"), token };
        *guard = Some((child, ep.clone()));
        Ok(ep)
    }

    pub fn stop(&self) {
        if let Some((mut child, _)) = self.inner.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        self.stop();
    }
}
