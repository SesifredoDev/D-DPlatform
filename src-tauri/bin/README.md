Place optional media tooling here for Astral post-session optimization.

Windows:
- ffmpeg.exe
- ffprobe.exe (optional)
- FFMPEG-LICENSE
- FFMPEG-README.txt

Packaged Tauri builds include this directory as app resources. The package build
runs `npm run tauri:prepare-ffmpeg` before Angular builds so local binaries can be
copied from PATH, `FFMPEG_DIR`, or the Windows WinGet install location.

The optimizer also checks this directory during development before falling back to
PATH.

The bundled Windows binaries currently come from the Gyan FFmpeg full build.
Review the included FFmpeg license/readme before distributing application builds.
