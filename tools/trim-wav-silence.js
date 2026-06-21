'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const soundDirectory = path.join(root, 'sound');
const backupDirectory = path.join(root, 'sound-originals');
const threshold = 330; // approximately -40 dBFS for 16-bit PCM
const leadingPaddingMs = 2;
const trailingPaddingMs = 12;

function findChunk(buffer, name) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkName = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (chunkName === name) return { offset, size, dataOffset: offset + 8 };
    offset += 8 + size + (size % 2);
  }
  return null;
}

function trimFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  const format = findChunk(buffer, 'fmt ');
  const data = findChunk(buffer, 'data');
  if (!format || !data) throw new Error('missing fmt or data chunk');
  const encoding = buffer.readUInt16LE(format.dataOffset);
  const channels = buffer.readUInt16LE(format.dataOffset + 2);
  const sampleRate = buffer.readUInt32LE(format.dataOffset + 4);
  const bits = buffer.readUInt16LE(format.dataOffset + 14);
  if (encoding !== 1 || bits !== 16) throw new Error('only 16-bit PCM is supported');

  const frameBytes = channels * 2;
  const frameCount = Math.floor(data.size / frameBytes);
  let first = -1;
  let last = -1;
  for (let frame = 0; frame < frameCount; frame++) {
    let level = 0;
    for (let channel = 0; channel < channels; channel++) {
      const sampleOffset = data.dataOffset + frame * frameBytes + channel * 2;
      level = Math.max(level, Math.abs(buffer.readInt16LE(sampleOffset)));
    }
    if (level >= threshold) {
      if (first === -1) first = frame;
      last = frame;
    }
  }
  if (first === -1) return null;

  const leadingPadding = Math.round(sampleRate * leadingPaddingMs / 1000);
  const trailingPadding = Math.round(sampleRate * trailingPaddingMs / 1000);
  const startFrame = Math.max(0, first - leadingPadding);
  const endFrame = Math.min(frameCount, last + trailingPadding + 1);
  const leadingMs = startFrame / sampleRate * 1000;
  const trailingMs = (frameCount - endFrame) / sampleRate * 1000;
  if (leadingMs < 2 && trailingMs < 20) return null;

  const trimmedData = buffer.subarray(
    data.dataOffset + startFrame * frameBytes,
    data.dataOffset + endFrame * frameBytes
  );
  const header = Buffer.from(buffer.subarray(0, data.dataOffset));
  header.writeUInt32LE(trimmedData.length, data.offset + 4);
  const output = Buffer.concat([header, trimmedData]);
  output.writeUInt32LE(output.length - 8, 4);
  fs.writeFileSync(filePath, output);
  return {
    beforeMs: frameCount / sampleRate * 1000,
    afterMs: (endFrame - startFrame) / sampleRate * 1000,
    removedLeadingMs: startFrame / sampleRate * 1000,
    removedTrailingMs: (frameCount - endFrame) / sampleRate * 1000,
  };
}

fs.mkdirSync(backupDirectory, { recursive: true });
for (const name of fs.readdirSync(soundDirectory).filter(name => name.toLowerCase().endsWith('.wav')).sort()) {
  const source = path.join(soundDirectory, name);
  const backup = path.join(backupDirectory, name);
  if (!fs.existsSync(backup)) fs.copyFileSync(source, backup);
  const result = trimFile(source);
  console.log(result ? `${name}: ${JSON.stringify(result)}` : `${name}: unchanged`);
}
