use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use tauri::http;
use tauri::{AppHandle, Emitter, Manager};

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingExportResponse {
    saved_path: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingImportBeginResponse {
    session_id: String,
    package_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingImportResponse {
    session_id: String,
    session_dir: String,
    package_path: String,
    package_size: u64,
    manifest: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingOptimizeOptions {
    target_video_bitrate_kbps: Option<u32>,
    target_audio_bitrate_kbps: Option<u32>,
    max_height: Option<u32>,
    keep_original: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingOptimizeProgress {
    job_id: String,
    stage: String,
    message: String,
    current: u32,
    total: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingOptimizeResponse {
    job_id: String,
    original_path: String,
    optimized_path: String,
    original_size: u64,
    optimized_size: u64,
    segment_count: u32,
    optimized_segment_count: u32,
    skipped_segment_count: u32,
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
    let astral_size = write_astral_package_from_dir(&session_dir, &astral_path)?;
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

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_export_package(
    app: AppHandle,
    package_path: String,
) -> Result<AstralRecordingExportResponse, String> {
    let source_path = PathBuf::from(package_path);
    validate_astral_package_extension(&source_path)?;

    let source_path = source_path.canonicalize().map_err(to_io_error)?;
    let recordings_root = recordings_root(&app)?.canonicalize().map_err(to_io_error)?;
    if !source_path.starts_with(&recordings_root) {
        return Err("Recording package is outside the managed recordings directory.".to_string());
    }

    if !source_path.is_file() {
        return Err("Recording package was not found.".to_string());
    }

    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("Could not resolve downloads directory: {error}"))?;
    fs::create_dir_all(&downloads_dir).map_err(to_io_error)?;

    let source_file_name = source_path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or("recording.astral");
    let destination_path = unique_export_path(&downloads_dir, source_file_name);
    fs::copy(&source_path, &destination_path).map_err(to_io_error)?;

    let size = fs::metadata(&destination_path).map_err(to_io_error)?.len();
    Ok(AstralRecordingExportResponse {
        saved_path: path_to_string(&destination_path),
        size,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_import_package(
    app: AppHandle,
    package_path: String,
) -> Result<AstralRecordingImportResponse, String> {
    let source_path = PathBuf::from(package_path);
    validate_astral_package_extension(&source_path)?;
    let source_path = source_path.canonicalize().map_err(to_io_error)?;
    if !source_path.is_file() {
        return Err("Recording package was not found.".to_string());
    }

    let session_id =
        create_import_session_id(source_path.file_name().and_then(|name| name.to_str()));
    let managed_package_path = recording_package_path(&app, &session_id)?;
    fs::copy(&source_path, &managed_package_path).map_err(to_io_error)?;
    match extract_astral_package(&app, &session_id) {
        Ok(response) => Ok(response),
        Err(error) => {
            let _ = cleanup_import_session(&app, &session_id);
            Err(error)
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_import_begin(
    app: AppHandle,
    file_name: String,
) -> Result<AstralRecordingImportBeginResponse, String> {
    let source_name = Path::new(&file_name);
    validate_astral_package_extension(source_name)?;

    let session_id =
        create_import_session_id(source_name.file_name().and_then(|name| name.to_str()));
    let package_path = recording_package_path(&app, &session_id)?;
    File::create(&package_path).map_err(to_io_error)?;

    Ok(AstralRecordingImportBeginResponse {
        session_id,
        package_path: path_to_string(&package_path),
    })
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_import_write_chunk(
    app: AppHandle,
    session_id: String,
    data_base64: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let package_path = recording_package_path(&app, &session_id)?;
    validate_astral_package_extension(&package_path)?;

    let bytes = STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Invalid Astral package data: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(package_path)
        .map_err(to_io_error)?;
    file.write_all(&bytes).map_err(to_io_error)
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_import_finalize(
    app: AppHandle,
    session_id: String,
) -> Result<AstralRecordingImportResponse, String> {
    validate_session_id(&session_id)?;
    extract_astral_package(&app, &session_id)
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_import_abort(app: AppHandle, session_id: String) -> Result<(), String> {
    validate_session_id(&session_id)?;
    cleanup_import_session(&app, &session_id)
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_optimize_package(
    app: AppHandle,
    job_id: String,
    package_path: String,
    options: AstralRecordingOptimizeOptions,
) -> Result<AstralRecordingOptimizeResponse, String> {
    validate_session_id(&job_id)?;
    let source_path = PathBuf::from(package_path);
    validate_astral_package_extension(&source_path)?;
    let source_path = source_path.canonicalize().map_err(to_io_error)?;
    let recordings_root = recordings_root(&app)?.canonicalize().map_err(to_io_error)?;
    if !source_path.starts_with(&recordings_root) {
        return Err("Recording package is outside the managed recordings directory.".to_string());
    }

    if !source_path.is_file() {
        return Err("Recording package was not found.".to_string());
    }

    let original_size = fs::metadata(&source_path).map_err(to_io_error)?.len();
    let work_dir = recordings_root.join("optimization").join(&job_id);
    if work_dir.exists() {
        fs::remove_dir_all(&work_dir).map_err(to_io_error)?;
    }
    fs::create_dir_all(&work_dir).map_err(to_io_error)?;

    let result = optimize_astral_package_in_work_dir(&app, &job_id, &source_path, &work_dir, options, original_size);
    let cleanup_result = fs::remove_dir_all(&work_dir).map_err(to_io_error);
    match (result, cleanup_result) {
        (Ok(response), _) => Ok(response),
        (Err(error), _) => Err(error),
    }
}

fn optimize_astral_package_in_work_dir(
    app: &AppHandle,
    job_id: &str,
    source_path: &Path,
    work_dir: &Path,
    options: AstralRecordingOptimizeOptions,
    original_size: u64,
) -> Result<AstralRecordingOptimizeResponse, String> {
    emit_optimize_progress(
        app,
        job_id,
        "extracting",
        "Extracting Astral package",
        0,
        0,
    );
    extract_astral_archive_to_dir(source_path, work_dir)?;

    emit_optimize_progress(
        app,
        job_id,
        "scanning",
        "Finding media segments",
        0,
        0,
    );
    let segments = collect_optimizable_media_segments(work_dir)?;
    let total_segments = u32::try_from(segments.len()).unwrap_or(u32::MAX);
    let target_video_bitrate_kbps = options.target_video_bitrate_kbps.unwrap_or(1200).max(250);
    let target_audio_bitrate_kbps = options.target_audio_bitrate_kbps.unwrap_or(96).max(32);
    let max_height = options.max_height.unwrap_or(720).max(240);
    let ffmpeg_command = resolve_media_tool_command(app, "ffmpeg");
    let ffprobe_command = resolve_media_tool_command(app, "ffprobe");
    let mut optimized_segment_count = 0u32;
    let mut skipped_segment_count = 0u32;

    for (index, segment_path) in segments.iter().enumerate() {
        let current = u32::try_from(index + 1).unwrap_or(u32::MAX);
        emit_optimize_progress(
            app,
            job_id,
            "optimizing",
            &format!("Optimizing segment {current} of {total_segments}"),
            current,
            total_segments,
        );

        match optimize_media_segment(
            segment_path,
            &ffmpeg_command,
            &ffprobe_command,
            target_video_bitrate_kbps,
            target_audio_bitrate_kbps,
            max_height,
        ) {
            Ok(true) => optimized_segment_count = optimized_segment_count.saturating_add(1),
            Ok(false) => skipped_segment_count = skipped_segment_count.saturating_add(1),
            Err(error) => {
                return Err(format!(
                    "Could not optimize {}: {error}",
                    segment_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("media segment")
                ));
            }
        }
    }

    emit_optimize_progress(
        app,
        job_id,
        "packaging",
        "Writing optimized Astral package",
        total_segments,
        total_segments,
    );

    let keep_original = options.keep_original.unwrap_or(true);
    let output_path = if keep_original {
        unique_optimized_package_path(source_path)
    } else {
        source_path.with_extension("optimized.tmp.astral")
    };
    let optimized_size = write_astral_package_from_dir(work_dir, &output_path)?;
    let optimized_path = if keep_original {
        output_path
    } else {
        fs::remove_file(source_path).map_err(to_io_error)?;
        fs::rename(&output_path, source_path).map_err(to_io_error)?;
        source_path.to_path_buf()
    };

    emit_optimize_progress(
        app,
        job_id,
        "completed",
        "Astral optimization complete",
        total_segments,
        total_segments,
    );

    Ok(AstralRecordingOptimizeResponse {
        job_id: job_id.to_string(),
        original_path: path_to_string(source_path),
        optimized_path: path_to_string(&optimized_path),
        original_size,
        optimized_size,
        segment_count: total_segments,
        optimized_segment_count,
        skipped_segment_count,
    })
}

fn cleanup_import_session(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let package_path = recording_package_path(&app, &session_id)?;
    if package_path.exists() {
        fs::remove_file(package_path).map_err(to_io_error)?;
    }

    let session_dir = session_dir(&app, &session_id)?;
    if session_dir.exists() {
        fs::remove_dir_all(session_dir).map_err(to_io_error)?;
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

fn recording_package_path(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(recordings_root(app)?.join(format!("{session_id}.astral")))
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

fn write_astral_package_from_dir(session_dir: &Path, astral_path: &Path) -> Result<u64, String> {
    let mut package = File::create(astral_path).map_err(to_io_error)?;
    package.write_all(ASTRAL_MAGIC).map_err(to_io_error)?;

    let mut encoder = GzEncoder::new(package, Compression::default());
    append_directory_to_archive(&mut encoder, session_dir, session_dir)?;
    encoder
        .write_all(&0u32.to_le_bytes())
        .map_err(to_io_error)?;
    encoder.finish().map_err(to_io_error)?;

    fs::metadata(astral_path)
        .map(|metadata| metadata.len())
        .map_err(to_io_error)
}

fn extract_astral_package(
    app: &AppHandle,
    session_id: &str,
) -> Result<AstralRecordingImportResponse, String> {
    validate_session_id(session_id)?;
    let package_path = recording_package_path(app, session_id)?;
    validate_astral_package_extension(&package_path)?;
    if !package_path.is_file() {
        return Err("Recording package was not found.".to_string());
    }

    let session_dir = session_dir(app, session_id)?;
    if session_dir.exists() {
        fs::remove_dir_all(&session_dir).map_err(to_io_error)?;
    }
    fs::create_dir_all(&session_dir).map_err(to_io_error)?;

    let manifest = extract_astral_archive_to_dir(&package_path, &session_dir)?;
    let package_size = fs::metadata(&package_path).map_err(to_io_error)?.len();

    Ok(AstralRecordingImportResponse {
        session_id: session_id.to_string(),
        session_dir: path_to_string(&session_dir),
        package_path: path_to_string(&package_path),
        package_size,
        manifest,
    })
}

fn extract_astral_archive_to_dir(
    package_path: &Path,
    session_dir: &Path,
) -> Result<serde_json::Value, String> {
    let mut package = File::open(package_path).map_err(to_io_error)?;
    let mut magic = vec![0u8; ASTRAL_MAGIC.len()];
    package.read_exact(&mut magic).map_err(to_io_error)?;
    if magic != ASTRAL_MAGIC {
        return Err("Invalid .astral recording package.".to_string());
    }

    let mut decoder = GzDecoder::new(package);
    loop {
        let mut path_len_bytes = [0u8; 4];
        decoder
            .read_exact(&mut path_len_bytes)
            .map_err(to_io_error)?;
        let path_len = u32::from_le_bytes(path_len_bytes);
        if path_len == 0 {
            break;
        }
        if path_len > 4096 {
            return Err("Astral package contains a path that is too long.".to_string());
        }

        let mut file_size_bytes = [0u8; 8];
        decoder
            .read_exact(&mut file_size_bytes)
            .map_err(to_io_error)?;
        let file_size = u64::from_le_bytes(file_size_bytes);

        let mut relative_path_bytes = vec![0u8; path_len as usize];
        decoder
            .read_exact(&mut relative_path_bytes)
            .map_err(to_io_error)?;
        let relative_path = String::from_utf8(relative_path_bytes)
            .map_err(|error| format!("Invalid archive path encoding: {error}"))?;
        let normalized_relative_path = normalize_archive_relative_path(&relative_path)?;
        let destination_path = session_dir.join(normalized_relative_path);

        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).map_err(to_io_error)?;
        }

        let mut destination = File::create(&destination_path).map_err(to_io_error)?;
        let mut content = Read::by_ref(&mut decoder).take(file_size);
        let copied = io::copy(&mut content, &mut destination).map_err(to_io_error)?;
        if copied != file_size {
            return Err("Astral package ended before a file was fully read.".to_string());
        }
    }

    let manifest_path = session_dir.join("manifest.json");
    let manifest_json = fs::read_to_string(manifest_path).map_err(to_io_error)?;
    serde_json::from_str::<serde_json::Value>(&manifest_json)
        .map_err(|error| format!("Invalid recording manifest: {error}"))
}

fn collect_optimizable_media_segments(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut segments = Vec::new();
    collect_optimizable_media_segments_recursive(root, &mut segments)?;
    segments.sort();
    Ok(segments)
}

fn collect_optimizable_media_segments_recursive(
    dir: &Path,
    segments: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(to_io_error)? {
        let entry = entry.map_err(to_io_error)?;
        let path = entry.path();
        if path.is_dir() {
            collect_optimizable_media_segments_recursive(&path, segments)?;
            continue;
        }

        if path.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("webm"))
        {
            segments.push(path);
        }
    }

    Ok(())
}

fn optimize_media_segment(
    segment_path: &Path,
    ffmpeg_command: &str,
    ffprobe_command: &str,
    target_video_bitrate_kbps: u32,
    target_audio_bitrate_kbps: u32,
    max_height: u32,
) -> Result<bool, String> {
    let original_size = fs::metadata(segment_path).map_err(to_io_error)?.len();
    let temp_path = segment_path.with_extension("optimized.tmp.webm");
    if temp_path.exists() {
        fs::remove_file(&temp_path).map_err(to_io_error)?;
    }

    let video_bitrate = format!("{target_video_bitrate_kbps}k");
    let audio_bitrate = format!("{target_audio_bitrate_kbps}k");
    let scale_filter = format!("scale=-2:min({max_height}\\,ih)");
    let stream_info = media_segment_streams(ffprobe_command, segment_path)?;
    if matches!(stream_info, Some((false, false))) {
        return Ok(false);
    }

    if matches!(stream_info, Some((false, true))) {
        run_audio_only_optimization(ffmpeg_command, segment_path, &temp_path, &audio_bitrate)?;
    } else {
        let video_result = run_ffmpeg_command(ffmpeg_command, &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            &path_to_string(segment_path),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            &video_bitrate,
            "-deadline",
            "good",
            "-cpu-used",
            "4",
            "-row-mt",
            "1",
            "-vf",
            &scale_filter,
            "-c:a",
            "libopus",
            "-b:a",
            &audio_bitrate,
            "-f",
            "webm",
            &path_to_string(&temp_path),
        ]);

        if let Err(error) = video_result {
            if temp_path.exists() {
                let _ = fs::remove_file(&temp_path);
            }

            if stream_info.is_none() && is_missing_video_stream_error(&error) {
                run_audio_only_optimization(ffmpeg_command, segment_path, &temp_path, &audio_bitrate)?;
            } else {
                return Err(error);
            }
        }
    }

    let optimized_size = fs::metadata(&temp_path).map_err(to_io_error)?.len();
    if optimized_size == 0 || optimized_size >= original_size {
        fs::remove_file(&temp_path).map_err(to_io_error)?;
        return Ok(false);
    }

    fs::rename(&temp_path, segment_path).map_err(to_io_error)?;
    Ok(true)
}

fn run_audio_only_optimization(
    ffmpeg_command: &str,
    segment_path: &Path,
    temp_path: &Path,
    audio_bitrate: &str,
) -> Result<(), String> {
    run_ffmpeg_command(ffmpeg_command, &[
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        &path_to_string(segment_path),
        "-map",
        "0:a?",
        "-vn",
        "-c:a",
        "libopus",
        "-b:a",
        audio_bitrate,
        "-f",
        "webm",
        &path_to_string(temp_path),
    ])
}

fn media_segment_streams(
    ffprobe_command: &str,
    segment_path: &Path,
) -> Result<Option<(bool, bool)>, String> {
    let output = Command::new(ffprobe_command)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            &path_to_string(segment_path),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                String::new()
            } else {
                format!("Could not start ffprobe: {error}")
            }
        });

    let output = match output {
        Ok(output) => output,
        Err(error) if error.is_empty() => return Ok(None),
        Err(error) => return Err(error),
    };

    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(Some((
        stdout.lines().any(|line| line.trim().eq_ignore_ascii_case("video")),
        stdout.lines().any(|line| line.trim().eq_ignore_ascii_case("audio")),
    )))
}

fn is_missing_video_stream_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("stream map '0:v:0' matches no streams")
        || error.contains("matches no streams")
        || error.contains("no such stream")
}

fn run_ffmpeg_command(ffmpeg_command: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(ffmpeg_command)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                "ffmpeg was not found. Install ffmpeg or bundle it as a Tauri sidecar before optimizing Astral recordings.".to_string()
            } else {
                format!("Could not start ffmpeg: {error}")
            }
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        return Err(format!("ffmpeg exited with status {}", output.status));
    }

    let mut message = stderr.to_string();
    message.truncate(1800);
    Err(message)
}

fn unique_optimized_package_path(source_path: &Path) -> PathBuf {
    let directory = source_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("recording");
    let mut candidate = directory.join(format!("{stem}-optimized.astral"));
    let mut index = 1;
    while candidate.exists() {
        candidate = directory.join(format!("{stem}-optimized-{index}.astral"));
        index += 1;
    }

    candidate
}

fn resolve_media_tool_command(app: &AppHandle, tool_name: &str) -> String {
    let executable_name = if cfg!(windows) {
        format!("{tool_name}.exe")
    } else {
        tool_name.to_string()
    };

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join("bin").join(&executable_name),
            resource_dir.join(&executable_name),
        ] {
            if candidate.is_file() {
                return path_to_string(&candidate);
            }
        }
    }

    if cfg!(debug_assertions) {
        for candidate in [
            PathBuf::from("src-tauri").join("bin").join(&executable_name),
            PathBuf::from("bin").join(&executable_name),
        ] {
            if candidate.is_file() {
                return path_to_string(&candidate);
            }
        }
    }

    if let Some(candidate) = find_winget_media_tool(&executable_name) {
        return path_to_string(&candidate);
    }

    tool_name.to_string()
}

fn find_winget_media_tool(executable_name: &str) -> Option<PathBuf> {
    let local_app_data = env::var_os("LOCALAPPDATA")?;
    let winget_packages = PathBuf::from(local_app_data)
        .join("Microsoft")
        .join("WinGet")
        .join("Packages");
    find_file_recursive(&winget_packages, executable_name, 5)
}

fn find_file_recursive(dir: &Path, file_name: &str, max_depth: usize) -> Option<PathBuf> {
    if max_depth == 0 || !dir.is_dir() {
        return None;
    }

    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(file_name))
        {
            return Some(path);
        }

        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, file_name, max_depth - 1) {
                return Some(found);
            }
        }
    }

    None
}

fn emit_optimize_progress(
    app: &AppHandle,
    job_id: &str,
    stage: &str,
    message: &str,
    current: u32,
    total: u32,
) {
    let _ = app.emit(
        "astral-recording-optimize-progress",
        AstralRecordingOptimizeProgress {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            message: message.to_string(),
            current,
            total,
        },
    );
}

fn normalize_archive_relative_path(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Err("Astral package contains an absolute path.".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            _ => return Err("Astral package contains an unsafe path.".to_string()),
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("Astral package contains an empty path.".to_string());
    }

    Ok(normalized)
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

fn create_import_session_id(file_name: Option<&str>) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let stem = file_name
        .and_then(|name| Path::new(name).file_stem())
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .map(sanitize_path_component)
        .unwrap_or_else(|| "recording".to_string());

    format!("astral-import-{timestamp}-{}-{stem}", std::process::id())
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

fn validate_astral_package_extension(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("astral"))
    {
        return Ok(());
    }

    Err("Only .astral recording packages can be used here.".to_string())
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
    let mime_type = mime_type.to_ascii_lowercase();
    if mime_type.contains("webp") {
        "webp"
    } else if mime_type.contains("png") {
        "png"
    } else if mime_type.contains("jpeg") || mime_type.contains("jpg") {
        "jpg"
    } else if mime_type.contains("mp4") {
        "mp4"
    } else {
        "webm"
    }
}

fn unique_export_path(directory: &Path, file_name: &str) -> PathBuf {
    let file_name_path = Path::new(file_name);
    let stem = file_name_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("recording");
    let extension = file_name_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("astral");

    let mut candidate = directory.join(format!("{stem}.{extension}"));
    let mut index = 1;
    while candidate.exists() {
        candidate = directory.join(format!("{stem}-{index}.{extension}"));
        index += 1;
    }

    candidate
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
            astral_recording_abort,
            astral_recording_export_package,
            astral_recording_import_package,
            astral_recording_import_begin,
            astral_recording_import_write_chunk,
            astral_recording_import_finalize,
            astral_recording_import_abort,
            astral_recording_optimize_package
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
