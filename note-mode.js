#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ansi: colors } = require('./theme');
const { noteFilePath } = require('./storage');
const { playSound, playTypingSound, warmSoundSystem } = require('./sound');

if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1);

const isFixMode = process.argv.includes('--fix');
const noteName = isFixMode ? 'fix.txt' : 'notes.txt';
const legacyName = isFixMode ? 'fix.txt' : 'wordfx-notes.txt';
const notesFile = noteFilePath(noteName, path.join(__dirname, 'notes', legacyName));
const editorTitle = isFixMode ? ':// FIX' : ':// NOTE';
const archiveLabel = isFixMode ? 'FIX' : 'NOTE';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const size = () => ({
  width: Math.max(24, process.stdout.columns || 80),
  height: Math.max(10, process.stdout.rows || 24),
});
const at = (row, column, text) => `\x1b[${row};${column}H${text}`;

function timestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${offset}`;
}

function wrap(text, width) {
  const lines = [];
  for (let index = 0; index < text.length || index === 0; index += width) lines.push(text.slice(index, index + width));
  return lines;
}

function renderEditor(sentence, message = 'ENTER saves  •  CTRL+C cancels') {
  const { width, height } = size();
  const boxWidth = Math.min(74, width - 4);
  const inside = boxWidth - 2;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const inputWidth = inside - 4;
  const lines = wrap(sentence, inputWidth).slice(-3);
  const top = Math.max(2, Math.floor(height / 2) - 5);
  let output = '\x1b[?25l\x1b[H';
  for (let row = 1; row <= height; row++) output += at(row, 1, '\x1b[2K');
  output += at(top, left, `${colors.cyan}╭${'─'.repeat(inside)}╮${colors.reset}`);
  output += at(top + 1, left, `${colors.cyan}│${colors.reset}  ${colors.bold}${colors.white}${editorTitle}${colors.reset}${' '.repeat(inside - editorTitle.length - 2)}${colors.cyan}│${colors.reset}`);
  output += at(top + 2, left, `${colors.cyan}├${'─'.repeat(inside)}┤${colors.reset}`);
  for (let row = 0; row < 3; row++) {
    const content = lines[row] || '';
    output += at(top + 3 + row, left, `${colors.cyan}│${colors.reset}  ${content}${' '.repeat(inputWidth - content.length)}  ${colors.cyan}│${colors.reset}`);
  }
  output += at(top + 6, left, `${colors.cyan}├${'─'.repeat(inside)}┤${colors.reset}`);
  const clippedMessage = message.slice(0, inside - 4);
  output += at(top + 7, left, `${colors.cyan}│${colors.reset}  ${colors.dim}${clippedMessage}${' '.repeat(inside - clippedMessage.length - 4)}${colors.reset}  ${colors.cyan}│${colors.reset}`);
  output += at(top + 8, left, `${colors.cyan}╰${'─'.repeat(inside)}╯${colors.reset}`);
  const visible = lines.at(-1) || '';
  const caretRow = top + 3 + Math.max(0, lines.length - 1);
  output += at(caretRow, left + 3 + visible.length, '\x1b[5 q\x1b[?25h');
  process.stdout.write(output);
}

async function dissolve(sentence) {
  playSound('note_dissolve');
  const glyphs = '01#@$%&*+<>▓▒░';
  for (let frame = 0; frame <= 24; frame++) {
    const progress = frame / 24;
    const dissolved = Array.from(sentence, (character, index) => {
      const threshold = ((index * 37) % 101) / 100;
      if (threshold < progress) return ' ';
      if (threshold < progress + 0.2) return glyphs[(frame + index) % glyphs.length];
      return character;
    }).join('');
    renderEditor(dissolved, `DISSOLVING ${archiveLabel} INTO ARCHIVE`);
    await wait(28);
  }
}

function readSentence() {
  return new Promise(resolve => {
    let sentence = '';
    const maximumLength = Math.max(80, (process.stdout.columns || 80) * 3);
    const onResize = () => renderEditor(sentence);
    const onData = data => {
      const key = data.toString('utf8');
      playTypingSound(key);
      if (key === '\x03') return finish(null);
      if (key === '\r' || key === '\n') return sentence.trim() ? finish(sentence.trim()) : undefined;
      if (key === '\x7f' || key === '\b') sentence = sentence.slice(0, -1);
      else if (!key.startsWith('\x1b') && !/[\x00-\x1f]/.test(key) && sentence.length < maximumLength) sentence += key.replace(/[\r\n]/g, ' ');
      renderEditor(sentence);
    };
    const finish = value => {
      process.stdin.off('data', onData);
      process.stdout.off('resize', onResize);
      resolve(value);
    };
    process.stdin.on('data', onData);
    process.stdout.on('resize', onResize);
    renderEditor(sentence);
  });
}

async function main() {
  void warmSoundSystem(0);
  process.stdout.write('\x1b[r\x1b[3J\x1b[2J\x1b[H');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    const sentence = await readSentence();
    if (sentence === null) return;
    await dissolve(sentence);
    fs.appendFileSync(notesFile, `- [${timestamp()}] ${sentence}\n`, 'utf8');
    renderEditor('', `SAVED  •  ${notesFile}`);
    await wait(650);
  } finally {
    playSound('closing or quitting');
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h\x1b[0 q\x1b[0m\x1b[3J\x1b[2J\x1b[H');
  }
}

main().catch(error => {
  playSound('error');
  process.stdout.write(`\x1b[?25h\x1b[0m\nCould not save ${archiveLabel.toLowerCase()}: ${error.message}\n`);
  process.exitCode = 1;
});
