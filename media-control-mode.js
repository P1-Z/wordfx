#!/usr/bin/env node

'use strict';

const { spawn } = require('node:child_process');
const { ansi, rgb, getTheme, getSkin, themePalette } = require('./theme');
const { playSound, warmSoundSystem } = require('./sound');

const ESC = '\x1b[';
const { reset, bold, dim } = ansi;

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Media player needs an interactive terminal.');
  process.exit(1);
}
void warmSoundSystem(0);

const keyBackendScript = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MediaKeys {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static void Press(byte key) {
    keybd_event(key, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 2, UIntPtr.Zero);
  }
}
'@
while (($line = [Console]::In.ReadLine()) -ne $null) {
  [byte]$key = 0
  if ([byte]::TryParse($line, [ref]$key)) { [MediaKeys]::Press($key) }
}
`;

const backend = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', keyBackendScript], {
  stdio: ['pipe', 'ignore', 'ignore'],
  windowsHide: true,
});

let frame = 0;
let closing = false;
let lastAction = 'READY';
let actionUntil = 0;

const mediaPalette = [
  [176, 92, 92], [190, 135, 80], [190, 170, 95], [92, 150, 110],
  [78, 145, 148], [90, 116, 165], [134, 105, 155], [170, 100, 135],
];

const playerProfiles = Object.freeze({
  rainbow: { title: 'PRISM MIXER', subtitle: 'eight colors / one loud signal', glyphs: ['.', ':', '*', 'o', 'O', '@'], event: 'prism', ornament: '<+>' },
  midnight: { title: 'NIGHT RADIO', subtitle: 'broadcasting after everyone leaves', glyphs: ['.', '.', ':', '*', '+'], event: 'comet', ornament: '. * .' },
  neon: { title: 'PULSE DECK', subtitle: 'high voltage stereo', glyphs: ['.', '=', '#', '#'], event: 'flash', ornament: '[!!]' },
  ocean: { title: 'TIDAL TUNER', subtitle: 'system audio below the surface', glyphs: ['~', '~', '=', '\u2248'], event: 'ripple', ornament: '~ o ~' },
  ember: { title: 'HEARTH RADIO', subtitle: 'keep one good song burning', glyphs: ['.', ':', '*', '^', '#'], event: 'sparks', ornament: '* ^ *' },
  aurora: { title: 'SKY RECEIVER', subtitle: 'signals moving over the horizon', glyphs: ['.', '\u00b7', '*', '\u2726', '\u2736'], event: 'constellation', ornament: '\u2726 . \u2726' },
  phosphor: { title: 'SIGNAL TERMINAL', subtitle: 'audio channel 01 / trace locked', glyphs: ['.', '-', '=', '#'], event: 'scan', ornament: '[CRT]' },
  paper: { title: 'DESK RADIO', subtitle: 'now playing, in plain type', glyphs: ['.', ':', ';', '!', '#'], event: 'type', ornament: '[memo]' },
  mono: { title: 'UTILITY AUDIO', subtitle: 'transport / level / output', glyphs: ['.', '-', '=', '#'], event: 'meter', ornament: '[--]' },
  macintosh: { title: ':// HI-FI', subtitle: 'a small machine for loud feelings', glyphs: ['.', ':', '*', 'o'], event: 'pinwheel', ornament: '[#]' },
});

function color(value) {
  return `\x1b[38;2;${value.join(';')}m`;
}

function visibleLength(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').length;
}

function centered(row, text, width) {
  const column = Math.max(1, Math.floor((width - visibleLength(text)) / 2) + 1);
  return `${ESC}${row};${column}H${text}`;
}

function visualizer(frame, width) {
  const count = Math.max(12, Math.min(34, width - 18));
  const palette = getSkin() === 'macintosh' ? mediaPalette : themePalette();
  let output = '';
  for (let index = 0; index < count; index++) {
    const strength = (Math.sin(frame * 0.18 + index * 0.72) + Math.sin(frame * 0.09 - index * 0.31) + 2) / 4;
    const glyphs = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const glyph = glyphs[Math.min(glyphs.length - 1, Math.floor(strength * glyphs.length))];
    const place = index / Math.max(1, count - 1) * (palette.length - 1);
    const from = palette[Math.floor(place)];
    const to = palette[Math.min(palette.length - 1, Math.floor(place) + 1)];
    const blend = place - Math.floor(place);
    const shade = from.map((channel, channelIndex) => Math.round(channel + (to[channelIndex] - channel) * blend));
    output += `${color(shade)}${glyph}`;
  }
  return `${output}${reset}`;
}

function gradientRail(frame, width) {
  const activePalette = getSkin() === 'macintosh' ? mediaPalette : themePalette();
  const palette = [...activePalette, activePalette[0]];
  const span = palette.length - 1;
  let output = '';
  for (let index = 0; index < width; index++) {
    const place = ((index / Math.max(1, width) * span - frame * 0.065) % span + span) % span;
    const from = Math.floor(place);
    const to = (from + 1) % palette.length;
    const amount = place - from;
    const smooth = amount * amount * (3 - 2 * amount);
    const shade = palette[from].map((channel, channelIndex) =>
      Math.round(channel + (palette[to][channelIndex] - channel) * smooth)
    );
    output += `${color(shade)}━`;
  }
  return `${output}${reset}`;
}

function button(label, action) {
  const active = Date.now() < actionUntil && lastAction === action;
  return `${active ? color(rgb.pink) + bold + '▰' : color(rgb.cyan) + '▱'} ${label}${reset}`;
}

function themedVisualizer(profile, width) {
  const palette = themePalette();
  let output = '';
  for (let index = 0; index < width; index++) {
    const first = Math.sin(frame * 0.13 + index * 0.61);
    const second = Math.sin(frame * 0.057 - index * 0.27);
    const strength = (first + second + 2) / 4;
    const glyph = profile.glyphs[Math.min(profile.glyphs.length - 1, Math.floor(strength * profile.glyphs.length))];
    const shade = palette[Math.floor(index / Math.max(1, width) * palette.length) % palette.length];
    output += `${color(shade)}${glyph}`;
  }
  return `${output}${reset}`;
}

function themedEvent(profile, width) {
  if (Date.now() >= actionUntil) return `${dim}${'-'.repeat(Math.max(4, width))}${reset}`;
  const tick = Math.floor(frame / 2);
  const action = lastAction === 'PLAY / PAUSE' ? 'PLAY' : lastAction;
  const space = Math.max(10, width - action.length - 4);
  let effect;
  switch (profile.event) {
    case 'prism': effect = Array.from({ length: space }, (_, i) => (i + tick) % 7 === 0 ? '*' : '-').join(''); break;
    case 'comet': effect = `${'.'.repeat(tick % space)}*${'.'.repeat(Math.max(0, space - tick % space - 1))}`; break;
    case 'flash': effect = tick % 2 ? '#'.repeat(space) : '='.repeat(space); break;
    case 'ripple': effect = `${'~'.repeat(tick % 5)}((${action}))${'~'.repeat(tick % 5)}`; return effect.slice(0, width);
    case 'sparks': effect = Array.from({ length: space }, (_, i) => '*+.'[(i * 3 + tick) % 3]).join(''); break;
    case 'constellation': effect = Array.from({ length: space }, (_, i) => (i * 5 + tick) % 13 < 2 ? '*' : '.').join(''); break;
    case 'scan': effect = `${'='.repeat(tick % space)}>${'.'.repeat(Math.max(0, space - tick % space - 1))}`; break;
    case 'type': effect = `memo: ${action}`.slice(0, Math.max(1, tick + 1)).padEnd(space); break;
    case 'pinwheel': effect = `[ ${['|', '/', '-', '\\'][tick % 4]} ] ${action}`.padEnd(space); break;
    default: effect = `[${'='.repeat(Math.max(1, Math.round(space * ((tick % 10) / 10))))}]`.padEnd(space); break;
  }
  return `${effect}  ${bold}${action}${reset}`;
}

function themedButton(label, action, paletteIndex) {
  const palette = themePalette();
  const active = Date.now() < actionUntil && lastAction === action;
  return `${color(palette[paletteIndex % palette.length])}${active ? bold + '<*>' : '< >'} ${label}${reset}`;
}

function renderSkinnedPlayer(width, height, middle, status, profile) {
  const panelWidth = Math.max(36, Math.min(70, width - 4));
  const compact = height < 20;
  const top = Math.max(1, middle - (compact ? 7 : 9));
  const visualWidth = Math.max(14, panelWidth - 12);
  const palette = themePalette();
  let output = `${ESC}?25l${ESC}2J${ESC}H`;
  output += centered(top, gradientRail(frame, panelWidth), width);
  output += centered(top + 1, `${color(palette[0])}${profile.ornament}${reset}  ${bold}:// ${profile.title}${reset}  ${color(palette[palette.length - 1])}${profile.ornament}${reset}`, width);
  output += centered(top + 2, `${dim}${profile.subtitle}${reset}`, width);
  output += centered(top + 4, themedVisualizer(profile, visualWidth), width);
  output += centered(top + 6, themedEvent(profile, visualWidth), width);
  output += centered(top + 8, `${themedButton('PREV', 'PREVIOUS TRACK', 0)}   ${themedButton('PLAY', 'PLAY / PAUSE', 2)}   ${themedButton('NEXT', 'NEXT TRACK', 4)}`, width);
  output += centered(top + 10, `${themedButton('VOL -', 'VOLUME DOWN', 1)}   ${themedButton('MUTE', 'MUTE TOGGLED', 3)}   ${themedButton('VOL +', 'VOLUME UP', 5)}`, width);
  output += centered(top + 12, `${color(palette[3 % palette.length])}o${reset} ${bold}${status}${reset}`, width);
  if (!compact) output += centered(top + 14, `${dim}SPACE play  ARROWS track/volume  M mute  Q return${reset}`, width);
  output += centered(top + (compact ? 14 : 16), gradientRail(frame + 12, panelWidth), width);
  process.stdout.write(output);
}

function macButton(label, action, paletteIndex) {
  const active = Date.now() < actionUntil && lastAction === action;
  return `${color(mediaPalette[paletteIndex])}${active ? bold + '[*]' : '[ ]'} ${label}${reset}`;
}

function renderMacintosh(width, height, middle, status) {
  const panelWidth = Math.max(38, Math.min(64, width - 4));
  const inside = panelWidth - 2;
  const top = Math.max(1, middle - 8);
  const row = (offset, content = '') => {
    const padding = ' '.repeat(Math.max(0, inside - visibleLength(content)));
    const edge = color(mediaPalette[(offset + 5) % mediaPalette.length]);
    return centered(top + offset, `${edge}|${reset}${content}${padding}${edge}|${reset}`, width);
  };
  const spinner = ['|', '/', '-', '\\'][Math.floor(frame / 2) % 4];
  let output = `${ESC}?25l${ESC}2J${ESC}H`;
  output += centered(top, gradientRail(frame, panelWidth), width);
  output += row(1, `${bold} [#]  :// HI-FI${reset}${dim}   File  Controls  Sound${reset}`);
  output += row(2, `${dim}${'-'.repeat(inside)}${reset}`);
  output += row(3, `       ${color(mediaPalette[6])}(( ${spinner} ))${reset}   ${bold}SYSTEM AUDIO${reset}`);
  output += row(4, `       ${dim}a small machine for loud feelings${reset}`);
  output += row(5, '');
  output += row(6, `   ${visualizer(frame, Math.max(12, inside - 8))}`);
  output += row(7, '');
  output += row(8, ` ${macButton('<<', 'PREVIOUS TRACK', 5)}  ${macButton('PLAY', 'PLAY / PAUSE', 3)}  ${macButton('>>', 'NEXT TRACK', 6)}`);
  output += row(9, ` ${macButton('VOL -', 'VOLUME DOWN', 1)}  ${macButton('MUTE', 'MUTE TOGGLED', 0)}  ${macButton('VOL +', 'VOLUME UP', 2)}`);
  output += row(10, `  ${themedEvent(playerProfiles.macintosh, Math.max(12, inside - 4))}`);
  output += row(11, `  ${color(mediaPalette[3])}o${reset} ${bold}${status}${reset}`);
  output += row(12, `  ${dim}SPACE play  ARROWS track/volume  M mute${reset}`);
  output += row(13, `  ${dim}Q / ESC / ENTER returns to ://${reset}`);
  output += centered(top + 14, gradientRail(frame + 14, panelWidth), width);
  process.stdout.write(output);
}

function render() {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const middle = Math.max(8, Math.floor(height / 2));
  const status = Date.now() < actionUntil ? lastAction : 'SYSTEM MEDIA READY';
  if (getSkin() === 'macintosh' && height >= 16) return renderMacintosh(width, height, middle, status);
  return renderSkinnedPlayer(width, height, middle, status, playerProfiles[getTheme()] || playerProfiles.rainbow);
  const panelWidth = Math.max(20, Math.min(72, width - 4));
  const orbit = ['◜', '◝', '◞', '◟'][Math.floor(frame / 3) % 4];
  const core = `${color(rgb.purple)}${orbit}${reset} ${color(rgb.pink)}◉${reset} ${color(rgb.purple)}${orbit}${reset}`;
  let output = `${ESC}?25l${ESC}2J${ESC}H`;
  if (height < 20) {
    output += centered(middle - 7, `${color(rgb.cyan)}${bold}:// MEDIA CONTROL DECK${reset}`, width);
    output += centered(middle - 6, gradientRail(frame, panelWidth), width);
    output += centered(middle - 4, visualizer(frame, panelWidth), width);
    output += centered(middle, `${button('◀◀', 'PREVIOUS TRACK')}  ${button('▶ / ❚❚', 'PLAY / PAUSE')}  ${button('▶▶', 'NEXT TRACK')}`, width);
    output += centered(middle + 2, `${button('VOL−', 'VOLUME DOWN')}  ${button('MUTE', 'MUTE TOGGLED')}  ${button('VOL+', 'VOLUME UP')}`, width);
    output += centered(middle + 4, `${color(rgb.green)}●${reset} ${bold}${status}${reset}`, width);
    output += centered(middle + 6, `${dim}Q / ESC / ENTER  RETURN${reset}`, width);
    output += centered(middle + 7, gradientRail(frame + 14, panelWidth), width);
    process.stdout.write(output);
    return;
  }
  output += centered(middle - 9, `${color(rgb.purple)}✦${reset}  ${color(rgb.cyan)}${bold}:// MEDIA CONTROL DECK${reset}  ${color(rgb.pink)}✦${reset}`, width);
  output += centered(middle - 8, gradientRail(frame, panelWidth), width);
  output += centered(middle - 6, `${core}   ${bold}WINDOWS SYSTEM AUDIO LINK${reset}   ${core}`, width);
  output += centered(middle - 5, `${dim}GLOBAL TRANSPORT  /  MEDIA KEY BRIDGE  /  ONLINE${reset}`, width);
  output += centered(middle - 3, visualizer(frame, panelWidth), width);
  output += centered(middle + 1, `${button('◀◀ PREV', 'PREVIOUS TRACK')}   ${button('▶ / ❚❚', 'PLAY / PAUSE')}   ${button('NEXT ▶▶', 'NEXT TRACK')}`, width);
  output += centered(middle + 3, `${button('VOL −', 'VOLUME DOWN')}   ${button('MUTE', 'MUTE TOGGLED')}   ${button('VOL +', 'VOLUME UP')}`, width);
  output += centered(middle + 5, `${color(rgb.green)}● LINKED${reset}  ${color(rgb.pink)}${bold}${status}${reset}`, width);
  output += centered(middle + 7, `${dim}SPACE PLAY/PAUSE  ·  ←/→ TRACK  ·  ↑/↓ VOLUME  ·  M MUTE${reset}`, width);
  output += centered(middle + 8, `${dim}Q / ESC / ENTER  RETURN TO ://${reset}`, width);
  output += centered(middle + 9, gradientRail(frame + 14, panelWidth), width);
  process.stdout.write(output);
}

function sendMediaKey(virtualKey, action) {
  if (!backend.stdin.destroyed) backend.stdin.write(`${virtualKey}\n`);
  lastAction = action;
  actionUntil = Date.now() + 1200;
  render();
}

function close(code = 0) {
  if (closing) return;
  closing = true;
  playSound('closing or quitting');
  clearInterval(timer);
  process.stdin.off('data', handleKey);
  process.stdout.off('resize', render);
  backend.stdin.end();
  process.stdout.write(`${reset}${ESC}?25h${ESC}2J${ESC}H`);
  process.exit(code);
}

function handleKey(data) {
  const key = data.toString('utf8');
  if (key === '\x03') return close(130);
  if (key === '\x1b' || key === 'q' || key === 'Q' || key === '\r' || key === '\n') return close();
  if (key === ' ') return sendMediaKey(0xB3, 'PLAY / PAUSE');
  if (key === '\x1b[D') return sendMediaKey(0xB1, 'PREVIOUS TRACK');
  if (key === '\x1b[C') return sendMediaKey(0xB0, 'NEXT TRACK');
  if (key === '\x1b[A') return sendMediaKey(0xAF, 'VOLUME UP');
  if (key === '\x1b[B') return sendMediaKey(0xAE, 'VOLUME DOWN');
  if (key === 'm' || key === 'M') return sendMediaKey(0xAD, 'MUTE TOGGLED');
}

backend.once('error', error => {
  lastAction = `MEDIA BACKEND ERROR: ${error.message}`;
  actionUntil = Number.POSITIVE_INFINITY;
  render();
});
backend.stdin.on('error', () => {});
backend.once('exit', code => {
  if (closing || code === 0) return;
  lastAction = 'MEDIA BACKEND UNAVAILABLE';
  actionUntil = Number.POSITIVE_INFINITY;
  render();
});

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', handleKey);
process.stdout.on('resize', render);
process.on('exit', () => process.stdout.write(`${reset}${ESC}?25h`));
const timer = setInterval(() => {
  frame++;
  render();
}, 70);
render();
