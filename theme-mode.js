#!/usr/bin/env node

'use strict';

const { ansi: colors, themes, getTheme, setTheme, renderThemeBar } = require('./theme');
const { playSound, warmSoundSystem } = require('./sound');

if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1);
void warmSoundSystem();

const names = Object.keys(themes);
let selected = Math.max(0, names.indexOf(getTheme()));
let frame = 0;
let pendingTheme = null;
const at = (row, column, text) => `\x1b[${row};${column}H${text}`;
const size = () => ({
  width: Math.max(32, process.stdout.columns || 80),
  height: Math.max(14, process.stdout.rows || 24),
});

function render() {
  const { width, height } = size();
  const boxWidth = Math.min(68, width - 4);
  const inside = boxWidth - 2;
  const contentWidth = inside - 4;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const top = Math.max(2, Math.floor((height - names.length - 7) / 2) + 1);
  let output = '\x1b[?25l\x1b[H';
  for (let row = 1; row <= height; row++) output += at(row, 1, '\x1b[2K');
  output += at(top, left, `${colors.purple}\u256d${'\u2500'.repeat(inside)}\u256e${colors.reset}`);
  const title = ':// SKINS';
  output += at(top + 1, left, `${colors.purple}\u2502${colors.reset}  ${colors.bold}${colors.white}${title}${colors.reset}${' '.repeat(contentWidth - title.length)}  ${colors.purple}\u2502${colors.reset}`);
  output += at(top + 2, left, `${colors.purple}\u251c${'\u2500'.repeat(inside)}\u2524${colors.reset}`);

  names.forEach((name, index) => {
    const theme = themes[name];
    const focused = index === selected;
    const active = name === getTheme();
    const palette = theme.skin === 'macintosh'
      ? `${colors.white}[ ${theme.effect.spinner[(frame + index) % theme.effect.spinner.length]} ]${colors.reset}`
      : renderThemeBar(1, 8, frame + index * 3, name);
    const marker = focused ? `${colors.cyan}>${colors.reset}` : ' ';
    const state = active ? `${colors.green}ACTIVE${colors.reset}` : '      ';
    const description = theme.description.slice(0, Math.max(0, contentWidth - 31));
    const plainLength = 31 + description.length;
    const content = `${marker} ${focused ? colors.bold + colors.white : colors.white}${theme.label.padEnd(10)}${colors.reset} ${palette}  ${state}  ${colors.dim}${description}${colors.reset}`;
    output += at(top + 3 + index, left, `${colors.purple}\u2502${colors.reset}  ${content}${' '.repeat(Math.max(0, contentWidth - Math.min(contentWidth, plainLength)))}  ${colors.purple}\u2502${colors.reset}`);
  });

  output += at(top + 3 + names.length, left, `${colors.purple}\u251c${'\u2500'.repeat(inside)}\u2524${colors.reset}`);
  const footer = pendingTheme
    ? `SKIN APPLIED: ${themes[pendingTheme].label.toUpperCase()}  \u00b7  RESTART :// NOW?  [Y] YES  [N] NO`
    : 'ARROWS select  \u00b7  ENTER apply  \u00b7  ESC cancel';
  output += at(top + 4 + names.length, left, `${colors.purple}\u2502${colors.reset}  ${colors.dim}${footer}${' '.repeat(Math.max(0, contentWidth - footer.length))}${colors.reset}  ${colors.purple}\u2502${colors.reset}`);
  output += at(top + 5 + names.length, left, `${colors.purple}\u2570${'\u2500'.repeat(inside)}\u256f${colors.reset}`);
  process.stdout.write(output);
}

function finish(code = 0) {
  playSound('closing or quitting');
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');
  process.exit(code);
}

function finishSelection(code) {
  if (process.send) process.send({ type: 'theme-selected', theme: pendingTheme }, () => finish(code));
  else finish(code);
}

function applySelection() {
  pendingTheme = names[selected];
  setTheme(pendingTheme);
  render();
}

process.stdout.on('resize', render);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => {
  const key = data.toString('utf8');
  if (pendingTheme) {
    for (const character of key.toLowerCase()) {
      if (character === 'y') return finishSelection(42);
      if (character === 'n' || character === '\r' || character === '\n' || character === '\x1b') return finishSelection(0);
    }
    return;
  }
  let changed = false;
  for (let index = 0; index < key.length;) {
    const sequence = key.slice(index, index + 3);
    if (sequence === '\x1b[A' || sequence === '\x1b[D') {
      selected = (selected - 1 + names.length) % names.length;
      changed = true;
      index += 3;
    } else if (sequence === '\x1b[B' || sequence === '\x1b[C') {
      selected = (selected + 1) % names.length;
      changed = true;
      index += 3;
    } else if (key[index] === '\r' || key[index] === '\n') {
      applySelection();
      return;
    } else if (key[index] === '\x03' || key[index] === '\x1b' || key[index].toLowerCase() === 'q') {
      finish();
      return;
    } else index++;
  }
  if (changed) render();
});

process.stdout.write('\x1b[r\x1b[3J\x1b[2J\x1b[H');
render();
setInterval(() => {
  frame++;
  render();
}, 100);
