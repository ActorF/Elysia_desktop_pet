/** Explicit release-maintainer tool; never run by the app or the normal build. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { downloadResource } = require('../electron/resource-download.cjs');
const ROOT = path.resolve(__dirname, '..');
const FILE_NAME = 'GPT-SoVITS-v2-240821.7z';

function containedPath(root, relative) {
  root = path.resolve(root);
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error('Path is outside the project.');
  if (fs.realpathSync(root) !== root) throw new Error('Project root must not be a link.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked paths are not allowed.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

function loadRuntime(root = ROOT) {
  const manifestPath = containedPath(root, 'electron/voice-bootstrap-manifest.json');
  if (!fs.statSync(manifestPath).isFile() || fs.statSync(manifestPath).size > 65536) throw new Error('Invalid voice manifest file.');
  const raw = fs.readFileSync(manifestPath, 'utf8'), manifest = JSON.parse(raw), runtime = manifest.runtime;
  if (runtime?.fileName !== FILE_NAME || !Number.isSafeInteger(runtime.bytes) || runtime.bytes <= 0 || runtime.bytes > 12 * 1024 ** 3
    || !/^[a-f0-9]{64}$/.test(runtime.sha256) || typeof runtime.url !== 'string') throw new Error('Invalid pinned voice runtime.');
  const source = new URL(runtime.url);
  if (source.protocol !== 'https:' || source.hostname !== 'huggingface.co' || source.username || source.password || source.port || source.search || source.hash
    || !new RegExp(`^/lj1995/GPT-SoVITS-windows-package/resolve/[a-f0-9]{40}/${FILE_NAME.replaceAll('.', '\\.')}$`).test(source.pathname)) {
    throw new Error('The runtime must retain its pinned original upstream URL.');
  }
  return { manifestPath, raw, manifest, runtime };
}

function renderReadme(runtime) {
  return [
    '---', 'license: mit', '---', '', '# GPT-SoVITS Windows runtime mirror', '',
    'This repository mirrors the original upstream Windows archive without modifying its bytes.',
    'It contains no Elysia user data, character artwork, personal voice profiles, or chat history.', '',
    `- File: ${runtime.fileName}`, `- Bytes: ${runtime.bytes}`, `- SHA256: ${runtime.sha256}`,
    `- Original download: ${runtime.url}`, '- Upstream project: https://github.com/RVC-Boss/GPT-SoVITS', '',
    'GPT-SoVITS is distributed under the upstream MIT license. Bundled components retain their own licenses and notices inside the original archive.', '',
  ].join('\n');
}

function allowedOriginal(url, original) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  if (url.hostname === 'huggingface.co') return url.pathname === new URL(original).pathname && !url.search;
  return ['cdn-lfs.huggingface.co', 'cdn-lfs-us-1.hf.co', 'cdn-lfs-eu-1.hf.co', 'cdn-lfs.hf.co', 'cas-bridge.xethub.hf.co'].includes(url.hostname)
    || url.hostname === 'cdn.hf.co' || url.hostname.endsWith('.cdn.hf.co');
}

async function prepareVoiceMirror({ root = ROOT, download = false, fetchImpl = globalThis.fetch, signal = new AbortController().signal } = {}) {
  const { runtime } = loadRuntime(root);
  const directory = containedPath(root, 'build-resources/voice-mirror');
  const archive = containedPath(root, `build-resources/voice-mirror/${runtime.fileName}`);
  const readme = containedPath(root, 'build-resources/voice-mirror/README.md');
  const plan = { action: download ? 'prepare' : 'dry-run', originalUrl: runtime.url, bytes: runtime.bytes,
    sha256: runtime.sha256, files: [archive, readme] };
  if (!download) return plan;
  await fs.promises.mkdir(directory, { recursive: true });
  containedPath(root, 'build-resources/voice-mirror');
  await downloadResource({ asset: runtime, destination: archive, sources: [runtime.url], fetchImpl, signal,
    preserveInvalidDestination: false, isAllowedUrl: (url, source) => allowedOriginal(url, source) });
  containedPath(root, 'build-resources/voice-mirror/README.md');
  await fs.promises.writeFile(readme, renderReadme(runtime), { encoding: 'utf8', mode: 0o600 });
  return plan;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('Usage: node scripts/prepare-voice-mirror.cjs [--download]\nDefault: show exact files only. --download prepares the pinned 5.74 GB archive in project build-resources/voice-mirror.');
  else if (args.some(arg => arg !== '--download') || args.length > 1) { console.error('Only --download or --help is supported.'); process.exitCode = 1; }
  else prepareVoiceMirror({ download: args.includes('--download') }).then(plan => console.log(JSON.stringify(plan, null, 2)))
    .catch(error => { console.error(error.setupCode ? `Voice mirror preparation failed: ${error.setupCode}` : error.message); process.exitCode = 1; });
}

module.exports = { ROOT, FILE_NAME, containedPath, loadRuntime, renderReadme, prepareVoiceMirror };
