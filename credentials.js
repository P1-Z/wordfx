'use strict';

const fs = require('node:fs');
const { randomBytes, pbkdf2Sync, timingSafeEqual } = require('node:crypto');
const { dataPath } = require('./storage');

const credentialPath = dataPath('credentials.json');
const ITERATIONS = 210000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

function readCredentials() {
  try {
    const value = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    if (value.version !== 1 || typeof value.username !== 'string' || typeof value.salt !== 'string' || typeof value.hash !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

function registeredUsername() {
  return readCredentials()?.username || null;
}

function registerCredentials(username, password) {
  const cleanUsername = String(username).trim();
  if (cleanUsername.length < 2 || cleanUsername.length > 24) throw new Error('Username must be 2-24 characters.');
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  const record = { version: 1, username: cleanUsername, salt: salt.toString('hex'), hash: hash.toString('hex'), iterations: ITERATIONS, digest: DIGEST };
  const temporaryPath = `${credentialPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, credentialPath);
  return cleanUsername;
}

function credentialsMatch(username, password) {
  const saved = readCredentials();
  if (!saved || String(username).trim() !== saved.username) return false;
  try {
    const expected = Buffer.from(saved.hash, 'hex');
    const actual = pbkdf2Sync(password, Buffer.from(saved.salt, 'hex'), saved.iterations || ITERATIONS, expected.length, saved.digest || DIGEST);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

module.exports = { readCredentials, registeredUsername, registerCredentials, credentialsMatch };
