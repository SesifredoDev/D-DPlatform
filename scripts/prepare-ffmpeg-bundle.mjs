import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(rootDir, 'src-tauri', 'bin');
const extension = process.platform === 'win32' ? '.exe' : '';
const tools = ['ffmpeg', 'ffprobe'];

mkdirSync(targetDir, { recursive: true });

const missing = [];

for (const tool of tools) {
  const target = join(targetDir, `${tool}${extension}`);
  if (existsSync(target)) {
    continue;
  }

  const source = findTool(`${tool}${extension}`);
  if (!source) {
    missing.push(tool);
    continue;
  }

  copyFileSync(source, target);
  console.log(`Bundled ${tool} from ${source}`);
}

if (missing.length > 0) {
  console.error(
    [
      `Missing required media tool${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      'Install FFmpeg on the build machine or set FFMPEG_DIR to a directory containing ffmpeg and ffprobe before running a Tauri package build.',
    ].join('\n'),
  );
  process.exit(1);
}

function findTool(executableName) {
  const envDir = process.env.FFMPEG_DIR;
  if (envDir) {
    const candidate = join(envDir, executableName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const pathCandidate = findOnPath(executableName);
  if (pathCandidate) {
    return pathCandidate;
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const wingetPackages = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
      const wingetCandidate = findFileRecursive(wingetPackages, executableName, 5);
      if (wingetCandidate) {
        return wingetCandidate;
      }
    }
  }

  return null;
}

function findOnPath(executableName) {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, [executableName], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const firstMatch = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return firstMatch && existsSync(firstMatch) ? firstMatch : null;
}

function findFileRecursive(directory, executableName, depth) {
  if (depth < 0 || !existsSync(directory)) {
    return null;
  }

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === executableName.toLowerCase()) {
      return fullPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = join(directory, entry.name);
    if (isLikelyHugeDirectory(fullPath)) {
      continue;
    }

    const found = findFileRecursive(fullPath, executableName, depth - 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function isLikelyHugeDirectory(directory) {
  try {
    return lstatSync(directory).isSymbolicLink();
  } catch {
    return false;
  }
}
