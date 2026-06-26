#!/usr/bin/env node

'use strict';

const { playSound, warmSoundSystem } = require('./sound');

const ESC = '\x1b[';
const reset = '\x1b[0m';
const bold = '\x1b[1m';
const dim = '\x1b[2m';
const white = '\x1b[38;2;235;235;242m';
const yellow = '\x1b[38;2;250;205;70m';
const pink = '\x1b[38;2;255;105;180m';
const cyan = '\x1b[38;2;100;205;220m';
const MARBURG = { latitude: 50.807, longitude: 8.7708 };
const ROSH_HAAYIN = { latitude: 32.0956, longitude: 34.9566 };

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('The love animation needs an interactive terminal.');
  process.exit(1);
}
void warmSoundSystem(0);

function relationshipAge(now = new Date()) {
  const start = new Date(2023, 10, 12);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let years = today.getFullYear() - start.getFullYear();
  let cursor = new Date(start.getFullYear() + years, start.getMonth(), start.getDate());
  if (cursor > today) {
    years--;
    cursor = new Date(start.getFullYear() + years, start.getMonth(), start.getDate());
  }

  let months = 0;
  while (months < 11) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate());
    if (next > today) break;
    cursor = next;
    months++;
  }
  const days = Math.floor((today - cursor) / 86400000);
  return { years, months, days };
}

function distanceInKilometers(from, to) {
  const radians = degrees => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude))
    * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(value)));
}

const DISTANCE_KM = distanceInKilometers(MARBURG, ROSH_HAAYIN);

function visibleLength(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').length;
}

function centered(row, text, width) {
  const column = Math.max(1, Math.floor((width - visibleLength(text)) / 2) + 1);
  return `${ESC}${row};${column}H${text}`;
}

function blendColor(from, to, amount) {
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount));
}

function shimmerText(text, frame, from = [255, 105, 180], to = [255, 225, 120]) {
  return Array.from(text, (character, index) => {
    const position = ((index * 0.32 - frame * 0.11) % 2 + 2) % 2;
    const amount = position <= 1 ? position : 2 - position;
    const smooth = amount * amount * (3 - 2 * amount);
    const [red, green, blue] = blendColor(from, to, smooth);
    return `\x1b[1;38;2;${red};${green};${blue}m${character}`;
  }).join('') + reset;
}

function twinkles(frame) {
  const patterns = ['✦  ♡  ✧', '✧  ♥  ·', '·  ♡  ✦', '✧  ♥  ✦'];
  return `${pink}${patterns[Math.floor(frame / 4) % patterns.length]}${reset}`;
}

function render(frame) {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const middle = Math.max(6, Math.floor(height / 2));
  const age = relationshipAge();
  const pulse = (Math.sin(frame * 0.12) + 1) / 2;
  const gap = 3 + Math.round(pulse * 4);
  const square = `${yellow}${bold}■${reset}`;
  const circle = `${pink}${bold}●${reset}`;
  const heart = `${pink}${bold}${pulse > 0.5 ? '♥' : '♡'}${reset}`;
  const icons = `${square}${' '.repeat(gap)}${heart}${' '.repeat(gap)}${circle}`;
  const counter = [
    `${yellow}${bold}${String(age.years).padStart(2, '0')}${reset} ${dim}YEARS${reset}`,
    `${pink}${bold}${String(age.months).padStart(2, '0')}${reset} ${dim}MONTHS${reset}`,
    `${white}${bold}${String(age.days).padStart(2, '0')}${reset} ${dim}DAYS${reset}`,
  ].join(`  ${dim}·${reset}  `);

  let output = `${ESC}?25l${ESC}2J${ESC}H`;
  output += centered(middle - 7, `${twinkles(frame)}  ${shimmerText('NOVEMBER 12, 2023', frame * 0.55, [235, 235, 242], [255, 170, 205])}  ${twinkles(frame + 7)}`, width);
  output += centered(middle - 4, icons, width);
  output += centered(middle - 1, counter, width);
  output += centered(middle + 1, `${shimmerText(`≈ ${DISTANCE_KM.toLocaleString('en-US')} KM APART`, frame * 0.65, [100, 205, 220], [255, 170, 205])}  ${dim}MARBURG ↔ ROSH HA'AYIN${reset}`, width);
  output += centered(middle + 3, `${twinkles(frame + 3)}  ${shimmerText('I LOVE YOU', frame)}  ${twinkles(frame + 11)}`, width);
  output += centered(middle + 5, shimmerText('NO DISTANCE WILL SPLIT US', frame * 0.82, [255, 75, 170], [255, 225, 120]), width);
  output += centered(middle + 7, `${dim}SALLY + ERIK  ·  Q / ESC / ENTER TO RETURN${reset}`, width);
  process.stdout.write(output);
}

let frame = 0;
let closing = false;
const timer = setInterval(() => render(frame++), 70);

function close(code = 0) {
  if (closing) return;
  closing = true;
  playSound('closing or quitting');
  clearInterval(timer);
  process.stdout.off('resize', handleResize);
  process.stdin.off('data', handleKey);
  process.stdout.write(`${reset}${ESC}?25h${ESC}2J${ESC}H`);
  process.exit(code);
}

function handleKey(data) {
  const key = data.toString('utf8').toLowerCase();
  if (key === '\x03') return close(130);
  if (key === '\x1b' || key === 'q' || key === '\r' || key === '\n') close();
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
