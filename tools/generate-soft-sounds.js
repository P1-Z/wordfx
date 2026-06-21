#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 44100;
const TAU = Math.PI * 2;
const outputDirectory = path.join(__dirname, '..', 'sound');
let randomState = 0x51a55eed;

function random() {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0xffffffff;
}

function samples(seconds) {
  return new Float64Array(Math.max(1, Math.round(seconds * SAMPLE_RATE)));
}

function envelope(time, duration, attack = 0.006, releasePower = 2.2) {
  const fadeIn = Math.sin(Math.min(1, time / attack) * Math.PI / 2);
  const fadeOut = Math.max(0, 1 - time / duration) ** releasePower;
  return fadeIn * fadeOut;
}

function addTone(buffer, options) {
  const {
    frequency,
    endFrequency = frequency,
    start = 0,
    duration = buffer.length / SAMPLE_RATE - start,
    volume = 1,
    attack = 0.006,
    releasePower = 2.2,
    warmth = 0.16,
    phaseOffset = 0,
  } = options;
  const startIndex = Math.max(0, Math.round(start * SAMPLE_RATE));
  const endIndex = Math.min(buffer.length, startIndex + Math.round(duration * SAMPLE_RATE));
  let phase = phaseOffset;
  for (let index = startIndex; index < endIndex; index++) {
    const time = (index - startIndex) / SAMPLE_RATE;
    const progress = time / Math.max(duration, 0.001);
    const currentFrequency = frequency * ((endFrequency / frequency) ** progress);
    phase += TAU * currentFrequency / SAMPLE_RATE;
    const body = Math.sin(phase) + warmth * Math.sin(phase * 2 + 0.3) + warmth * 0.32 * Math.sin(phase * 3 + 0.8);
    buffer[index] += body * envelope(time, duration, attack, releasePower) * volume;
  }
}

function addSoftNoise(buffer, options = {}) {
  const {
    start = 0,
    duration = buffer.length / SAMPLE_RATE - start,
    volume = 0.1,
    smoothing = 0.82,
    attack = 0.002,
    releasePower = 2.8,
  } = options;
  const startIndex = Math.max(0, Math.round(start * SAMPLE_RATE));
  const endIndex = Math.min(buffer.length, startIndex + Math.round(duration * SAMPLE_RATE));
  let filtered = 0;
  for (let index = startIndex; index < endIndex; index++) {
    const time = (index - startIndex) / SAMPLE_RATE;
    filtered = filtered * smoothing + (random() * 2 - 1) * (1 - smoothing);
    buffer[index] += filtered * envelope(time, duration, attack, releasePower) * volume;
  }
}

function addFeltTap(buffer, options = {}) {
  const {
    start = 0,
    pitch = 185,
    volume = 0.55,
    duration = 0.075,
  } = options;
  addSoftNoise(buffer, { start, duration: duration * 0.55, volume: volume * 0.52, smoothing: 0.72, releasePower: 4 });
  addTone(buffer, {
    frequency: pitch * 1.08,
    endFrequency: pitch,
    start,
    duration,
    volume,
    attack: 0.0015,
    releasePower: 3.7,
    warmth: 0.27,
  });
}

function addChime(buffer, frequency, start, duration, volume = 0.45) {
  addTone(buffer, { frequency, start, duration, volume, attack: 0.012, releasePower: 2.7, warmth: 0.11 });
  addTone(buffer, { frequency: frequency * 2.01, start, duration: duration * 0.72, volume: volume * 0.19, attack: 0.008, releasePower: 3.2, warmth: 0.03 });
  addTone(buffer, { frequency: frequency * 3.98, start, duration: duration * 0.45, volume: volume * 0.055, attack: 0.004, releasePower: 3.5, warmth: 0 });
}

function addBubble(buffer, options = {}) {
  const {
    start = 0,
    frequency = 220,
    duration = 0.12,
    volume = 0.16,
  } = options;
  addTone(buffer, {
    frequency,
    endFrequency: frequency * 1.72,
    start,
    duration,
    volume,
    attack: 0.006,
    releasePower: 3.1,
    warmth: 0.055,
  });
  addTone(buffer, {
    frequency: frequency * 0.51,
    endFrequency: frequency * 0.76,
    start,
    duration: duration * 0.82,
    volume: volume * 0.24,
    attack: 0.008,
    releasePower: 3.5,
    warmth: 0,
  });
}

function addTapeTexture(buffer, volume = 0.018) {
  let filtered = 0;
  for (let index = 0; index < buffer.length; index++) {
    filtered = filtered * 0.94 + (random() * 2 - 1) * 0.06;
    const slowWobble = 0.72 + Math.sin(index / SAMPLE_RATE * TAU * 0.63) * 0.18;
    buffer[index] += filtered * volume * slowWobble;
  }
}

function normalize(buffer, targetPeak = 0.28) {
  let mean = 0;
  for (const value of buffer) mean += value;
  mean /= buffer.length;
  let peak = 0;
  for (let index = 0; index < buffer.length; index++) {
    buffer[index] = Math.tanh((buffer[index] - mean) * 1.18);
    peak = Math.max(peak, Math.abs(buffer[index]));
  }
  const gain = peak ? targetPeak / peak : 0;
  const edgeSamples = Math.min(Math.round(SAMPLE_RATE * 0.004), Math.floor(buffer.length / 2));
  for (let index = 0; index < buffer.length; index++) {
    const edgeFade = Math.min(1, index / Math.max(1, edgeSamples), (buffer.length - 1 - index) / Math.max(1, edgeSamples));
    buffer[index] *= gain * Math.max(0, edgeFade);
  }
  return buffer;
}

function writeWave(name, buffer, targetPeak) {
  normalize(buffer, targetPeak);
  const dataSize = buffer.length * 2;
  const output = Buffer.alloc(44 + dataSize);
  output.write('RIFF', 0);
  output.writeUInt32LE(36 + dataSize, 4);
  output.write('WAVE', 8);
  output.write('fmt ', 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < buffer.length; index++) {
    const value = Math.max(-1, Math.min(1, buffer[index]));
    output.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  fs.writeFileSync(path.join(outputDirectory, `${name}.wav`), output);
}

function typingSound(variant) {
  const buffer = samples(0.052 + variant * 0.0015);
  addFeltTap(buffer, { pitch: 168 + variant * 5, volume: 0.62, duration: 0.047 + variant * 0.001 });
  addSoftNoise(buffer, { start: 0.004, duration: 0.025, volume: 0.08, smoothing: 0.9, releasePower: 3.8 });
  return buffer;
}

function navigationSound(variant) {
  const buffer = samples(0.07);
  addFeltTap(buffer, { pitch: 235 + variant * 24, volume: 0.38, duration: 0.058 });
  return buffer;
}

function selectionSound(variant) {
  const buffer = samples(0.12);
  addFeltTap(buffer, { pitch: 210 + variant * 35, volume: 0.5, duration: 0.085 });
  addTone(buffer, { frequency: 390 + variant * 38, start: 0.013, duration: 0.09, volume: 0.18, attack: 0.004, releasePower: 3.3 });
  return buffer;
}

function confirmationSound(variant) {
  const buffer = samples(0.28);
  addFeltTap(buffer, { pitch: 190 + variant * 12, volume: 0.3, duration: 0.07 });
  addChime(buffer, variant ? 440 : 392, 0.018, 0.21, 0.34);
  addChime(buffer, variant ? 554.37 : 493.88, 0.075, 0.19, 0.27);
  return buffer;
}

function chatSendSound(variant) {
  const buffer = samples(0.19);
  addFeltTap(buffer, { pitch: 175 + variant * 11, volume: 0.42, duration: 0.072 });
  addTone(buffer, { frequency: 330 + variant * 14, endFrequency: 465 + variant * 18, start: 0.018, duration: 0.145, volume: 0.27, attack: 0.006, releasePower: 3.1 });
  return buffer;
}

const sounds = [];
for (let variant = 1; variant <= 8; variant++) sounds.push([`type_${String(variant).padStart(2, '0')}`, typingSound(variant), 0.16]);
for (let variant = 1; variant <= 3; variant++) sounds.push([`navigate_${String(variant).padStart(2, '0')}`, navigationSound(variant), 0.14]);
for (let variant = 1; variant <= 2; variant++) sounds.push([`select_${String(variant).padStart(2, '0')}`, selectionSound(variant), 0.2]);
for (let variant = 1; variant <= 2; variant++) sounds.push([`confirm_${String(variant).padStart(2, '0')}`, confirmationSound(variant), 0.22]);
for (let variant = 1; variant <= 3; variant++) sounds.push([`chat_send_${String(variant).padStart(2, '0')}`, chatSendSound(variant), 0.2]);

{
  const buffer = samples(0.62);
  addChime(buffer, 220, 0, 0.52, 0.3);
  addChime(buffer, 277.18, 0.07, 0.48, 0.24);
  addChime(buffer, 329.63, 0.15, 0.4, 0.2);
  sounds.push(['opening or loading', buffer, 0.24]);
}
{
  const buffer = samples(0.5);
  addChime(buffer, 329.63, 0, 0.38, 0.24);
  addChime(buffer, 261.63, 0.07, 0.36, 0.22);
  addChime(buffer, 196, 0.14, 0.31, 0.18);
  sounds.push(['closing or quitting', buffer, 0.22]);
}
{
  const buffer = samples(0.3);
  addFeltTap(buffer, { pitch: 105, volume: 0.58, duration: 0.13 });
  addTone(buffer, { frequency: 155, endFrequency: 118, start: 0.035, duration: 0.23, volume: 0.38, attack: 0.006, releasePower: 2.8, warmth: 0.3 });
  sounds.push(['error', buffer, 0.24]);
}
{
  const buffer = samples(0.48);
  addTapeTexture(buffer, 0.006);
  addChime(buffer, 392, 0, 0.36, 0.33);
  addChime(buffer, 523.25, 0.105, 0.32, 0.28);
  sounds.push(['notification', buffer, 0.23]);
}
{
  const buffer = samples(0.7);
  const pitches = [185, 232, 204, 286, 248, 342, 278, 405, 326, 468, 386];
  const spacing = [0, 0.052, 0.108, 0.158, 0.224, 0.281, 0.344, 0.401, 0.477, 0.536, 0.59];
  for (let bubble = 0; bubble < pitches.length; bubble++) {
    addBubble(buffer, {
      start: 0.012 + spacing[bubble],
      frequency: pitches[bubble],
      duration: Math.max(0.075, 0.13 - bubble * 0.0045),
      volume: 0.13 + (bubble % 3) * 0.012,
    });
  }
  // Keep later assets byte-stable when this cue's synthesis changes. The
  // previous dissolve consumed this many deterministic noise samples.
  for (let skippedNoiseSample = 0; skippedNoiseSample < 74976; skippedNoiseSample++) random();
  sounds.push(['note_dissolve', buffer, 0.2]);
}
{
  const buffer = samples(0.34);
  addFeltTap(buffer, { pitch: 180, volume: 0.25, duration: 0.06 });
  addChime(buffer, 349.23, 0.02, 0.27, 0.28);
  addChime(buffer, 440, 0.075, 0.22, 0.21);
  sounds.push(['success', buffer, 0.21]);
}
{
  const buffer = samples(0.17);
  addFeltTap(buffer, { pitch: 150, volume: 0.45, duration: 0.08 });
  addTone(buffer, { frequency: 310, endFrequency: 240, start: 0.018, duration: 0.12, volume: 0.2, attack: 0.003, releasePower: 3.1 });
  sounds.push(['cancel', buffer, 0.18]);
}
{
  const buffer = samples(0.16);
  addFeltTap(buffer, { pitch: 205, volume: 0.46, duration: 0.075 });
  addSoftNoise(buffer, { start: 0.014, duration: 0.1, volume: 0.09, smoothing: 0.9, releasePower: 3 });
  sounds.push(['command', buffer, 0.18]);
}
{
  const buffer = samples(0.25);
  addFeltTap(buffer, { pitch: 185, volume: 0.25, duration: 0.07 });
  addChime(buffer, 415.3, 0.028, 0.18, 0.24);
  sounds.push(['chat_receive', buffer, 0.19]);
}
{
  const buffer = samples(0.4);
  addChime(buffer, 293.66, 0, 0.32, 0.28);
  addChime(buffer, 440, 0.085, 0.28, 0.24);
  addFeltTap(buffer, { start: 0.015, pitch: 170, volume: 0.18, duration: 0.07 });
  sounds.push(['room_join', buffer, 0.21]);
}
{
  const buffer = samples(0.34);
  addChime(buffer, 349.23, 0, 0.26, 0.24);
  addChime(buffer, 233.08, 0.075, 0.23, 0.21);
  sounds.push(['room_leave', buffer, 0.19]);
}
{
  const buffer = samples(0.13);
  addSoftNoise(buffer, { duration: 0.09, volume: 0.18, smoothing: 0.9, releasePower: 3.8 });
  addTone(buffer, { frequency: 260, endFrequency: 390, duration: 0.1, volume: 0.24, attack: 0.002, releasePower: 3.6 });
  sounds.push(['toggle_on', buffer, 0.17]);
}
{
  const buffer = samples(0.13);
  addSoftNoise(buffer, { duration: 0.09, volume: 0.18, smoothing: 0.9, releasePower: 3.8 });
  addTone(buffer, { frequency: 350, endFrequency: 220, duration: 0.1, volume: 0.24, attack: 0.002, releasePower: 3.6 });
  sounds.push(['toggle_off', buffer, 0.17]);
}

fs.mkdirSync(outputDirectory, { recursive: true });
for (const file of fs.readdirSync(outputDirectory)) {
  if (file.toLowerCase().endsWith('.wav')) fs.rmSync(path.join(outputDirectory, file));
}
for (const [name, buffer, targetPeak] of sounds) writeWave(name, buffer, targetPeak);
console.log(`Generated ${sounds.length} soft UI sounds in ${outputDirectory}`);
