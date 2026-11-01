mod access;
mod ai;
mod checkpoint;
mod fm;
pub mod latex;
mod project;
mod sandbox;
mod synctex;
pub mod texlive;
mod update;

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn cache_root(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path().app_cache_dir().map_err(err)
}

/// Native pickers. What the user picks becomes usable by the commands below; paths the
/// webview makes up don't (see access.rs).
async fn pick(
    app: AppHandle,
    show: impl FnOnce(tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>) -> Option<tauri_plugin_dialog::FilePath> + Send + 'static,
) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file();
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&w);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || show(dialog)).await.map_err(err)?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    app.state::<access::Access>().choose(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn pick_folder(app: AppHandle, title: String) -> CmdResult<Option<String>> {
    pick(app, move |d| d.set_title(title).blocking_pick_folder()).await
}

#[tauri::command]
async fn pick_file(app: AppHandle, title: String, filter: String, extensions: Vec<String>) -> CmdResult<Option<String>> {
    pick(app, move |d| d.set_title(title).add_filter(filter, &extensions.iter().map(String::as_str).collect::<Vec<_>>()).blocking_pick_file()).await
}

#[tauri::command]
async fn pick_save(app: AppHandle, title: String, file_name: String, filter: String, extensions: Vec<String>) -> CmdResult<Option<String>> {
    pick(app, move |d| {
        d.set_title(title).set_file_name(file_name).add_filter(filter, &extensions.iter().map(String::as_str).collect::<Vec<_>>()).blocking_save_file()
    })
    .await
}

#[tauri::command]
fn open_project(access: State<'_, access::Access>, path: String) -> CmdResult<project::Project> {
    let p = project::open(&access.openable(&path)?).map_err(err)?;
    access.add_project(Path::new(&p.root));
    Ok(p)
}

#[tauri::command]
fn import_zip(access: State<'_, access::Access>, zip_path: String, dest_parent: String) -> CmdResult<project::Project> {
    let dir = project::import_zip(&access.chosen(&zip_path)?, &access.chosen(&dest_parent)?).map_err(err)?;
    let p = project::open(&dir).map_err(err)?;
    access.add_project(Path::new(&p.root));
    Ok(p)
}

#[tauri::command]
fn read_text(access: State<'_, access::Access>, root: String, path: String) -> CmdResult<String> {
    let bytes = std::fs::read(project::resolve(&access.project(&root)?, &path).map_err(err)?).map_err(err)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn rename_path(access: State<'_, access::Access>, root: String, path: String, new_name: String) -> CmdResult<String> {
    project::rename(&access.project(&root)?, &path, &new_name).map_err(err)
}

#[tauri::command]
fn rename_project(access: State<'_, access::Access>, root: String, new_name: String) -> CmdResult<project::Project> {
    let to = project::rename_project(&access.project(&root)?, &new_name).map_err(err)?;
    let p = project::open(&to).map_err(err)?;
    access.add_project(Path::new(&p.root));
    Ok(p)
}

#[tauri::command]
fn write_text(access: State<'_, access::Access>, root: String, path: String, contents: String) -> CmdResult<()> {
    std::fs::write(project::resolve(&access.project(&root)?, &path).map_err(err)?, contents).map_err(err)
}

#[tauri::command]
async fn compile(app: AppHandle, access: State<'_, access::Access>, running: State<'_, Arc<latex::Running>>, root: String, main: String) -> CmdResult<latex::CompileResult> {
    let root = access.project(&root)?;
    let out_dir = latex::build_dir(&cache_root(&app)?, &root);
    let running = Arc::clone(&running);
    tauri::async_runtime::spawn_blocking(move || latex::compile(&root, &main, &out_dir, &running))
        .await
        .map_err(err)
}

#[tauri::command]
fn cancel_compile(running: State<'_, Arc<latex::Running>>) {
    running.cancel();
}

#[tauri::command]
fn read_pdf(app: AppHandle, path: String) -> CmdResult<tauri::ipc::Response> {
    let builds = cache_root(&app)?.join("builds");
    let path = Path::new(&path).canonicalize().map_err(err)?;
    if !path.starts_with(builds.canonicalize().map_err(err)?) {
        return Err("not a build output".into());
    }
    Ok(tauri::ipc::Response::new(std::fs::read(path).map_err(err)?))
}

#[tauri::command]
fn export_zip(access: State<'_, access::Access>, root: String, dest: String) -> CmdResult<()> {
    project::export_zip(&access.project(&root)?, &access.chosen(&dest)?).map_err(err)
}

/// Copies a compiled PDF out of the build cache to where the user chose.
#[tauri::command]
fn save_pdf(app: AppHandle, access: State<'_, access::Access>, pdf: String, dest: String) -> CmdResult<()> {
    let builds = cache_root(&app)?.join("builds").canonicalize().map_err(err)?;
    let pdf = Path::new(&pdf).canonicalize().map_err(err)?;
    if !pdf.starts_with(builds) {
        return Err("not a build output".into());
    }
    std::fs::copy(pdf, access.chosen(&dest)?).map(|_| ()).map_err(err)
}

#[tauri::command]
fn synctex_forward(access: State<'_, access::Access>, root: String, pdf: String, file: String, line: u32) -> Vec<synctex::PdfBox> {
    let (Some(bin), Ok(root)) = (latex::find_tex_bin(), access.project(&root)) else { return vec![] };
    synctex::forward(&bin, Path::new(&pdf), &root, &file, line)
}

#[tauri::command]
fn synctex_inverse(access: State<'_, access::Access>, root: String, pdf: String, page: u32, x: f64, y: f64) -> Option<synctex::SourceLocation> {
    synctex::inverse(&latex::find_tex_bin()?, Path::new(&pdf), &access.project(&root).ok()?, page, x, y)
}

/// Project folder passed on the command line (`corollary ~/papers/thesis`).
#[tauri::command]
fn initial_project(access: State<'_, access::Access>) -> Option<String> {
    let path = std::env::args().nth(1).filter(|a| Path::new(a).is_dir())?;
    access.choose(Path::new(&path));
    Some(path)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TexInstallation {
    bin: String,
    managed: bool,
}

#[tauri::command]
fn tex_installation() -> Option<TexInstallation> {
    latex::find_tex_bin().map(|p| TexInstallation { managed: texlive::is_managed(&p), bin: p.to_string_lossy().into_owned() })
}

#[tauri::command]
async fn texlive_install(on_progress: Channel<texlive::Progress>) -> CmdResult<String> {
    let bin = texlive::install(move |p| {
        let _ = on_progress.send(p);
    })
    .await?;
    Ok(bin.to_string_lossy().into_owned())
}

#[tauri::command]
async fn texlive_install_for(files: Vec<String>, on_progress: Channel<texlive::Progress>) -> CmdResult<Vec<String>> {
    let bin = latex::find_tex_bin().filter(|b| texlive::is_managed(b)).ok_or("Packages can only be installed into Corollary's own TeX Live.")?;
    tauri::async_runtime::spawn_blocking(move || {
        texlive::install_for(&bin, &files, |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(err)?
}

fn data_root(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path().app_data_dir().map_err(err)
}

fn settings_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Value {
    settings_path(app).ok().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
}

fn provider(app: &AppHandle) -> ai::Provider {
    serde_json::from_value(load_settings(app)["provider"].clone()).unwrap_or_default()
}

#[tauri::command]
fn ai_get_provider(app: AppHandle) -> ai::Provider {
    provider(&app)
}

#[tauri::command]
fn ai_set_provider(app: AppHandle, provider: ai::Provider) -> CmdResult<()> {
    let mut s = load_settings(&app);
    s["provider"] = serde_json::to_value(provider).map_err(err)?;
    let path = settings_path(&app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
    std::fs::write(path, serde_json::to_vec_pretty(&s).map_err(err)?).map_err(err)
}

#[tauri::command]
fn ai_set_key(base_url: String, key: Option<String>) -> CmdResult<()> {
    ai::set_key(&base_url, key.as_deref())
}

#[tauri::command]
fn ai_has_key(base_url: String) -> bool {
    ai::get_key(&base_url).is_some()
}

#[tauri::command]
async fn ai_list_models(base_url: String) -> CmdResult<Vec<String>> {
    ai::list_models(&base_url).await
}

fn models_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(data_root(app)?.join("models"))
}

/// What's available on this Mac, for the first-run screen and the model picker.
#[tauri::command]
async fn ai_status(app: AppHandle, helper: State<'_, Arc<fm::Helper>>) -> CmdResult<Value> {
    let helper = Arc::clone(&helper);
    let dir = models_dir(&app)?;
    let ep = tauri::async_runtime::spawn_blocking(move || helper.endpoint(&dir)).await.map_err(err)?;
    let health = match &ep {
        Ok(ep) => ai::helper_get(ep, "/health").await.ok(),
        Err(_) => None,
    };
    let ollama = ai::ollama_models(ai::OLLAMA_URL).await;
    Ok(json!({
        "helper": ep.as_ref().err(),
        "apple": health.as_ref().map(|h| h["apple"].clone()),
        "ocr": health.as_ref().map(|h| h["ocr"].clone()),
        "ollama": ollama,
    }))
}

#[tauri::command]
async fn ai_chat(app: AppHandle, helper: State<'_, Arc<fm::Helper>>, messages: Vec<ai::Message>, max_tokens: u32, on_event: Channel<ai::ChatEvent>) -> CmdResult<String> {
    let provider = provider(&app);
    let helper = Arc::clone(&helper);
    let dir = models_dir(&app)?;
    let target = tauri::async_runtime::spawn_blocking(move || ai::target(&provider, &helper, &dir)).await.map_err(err)??;
    ai::chat(&target, &messages, max_tokens, |text| {
        let _ = on_event.send(ai::ChatEvent::Delta { text: text.to_string() });
    })
    .await
}

/// Image → LaTeX: the on-device model when downloaded, else an Ollama OCR model.
#[tauri::command]
async fn ocr_image(app: AppHandle, helper: State<'_, Arc<fm::Helper>>, image_b64: String) -> CmdResult<String> {
    let helper = Arc::clone(&helper);
    let dir = models_dir(&app)?;
    if let Ok(ep) = tauri::async_runtime::spawn_blocking(move || helper.endpoint(&dir)).await.map_err(err)? {
        let ready = ai::helper_get(&ep, "/health").await.is_ok_and(|h| h["ocr"]["state"] == "ready");
        if ready {
            let r = ai::helper_post(&ep, "/v1/ocr", &json!({ "image": image_b64 })).await?;
            return Ok(r["latex"].as_str().unwrap_or_default().to_string());
        }
    }
    let models = ai::ollama_models(ai::OLLAMA_URL).await.unwrap_or_default();
    if let Some(m) = models.iter().find(|m| m.starts_with(ai::OLLAMA_OCR_MODEL)) {
        return ai::ollama_ocr(ai::OLLAMA_URL, m, &image_b64).await;
    }
    Err("model_missing".into())
}

#[tauri::command]
async fn ocr_download(app: AppHandle, helper: State<'_, Arc<fm::Helper>>) -> CmdResult<Value> {
    let helper = Arc::clone(&helper);
    let dir = models_dir(&app)?;
    let ep = tauri::async_runtime::spawn_blocking(move || helper.endpoint(&dir)).await.map_err(err)??;
    ai::helper_post(&ep, "/v1/ocr/download", &json!({})).await
}

/// A dropped image file, base64-encoded for OCR.
#[tauri::command]
fn read_image_b64(access: State<'_, access::Access>, path: String) -> CmdResult<String> {
    use base64::Engine;
    let p = &access.chosen(&path)?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "bmp"].contains(&ext.as_str()) {
        return Err("not an image".into());
    }
    if p.metadata().map_err(err)?.len() > 32 << 20 {
        return Err("The image is larger than 32 MB.".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(p).map_err(err)?))
}

#[tauri::command]
fn checkpoint_create(app: AppHandle, access: State<'_, access::Access>, root: String, message: String) -> CmdResult<String> {
    let root = &access.project(&root)?;
    checkpoint::create(&checkpoint::store_dir(&data_root(&app)?, root), root, &message).map_err(err)
}

#[tauri::command]
fn checkpoint_list(app: AppHandle, access: State<'_, access::Access>, root: String) -> CmdResult<Vec<checkpoint::Checkpoint>> {
    let root = &access.project(&root)?;
    checkpoint::list(&checkpoint::store_dir(&data_root(&app)?, root), root, 50).map_err(err)
}

#[tauri::command]
fn checkpoint_restore(app: AppHandle, access: State<'_, access::Access>, root: String, id: String) -> CmdResult<()> {
    let root = &access.project(&root)?;
    checkpoint::restore(&checkpoint::store_dir(&data_root(&app)?, root), root, &id).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(access::Access::load(app.path().app_config_dir()?.join("projects.json")));
            update::spawn_check(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // A drop is how the frontend learns a path, so dropped paths count as chosen.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let access = window.state::<access::Access>();
                for p in paths {
                    access.choose(p);
                }
            }
        })
        .manage(Arc::new(latex::Running::default()))
        .manage(Arc::new(fm::Helper::default()))
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            pick_file,
            pick_save,
            open_project,
            import_zip,
            read_text,
            write_text,
            rename_path,
            rename_project,
            compile,
            cancel_compile,
            read_pdf,
            export_zip,
            save_pdf,
            synctex_forward,
            synctex_inverse,
            tex_installation,
            initial_project,
            texlive_install,
            texlive_install_for,
            ai_get_provider,
            ai_set_provider,
            ai_set_key,
            ai_has_key,
            ai_list_models,
            ai_status,
            ai_chat,
            ocr_image,
            ocr_download,
            read_image_b64,
            checkpoint_create,
            checkpoint_list,
            checkpoint_restore,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Arc<fm::Helper>>().stop();
            }
        });
}
