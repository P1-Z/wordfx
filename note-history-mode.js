#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ansi: colors } = require('./theme');
const { noteFilePath } = require('./storage');
const { playSound, warmSoundSystem } = require('./sound');

if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1);
void warmSoundSystem();

const notesFile = noteFilePath('notes.txt', path.join(__dirname, 'notes', 'wordfx-notes.txt'));
const at = (row, column, text) => `\x1b[${row};${column}H${text}`;
const size = () => ({
  width: Math.max(24, process.stdout.columns || 80),
  height: Math.max(8, process.stdout.rows || 24),
});

function loadNotes() {
  try {
    return fs.readFileSync(notesFile, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .reverse();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function wrapLine(text, width) {
  const lines = [];
  let remaining = text;
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(' ', width);
    if (split < Math.floor(width / 2)) split = width;
    lines.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  lines.push(remaining);
  return lines;
}

function historyLines(notes, width) {
  if (!notes.length) return ['No notes have been saved yet.'];
  return notes.flatMap((note, index) => [
    ...wrapLine(note, width),
    ...(index < notes.length - 1 ? [''] : []),
  ]);
}

function render(notes, offset) {
  const { width, height } = size();
  const boxWidth = Math.min(100, width - 2);
  const inside = boxWidth - 2;
  const contentWidth = inside - 4;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const visibleRows = Math.max(1, height - 7);
  const lines = historyLines(notes, contentWidth);
  const maximumOffset = Math.max(0, lines.length - visibleRows);
  const safeOffset = Math.max(0, Math.min(offset, maximumOffset));
  let output = '\x1b[?25l\x1b[H';
  for (let row = 1; row <= height; row++) output += at(row, 1, '\x1b[2K');
  output += at(1, left, `${colors.purple}╭${'─'.repeat(inside)}╮${colors.reset}`);
  const title = `NOTE HISTORY  •  ${notes.length} ${notes.length === 1 ? 'NOTE' : 'NOTES'}  •  NEWEST FIRST`;
  const visibleTitle = title.slice(0, contentWidth);
  output += at(2, left, `${colors.purple}│${colors.reset}  ${colors.bold}${colors.white}${visibleTitle}${colors.reset}${' '.repeat(contentWidth - visibleTitle.length)}  ${colors.purple}│${colors.reset}`);
  output += at(3, left, `${colors.purple}├${'─'.repeat(inside)}┤${colors.reset}`);
  for (let row = 0; row < visibleRows; row++) {
    const line = lines[safeOffset + row] || '';
    output += at(4 + row, left, `${colors.purple}│${colors.reset}  ${line}${' '.repeat(Math.max(0, contentWidth - line.length))}  ${colors.purple}│${colors.reset}`);
  }
  output += at(4 + visibleRows, left, `${colors.purple}├${'─'.repeat(inside)}┤${colors.reset}`);
  const position = maximumOffset ? `${safeOffset + 1}-${Math.min(lines.length, safeOffset + visibleRows)} / ${lines.length}` : 'ALL NOTES VISIBLE';
  const footer = `UP/DOWN scroll  •  PGUP/PGDN jump  •  Q/ESC/ENTER returns  •  ${position}`;
  output += at(5 + visibleRows, left, `${colors.purple}│${colors.reset}  ${colors.dim}${footer.slice(0, contentWidth)}${' '.repeat(Math.max(0, contentWidth - footer.length))}${colors.reset}  ${colors.purple}│${colors.reset}`);
  output += at(6 + visibleRows, left, `${colors.purple}╰${'─'.repeat(inside)}╯${colors.reset}`);
  process.stdout.write(output);
  return { offset: safeOffset, maximumOffset, page: visibleRows };
}

function main() {
  const notes = loadNotes();
  let offset = 0;
  process.stdout.write('\x1b[r\x1b[3J\x1b[2J\x1b[H');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let layout = render(notes, offset);

  const finish = () => {
    playSound('closing or quitting');
    process.stdin.off('data', onData);
    process.stdout.off('resize', onResize);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');
    process.exit(0);
  };
  const onResize = () => { layout = render(notes, offset); };
  const onData = data => {
    const key = data.toString('utf8');
    if (key === 'q' || key === 'Q' || key === '\x1b' || key === '\r' || key === '\n' || key === '\x03') return finish();
    if (key === '\x1b[A') offset--;
    else if (key === '\x1b[B') offset++;
    else if (key === '\x1b[5~') offset -= layout.page;
    else if (key === '\x1b[6~') offset += layout.page;
    else if (key === '\x1b[H' || key === '\x1b[1~') offset = 0;
    else if (key === '\x1b[F' || key === '\x1b[4~') offset = layout.maximumOffset;
    layout = render(notes, offset);
    offset = layout.offset;
  };

  process.stdin.on('data', onData);
  process.stdout.on('resize', onResize);
}

try {
  main();
} catch (error) {
  process.stdout.write(`\x1b[?25h\x1b[0m\nCould not load note history: ${error.message}\n`);
  process.exitCode = 1;
}
