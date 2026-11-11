'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { downloadResource, verifyResource } = require('../electron/resource-download.cjs');

const sources = ['https://first.example/model.bin', 'https://second.example/model.bin'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = url => url.protocol === 'https:' && ['first.example', 'second.example', 'cdn.example'].includes(url.hostname);
function fixture(t) {
  const parent = path.resolve(__dirname, '../artifacts/error-classification/temp/resource-download');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => {
    assert.equal(path.dirname(directory), parent);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from('GGUF the exact pinned model payload');
  const asset = { bytes: bytes.length, sha256: digest(bytes) };
  const destination = path.join(directory, 'model.bin');
  const calls = [];
  function response(offset = 0, data = bytes) {
    return new Response(data.subarray(offset), { status: offset ? 206 : 200, headers: {
      'content-length': String(data.length - offset),
      ...(offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
    } });
  }
  function options(fetch, extra = {}) {
    return { asset, destination, sources, isAllowedUrl: allowed,
      fetchImpl: async (url, request) => { calls.push({ url, request }); return fetch(url, request); }, ...extra };
  }
  return { directory, bytes, asset, destination, partial: destination + '.part', calls, response, options };
}
const setupError = code => error => error.setupCode === code;
function interrupted(prefix, { stall = false, overflow, onCancel = () => {} } = {}) {
  let reads = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      reads++;
      if (reads === 1) controller.enqueue(prefix);
      else if (overflow) { controller.enqueue(overflow); controller.close(); }
      else if (!stall) controller.error(new Error('connection interrupted'));
    },
    cancel: onCancel,
  }, { highWaterMark: 0 }));
}

test('verified completed resources and complete partials work without network', async t => {
  const f = fixture(t);
  assert.equal(await verifyResource(f.destination, f.asset), false);
  fs.writeFileSync(f.partial, f.bytes);
  const options = f.options(() => { throw new Error('network must not be called'); });
  assert.equal(await downloadResource(options), f.destination);
  assert.equal(fs.existsSync(f.partial), false);
  assert.equal(await downloadResource(options), f.destination);
  assert.equal(f.calls.length, 0);
});

test('failed first source switches automatically and publishes only verified bytes', async t => {
  const f = fixture(t), switches = [];
  await downloadResource(f.options(url => {
    if (url === sources[0]) throw new Error('unreachable');
    return f.response();
  }, { onSourceChange: value => switches.push(value) }));
  assert.deepEqual(f.calls.map(call => call.url), sources);
  assert.deepEqual(switches, [{ index: 1, url: sources[1] }]);
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('an interrupted mirror resumes the same partial on the next mirror', async t => {
  const f = fixture(t);
  await downloadResource(f.options((url, request) => {
    if (url === sources[0]) return interrupted(f.bytes.subarray(0, 7));
    assert.equal(request.headers.Range, 'bytes=7-');
    return f.response(7);
  }));
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
  assert.equal(f.calls.length, 2);
});

test('user cancellation preserves partial bytes and the next run resumes them', async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(downloadResource(f.options(() => interrupted(f.bytes.subarray(0, 5), { stall: true }), {
    signal: controller.signal,
    onProgress: completed => { if (completed === 5) controller.abort(); },
  })), error => error.name === 'AbortError' && error.diagnosticKind === undefined);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(fs.readFileSync(f.partial), f.bytes.subarray(0, 5));
  await downloadResource(f.options((_url, request) => {
    assert.equal(request.headers.Range, 'bytes=5-'); return f.response(5);
  }));
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('incorrect Content-Range cannot append bytes or destroy a valid saved prefix', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.partial, f.bytes.subarray(0, 4));
  await downloadResource(f.options((url, request) => {
    assert.equal(request.headers.Range, 'bytes=4-');
    if (url === sources[0]) return new Response('untrusted', { status: 206, headers: { 'content-range': `bytes 0-${f.bytes.length - 1}/${f.bytes.length}` } });
    assert.deepEqual(fs.readFileSync(f.partial), f.bytes.subarray(0, 4));
    return f.response(4);
  }));
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('a server ignoring Range safely restarts from byte zero', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.partial, f.bytes.subarray(0, 5));
  await downloadResource(f.options((_url, request) => {
    assert.equal(request.headers.Range, 'bytes=5-'); return f.response();
  }));
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('digest mismatch clears corrupt data before trying the next source', async t => {
  const f = fixture(t);
  await downloadResource(f.options((url, request) => {
    assert.equal(request.headers.Range, undefined);
    return url === sources[0] ? f.response(0, Buffer.alloc(f.bytes.length, 0x58)) : f.response();
  }));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('bad saved prefix triggers one clean retry of an otherwise healthy final source', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.partial, Buffer.from('WRONG'));
  await downloadResource(f.options((_url, request) => request.headers.Range ? f.response(5) : f.response(), { sources: [sources[0]] }));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].request.headers.Range, 'bytes=5-');
  assert.equal(f.calls[1].request.headers.Range, undefined);
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('streamed overflow discards the untrusted prefix before fallback', async t => {
  const f = fixture(t);
  await downloadResource(f.options((url, request) => {
    if (url === sources[0]) return interrupted(Buffer.from('wrong'), { overflow: Buffer.alloc(f.bytes.length) });
    assert.equal(request.headers.Range, undefined); return f.response();
  }));
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('untrusted redirect is never fetched and fallback can still succeed', async t => {
  const f = fixture(t);
  await downloadResource(f.options(url => url === sources[0]
    ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) : f.response()));
  assert.deepEqual(f.calls.map(call => call.url), sources);
});

test('allowed redirects keep Range and are checked against the original source', async t => {
  const f = fixture(t), policies = [];
  fs.writeFileSync(f.partial, f.bytes.subarray(0, 3));
  await downloadResource(f.options((url, request) => {
    assert.equal(request.headers.Range, 'bytes=3-');
    return url === sources[0] ? new Response(null, { status: 307, headers: { location: 'https://cdn.example/file' } }) : f.response(3);
  }, { isAllowedUrl: (url, source) => { policies.push([url.href, source.href]); return allowed(url); } }));
  assert.deepEqual(policies, [[sources[0], sources[0]], ['https://cdn.example/file', sources[0]]]);
});

test('header timeout aborts a stalled transport and cancels its late response', async t => {
  const f = fixture(t);
  let respondLate, firstSignal, cancelledLate = false;
  await downloadResource(f.options((url, request) => {
    if (url !== sources[0]) return f.response();
    firstSignal = request.signal;
    return new Promise(resolve => { respondLate = resolve; });
  }, { requestTimeoutMs: 20 }));
  assert.equal(firstSignal.aborted, true);
  respondLate(new Response(new ReadableStream({ cancel() { cancelledLate = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelledLate, true);
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('body idle timeout preserves downloaded bytes and closes the stalled reader', async t => {
  const f = fixture(t);
  let cancelledBody = false;
  await downloadResource(f.options((url, request) => {
    if (url === sources[0]) return interrupted(f.bytes.subarray(0, 6), { stall: true, onCancel() { cancelledBody = true; } });
    assert.equal(request.headers.Range, 'bytes=6-'); return f.response(6);
  }, { idleTimeoutMs: 20 }));
  assert.equal(cancelledBody, true);
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('header deadline does not limit a healthy streaming body to the header timeout', async t => {
  const f = fixture(t);
  await downloadResource(f.options(() => {
    let offset = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 8));
        if (offset === f.bytes.length) controller.close();
        else controller.enqueue(f.bytes.subarray(offset, ++offset));
      },
    }, { highWaterMark: 0 }));
  }, { requestTimeoutMs: 20, idleTimeoutMs: 100 }));
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('total deadline stops rather than restarting a fresh timeout on every source', async t => {
  const f = fixture(t);
  await assert.rejects(downloadResource(f.options(() => new Promise(() => {}), {
    requestTimeoutMs: 1000, downloadTimeoutMs: 20,
  })), setupError('download'));
  assert.equal(f.calls.length, 1);
});

test('wrong-sized declared response and final digest failure are rejected', async t => {
  const f = fixture(t);
  await assert.rejects(downloadResource(f.options(() => new Response(f.bytes, { headers: { 'content-length': '0' } }), { sources: [sources[0]] })), setupError('integrity'));
  assert.equal(fs.existsSync(f.destination), false);
  await assert.rejects(downloadResource(f.options(() => f.response(0, Buffer.alloc(f.bytes.length)), { sources: [sources[0]] })), setupError('integrity'));
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.existsSync(f.partial), false);
});

test('unverified existing destination is preserved before fetching its replacement', async t => {
  const f = fixture(t), original = Buffer.from('user supplied old model');
  fs.writeFileSync(f.destination, original);
  await downloadResource(f.options(() => f.response()));
  const saved = fs.readdirSync(f.directory).filter(name => name.startsWith('model.bin.unverified-'));
  assert.equal(saved.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, saved[0])), original);
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('app-owned corrupt cache can be replaced without retaining a duplicate archive', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.destination, Buffer.alloc(f.bytes.length, 0x58));
  await downloadResource(f.options(() => f.response(), { preserveInvalidDestination: false }));
  assert.deepEqual(fs.readdirSync(f.directory), ['model.bin']);
  assert.deepEqual(fs.readFileSync(f.destination), f.bytes);
});

test('non-regular destination and partial files fail without network writes', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.destination);
  await assert.rejects(downloadResource(f.options(() => f.response())), setupError('storage'));
  fs.rmdirSync(f.destination); fs.mkdirSync(f.partial);
  await assert.rejects(downloadResource(f.options(() => f.response())), setupError('storage'));
  assert.equal(f.calls.length, 0);
});

test('a disk write failure is storage and does not waste downloads on another mirror', async t => {
  const f = fixture(t), realOpen = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args) => {
    if (args[0] === f.partial) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    return realOpen(...args);
  });
  await assert.rejects(downloadResource(f.options(() => f.response())), error => error.setupCode === 'storage' && error.diagnosticKind === 'storage-space');
  assert.equal(f.calls.length, 1);
});

test('known transport causes are classified without copying messages, URLs or secrets', async t => {
  for (const [code, expected] of [
    ['ENOTFOUND', 'network-dns'], ['EAI_AGAIN', 'network-dns'],
    ['ECONNREFUSED', 'network-connect'], ['ECONNRESET', 'network-connect'], ['ENETUNREACH', 'network-connect'],
    ['CERT_HAS_EXPIRED', 'network-tls'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'network-tls'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'network-tls'],
    ['UND_ERR_CONNECT_TIMEOUT', 'network-timeout'], ['UND_ERR_HEADERS_TIMEOUT', 'network-timeout'],
    ['UND_ERR_BODY_TIMEOUT', 'network-idle-timeout'], ['UNRECOGNIZED', 'network-unknown'],
  ]) {
    await t.test(code, async t => {
      const f = fixture(t), cause = Object.assign(new Error('https://private.example/?token=secret'), { code });
      const transport = new TypeError('request contained private data', { cause: new Error('wrapper', { cause }) });
      await assert.rejects(downloadResource(f.options(() => { throw transport; }, { sources: [sources[0]] })), error => {
        assert.equal(error.setupCode, 'download'); assert.equal(error.diagnosticKind, expected);
        assert.equal(error.cause, transport, 'original cause remains internal for trusted troubleshooting');
        assert.equal(error.message, 'download'); assert.doesNotMatch(JSON.stringify(error), /private|secret|token/);
        return true;
      });
      assert.equal(f.calls.length, 1);
    });
  }
});

test('cause traversal stops on cycles and does not guess unknown transport failures', async t => {
  const f = fixture(t), cause = new Error('opaque'); cause.cause = cause;
  await assert.rejects(downloadResource(f.options(() => { throw cause; }, { sources: [sources[0]] })), error => error.diagnosticKind === 'network-unknown');
});

test('HTTP response status remains available for forbidden, missing, rate-limited and server failures', async t => {
  for (const status of [401, 403, 404, 408, 429, 500, 502, 503]) {
    await t.test(String(status), async t => {
      const f = fixture(t);
      await assert.rejects(downloadResource(f.options(() => new Response('private server body', { status }), { sources: [sources[0]] })), error => {
        assert.equal(error.setupCode, 'download'); assert.equal(error.diagnosticKind, 'network-http'); assert.equal(error.httpStatus, status);
        assert.doesNotMatch(JSON.stringify(error), /private server body/); return true;
      });
      assert.equal(fs.existsSync(f.partial), false);
    });
  }
});

test('header, body inactivity and whole-operation deadlines remain distinct', async t => {
  for (const [label, kind] of [['header', 'network-timeout'], ['body', 'network-idle-timeout'], ['total', 'network-total-timeout']]) {
    await t.test(label, async t => {
      const f = fixture(t);
      const fetch = label === 'body' ? () => interrupted(f.bytes.subarray(0, 4), { stall: true }) : () => new Promise(() => {});
      const timeout = label === 'header' ? { requestTimeoutMs: 15 } : label === 'body' ? { idleTimeoutMs: 15 } : { downloadTimeoutMs: 15, requestTimeoutMs: 1000 };
      await assert.rejects(downloadResource(f.options(fetch, { sources: [sources[0]], ...timeout })), error => error.setupCode === 'download' && error.diagnosticKind === kind);
      if (label === 'body') assert.deepEqual(fs.readFileSync(f.partial), f.bytes.subarray(0, 4), 'idle timeout keeps resumable bytes');
    });
  }
});

test('redirect policy, invalid range, short body, length and SHA failures have different diagnoses', async t => {
  const cases = [
    ['network-redirect', f => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private?token=hidden' } })],
    ['network-redirect', () => new Response(null, { status: 302 })],
    ['network-range', f => new Response(f.bytes, { status: 206, headers: { 'content-range': 'bytes 1-2/3' } })],
    ['network-truncated', f => new Response(f.bytes.subarray(0, 5))],
    ['integrity-size', f => new Response(f.bytes, { headers: { 'content-length': '0' } })],
    ['integrity-size', f => new Response(Buffer.concat([f.bytes, Buffer.from('overflow')]))],
    ['integrity-hash', f => f.response(0, Buffer.alloc(f.bytes.length))],
  ];
  for (const [kind, fetch] of cases) await t.test(kind, async t => {
    const f = fixture(t);
    await assert.rejects(downloadResource(f.options(() => fetch(f), { sources: [sources[0]] })), error => {
      assert.equal(error.diagnosticKind, kind); assert.equal(error.setupCode, kind.startsWith('integrity-') ? 'integrity' : 'download');
      assert.doesNotMatch(JSON.stringify(error), /token|hidden|private/); return true;
    });
    assert.equal(f.calls.length, 1); assert.equal(fs.existsSync(f.destination), false);
  });
});

test('file-system error classes retain storage attribution and never trigger a mirror retry', async t => {
  for (const [code, kind] of [['EDQUOT', 'storage-space'], ['EACCES', 'storage-permission'], ['EPERM', 'storage-permission'],
    ['EBUSY', 'storage-busy'], ['ENAMETOOLONG', 'storage-path'], ['EIO', 'storage-io']]) {
    await t.test(code, async t => {
      const f = fixture(t), realOpen = fs.promises.open.bind(fs.promises);
      t.mock.method(fs.promises, 'open', async (...args) => {
        if (args[0] === f.partial) throw Object.assign(new Error('private path'), { code });
        return realOpen(...args);
      });
      await assert.rejects(downloadResource(f.options(() => f.response())), error => error.setupCode === 'storage' && error.diagnosticKind === kind);
      assert.equal(f.calls.length, 1); assert.equal(fs.existsSync(f.destination), false);
    });
  }
});

test('a write failure after the first chunk is still storage, even if the stream has more bytes', async t => {
  const f = fixture(t), realOpen = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await realOpen(...args);
    if (args[0] !== f.partial) return handle;
    return { close: () => handle.close(), writeFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  });
  await assert.rejects(downloadResource(f.options(() => f.response())), error => error.setupCode === 'storage' && error.diagnosticKind === 'storage-space');
  assert.equal(f.calls.length, 1);
});

test('synchronous verification read failures retain their storage attribution', async t => {
  const f = fixture(t); fs.writeFileSync(f.destination, f.bytes);
  const realRead = fs.createReadStream.bind(fs);
  t.mock.method(fs, 'createReadStream', (file, options) => {
    if (file !== f.destination) return realRead(file, options);
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  await assert.rejects(downloadResource(f.options(() => assert.fail('cannot fetch after cache read denial'))), error => error.setupCode === 'storage' && error.diagnosticKind === 'storage-permission');
});

test('cancelling while headers are pending is not presented as a timeout or connection failure', async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(downloadResource(f.options(() => {
    queueMicrotask(() => controller.abort()); return new Promise(() => {});
  }, { signal: controller.signal, requestTimeoutMs: 1000 })), error => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.diagnosticKind, undefined); assert.equal(error.httpStatus, undefined); return true;
  });
  assert.equal(f.calls.length, 1); assert.equal(fs.existsSync(f.destination), false);
});
