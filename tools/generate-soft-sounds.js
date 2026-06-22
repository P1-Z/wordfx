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
    wow = 0,
    flutter = 0,
  } = options;
  const startIndex = Math.max(0, Math.round(start * SAMPLE_RATE));
  const endIndex = Math.min(buffer.length, startIndex + Math.round(duration * SAMPLE_RATE));
  let phase = phaseOffset;
  for (let index = startIndex; index < endIndex; index++) {
    const time = (index - startIndex) / SAMPLE_RATE;
    const progress = time / Math.max(duration, 0.001);
    const drift = 1
      + Math.sin(time * TAU * 1.17 + phaseOffset) * wow
      + Math.sin(time * TAU * 7.9 + phaseOffset * 1.7) * flutter;
    const currentFrequency = frequency * ((endFrequency / frequency) ** progress) * drift;
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
  // Tactile noise burst -- sharper, grittier transient
  addSoftNoise(buffer, { start, duration: duration * 0.48, volume: volume * 0.68, smoothing: 0.62, releasePower: 4.5 });
  // Main body tone with warmth and drift
  addTone(buffer, {
    frequency: pitch * 1.08,
    endFrequency: pitch,
    start,
    duration,
    volume,
    attack: 0.001,
    releasePower: 3.4,
    warmth: 0.36,
    wow: 0.005,
    flutter: 0.002,
  });
  // Sub-bass thump for physical weight
  addTone(buffer, {
    frequency: pitch * 0.48,
    endFrequency: pitch * 0.38,
    start: start + 0.001,
    duration: duration * 0.88,
    volume: volume * 0.28,
    attack: 0.001,
    releasePower: 4.0,
    warmth: 0.42,
    wow: 0.006,
  });
  // High click transient for snap
  addSoftNoise(buffer, { start, duration: 0.004, volume: volume * 0.35, smoothing: 0.35, releasePower: 6 });
}

function addChime(buffer, frequency, start, duration, volume = 0.45) {
  addTone(buffer, { frequency, start, duration, volume, attack: 0.01, releasePower: 2.5, warmth: 0.2, wow: 0.006, flutter: 0.002 });
  addTone(buffer, { frequency: frequency * 2.01, start, duration: duration * 0.68, volume: volume * 0.22, attack: 0.007, releasePower: 3.0, warmth: 0.08, wow: 0.005 });
  addTone(buffer, { frequency: frequency * 3.98, start, duration: duration * 0.38, volume: volume * 0.04, attack: 0.004, releasePower: 3.5, warmth: 0 });
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
  let dust = 0;
  let hiss = 0;
  for (let index = 0; index < buffer.length; index++) {
    filtered = filtered * 0.92 + (random() * 2 - 1) * 0.08;
    hiss = hiss * 0.65 + (random() * 2 - 1) * 0.35;
    if (random() > 0.99972) dust = (random() * 2 - 1) * 0.45;
    dust *= 0.68;
    const slowWobble = 0.68 + Math.sin(index / SAMPLE_RATE * TAU * 0.51) * 0.22;
    buffer[index] += (filtered * slowWobble + hiss * 0.12 + dust) * volume;
  }
}

function normalize(buffer, targetPeak = 0.28) {
  let mean = 0;
  for (const value of buffer) mean += value;
  mean /= buffer.length;
  let peak = 0;
  for (let index = 0; index < buffer.length; index++) {
    buffer[index] = Math.tanh((buffer[index] - mean) * 1.55);
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

// Simple one-pole low-pass for lo-fi tape warmth. Rolls off highs gently.
function lofiFilter(buffer, cutoff = 0.42) {
  const alpha = cutoff;
  let previous = 0;
  for (let index = 0; index < buffer.length; index++) {
    previous = previous + alpha * (buffer[index] - previous);
    buffer[index] = previous;
  }
}

function writeWave(name, buffer, targetPeak) {
  addTapeTexture(buffer, name.startsWith('type_') ? 0.018 : 0.013);
  lofiFilter(buffer, name.startsWith('type_') ? 0.52 : 0.44);
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
  const profiles = [
    [176, 0.054, 0.58], [164, 0.059, 0.61], [189, 0.052, 0.55],
    [171, 0.064, 0.59], [198, 0.049, 0.54], [181, 0.057, 0.6],
    [158, 0.066, 0.62], [193, 0.055, 0.56], [168, 0.061, 0.6],
    [185, 0.05, 0.57], [174, 0.056, 0.61], [201, 0.053, 0.54],
  ];
  const [pitch, duration, volume] = profiles[variant - 1];
  const buffer = samples(duration + 0.016);
  addFeltTap(buffer, { pitch, volume, duration });
  addSoftNoise(buffer, { start: 0.002, duration: duration * 0.6, volume: 0.14, smoothing: 0.78, releasePower: 3.8 });
  return buffer;
}

function spaceSound(variant) {
  const profiles = [[126, 0.088], [118, 0.097], [134, 0.083], [122, 0.092]];
  const [pitch, duration] = profiles[variant - 1];
  const buffer = samples(duration + 0.022);
  addFeltTap(buffer, { pitch, volume: 0.58, duration });
  addSoftNoise(buffer, { start: 0.003, duration: duration * 0.82, volume: 0.18, smoothing: 0.82, releasePower: 3.2 });
  return buffer;
}

function backspaceSound(variant) {
  const profiles = [[151, 118], [143, 109], [158, 121], [147, 113]];
  const [frequency, endFrequency] = profiles[variant - 1];
  const buffer = samples(0.086 + variant * 0.004);
  addSoftNoise(buffer, { duration: 0.07, volume: 0.24, smoothing: 0.74, releasePower: 3.8 });
  addTone(buffer, { frequency, endFrequency, start: 0.003, duration: 0.07, volume: 0.52, attack: 0.001, releasePower: 3.6, warmth: 0.42, wow: 0.006 });
  return buffer;
}

function returnSound(variant) {
  const profiles = [[108, 204], [114, 216], [102, 195]];
  const [body, accent] = profiles[variant - 1];
  const buffer = samples(0.16 + variant * 0.006);
  addFeltTap(buffer, { pitch: body, volume: 0.66, duration: 0.11 });
  addSoftNoise(buffer, { start: 0.015, duration: 0.11, volume: 0.2, smoothing: 0.82, releasePower: 2.8 });
  addTone(buffer, { frequency: accent, endFrequency: accent * 0.88, start: 0.035, duration: 0.1, volume: 0.2, attack: 0.003, releasePower: 3.5, warmth: 0.28, wow: 0.008 });
  return buffer;
}

function navigationSound(variant) {
  const profiles = [[257, 0.058], [291, 0.064], [239, 0.06], [276, 0.068], [248, 0.063]];
  const [pitch, duration] = profiles[variant - 1];
  const buffer = samples(duration + 0.022);
  addFeltTap(buffer, { pitch, volume: 0.44, duration });
  addSoftNoise(buffer, { start: 0.002, duration: duration * 0.4, volume: 0.08, smoothing: 0.7, releasePower: 4.5 });
  return buffer;
}

function selectionSound(variant) {
  const profiles = [[224, 408], [251, 449], [216, 427], [238, 463]];
  const [body, accent] = profiles[variant - 1];
  const buffer = samples(0.14 + variant * 0.004);
  addFeltTap(buffer, { pitch: body, volume: 0.55, duration: 0.092 });
  addTone(buffer, { frequency: accent, start: 0.012, duration: 0.1, volume: 0.22, attack: 0.003, releasePower: 3.0, warmth: 0.18, wow: 0.006 });
  return buffer;
}

function confirmationSound(variant) {
  const profiles = [[392, 493.88], [440, 554.37], [415.3, 523.25], [369.99, 466.16]];
  const [first, second] = profiles[variant - 1];
  const buffer = samples(0.3 + variant * 0.006);
  addFeltTap(buffer, { pitch: 185 + variant * 4, volume: 0.35, duration: 0.078 });
  addChime(buffer, first, 0.016, 0.24, 0.36);
  addChime(buffer, second, 0.072, 0.22, 0.29);
  return buffer;
}

function chatSendSound(variant) {
  const profiles = [[341, 474], [362, 506], [328, 458], [351, 492], [336, 481]];
  const [start, end] = profiles[variant - 1];
  const buffer = samples(0.2 + variant * 0.005);
  addFeltTap(buffer, { pitch: 174 + (variant % 3) * 9, volume: 0.48, duration: 0.078 });
  addTone(buffer, { frequency: start, endFrequency: end, start: 0.016, duration: 0.155, volume: 0.3, attack: 0.005, releasePower: 2.8, warmth: 0.22, wow: 0.006, flutter: 0.002 });
  return buffer;
}

const sounds = [];
for (let variant = 1; variant <= 12; variant++) sounds.push([`type_${String(variant).padStart(2, '0')}`, typingSound(variant), 0.16]);
for (let variant = 1; variant <= 4; variant++) sounds.push([`type_space_${String(variant).padStart(2, '0')}`, spaceSound(variant), 0.15]);
for (let variant = 1; variant <= 4; variant++) sounds.push([`type_backspace_${String(variant).padStart(2, '0')}`, backspaceSound(variant), 0.16]);
for (let variant = 1; variant <= 3; variant++) sounds.push([`type_return_${String(variant).padStart(2, '0')}`, returnSound(variant), 0.18]);
for (let variant = 1; variant <= 5; variant++) sounds.push([`navigate_${String(variant).padStart(2, '0')}`, navigationSound(variant), 0.14]);
for (let variant = 1; variant <= 4; variant++) sounds.push([`select_${String(variant).padStart(2, '0')}`, selectionSound(variant), 0.2]);
for (let variant = 1; variant <= 4; variant++) sounds.push([`confirm_${String(variant).padStart(2, '0')}`, confirmationSound(variant), 0.22]);
for (let variant = 1; variant <= 5; variant++) sounds.push([`chat_send_${String(variant).padStart(2, '0')}`, chatSendSound(variant), 0.2]);

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
  addFeltTap(buffer, { pitch: 100, volume: 0.62, duration: 0.14 });
  addTone(buffer, { frequency: 155, endFrequency: 112, start: 0.03, duration: 0.24, volume: 0.42, attack: 0.005, releasePower: 2.5, warmth: 0.38, wow: 0.007 });
  sounds.push(['error', buffer, 0.24]);
}
{
  const buffer = samples(0.48);
  addTapeTexture(buffer, 0.01);
  addChime(buffer, 392, 0, 0.36, 0.35);
  addChime(buffer, 523.25, 0.1, 0.32, 0.3);
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
  const buffer = samples(0.35);
  addFeltTap(buffer, { pitch: 175, volume: 0.3, duration: 0.065 });
  addChime(buffer, 349.23, 0.018, 0.28, 0.3);
  addChime(buffer, 440, 0.07, 0.24, 0.24);
  sounds.push(['success', buffer, 0.21]);
}
{
  const buffer = samples(0.18);
  addFeltTap(buffer, { pitch: 145, volume: 0.5, duration: 0.085 });
  addTone(buffer, { frequency: 310, endFrequency: 232, start: 0.016, duration: 0.13, volume: 0.24, attack: 0.002, releasePower: 2.8, warmth: 0.22, wow: 0.005 });
  sounds.push(['cancel', buffer, 0.18]);
}
{
  const buffer = samples(0.17);
  addFeltTap(buffer, { pitch: 200, volume: 0.52, duration: 0.08 });
  addSoftNoise(buffer, { start: 0.012, duration: 0.11, volume: 0.12, smoothing: 0.78, releasePower: 2.8 });
  sounds.push(['command', buffer, 0.18]);
}
{
  const buffer = samples(0.26);
  addFeltTap(buffer, { pitch: 180, volume: 0.3, duration: 0.075 });
  addChime(buffer, 415.3, 0.025, 0.19, 0.26);
  sounds.push(['chat_receive', buffer, 0.19]);
}
{
  const buffer = samples(0.42);
  addChime(buffer, 293.66, 0, 0.34, 0.3);
  addChime(buffer, 440, 0.08, 0.3, 0.26);
  addFeltTap(buffer, { start: 0.012, pitch: 165, volume: 0.22, duration: 0.075 });
  sounds.push(['room_join', buffer, 0.21]);
}
{
  const buffer = samples(0.36);
  addChime(buffer, 349.23, 0, 0.28, 0.26);
  addChime(buffer, 233.08, 0.07, 0.25, 0.23);
  sounds.push(['room_leave', buffer, 0.19]);
}
{
  const buffer = samples(0.14);
  addSoftNoise(buffer, { duration: 0.095, volume: 0.22, smoothing: 0.78, releasePower: 3.5 });
  addTone(buffer, { frequency: 260, endFrequency: 390, duration: 0.105, volume: 0.28, attack: 0.001, releasePower: 3.2, warmth: 0.15, wow: 0.005 });
  sounds.push(['toggle_on', buffer, 0.17]);
}
{
  const buffer = samples(0.14);
  addSoftNoise(buffer, { duration: 0.095, volume: 0.22, smoothing: 0.78, releasePower: 3.5 });
  addTone(buffer, { frequency: 350, endFrequency: 220, duration: 0.105, volume: 0.28, attack: 0.001, releasePower: 3.2, warmth: 0.15, wow: 0.005 });
  sounds.push(['toggle_off', buffer, 0.17]);
}

fs.mkdirSync(outputDirectory, { recursive: true });
for (const file of fs.readdirSync(outputDirectory)) {
  if (file.toLowerCase().endsWith('.wav')) fs.rmSync(path.join(outputDirectory, file));
}
for (const [name, buffer, targetPeak] of sounds) writeWave(name, buffer, targetPeak);
console.log(`Generated ${sounds.length} soft UI sounds in ${outputDirectory}`);
