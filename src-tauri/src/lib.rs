use std::borrow::Cow;
use std::collections::{hash_map::DefaultHasher, BTreeMap, HashSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use tauri::http;
use tauri::{AppHandle, Emitter, Manager};

const APP_PROTOCOL: &str = "ddplatform";
const USE_HTTPS_SCHEME: bool = true;
const ASTRAL_MAGIC: &[u8] = b"ASTRAL1\0";
const RECOVERABLE_MEDIA_EXTENSIONS: &[&str] = &[
    "webm", "webp", "mp4", "m4v", "mov", "ogg", "opus", "mp3", "wav", "png", "jpg", "jpeg", "gif",
];

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
#[cfg(windows)]
const BACKGROUND_PROCESS_FLAGS: u32 = CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS;

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
    streaming_extraction: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingLocalPackage {
    id: String,
    name: String,
    path: String,
    size: u64,
    modified_at_ms: u64,
    started_at: Option<String>,
    duration_ms: Option<u64>,
    participant_count: u64,
    call_room_id: Option<String>,
    read_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingUnpackedSession {
    id: String,
    name: String,
    path: String,
    size: u64,
    modified_at_ms: u64,
    started_at: Option<String>,
    duration_ms: Option<u64>,
    participant_count: u64,
    segment_count: u64,
    has_manifest: bool,
    read_error: Option<String>,
}

struct RawRecordingSegment {
    participant_id: String,
    segment_index: u64,
    mime_type: String,
    is_local: bool,
    user_data: Option<serde_json::Value>,
    participant_meta: Option<serde_json::Value>,
    volume_percent: u64,
    started_at_ms: u64,
    file_ended_at_ms: u64,
    size: u64,
    relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingOptimizeOptions {
    target_video_bitrate_kbps: Option<u32>,
    target_audio_bitrate_kbps: Option<u32>,
    max_height: Option<u32>,
    keep_original: Option<bool>,
    cpu_threads: Option<u32>,
    memory_limit_mb: Option<u32>,
    prefer_hardware_encoding: Option<bool>,
    gpu_vendor: Option<String>,
    gpu_renderer: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AstralGpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Unknown,
}

struct AstralOptimizationPlan {
    target_video_bitrate_kbps: u32,
    target_audio_bitrate_kbps: u32,
    max_height: u32,
    cpu_threads: u32,
    audio_threads: u32,
    cpu_used: u32,
    hardware_video_encoder: Option<&'static str>,
    use_hardware_decode: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingOptimizeProgress {
    job_id: String,
    stage: String,
    message: String,
    current: u32,
    total: u32,
    progress_percent: Option<u8>,
    segment_index: Option<u32>,
    current_segment: Option<String>,
    current_segment_size: Option<u64>,
    optimized_segment_size: Option<u64>,
    optimized_segment_count: u32,
    skipped_segment_count: u32,
    package_current_bytes: Option<u64>,
    package_total_bytes: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AstralRecordingPackageProgress {
    job_id: String,
    stage: String,
    message: String,
    current_bytes: u64,
    total_bytes: u64,
    progress_percent: u8,
    current_file: Option<String>,
    astral_path: Option<String>,
    astral_size: Option<u64>,
    error: Option<String>,
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
    is_local: Option<bool>,
    user_data: Option<serde_json::Value>,
    participant_meta: Option<serde_json::Value>,
    volume_percent: Option<u64>,
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
        is_local.unwrap_or(false),
        user_data,
        participant_meta,
        volume_percent.unwrap_or(100),
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
fn astral_recording_recover_package(
    app: AppHandle,
    session_dir: String,
    manifest_json: String,
) -> Result<AstralRecordingFinalizeResponse, String> {
    let session_dir_path = PathBuf::from(session_dir)
        .canonicalize()
        .map_err(to_io_error)?;
    let recordings_root = recordings_root(&app)?.canonicalize().map_err(to_io_error)?;
    if !session_dir_path.starts_with(&recordings_root) {
        return Err("Recording session is outside the managed recordings directory.".to_string());
    }

    if !session_dir_path.is_dir() {
        return Err("Recording session directory was not found.".to_string());
    }

    if !session_dir_path.join("participants").is_dir() {
        return Err("Recording session has no participant media to recover.".to_string());
    }

    let session_id = session_dir_path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| "Recording session directory is invalid.".to_string())?;
    validate_session_id(session_id)?;
    serde_json::from_str::<serde_json::Value>(&manifest_json)
        .map_err(|error| format!("Invalid recording manifest: {error}"))?;
    fs::write(session_dir_path.join("manifest.json"), manifest_json).map_err(to_io_error)?;

    let astral_path = unique_recovered_package_path(&recordings_root, session_id);
    let astral_size = write_astral_package_from_dir(&session_dir_path, &astral_path)?;
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

    import_astral_package_from_source_path(&app, source_path)
}

#[tauri::command(rename_all = "camelCase")]
async fn astral_recording_import_unpacked_session(
    app: AppHandle,
    session_dir: String,
) -> Result<AstralRecordingImportResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_unpacked_session_from_source_dir(&app, session_dir)
    })
    .await
    .map_err(|error| format!("Astral unpacked playback task failed: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_list_local_packages(
    app: AppHandle,
) -> Result<Vec<AstralRecordingLocalPackage>, String> {
    let recordings_root = recordings_root(&app)?;
    if !recordings_root.is_dir() {
        return Ok(Vec::new());
    }

    let mut packages = Vec::new();
    for entry in fs::read_dir(recordings_root).map_err(to_io_error)? {
        let entry = entry.map_err(to_io_error)?;
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("astral"))
        {
            continue;
        }

        packages.push(local_astral_package_from_path(&path)?);
    }

    packages.sort_by(|first, second| {
        second
            .modified_at_ms
            .cmp(&first.modified_at_ms)
            .then_with(|| first.name.cmp(&second.name))
    });
    Ok(packages)
}

#[tauri::command(rename_all = "camelCase")]
fn astral_recording_list_unpacked_sessions(
    app: AppHandle,
) -> Result<Vec<AstralRecordingUnpackedSession>, String> {
    let recordings_root = recordings_root(&app)?;
    if !recordings_root.is_dir() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    for entry in fs::read_dir(&recordings_root).map_err(to_io_error)? {
        let entry = entry.map_err(to_io_error)?;
        let path = entry.path();
        if !path.is_dir() || !path.join("participants").is_dir() {
            continue;
        }

        let Some(session_id) = path.file_name().and_then(|file_name| file_name.to_str()) else {
            continue;
        };
        if !is_recordable_session_dir_name(session_id)
            || recordings_root
                .join(format!("{session_id}.astral"))
                .is_file()
        {
            continue;
        }

        sessions.push(unpacked_session_from_dir(&path, session_id)?);
    }

    sessions.sort_by(|first, second| {
        second
            .modified_at_ms
            .cmp(&first.modified_at_ms)
            .then_with(|| first.name.cmp(&second.name))
    });
    Ok(sessions)
}

#[tauri::command(rename_all = "camelCase")]
async fn astral_recording_package_unpacked_session(
    app: AppHandle,
    session_dir: String,
    job_id: Option<String>,
) -> Result<AstralRecordingFinalizeResponse, String> {
    tauri::async_runtime::spawn_blocking(move || match job_id {
        Some(job_id) => package_unpacked_session_blocking_with_progress(&app, session_dir, job_id),
        None => package_unpacked_session_blocking(&app, session_dir),
    })
    .await
    .map_err(|error| format!("Astral packaging task failed: {error}"))?
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
async fn astral_recording_optimize_package(
    app: AppHandle,
    job_id: String,
    package_path: String,
    options: AstralRecordingOptimizeOptions,
) -> Result<AstralRecordingOptimizeResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        astral_recording_optimize_package_blocking(app, job_id, package_path, options)
    })
    .await
    .map_err(|error| format!("Astral optimization task failed: {error}"))?
}

fn astral_recording_optimize_package_blocking(
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

    let result = optimize_astral_package_in_work_dir(
        &app,
        &job_id,
        &source_path,
        &work_dir,
        options,
        original_size,
    );
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
    emit_optimize_progress(app, job_id, "extracting", "Extracting Astral package", 0, 0);
    extract_astral_archive_to_dir(source_path, work_dir)?;

    emit_optimize_progress(app, job_id, "scanning", "Finding media segments", 0, 0);
    let segments = collect_optimizable_media_segments(work_dir)?;
    let total_segments = u32::try_from(segments.len()).unwrap_or(u32::MAX);
    let ffmpeg_command = resolve_media_tool_command(app, "ffmpeg");
    let ffprobe_command = resolve_media_tool_command(app, "ffprobe");
    let optimization_plan = build_astral_optimization_plan(&options, &ffmpeg_command);
    let mut optimized_segment_count = 0u32;
    let mut skipped_segment_count = 0u32;

    for (index, segment_path) in segments.iter().enumerate() {
        let segment_index = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let completed_segments = u32::try_from(index).unwrap_or(u32::MAX);
        let current_segment = archive_relative_path(work_dir, segment_path).ok();
        let original_segment_size = fs::metadata(segment_path)
            .map(|metadata| metadata.len())
            .ok();
        emit_optimize_progress_detail(
            app,
            job_id,
            "optimizing",
            &format!("Optimizing segment {segment_index} of {total_segments}"),
            completed_segments,
            total_segments,
            Some(optimize_segment_progress_percent(
                completed_segments,
                total_segments,
            )),
            Some(segment_index),
            current_segment.as_deref(),
            original_segment_size,
            None,
            optimized_segment_count,
            skipped_segment_count,
            None,
            None,
        );

        match optimize_media_segment(
            segment_path,
            &ffmpeg_command,
            &ffprobe_command,
            &optimization_plan,
        ) {
            Ok(optimized) => {
                let optimized_segment_size = fs::metadata(segment_path)
                    .map(|metadata| metadata.len())
                    .ok();
                if optimized {
                    optimized_segment_count = optimized_segment_count.saturating_add(1);
                } else {
                    skipped_segment_count = skipped_segment_count.saturating_add(1);
                }

                emit_optimize_progress_detail(
                    app,
                    job_id,
                    if optimized { "optimized" } else { "skipped" },
                    &format!(
                        "{} segment {segment_index} of {total_segments}",
                        if optimized { "Optimized" } else { "Skipped" }
                    ),
                    segment_index,
                    total_segments,
                    Some(optimize_segment_progress_percent(
                        segment_index,
                        total_segments,
                    )),
                    Some(segment_index),
                    current_segment.as_deref(),
                    original_segment_size,
                    optimized_segment_size,
                    optimized_segment_count,
                    skipped_segment_count,
                    None,
                    None,
                );
            }
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

    emit_optimize_progress_detail(
        app,
        job_id,
        "packaging",
        "Writing optimized Astral package",
        total_segments,
        total_segments,
        Some(90),
        None,
        None,
        None,
        None,
        optimized_segment_count,
        skipped_segment_count,
        None,
        None,
    );

    let keep_original = options.keep_original.unwrap_or(true);
    let output_path = if keep_original {
        unique_optimized_package_path(source_path)
    } else {
        source_path.with_extension("optimized.tmp.astral")
    };
    let mut last_package_percent = 255u8;
    let mut last_package_emit_at = Instant::now();
    let optimized_size = write_astral_package_from_dir_with_progress(
        work_dir,
        &output_path,
        |current_bytes, total_bytes, current_file| {
            let progress_percent = optimize_package_progress_percent(current_bytes, total_bytes);
            let should_emit = progress_percent != last_package_percent
                || last_package_emit_at.elapsed().as_millis() >= 500;
            if should_emit {
                last_package_percent = progress_percent;
                last_package_emit_at = Instant::now();
                emit_optimize_progress_detail(
                    app,
                    job_id,
                    "packaging",
                    "Writing optimized Astral package",
                    total_segments,
                    total_segments,
                    Some(progress_percent),
                    None,
                    current_file,
                    None,
                    None,
                    optimized_segment_count,
                    skipped_segment_count,
                    Some(current_bytes),
                    Some(total_bytes),
                );
            }
        },
    )?;
    let optimized_path = if keep_original {
        output_path
    } else {
        fs::remove_file(source_path).map_err(to_io_error)?;
        fs::rename(&output_path, source_path).map_err(to_io_error)?;
        source_path.to_path_buf()
    };

    emit_optimize_progress_detail(
        app,
        job_id,
        "completed",
        "Astral optimization complete",
        total_segments,
        total_segments,
        Some(100),
        None,
        None,
        None,
        None,
        optimized_segment_count,
        skipped_segment_count,
        None,
        None,
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
    is_local: bool,
    user_data: Option<serde_json::Value>,
    participant_meta: Option<serde_json::Value>,
    volume_percent: u64,
) -> Result<(), String> {
    let metadata_path = participant_dir.join(format!("{segment_index:06}.json"));
    if metadata_path.exists() {
        return Ok(());
    }

    let metadata = serde_json::json!({
        "participantId": participant_id,
        "segmentIndex": segment_index,
        "mimeType": mime_type,
        "isLocal": is_local,
        "userData": user_data.unwrap_or(serde_json::Value::Null),
        "participantMeta": participant_meta.unwrap_or(serde_json::Value::Null),
        "volumePercent": volume_percent,
        "startedAtMs": started_at_ms,
        "firstChunkStartedAtMs": chunk_started_at_ms
    });
    fs::write(
        metadata_path,
        serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
    )
    .map_err(to_io_error)
}

fn collect_archive_file_paths(files: &mut Vec<PathBuf>, dir: &Path) -> Result<(), String> {
    let mut entries = fs::read_dir(dir)
        .map_err(to_io_error)?
        .collect::<Result<Vec<_>, io::Error>>()
        .map_err(to_io_error)?;
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_archive_file_paths(files, &path)?;
        } else if path.is_file() {
            files.push(path);
        }
    }

    Ok(())
}

fn archive_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|error| format!("Could not calculate archive path: {error}"))
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn append_file_to_archive<W: Write, F: FnMut(u64)>(
    writer: &mut W,
    path: &Path,
    relative_path: &str,
    file_size: u64,
    progress: &mut F,
) -> Result<(), String> {
    let relative_bytes = relative_path.as_bytes();
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
    let mut copied_bytes = 0u64;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read_bytes = file.read(&mut buffer).map_err(to_io_error)?;
        if read_bytes == 0 {
            break;
        }

        writer
            .write_all(&buffer[..read_bytes])
            .map_err(to_io_error)?;
        copied_bytes = copied_bytes.saturating_add(read_bytes as u64);
        progress(copied_bytes);
    }

    Ok(())
}

fn write_astral_package_from_dir(session_dir: &Path, astral_path: &Path) -> Result<u64, String> {
    write_astral_package_from_dir_with_progress(session_dir, astral_path, |_, _, _| {})
}

fn write_astral_package_from_dir_with_progress<F>(
    session_dir: &Path,
    astral_path: &Path,
    mut progress: F,
) -> Result<u64, String>
where
    F: FnMut(u64, u64, Option<&str>),
{
    let mut file_paths = Vec::new();
    collect_archive_file_paths(&mut file_paths, session_dir)?;
    let mut file_sizes = Vec::with_capacity(file_paths.len());
    let mut total_bytes = 0u64;
    for path in &file_paths {
        let file_size = fs::metadata(path).map_err(to_io_error)?.len();
        total_bytes = total_bytes.saturating_add(file_size);
        file_sizes.push(file_size);
    }

    let mut processed_bytes = 0u64;
    progress(0, total_bytes, None);

    let mut package = File::create(astral_path).map_err(to_io_error)?;
    package.write_all(ASTRAL_MAGIC).map_err(to_io_error)?;

    let mut encoder = GzEncoder::new(package, Compression::default());
    for (path, file_size) in file_paths.iter().zip(file_sizes.iter()) {
        let relative_path = archive_relative_path(session_dir, path)?;
        progress(processed_bytes, total_bytes, Some(&relative_path));
        append_file_to_archive(
            &mut encoder,
            path,
            &relative_path,
            *file_size,
            &mut |file_copied_bytes| {
                progress(
                    processed_bytes.saturating_add(file_copied_bytes),
                    total_bytes,
                    Some(&relative_path),
                );
            },
        )?;
        processed_bytes = processed_bytes.saturating_add(*file_size);
        progress(processed_bytes, total_bytes, Some(&relative_path));
    }

    encoder
        .write_all(&0u32.to_le_bytes())
        .map_err(to_io_error)?;
    encoder.finish().map_err(to_io_error)?;

    progress(total_bytes, total_bytes, None);

    fs::metadata(astral_path)
        .map(|metadata| metadata.len())
        .map_err(to_io_error)
}

fn import_astral_package_from_source_path(
    app: &AppHandle,
    source_path: PathBuf,
) -> Result<AstralRecordingImportResponse, String> {
    let session_id =
        create_import_session_id(source_path.file_name().and_then(|name| name.to_str()));
    let session_dir = session_dir(app, &session_id)?;
    if session_dir.exists() {
        fs::remove_dir_all(&session_dir).map_err(to_io_error)?;
    }
    fs::create_dir_all(&session_dir).map_err(to_io_error)?;

    let manifest = extract_astral_manifest_from_package(&source_path)?;
    fs::write(
        session_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(to_io_error)?;

    let package_size = fs::metadata(&source_path).map_err(to_io_error)?.len();
    let extraction_session_id = session_id.clone();
    let extraction_source_path = source_path.clone();
    let extraction_session_dir = session_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) =
            extract_astral_archive_to_dir(&extraction_source_path, &extraction_session_dir)
        {
            eprintln!("Failed to stream extract Astral recording {extraction_session_id}: {error}");
        }
    });

    Ok(AstralRecordingImportResponse {
        session_id,
        session_dir: path_to_string(&session_dir),
        package_path: path_to_string(&source_path),
        package_size,
        manifest,
        streaming_extraction: true,
    })
}

fn local_astral_package_from_path(path: &Path) -> Result<AstralRecordingLocalPackage, String> {
    let metadata = fs::metadata(path).map_err(to_io_error)?;
    let name = path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or("recording.astral")
        .to_string();
    let modified_at_ms = metadata.modified().map(system_time_to_unix_ms).unwrap_or(0);
    let mut package = AstralRecordingLocalPackage {
        id: sanitize_path_component(&path_to_string(path)),
        name,
        path: path_to_string(path),
        size: metadata.len(),
        modified_at_ms,
        started_at: None,
        duration_ms: None,
        participant_count: 0,
        call_room_id: None,
        read_error: None,
    };

    match extract_astral_manifest_from_package(path) {
        Ok(manifest) => apply_local_package_manifest(&mut package, &manifest),
        Err(error) => package.read_error = Some(error),
    }

    Ok(package)
}

fn apply_local_package_manifest(
    package: &mut AstralRecordingLocalPackage,
    manifest: &serde_json::Value,
) {
    let recording = manifest.get("recording").unwrap_or(manifest);
    package.started_at = recording
        .get("startedAt")
        .or_else(|| manifest.get("packagedAt"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    package.duration_ms = recording.get("durationMs").and_then(|value| value.as_u64());
    if let Some(participants) = recording
        .get("participantMedia")
        .and_then(|value| value.as_array())
    {
        package.participant_count = count_unique_participants(participants);
    }
    package.call_room_id = recording
        .get("callRoomId")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
}

fn unpacked_session_from_dir(
    session_dir: &Path,
    session_id: &str,
) -> Result<AstralRecordingUnpackedSession, String> {
    let metadata = fs::metadata(session_dir).map_err(to_io_error)?;
    let has_manifest = session_dir.join("manifest.json").is_file();
    let mut session = AstralRecordingUnpackedSession {
        id: session_id.to_string(),
        name: session_id.to_string(),
        path: path_to_string(session_dir),
        size: 0,
        modified_at_ms: metadata.modified().map(system_time_to_unix_ms).unwrap_or(0),
        started_at: None,
        duration_ms: None,
        participant_count: 0,
        segment_count: 0,
        has_manifest,
        read_error: None,
    };

    match read_or_build_unpacked_session_manifest(session_dir, session_id) {
        Ok(manifest) => apply_unpacked_session_manifest(&mut session, &manifest),
        Err(error) => session.read_error = Some(error),
    }

    Ok(session)
}

fn apply_unpacked_session_manifest(
    session: &mut AstralRecordingUnpackedSession,
    manifest: &serde_json::Value,
) {
    let recording = manifest.get("recording").unwrap_or(manifest);
    session.started_at = recording
        .get("startedAt")
        .or_else(|| manifest.get("packagedAt"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    session.duration_ms = recording.get("durationMs").and_then(|value| value.as_u64());
    session.size = recording_media_size_from_manifest(manifest);

    let Some(participants) = recording
        .get("participantMedia")
        .and_then(|value| value.as_array())
    else {
        return;
    };

    session.segment_count = participants.len() as u64;
    session.participant_count = count_unique_participants(participants);
}

fn recording_media_size_from_manifest(manifest: &serde_json::Value) -> u64 {
    let recording = manifest.get("recording").unwrap_or(manifest);
    let direct_media_size = recording
        .get("media")
        .and_then(|media| media.get("size"))
        .and_then(|size| size.as_u64())
        .unwrap_or(0);
    let participant_media_size: u64 = recording
        .get("participantMedia")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|participant| participant.get("media"))
        .filter_map(|media| media.get("size"))
        .filter_map(|size| size.as_u64())
        .sum();

    direct_media_size.saturating_add(participant_media_size)
}

fn package_unpacked_session_blocking(
    app: &AppHandle,
    session_dir: String,
) -> Result<AstralRecordingFinalizeResponse, String> {
    package_unpacked_session_blocking_inner(app, session_dir, None)
}

fn package_unpacked_session_blocking_with_progress(
    app: &AppHandle,
    session_dir: String,
    job_id: String,
) -> Result<AstralRecordingFinalizeResponse, String> {
    match package_unpacked_session_blocking_inner(app, session_dir, Some(job_id.as_str())) {
        Ok(response) => Ok(response),
        Err(error) => {
            emit_package_progress(
                app,
                &job_id,
                "failed",
                "Astral packaging failed",
                0,
                0,
                100,
                None,
                None,
                None,
                Some(error.as_str()),
            );
            Err(error)
        }
    }
}

fn package_unpacked_session_blocking_inner(
    app: &AppHandle,
    session_dir: String,
    job_id: Option<&str>,
) -> Result<AstralRecordingFinalizeResponse, String> {
    if let Some(job_id) = job_id {
        emit_package_progress(
            app,
            job_id,
            "preparing",
            "Preparing unpacked recording",
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        );
    }

    let (session_dir, session_id, recordings_root) =
        validate_unpacked_session_dir(app, &session_dir)?;
    let default_package_path = recordings_root.join(format!("{session_id}.astral"));
    if default_package_path.is_file() {
        let astral_size = fs::metadata(&default_package_path)
            .map_err(to_io_error)?
            .len();
        if let Some(job_id) = job_id {
            emit_package_progress(
                app,
                job_id,
                "completed",
                "Astral package already exists",
                astral_size,
                astral_size,
                100,
                None,
                Some(&path_to_string(&default_package_path)),
                Some(astral_size),
                None,
            );
        }
        return Ok(AstralRecordingFinalizeResponse {
            astral_path: path_to_string(&default_package_path),
            astral_size,
        });
    }

    if let Some(job_id) = job_id {
        emit_package_progress(
            app,
            job_id,
            "manifest",
            "Writing recording manifest",
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        );
    }

    let manifest = read_or_build_unpacked_session_manifest(&session_dir, &session_id)?;
    fs::write(
        session_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(to_io_error)?;

    let astral_path = unique_export_path(&recordings_root, &format!("{session_id}.astral"));
    let astral_size = if let Some(job_id) = job_id {
        let mut last_progress_percent = 255u8;
        let mut last_emit_at = Instant::now();
        write_astral_package_from_dir_with_progress(
            &session_dir,
            &astral_path,
            |current_bytes, total_bytes, current_file| {
                let progress_percent = package_progress_percent(current_bytes, total_bytes).min(99);
                let should_emit = progress_percent != last_progress_percent
                    || last_emit_at.elapsed().as_millis() >= 500;
                if should_emit {
                    last_progress_percent = progress_percent;
                    last_emit_at = Instant::now();
                    emit_package_progress(
                        app,
                        job_id,
                        "packaging",
                        "Writing Astral package",
                        current_bytes,
                        total_bytes,
                        progress_percent,
                        current_file,
                        Some(&path_to_string(&astral_path)),
                        None,
                        None,
                    );
                }
            },
        )?
    } else {
        write_astral_package_from_dir(&session_dir, &astral_path)?
    };

    if let Some(job_id) = job_id {
        emit_package_progress(
            app,
            job_id,
            "completed",
            "Astral package ready",
            astral_size,
            astral_size,
            100,
            None,
            Some(&path_to_string(&astral_path)),
            Some(astral_size),
            None,
        );
    }

    Ok(AstralRecordingFinalizeResponse {
        astral_path: path_to_string(&astral_path),
        astral_size,
    })
}

fn import_unpacked_session_from_source_dir(
    app: &AppHandle,
    session_dir: String,
) -> Result<AstralRecordingImportResponse, String> {
    let (session_dir, session_id, _) = validate_unpacked_session_dir(app, &session_dir)?;
    let manifest = read_or_build_unpacked_session_manifest(&session_dir, &session_id)?;
    let package_size = recording_media_size_from_manifest(&manifest);

    Ok(AstralRecordingImportResponse {
        session_id,
        session_dir: path_to_string(&session_dir),
        package_path: path_to_string(&session_dir),
        package_size,
        manifest,
        streaming_extraction: false,
    })
}

fn validate_unpacked_session_dir(
    app: &AppHandle,
    session_dir: &str,
) -> Result<(PathBuf, String, PathBuf), String> {
    let session_dir = PathBuf::from(session_dir)
        .canonicalize()
        .map_err(to_io_error)?;
    let recordings_root = recordings_root(app)?.canonicalize().map_err(to_io_error)?;
    if !session_dir.starts_with(&recordings_root) {
        return Err("Recording session is outside the managed recordings directory.".to_string());
    }
    if !session_dir.is_dir() || !session_dir.join("participants").is_dir() {
        return Err("Recording session has no participant media to package.".to_string());
    }

    let session_id = session_dir
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| "Recording session directory is invalid.".to_string())?
        .to_string();
    if !is_recordable_session_dir_name(&session_id) {
        return Err("Recording session directory is not packageable.".to_string());
    }

    Ok((session_dir, session_id, recordings_root))
}

fn read_or_build_unpacked_session_manifest(
    session_dir: &Path,
    session_id: &str,
) -> Result<serde_json::Value, String> {
    let manifest_path = session_dir.join("manifest.json");
    if manifest_path.is_file() {
        let manifest_json = fs::read_to_string(&manifest_path).map_err(to_io_error)?;
        if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&manifest_json) {
            return Ok(merge_unpacked_manifest_with_raw_segments(
                manifest,
                session_dir,
                session_id,
            ));
        }
    }

    build_recovery_manifest_from_raw_session(session_dir, session_id)
}

fn merge_unpacked_manifest_with_raw_segments(
    manifest: serde_json::Value,
    session_dir: &Path,
    session_id: &str,
) -> serde_json::Value {
    match build_recovery_manifest_from_raw_session(session_dir, session_id) {
        Ok(recovery_manifest) => merge_manifest_details_into_recovery(manifest, recovery_manifest),
        Err(_) => manifest,
    }
}

fn merge_manifest_details_into_recovery(
    manifest: serde_json::Value,
    mut recovery_manifest: serde_json::Value,
) -> serde_json::Value {
    let source_recording = manifest.get("recording").unwrap_or(&manifest);
    let source_participants = source_recording
        .get("participantMedia")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    if let Some(recovery_recording) = recovery_manifest
        .get_mut("recording")
        .and_then(|value| value.as_object_mut())
    {
        for key in [
            "id",
            "callRoomId",
            "startedAt",
            "endedAt",
            "media",
            "vtt",
            "callEnvironment",
        ] {
            if let Some(value) = source_recording.get(key).filter(|value| !value.is_null()) {
                recovery_recording.insert(key.to_string(), value.clone());
            }
        }

        let source_duration_ms = source_recording
            .get("durationMs")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        if source_duration_ms > 0 {
            let recovery_duration_ms = recovery_recording
                .get("durationMs")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            recovery_recording.insert(
                "durationMs".to_string(),
                serde_json::Value::from(source_duration_ms.max(recovery_duration_ms)),
            );
        }

        if let Some(recovery_participants) = recovery_recording
            .get_mut("participantMedia")
            .and_then(|value| value.as_array_mut())
        {
            for participant in recovery_participants {
                merge_participant_details(participant, &source_participants);
            }
        }
    }

    if let Some(value) = manifest
        .get("packagedAt")
        .filter(|value| !value.is_null())
        .cloned()
    {
        recovery_manifest["packagedAt"] = value;
    }

    recovery_manifest
}

fn merge_participant_details(
    participant: &mut serde_json::Value,
    source_participants: &[serde_json::Value],
) {
    let Some(source) = find_source_participant_details(participant, source_participants) else {
        return;
    };

    for key in ["isLocal", "userData", "participantMeta", "volumePercent"] {
        let should_copy = match key {
            "isLocal" => true,
            "volumePercent" => participant
                .get(key)
                .map(|value| value.is_null() || value.as_u64() == Some(100))
                .unwrap_or(true),
            _ => participant
                .get(key)
                .map(|value| value.is_null())
                .unwrap_or(true),
        };
        if should_copy {
            if let Some(value) = source.get(key).filter(|value| !value.is_null()) {
                participant[key] = value.clone();
            }
        }
    }
}

fn find_source_participant_details<'a>(
    participant: &serde_json::Value,
    source_participants: &'a [serde_json::Value],
) -> Option<&'a serde_json::Value> {
    let participant_path = participant
        .get("media")
        .and_then(|media| media.get("path"))
        .and_then(|value| value.as_str());
    if let Some(path) = participant_path {
        if let Some(source) = source_participants.iter().find(|source| {
            source
                .get("media")
                .and_then(|media| media.get("path"))
                .and_then(|value| value.as_str())
                .is_some_and(|source_path| source_path == path)
        }) {
            return Some(source);
        }
    }

    let participant_id = participant
        .get("participantId")
        .and_then(|value| value.as_str())?;
    let participant_started_at_ms = participant
        .get("startedAtMs")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);

    source_participants
        .iter()
        .filter(|source| {
            source
                .get("participantId")
                .and_then(|value| value.as_str())
                .is_some_and(|source_id| source_id == participant_id)
        })
        .min_by_key(|source| {
            let source_started_at_ms = source
                .get("startedAtMs")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            source_started_at_ms.abs_diff(participant_started_at_ms)
        })
}

fn build_recovery_manifest_from_raw_session(
    session_dir: &Path,
    session_id: &str,
) -> Result<serde_json::Value, String> {
    let session_started_at_ms = infer_session_started_at_ms(session_id);
    let segments = collect_raw_recording_segments(session_dir, session_started_at_ms)?;
    if segments.is_empty() {
        return Err("No participant media segments were found.".to_string());
    }

    let mut grouped: BTreeMap<String, Vec<RawRecordingSegment>> = BTreeMap::new();
    for segment in segments {
        grouped
            .entry(segment.participant_id.clone())
            .or_default()
            .push(segment);
    }

    let mut participant_media = Vec::new();
    let mut duration_ms = 0u64;
    for segments in grouped.values_mut() {
        segments.sort_by(|first, second| {
            first
                .started_at_ms
                .cmp(&second.started_at_ms)
                .then_with(|| first.segment_index.cmp(&second.segment_index))
        });

        for index in 0..segments.len() {
            let segment = &segments[index];
            let ended_at_ms = segments
                .get(index + 1)
                .map(|next| next.started_at_ms.max(segment.started_at_ms + 250))
                .unwrap_or_else(|| segment.file_ended_at_ms.max(segment.started_at_ms + 250));
            duration_ms = duration_ms.max(ended_at_ms);
            participant_media.push(serde_json::json!({
                "participantId": segment.participant_id.clone(),
                "isLocal": segment.is_local,
                "userData": segment.user_data.clone().unwrap_or(serde_json::Value::Null),
                "participantMeta": segment.participant_meta.clone().unwrap_or(serde_json::Value::Null),
                "volumePercent": segment.volume_percent,
                "startedAtMs": segment.started_at_ms,
                "endedAtMs": ended_at_ms,
                "media": {
                    "storage": "astral",
                    "mimeType": segment.mime_type.clone(),
                    "durationMs": ended_at_ms.saturating_sub(segment.started_at_ms),
                    "size": segment.size,
                    "path": segment.relative_path.clone()
                }
            }));
        }
    }

    participant_media.sort_by(|first, second| {
        let first_started = first
            .get("startedAtMs")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let second_started = second
            .get("startedAtMs")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        first_started.cmp(&second_started)
    });

    Ok(serde_json::json!({
        "format": "astral-session-recording",
        "formatVersion": 1,
        "packagedAt": unix_ms_to_iso(now_unix_ms()),
        "recovery": {
            "generatedFrom": "raw-segment-metadata",
            "sourceSessionDir": path_to_string(session_dir),
            "note": "Recovered from unpackaged local media chunks. VTT and call-environment timelines are not recoverable from raw media chunks alone."
        },
        "recording": {
            "id": format!("{session_id}-recovered"),
            "callRoomId": null,
            "startedAt": unix_ms_to_iso(session_started_at_ms),
            "endedAt": unix_ms_to_iso(session_started_at_ms.saturating_add(duration_ms)),
            "durationMs": duration_ms,
            "media": null,
            "participantMedia": participant_media,
            "vtt": {
                "roomId": null,
                "initialState": null,
                "actions": []
            },
            "callEnvironment": {
                "initialState": null,
                "events": []
            }
        }
    }))
}

fn collect_raw_recording_segments(
    session_dir: &Path,
    session_started_at_ms: u64,
) -> Result<Vec<RawRecordingSegment>, String> {
    let participants_root = session_dir.join("participants");
    let mut segments = Vec::new();
    for participant_entry in fs::read_dir(&participants_root).map_err(to_io_error)? {
        let participant_entry = participant_entry.map_err(to_io_error)?;
        let participant_dir = participant_entry.path();
        if !participant_dir.is_dir() {
            continue;
        }

        for metadata_entry in fs::read_dir(&participant_dir).map_err(to_io_error)? {
            let metadata_entry = metadata_entry.map_err(to_io_error)?;
            let metadata_path = metadata_entry.path();
            if !metadata_path.is_file()
                || !metadata_path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
            {
                continue;
            }

            let metadata_json = fs::read_to_string(&metadata_path).map_err(to_io_error)?;
            let metadata = serde_json::from_str::<serde_json::Value>(&metadata_json)
                .map_err(|error| format!("Invalid segment metadata: {error}"))?;
            let Some(media_path) = find_raw_media_for_metadata(&participant_dir, &metadata_path)
            else {
                continue;
            };
            let media_metadata = fs::metadata(&media_path).map_err(to_io_error)?;
            let media_modified_at_ms = media_metadata
                .modified()
                .map(system_time_to_unix_ms)
                .unwrap_or(0);
            let started_at_ms = metadata
                .get("startedAtMs")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let file_ended_at_ms = if media_modified_at_ms > session_started_at_ms {
                media_modified_at_ms.saturating_sub(session_started_at_ms)
            } else {
                started_at_ms.saturating_add(250)
            };
            let participant_id = metadata
                .get("participantId")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .or_else(|| {
                    participant_dir
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(|value| value.to_string())
                })
                .unwrap_or_else(|| "unknown-participant".to_string());
            let segment_index = metadata
                .get("segmentIndex")
                .and_then(|value| value.as_u64())
                .unwrap_or(segments.len() as u64);
            let mime_type = metadata
                .get("mimeType")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .unwrap_or_else(|| guess_mime_type(&media_path).to_string());
            let is_local = metadata
                .get("isLocal")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let user_data = metadata
                .get("userData")
                .filter(|value| !value.is_null())
                .cloned();
            let participant_meta = metadata
                .get("participantMeta")
                .filter(|value| !value.is_null())
                .cloned();
            let volume_percent = metadata
                .get("volumePercent")
                .and_then(|value| value.as_u64())
                .unwrap_or(100);
            let relative_path = media_path
                .strip_prefix(session_dir)
                .map_err(|error| format!("Could not calculate media path: {error}"))?
                .to_string_lossy()
                .replace('\\', "/");

            segments.push(RawRecordingSegment {
                participant_id,
                segment_index,
                mime_type,
                is_local,
                user_data,
                participant_meta,
                volume_percent,
                started_at_ms,
                file_ended_at_ms: file_ended_at_ms.max(started_at_ms),
                size: media_metadata.len(),
                relative_path,
            });
        }
    }

    Ok(segments)
}

fn find_raw_media_for_metadata(participant_dir: &Path, metadata_path: &Path) -> Option<PathBuf> {
    let stem = metadata_path.file_stem()?.to_str()?;
    for extension in RECOVERABLE_MEDIA_EXTENSIONS {
        let candidate = participant_dir.join(format!("{stem}.{extension}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
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
        streaming_extraction: false,
    })
}

fn extract_astral_manifest_from_package(package_path: &Path) -> Result<serde_json::Value, String> {
    let mut package = File::open(package_path).map_err(to_io_error)?;
    let mut magic = vec![0u8; ASTRAL_MAGIC.len()];
    package.read_exact(&mut magic).map_err(to_io_error)?;
    if magic != ASTRAL_MAGIC {
        return Err("Invalid .astral recording package.".to_string());
    }

    let mut decoder = GzDecoder::new(package);
    let mut path_len_bytes = [0u8; 4];
    decoder
        .read_exact(&mut path_len_bytes)
        .map_err(to_io_error)?;
    let path_len = u32::from_le_bytes(path_len_bytes);
    if path_len == 0 || path_len > 4096 {
        return Err("Astral package is missing manifest.json.".to_string());
    }

    let mut file_size_bytes = [0u8; 8];
    decoder
        .read_exact(&mut file_size_bytes)
        .map_err(to_io_error)?;
    let file_size = u64::from_le_bytes(file_size_bytes);
    if file_size > 32 * 1024 * 1024 {
        return Err("Astral manifest is too large.".to_string());
    }

    let mut relative_path_bytes = vec![0u8; path_len as usize];
    decoder
        .read_exact(&mut relative_path_bytes)
        .map_err(to_io_error)?;
    let relative_path = String::from_utf8(relative_path_bytes)
        .map_err(|error| format!("Invalid archive path encoding: {error}"))?;
    let normalized_relative_path = normalize_archive_relative_path(&relative_path)?;
    if normalized_relative_path != PathBuf::from("manifest.json") {
        return Err(
            "Astral package cannot be streamed because manifest.json is not first.".to_string(),
        );
    }

    let manifest_size =
        usize::try_from(file_size).map_err(|_| "Astral manifest is too large.".to_string())?;
    let mut manifest_bytes = vec![0u8; manifest_size];
    decoder
        .read_exact(&mut manifest_bytes)
        .map_err(to_io_error)?;
    serde_json::from_slice::<serde_json::Value>(&manifest_bytes)
        .map_err(|error| format!("Invalid recording manifest: {error}"))
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

fn build_astral_optimization_plan(
    options: &AstralRecordingOptimizeOptions,
    ffmpeg_command: &str,
) -> AstralOptimizationPlan {
    let cpu_count = available_cpu_count();
    let memory_limit_mb = options.memory_limit_mb.filter(|value| *value > 0);
    let max_height = options
        .max_height
        .unwrap_or_else(|| default_optimization_max_height(cpu_count, memory_limit_mb))
        .clamp(240, 2160);
    let target_video_bitrate_kbps = options
        .target_video_bitrate_kbps
        .unwrap_or_else(|| default_video_bitrate_kbps(max_height, cpu_count, memory_limit_mb))
        .max(250);
    let target_audio_bitrate_kbps = options
        .target_audio_bitrate_kbps
        .unwrap_or_else(|| default_audio_bitrate_kbps(memory_limit_mb))
        .max(32);
    let thread_cap = optimization_thread_cap(cpu_count, memory_limit_mb);
    let cpu_threads = options
        .cpu_threads
        .unwrap_or(thread_cap)
        .clamp(1, thread_cap);
    let cpu_used = if cpu_threads <= 1 || memory_limit_mb.is_some_and(|value| value <= 1536) {
        6
    } else if cpu_threads <= 2 {
        5
    } else if cpu_threads >= 6 && max_height >= 1080 {
        3
    } else {
        4
    };
    let gpu_vendor = parse_gpu_vendor(
        options.gpu_vendor.as_deref(),
        options.gpu_renderer.as_deref(),
    );
    let prefer_hardware_encoding = options.prefer_hardware_encoding.unwrap_or(false);
    let hardware_video_encoder = if prefer_hardware_encoding {
        select_hardware_video_encoder(ffmpeg_command, gpu_vendor)
    } else {
        None
    };

    AstralOptimizationPlan {
        target_video_bitrate_kbps,
        target_audio_bitrate_kbps,
        max_height,
        cpu_threads,
        audio_threads: cpu_threads.min(2).max(1),
        cpu_used,
        hardware_video_encoder,
        use_hardware_decode: prefer_hardware_encoding
            && hardware_video_encoder.is_none()
            && gpu_vendor != AstralGpuVendor::Unknown,
    }
}

fn available_cpu_count() -> u32 {
    std::thread::available_parallelism()
        .map(|parallelism| u32::try_from(parallelism.get()).unwrap_or(32).clamp(1, 32))
        .unwrap_or(4)
}

fn optimization_thread_cap(cpu_count: u32, memory_limit_mb: Option<u32>) -> u32 {
    let cpu_cap = match cpu_count {
        0..=2 => 1,
        3..=4 => cpu_count.saturating_sub(1),
        5..=8 => cpu_count.saturating_sub(1),
        _ => cpu_count.saturating_sub(2).min(10),
    }
    .max(1);
    let memory_cap = match memory_limit_mb {
        Some(value) if value < 1024 => 1,
        Some(value) if value < 2048 => 2,
        Some(value) if value < 4096 => 4,
        Some(value) if value < 6144 => 6,
        _ => 8,
    };

    cpu_cap.min(memory_cap).max(1)
}

fn default_optimization_max_height(cpu_count: u32, memory_limit_mb: Option<u32>) -> u32 {
    if cpu_count <= 2 || memory_limit_mb.is_some_and(|value| value < 1536) {
        480
    } else if cpu_count >= 8 && memory_limit_mb.is_some_and(|value| value >= 4096) {
        1080
    } else {
        720
    }
}

fn default_video_bitrate_kbps(
    max_height: u32,
    cpu_count: u32,
    memory_limit_mb: Option<u32>,
) -> u32 {
    if max_height >= 1080 {
        if cpu_count >= 8 && memory_limit_mb.map_or(true, |value| value >= 4096) {
            2200
        } else {
            1900
        }
    } else if max_height >= 720 {
        if cpu_count >= 6 && memory_limit_mb.map_or(true, |value| value >= 2048) {
            1400
        } else {
            1100
        }
    } else {
        800
    }
}

fn default_audio_bitrate_kbps(memory_limit_mb: Option<u32>) -> u32 {
    match memory_limit_mb {
        Some(value) if value < 1536 => 64,
        Some(value) if value >= 5120 => 128,
        _ => 96,
    }
}

fn parse_gpu_vendor(vendor: Option<&str>, renderer: Option<&str>) -> AstralGpuVendor {
    let value = format!(
        "{} {}",
        vendor.unwrap_or_default(),
        renderer.unwrap_or_default()
    )
    .to_ascii_lowercase();
    if value.contains("nvidia") {
        AstralGpuVendor::Nvidia
    } else if value.contains("amd") || value.contains("radeon") {
        AstralGpuVendor::Amd
    } else if value.contains("intel") {
        AstralGpuVendor::Intel
    } else if value.contains("apple") {
        AstralGpuVendor::Apple
    } else {
        AstralGpuVendor::Unknown
    }
}

fn select_hardware_video_encoder(
    ffmpeg_command: &str,
    gpu_vendor: AstralGpuVendor,
) -> Option<&'static str> {
    let supported_encoders = supported_ffmpeg_encoder_names(ffmpeg_command);
    let candidates: &[&str] = match gpu_vendor {
        AstralGpuVendor::Intel => &["vp9_qsv", "vp9_vaapi"],
        AstralGpuVendor::Nvidia => &["vp9_nvenc", "vp9_vaapi"],
        AstralGpuVendor::Amd => &["vp9_amf", "vp9_vaapi"],
        AstralGpuVendor::Apple => &["vp9_videotoolbox"],
        AstralGpuVendor::Unknown => &[
            "vp9_qsv",
            "vp9_vaapi",
            "vp9_nvenc",
            "vp9_amf",
            "vp9_videotoolbox",
        ],
    };

    candidates
        .iter()
        .copied()
        .find(|candidate| supported_encoders.contains(*candidate))
}

fn supported_ffmpeg_encoder_names(ffmpeg_command: &str) -> HashSet<String> {
    let mut command = Command::new(ffmpeg_command);
    configure_background_process(&mut command);
    let Ok(output) = command
        .args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    else {
        return HashSet::new();
    };

    if !output.status.success() {
        return HashSet::new();
    }

    let mut encoders = HashSet::new();
    let encoder_output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for encoder in [
        "vp9_qsv",
        "vp9_vaapi",
        "vp9_nvenc",
        "vp9_amf",
        "vp9_videotoolbox",
    ] {
        if encoder_output.contains(encoder) {
            encoders.insert(encoder.to_string());
        }
    }

    encoders
}

fn build_cpu_video_optimization_args(
    segment_path: &Path,
    temp_path: &Path,
    video_bitrate: &str,
    audio_bitrate: &str,
    scale_filter: &str,
    plan: &AstralOptimizationPlan,
    use_hardware_decode: bool,
) -> Vec<String> {
    let mut args = common_ffmpeg_input_args(segment_path, use_hardware_decode);
    push_ffmpeg_args(
        &mut args,
        &[
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            video_bitrate,
            "-deadline",
            "good",
            "-threads",
            &plan.cpu_threads.to_string(),
            "-cpu-used",
            &plan.cpu_used.to_string(),
            "-row-mt",
            "1",
        ],
    );

    let tile_columns = if plan.cpu_threads >= 8 {
        3
    } else if plan.cpu_threads >= 4 {
        2
    } else if plan.cpu_threads >= 2 {
        1
    } else {
        0
    };
    if tile_columns > 0 {
        push_ffmpeg_args(&mut args, &["-tile-columns", &tile_columns.to_string()]);
    }

    push_ffmpeg_args(
        &mut args,
        &[
            "-vf",
            scale_filter,
            "-c:a",
            "libopus",
            "-b:a",
            audio_bitrate,
            "-f",
            "webm",
        ],
    );
    args.push(path_to_string(temp_path));
    args
}

fn build_hardware_video_optimization_args(
    segment_path: &Path,
    temp_path: &Path,
    video_bitrate: &str,
    audio_bitrate: &str,
    scale_filter: &str,
    encoder: &str,
) -> Vec<String> {
    let mut args = common_ffmpeg_input_args(segment_path, true);
    push_ffmpeg_args(
        &mut args,
        &[
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            encoder,
            "-b:v",
            video_bitrate,
            "-vf",
            scale_filter,
            "-c:a",
            "libopus",
            "-b:a",
            audio_bitrate,
            "-f",
            "webm",
        ],
    );
    args.push(path_to_string(temp_path));
    args
}

fn common_ffmpeg_input_args(segment_path: &Path, use_hardware_decode: bool) -> Vec<String> {
    let mut args = Vec::from([
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-nostdin".to_string(),
        "-y".to_string(),
    ]);
    if use_hardware_decode {
        push_ffmpeg_args(&mut args, &["-hwaccel", "auto"]);
    }
    args.push("-i".to_string());
    args.push(path_to_string(segment_path));
    args
}

fn push_ffmpeg_args(args: &mut Vec<String>, values: &[&str]) {
    args.extend(values.iter().map(|value| (*value).to_string()));
}

fn optimize_media_segment(
    segment_path: &Path,
    ffmpeg_command: &str,
    ffprobe_command: &str,
    plan: &AstralOptimizationPlan,
) -> Result<bool, String> {
    let original_size = fs::metadata(segment_path).map_err(to_io_error)?.len();
    let temp_path = segment_path.with_extension("optimized.tmp.webm");
    if temp_path.exists() {
        fs::remove_file(&temp_path).map_err(to_io_error)?;
    }

    let video_bitrate = format!("{}k", plan.target_video_bitrate_kbps);
    let audio_bitrate = format!("{}k", plan.target_audio_bitrate_kbps);
    let scale_filter = format!("scale=-2:min({}\\,ih)", plan.max_height);
    let stream_info = media_segment_streams(ffprobe_command, segment_path)?;
    if matches!(stream_info, Some((false, false))) {
        return Ok(false);
    }

    if matches!(stream_info, Some((false, true))) {
        run_audio_only_optimization(
            ffmpeg_command,
            segment_path,
            &temp_path,
            &audio_bitrate,
            plan.audio_threads,
        )?;
    } else {
        let mut used_accelerated_attempt = false;
        let mut video_result = if let Some(encoder) = plan.hardware_video_encoder {
            used_accelerated_attempt = true;
            run_ffmpeg_command(
                ffmpeg_command,
                &build_hardware_video_optimization_args(
                    segment_path,
                    &temp_path,
                    &video_bitrate,
                    &audio_bitrate,
                    &scale_filter,
                    encoder,
                ),
            )
        } else if plan.use_hardware_decode {
            used_accelerated_attempt = true;
            run_ffmpeg_command(
                ffmpeg_command,
                &build_cpu_video_optimization_args(
                    segment_path,
                    &temp_path,
                    &video_bitrate,
                    &audio_bitrate,
                    &scale_filter,
                    plan,
                    true,
                ),
            )
        } else {
            run_ffmpeg_command(
                ffmpeg_command,
                &build_cpu_video_optimization_args(
                    segment_path,
                    &temp_path,
                    &video_bitrate,
                    &audio_bitrate,
                    &scale_filter,
                    plan,
                    false,
                ),
            )
        };

        if video_result.is_err() && used_accelerated_attempt {
            if temp_path.exists() {
                let _ = fs::remove_file(&temp_path);
            }

            video_result = run_ffmpeg_command(
                ffmpeg_command,
                &build_cpu_video_optimization_args(
                    segment_path,
                    &temp_path,
                    &video_bitrate,
                    &audio_bitrate,
                    &scale_filter,
                    plan,
                    false,
                ),
            );
        }

        if let Err(error) = video_result {
            if temp_path.exists() {
                let _ = fs::remove_file(&temp_path);
            }

            if stream_info.is_none() && is_missing_video_stream_error(&error) {
                run_audio_only_optimization(
                    ffmpeg_command,
                    segment_path,
                    &temp_path,
                    &audio_bitrate,
                    plan.audio_threads,
                )?;
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
    audio_threads: u32,
) -> Result<(), String> {
    run_ffmpeg_command(
        ffmpeg_command,
        &vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-nostdin".to_string(),
            "-y".to_string(),
            "-i".to_string(),
            path_to_string(segment_path),
            "-map".to_string(),
            "0:a?".to_string(),
            "-vn".to_string(),
            "-c:a".to_string(),
            "libopus".to_string(),
            "-b:a".to_string(),
            audio_bitrate.to_string(),
            "-threads".to_string(),
            audio_threads.to_string(),
            "-f".to_string(),
            "webm".to_string(),
            path_to_string(temp_path),
        ],
    )
}

fn media_segment_streams(
    ffprobe_command: &str,
    segment_path: &Path,
) -> Result<Option<(bool, bool)>, String> {
    let mut command = Command::new(ffprobe_command);
    configure_background_process(&mut command);
    let output = command
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            &path_to_string(segment_path),
        ])
        .stdin(Stdio::null())
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
        stdout
            .lines()
            .any(|line| line.trim().eq_ignore_ascii_case("video")),
        stdout
            .lines()
            .any(|line| line.trim().eq_ignore_ascii_case("audio")),
    )))
}

fn is_missing_video_stream_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("stream map '0:v:0' matches no streams")
        || error.contains("matches no streams")
        || error.contains("no such stream")
}

fn run_ffmpeg_command(ffmpeg_command: &str, args: &[String]) -> Result<(), String> {
    let mut command = Command::new(ffmpeg_command);
    configure_background_process(&mut command);
    let output = command
        .args(args)
        .stdin(Stdio::null())
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

#[cfg(windows)]
fn configure_background_process(command: &mut Command) {
    command.creation_flags(BACKGROUND_PROCESS_FLAGS);
}

#[cfg(not(windows))]
fn configure_background_process(_: &mut Command) {}

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

fn unique_recovered_package_path(recordings_root: &Path, session_id: &str) -> PathBuf {
    let default_path = recordings_root.join(format!("{session_id}.astral"));
    if !default_path.exists() {
        return default_path;
    }

    unique_export_path(recordings_root, &format!("{session_id}-recovered.astral"))
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
            PathBuf::from("src-tauri")
                .join("bin")
                .join(&executable_name),
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
    emit_optimize_progress_detail(
        app, job_id, stage, message, current, total, None, None, None, None, None, 0, 0, None, None,
    );
}

fn emit_optimize_progress_detail(
    app: &AppHandle,
    job_id: &str,
    stage: &str,
    message: &str,
    current: u32,
    total: u32,
    progress_percent: Option<u8>,
    segment_index: Option<u32>,
    current_segment: Option<&str>,
    current_segment_size: Option<u64>,
    optimized_segment_size: Option<u64>,
    optimized_segment_count: u32,
    skipped_segment_count: u32,
    package_current_bytes: Option<u64>,
    package_total_bytes: Option<u64>,
) {
    let _ = app.emit(
        "astral-recording-optimize-progress",
        AstralRecordingOptimizeProgress {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            message: message.to_string(),
            current,
            total,
            progress_percent,
            segment_index,
            current_segment: current_segment.map(|value| value.to_string()),
            current_segment_size,
            optimized_segment_size,
            optimized_segment_count,
            skipped_segment_count,
            package_current_bytes,
            package_total_bytes,
        },
    );
}

fn emit_package_progress(
    app: &AppHandle,
    job_id: &str,
    stage: &str,
    message: &str,
    current_bytes: u64,
    total_bytes: u64,
    progress_percent: u8,
    current_file: Option<&str>,
    astral_path: Option<&str>,
    astral_size: Option<u64>,
    error: Option<&str>,
) {
    let _ = app.emit(
        "astral-recording-package-progress",
        AstralRecordingPackageProgress {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            message: message.to_string(),
            current_bytes,
            total_bytes,
            progress_percent,
            current_file: current_file.map(|value| value.to_string()),
            astral_path: astral_path.map(|value| value.to_string()),
            astral_size,
            error: error.map(|value| value.to_string()),
        },
    );
}

fn package_progress_percent(current_bytes: u64, total_bytes: u64) -> u8 {
    if total_bytes == 0 {
        return 0;
    }

    (((current_bytes as u128) * 100) / (total_bytes as u128)).min(100) as u8
}

fn optimize_segment_progress_percent(completed_segments: u32, total_segments: u32) -> u8 {
    if total_segments == 0 {
        return 0;
    }

    (((completed_segments as u128) * 90) / (total_segments as u128)).min(90) as u8
}

fn optimize_package_progress_percent(current_bytes: u64, total_bytes: u64) -> u8 {
    if total_bytes == 0 {
        return 90;
    }

    let packaging_percent = ((current_bytes as u128) * 9) / (total_bytes as u128);
    (90u128 + packaging_percent).min(99) as u8
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

fn is_recordable_session_dir_name(session_id: &str) -> bool {
    session_id.starts_with("astral-")
        && !session_id.starts_with("astral-import-")
        && session_id != "optimization"
        && validate_session_id(session_id).is_ok()
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

fn count_unique_participants(participant_media: &[serde_json::Value]) -> u64 {
    let mut participant_ids = HashSet::new();
    for participant in participant_media {
        if let Some(participant_id) = participant
            .get("participantId")
            .and_then(|value| value.as_str())
        {
            participant_ids.insert(participant_id.to_string());
        }
    }

    participant_ids.len() as u64
}

fn infer_session_started_at_ms(session_id: &str) -> u64 {
    session_id
        .strip_prefix("astral-")
        .and_then(|suffix| suffix.split('-').next())
        .and_then(|value| value.parse::<u128>().ok())
        .and_then(|nanoseconds| u64::try_from(nanoseconds / 1_000_000).ok())
        .unwrap_or_else(now_unix_ms)
}

fn guess_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("mp4") | Some("m4v") | Some("mov") => "video/mp4",
        Some("ogg") | Some("opus") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        _ => "video/webm",
    }
}

fn now_unix_ms() -> u64 {
    system_time_to_unix_ms(SystemTime::now())
}

fn system_time_to_unix_ms(time: SystemTime) -> u64 {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    u64::try_from(millis).unwrap_or(u64::MAX)
}

fn unix_ms_to_iso(ms: u64) -> String {
    let total_seconds = ms / 1000;
    let millis = ms % 1000;
    let days = (total_seconds / 86_400) as i64;
    let seconds_of_day = total_seconds % 86_400;
    let (year, month, day) = civil_from_unix_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_unix_days(days: i64) -> (i64, u64, u64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month as u64, day as u64)
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
            astral_recording_recover_package,
            astral_recording_abort,
            astral_recording_export_package,
            astral_recording_import_package,
            astral_recording_import_unpacked_session,
            astral_recording_list_local_packages,
            astral_recording_list_unpacked_sessions,
            astral_recording_package_unpacked_session,
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
