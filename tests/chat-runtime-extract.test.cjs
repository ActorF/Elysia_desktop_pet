'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EXTRACT_SCRIPT } = require('../electron/chat-runtime-extract.cjs');
// Match the native host fixture's allowance for hosted Windows cold starts.
// A timeout or failed launch must never count as rejecting an unsafe archive.
const EXTRACT_TIMEOUT_MS = 45000;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data || ''), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((entry.attributes || 0) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const footer = Buffer.alloc(22), directory = Buffer.concat(central);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10); footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}
test('native extractor accepts ordinary nested files and rejects unsafe entries before writing', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-zip-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scenarios = [
    { name: 'valid', entries: [{ name: 'llama-server.exe', data: 'server' }, { name: 'lib/' }, { name: 'lib/runtime.dll', data: 'library' }], valid: true },
    { name: 'traversal', entries: [{ name: 'safe.txt', data: 'must not extract' }, { name: '../outside.txt', data: 'bad' }] },
    { name: 'drive', entries: [{ name: 'C:/outside.txt' }] },
    { name: 'ads', entries: [{ name: 'file.txt:payload' }] },
    { name: 'duplicate', entries: [{ name: 'A.dll' }, { name: 'a.dll' }] },
    { name: 'alias', entries: [{ name: 'file.dll.' }] },
    { name: 'device', entries: [{ name: 'NUL.txt' }] },
    { name: 'link', entries: [{ name: 'library.dll', data: '../outside', attributes: 0xa1ff0000 }] },
  ];
  for (const scenario of scenarios) {
    const archive = path.join(root, scenario.name + '.zip'), stage = path.join(root, scenario.name);
    fs.mkdirSync(stage); fs.writeFileSync(archive, zip(scenario.entries));
    const child = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(EXTRACT_SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, encoding: 'utf8', timeout: EXTRACT_TIMEOUT_MS, env: { ...process.env, ELYSIA_CHAT_ARCHIVE: archive, ELYSIA_CHAT_STAGE: stage } });
    const diagnostic = JSON.stringify({ scenario: scenario.name, timeoutMs: EXTRACT_TIMEOUT_MS,
      error: child.error && { code: child.error.code, message: child.error.message },
      status: child.status, signal: child.signal, stderr: child.stderr?.slice(-2048) });
    assert.ok(!child.error, diagnostic);
    assert.equal(child.signal, null, diagnostic);
    assert.ok(Number.isInteger(child.status), diagnostic);
    if (scenario.valid) {
      assert.equal(child.status, 0, diagnostic); assert.equal(fs.readFileSync(path.join(stage, 'lib/runtime.dll'), 'utf8'), 'library');
    } else { assert.notEqual(child.status, 0, diagnostic); assert.deepEqual(fs.readdirSync(stage), [], scenario.name); }
  }
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
});
