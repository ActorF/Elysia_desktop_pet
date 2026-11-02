/** Digest-pinned downloads with resumable partials and ordered, allowlisted mirrors. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const failure = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined), { setupCode: code });
const cancelled = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw cancelled(); };
const ordinary = stat => stat?.isFile() && !stat.isSymbolicLink();
async function io(operation) {
  try { return await operation(); } catch (error) { throw error.setupCode ? error : failure('storage', error); }
}
async function stat(file) {
  try { return await fs.promises.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw failure('storage', error); }
}

/** Missing, non-regular, wrong-sized or mismatched files return false; I/O errors are not a cache miss. */
async function verifyResource(file, asset, signal) {
  checkAbort(signal);
  const existing = await stat(file);
  if (!ordinary(existing) || existing.size !== asset.bytes) return false;
  const hash = createHash('sha256');
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
  const stop = () => stream.destroy(cancelled());
  signal?.addEventListener('abort', stop, { once: true });
  try {
    checkAbort(signal);
    for await (const chunk of stream) { checkAbort(signal); hash.update(chunk); }
    checkAbort(signal);
    return hash.digest('hex') === asset.sha256.toLowerCase();
  } catch (error) {
    checkAbort(signal);
    throw error.setupCode ? error : failure('storage', error);
  } finally { signal?.removeEventListener('abort', stop); stream.destroy(); }
}

function discardBody(response) {
  // Cancellation must not make timeout handling wait for a misbehaving transport.
  try { void response?.body?.cancel().catch(() => {}); } catch {}
}

/** Race even injected transports that ignore AbortSignal; dispose all our timers/listeners. */
function bounded(promise, signal, timeoutMs, onTimeout, onLateValue = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(failure('download'));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { finish(failure('download')); onTimeout(); }, timeoutMs);
    Promise.resolve(promise).then(value => {
      if (settled) { onLateValue(value); return; }
      finish(null, value);
    }, error => finish(error));
    if (signal.aborted) abort();
  });
}

async function downloadResource({ asset, destination, sources = asset?.sources ?? [asset?.url],
  fetchImpl = globalThis.fetch, signal = new AbortController().signal, isAllowedUrl,
  preserveInvalidDestination = true,
  onProgress = () => {}, onVerify = () => {}, onSourceChange = () => {},
  requestTimeoutMs = 15000, idleTimeoutMs = 30000, downloadTimeoutMs = 4 * 60 * 60 * 1000 } = {}) {
  if (!asset || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !/^[a-f0-9]{64}$/i.test(asset.sha256)
    || typeof destination !== 'string' || !path.isAbsolute(destination) || typeof isAllowedUrl !== 'function'
    || typeof preserveInvalidDestination !== 'boolean'
    || ![requestTimeoutMs, idleTimeoutMs, downloadTimeoutMs].every(ms => Number.isSafeInteger(ms) && ms > 0 && ms <= 0x7fffffff)) {
    throw new TypeError('A pinned resource, absolute destination, URL policy and positive timeouts are required.');
  }
  checkAbort(signal);
  const existing = await stat(destination);
  if (existing && !ordinary(existing)) throw failure('storage');
  if (existing) {
    onVerify();
    if (await verifyResource(destination, asset, signal)) return destination;
    checkAbort(signal);
    // Chat models may be user-imported. Callers with an exclusively app-owned,
    // hash-named cache can opt out to avoid retaining multi-GB corrupt archives.
    if (preserveInvalidDestination) await io(() => fs.promises.rename(destination, `${destination}.unverified-${randomUUID()}`));
    else await io(() => fs.promises.unlink(destination));
  }
  const partial = destination + '.part';
  async function partialSize() {
    const item = await stat(partial);
    if (item && !ordinary(item)) throw failure('storage');
    return item?.size || 0;
  }
  async function removePartial() {
    const item = await stat(partial);
    if (!item) return;
    if (!ordinary(item)) throw failure('storage');
    await io(() => fs.promises.unlink(partial));
  }
  async function commit() {
    checkAbort(signal);
    // A concurrently-created destination is not ours to overwrite.
    if (await stat(destination)) throw failure('storage');
    await io(() => fs.promises.rename(partial, destination));
    return destination;
  }
  async function completePartial(checkSignal) {
    const size = await partialSize();
    if (size > asset.bytes) { await removePartial(); return false; }
    if (size !== asset.bytes) return false;
    onVerify();
    if (await verifyResource(partial, asset, checkSignal)) return true;
    await removePartial();
    return false;
  }
  if (await completePartial(signal)) return commit();
  if (!Array.isArray(sources) || sources.length === 0 || sources.some(source => typeof source !== 'string')) throw failure('download');

  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(), downloadTimeoutMs);
  const restartedSources = new Set();
  let lastError = failure('download');
  try {
    for (let index = 0; index < sources.length; index++) {
      checkAbort(signal);
      if (total.signal.aborted) throw failure('download');
      const attempt = new AbortController();
      const combined = AbortSignal.any([signal, total.signal, attempt.signal]);
      let response, reader, handle, discardPartial = false;
      try {
        if (await completePartial(combined)) return await commit();
        const source = new URL(sources[index]);
        if (index > 0) onSourceChange({ index, url: source.href });
        let current = source, completed = await partialSize();
        const requestedOffset = completed;
        for (let redirects = 0; redirects <= 8; redirects++) {
          if (!isAllowedUrl(current, source)) throw failure('download');
          const headers = { 'Accept-Encoding': 'identity', ...(completed ? { Range: `bytes=${completed}-` } : {}) };
          response = await bounded(
            Promise.resolve().then(() => fetchImpl(current.href, { signal: combined, redirect: 'manual', headers })),
            combined, requestTimeoutMs, () => attempt.abort(), discardBody);
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location'); discardBody(response); response = null;
          if (!location || redirects === 8) throw failure('download');
          current = new URL(location, current);
        }
        if (!response?.ok || !response.body) throw failure('download');
        if (response.status === 206) {
          if (response.headers.get('content-range') !== `bytes ${completed}-${asset.bytes - 1}/${asset.bytes}`) throw failure('download');
        } else if (response.status === 200) completed = 0;
        else throw failure('download');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.bytes - completed)) throw failure('integrity');
        // A partial changed while waiting for headers must not be appended/truncated by this operation.
        if (await partialSize() !== requestedOffset) throw failure('storage');
        checkAbort(signal);
        handle = await io(() => fs.promises.open(partial, completed ? 'a' : 'w', 0o600));
        reader = response.body.getReader();
        onProgress(completed, asset.bytes);
        for (;;) {
          const result = await bounded(reader.read(), combined, idleTimeoutMs, () => attempt.abort());
          checkAbort(signal);
          if (total.signal.aborted) throw failure('download');
          if (result.done) break;
          if (!(result.value instanceof Uint8Array)) throw failure('download');
          if (completed + result.value.length > asset.bytes) { discardPartial = true; throw failure('integrity'); }
          await io(() => handle.writeFile(result.value));
          completed += result.value.length;
          onProgress(completed, asset.bytes);
        }
        await io(() => handle.close()); handle = null;
        if (completed !== asset.bytes) throw failure('download');
        onVerify();
        if (!await verifyResource(partial, asset, combined)) {
          await removePartial();
          throw Object.assign(failure('integrity'), { restartSource: requestedOffset > 0 });
        }
        if (total.signal.aborted) throw failure('download');
        return await commit();
      } catch (error) {
        checkAbort(signal);
        if (error.setupCode === 'storage') throw error;
        if (total.signal.aborted) throw failure('download');
        lastError = error.setupCode ? error : failure('download', error);
        // The prefix may have come from a broken mirror or an interrupted older run.
        // Retry this source once from zero rather than carrying bad bytes to every mirror.
        if (error.restartSource && !restartedSources.has(index)) { restartedSources.add(index); index--; }
      } finally {
        attempt.abort();
        if (reader) {
          try { void reader.cancel().catch(() => {}); } catch {}
          try { reader.releaseLock(); } catch {}
        } else discardBody(response);
        if (handle) await io(() => handle.close());
        if (discardPartial) await removePartial();
      }
    }
    throw lastError;
  } finally { clearTimeout(totalTimer); }
}

module.exports = { downloadResource, verifyResource };
