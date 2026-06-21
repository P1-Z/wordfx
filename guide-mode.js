#!/usr/bin/env node

'use strict';

const { ansi, renderThemeRail } = require('./theme');
const { playSound, warmSoundSystem } = require('./sound');

const ESC = '\x1b[';
const { reset, bold, dim, cyan, purple, pink, green, white, yellow } = ansi;

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('The animation guide needs an interactive terminal.');
  process.exit(1);
}
void warmSoundSystem();

function visibleLength(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').length;
}

function clip(text, width) {
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  return plain.length <= width ? text : `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function pad(text, width) {
  const fitted = clip(text, width);
  return `${fitted}${' '.repeat(Math.max(0, width - visibleLength(fitted)))}`;
}

function row(text, width, color = purple) {
  return `${color}│${reset} ${pad(text, width - 4)} ${color}│${reset}`;
}

function rule(width, left = '├', right = '┤', color = purple) {
  return `${color}${left}${'─'.repeat(Math.max(0, width - 2))}${right}${reset}`;
}

function momentumBar(frame, width) {
  const track = Math.max(10, width - 20);
  const position = Math.round(((Math.sin(frame * 0.08 - Math.PI / 2) + 1) / 2) * (track - 1));
  return `${dim}START ${reset}${renderThemeRail(position, frame)}${yellow}◆${renderThemeRail(track - position - 1, frame + position)}${dim} SETTLE${reset}`;
}

function render(frame = 0) {
  const terminalWidth = process.stdout.columns || 80;
  const terminalHeight = process.stdout.rows || 30;
  const width = Math.max(24, Math.min(92, terminalWidth - 2));
  const lines = [];

  lines.push(rule(width, '╭', '╮'));
  lines.push(row(`${bold}${white}ANIMATION MOMENTUM GUIDE${reset}  ${dim}// movement with intent${reset}`, width));
  lines.push(rule(width));
  lines.push(row(momentumBar(frame, width), width));
  lines.push(rule(width));
  lines.push(row(`${yellow}01  DEFINE THE FORCE${reset}`, width));
  lines.push(row(`${white}What starts the motion?${reset}  Push, pull, impact, gravity, or intent.`, width));
  lines.push(row(`${dim}A clear force gives every acceleration and reaction a reason.${reset}`, width));
  lines.push(rule(width));
  lines.push(row(`${yellow}02  BUILD THE MOTION${reset}`, width));
  lines.push(row(`${cyan}ANTICIPATE${reset}  load opposite the travel direction; keep it brief and readable.`, width));
  lines.push(row(`${cyan}ACCELERATE${reset}  spacing grows as energy enters the movement.`, width));
  lines.push(row(`${cyan}PEAK${reset}        fastest point; protect the silhouette and main action.`, width));
  lines.push(row(`${cyan}DECELERATE${reset}  spacing tightens before the target, never stops mechanically.`, width));
  lines.push(row(`${cyan}SETTLE${reset}      overshoot, recover, then let secondary parts arrive last.`, width));
  lines.push(rule(width));
  lines.push(row(`${yellow}03  PRESERVE MOMENTUM${reset}`, width));
  lines.push(row(`${green}ARCS${reset}          favor curved paths unless the force is deliberately mechanical.`, width));
  lines.push(row(`${green}OVERLAP${reset}       hips → chest → head → hands; offset connected parts.`, width));
  lines.push(row(`${green}WEIGHT${reset}        heavier objects take longer to start and longer to settle.`, width));
  lines.push(row(`${green}DIRECTION${reset}     carry energy through turns; avoid unexplained reversals.`, width));
  lines.push(rule(width));
  lines.push(row(`${yellow}04  QUICK PASS${reset}`, width));
  lines.push(row(`${pink}POSE${reset} key storytelling shapes  →  ${pink}TIME${reset} the beats  →  ${pink}SPACE${reset} the motion`, width));
  lines.push(row(`${pink}OFFSET${reset} secondary parts  →  ${pink}POLISH${reset} arcs, settles, and tiny holds`, width));
  lines.push(rule(width));
  lines.push(row(`${bold}${white}CHECK:${reset} Can you feel the force? Read the path? Predict where energy goes next?`, width));
  lines.push(row(`${dim}ESC / Q / ENTER  return to ://${reset}`, width));
  lines.push(rule(width, '╰', '╯'));

  const visible = lines.slice(0, Math.max(1, terminalHeight - 2));
  const top = Math.max(1, Math.floor((terminalHeight - visible.length) / 2) + 1);
  const left = Math.max(1, Math.floor((terminalWidth - width) / 2) + 1);
  let output = `${ESC}?25l${ESC}2J${ESC}H`;
  for (let index = 0; index < visible.length; index++) {
    output += `${ESC}${top + index};${left}H${visible[index]}`;
  }
  process.stdout.write(output);
}

let frame = 0;
let closing = false;
const timer = setInterval(() => render(frame++), 50);

function close() {
  if (closing) return;
  closing = true;
  playSound('closing or quitting');
  clearInterval(timer);
  process.stdout.off('resize', handleResize);
  process.stdin.off('data', handleKey);
  process.stdout.write(`${reset}${ESC}?25h${ESC}2J${ESC}H`);
  process.exit(0);
}

function handleKey(data) {
  const key = data.toString('utf8').toLowerCase();
  if (key === '\x03' || key === '\x1b' || key === 'q' || key === '\r' || key === '\n') close();
}

function handleResize() {
  render(frame);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', handleKey);
process.stdout.on('resize', handleResize);
process.on('exit', () => process.stdout.write(`${reset}${ESC}?25h`));
render(frame++);
