#!/usr/bin/env node

'use strict';

const os = require('node:os');
const { playSound, warmSoundSystem } = require('./sound');

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('System monitor needs an interactive terminal.');
  process.exit(1);
}
void warmSoundSystem(0);

const cyan = '\x1b[36m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const reset = '\x1b[0m';
let previousCpu = cpuTimes();
let closed = false;
let timer;

function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((value, time) => value + time, 0);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function duration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
}

function bar(percent, width) {
  const filled = Math.round(Math.max(0, Math.min(100, percent)) / 100 * width);
  return `${green}${'█'.repeat(filled)}${dim}${'░'.repeat(width - filled)}${reset}`;
}

function render() {
  const currentCpu = cpuTimes();
  const elapsed = currentCpu.total - previousCpu.total;
  const cpuPercent = elapsed > 0
    ? (1 - (currentCpu.idle - previousCpu.idle) / elapsed) * 100
    : 0;
  previousCpu = currentCpu;

  const totalMemory = os.totalmem();
  const usedMemory = totalMemory - os.freemem();
  const memoryPercent = usedMemory / totalMemory * 100;
  const width = Math.max(20, Math.min(56, (process.stdout.columns || 80) - 24));
  const load = os.loadavg().map(value => value.toFixed(2)).join(' / ');

  process.stdout.write('\x1b[2J\x1b[H');
  console.log(`${bold}${cyan}:// LIVE SYSTEM MONITOR${reset}  ${green}● ONLINE${reset}`);
  console.log(`${dim}${os.hostname()} · ${os.type()} ${os.release()} · refresh 1s${reset}\n`);
  console.log(`${yellow}CPU${reset}     ${bar(cpuPercent, width)} ${cpuPercent.toFixed(1).padStart(5)}%`);
  console.log(`${yellow}MEMORY${reset}  ${bar(memoryPercent, width)} ${memoryPercent.toFixed(1).padStart(5)}%`);
  console.log(`\n${cyan}Memory${reset}   ${formatBytes(usedMemory)} / ${formatBytes(totalMemory)}`);
  console.log(`${cyan}Load avg${reset} ${load}`);
  console.log(`${cyan}Cores${reset}    ${os.cpus().length}`);
  console.log(`${cyan}Uptime${reset}   ${duration(os.uptime())}`);
  console.log(`\n${dim}Press Q, Escape, or Enter to return.${reset}`);
}

function close(code = 0) {
  if (closed) return;
  closed = true;
  playSound('closing or quitting');
  clearInterval(timer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`\x1b[?25h${reset}`);
  process.exit(code);
}

function onInput(data) {
  const key = data.toString();
  if (key === '\u0003') return close(130);
  if (key === '\u001b' || key === '\r' || key === '\n' || key.toLowerCase() === 'q') close();
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', onInput);
process.stdout.write('\x1b[?25l');
render();
timer = setInterval(render, 1000);
process.stdout.on('resize', render);
