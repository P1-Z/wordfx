#!/usr/bin/env node

'use strict';

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const packageManifest = require('./package.json');
const { dataDirectory, dataPathWithLegacy, notesDirectory, setNotesDirectory } = require('./storage');
const { registeredUsername, registerCredentials, credentialsMatch } = require('./credentials');
const { ansi: paint, rgb: themeRgb, getTheme, setTheme, reloadTheme, themePalette, renderThemeBar, renderThemeRail, themeSpinner } = require('./theme');
const { playSound, playTypingSound, shutdownSoundSystem, warmSoundSystem } = require('./sound');

let AUTH_USER = registeredUsername() || 'NEW USER';
const COMMAND_SESSION = Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, '0');
const COMMAND_STARTED_AT = Date.now();
const COMMAND_FOOTER_ROWS = 2;
let commandScreenActive = false;
let commandOwnsAlternateScreen = false;
let commandActivity = 'AWAITING INPUT';
let commandFullscreenEffect = false;

const registryPath = dataPathWithLegacy('linked-apps.json', path.join(__dirname, 'linked-apps.json'));
const directoryRegistryPath = dataPathWithLegacy('linked-directories.json', path.join(__dirname, 'linked-directories.json'));

function displayPath(value) {
  return String(value).replace(/(^|[\\/])wordfx(?=([\\/]|$))/gi, '$1://');
}

function loadApps() {
  try {
    const apps = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!apps || Array.isArray(apps) || typeof apps !== 'object') {
      throw new Error('registry must contain a JSON object');
    }
    return Object.fromEntries(
      Object.entries(apps).filter(([, appPath]) => typeof appPath === 'string')
    );
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read app registry: ${error.message}`);
    return {};
  }
}

function saveApps(apps) {
  const temporaryPath = `${registryPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(apps, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, registryPath);
}

function loadDirectories() {
  try {
    const directories = JSON.parse(fs.readFileSync(directoryRegistryPath, 'utf8'));
    if (!directories || Array.isArray(directories) || typeof directories !== 'object') {
      throw new Error('directory registry must contain a JSON object');
    }
    return Object.fromEntries(
      Object.entries(directories).filter(([, directoryPath]) => typeof directoryPath === 'string')
    );
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read directory registry: ${error.message}`);
    return {};
  }
}

function saveDirectories(directories) {
  const temporaryPath = `${directoryRegistryPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(directories, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, directoryRegistryPath);
}

function cleanPath(value) {
  const unquoted = value.trim().replace(/^(?:"(.*)"|'(.*)')$/, (_, double, single) => double ?? single);
  return unquoted.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

function resolveDirectoryTarget(value) {
  const requested = cleanPath(value || '.');
  const directories = loadDirectories();
  if (directories[requested.toLowerCase()]) return path.resolve(directories[requested.toLowerCase()]);

  const parts = requested.split(/[\\/]/);
  const linkedRoot = directories[parts[0].toLowerCase()];
  if (linkedRoot && parts.length > 1) return path.resolve(linkedRoot, ...parts.slice(1));
  return path.resolve(process.cwd(), requested);
}

function openApp(appPath) {
  const extension = path.extname(appPath).toLowerCase();
  const directlyExecutable = ['.exe', '.com', '.bat', '.cmd'].includes(extension);
  const child = directlyExecutable
    ? spawn(appPath, [], { detached: true, stdio: 'ignore', windowsHide: false })
    : spawn('explorer.exe', [appPath], { detached: true, stdio: 'ignore', windowsHide: false });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function openTerminal(executable, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', [
      '/d',
      '/c',
      'start',
      options.title || '',
      executable,
      ...args,
    ], {
      cwd: options.cwd || process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: options.env || process.env,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function playWindowTransition(label, playCue = true) {
  await warmSoundSystem();
  if (playCue) playSound('opening or loading');
  const { width, height } = effectScreenSize();
  const middle = Math.max(2, Math.floor(height / 2));
  const frames = 8;
  for (let frame = 0; frame <= frames; frame++) {
    const progress = frame / frames;
    const eased = 1 - Math.pow(1 - progress, 3);
    const railWidth = Math.max(1, Math.round((width - 6) * eased));
    let output = clearFrame(height);
    if (getTheme() === 'macintosh') {
      output += centeredAt(middle - 2, `${paint.dim}${label}${paint.reset}`, width);
      output += centeredAt(middle, `${paint.purple}${paint.bold}${themeSpinner(frame)}${paint.reset}`, width);
      output += centeredAt(middle + 2, `${paint.white}${String(Math.round(progress * 100)).padStart(3)}%${paint.reset}`, width);
    } else {
      output += centeredAt(middle - 1, `${paint.dim}${label}${paint.reset}`, width);
      output += centeredAt(middle + 1, gradientRail(railWidth, frame), width);
    }
    process.stdout.write(output);
    await wait(22);
  }
  await wait(35);
  // Schedule the parent's sound player shutdown after the loading cue
  // finishes playing. The child process creates its own player -- having
  // both active at once causes audio contention on some systems.
  if (playCue) {
    const timer = setTimeout(() => shutdownSoundSystem(), 400);
    timer.unref?.();
  }
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
}

async function playReturnTransition() {
  await wait(170);
  await playWindowTransition('RETURNING TO COMMAND', false);
}

async function runNoteMode() {
  await playWindowTransition('OPENING NOTE');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'note-mode.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', code => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function runWordMode() {
  await playWindowTransition('OPENING WORD GAME');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'word-mode.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', code => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function runThemeMode() {
  await playWindowTransition('OPENING SKIN SELECTOR');
  const code = await new Promise((resolve, reject) => {
    let selectedTheme = null;
    const child = spawn(process.execPath, [path.join(__dirname, 'theme-mode.js')], {
      cwd: __dirname,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: false,
    });
    child.on('message', message => {
      if (message?.type === 'theme-selected' && typeof message.theme === 'string') selectedTheme = message.theme;
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (selectedTheme) setTheme(selectedTheme);
      else reloadTheme();
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
  if (code !== 42) await playReturnTransition();
  return code;
}

async function runFixMode() {
  await playWindowTransition('OPENING FIX NOTE');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'note-mode.js'), '--fix'], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', code => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function runNoteHistoryMode() {
  await playWindowTransition('OPENING NOTE HISTORY');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'note-history-mode.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', code => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function runGuideMode() {
  await playWindowTransition('OPENING GUIDE');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'guide-mode.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', code => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function runHelpMode(entries) {
  await playWindowTransition('OPENING HELP');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'help-mode.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
      env: { ...process.env, WORDFX_HELP_ENTRIES: JSON.stringify(entries) },
    });
    child.once('error', reject);
    child.once('exit', code => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function runListMode(mode, target = '') {
  const label = mode === 'folder' ? 'OPENING FILES' : mode === 'apps' ? 'OPENING APPS' : 'OPENING LINKS';
  await playWindowTransition(label);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'list-mode.js'), mode, target], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', code => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function runSystemMonitorMode() {
  await playWindowTransition('OPENING SYSTEM MONITOR');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'system-monitor-mode.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', exitCode => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(exitCode ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function runLoveMode() {
  await playWindowTransition('OPENING SALLY + ERIK');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'love-mode.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', exitCode => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(exitCode ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function runMediaControlMode() {
  await playWindowTransition('OPENING MEDIA PLAYER');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'media-control-mode.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', exitCode => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(exitCode ?? 1);
    });
  });
  await playReturnTransition();
  return code;
}

async function launchMessengerWindow(args = []) {
  await playWindowTransition('OPENING PRIVATE MESSENGER');
  await openTerminal(process.execPath, [path.join(__dirname, 'messenger-mode.js'), ...args], {
    cwd: __dirname,
    title: ':// PRIVATE MESSENGER',
    env: { ...process.env, WORDFX_CHAT_USERNAME: AUTH_USER, WORDFX_SKIP_STARTUP_SOUND: '1' },
  });
}

async function runUpdaterMode() {
  await playWindowTransition('CHECKING FOR UPDATES');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'updater.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', exitCode => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(exitCode ?? 1);
    });
  });
  if (code !== 42) await playReturnTransition();
  return code;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function parseArguments(input) {
  const arguments_ = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(input)) !== null) {
    arguments_.push(match[1] ?? match[2] ?? match[3]);
  }
  return arguments_;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function animatedReply(message, color = paint.white) {
  for (let frame = 0; frame < 3; frame++) {
    const strength = 0.2 - frame * 0.07;
    const scrambled = glitchText(message, frame, strength);
    const [red, green, blue] = rainbowRgb(frame * 2.4);
    process.stdout.write(`\r\x1b[2K\x1b[38;2;${red};${green};${blue}m${scrambled}${paint.reset}`);
    await wait(24);
  }
  process.stdout.write(`\r\x1b[2K${color}`);
  const characters = Array.from(message);
  for (let i = 0; i < characters.length; i++) {
    const [red, green, blue] = rainbowRgb(i * 0.8);
    if (i % 3 === 0) process.stdout.write(`\x1b[38;2;${red};${green};${blue}m`);
    process.stdout.write(characters[i]);
    await wait(4);
  }
  process.stdout.write(`${paint.reset}\n`);
}

async function revealLines(lines) {
  for (const line of lines) {
    console.log(line);
    await wait(28);
  }
}

async function launchSpinner(label) {
  playSound('opening or loading');
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  for (let i = 0; i <= 18; i++) {
    const [red, green, blue] = rainbowRgb(i * 1.4);
    const color = `\x1b[38;2;${red};${green};${blue}m`;
    const spinner = themeSpinner(i);
    const bar = progressBar(i / 18, 12, i);
    const pulseLabel = Math.sin(i * 0.45) > 0 ? label.toUpperCase() : label;
    process.stdout.write(`\r\x1b[2K${color}${spinner}${paint.reset} ${bar} ${paint.dim}${pulseLabel}${paint.reset}`);
    await wait(34);
  }
  process.stdout.write(`\r\x1b[2K${paint.green}✓ COMPLETE${paint.reset}`);
  await wait(90);
  process.stdout.write('\r\x1b[2K');
}

function cursorTo(row, column) {
  process.stdout.write(`\x1b[${row};${column}H`);
}

function centeredColumn(textLength) {
  return Math.max(1, Math.floor(((process.stdout.columns || 80) - textLength) / 2) + 1);
}

function terminalWidth() {
  return Math.max(32, (process.stdout.columns || 80) - 1);
}

function clip(value, width) {
  const text = String(value);
  if (text.length <= width) return text;
  return width < 2 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

// Shared visual language from the main :// canvas: drifting rainbow,
// Matrix trails, pulse brightness, sparkles, and short glitch reveals.
function rainbowRgb(position) {
  const stops = themePalette();
  const place = ((position / 1.8) % stops.length + stops.length) % stops.length;
  const from = Math.floor(place);
  const to = (from + 1) % stops.length;
  const amount = place - from;
  const blend = amount * amount * (3 - 2 * amount);
  return stops[from].map((channel, index) =>
    Math.round(channel + (stops[to][index] - channel) * blend)
  );
}

function hslToRgb(hue, saturation, lightness) {
  const normalizedSaturation = saturation / 100;
  const normalizedLightness = lightness / 100;
  const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
  const intermediate = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const match = normalizedLightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (hue < 60) [red, green] = [chroma, intermediate];
  else if (hue < 120) [red, green] = [intermediate, chroma];
  else if (hue < 180) [green, blue] = [chroma, intermediate];
  else if (hue < 240) [green, blue] = [intermediate, chroma];
  else if (hue < 300) [red, blue] = [intermediate, chroma];
  else [red, blue] = [chroma, intermediate];
  return [red, green, blue].map(channel => Math.round((channel + match) * 255));
}

function seededRandom(value) {
  const result = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return result - Math.floor(result);
}

function gradientRail(width, offset = 0) {
  return renderThemeRail(width, offset);
  /* Legacy renderer retained below for reference. */
  const palette = themePalette();
  let output = '';
  for (let column = 0; column < width; column++) {
    const place = ((column / Math.max(1, width) * palette.length - offset * 0.12) % palette.length + palette.length) % palette.length;
    const from = Math.floor(place);
    const to = (from + 1) % palette.length;
    const amount = place - from;
    const smooth = amount * amount * (3 - 2 * amount);
    const color = palette[from].map((channel, index) =>
      Math.round(channel + (palette[to][index] - channel) * smooth)
    );
    output += `\x1b[38;2;${color.join(';')}m━`;
  }
  return `${output}${paint.reset}`;
}

function gradientText(text, offset = 0) {
  return Array.from(text, (character, index) => {
    const [red, green, blue] = rainbowRgb(index * 0.34 + offset * 0.08);
    return `\x1b[1;38;2;${red};${green};${blue}m${character}`;
  }).join('') + paint.reset;
}

function panelRow(content, insideWidth, color = paint.cyan) {
  const raw = stripAnsi(content);
  const rendered = raw.length > insideWidth - 2 ? clip(raw, insideWidth - 2) : content;
  const visibleLength = Math.min(raw.length, insideWidth - 2);
  return `${color}│${paint.reset} ${rendered}${' '.repeat(Math.max(0, insideWidth - visibleLength - 1))}${color}│${paint.reset}`;
}

function formatSessionAge() {
  const seconds = Math.floor((Date.now() - COMMAND_STARTED_AT) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function effectScreenSize() {
  return {
    width: Math.max(32, (process.stdout.columns || 80) - 1),
    height: Math.max(16, process.stdout.rows || 24),
  };
}

function enterCommandScreen() {
  if (commandScreenActive) return;
  commandScreenActive = true;
  commandOwnsAlternateScreen = process.env.WORDFX_PARENT_ALT !== '1';
  process.stdout.write(`${commandOwnsAlternateScreen ? '\x1b[?1049h' : ''}\x1b[r\x1b[3J\x1b[2J\x1b[H\x1b[?25h`);
}

function leaveCommandScreen() {
  if (!commandScreenActive) return;
  commandScreenActive = false;
  process.stdout.write(`\x1b[r\x1b[?25h\x1b[0m${commandOwnsAlternateScreen ? '\x1b[?1049l' : '\x1b[2J\x1b[H'}`);
  commandOwnsAlternateScreen = false;
}

function at(row, column, content) {
  return `\x1b[${Math.max(1, row)};${Math.max(1, column)}H${content}`;
}

function centeredAt(row, content, width = effectScreenSize().width) {
  return at(row, Math.max(1, Math.floor((width - stripAnsi(content).length) / 2) + 1), content);
}

function clearFrame(height) {
  let output = '\x1b[?25l\x1b[H';
  for (let row = 1; row <= height; row++) output += `\x1b[${row};1H\x1b[2K`;
  return output;
}

function matrixField(frame, width, height, protectedTop = 0, protectedBottom = 0) {
  const glyphs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZｱｲｳｴｵｶｷｸｹｺ█▓▒░';
  const usableHeight = Math.max(1, height - protectedTop - protectedBottom);
  let output = '';
  for (let column = 2; column < width; column += 4) {
    const seed = seededRandom(column * 31);
    const head = protectedTop + 1 + ((frame + Math.floor(seed * usableHeight * 2)) % usableHeight);
    for (let depth = 0; depth < 4; depth++) {
      const row = head - depth;
      if (row <= protectedTop || row > height - protectedBottom) continue;
      const glyph = glyphs[(column * 7 + frame * 3 - depth * 11 + glyphs.length * 10) % glyphs.length];
      const trail = themeRgb.green.map(channel => Math.max(0, Math.round(channel * (1 - depth * 0.2))));
      const color = depth === 0 ? paint.green : `\x1b[2;38;2;${trail.join(';')}m`;
      output += at(row, column, `${color}${glyph}${paint.reset}`);
    }
  }
  return output;
}

function glitchText(message, frame, strength = 0.18) {
  const noise = '01#@$%&*<>/\\█▓▒░';
  return Array.from(message, (character, index) => {
    if (character === ' ' || seededRandom(frame * 997 + index * 37) > strength) return character;
    return noise[Math.floor(seededRandom(frame * 613 + index * 71) * noise.length)];
  }).join('');
}

function progressBar(progress, width, frame) {
  return renderThemeBar(progress, width, frame);
  /* Legacy bar retained below for visual-reference parity. */
  const filled = Math.round(Math.max(0, Math.min(1, progress)) * width);
  let output = '';
  for (let index = 0; index < width; index++) {
    if (index < filled) {
      // Spread the palette across the full rail and drift it slowly between frames.
      const [red, green, blue] = rainbowRgb(index * 0.3 + frame * 0.08);
      output += `\x1b[38;2;${red};${green};${blue}m━`;
    } else {
      output += `${paint.dim}${paint.muted}─`;
    }
  }
  return `${output}${paint.reset}`;
}

async function renderLoginScreen() {
  const terminalHeight = process.stdout.rows || 24;
  const boxWidth = 50;
  const left = centeredColumn(boxWidth);
  const top = Math.max(1, Math.floor(terminalHeight / 2) - 4);
  const inside = boxWidth - 2;
  
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
  
  // Clean, elegant login box
  const box = [
    `╭${'─'.repeat(inside)}╮`,
    `│${' '.repeat(inside)}│`,
    `│  ${paint.bold}:// AUTHENTICATION${paint.reset}${' '.repeat(inside - 19)}│`,
    `│${'─'.repeat(inside)}│`,
    `│${' '.repeat(inside)}│`,
    `│  Username: ${'_'.repeat(25)}${' '.repeat(inside - 38)}│`,
    `│${' '.repeat(inside)}│`,
    `│  Password: ${'_'.repeat(25)}${' '.repeat(inside - 38)}│`,
    `│${' '.repeat(inside)}│`,
    `╰${'─'.repeat(inside)}╯`
  ];
  
  // Draw box smoothly
  for (let i = 0; i < box.length; i++) {
    cursorTo(top + i, left);
    process.stdout.write(paint.cyan + box[i] + paint.reset);
    await wait(30);
  }
  
  process.stdout.write('\x1b[?25h');
  return {
    userRow: top + 5,
    passwordRow: top + 7,
    statusRow: top + 8,
    inputColumn: left + 14,
  };
}

async function playWelcomeIntro() {
  const rotations = ['-', '\\', '|', '/'];
  const message = 'WELCOME, P1Z';
  const row = Math.max(1, Math.floor((process.stdout.rows || 24) / 2));
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
  for (let i = 0; i < 24; i++) {
    const line = rotations[i % rotations.length];
    const content = `${line}  ${message}  ${line}`;
    cursorTo(row, centeredColumn(content.length));
    process.stdout.write(`${paint.cyan}${line}${paint.reset}  ${paint.bold}${paint.white}${message}${paint.reset}  ${paint.green}${line}${paint.reset}`);
    await wait(48);
  }
  process.stdout.write('\x1b[?25h');
}

async function playCyberBoot() {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const left = Math.max(1, Math.floor(width / 2) - 20);
  const top = Math.max(1, Math.floor(height / 2) - 4);
  
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
  
  const modules = [
    ['NEURAL LINK', 'READY', paint.cyan],
    ['COMMAND BUS', 'ONLINE', paint.green],
    ['APP REGISTRY', 'LOADED', paint.purple],
    ['SECURE SHELL', 'ACTIVE', paint.yellow]
  ];
  
  // Clean boot sequence
  for (let i = 0; i < modules.length; i++) {
    cursorTo(top + i, left);
    process.stdout.write(`${paint.dim}[ .. ]${paint.reset} ${modules[i][0]}`);
    await wait(200);
    
    cursorTo(top + i, left);
    const color = modules[i][2];
    process.stdout.write(`${color}[ OK ]${paint.reset} ${modules[i][0]} ${paint.dim}${modules[i][1]}${paint.reset}`);
    await wait(150);
  }
  
  // Simple progress bar
  cursorTo(top + 5, left);
  process.stdout.write(`${paint.dim}Loading...${paint.reset}`);
  
  cursorTo(top + 6, left);
  for (let i = 0; i <= 30; i++) {
    const bar = paint.cyan + '█'.repeat(i) + paint.dim + '░'.repeat(30 - i) + paint.reset;
    cursorTo(top + 6, left);
    process.stdout.write(bar);
    await wait(20);
  }
  
  await wait(200);
  process.stdout.write('\x1b[2J\x1b[H');
  
  // Enhanced progress bar with wave effect
  const barWidth = 40;
  cursorTo(top + modules.length + 1, left);
  process.stdout.write(`${paint.dim}INITIALIZING SYSTEM...${paint.reset}`);
  
  for (let step = 0; step <= barWidth; step++) {
    const percent = Math.round((step / barWidth) * 100).toString().padStart(3);
    const filledChar = step % 2 === 0 ? '█' : '▓';
    const emptyChar = '░';
    
    // Create wave effect in the progress bar
    let bar = '';
    for (let i = 0; i < barWidth; i++) {
      if (i < step) {
        const waveHeight = Math.sin((i + step) * 0.3) > 0 ? filledChar : '▓';
        bar += waveHeight;
      } else {
        bar += emptyChar;
      }
    }
    
    cursorTo(top + modules.length + 2, left);
    const barColor = step < 20 ? paint.green : step < 35 ? paint.cyan : paint.pink;
    process.stdout.write(`${paint.dim}BOOT${paint.reset} ${barColor}${bar}${paint.reset} ${paint.white}${percent}%${paint.reset}`);
    
    // Random glitch messages
    if (step === 15 || step === 28 || step === 36) {
      const glitchMessages = ['QUANTUM FLUX DETECTED', 'NEURAL SYNC IN PROGRESS', 'REALITY MATRIX STABLE'];
      const message = glitchMessages[step === 15 ? 0 : step === 28 ? 1 : 2];
      cursorTo(top + modules.length + 3, left + 5);
      process.stdout.write(`${paint.yellow}${message}${paint.reset}`);
      await wait(100);
      cursorTo(top + modules.length + 3, left + 5);
      process.stdout.write(' '.repeat(30));
    }
    
    await wait(step > 35 ? 5 : step > 25 ? 10 : 15);
  }
  
  // Final system ready message with pulse effect
  for (let pulse = 0; pulse < 3; pulse++) {
    cursorTo(top + modules.length + 4, centeredColumn(21));
    process.stdout.write(`${pulse % 2 ? paint.bold + paint.white : paint.cyan}SYSTEM SYNCHRONIZED${paint.reset}`);
    await wait(150);
  }
  
  await wait(300);
  process.stdout.write('\x1b[?25h');
}

async function playCyberSurge() {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const colors = [paint.green, paint.cyan, paint.pink, paint.purple, paint.yellow, paint.blue];
  const glyphs = '01<>/\\#$%*ｱｲｳｴｵｶｷｸｹｺ█▓▒░╬═╔╗╚╝';
  process.stdout.write('\x1b[?25l');
  
  // Create matrix-like background
  for (let col = 0; col < width; col += 3) {
    const row = Math.floor(Math.random() * height) + 1;
    const glyph = glyphs[Math.floor(Math.random() * glyphs.length)];
    cursorTo(row, col);
    process.stdout.write(`${paint.dim}${paint.green}${glyph}${paint.reset}`);
  }
  
  for (let frame = 0; frame < 15; frame++) {
    // Dynamic bands of data
    for (let band = 0; band < 8; band++) {
      const row = 1 + ((frame * 4 + band * 3) % Math.max(1, height));
      const length = Math.max(10, Math.floor(width * (0.2 + Math.sin(frame * 0.3 + band) * 0.3)));
      const column = 1 + ((frame * 7 + band * 11) % Math.max(1, width - length));
      
      cursorTo(row, column);
      const color = colors[(frame + band) % colors.length];
      const isBright = band % 3 === 0;
      
      // Create data stream effect
      let stream = '';
      for (let i = 0; i < length; i++) {
        if (i < 3 || i > length - 4) {
          stream += '░';
        } else {
          const glyphIndex = (frame * 5 + band * 7 + i * 3) % glyphs.length;
          stream += glyphs[glyphIndex];
        }
      }
      
      process.stdout.write(`${isBright ? paint.bold : ''}${color}${stream}${paint.reset}`);
    }
    
    // Central message with glitch effect
    const messages = [
      'INITIALIZING CYBERSPACE',
      'NEURAL MATRIX ONLINE',
      'QUANTUM SYNC ENGAGED',
      'REALITY ENGINE ACTIVE',
      'CYBERPSYCHOSIS // LINK ACTIVE'
    ];
    const message = messages[Math.min(Math.floor(frame / 3), messages.length - 1)];
    const corrupted = Array.from(message, (character, idx) =>
      character !== ' ' && Math.random() < 0.15 - frame * 0.01
        ? glyphs[Math.floor(Math.random() * glyphs.length)]
        : character
    ).join('');
    
    cursorTo(Math.max(1, Math.floor(height / 2)), centeredColumn(message.length));
    process.stdout.write(`${paint.bold}${colors[frame % colors.length]}${corrupted}${paint.reset}`);
    
    await wait(60 - frame * 2);
  }
  
  // Final flash sequence
  for (let flash = 0; flash < 3; flash++) {
    process.stdout.write('\x1b[2J\x1b[H');
    if (flash % 2 === 0) {
      const finalMessage = 'CYBERPSYCHOSIS // LINK ACTIVE';
      cursorTo(Math.floor(height / 2), centeredColumn(finalMessage.length));
      process.stdout.write(`${paint.bold}${paint.white}${finalMessage}${paint.reset}`);
    }
    await wait(100);
  }
  
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');
}


function commandHeaderSnapshot() {
  const apps = loadApps();
  return {
    location: process.cwd(),
    online: Object.values(apps).filter(appPath => fs.existsSync(appPath)).length,
    total: Object.keys(apps).length,
  };
}

function commandFooterLines(frame = 0, snapshot = commandHeaderSnapshot()) {
  const width = terminalWidth();
  const state = commandActivity === 'AWAITING INPUT' ? 'READY' : commandActivity;
  const badge = ' :// CMD ';
  const available = Math.max(0, width - badge.length - 1);
  const essentials = `${AUTH_USER.toUpperCase()}  ·  ${COMMAND_SESSION}  ·  APPS ${snapshot.online}/${snapshot.total}  ·  ${state}  ·  HELP`;
  const pathWidth = Math.max(0, available - essentials.length - 3);
  const details = pathWidth > 0 ? `${essentials}  ·  ${clip(displayPath(snapshot.location), pathWidth)}` : essentials;
  const visibleDetails = clip(details, available).padEnd(available);
  return [
    gradientRail(width, frame),
    `${paint.bold}${paint.cyan}${badge}${paint.reset} ${paint.dim}${paint.muted}${visibleDetails}${paint.reset}`,
  ];
}

function paintCommandFooter(lines, height, rows = lines.map((_, index) => index)) {
  let output = '';
  for (const row of rows) output += at(height - 1 + row, 1, `\x1b[2K${lines[row]}`);
  return output;
}

async function renderCommandHeader(frame = 0) {
  const { height } = effectScreenSize();
  const scrollBottom = Math.max(1, height - COMMAND_FOOTER_ROWS);
  const lines = commandFooterLines(frame);
  let output = '\x1b[r\x1b[3J\x1b[2J\x1b[H\x1b[?25l';
  output += paintCommandFooter(lines, height);
  output += `\x1b[1;${scrollBottom}r`;
  output += at(1, 1, `${paint.dim}Workspace ready.${paint.reset}\n`);
  output += '\x1b[?25h';
  process.stdout.write(output);
}

function animateCommandHeader(frame, snapshot) {
  const { height } = effectScreenSize();
  const lines = commandFooterLines(frame, snapshot);
  process.stdout.write(`\x1b[s\x1b[?25l${paintCommandFooter(lines, height)}\x1b[u\x1b[?25h`);
}


function readCredential(label, hidden = false, maxLength = 64) {
  return new Promise(resolve => {
    let value = '';
    let settled = false;
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    function finish(result = value) {
      if (settled) return;
      settled = true;
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdout.write('\n');
      resolve(result);
    }

    function onData(data) {
      playTypingSound(data);
      for (const character of data.toString('utf8')) {
        if (character === '\x03' || character === '\x1b') return finish(null);
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\x7f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (/^[\x20-\x7e]$/.test(character) && value.length < maxLength) {
          value += character;
          process.stdout.write(hidden ? '*' : character);
        }
      }
    }

    process.stdin.on('data', onData);
  });
}

function waitForLoginRetry(layout, message) {
  return new Promise(resolve => {
    let settled = false;
    const hint = `${message}  Enter: retry  Esc: return`;
    process.stdout.write(loginStatus(layout, hint, paint.red));
    cursorTo(layout.statusRow, layout.statusColumn + Math.min(layout.statusWidth, hint.length));
    process.stdout.write('\x1b[?25h');
    process.stdin.setRawMode(true);
    process.stdin.resume();

    function finish(retry) {
      if (settled) return;
      settled = true;
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      resolve(retry);
    }

    function onData(data) {
      const input = data.toString('utf8');
      if (input.includes('\x03') || input.includes('\x1b')) return finish(false);
      if (input.includes('\r') || input.includes('\n')) finish(true);
    }

    process.stdin.on('data', onData);
  });
}

async function playAccessSequence() {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
  
  const messages = [
    'ESTABLISHING CONNECTION',
    'VERIFYING CREDENTIALS',
    'INITIALIZING INTERFACE'
  ];
  
  const centerRow = Math.floor(height / 2);
  
  // Clean, professional sequence
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const col = centeredColumn(msg.length);
    
    cursorTo(centerRow, col);
    process.stdout.write(`${paint.cyan}${msg}${paint.reset}`);
    
    // Simple progress dots
    for (let dot = 0; dot < 3; dot++) {
      await wait(300);
      process.stdout.write('.');
    }
    
    await wait(200);
    cursorTo(centerRow, 1);
    process.stdout.write(' '.repeat(width - 2));
  }
  
  const accessMsg = 'CONNECTION READY';
  cursorTo(centerRow, centeredColumn(accessMsg.length));
  process.stdout.write(`${paint.bold}${paint.green}${accessMsg}${paint.reset}`);
  await wait(800);
  
  process.stdout.write('\x1b[?25h');
}

async function renderPolishedLoginScreen() {
  const { width, height } = effectScreenSize();
  const profiles = {
    rainbow: { title: 'SPECTRUM GATE', marker: '>', accent: 'cyan', motif: 'full color channel' },
    midnight: { title: 'NIGHT ACCESS', marker: ':', accent: 'blue', motif: 'quiet hours / secure session' },
    neon: { title: 'NEON LOCK', marker: '#', accent: 'pink', motif: 'high voltage identity grid' },
    ocean: { title: 'TIDAL ACCESS', marker: '~', accent: 'cyan', motif: 'signal below the surface' },
    ember: { title: 'FIREWALL', marker: '+', accent: 'orange', motif: 'keep the signal burning' },
    aurora: { title: 'SKY SIGNAL', marker: '*', accent: 'green', motif: 'identity under moving light' },
    phosphor: { title: 'CRT SESSION', marker: '>', accent: 'green', motif: 'scanline terminal / channel 01' },
    paper: { title: 'DESK LOGIN', marker: ':', accent: 'orange', motif: 'private correspondence' },
    mono: { title: 'TERMINAL LOGIN', marker: ':', accent: 'white', motif: 'plain text / clear intent' },
    macintosh: { title: 'USER ACCESS', marker: '>', accent: 'purple', motif: 'File  Edit  Special' },
  };
  const profile = profiles[getTheme()] || profiles.rainbow;
  const formWidth = Math.min(54, width - 4);
  const inside = formWidth - 2;
  const left = Math.max(2, Math.floor((width - formWidth) / 2) + 1);
  const top = Math.max(2, Math.floor(height / 2) - 6);
  const accent = paint[profile.accent];
  const fieldPrefix = label => ` ${profile.marker} ${label.padEnd(9)}`;
  const inputColumn = left + 1 + fieldPrefix('User:').length;
  const panelLine = (row, content = '') => {
    const plainLength = String(content).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').length;
    return at(row, left, `${accent}\u2502${paint.reset}${content}${' '.repeat(Math.max(0, inside - plainLength))}${accent}\u2502${paint.reset}`);
  };
  let output = clearFrame(height);
  output += at(top, left, `${accent}\u250c${'\u2500'.repeat(inside)}\u2510${paint.reset}`);
  output += panelLine(top + 1, ` ${paint.bold}${paint.white}[#]  :// ${profile.title}${paint.reset}`);
  output += panelLine(top + 2, ` ${paint.dim}${profile.motif}${paint.reset}`);
  output += panelLine(top + 3, renderThemeRail(inside, 0));
  output += panelLine(top + 4, `${paint.white}${fieldPrefix('User:')}${paint.reset}`);
  output += panelLine(top + 5, '');
  output += panelLine(top + 6, `${paint.white}${fieldPrefix('Password:')}${paint.reset}`);
  output += panelLine(top + 7, '');
  output += panelLine(top + 8, ` ${paint.dim}[ ${themeSpinner(0)} ] Awaiting credentials${paint.reset}`);
  output += panelLine(top + 9, ` ${paint.dim}Enter submits  /  Esc returns${paint.reset}`);
  output += at(top + 10, left, `${accent}\u2514${'\u2500'.repeat(inside)}\u2518${paint.reset}`);
  output += `${at(top + 4, inputColumn, '')}\x1b[?25h`;
  process.stdout.write(output);
  return {
    userRow: top + 4,
    passwordRow: top + 6,
    statusRow: top + 8,
    inputColumn,
    statusColumn: left + 3,
    statusWidth: Math.max(8, inside - 4),
    maxInputLength: Math.max(4, inside - fieldPrefix('User:').length - 1),
    railRow: top + 3,
    railColumn: left + 1,
    railWidth: inside,
  };
}

function animateLoginRail(layout) {
  let railFrame = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\x1b[s${at(layout.railRow, layout.railColumn, renderThemeRail(layout.railWidth, railFrame++))}\x1b[u`);
  }, 85);
  return () => clearInterval(timer);
}

function loginStatus(layout, message, color) {
  const visible = clip(message, layout.statusWidth);
  return at(layout.statusRow, layout.statusColumn, `${color}${visible}${paint.reset}${' '.repeat(Math.max(0, layout.statusWidth - visible.length))}`);
}

async function playPolishedAccessSequence() {
  const { width, height } = effectScreenSize();
  const boxWidth = Math.min(62, width - 4);
  const inside = boxWidth - 2;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const top = Math.max(3, Math.floor(height / 2) - 5);
  const phases = ['CREDENTIAL HASH', 'SECURE CHANNEL', 'IDENTITY BIND'];
  const states = ['ACCEPTED', 'ESTABLISHED', 'CONFIRMED'];

  for (let frame = 0; frame <= 24; frame++) {
    const progress = frame / 24;
    const complete = Math.min(phases.length, Math.floor(progress * (phases.length + 0.4)));
    let output = clearFrame(height);
    output += matrixField(frame, width, height);
    output += at(Math.max(1, top - 2), 1, gradientRail(width, frame));
    output += at(top, left, `${paint.green}╭${'─'.repeat(inside)}╮${paint.reset}`);
    output += at(top + 1, left, panelRow(`${paint.bold}${paint.white}ACCESS HANDSHAKE${paint.reset}  ${paint.dim}// AUTHENTICATED SESSION${paint.reset}`, inside, paint.green));
    output += at(top + 2, left, `${paint.green}├${'─'.repeat(inside)}┤${paint.reset}`);
    phases.forEach((phase, index) => {
      const done = index < complete;
      const active = index === complete;
      const indicator = done ? `${paint.green}[ OK ]` : active ? `${paint.yellow}[ .. ]` : `${paint.dim}[ -- ]`;
      const state = done ? states[index] : active ? 'VERIFYING' : 'QUEUED';
      output += at(top + 3 + index, left, panelRow(`${indicator}${paint.reset} ${paint.cyan}${phase.padEnd(20)}${paint.reset} ${paint.dim}${state}${paint.reset}`, inside, paint.green));
    });
    output += at(top + 6, left, `${paint.green}├${'─'.repeat(inside)}┤${paint.reset}`);
    output += at(top + 7, left, panelRow(`${progressBar(progress, Math.max(8, inside - 13), frame)} ${paint.white}${String(Math.round(progress * 100)).padStart(3)}%${paint.reset}`, inside, paint.green));
    output += at(top + 8, left, `${paint.green}╰${'─'.repeat(inside)}╯${paint.reset}`);
    process.stdout.write(output);
    await wait(38);
  }
}

async function playPolishedBoot() {
  const { width, height } = effectScreenSize();
  const boxWidth = Math.min(68, width - 4);
  const inside = boxWidth - 2;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const top = Math.max(3, Math.floor(height / 2) - 6);
  const modules = [
    ['EFFECT ENGINE', 'RAINBOW / PULSE / SPARKLE'],
    ['MATRIX FIELD', 'TRAIL BUFFER ONLINE'],
    ['APP REGISTRY', `${Object.keys(loadApps()).length} TARGETS MOUNTED`],
    ['COMMAND BUS', 'READLINE + HISTORY READY'],
  ];

  for (let frame = 0; frame <= 32; frame++) {
    const progress = frame / 32;
    const completed = Math.min(modules.length, Math.floor(progress * 5));
    const pulse = 170 + Math.round((Math.sin(frame * 0.55) + 1) * 35);
    let output = clearFrame(height);
    output += matrixField(frame * 2, width, height);
    output += at(Math.max(1, top - 2), 1, gradientRail(width, frame));
    output += at(top, left, `${paint.cyan}╭${'─'.repeat(inside)}╮${paint.reset}`);
    output += at(top + 1, left, panelRow(`${paint.bold}${paint.white}:// EFFECT CORE${paint.reset}  ${paint.purple}◆ BOOT SEQUENCE${paint.reset}`, inside, paint.cyan));
    output += at(top + 2, left, `${paint.cyan}├${'─'.repeat(inside)}┤${paint.reset}`);
    modules.forEach(([name, state], index) => {
      const done = index < completed;
      output += at(top + 3 + index, left, panelRow(`${done ? paint.green + '●' : paint.dim + '○'}${paint.reset} ${paint.cyan}${name.padEnd(18)}${paint.reset} ${done ? paint.white : paint.dim}${done ? state : 'INITIALIZING'}${paint.reset}`, inside));
    });
    output += at(top + 7, left, `${paint.cyan}├${'─'.repeat(inside)}┤${paint.reset}`);
    output += at(top + 8, left, panelRow(`${progressBar(progress, Math.max(8, inside - 13), frame)} ${paint.white}${String(Math.round(progress * 100)).padStart(3)}%${paint.reset}`, inside));
    output += at(top + 9, left, panelRow(`${paint.dim}${progress < 1 ? 'SYNCHRONIZING VISUAL LAYERS' : 'ALL EFFECT LAYERS SYNCHRONIZED'}${paint.reset}`, inside));
    output += at(top + 10, left, `${paint.cyan}╰${'─'.repeat(inside)}╯${paint.reset}`);
    process.stdout.write(output);
    await wait(34);
  }
}

async function playPolishedSurge() {
  const { width, height } = effectScreenSize();
  const message = 'COMMAND MATRIX // LINK ACTIVE';
  for (let frame = 0; frame < 16; frame++) {
    const strength = Math.max(0, 0.34 - frame * 0.023);
    const shown = glitchText(message, frame, strength);
    const [red, green, blue] = rainbowRgb(frame * 2.1);
    let output = clearFrame(height);
    output += matrixField(frame * 3, width, height);
    output += at(Math.max(1, Math.floor(height / 2) - 2), 1, gradientRail(width, frame));
    output += centeredAt(Math.floor(height / 2), `\x1b[1;38;2;${red};${green};${blue}m${shown}${paint.reset}`, width);
    output += centeredAt(Math.floor(height / 2) + 2, `${paint.dim}${frame < 12 ? 'CALIBRATING REALITY ENGINE' : 'READY'}${paint.reset}`, width);
    output += at(Math.min(height, Math.floor(height / 2) + 4), 1, gradientRail(width, frame + 8));
    process.stdout.write(output);
    await wait(42);
  }
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H\x1b[?25h');
}

async function playCommandInterfaceReveal() {
  if (process.env.WORDFX_SKIP_STARTUP_SOUND !== '1') playSound('opening or loading');
  const { width, height } = effectScreenSize();
  const frames = 30;
  const middle = Math.max(2, Math.floor(height / 2));

  process.stdout.write('\x1b[r\x1b[3J\x1b[2J\x1b[H\x1b[?25l');
  for (let frame = 0; frame <= frames; frame++) {
    const progress = frame / frames;
    const eased = 1 - Math.pow(1 - progress, 3);
    let output = clearFrame(height);
    if (getTheme() === 'macintosh') {
      output += centeredAt(middle - 2, `${paint.dim}:// OPENING SESSION${paint.reset}`, width);
      output += centeredAt(middle, `${paint.purple}${paint.bold}${themeSpinner(frame)}${paint.reset}`, width);
      output += centeredAt(middle + 2, `${paint.white}${String(Math.round(progress * 100)).padStart(3)}%${paint.reset}`, width);
    } else {
      output += centeredAt(middle - 3, gradientText(':// COMMAND', frame), width);
      output += centeredAt(middle - 1, `${paint.bold}${progress < 1 ? paint.cyan : paint.green}${progress < 1 ? 'OPENING SESSION' : 'SESSION READY'}${paint.reset}`, width);
      output += centeredAt(middle + 1, `${progressBar(eased, Math.max(16, Math.min(44, width - 12)), frame)} ${paint.white}${String(Math.round(progress * 100)).padStart(3)}%${paint.reset}`, width);
    }
    process.stdout.write(output);
    await wait(30);
  }

  for (let frame = 0; frame < 4; frame++) {
    const flash = frame % 2 === 0;
    let output = clearFrame(height);
    output += centeredAt(middle, `${flash ? paint.white : paint.dim}SESSION READY${paint.reset}`, width);
    process.stdout.write(output);
    await wait(40);
  }

  await wait(90);
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
}

async function playCommandExitAnimation() {
  const { width, height } = effectScreenSize();
  const middle = Math.max(2, Math.floor(height / 2));
  const frames = 26;

  process.stdout.write('\x1b[?25l');
  for (let frame = 0; frame <= frames; frame++) {
    const progress = frame / frames;
    const eased = progress * progress * (3 - 2 * progress);
    let output = clearFrame(height);
    if (getTheme() === 'macintosh') {
      output += centeredAt(middle - 2, `${paint.dim}:// CLOSING SESSION${paint.reset}`, width);
      output += centeredAt(middle, `${paint.purple}${paint.bold}${themeSpinner(frame)}${paint.reset}`, width);
      output += centeredAt(middle + 2, `${paint.white}${String(Math.round(progress * 100)).padStart(3)}%${paint.reset}`, width);
    } else {
      output += centeredAt(middle - 3, gradientText(':// COMMAND', frames - frame), width);
      output += centeredAt(middle - 1, `${paint.bold}${progress < 1 ? paint.pink : paint.green}${progress < 1 ? 'CLOSING SESSION' : 'SESSION CLOSED'}${paint.reset}`, width);
      output += centeredAt(middle + 1, `${progressBar(1 - eased, Math.max(16, Math.min(44, width - 12)), frame)} ${paint.white}${String(Math.round(progress * 100)).padStart(3)}%${paint.reset}`, width);
    }
    process.stdout.write(output);
    await wait(31);
  }

  for (let frame = 0; frame < 4; frame++) {
    const flash = frame % 2 === 0;
    let output = clearFrame(height);
    output += centeredAt(middle, `${flash ? paint.white : paint.dim}SESSION CLOSED${paint.reset}`, width);
    process.stdout.write(output);
    await wait(40);
  }

  process.stdout.write(`${clearFrame(height)}${paint.reset}`);
  await wait(90);
}

const breakProfiles = Object.freeze({
  rainbow: { title: 'COLOR INTERMISSION', message: 'gone to find another color', accent: 'cyan', motif: 'prism' },
  midnight: { title: 'LIGHTS DOWN', message: 'the room is quiet for a minute', accent: 'blue', motif: 'stars' },
  neon: { title: 'STANDBY // LIVE', message: 'the tubes are warm; stay close', accent: 'pink', motif: 'voltage' },
  ocean: { title: 'OUT WITH THE TIDE', message: 'drifting back shortly', accent: 'cyan', motif: 'waves' },
  ember: { title: 'KEEP THE FIRE', message: 'stepped away; the coals are glowing', accent: 'orange', motif: 'sparks' },
  aurora: { title: 'UNDER THE SKY', message: 'following the light for a moment', accent: 'green', motif: 'aurora' },
  phosphor: { title: 'TERMINAL IDLE', message: 'operator temporarily offline', accent: 'green', motif: 'scan' },
  paper: { title: 'AWAY FROM DESK', message: 'a note was left beside the keys', accent: 'orange', motif: 'type' },
  mono: { title: 'PAUSED', message: 'be right back', accent: 'white', motif: 'clock' },
  macintosh: { title: 'Away', message: 'The user will be right back.', accent: 'purple', motif: 'macintosh' },
});

function breakMotif(profile, frame) {
  const tick = Math.floor(frame / 2);
  switch (profile.motif) {
    case 'prism': return gradientText('< < <  ://  > > >', frame);
    case 'stars': return `${paint.blue}${Array.from({ length: 31 }, (_, i) => (i * 7 + tick) % 19 < 2 ? '*' : '.').join('')}${paint.reset}`;
    case 'voltage': return `${tick % 2 ? paint.pink : paint.cyan}[|||]--[|||]--[|||]${paint.reset}`;
    case 'waves': return `${paint.cyan}${Array.from({ length: 27 }, (_, i) => Math.sin(i * 0.7 - frame * 0.2) > 0 ? '~' : '_').join('')}${paint.reset}`;
    case 'sparks': return `${paint.orange}${Array.from({ length: 25 }, (_, i) => ['.', '*', '+'][(i * 5 + tick) % 3]).join('')}${paint.reset}`;
    case 'aurora': return `${paint.green}.${paint.cyan} * ${paint.blue}.  ${paint.purple}* ${paint.pink}. ${paint.purple}*  ${paint.blue}. ${paint.cyan}* ${paint.green}.${paint.reset}`;
    case 'scan': { const at = tick % 25; return `${paint.green}${'='.repeat(at)}>${'.'.repeat(24 - at)}${paint.reset}`; }
    case 'type': return `${paint.orange}${'please wait...'.slice(0, tick % 15).padEnd(14)}${Math.floor(frame / 5) % 2 ? '|' : ' '}${paint.reset}`;
    default: return `${paint.white}[ ${['|', '/', '-', '\\'][tick % 4]} ]${paint.reset}`;
  }
}

function renderMacintoshBreakFrame(frame, progress, returning, width, height) {
  const middle = Math.floor(height / 2);
  const spinner = ['|', '/', '-', '\\'][Math.floor(frame / 3) % 4];
  const shownProgress = returning ? Math.max(0, Math.min(1, progress)) : 0;
  const percentage = `${String(Math.round(shownProgress * 100)).padStart(3)}%`;
  const status = returning ? 'returning to ://' : 'press space to return';

  let output = clearFrame(height);
  output += centeredAt(middle - 2, `${paint.dim}:// AWAY${paint.reset}`, width);
  output += centeredAt(middle, `${paint.purple}${paint.bold}${spinner}${paint.reset}`, width);
  output += centeredAt(middle + 2, `${paint.white}${percentage}${paint.reset}`, width);
  output += centeredAt(middle + 4, `${paint.dim}${status}${paint.reset}`, width);
  process.stdout.write(output);
}

function renderBreakFrame(frame, progress, returning = false) {
  const { width, height } = effectScreenSize();
  if (getTheme() === 'macintosh') {
    renderMacintoshBreakFrame(frame, progress, returning, width, height);
    return;
  }
  const centerRow = Math.floor(height / 2);
  const barWidth = Math.max(16, Math.min(48, width - 12));
  const profile = breakProfiles[getTheme()] || breakProfiles.rainbow;
  const accent = paint[profile.accent];
  let output = clearFrame(height);
  output += at(Math.max(1, centerRow - 4), 1, gradientRail(width, frame));
  output += centeredAt(centerRow - 2, `${paint.bold}${accent}${profile.title}${paint.reset}`, width);
  output += centeredAt(centerRow, breakMotif(profile, frame), width);
  output += centeredAt(centerRow + 1, `${paint.white}${profile.message}${paint.reset}`, width);
  output += centeredAt(centerRow + 2, progressBar(progress, barWidth, frame), width);
  const hint = returning ? 'RETURNING TO ://' : 'PRESS SPACE TO RETURN';
  output += centeredAt(centerRow + 4, `${returning ? paint.green : paint.dim}${hint}${paint.reset}`, width);
  output += at(Math.min(height, centerRow + 6), 1, gradientRail(width, frame + 7));
  process.stdout.write(output);
}

async function playBreakScreen() {
  let released = false;
  const onReadable = () => {
    let data;
    while ((data = process.stdin.read()) !== null) {
      if (data.toString('utf8').includes(' ')) released = true;
    }
  };

  process.stdout.write('\x1b[r');
  process.stdin.on('readable', onReadable);
  let frame = 0;
  while (!released) {
    renderBreakFrame(frame++, 0.12 + (Math.sin(frame * 0.12) + 1) * 0.025);
    await wait(33);
  }
  process.stdin.off('readable', onReadable);
  process.stdin.pause();
  playSound('closing or quitting');

  const startProgress = 0.15;
  for (let step = 0; step <= 30; step++) {
    const amount = step / 30;
    const eased = 1 - Math.pow(1 - amount, 3);
    renderBreakFrame(frame++, startProgress + (1 - startProgress) * eased, true);
    await wait(20);
  }
  renderBreakFrame(frame, 1, true);
  await wait(220);
}

async function registerFirstUser() {
  while (!registeredUsername()) {
    const layout = await renderPolishedLoginScreen();
    const stopLoginAnimation = animateLoginRail(layout);
    process.stdout.write(loginStatus(layout, 'FIRST RUN: create your CMD account', paint.yellow));
    cursorTo(layout.userRow, layout.inputColumn);
    const username = await readCredential('', false, layout.maxInputLength);
    if (username === null) {
      stopLoginAnimation();
      return false;
    }
    cursorTo(layout.passwordRow, layout.inputColumn);
    const password = await readCredential('', true, layout.maxInputLength);
    if (password === null) {
      stopLoginAnimation();
      return false;
    }
    process.stdout.write(at(layout.passwordRow, layout.inputColumn, ' '.repeat(layout.maxInputLength)));
    process.stdout.write(loginStatus(layout, 'Retype password to confirm', paint.cyan));
    cursorTo(layout.passwordRow, layout.inputColumn);
    const confirmation = await readCredential('', true, layout.maxInputLength);
    stopLoginAnimation();
    if (confirmation === null) return false;

    if (password !== confirmation) {
      process.stdout.write(loginStatus(layout, 'Passwords do not match', paint.red));
      await wait(950);
      continue;
    }
    try {
      AUTH_USER = registerCredentials(username, password);
      playSound('success');
      process.stdout.write(loginStatus(layout, `Account created for ${AUTH_USER}`, paint.green));
      await wait(750);
      return true;
    } catch (error) {
      process.stdout.write(loginStatus(layout, error.message, paint.red));
      await wait(1100);
    }
  }
  AUTH_USER = registeredUsername();
  return true;
}

async function authenticate() {
  if (!registeredUsername()) return registerFirstUser();
  AUTH_USER = registeredUsername();
  let failedAttempts = 0;
  while (failedAttempts < 3) {
    const layout = await renderPolishedLoginScreen();
    const stopLoginAnimation = animateLoginRail(layout);
    
    cursorTo(layout.userRow, layout.inputColumn);
    const user = await readCredential('', false, layout.maxInputLength);
    if (user === null) {
      stopLoginAnimation();
      return false;
    }
    
    if (user.trim().length === 0) {
      stopLoginAnimation();
      if (!(await waitForLoginRetry(layout, 'User required'))) return false;
      continue;
    }
    
    cursorTo(layout.passwordRow, layout.inputColumn);
    const password = await readCredential('', true, layout.maxInputLength);
    stopLoginAnimation();
    if (password === null) return false;
    
    if (password.length === 0) {
      if (!(await waitForLoginRetry(layout, 'Password required'))) return false;
      continue;
    }
    
    process.stdout.write(loginStatus(layout, 'Checking credentials...', paint.dim));
    await wait(280);

    if (credentialsMatch(user, password)) {
      playSound('success');
      process.stdout.write(loginStatus(layout, 'Access granted', paint.green));
      await wait(260);
      return true;
    }
    
    failedAttempts++;
    const remaining = 3 - failedAttempts;
    if (remaining === 0) {
      playSound('error');
      process.stdout.write(loginStatus(layout, 'Access denied · returning to ://', paint.red));
      await wait(900);
      return false;
    }
    const denied = `Denied · ${remaining} left`;
    if (!(await waitForLoginRetry(layout, denied))) return false;
  }
  return false;
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Command mode needs an interactive terminal.');
  process.exit(1);
}

async function runEnhancedConsole() {
  const helpEntries = [
    ['help', '', 'Show this command guide'],
    ['apps', '', 'List linked applications'],
    ['link', '<name> <path>', 'Save an application or shortcut'],
    ['run', '<name>', 'Launch a linked application'],
    ['unlink', '<name>', 'Remove a linked application'],
    ['cdlink', '[name path]', 'List or save a linked directory'],
    ['cd', '<folder>', 'Enter a path or linked directory'],
    ['ls', '[folder]', 'List folder contents (alias: dir)'],
    ['open', '<file>', 'Open a file or folder'],
    ['status', '', 'Show system and session information'],
    ['monitor', '', 'Open the live system monitor'],
    ['selina', '', 'Open the Sally + Erik animation (alias: sally)'],
    ['player', '', 'Open the skinned system media player'],
    ['chat', '[host|join]', 'Open messenger in a separate window'],
    ['update', '', 'Install the latest GitHub release'],
    ['pwd', '', 'Print the working directory'],
    ['exec', '', 'Open a clean Windows command terminal'],
    ['wsl', '', 'Open WSL in a new terminal window'],
    ['echo', '<text>', 'Print text'],
    ['time', '', 'Show local date and time'],
    ['clear', '', 'Redraw the console (alias: cls)'],
    ['brb', '', 'Show a break screen; Space returns'],
    ['note', '', 'Write and archive a timestamped note'],
    ['nd', '[directory]', 'Set where note and fix history is saved'],
    ['word', '', 'Play a timed random-word typing game'],
    ['skin', '', 'Select the global :// interface skin'],
    ['theme', '', 'Alias for skin'],
    ['fix', '', 'Archive an issue or fix for a later session'],
    ['nh', '', 'View timestamped note history'],
    ['guide', '', 'Open the animation momentum guide'],
    ['about', '', 'Show command-mode details'],
    ['exit', '', 'Return to the :// canvas'],
  ];

  function printHelp() {
    const inside = terminalWidth() - 4;
    const entriesFor = names => names.map(name => helpEntries.find(entry => entry[0] === name));
    const groups = [
      ['APP CONTROL', entriesFor(['apps', 'link', 'run', 'unlink'])],
      ['FILE BROWSER', entriesFor(['cdlink', 'cd', 'ls', 'open', 'pwd'])],
      ['WORKSPACE', entriesFor(['status', 'monitor', 'exec', 'wsl', 'update', 'echo', 'time', 'clear'])],
      ['SESSION', entriesFor(['help', 'brb', 'note', 'nd', 'word', 'skin', 'theme', 'fix', 'nh', 'guide', 'selina', 'player', 'chat', 'about', 'exit'])],
    ];
    console.log(`\n${paint.purple}╭${'─'.repeat(inside)}╮${paint.reset}`);
    console.log(panelRow(`${paint.bold}${paint.white}COMMAND INDEX${paint.reset}  ${paint.dim}// ${helpEntries.length} operations online${paint.reset}`, inside, paint.purple));
    for (const [label, entries] of groups) {
      console.log(`${paint.purple}├${'─'.repeat(inside)}┤${paint.reset}`);
      console.log(panelRow(`${paint.yellow}${label}${paint.reset}`, inside, paint.purple));
      for (const [name, usage, description] of entries) {
        const syntax = `${name}${usage ? ` ${usage}` : ''}`.padEnd(28);
        console.log(panelRow(`${paint.green}◆${paint.reset} ${paint.cyan}${syntax}${paint.reset}${paint.dim}${description}${paint.reset}`, inside, paint.purple));
      }
    }
    console.log(`${paint.purple}├${'─'.repeat(inside)}┤${paint.reset}`);
    console.log(panelRow(`${paint.dim}TAB completes commands/apps · UP/DOWN recalls history · CLEAR redraws the UI${paint.reset}`, inside, paint.purple));
    console.log(`${paint.purple}╰${'─'.repeat(inside)}╯${paint.reset}`);
  }

  function printStatus() {
    const usedMemory = os.totalmem() - os.freemem();
    const rows = [
      ['IDENTITY', AUTH_USER],
      ['HOST', os.hostname()],
      ['PLATFORM', `${os.type()} ${os.release()} (${os.arch()})`],
      ['NODE', process.version],
      ['MEMORY', `${formatBytes(usedMemory)} / ${formatBytes(os.totalmem())}`],
      ['UPTIME', `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`],
      ['LOCATION', displayPath(process.cwd())],
      ['LINKED APPS', String(Object.keys(loadApps()).length)],
      ['LINKED DIRS', String(Object.keys(loadDirectories()).length)],
    ];
    const inside = terminalWidth() - 4;
    console.log(`\n${paint.green}╭${'─'.repeat(inside)}╮${paint.reset}`);
    console.log(panelRow(`${paint.bold}${paint.white}SYSTEM TELEMETRY${paint.reset}  ${paint.green}● ALL SYSTEMS NOMINAL${paint.reset}`, inside, paint.green));
    console.log(`${paint.green}├${'─'.repeat(inside)}┤${paint.reset}`);
    for (const [label, value] of rows) {
      console.log(panelRow(`${paint.green}●${paint.reset} ${paint.cyan}${label.padEnd(14)}${paint.reset} ${paint.white}${value}${paint.reset}`, inside, paint.green));
    }
    console.log(`${paint.green}╰${'─'.repeat(inside)}╯${paint.reset}`);
  }

  async function listDirectory(requestedPath) {
    const target = resolveDirectoryTarget(requestedPath || '.');
    if (!fs.statSync(target).isDirectory()) throw new Error(`Not a directory: ${target}`);
    await openListViewer('folder', target);
  }

  async function launchLinked(name) {
    const apps = loadApps();
    const normalizedName = (name || '').toLowerCase();
    const appPath = apps[normalizedName];
    if (!appPath) throw new Error(`No linked app named: ${normalizedName || '(missing)'}`);
    if (!fs.existsSync(appPath)) throw new Error(`Linked path no longer exists: ${appPath}`);
    await openApp(appPath);
    await launchSpinner(`opening ${normalizedName}`);
    await animatedReply(`${normalizedName} launched`, paint.green);
  }

  let terminal;
  let commandCounter = 0;
  let chromeFrame = 0;
  let chromeSnapshot = commandHeaderSnapshot();
  let chromeTimer;
  let commandClosing = false;
  let footerRefreshQueued = false;

  function refreshFooterAfterInput(data) {
    playTypingSound(data);
    if (footerRefreshQueued) return;
    footerRefreshQueued = true;
    setImmediate(() => {
      footerRefreshQueued = false;
      if (commandFullscreenEffect || commandClosing || terminal.closed) return;
      animateCommandHeader(chromeFrame, chromeSnapshot);
    });
  }

  async function openListViewer(mode, target = '') {
    commandFullscreenEffect = true;
    try {
      const code = await runListMode(mode, target);
      chromeSnapshot = commandHeaderSnapshot();
      await renderCommandHeader(chromeFrame);
      terminal.line = '';
      terminal.cursor = 0;
      if (code !== 0) throw new Error('List viewer closed unexpectedly.');
    } finally {
      commandFullscreenEffect = false;
    }
  }

  async function closeCommandMode() {
    if (commandClosing) return;
    commandClosing = true;
    commandFullscreenEffect = true;
    terminal.pause();
    playSound('closing or quitting');
    clearInterval(chromeTimer);
    try {
      await playCommandExitAnimation();
    } finally {
      terminal.close();
    }
  }

  const commands = {
    help: async () => {
      commandFullscreenEffect = true;
      try {
        const code = await runHelpMode(helpEntries);
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('Command guide closed unexpectedly.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    apps: async () => openListViewer('apps'),
    link: async args => {
      const name = (args.shift() || '').toLowerCase();
      const appPath = cleanPath(args.join(' '));
      if (!/^[a-z0-9_-]+$/i.test(name) || !appPath) throw new Error('Usage: link <name> <full path>');
      if (!fs.existsSync(appPath)) throw new Error(`Path not found: ${appPath}`);
      if (fs.statSync(appPath).isDirectory()) throw new Error('Use cdlink for directories.');
      const apps = loadApps();
      apps[name] = path.resolve(appPath);
      saveApps(apps);
      await animatedReply(`Linked ${name} -> ${apps[name]}`, paint.green);
    },
    run: async args => {
      if (args.length !== 1) throw new Error('Usage: run <app name>');
      await launchLinked(args[0]);
    },
    unlink: async args => {
      const name = (args[0] || '').toLowerCase();
      const apps = loadApps();
      if (!apps[name]) throw new Error(`No linked app named: ${name || '(missing)'}`);
      delete apps[name];
      saveApps(apps);
      await animatedReply(`Unlinked ${name}`, paint.green);
    },
    status: async () => printStatus(),
    monitor: async args => {
      if (args.length) throw new Error('Usage: monitor');
      commandFullscreenEffect = true;
      try {
        const code = await runSystemMonitorMode();
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('System monitor closed unexpectedly.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    selina: async args => {
      if (args.length) throw new Error('Usage: selina');
      commandFullscreenEffect = true;
      try {
        const code = await runLoveMode();
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('Love animation closed unexpectedly.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    sally: async args => commands.selina(args),
    player: async args => {
      if (args.length) throw new Error('Usage: player');
      commandFullscreenEffect = true;
      try {
        const code = await runMediaControlMode();
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('Media player closed unexpectedly.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    mediaplayer: async args => commands.player(args),
    mediactrl: async args => commands.player(args),
    chat: async args => {
      if (args.length > 1) throw new Error('Usage: chat [host|join]');
      if (args.length && !['host', 'join'].includes(args[0].toLowerCase())) {
        throw new Error('Usage: chat [host|join]');
      }
      commandFullscreenEffect = true;
      try {
        await launchMessengerWindow(args.map(argument => argument.toLowerCase()));
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
      } finally {
        commandFullscreenEffect = false;
      }
      await animatedReply('Messenger opened in a separate window', paint.green);
    },
    update: async args => {
      if (args.length) throw new Error('Usage: update');
      commandFullscreenEffect = true;
      try {
        const code = await runUpdaterMode();
        if (code === 42) {
          leaveCommandScreen();
          process.exit(42);
        }
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) {
          const reasons = { 2: 'No internet connection.', 3: 'GitHub rate limit reached. Try again shortly.', 4: 'No release found on GitHub.' };
          throw new Error(reasons[code] || 'Update did not complete. Check the log above for details.');
        }
      } finally {
        commandFullscreenEffect = false;
      }
    },
    pwd: async () => console.log(`${paint.cyan}${displayPath(process.cwd())}${paint.reset}`),
    cdlink: async args => {
      if (!args.length) {
        await openListViewer('links');
        return;
      }

      const name = (args.shift() || '').toLowerCase();
      const requestedPath = cleanPath(args.join(' '));
      if (!/^[a-z0-9_-]+$/i.test(name) || !requestedPath) throw new Error('Usage: cdlink <name> <directory path>');
      const directoryPath = path.resolve(process.cwd(), requestedPath);
      if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
        throw new Error(`Directory not found: ${directoryPath}`);
      }
      const directories = loadDirectories();
      directories[name] = directoryPath;
      saveDirectories(directories);
      await animatedReply(`Directory linked: ${name} -> ${displayPath(directoryPath)}`, paint.green);
    },
    cd: async args => {
      if (!args.length) throw new Error('Usage: cd <folder or linked name>');
      const target = resolveDirectoryTarget(args.join(' '));
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`Directory not found: ${target}`);
      process.chdir(target);
      updatePrompt();
      console.log(`${paint.dim}${displayPath(process.cwd())}${paint.reset}`);
    },
    ls: async args => listDirectory(args.join(' ')),
    dir: async args => commands.ls(args),
    open: async args => {
      if (!args.length) throw new Error('Usage: open <file or folder>');
      const target = resolveDirectoryTarget(args.join(' '));
      if (!fs.existsSync(target)) throw new Error(`Path not found: ${target}`);
      if (!fs.statSync(target).isDirectory()) await launchSpinner(`opening ${path.basename(target)}`);
      await openApp(target);
      await animatedReply(`Opened ${displayPath(target)}`, paint.green);
    },
    exec: async args => {
      if (args.length) throw new Error('Usage: exec');
      await openTerminal('cmd.exe', ['/d', '/k']);
      await animatedReply('Windows terminal opened', paint.green);
    },
    wsl: async args => {
      if (args.length) throw new Error('Usage: wsl');
      await openTerminal('wsl.exe');
      await animatedReply('WSL terminal opened', paint.green);
    },
    echo: async (_args, rawArguments) => console.log(rawArguments),
    time: async () => console.log(`${paint.cyan}${new Date().toLocaleString()}${paint.reset}`),
    clear: async () => renderCommandHeader(),
    cls: async args => commands.clear(args),
    note: async () => {
      commandFullscreenEffect = true;
      try {
        const code = await runNoteMode();
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('Note mode exited before saving.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    nd: async (_args, rawArguments) => {
      let requestedPath = cleanPath(rawArguments);
      if (!requestedPath) {
        commandFullscreenEffect = true;
        try {
          requestedPath = cleanPath(await new Promise(resolve => {
            terminal.resume();
            terminal.question(`\n${paint.cyan}Paste note directory${paint.reset} ${paint.dim}(${displayPath(notesDirectory())})${paint.reset}\n${paint.purple}›${paint.reset} `, resolve);
          }));
        } finally {
          commandFullscreenEffect = false;
        }
      }
      if (!requestedPath) {
        await animatedReply('Note directory unchanged.', paint.dim);
        return;
      }
      const target = path.resolve(process.cwd(), requestedPath);
      const result = setNotesDirectory(target);
      const migration = result.copied.length ? ` Copied: ${result.copied.join(', ')}.` : '';
      await animatedReply(`Note and fix history directory: ${displayPath(result.directory)}.${migration}`, paint.green);
    },
    word: async () => {
      commandFullscreenEffect = true;
      try {
        const code = await runWordMode();
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('Word game closed unexpectedly.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    theme: async () => {
      commandFullscreenEffect = true;
      try {
        const code = await runThemeMode();
        if (code === 42) {
          leaveCommandScreen();
          process.exit(42);
        }
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('Skin selector closed unexpectedly.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    skin: async () => commands.theme(),
    fix: async () => {
      commandFullscreenEffect = true;
      try {
        const code = await runFixMode();
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('Fix entry was not saved.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    nh: async () => {
      commandFullscreenEffect = true;
      try {
        const code = await runNoteHistoryMode();
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('Note history could not be loaded.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    guide: async () => {
      commandFullscreenEffect = true;
      try {
        const code = await runGuideMode();
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
        if (code !== 0) throw new Error('Animation guide closed unexpectedly.');
      } finally {
        commandFullscreenEffect = false;
      }
    },
    brb: async () => {
      commandFullscreenEffect = true;
      try {
        await playBreakScreen();
        chromeSnapshot = commandHeaderSnapshot();
        await renderCommandHeader(chromeFrame);
        terminal.line = '';
        terminal.cursor = 0;
      } finally {
        commandFullscreenEffect = false;
      }
    },
    about: async () => revealLines([
      `${paint.bold}${paint.cyan}:// COMMAND MODE ${packageManifest.version}${paint.reset}`,
      `${paint.dim}Authenticated app launcher and Windows command console.${paint.reset}`,
      `${paint.dim}Published by ${packageManifest.publisher || packageManifest.author}${paint.reset}`,
      `${paint.dim}Portable data: ${displayPath(dataDirectory)}${paint.reset}`,
      `${paint.dim}Registry: ${displayPath(registryPath)}${paint.reset}`,
      `${paint.dim}Runtime: ${process.version}${paint.reset}`,
    ]),
    exit: async args => {
      if (args.length) throw new Error('Usage: exit');
      await closeCommandMode();
    },
  };

  function updatePrompt() {
    const location = displayPath(path.basename(process.cwd()) || process.cwd());
    terminal.setPrompt(`\n${paint.dim}${AUTH_USER}@://${paint.reset} ${paint.cyan}${clip(location, 24)}${paint.reset} ${paint.purple}›${paint.reset} `);
  }

  function complete(line) {
    const tokens = line.trimStart().split(/\s+/);
    let candidates = Object.keys(commands);
    if (tokens.length > 1 && tokens[0].toLowerCase() === 'run') candidates = Object.keys(loadApps());
    else if (tokens.length > 1 && ['cd', 'ls', 'dir', 'open'].includes(tokens[0].toLowerCase())) {
      let entries = [];
      try {
        entries = fs.readdirSync(process.cwd(), { withFileTypes: true }).map(entry => entry.name);
      } catch {}
      candidates = [...Object.keys(loadDirectories()), ...entries];
    }
    const fragment = tokens[tokens.length - 1].toLowerCase();
    const hits = candidates.filter(candidate => candidate.startsWith(fragment));
    return [hits.length ? hits : candidates, fragment];
  }

  terminal = readline.createInterface({ input: process.stdin, output: process.stdout, completer: complete, historySize: 200 });
  process.stdin.on('data', refreshFooterAfterInput);
  updatePrompt();
  chromeTimer = setInterval(() => {
    if (commandFullscreenEffect) return;
    chromeFrame++;
    if (chromeFrame % 300 === 0) chromeSnapshot = commandHeaderSnapshot();
    animateCommandHeader(chromeFrame, chromeSnapshot);
  }, 80);

  const handleResize = () => {
    if (commandFullscreenEffect) return;
    chromeSnapshot = commandHeaderSnapshot();
    renderCommandHeader(chromeFrame).then(() => {
      updatePrompt();
      if (!terminal.closed) terminal.prompt(true);
    });
  };
  process.stdout.on('resize', handleResize);
  terminal.on('line', async line => {
    const input = line.trim();
    if (!input) return terminal.prompt();
    commandCounter++;
    const firstSpace = input.search(/\s/);
    const name = (firstSpace === -1 ? input : input.slice(0, firstSpace)).toLowerCase();
    const rawArguments = firstSpace === -1 ? '' : input.slice(firstSpace).trim();
    commandActivity = 'PROCESSING COMMAND';
    terminal.pause();
    try {
      if (commands[name]) {
        playSound('command');
        await commands[name](parseArguments(rawArguments), rawArguments);
      } else {
        playSound('error');
        await animatedReply(`Unknown command: ${name}. Type help to list commands.`, paint.red);
      }
    } catch (error) {
      playSound('error');
      await animatedReply(error.message, paint.red);
    } finally {
      commandActivity = 'AWAITING INPUT';
      if (!terminal.closed) {
        updatePrompt();
        terminal.resume();
        terminal.prompt();
        refreshFooterAfterInput();
      }
    }
  });
  terminal.on('close', () => {
    clearInterval(chromeTimer);
    process.stdin.off('data', refreshFooterAfterInput);
    process.stdout.off('resize', handleResize);
    process.exit(0);
  });
  terminal.on('SIGINT', () => void closeCommandMode());
  terminal.prompt();
}

async function startCommandMode() {
  await warmSoundSystem();
  enterCommandScreen();
  if (!(await authenticate())) {
    await animatedReply('COMMAND PROCESS TERMINATED', paint.red);
    process.exit(1);
  }

  await playCommandInterfaceReveal();
  await renderCommandHeader();

/* Legacy command loop retained as a reference for the original visual design.
const terminal = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${paint.green}${paint.bold}p1z${paint.reset}${paint.cyan}@${paint.reset}${paint.purple}${paint.bold}://${paint.reset} ${paint.yellow}◆${paint.reset} ${paint.cyan}cmd${paint.reset} ${paint.pink}▸${paint.reset} `,
});

terminal.on('line', async line => {
  const command = line.trim();
  const apps = loadApps();
  if (!command) {
    terminal.prompt();
    return;
  }

  if (command.toLowerCase() === 'exit') {
    terminal.close();
    return;
  }

  terminal.pause();

  if (command.toLowerCase() === 'help') {
    console.log(`\n${paint.yellow}╭─────────────────────────────────────────────────────────╮${paint.reset}`);
    console.log(`${paint.yellow}│${paint.reset} ${paint.bold}${paint.white}COMMAND INTERFACE${paint.reset}                                       ${paint.yellow}│${paint.reset}`);
    console.log(`${paint.yellow}╰─────────────────────────────────────────────────────────╯${paint.reset}\n`);
    
    await revealLines([
      `${paint.green}◆ ${paint.cyan}help${paint.reset}                         ${paint.dim}Show this help menu${paint.reset}`,
      `${paint.green}◆ ${paint.cyan}apps${paint.reset}                         ${paint.dim}List all linked applications${paint.reset}`,
      `${paint.green}◆ ${paint.cyan}link${paint.reset} ${paint.purple}<name> <path>${paint.reset}           ${paint.dim}Link an app executable or shortcut${paint.reset}`,
      `${paint.green}◆ ${paint.cyan}open${paint.reset} ${paint.purple}<name>${paint.reset}                  ${paint.dim}Launch a linked application${paint.reset}`,
      `${paint.green}◆ ${paint.cyan}unlink${paint.reset} ${paint.purple}<name>${paint.reset}                ${paint.dim}Remove an app link${paint.reset}`,
      `${paint.green}◆ ${paint.cyan}exit${paint.reset}                         ${paint.dim}Return to :// canvas${paint.reset}`,
      '',
      `${paint.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${paint.reset}`,
      '',
      `${paint.dim}Example:${paint.reset}`,
      `  ${paint.purple}link${paint.reset} ${paint.green}notepad${paint.reset} ${paint.yellow}"C:\\Windows\\System32\\notepad.exe"${paint.reset}`,
      `  ${paint.purple}open${paint.reset} ${paint.green}notepad${paint.reset}`,
      '',
    ]);
  } else if (command.toLowerCase() === 'apps') {
    const entries = Object.entries(apps);
    if (entries.length === 0) await animatedReply('No apps linked yet.', paint.dim);
    else {
      console.log(`${paint.bold}${paint.white}LINKED APPS${paint.reset}`);
      for (const [name, appPath] of entries) {
        console.log(`${paint.green}●${paint.reset} ${paint.cyan}${name.padEnd(15)}${paint.reset} ${paint.dim}${appPath}${paint.reset}`)
        await wait(35);
      }
    }
  } else if (/^link\s+/i.test(command)) {
    const match = command.match(/^link\s+([a-z0-9_-]+)\s+(.+)$/i);
    if (!match) {
      await animatedReply('Usage: link <name> <full app path>', paint.red);
    } else {
      const name = match[1].toLowerCase();
      const appPath = cleanPath(match[2]);
      if (!fs.existsSync(appPath)) {
        await animatedReply(`Path not found: ${appPath}`, paint.red);
      } else {
        apps[name] = appPath;
        saveApps(apps);
        await animatedReply(`Linked ${name} -> ${appPath}`, paint.green);
      }
    }
  } else if (/^open\s+/i.test(command)) {
    const name = command.slice(5).trim().toLowerCase();
    const appPath = apps[name];
    if (!appPath) {
      await animatedReply(`No linked app named: ${name}`, paint.red);
    } else if (!fs.existsSync(appPath)) {
      await animatedReply(`Linked path no longer exists: ${appPath}`, paint.red);
    } else {
      try {
        await openApp(appPath);
        await launchSpinner(`opening ${name}`);
        await animatedReply(`${name} launched`, paint.green);
      } catch (error) {
        await animatedReply(`Could not open ${name}: ${error.message}`, paint.red);
      }
    }
  } else if (/^unlink\s+/i.test(command)) {
    const name = command.slice(7).trim().toLowerCase();
    if (!apps[name]) {
      await animatedReply(`No linked app named: ${name}`, paint.red);
    } else {
      delete apps[name];
      saveApps(apps);
      await animatedReply(`Unlinked ${name}.`, paint.green);
    }
  } else {
    await animatedReply(`Unknown command: ${command}`, paint.red);
  }
  terminal.resume();
  terminal.prompt();
});

terminal.on('close', () => process.exit(0));
terminal.on('SIGINT', () => terminal.close());
terminal.prompt();
*/
await runEnhancedConsole();
}

async function startMainScreenBreak() {
  enterCommandScreen();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    await playBreakScreen();
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
  }
  process.exit(0);
}

process.once('exit', leaveCommandScreen);
process.once('SIGTERM', () => process.exit(0));

(process.argv.includes('--brb-main') ? startMainScreenBreak() : startCommandMode()).catch(error => {
  leaveCommandScreen();
  console.error(`Command mode failed: ${error.message}`);
  process.exitCode = 1;
});
