'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const soundDirectory = path.join(__dirname, '..', 'sound');

function readWave(name) {
  const buffer = fs.readFileSync(path.join(soundDirectory, `${name}.wav`));
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.readUInt16LE(20), 1);
  assert.equal(buffer.readUInt16LE(22), 1);
  assert.equal(buffer.readUInt32LE(24), 32000);
  assert.equal(buffer.readUInt16LE(34), 16);
  let peak = 0;
  for (let offset = 44; offset + 1 < buffer.length; offset += 2) {
    peak = Math.max(peak, Math.abs(buffer.readInt16LE(offset) / 32767));
  }
  return { buffer, peak, duration: (buffer.length - 44) / 2 / 32000 };
}

test('contains the complete semantic sound bank', () => {
  const required = [
    'opening or loading', 'closing or quitting', 'error', 'notification',
    'note_dissolve', 'success', 'cancel', 'command', 'chat_receive',
    'room_join', 'room_leave', 'toggle_on', 'toggle_off',
  ];
  for (let index = 1; index <= 8; index++) required.push(`type_${String(index).padStart(2, '0')}`);
  for (let index = 1; index <= 3; index++) required.push(`navigate_${String(index).padStart(2, '0')}`);
  for (let index = 1; index <= 2; index++) required.push(`select_${String(index).padStart(2, '0')}`);
  for (let index = 1; index <= 2; index++) required.push(`confirm_${String(index).padStart(2, '0')}`);
  for (let index = 1; index <= 3; index++) required.push(`chat_send_${String(index).padStart(2, '0')}`);
  for (const name of required) assert.ok(fs.existsSync(path.join(soundDirectory, `${name}.wav`)), name);
});
test('all cues are short, quiet PCM WAV files', () => {
  const waveFiles = fs.readdirSync(soundDirectory).filter(file => file.endsWith('.wav'));
  assert.equal(waveFiles.length, 31);
  for (const file of waveFiles) {
    const sound = readWave(path.basename(file, '.wav'));
    assert.ok(sound.duration >= 0.05 && sound.duration <= 0.7, `${file} duration ${sound.duration}`);
    assert.ok(sound.peak > 0.08 && sound.peak <= 0.25, `${file} peak ${sound.peak}`);
  }
});
