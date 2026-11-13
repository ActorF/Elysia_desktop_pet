'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { downloadResource } = require('../electron/resource-download.cjs');
const parent = path.resolve(__dirname, '../artifacts/deep-audit-round3/download-tail');

for (const mode of ['disconnect', 'early-disconnect', 'idle', 'corrupt', 'overflow', 'total', 'cancel']) {
  test(`a last-source ${mode} preserves digest and cancellation guarantees`, async t => {
    fs.mkdirSync(parent, { recursive: true }); const directory = fs.mkdtempSync(path.join(parent, 'case-'));
    const bytes = Buffer.from('small digest-pinned fixture'), destination = path.join(directory, 'resource.bin');
    const asset = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    let requests = 0, response, acknowledgedDisconnect = false;
    const server = http.createServer((request, reply) => {
      requests++; response = reply; reply.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      reply.write(mode === 'corrupt' ? Buffer.alloc(bytes.length, 45) : mode === 'early-disconnect' ? bytes.subarray(0, 4) : bytes);
      if (mode === 'overflow') reply.end('extra bytes');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      response?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(directory), parent); fs.rmSync(directory, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${server.address().port}/fixture`;
    const controller = new AbortController();
    const operation = downloadResource({ asset, destination, sources: [url], signal: controller.signal,
      isAllowedUrl: candidate => candidate.href === url, idleTimeoutMs: mode === 'total' ? 500 : 40,
      downloadTimeoutMs: mode === 'total' ? 30 : 2000,
      onProgress: completed => {
        if (mode === 'cancel' && completed === bytes.length) controller.abort();
        // A server write/timer does not prove the client consumed the bytes:
        // under contention, disconnect can reject undici's queued body first.
        // Trigger the real socket failure only after the downloader has written
        // the intended full payload (or deliberately incomplete prefix).
        const disconnectAfter = mode === 'disconnect' ? bytes.length : mode === 'early-disconnect' ? 4 : 0;
        if (disconnectAfter && completed === disconnectAfter) {
          assert.deepEqual(fs.readFileSync(`${destination}.part`), bytes.subarray(0, disconnectAfter));
          acknowledgedDisconnect = true; response.destroy();
        }
      } });
    if (['disconnect', 'idle'].includes(mode)) {
      assert.equal(await operation, destination); assert.deepEqual(fs.readFileSync(destination), bytes);
      assert.equal(fs.existsSync(`${destination}.part`), false);
    } else {
      await assert.rejects(operation, error => mode === 'cancel' ? error.name === 'AbortError'
        : error.diagnosticKind === ({ 'early-disconnect': 'network-connect', corrupt: 'integrity-hash', overflow: 'integrity-size', total: 'network-total-timeout' })[mode]);
      assert.equal(fs.existsSync(destination), false);
      if (['corrupt', 'overflow'].includes(mode)) assert.equal(fs.existsSync(`${destination}.part`), false);
      if (mode === 'early-disconnect') assert.deepEqual(fs.readFileSync(`${destination}.part`), bytes.subarray(0, 4));
    }
    if (mode.endsWith('disconnect')) assert.equal(acknowledgedDisconnect, true, 'the intended persisted-byte boundary must actually be reached');
    assert.equal(requests, 1);
  });
}
