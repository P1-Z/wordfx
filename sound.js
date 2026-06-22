'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SOUND_DIRECTORY = path.join(__dirname, 'sound');
const PLAYER_SCRIPT = path.join(__dirname, 'sound-player.ps1');
const SOUND_NAME = /^[a-z0-9 _-]+$/i;
let player = null;
let playerReady = false;
let readyPromise = null;
let resolveReady = null;
const recentVariantIndexes = new Map();
let loopGeneration = 0;
const activeLoops = new Map();
const MINIMUM_LOOP_PLAYBACK_MS = 750;
const CUE_DEBOUNCE_MS = 120;
const lastCueAt = new Map();
const SOUND_VARIANTS = Object.freeze({
  navigate: 5,
  select: 4,
  confirm: 4,
  chat_send: 5,
});
const TYPING_VARIANTS = Object.freeze({
  type: 12,
  type_space: 4,
  type_backspace: 4,
  type_return: 3,
});

function pickVariantIndex(name, count, random = Math.random, historyMap = recentVariantIndexes) {
  if (!Number.isInteger(count) || count < 1) return 0;
  const history = historyMap.get(name) || [];
  // With four or more samples, keep the last two out of the draw. This avoids
  // obvious repeats while retaining enough choices to prevent a new pattern.
  // Three-sample banks remember one draw; two-sample banks stay fully random
  // instead of falling into an equally mechanical A/B alternation.
  const memory = count >= 4 ? 2 : count === 3 ? 1 : 0;
  const excluded = new Set(memory ? history.slice(-memory) : []);
  const candidates = [];
  for (let index = 1; index <= count; index++) {
    if (!excluded.has(index)) candidates.push(index);
  }
  const draw = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
  const selected = candidates[Math.floor(draw * candidates.length)];
  historyMap.set(name, [...history, selected].slice(-Math.max(1, memory)));
  return selected;
}

function variantName(name, count, random = Math.random, historyMap = recentVariantIndexes) {
  const index = pickVariantIndex(name, count, random, historyMap);
  return index ? `${name}_${String(index).padStart(2, '0')}` : name;
}

function soundEnabled() {
  return process.platform === 'win32'
    && process.env.WORDFX_SOUND !== '0'
    && fs.existsSync(SOUND_DIRECTORY)
    && fs.existsSync(PLAYER_SCRIPT);
}

function ensurePlayer() {
  if (player?.stdin?.writable) return player;
  if (!soundEnabled()) return null;
  try {
    playerReady = false;
    readyPromise = new Promise(resolve => { resolveReady = resolve; });
    const spawnedPlayer = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', PLAYER_SCRIPT,
      '-SoundDirectory', SOUND_DIRECTORY,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    player = spawnedPlayer;
    let output = '';
    spawnedPlayer.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (!playerReady && /(?:^|\r?\n)READY(?:\r?\n|$)/.test(output)) {
        playerReady = true;
        resolveReady?.(true);
        resolveReady = null;
      }
      if (output.length > 64) output = output.slice(-64);
    });
    const resetPlayer = () => {
      if (player !== spawnedPlayer) return;
      resolveReady?.(false);
      resolveReady = null;
      playerReady = false;
      readyPromise = null;
      player = null;
    };
    spawnedPlayer.once('error', resetPlayer);
    spawnedPlayer.once('exit', resetPlayer);
    spawnedPlayer.unref();
    spawnedPlayer.stdin.unref?.();
    spawnedPlayer.stdout.unref?.();
    return spawnedPlayer;
  } catch {
    player = null;
    return null;
  }
}

async function warmSoundSystem(timeoutMs = 5000) {
  if (!ensurePlayer()) return false;
  if (playerReady) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    readyPromise.then(result => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function send(command, name) {
  if (!SOUND_NAME.test(name)) return false;
  const activePlayer = ensurePlayer();
  if (!activePlayer?.stdin?.writable) return false;
  try {
    activePlayer.stdin.write(`${command} ${name}\n`);
    return true;
  } catch {
    return false;
  }
}

function playSound(name) {
  const now = Date.now();
  if (now - (lastCueAt.get(name) || 0) < CUE_DEBOUNCE_MS) return false;
  const count = SOUND_VARIANTS[name] || 0;
  const resolvedName = count ? variantName(name, count) : name;
  const sent = send('play', resolvedName);
  if (sent) lastCueAt.set(name, now);
  return sent;
}

function startSoundLoop(name) {
  const state = {
    generation: ++loopGeneration,
    startedAt: Date.now(),
  };
  activeLoops.set(name, state);
  return send('loop', name);
}

function stopSound(name) {
  const state = activeLoops.get(name);
  if (!state) return send('stop', name);
  const remaining = Math.max(0, MINIMUM_LOOP_PLAYBACK_MS - (Date.now() - state.startedAt));
  const finish = () => {
    if (activeLoops.get(name)?.generation !== state.generation) return;
    activeLoops.delete(name);
    send('stop', name);
  };
  if (!remaining) {
    finish();
    return true;
  }
  const timer = setTimeout(finish, remaining);
  timer.unref?.();
  return true;
}

function playTypingSound(value) {
  if (value === undefined || value === null) return false;
  const key = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  if (key.startsWith('\x1b')) return false;
  const isBackspace = key === '\x7f' || key === '\b';
  const isReturn = key === '\r' || key === '\n';
  const isSinglePrintableCharacter = Array.from(key).length === 1 && !/[\x00-\x1f\x7f]/.test(key);
  if (!isBackspace && !isReturn && !isSinglePrintableCharacter) return false;
  const family = isBackspace
    ? 'type_backspace'
    : isReturn
      ? 'type_return'
      : key === ' '
        ? 'type_space'
        : 'type';
  // Typing bypasses the UI-cue debounce. Each physical keystroke should have
  // a response, and the anti-repeat picker keeps fast input from sounding rigid.
  return send('play', variantName(family, TYPING_VARIANTS[family]));
}

function shutdownSoundSystem() {
  loopGeneration++;
  activeLoops.clear();
  lastCueAt.clear();
  recentVariantIndexes.clear();
  if (player) {
    try { player.stdin?.end?.(); } catch {}
    try { player.kill(); } catch {}
  }
  player = null;
  playerReady = false;
  readyPromise = null;
  resolveReady = null;
}

module.exports = {
  playSound,
  playTypingSound,
  shutdownSoundSystem,
  soundEnabled,
  startSoundLoop,
  stopSound,
  warmSoundSystem,
  _testing: Object.freeze({ pickVariantIndex, variantName }),
};
