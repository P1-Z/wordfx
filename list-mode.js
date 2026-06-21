#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ansi: colors, rgb: themeRgb, getSkin, renderThemeBar, themeSpinner } = require('./theme');
const { dataPathWithLegacy } = require('./storage');
const { playSound, playTypingSound, warmSoundSystem } = require('./sound');

if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1);

let activeMode = process.argv[2];
let currentTarget = process.argv[3];
let browseRoot = activeMode === 'folder' && currentTarget ? path.resolve(currentTarget) : '';

function displayPath(value) {
  return String(value).replace(/(^|[\\/])wordfx(?=([\\/]|$))/gi, '$1://');
}
const root = __dirname;
const at = (row, column, text) => `\x1b[${row};${column}H${text}`;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const fileTypes = [
  ['FLA', 'ϟ', colors.pink, new Set(['.fla'])],
  ['TXT', '¶', colors.cyan, new Set(['.txt', '.md', '.rtf', '.log', '.csv', '.json', '.xml', '.html', '.css', '.js', '.ts', '.yml', '.yaml', '.ini', '.ps1', '.cmd', '.bat'])],
  ['VIDEO', '▶', colors.pink, new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m4v', '.flv'])],
  ['AUDIO', '♪', colors.yellow, new Set(['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'])],
  ['IMAGE', '▧', colors.purple, new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff'])],
];

function readRegistry(filename) {
  const target = dataPathWithLegacy(filename, path.join(root, filename));
  if (!fs.existsSync(target)) return {};
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function classify(name, isDirectory) {
  if (isDirectory) return { type: 'DIR', symbol: '▰', color: colors.green };
  const extension = path.extname(name).toLowerCase();
  for (const [type, symbol, color, extensions] of fileTypes) {
    if (extensions.has(extension)) return { type, symbol, color };
  }
  return { type: 'FILE', symbol: '◆', color: colors.white };
}

function loadEntries() {
  if (activeMode === 'apps') {
    return Object.entries(readRegistry('linked-apps.json'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, value, type: 'APP', symbol: '●', color: colors.pink }));
  }
  if (activeMode === 'links') {
    return Object.entries(readRegistry('linked-directories.json'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, value, type: 'LINK', symbol: '↗', color: colors.cyan }));
  }
  if (activeMode === 'folder') {
    return fs.readdirSync(currentTarget, { withFileTypes: true })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map(entry => ({ name: entry.name, value: '', isDirectory: entry.isDirectory(), ...classify(entry.name, entry.isDirectory()) }));
  }
  throw new Error(`Unknown list mode: ${activeMode || '(missing)'}`);
}

function openTarget(targetPath) {
  const { spawn } = require('node:child_process');
  const extension = path.extname(targetPath).toLowerCase();
  const directlyExecutable = ['.exe', '.com', '.bat', '.cmd'].includes(extension);
  const child = directlyExecutable
    ? spawn(targetPath, [], { detached: true, stdio: 'ignore', windowsHide: false })
    : spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore', windowsHide: false });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function playOpenAnimation(targetPath) {
  await warmSoundSystem();
  playSound('opening or loading');
  const name = path.basename(targetPath) || targetPath;
  const frames = 20;
  for (let frame = 0; frame <= frames; frame++) {
    const { width, height } = size();
    const progress = frame / frames;
    const barWidth = Math.max(14, Math.min(42, width - 14));
    const filled = Math.round(progress * barWidth);
    const themedBar = renderThemeBar(progress, barWidth, frame);
    const bar = `${colors.pink}${'█'.repeat(filled)}${colors.dim}${'░'.repeat(barWidth - filled)}${colors.reset}`;
    const label = `OPENING  //  ${name}`.slice(0, Math.max(8, width - 8));
    const center = Math.max(3, Math.floor(height / 2));
    let output = '\x1b[?25l\x1b[H';
    for (let row = 1; row <= height; row++) output += at(row, 1, '\x1b[2K');
    if (getSkin() === 'macintosh') {
      const percentage = `${String(Math.round(progress * 100)).padStart(3)}%`;
      output += at(center - 2, Math.max(1, Math.floor((width - label.length) / 2) + 1), `${colors.dim}${label}${colors.reset}`);
      output += at(center, Math.max(1, Math.floor(width / 2) + 1), `${colors.purple}${colors.bold}${themeSpinner(frame)}${colors.reset}`);
      output += at(center + 2, Math.max(1, Math.floor((width - percentage.length) / 2) + 1), `${colors.white}${percentage}${colors.reset}`);
    } else {
      output += at(center - 2, Math.max(1, Math.floor((width - label.length) / 2) + 1), `${colors.bold}${colors.white}${label}${colors.reset}`);
      output += at(center, Math.max(1, Math.floor((width - barWidth) / 2) + 1), themedBar);
      const status = frame < frames ? `${Math.round(progress * 100)}%  LOADING TARGET` : 'TARGET READY';
      output += at(center + 2, Math.max(1, Math.floor((width - status.length) / 2) + 1), `${frame < frames ? colors.dim : colors.green}${status}${colors.reset}`);
    }
    process.stdout.write(output);
    await wait(28);
  }
  await wait(80);
}

function size() {
  return { width: Math.max(24, process.stdout.columns || 80), height: Math.max(10, process.stdout.rows || 24) };
}

function viewerTitle() {
  if (activeMode === 'apps') return 'LINKED APPLICATIONS';
  if (activeMode === 'links') return 'LINKED DIRECTORIES';
  return `FOLDER  //  ${displayPath(currentTarget)}`;
}

function isInsideBrowseRoot(candidate) {
  if (!browseRoot) return false;
  const relative = path.relative(browseRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function render(entries, selected, offset, query) {
  const { width, height } = size();
  const boxWidth = Math.min(118, width - 2);
  const inside = boxWidth - 2;
  const contentWidth = inside - 4;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const visibleRows = Math.max(1, height - 9);
  const safeSelected = entries.length ? Math.max(0, Math.min(selected, entries.length - 1)) : 0;
  const maximumOffset = Math.max(0, entries.length - visibleRows);
  let safeOffset = Math.max(0, Math.min(offset, maximumOffset));
  if (safeSelected < safeOffset) safeOffset = safeSelected;
  if (safeSelected >= safeOffset + visibleRows) safeOffset = safeSelected - visibleRows + 1;
  let output = '\x1b[?25l\x1b[H';
  for (let row = 1; row <= height; row++) output += at(row, 1, '\x1b[2K');
  output += at(1, left, `${colors.purple}╭${'─'.repeat(inside)}╮${colors.reset}`);
  const title = `${viewerTitle()}  //  ${entries.length} ITEMS`.slice(0, contentWidth);
  output += at(2, left, `${colors.purple}│${colors.reset}  ${colors.bold}${colors.white}${title}${colors.reset}${' '.repeat(contentWidth - title.length)}  ${colors.purple}│${colors.reset}`);
  const search = `SEARCH ▸ ${query || '(type to filter)'}`.slice(0, contentWidth);
  output += at(3, left, `${colors.purple}│${colors.reset}  ${colors.cyan}${search}${colors.reset}${' '.repeat(contentWidth - search.length)}  ${colors.purple}│${colors.reset}`);
  output += at(4, left, `${colors.purple}├${'─'.repeat(inside)}┤${colors.reset}`);

  for (let row = 0; row < visibleRows; row++) {
    const entryIndex = safeOffset + row;
    const entry = entries[entryIndex];
    let content = '';
    let visibleLength = 0;
    if (entry) {
      const prefix = `${entry.symbol} ${entry.type.padEnd(5)} `;
      const suffix = entry.value ? `  ${displayPath(entry.value)}` : '';
      const raw = `${prefix}${entry.name}${suffix}`;
      const clipped = raw.length > contentWidth ? `${raw.slice(0, Math.max(1, contentWidth - 1))}…` : raw;
      visibleLength = clipped.length;
      const selectedStyle = entryIndex === safeSelected ? `\x1b[1;48;2;${themeRgb.selection.join(';')}m` : '';
      content = `${selectedStyle}${entry.color}${clipped}${' '.repeat(Math.max(0, contentWidth - visibleLength))}${colors.reset}`;
      visibleLength = contentWidth;
    }
    output += at(5 + row, left, `${colors.purple}│${colors.reset}  ${content}${' '.repeat(Math.max(0, contentWidth - visibleLength))}  ${colors.purple}│${colors.reset}`);
  }

  output += at(5 + visibleRows, left, `${colors.purple}├${'─'.repeat(inside)}┤${colors.reset}`);
  const legend = '▰ DIR   ϟ FLA   ¶ TXT   ▶ VIDEO   ♪ AUDIO   ▧ IMAGE   ◆ FILE';
  output += at(6 + visibleRows, left, `${colors.purple}│${colors.reset}  ${colors.dim}${legend.slice(0, contentWidth)}${' '.repeat(Math.max(0, contentWidth - legend.length))}${colors.reset}  ${colors.purple}│${colors.reset}`);
  const position = entries.length ? `${safeSelected + 1} / ${entries.length}` : 'EMPTY';
  const footer = `ARROWS select  •  ENTER open  •  BACKSPACE parent  •  ESC close  •  ${position}`;
  output += at(7 + visibleRows, left, `${colors.purple}│${colors.reset}  ${colors.dim}${footer.slice(0, contentWidth)}${' '.repeat(Math.max(0, contentWidth - footer.length))}${colors.reset}  ${colors.purple}│${colors.reset}`);
  output += at(8 + visibleRows, left, `${colors.purple}╰${'─'.repeat(inside)}╯${colors.reset}`);
  process.stdout.write(output);
  return { selected: safeSelected, offset: safeOffset, maximumOffset, page: visibleRows };
}

function main() {
  void warmSoundSystem();
  let entries = loadEntries();
  let filteredEntries = entries;
  let query = '';
  let selected = 0;
  let offset = 0;
  let opening = false;
  process.stdout.write('\x1b[r\x1b[3J\x1b[2J\x1b[H');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let layout = render(filteredEntries, selected, offset, query);

  const finish = () => {
    playSound('closing or quitting');
    process.stdin.off('data', onData);
    process.stdout.off('resize', onResize);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');
    process.exit(0);
  };
  const refresh = (resetSelection = false) => {
    const normalizedQuery = query.toLowerCase();
    filteredEntries = normalizedQuery
      ? entries.filter(entry => `${entry.name} ${entry.value || ''} ${entry.type}`.toLowerCase().includes(normalizedQuery))
      : entries;
    if (resetSelection) {
      selected = 0;
      offset = 0;
    }
    layout = render(filteredEntries, selected, offset, query);
    selected = layout.selected;
    offset = layout.offset;
  };
  const onResize = () => refresh();
  const onData = async data => {
    if (opening) return;
    const key = data.toString('utf8');
    playTypingSound(key);
    if (key === '\x1b' || key === '\x03') return finish();
    if (key === '\x1b[A') selected--;
    else if (key === '\x1b[B') selected++;
    else if (key === '\x1b[5~') selected -= layout.page;
    else if (key === '\x1b[6~') selected += layout.page;
    else if (key === '\x1b[H' || key === '\x1b[1~') selected = 0;
    else if (key === '\x1b[F' || key === '\x1b[4~') selected = Math.max(0, filteredEntries.length - 1);
    else if (key === '\x7f' || key === '\b') {
      if (query) query = query.slice(0, -1);
      else if (activeMode === 'folder') {
        const parent = path.dirname(currentTarget);
        if (parent !== currentTarget && isInsideBrowseRoot(parent)) currentTarget = parent;
        entries = loadEntries();
      }
      return refresh(true);
    } else if (key === '\r' || key === '\n') {
      const entry = filteredEntries[selected];
      if (!entry) return;
      if (activeMode === 'links') {
        activeMode = 'folder';
        currentTarget = path.resolve(entry.value);
        browseRoot = currentTarget;
        entries = loadEntries();
        query = '';
        return refresh(true);
      }
      if (activeMode === 'folder' && entry.isDirectory) {
        currentTarget = path.join(currentTarget, entry.name);
        entries = loadEntries();
        query = '';
        return refresh(true);
      }
      opening = true;
      try {
        const targetPath = activeMode === 'folder' ? path.join(currentTarget, entry.name) : entry.value;
        await playOpenAnimation(targetPath);
        await openTarget(targetPath);
        finish();
      } catch (error) {
        playSound('error');
        opening = false;
        process.stdout.write(`\x1b[${Math.max(1, (process.stdout.rows || 24) - 1)};1H${colors.red}${error.message}${colors.reset}`);
      }
      return;
    } else if (/^[\x20-\x7e]+$/.test(key)) {
      query += key;
      return refresh(true);
    }
    refresh();
  };
  process.stdin.on('data', onData);
  process.stdout.on('resize', onResize);
}

try {
  main();
} catch (error) {
  playSound('error');
  process.stdout.write(`\x1b[?25h\x1b[0m\nCould not open list: ${error.message}\n`);
  process.exitCode = 1;
}
