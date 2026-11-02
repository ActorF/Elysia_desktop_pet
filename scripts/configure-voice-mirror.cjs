/** Verify a real public mirror before pinning it; default mode never changes the manifest. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ROOT, containedPath, loadRuntime } = require('./prepare-voice-mirror.cjs');
const USER_AGENT = 'Elysia-Voice-Mirror-Check/1.0';

function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(repo)) {
    throw new Error('Use a real ModelScope repository in owner/name form.');
  }
  return repo;
}

function verifyMetadata(payload, runtime) {
  if (payload?.Success !== true || payload.Code !== 200 || !Array.isArray(payload.Data?.Files)) throw new Error('Public repository metadata is unavailable.');
  const entries = payload.Data.Files.filter(file => file.Path === runtime.fileName && file.Name === runtime.fileName);
  if (entries.length !== 1) throw new Error('The mirror must contain exactly one matching archive at its root.');
  const file = entries[0];
  if (file.Size !== runtime.bytes || typeof file.Sha256 !== 'string' || file.Sha256.toLowerCase() !== runtime.sha256
    || typeof file.Revision !== 'string' || !/^[a-f0-9]{40}$/.test(file.Revision)) {
    throw new Error('Mirror file size, SHA256, or immutable revision does not match the pinned archive.');
  }
  return file.Revision;
}

async function readMetadata(response, signal) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Public repository metadata request failed.'); }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > 2 * 1024 * 1024) { await response.body.cancel(); throw new Error('Repository metadata exceeds the permitted size.'); }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error('Metadata request timed out.');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('Metadata request timed out.');
      if (done) break;
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('Repository metadata exceeds the permitted size.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function allowedMirrorUrl(url, source, runtime) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  if (url.hostname === 'www.modelscope.cn') return url.pathname === source.pathname && !url.search;
  const hash = runtime.sha256;
  return url.hostname === 'cdn-lfs-cn-1.modelscope.cn'
    && url.pathname === `/prod/lfs-objects/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`;
}

async function probePublicRange(sourceUrl, runtime, fetchImpl = globalThis.fetch) {
  const source = new URL(sourceUrl), signal = AbortSignal.timeout(15000);
  let current = source;
  for (let count = 0; count <= 8; count++) {
    if (!allowedMirrorUrl(current, source, runtime)) throw new Error('Mirror redirects outside the permitted resource.');
    const response = await fetchImpl(current.href, { method: 'GET', redirect: 'manual', signal, credentials: 'omit',
      headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT } });
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || count === 8) throw new Error('Invalid or excessive mirror redirects.');
        current = new URL(location, current);
        continue;
      }
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes 0-0/${runtime.bytes}`
        || (response.headers.has('content-length') && response.headers.get('content-length') !== '1')) {
        throw new Error('Mirror does not provide the expected anonymous one-byte Range response.');
      }
      if (!response.body) throw new Error('Mirror Range response contains no data.');
      const reader = response.body.getReader();
      const stop = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', stop, { once: true });
      try {
        if (signal.aborted) throw new Error('Mirror Range request timed out.');
        const { done, value } = await reader.read();
        if (signal.aborted) throw new Error('Mirror Range request timed out.');
        if (done || !(value instanceof Uint8Array) || value.length !== 1) {
          throw new Error('Mirror did not transfer the requested one-byte body.');
        }
      } finally {
        signal.removeEventListener('abort', stop);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
}

async function configureVoiceMirror({ repo, apply = false, root = ROOT, fetchImpl = globalThis.fetch } = {}) {
  validateRepo(repo);
  const { runtime, manifest, manifestPath, raw } = loadRuntime(root);
  const metadataUrl = `https://www.modelscope.cn/api/v1/models/${repo}/repo/files?Revision=master&Recursive=true`;
  const signal = AbortSignal.timeout(15000);
  const response = await fetchImpl(metadataUrl, { method: 'GET', redirect: 'error', signal, credentials: 'omit', headers: { 'User-Agent': USER_AGENT } });
  const revision = verifyMetadata(await readMetadata(response, signal), runtime);
  const source = `https://www.modelscope.cn/models/${repo}/resolve/${revision}/${runtime.fileName}`;
  await probePublicRange(source, runtime, fetchImpl);
  const sources = [source, runtime.url];
  const result = { action: apply ? 'applied' : 'dry-run', repo, file: runtime.fileName, bytes: runtime.bytes,
    sha256: runtime.sha256, revision, sources };
  if (!apply) return result;
  containedPath(root, path.relative(root, manifestPath));
  if (fs.readFileSync(manifestPath, 'utf8') !== raw) throw new Error('Voice manifest changed during verification; nothing was written.');
  manifest.runtime.sources = sources;
  const temporary = containedPath(root, `electron/voice-bootstrap-manifest.json.mirror-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    containedPath(root, path.relative(root, manifestPath));
    if (fs.readFileSync(manifestPath, 'utf8') !== raw) throw new Error('Voice manifest changed during verification; nothing was written.');
    await fs.promises.rename(temporary, manifestPath);
  } finally { await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('Usage: node scripts/configure-voice-mirror.cjs --repo owner/name [--apply]\nDefault: verify public metadata and a one-byte Range response, then show the proposed sources. --apply updates only the voice manifest.');
  else {
    const repoIndex = args.indexOf('--repo');
    const valid = repoIndex >= 0 && args[repoIndex + 1] && args.filter(arg => arg === '--repo').length === 1
      && args.filter(arg => arg === '--apply').length <= 1 && args.every((arg, index) => index === repoIndex + 1 || arg === '--repo' || arg === '--apply');
    if (!valid) { console.error('Use --repo owner/name, optionally followed by --apply.'); process.exitCode = 1; }
    else configureVoiceMirror({ repo: args[repoIndex + 1], apply: args.includes('--apply') }).then(result => console.log(JSON.stringify(result, null, 2)))
      .catch(() => { console.error('Mirror verification/configuration failed; no unverified source was enabled. Check the public repository and its pinned archive.'); process.exitCode = 1; });
  }
}

module.exports = { validateRepo, verifyMetadata, probePublicRange, configureVoiceMirror };
