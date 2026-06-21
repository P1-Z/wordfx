#!/usr/bin/env node

'use strict';

const { ansi: colors } = require('./theme');
const { playSound, warmSoundSystem } = require('./sound');

if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1);
void warmSoundSystem();

const entries = (() => {
  try {
    const parsed = JSON.parse(process.env.WORDFX_HELP_ENTRIES || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
})();

const ESC = '\x1b[';
const at = (row, column, text) => `${ESC}${row};${column}H${text}`;

function size() {
  return {
    width: Math.max(24, process.stdout.columns || 80),
    height: Math.max(8, process.stdout.rows || 24),
  };
}

function render(offset) {
  const { width, height } = size();
  const boxWidth = Math.min(104, width - 2);
  const inside = boxWidth - 2;
  const contentWidth = inside - 4;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const visibleRows = Math.max(1, height - 7);
  const maximumOffset = Math.max(0, entries.length - visibleRows);
  const safeOffset = Math.max(0, Math.min(offset, maximumOffset));
  let output = `${ESC}?25l${ESC}H`;
  for (let row = 1; row <= height; row++) output += at(row, 1, `${ESC}2K`);
  output += at(1, left, `${colors.purple}╭${'─'.repeat(inside)}╮${colors.reset}`);
  const title = `COMMAND GUIDE  //  ${entries.length} OPERATIONS`.slice(0, contentWidth);
  output += at(2, left, `${colors.purple}│${colors.reset}  ${colors.bold}${colors.white}${title}${colors.reset}${' '.repeat(Math.max(0, contentWidth - title.length))}  ${colors.purple}│${colors.reset}`);
  output += at(3, left, `${colors.purple}├${'─'.repeat(inside)}┤${colors.reset}`);

  for (let row = 0; row < visibleRows; row++) {
    const entry = entries[safeOffset + row];
    let content = '';
    if (entry) {
      const [name, usage, description] = entry;
      const syntaxWidth = Math.max(8, Math.min(28, Math.floor(contentWidth * 0.42)));
      const syntax = `${name}${usage ? ` ${usage}` : ''}`.slice(0, syntaxWidth).padEnd(syntaxWidth);
      const plain = `◆ ${syntax}${description}`;
      const clippedLength = Math.min(plain.length, contentWidth);
      content = `${colors.green}◆${colors.reset} ${colors.cyan}${syntax}${colors.reset}${colors.dim}${description}${colors.reset}`;
      if (plain.length > contentWidth) {
        const clipped = plain.slice(0, Math.max(1, contentWidth - 1));
        content = `${colors.white}${clipped}…${colors.reset}`;
      }
      content += ' '.repeat(Math.max(0, contentWidth - clippedLength));
    } else {
      content = ' '.repeat(contentWidth);
    }
    output += at(4 + row, left, `${colors.purple}│${colors.reset}  ${content}  ${colors.purple}│${colors.reset}`);
  }

  output += at(4 + visibleRows, left, `${colors.purple}├${'─'.repeat(inside)}┤${colors.reset}`);
  const position = maximumOffset
    ? `${safeOffset + 1}-${Math.min(entries.length, safeOffset + visibleRows)} / ${entries.length}`
    : 'ALL COMMANDS VISIBLE';
  const footer = `WHEEL/ARROWS scroll  •  PGUP/PGDN jump  •  Q/ESC/ENTER return  •  ${position}`;
  const shownFooter = footer.slice(0, contentWidth);
  output += at(5 + visibleRows, left, `${colors.purple}│${colors.reset}  ${colors.dim}${shownFooter}${' '.repeat(Math.max(0, contentWidth - shownFooter.length))}${colors.reset}  ${colors.purple}│${colors.reset}`);
  output += at(6 + visibleRows, left, `${colors.purple}╰${'─'.repeat(inside)}╯${colors.reset}`);
  process.stdout.write(output);
  return { offset: safeOffset, maximumOffset, page: visibleRows };
}

let offset = 0;
let layout;

function finish() {
  playSound('closing or quitting');
  process.stdin.off('data', onData);
  process.stdout.off('resize', onResize);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${colors.reset}${ESC}3J${ESC}2J${ESC}H`);
  process.exit(0);
}

function onResize() {
  layout = render(offset);
  offset = layout.offset;
}

function onData(data) {
  const key = data.toString('utf8');
  if (key === 'q' || key === 'Q' || key === '\x1b' || key === '\r' || key === '\n' || key === '\x03') return finish();
  if (key === '\x1b[A' || /^\x1b\[<64;/.test(key)) offset--;
  else if (key === '\x1b[B' || /^\x1b\[<65;/.test(key)) offset++;
  else if (key === '\x1b[5~') offset -= layout.page;
  else if (key === '\x1b[6~') offset += layout.page;
  else if (key === '\x1b[H' || key === '\x1b[1~') offset = 0;
  else if (key === '\x1b[F' || key === '\x1b[4~') offset = layout.maximumOffset;
  layout = render(offset);
  offset = layout.offset;
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', onData);
process.stdout.on('resize', onResize);
process.stdout.write(`${ESC}r${ESC}3J${ESC}2J${ESC}H${ESC}?1000h${ESC}?1006h`);
layout = render(offset);
