#!/usr/bin/env node

'use strict';

const { playSound, warmSoundSystem } = require('../sound');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const preview = [
  ['navigate', 230],
  ['select', 280],
  ['confirm', 430],
  ['command', 300],
  ['chat_send', 330],
  ['chat_receive', 390],
  ['room_join', 520],
  ['notification', 620],
  ['note_dissolve', 780],
  ['closing or quitting', 700],
];

async function main() {
  if (!(await warmSoundSystem())) throw new Error('The Windows sound player is unavailable.');
  console.log('Playing the WordFX soft sound library...');
  for (const [name, delay] of preview) {
    console.log(`  ${name}`);
    playSound(name);
    await wait(delay);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
