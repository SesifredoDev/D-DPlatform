use std::borrow::Cow;
use std::fs;
use std::path::PathBuf;
use tauri::{http, Manager};

const APP_PROTOCOL: &str = "astralproject";
const USE_HTTPS_SCHEME: bool = true;

fn serve_app_asset<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    let path = request.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(asset) = ctx
        .app_handle()
        .asset_resolver()
        .get_for_scheme(path.to_string(), USE_HTTPS_SCHEME)
    {
        let mut response =
            http::Response::builder().header(http::header::CONTENT_TYPE, asset.mime_type());

        if let Some(csp) = asset.csp_header() {
            response = response.header(http::header::CONTENT_SECURITY_POLICY, csp);
        }

        response.body(Cow::Owned(asset.bytes)).unwrap()
    } else {
        http::Response::builder()
            .status(http::StatusCode::NOT_FOUND)
            .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Cow::Borrowed(&b"Not Found"[..]))
            .unwrap()
    }
}

#[tauri::command(rename_all = "camelCase")]
fn recording_and_streaming_disabled() -> bool {
    true
}

// Helper to resolve and ensure the homebrew-packs storage directory exists
fn get_homebrew_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let homebrew_dir = app_dir.join("homebrew-packs");
    if !homebrew_dir.exists() {
        fs::create_dir_all(&homebrew_dir).map_err(|e| e.to_string())?;
    }
    Ok(homebrew_dir)
}

#[tauri::command(rename_all = "camelCase")]
fn get_homebrew_packs(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = get_homebrew_dir(&app)?;
    let mut packs = Vec::new();

    if dir.exists() {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
                packs.push(content);
            }
        }
    }
    Ok(packs)
}

#[tauri::command(rename_all = "camelCase")]
fn save_homebrew_pack(app: tauri::AppHandle, pack_id: String, pack_json: String) -> Result<(), String> {
    let dir = get_homebrew_dir(&app)?;
    let file_path = dir.join(format!("{}.json", pack_id));
    fs::write(file_path, pack_json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn delete_homebrew_pack(app: tauri::AppHandle, pack_id: String) -> Result<(), String> {
    let dir = get_homebrew_dir(&app)?;
    let file_path = dir.join(format!("{}.json", pack_id));
    if file_path.exists() {
        fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol(APP_PROTOCOL, serve_app_asset)
        .invoke_handler(tauri::generate_handler![
            recording_and_streaming_disabled,
            get_homebrew_packs,
            save_homebrew_pack,
            delete_homebrew_pack
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
