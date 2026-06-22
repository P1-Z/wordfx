#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageManifest = require('./package.json');

const DEFAULT_REPOSITORY = 'P1-Z/wordfx';
const ARCHIVE_NAME = 'slashslash-windows.zip';
const CHECKSUM_NAME = `${ARCHIVE_NAME}.sha256`;
const UPDATE_EXIT_CODE = 42;
const EXIT_NETWORK = 2;
const EXIT_RATE_LIMITED = 3;
const EXIT_NO_RELEASE = 4;
const REQUIRED_FILES = ['package.json', 'wordfx.js', 'command-mode.js', 'updater.js', 'launch-wordfx.cmd'];
const PROTECTED_ROOTS = new Set([
  '.git',
  '.dev.vars',
  '.env',
  'credentials.json',
  'data',
  'notes',
  'linked-apps.json',
  'linked-directories.json',
  'theme.json',
]);

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function parseVersion(value) {
  const match = cleanVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`Invalid release version: ${value}`);
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] || '',
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return Math.sign(a.numbers[index] - b.numbers[index]);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function normalizeRelativePath(value) {
  const normalized = path.normalize(String(value || '')).replace(/^[\\/]+/, '');
  if (!normalized || path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe release path: ${value}`);
  }
  const firstPart = normalized.split(path.sep)[0].toLowerCase();
  if (PROTECTED_ROOTS.has(firstPart) || firstPart.startsWith('.env.') || firstPart.startsWith('.dev.vars.')) {
    throw new Error(`Release tried to replace protected data: ${value}`);
  }
  return normalized;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function checksumFromFile(value) {
  const match = String(value).match(/\b([a-f0-9]{64})\b/i);
  if (!match) throw new Error('The release checksum file is invalid.');
  return match[1].toLowerCase();
}

async function fetchChecked(url, type = 'buffer') {
  const response = await fetch(url, {
    headers: {
      Accept: type === 'json' ? 'application/vnd.github+json' : 'application/octet-stream',
      'User-Agent': `slashslash-updater/${packageManifest.version}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'follow',
  });
  if (response.status === 403) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const error = new Error('GitHub API rate limit reached. Try again in a few minutes.');
      error.exitCode = EXIT_RATE_LIMITED;
      throw error;
    }
  }
  if (response.status === 404) {
    const error = new Error('No releases found on GitHub.');
    error.exitCode = EXIT_NO_RELEASE;
    throw error;
  }
  if (!response.ok) throw new Error(`Update server returned HTTP ${response.status}.`);
  if (type === 'json') return response.json();
  return Buffer.from(await response.arrayBuffer());
}

function releaseAsset(release, name) {
  const asset = release.assets?.find(candidate => candidate.name === name);
  if (!asset?.browser_download_url) throw new Error(`Release is missing ${name}.`);
  return asset.browser_download_url;
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function extractArchive(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `Expand-Archive -LiteralPath ${quotePowerShellLiteral(archivePath)} -DestinationPath ${quotePowerShellLiteral(destination)} -Force`,
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Could not extract the update.').trim());
}

function readReleaseManifest(sourceDirectory) {
  const manifestPath = path.join(sourceDirectory, '.release-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.files)) {
    throw new Error('The release manifest is invalid.');
  }
  const files = [...new Set(manifest.files.map(normalizeRelativePath))];
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) throw new Error(`Release manifest is missing ${required}.`);
  }
  for (const relativePath of files) {
    if (!fs.statSync(path.join(sourceDirectory, relativePath)).isFile()) {
      throw new Error(`Release file is missing: ${relativePath}`);
    }
  }
  return { version: cleanVersion(manifest.version), files };
}

function applyUpdate(sourceDirectory, targetDirectory, files, backupDirectory) {
  const changed = [];
  fs.mkdirSync(backupDirectory, { recursive: true });
  try {
    for (const requestedPath of files) {
      const relativePath = normalizeRelativePath(requestedPath);
      const sourcePath = path.join(sourceDirectory, relativePath);
      const targetPath = path.join(targetDirectory, relativePath);
      const backupPath = path.join(backupDirectory, relativePath);
      const existed = fs.existsSync(targetPath);

      if (existed) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(targetPath, backupPath);
      }
      changed.push({ targetPath, backupPath, existed });
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  } catch (error) {
    for (const entry of changed.reverse()) {
      try {
        if (entry.existed) fs.copyFileSync(entry.backupPath, entry.targetPath);
        else fs.rmSync(entry.targetPath, { force: true });
      } catch {}
    }
    throw new Error(`Update could not be applied and was rolled back: ${error.message}`);
  }
}

async function runUpdate() {
  const repository = process.env.WORDFX_UPDATE_REPOSITORY || DEFAULT_REPOSITORY;
  const apiUrl = process.env.WORDFX_UPDATE_API || `https://api.github.com/repos/${repository}/releases/latest`;
  const currentVersion = cleanVersion(packageManifest.version);
  console.log('\n:// UPDATE');
  console.log(`Current version: v${currentVersion}`);
  console.log('Checking GitHub Releases...');

  const release = await fetchChecked(apiUrl, 'json');
  const latestVersion = cleanVersion(release.tag_name);
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    console.log(`Already up to date: v${currentVersion}`);
    return false;
  }

  console.log(`Downloading v${latestVersion}...`);
  const [archive, checksumFile] = await Promise.all([
    fetchChecked(releaseAsset(release, ARCHIVE_NAME)),
    fetchChecked(releaseAsset(release, CHECKSUM_NAME)),
  ]);
  const expectedChecksum = checksumFromFile(checksumFile.toString('utf8'));
  const actualChecksum = sha256(archive);
  if (actualChecksum !== expectedChecksum) throw new Error('Downloaded update failed SHA-256 verification.');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slashslash-update-'));
  try {
    const archivePath = path.join(temporaryRoot, ARCHIVE_NAME);
    const sourceDirectory = path.join(temporaryRoot, 'release');
    const backupDirectory = path.join(temporaryRoot, 'backup');
    fs.writeFileSync(archivePath, archive);
    console.log('Verified. Installing update...');
    extractArchive(archivePath, sourceDirectory);
    const manifest = readReleaseManifest(sourceDirectory);
    if (manifest.version !== latestVersion) {
      throw new Error(`Release version mismatch: tag v${latestVersion}, package v${manifest.version}.`);
    }
    applyUpdate(sourceDirectory, __dirname, manifest.files, backupDirectory);
    console.log(`Updated to v${latestVersion}. Restarting ://...`);
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runUpdate()
    .then(updated => {
      process.exitCode = updated ? UPDATE_EXIT_CODE : 0;
    })
    .catch(error => {
      if (error?.code === 'UND_ERR_CONNECT_TIMEOUT' || error?.cause?.code === 'ENOTFOUND' || error?.cause?.code === 'ECONNREFUSED') {
        console.error('Update failed: Could not reach GitHub. Check your internet connection.');
        process.exitCode = EXIT_NETWORK;
      } else {
        console.error(`Update failed: ${error.message}`);
        process.exitCode = error.exitCode || 1;
      }
    });
}

module.exports = {
  EXIT_NETWORK,
  EXIT_NO_RELEASE,
  EXIT_RATE_LIMITED,
  UPDATE_EXIT_CODE,
  applyUpdate,
  checksumFromFile,
  cleanVersion,
  compareVersions,
  normalizeRelativePath,
  readReleaseManifest,
  sha256,
};
