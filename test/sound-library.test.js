'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { _testing: soundTesting } = require('../sound');

const soundDirectory = path.join(__dirname, '..', 'sound');

function readWave(name) {
  const buffer = fs.readFileSync(path.join(soundDirectory, `${name}.wav`));
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.readUInt16LE(20), 1);
  assert.equal(buffer.readUInt16LE(22), 1);
  assert.equal(buffer.readUInt32LE(24), 44100);
  assert.equal(buffer.readUInt16LE(34), 16);
  let peak = 0;
  let maximumJump = 0;
  let previous = 0;
  for (let offset = 44; offset + 1 < buffer.length; offset += 2) {
    const value = buffer.readInt16LE(offset) / 32767;
    peak = Math.max(peak, Math.abs(value));
    maximumJump = Math.max(maximumJump, Math.abs(value - previous));
    previous = value;
  }
  return { buffer, peak, maximumJump, duration: (buffer.length - 44) / 2 / 44100 };
}

test('contains the complete semantic sound bank', () => {
  const required = [
    'opening or loading', 'closing or quitting', 'error', 'notification',
    'note_dissolve', 'success', 'cancel', 'command', 'chat_receive',
    'room_join', 'room_leave', 'toggle_on', 'toggle_off',
  ];
  for (let index = 1; index <= 12; index++) required.push(`type_${String(index).padStart(2, '0')}`);
  for (const [family, count] of [['type_space', 4], ['type_backspace', 4], ['type_return', 3]]) {
    for (let index = 1; index <= count; index++) required.push(`${family}_${String(index).padStart(2, '0')}`);
  }
  for (let index = 1; index <= 5; index++) required.push(`navigate_${String(index).padStart(2, '0')}`);
  for (let index = 1; index <= 4; index++) required.push(`select_${String(index).padStart(2, '0')}`);
  for (let index = 1; index <= 4; index++) required.push(`confirm_${String(index).padStart(2, '0')}`);
  for (let index = 1; index <= 5; index++) required.push(`chat_send_${String(index).padStart(2, '0')}`);
  for (const name of required) assert.ok(fs.existsSync(path.join(soundDirectory, `${name}.wav`)), name);
});
test('all cues are short, quiet PCM WAV files', () => {
  const waveFiles = fs.readdirSync(soundDirectory).filter(file => file.endsWith('.wav'));
  assert.equal(waveFiles.length, 54);
  for (const file of waveFiles) {
    const sound = readWave(path.basename(file, '.wav'));
    assert.ok(sound.duration >= 0.05 && sound.duration <= 0.7, `${file} duration ${sound.duration}`);
    assert.ok(sound.peak > 0.08 && sound.peak <= 0.25, `${file} peak ${sound.peak}`);
    assert.ok(sound.maximumJump <= 0.05, `${file} discontinuity ${sound.maximumJump}`);
  }
});

test('variant selection is random without replaying either recent sample', () => {
  const history = new Map();
  const draws = [0.01, 0.82, 0.25, 0.67, 0.44, 0.95, 0.12, 0.58];
  const selected = draws.map(draw => soundTesting.pickVariantIndex('typing', 5, () => draw, history));
  for (let index = 2; index < selected.length; index++) {
    assert.notEqual(selected[index], selected[index - 1]);
    assert.notEqual(selected[index], selected[index - 2]);
  }
  assert.ok(new Set(selected).size > 3);
});

test('a two-sample bank does not become forced round-robin', () => {
  const history = new Map();
  assert.equal(soundTesting.pickVariantIndex('small', 2, () => 0, history), 1);
  assert.equal(soundTesting.pickVariantIndex('small', 2, () => 0, history), 1);
});
