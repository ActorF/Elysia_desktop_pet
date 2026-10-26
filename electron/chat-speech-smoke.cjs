/** A silent in-memory worker for hidden Electron playback checks; it never opens a Python process. */
'use strict';
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function silentWave(seconds = .1) {
  const rate = 16000, length = Math.round(rate * seconds) * 2, bytes = Buffer.alloc(44 + length);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + length, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(length, 40); return bytes;
}
function createChatSpeechSmokeWorker() {
  const calls = [];
  let utterances = 0;
  function spawnImpl() {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const record = { killed: false, acknowledged: false, acknowledgements: 0, requests: 0, packets: [] }; calls.push(record);
    let exited = false, buffered = '';
    const close = code => { if (!exited) { exited = true; queueMicrotask(() => child.emit('close', code)); } };
    child.kill = () => { record.killed = true; close(1); };
    const send = value => { if (!exited) child.stdout.write(JSON.stringify(value) + '\n'); };
    child.stdin.on('data', chunk => {
      buffered += chunk.toString(); let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const packet = JSON.parse(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1);
        record.packets.push(packet.type);
        if (packet.type === 'warmup') queueMicrotask(() => send({ type: 'ready', emotion: 'neutral' }));
        if (packet.type === 'speak') queueMicrotask(() => {
          record.requests++; utterances++;
          send({ type: 'starting' });
          send({ type: 'audio', mime: 'audio/wav', emotion: 'neutral', base64: silentWave(utterances === 1 ? .1 : 3).toString('base64') });
        });
        if (packet.type === 'next') { record.acknowledged = true; record.acknowledgements++; send({ type: 'done' }); }
      }
    });
    return child;
  }
  return { spawnImpl, exists: () => true, calls };
}
module.exports = { createChatSpeechSmokeWorker, silentWave };
