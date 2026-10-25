'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { migrateSampleProfile } = require('../electron/profile-migration.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-profile-migration-'));
  const stable = path.join(root, 'Elysia Desktop Pet'), sample = path.join(root, 'Elysia Desktop Pet 1.3.0 Sample');
  fs.mkdirSync(stable); fs.mkdirSync(sample);
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (directory, name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const read = (directory, name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  return { root, stable, sample, write, read };
}

test('first formal launch copies missing sample settings and voice history without changing the source', t => {
  const f = fixture(t), settings = { settings: { scale: 1.4, cursorTrailDuration: 1.25 }, position: { x: 120, y: 350 } };
  const voice = { settings: { volume: .4, birthday: '08-13' }, history: { days: { '2026-10-25': { total: 3 } } } };
  f.write(f.sample, 'settings.json', settings); f.write(f.sample, 'voice-state.json', voice);
  const result = migrateSampleProfile(f.root);
  assert.deepEqual(result.copied, ['settings.json', 'voice-state.json']); assert.deepEqual(result.errors, []);
  assert.deepEqual(f.read(f.stable, 'settings.json'), settings); assert.deepEqual(f.read(f.stable, 'voice-state.json'), voice);
  assert.deepEqual(f.read(f.sample, 'settings.json'), settings); assert.deepEqual(f.read(f.sample, 'voice-state.json'), voice);
  assert.equal(fs.existsSync(path.join(f.stable, 'settings.pre-1.3.0.json')), false);
});

test('an existing 1.2 profile keeps its settings and position, imports only missing new fields, and is backed up once', t => {
  const f = fixture(t);
  const old = { settings: { scale: .8, alwaysOnTop: false, cursorTrailEnabled: false }, position: { x: 77, y: 88 }, preserved: 'old metadata' };
  const newer = { settings: { scale: 1.7, alwaysOnTop: true, interactionsEnabled: false, cursorTrailEnabled: true, cursorTrailStyle: 'ribbon', cursorTrailDuration: 2.25 }, position: { x: 400, y: 500 } };
  f.write(f.stable, 'settings.json', old); f.write(f.sample, 'settings.json', newer);
  f.write(f.stable, 'voice-state.json', { settings: { volume: .2 }, history: { existing: true } });
  f.write(f.sample, 'voice-state.json', { settings: { volume: .9 }, history: { sample: true } });
  const result = migrateSampleProfile(f.root), actual = f.read(f.stable, 'settings.json');
  assert.deepEqual(result.copied, []); assert.deepEqual(result.addedSettings, ['interactionsEnabled', 'cursorTrailStyle', 'cursorTrailDuration']);
  assert.deepEqual(actual, { ...old, settings: { ...old.settings, interactionsEnabled: false, cursorTrailStyle: 'ribbon', cursorTrailDuration: 2.25 } });
  assert.deepEqual(f.read(f.stable, 'settings.pre-1.3.0.json'), old);
  assert.deepEqual(f.read(f.stable, 'voice-state.json'), { settings: { volume: .2 }, history: { existing: true } });
  const before = fs.readFileSync(path.join(f.stable, 'settings.json'), 'utf8');
  f.write(f.sample, 'settings.json', { settings: { ...newer.settings, cursorTrailDuration: 5 } });
  assert.deepEqual(migrateSampleProfile(f.root).addedSettings, []);
  assert.equal(fs.readFileSync(path.join(f.stable, 'settings.json'), 'utf8'), before);
  assert.deepEqual(f.read(f.stable, 'settings.pre-1.3.0.json'), old);
});

test('missing sample data and malformed files cannot overwrite an existing formal profile', t => {
  const f = fixture(t), old = { settings: { scale: 1 }, position: { x: 1, y: 2 } };
  f.write(f.stable, 'settings.json', old);
  assert.deepEqual(migrateSampleProfile(f.root), { copied: [], addedSettings: [], errors: [] });
  fs.writeFileSync(path.join(f.sample, 'settings.json'), '{incomplete');
  fs.writeFileSync(path.join(f.sample, 'voice-state.json'), 'null');
  migrateSampleProfile(f.root); assert.deepEqual(f.read(f.stable, 'settings.json'), old);
  assert.equal(fs.existsSync(path.join(f.stable, 'voice-state.json')), false);
  f.write(f.sample, 'settings.json', { settings: { cursorTrailDuration: 5 } });
  fs.writeFileSync(path.join(f.stable, 'settings.json'), '{keep-user-data');
  migrateSampleProfile(f.root); assert.equal(fs.readFileSync(path.join(f.stable, 'settings.json'), 'utf8'), '{keep-user-data');
});

test('new fields are sanitized and a pre-existing backup is never overwritten', t => {
  const f = fixture(t);
  f.write(f.stable, 'settings.json', { settings: { scale: .9 } });
  f.write(f.stable, 'settings.pre-1.3.0.json', { savedEarlier: true });
  f.write(f.sample, 'settings.json', { settings: { cursorTrailDuration: 9, cursorTrailStyle: 'invalid', interactionsEnabled: 'invalid' } });
  const result = migrateSampleProfile(f.root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(f.read(f.stable, 'settings.json').settings, { scale: .9, interactionsEnabled: true, cursorTrailStyle: 'pink', cursorTrailDuration: 5 });
  assert.deepEqual(f.read(f.stable, 'settings.pre-1.3.0.json'), { savedEarlier: true });
});
