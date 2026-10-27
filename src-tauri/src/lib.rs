use std::borrow::Cow;

use tauri::http;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol(APP_PROTOCOL, serve_app_asset)
        .invoke_handler(tauri::generate_handler![recording_and_streaming_disabled])
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
