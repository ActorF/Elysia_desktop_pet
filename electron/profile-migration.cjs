'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeSettings } = require('./host-policy.cjs');

const NEW_SETTINGS = ['interactionsEnabled', 'cursorTrailEnabled', 'cursorTrailStyle', 'cursorTrailDuration'];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function readRecord(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return record(value) ? value : null; } catch { return null; }
}

/** Keep the stable 1.2 profile and import only missing data from the local sample. */
function migrateSampleProfile(appData) {
  const destination = path.join(appData, 'Elysia Desktop Pet');
  const source = path.join(appData, 'Elysia Desktop Pet 1.3.0 Sample');
  const result = { copied: [], addedSettings: [], errors: [] };
  const sampleSettings = readRecord(path.join(source, 'settings.json'));
  for (const name of ['settings.json', 'voice-state.json']) {
    const from = path.join(source, name), to = path.join(destination, name);
    const value = name === 'settings.json' ? sampleSettings : readRecord(from);
    if (!value || (name === 'settings.json' && !record(value.settings))) continue;
    try {
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      result.copied.push(name);
    } catch (error) { if (error.code !== 'EEXIST' && error.code !== 'ENOENT') result.errors.push(`${name}: ${error.message}`); }
  }
  const settingsFile = path.join(destination, 'settings.json'), existing = readRecord(settingsFile);
  if (!record(existing?.settings) || !record(sampleSettings?.settings)) return result;
  const clean = sanitizeSettings(sampleSettings.settings), additions = {};
  for (const key of NEW_SETTINGS) {
    if (!Object.hasOwn(existing.settings, key) && Object.hasOwn(sampleSettings.settings, key)) additions[key] = clean[key];
  }
  if (!Object.keys(additions).length) return result;
  const backup = path.join(destination, 'settings.pre-1.3.0.json');
  const temporary = path.join(destination, `settings.migration-${process.pid}.tmp`);
  let wroteTemporary = false;
  try {
    try { fs.copyFileSync(settingsFile, backup, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    fs.writeFileSync(temporary, JSON.stringify({ ...existing, settings: { ...existing.settings, ...additions } }, null, 2), { flag: 'wx' });
    wroteTemporary = true;
    fs.renameSync(temporary, settingsFile); wroteTemporary = false;
    result.addedSettings = Object.keys(additions);
  } catch (error) {
    result.errors.push(`settings migration: ${error.message}`);
  } finally {
    if (wroteTemporary) { try { fs.unlinkSync(temporary); } catch {} }
  }
  return result;
}

module.exports = { migrateSampleProfile };
