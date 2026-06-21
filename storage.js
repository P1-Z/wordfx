'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appDirectory = path.resolve(__dirname);
const legacyDataDirectory = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'slashslash');
const dataDirectory = process.env.SLASHSLASH_DATA_DIR
  ? path.resolve(process.env.SLASHSLASH_DATA_DIR)
  : path.join(appDirectory, 'data');
const noteDirectoryConfigName = 'note-directory.json';

let dataDirectoryPrepared = false;

function copyMissingData(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyMissingData(sourcePath, targetPath);
    else if (entry.isFile() && !fs.existsSync(targetPath)) fs.copyFileSync(sourcePath, targetPath);
  }
}

function ensureDataDirectory() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  if (!dataDirectoryPrepared) {
    dataDirectoryPrepared = true;
    const usesPortableDefault = !process.env.SLASHSLASH_DATA_DIR;
    if (usesPortableDefault && path.resolve(legacyDataDirectory) !== path.resolve(dataDirectory)) {
      copyMissingData(legacyDataDirectory, dataDirectory);
    }
  }
  return dataDirectory;
}

function dataPath(...parts) {
  return path.join(ensureDataDirectory(), ...parts);
}

function ensureFile(relativePath, initialContent = '') {
  const target = dataPath(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) fs.writeFileSync(target, initialContent, 'utf8');
  return target;
}

function dataPathWithLegacy(relativePath, legacyPath) {
  const target = dataPath(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target) && legacyPath && fs.existsSync(legacyPath)) fs.copyFileSync(legacyPath, target);
  return target;
}

function notesDirectory() {
  const fallback = dataPath('notes');
  const configPath = dataPath(noteDirectoryConfigName);
  let directory = fallback;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof config.directory === 'string' && config.directory.trim()) {
      directory = path.resolve(config.directory);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read note directory setting: ${error.message}`);
  }
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function noteFilePath(fileName, legacyPath) {
  const directory = notesDirectory();
  const target = path.join(directory, fileName);
  const usingDefaultDirectory = path.resolve(directory) === path.resolve(dataPath('notes'));
  if (usingDefaultDirectory && !fs.existsSync(target) && legacyPath && fs.existsSync(legacyPath)) {
    fs.copyFileSync(legacyPath, target);
  }
  return target;
}

function setNotesDirectory(requestedDirectory) {
  const directory = path.resolve(requestedDirectory);
  if (!fs.existsSync(directory)) throw new Error(`Directory not found: ${directory}`);
  if (!fs.statSync(directory).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  fs.accessSync(directory, fs.constants.W_OK);

  const previousDirectory = notesDirectory();
  const copied = [];
  for (const fileName of ['notes.txt', 'fix.txt']) {
    const source = path.join(previousDirectory, fileName);
    const target = path.join(directory, fileName);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.copyFileSync(source, target);
      copied.push(fileName);
    }
  }

  const configPath = dataPath(noteDirectoryConfigName);
  const temporaryPath = `${configPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ directory }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, configPath);
  return { directory, copied };
}

module.exports = {
  appDirectory,
  dataDirectory,
  dataPath,
  dataPathWithLegacy,
  ensureFile,
  ensureDataDirectory,
  noteFilePath,
  notesDirectory,
  setNotesDirectory,
};
