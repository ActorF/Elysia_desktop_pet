/** Fetch the small, pinned runtime at build time; end users receive it in the app. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { downloadResource } = require('../electron/resource-download.cjs');
const manifest = require('../electron/chat-bootstrap-manifest.json');
const directory = path.resolve(__dirname, '..', 'build-resources', 'chat-bootstrap');

function allowedRuntimeUrl(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  if (url.hostname === 'github.com') return url.pathname === new URL(manifest.runtime.url).pathname && !url.search;
  return ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
    && /^\/github-production-release-asset(?:-2e65be)?\//.test(url.pathname);
}

async function prepareChatBootstrap() {
  await fs.promises.mkdir(directory, { recursive: true });
  const destination = path.join(directory, manifest.runtime.file);
  await downloadResource({ asset: manifest.runtime, destination,
    sources: [manifest.runtime.url], signal: new AbortController().signal,
    isAllowedUrl: allowedRuntimeUrl });
  console.log(`Verified bundled chat runtime: ${path.relative(path.dirname(__dirname), destination)}`);
  return destination;
}

if (require.main === module) prepareChatBootstrap().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { prepareChatBootstrap };
