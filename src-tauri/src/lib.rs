use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::{write::GzEncoder, Compression};
use serde::Serialize;
use tauri::http;
use tauri::{AppHandle, Manager};

const APP_PROTOCOL: &str = "ddplatform";
const USE_HTTPS_SCHEME: bool = true;
const ASTRAL_MAGIC: &[u8] = b"ASTRAL1\0";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingBeginResponse {
    session_id: String,
    session_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingChunkResponse {
    file_path: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingFinalizeResponse {
    astral_path: String,
    astral_size: u64,
}

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
fn astral_recording_begin(
    app: AppHandle,
    call_room_id: Option<String>,
) -> Result<AstralRecordingBeginResponse, String> {
    let session_id = create_session_id(call_room_id.as_deref());
    let session_dir = session_dir(&app, &session_id)?;
    fs::create_dir_all(session_dir.join("participants")).map_err(to_io_error)?;

    Ok(AstralRecordingBeginResponse {
        session_id,
        session_dir: path_to_string(&session_dir),
    })
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_write_chunk(
    app: AppHandle,
    session_id: String,
    participant_id: String,
    segment_index: u32,
    mime_type: String,
    started_at_ms: u64,
    chunk_started_at_ms: u64,
    data_base64: String,
) -> Result<AstralRecordingChunkResponse, String> {
    validate_session_id(&session_id)?;
    let session_dir = session_dir(&app, &session_id)?;
    let participant_dir = session_dir
        .join("participants")
        .join(sanitize_path_component(&participant_id));
    fs::create_dir_all(&participant_dir).map_err(to_io_error)?;

    let media_extension = media_extension(&mime_type);
    let file_path = participant_dir.join(format!("{segment_index:06}.{media_extension}"));
    let bytes = STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Invalid recording chunk data: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(to_io_error)?;
    file.write_all(&bytes).map_err(to_io_error)?;

    write_segment_metadata(
        &participant_dir,
        segment_index,
        &participant_id,
        &mime_type,
        started_at_ms,
        chunk_started_at_ms,
    )?;

    let size = fs::metadata(&file_path).map_err(to_io_error)?.len();
    Ok(AstralRecordingChunkResponse {
        file_path: path_to_string(&file_path),
        size,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_write_manifest(
    app: AppHandle,
    session_id: String,
    manifest_json: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    write_manifest(&app, &session_id, &manifest_json)
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_finalize(
    app: AppHandle,
    session_id: String,
    manifest_json: String,
) -> Result<AstralRecordingFinalizeResponse, String> {
    validate_session_id(&session_id)?;
    write_manifest(&app, &session_id, &manifest_json)?;

    let session_dir = session_dir(&app, &session_id)?;
    let astral_path = recordings_root(&app)?.join(format!("{session_id}.astral"));
    let mut package = File::create(&astral_path).map_err(to_io_error)?;
    package.write_all(ASTRAL_MAGIC).map_err(to_io_error)?;

    let mut encoder = GzEncoder::new(package, Compression::default());
    append_directory_to_archive(&mut encoder, &session_dir, &session_dir)?;
    encoder
        .write_all(&0u32.to_le_bytes())
        .map_err(to_io_error)?;
    encoder.finish().map_err(to_io_error)?;

    let astral_size = fs::metadata(&astral_path).map_err(to_io_error)?.len();
    Ok(AstralRecordingFinalizeResponse {
        astral_path: path_to_string(&astral_path),
        astral_size,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_abort(app: AppHandle, session_id: String) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let session_dir = session_dir(&app, &session_id)?;
    if session_dir.exists() {
        fs::remove_dir_all(&session_dir).map_err(to_io_error)?;
    }

    Ok(())
}

fn recordings_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("recordings");
    fs::create_dir_all(&root).map_err(to_io_error)?;
    Ok(root)
}

fn session_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(recordings_root(app)?.join(session_id))
}

fn write_manifest(app: &AppHandle, session_id: &str, manifest_json: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(manifest_json)
        .map_err(|error| format!("Invalid recording manifest: {error}"))?;
    let manifest_path = session_dir(app, session_id)?.join("manifest.json");
    fs::write(manifest_path, manifest_json).map_err(to_io_error)
}

fn write_segment_metadata(
    participant_dir: &Path,
    segment_index: u32,
    participant_id: &str,
    mime_type: &str,
    started_at_ms: u64,
    chunk_started_at_ms: u64,
) -> Result<(), String> {
    let metadata_path = participant_dir.join(format!("{segment_index:06}.json"));
    if metadata_path.exists() {
        return Ok(());
    }

    let metadata = serde_json::json!({
        "participantId": participant_id,
        "segmentIndex": segment_index,
        "mimeType": mime_type,
        "startedAtMs": started_at_ms,
        "firstChunkStartedAtMs": chunk_started_at_ms
    });
    fs::write(
        metadata_path,
        serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
    )
    .map_err(to_io_error)
}

fn append_directory_to_archive<W: Write>(
    writer: &mut W,
    root: &Path,
    dir: &Path,
) -> Result<(), String> {
    let mut entries = fs::read_dir(dir)
        .map_err(to_io_error)?
        .collect::<Result<Vec<_>, io::Error>>()
        .map_err(to_io_error)?;
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            append_directory_to_archive(writer, root, &path)?;
        } else if path.is_file() {
            append_file_to_archive(writer, root, &path)?;
        }
    }

    Ok(())
}

fn append_file_to_archive<W: Write>(
    writer: &mut W,
    root: &Path,
    path: &Path,
) -> Result<(), String> {
    let relative_path = path
        .strip_prefix(root)
        .map_err(|error| format!("Could not calculate archive path: {error}"))?
        .to_string_lossy()
        .replace('\\', "/");
    let relative_bytes = relative_path.as_bytes();
    let file_size = fs::metadata(path).map_err(to_io_error)?.len();
    let path_len =
        u32::try_from(relative_bytes.len()).map_err(|_| "Archive path is too long".to_string())?;

    writer
        .write_all(&path_len.to_le_bytes())
        .map_err(to_io_error)?;
    writer
        .write_all(&file_size.to_le_bytes())
        .map_err(to_io_error)?;
    writer.write_all(relative_bytes).map_err(to_io_error)?;

    let mut file = File::open(path).map_err(to_io_error)?;
    io::copy(&mut file, writer).map_err(to_io_error)?;
    Ok(())
}

fn create_session_id(call_room_id: Option<&str>) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let room_part = call_room_id
        .filter(|room_id| !room_id.trim().is_empty())
        .map(sanitize_path_component)
        .unwrap_or_else(|| "call".to_string());

    format!("astral-{timestamp}-{}-{room_part}", std::process::id())
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > 180
        || !session_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("Invalid recording session id".to_string());
    }

    Ok(())
}

fn sanitize_path_component(value: &str) -> String {
    let mut cleaned = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();

    cleaned.truncate(80);
    while cleaned.ends_with('_') || cleaned.ends_with('-') {
        cleaned.pop();
    }

    if cleaned.is_empty() {
        cleaned = "item".to_string();
    }

    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{cleaned}_{:016x}", hasher.finish())
}

fn media_extension(mime_type: &str) -> &'static str {
    if mime_type.contains("mp4") {
        "mp4"
    } else {
        "webm"
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn to_io_error(error: io::Error) -> String {
    error.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol(APP_PROTOCOL, serve_app_asset)
        .invoke_handler(tauri::generate_handler![
            astral_recording_begin,
            astral_recording_write_chunk,
            astral_recording_write_manifest,
            astral_recording_finalize,
            astral_recording_abort
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
