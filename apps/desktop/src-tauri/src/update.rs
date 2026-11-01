//! Updates from GitHub Releases. The bundle is replaced in the background and used from the
//! next launch, so a restart can never cost unsaved edits. Packages are verified against the
//! public key in tauri.conf.json, independently of code signing.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

pub fn spawn_check(app: &AppHandle) {
    // Dev builds would replace themselves with the latest release.
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check(&app).await {
            eprintln!("update check failed: {e}");
        }
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else { return Ok(()) };
    update.download_and_install(|_, _| {}, || {}).await?;
    app.dialog()
        .message(format!("Corollary {} is installed. It opens the next time you start Corollary.", update.version))
        .title("Update installed")
        .show(|_| {});
    Ok(())
}
