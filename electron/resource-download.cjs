/** Digest-pinned downloads with resumable partials and ordered, allowlisted mirrors. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function causeCodes(error) {
  const codes = [], seen = new Set();
  for (let depth = 0; error && typeof error === 'object' && depth < 6 && !seen.has(error); depth++, error = error.cause) {
    seen.add(error);
    if (typeof error.code === 'string') codes.push(error.code);
  }
  return codes;
}
function storageKind(error) {
  const codes = causeCodes(error);
  if (codes.some(code => ['ENOSPC', 'EDQUOT'].includes(code))) return 'storage-space';
  if (codes.some(code => ['EACCES', 'EPERM', 'EROFS'].includes(code))) return 'storage-permission';
  if (codes.some(code => ['EBUSY', 'ETXTBSY', 'EEXIST'].includes(code))) return 'storage-busy';
  if (codes.some(code => ['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'ELOOP', 'EINVAL'].includes(code))) return 'storage-path';
  return 'storage-io';
}
function networkKind(error) {
  const codes = causeCodes(error);
  if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(code))) return 'network-dns';
  if (codes.some(code => /^(?:CERT_|ERR_TLS_|ERR_SSL_)/.test(code)
    || ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))) return 'network-tls';
  if (codes.includes('UND_ERR_BODY_TIMEOUT')) return 'network-idle-timeout';
  if (codes.some(code => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code))) return 'network-timeout';
  if (codes.some(code => ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE', 'UND_ERR_SOCKET'].includes(code))) return 'network-connect';
  return 'network-unknown';
}
const failure = (code, cause, diagnosticKind = code === 'storage' ? storageKind(cause) : code === 'download' ? networkKind(cause) : 'integrity-hash', details = {}) =>
  Object.assign(new Error(code, cause ? { cause } : undefined), { setupCode: code, diagnosticKind, ...details });
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
  let stream;
  const stop = () => stream?.destroy(cancelled());
  signal?.addEventListener('abort', stop, { once: true });
  try {
    checkAbort(signal);
    stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) { checkAbort(signal); hash.update(chunk); }
    checkAbort(signal);
    return hash.digest('hex') === asset.sha256.toLowerCase();
  } catch (error) {
    checkAbort(signal);
    throw error.setupCode ? error : failure('storage', error);
  } finally { signal?.removeEventListener('abort', stop); stream?.destroy(); }
}

function discardBody(response) {
  // Cancellation must not make timeout handling wait for a misbehaving transport.
  try { void response?.body?.cancel().catch(() => {}); } catch {}
}

/** Race even injected transports that ignore AbortSignal; dispose all our timers/listeners. */
function bounded(promise, signal, timeoutMs, onTimeout, onLateValue = () => {}, timeoutKind = 'network-timeout') {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(failure('download'));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { finish(failure('download', null, timeoutKind)); onTimeout(); }, timeoutMs);
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
  if (existing && !ordinary(existing)) throw failure('storage', null, 'storage-path');
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
    if (item && !ordinary(item)) throw failure('storage', null, 'storage-path');
    return item?.size || 0;
  }
  async function removePartial() {
    const item = await stat(partial);
    if (!item) return;
    if (!ordinary(item)) throw failure('storage', null, 'storage-path');
    await io(() => fs.promises.unlink(partial));
  }
  async function commit() {
    checkAbort(signal);
    // A concurrently-created destination is not ours to overwrite.
    if (await stat(destination)) throw failure('storage', null, 'storage-busy');
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
      if (total.signal.aborted) throw failure('download', null, 'network-total-timeout');
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
          if (!isAllowedUrl(current, source)) throw failure('download', null, 'network-redirect');
          const headers = { 'Accept-Encoding': 'identity', ...(completed ? { Range: `bytes=${completed}-` } : {}) };
          response = await bounded(
            Promise.resolve().then(() => fetchImpl(current.href, { signal: combined, redirect: 'manual', headers })),
            combined, requestTimeoutMs, () => attempt.abort(), discardBody);
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location'); discardBody(response); response = null;
          if (!location || redirects === 8) throw failure('download', null, 'network-redirect');
          try { current = new URL(location, current); } catch (error) { throw failure('download', error, 'network-redirect'); }
        }
        if (!response?.ok) {
          const status = response?.status;
          throw Number.isInteger(status) && status >= 100 && status <= 599
            ? failure('download', null, 'network-http', { httpStatus: status }) : failure('download');
        }
        if (!response.body) throw failure('download', null, 'network-truncated');
        if (response.status === 206) {
          if (response.headers.get('content-range') !== `bytes ${completed}-${asset.bytes - 1}/${asset.bytes}`) throw failure('download', null, 'network-range');
        } else if (response.status === 200) completed = 0;
        else throw failure('download', null, 'network-http', { httpStatus: response.status });
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.bytes - completed)) throw failure('integrity', null, 'integrity-size');
        // A partial changed while waiting for headers must not be appended/truncated by this operation.
        if (await partialSize() !== requestedOffset) throw failure('storage', null, 'storage-busy');
        checkAbort(signal);
        handle = await io(() => fs.promises.open(partial, completed ? 'a' : 'w', 0o600));
        reader = response.body.getReader();
        onProgress(completed, asset.bytes);
        for (;;) {
          const result = await bounded(reader.read(), combined, idleTimeoutMs, () => attempt.abort(), undefined, 'network-idle-timeout');
          checkAbort(signal);
          if (total.signal.aborted) throw failure('download', null, 'network-total-timeout');
          if (result.done) break;
          if (!(result.value instanceof Uint8Array)) throw failure('download');
          if (completed + result.value.length > asset.bytes) { discardPartial = true; throw failure('integrity', null, 'integrity-size'); }
          await io(() => handle.writeFile(result.value));
          completed += result.value.length;
          onProgress(completed, asset.bytes);
        }
        await io(() => handle.close()); handle = null;
        if (completed !== asset.bytes) throw failure('download', null, 'network-truncated');
        onVerify();
        if (!await verifyResource(partial, asset, combined)) {
          await removePartial();
          throw Object.assign(failure('integrity'), { restartSource: requestedOffset > 0 });
        }
        if (total.signal.aborted) throw failure('download', null, 'network-total-timeout');
        return await commit();
      } catch (error) {
        checkAbort(signal);
        if (error.setupCode === 'storage') throw error;
        if (total.signal.aborted) throw failure('download', null, 'network-total-timeout');
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
