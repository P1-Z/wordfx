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
let typingIndex = 0;
let loopGeneration = 0;
const activeLoops = new Map();
const MINIMUM_LOOP_PLAYBACK_MS = 750;
const CUE_DEBOUNCE_MS = 120;
const lastCueAt = new Map();

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

async function warmSoundSystem(timeoutMs = 3000) {
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
  const sent = send('play', name);
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
  const isSinglePrintableCharacter = key.length === 1 && !/[\x00-\x1f\x7f]/.test(key);
  if (!isBackspace && !isSinglePrintableCharacter) return false;
  typingIndex = typingIndex % 5 + 1;
  return playSound(`type_${String(typingIndex).padStart(2, '0')}`);
}

module.exports = {
  playSound,
  playTypingSound,
  soundEnabled,
  startSoundLoop,
  stopSound,
  warmSoundSystem,
};
