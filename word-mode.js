#!/usr/bin/env node

'use strict';

const { ansi: colors, renderThemeBar } = require('./theme');
const { playSound, playTypingSound, warmSoundSystem } = require('./sound');

if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1);

const WORDS_PER_ROUND = 20;
const WORDS = [
  'amber', 'anchor', 'apple', 'arrow', 'atlas', 'beacon', 'breeze', 'bridge',
  'canvas', 'cedar', 'cloud', 'comet', 'coral', 'crystal', 'delta', 'ember',
  'falcon', 'field', 'flame', 'forest', 'glow', 'harbor', 'horizon', 'island',
  'jungle', 'lantern', 'laser', 'lemon', 'lunar', 'matrix', 'meadow', 'meteor',
  'midnight', 'mirror', 'motion', 'neon', 'nova', 'ocean', 'orbit', 'pixel',
  'planet', 'prism', 'pulse', 'quantum', 'river', 'rocket', 'shadow', 'signal',
  'silver', 'solar', 'spark', 'spectrum', 'stone', 'storm', 'summit', 'sunset',
  'swift', 'tiger', 'trail', 'vector', 'velvet', 'violet', 'wave', 'willow',
];

const size = () => ({
  width: Math.max(32, process.stdout.columns || 80),
  height: Math.max(14, process.stdout.rows || 24),
});
const at = (row, column, text) => `\x1b[${row};${column}H${text}`;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

let words = [];
let wordIndex = 0;
let typed = '';
let startedAt = 0;
let finishedAt = 0;
let correctKeys = 0;
let totalKeys = 0;
let timer = null;
let finished = false;

function shuffledWords() {
  const pool = [...WORDS];
  for (let index = pool.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, WORDS_PER_ROUND);
}

function elapsedSeconds() {
  if (!startedAt) return 0;
  return Math.max(0, ((finishedAt || Date.now()) - startedAt) / 1000);
}

function wpm() {
  const minutes = elapsedSeconds() / 60;
  const completedCharacters = words.slice(0, wordIndex).reduce((sum, word) => sum + word.length + 1, 0);
  return minutes > 0 ? Math.round(completedCharacters / 5 / minutes) : 0;
}

function accuracy() {
  return totalKeys ? Math.round(correctKeys / totalKeys * 100) : 100;
}

function clearScreen(height) {
  let output = '\x1b[?25l\x1b[H';
  for (let row = 1; row <= height; row++) output += at(row, 1, '\x1b[2K');
  return output;
}

function row(content, inside, color = colors.cyan) {
  const visible = content.replace(/\x1b\[[0-9;]*m/g, '').length;
  return `${color}\u2502${colors.reset}  ${content}${' '.repeat(Math.max(0, inside - visible - 4))}  ${color}\u2502${colors.reset}`;
}

function styledInput(target) {
  let output = '';
  for (let index = 0; index < typed.length; index++) {
    const color = typed[index] === target[index] ? colors.green : colors.red;
    output += `${color}${typed[index]}${colors.reset}`;
  }
  return output || `${colors.dim}start typing...${colors.reset}`;
}

function render() {
  const { width, height } = size();
  const boxWidth = Math.min(74, width - 4);
  const inside = boxWidth - 2;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const top = Math.max(2, Math.floor(height / 2) - 6);
  const target = words[wordIndex] || '';
  const progress = finished ? WORDS_PER_ROUND : wordIndex;
  const progressWidth = Math.max(8, inside - 18);
  const bar = renderThemeBar(progress / WORDS_PER_ROUND, progressWidth, Math.floor(elapsedSeconds() * 12));
  let output = clearScreen(height);
  output += at(top, left, `${colors.cyan}\u256d${'\u2500'.repeat(inside)}\u256e${colors.reset}`);
  output += at(top + 1, left, row(`${colors.bold}${colors.white}:// WORD${colors.reset}`, inside));
  output += at(top + 2, left, `${colors.cyan}\u251c${'\u2500'.repeat(inside)}\u2524${colors.reset}`);

  if (finished) {
    output += at(top + 3, left, row(`${colors.green}${colors.bold}ROUND COMPLETE${colors.reset}`, inside));
    output += at(top + 4, left, row('', inside));
    output += at(top + 5, left, row(`${colors.white}${wpm()} WPM${colors.reset}  ${colors.dim}\u00b7${colors.reset}  ${colors.white}${accuracy()}% ACCURACY${colors.reset}`, inside));
    output += at(top + 6, left, row(`${colors.dim}${elapsedSeconds().toFixed(1)} SECONDS  \u00b7  ${WORDS_PER_ROUND} WORDS${colors.reset}`, inside));
    output += at(top + 7, left, row('', inside));
    output += at(top + 8, left, row(`${colors.dim}ENTER plays again  \u00b7  ESC exits${colors.reset}`, inside));
    output += at(top + 9, left, row('', inside));
  } else {
    output += at(top + 3, left, row(`${colors.dim}TYPE THIS WORD${colors.reset}`, inside));
    output += at(top + 4, left, row(`${colors.bold}${colors.white}${target}${colors.reset}`, inside));
    output += at(top + 5, left, row('', inside));
    output += at(top + 6, left, row(styledInput(target), inside));
    output += at(top + 7, left, row('', inside));
    output += at(top + 8, left, row(`${bar} ${colors.white}${String(progress).padStart(2)}/${WORDS_PER_ROUND}${colors.reset}`, inside));
    output += at(top + 9, left, row(`${colors.dim}${wpm()} WPM  \u00b7  ${accuracy()}% ACCURACY  \u00b7  ESC exits${colors.reset}`, inside));
  }

  output += at(top + 10, left, `${colors.cyan}\u2570${'\u2500'.repeat(inside)}\u256f${colors.reset}`);
  if (!finished) output += at(top + 6, left + 3 + typed.length, '\x1b[5 q\x1b[?25h');
  process.stdout.write(output);
}

function resetRound() {
  words = shuffledWords();
  wordIndex = 0;
  typed = '';
  startedAt = 0;
  finishedAt = 0;
  correctKeys = 0;
  totalKeys = 0;
  finished = false;
  render();
}

function acceptCharacter(character) {
  if (!startedAt) startedAt = Date.now();
  const target = words[wordIndex];
  if (typed.length >= target.length) return;
  totalKeys++;
  if (character === target[typed.length]) correctKeys++;
  typed += character;
  if (typed === target) {
    playSound(wordIndex === WORDS_PER_ROUND - 1 ? 'success' : 'confirm');
    wordIndex++;
    typed = '';
    if (wordIndex === WORDS_PER_ROUND) {
      finishedAt = Date.now();
      finished = true;
    }
  }
  render();
}

function cleanup() {
  playSound('closing or quitting');
  if (timer) clearInterval(timer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0 q\x1b[0m\x1b[3J\x1b[2J\x1b[H');
}

async function main() {
  void warmSoundSystem(0);
  process.stdout.write('\x1b[r\x1b[3J\x1b[2J\x1b[H');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  resetRound();
  timer = setInterval(() => {
    if (startedAt && !finished) render();
  }, 250);
  process.stdout.on('resize', render);
  process.stdin.on('data', data => {
    const key = data.toString('utf8');
    playTypingSound(key);
    if (key === '\x03' || key === '\x1b') {
      cleanup();
      process.exit(0);
    }
    if (finished) {
      if (key === '\r' || key === '\n') resetRound();
      return;
    }
    if (key === '\x7f' || key === '\b') {
      typed = typed.slice(0, -1);
      render();
      return;
    }
    if (/^[a-z]$/i.test(key)) acceptCharacter(key.toLowerCase());
  });
}

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

main().catch(async error => {
  playSound('error');
  cleanup();
  process.stdout.write(`Could not start word mode: ${error.message}\n`);
  await wait(20);
  process.exitCode = 1;
});
