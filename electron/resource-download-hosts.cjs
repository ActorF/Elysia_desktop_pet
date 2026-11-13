'use strict';

// Official HF-owned CDN/LFS hosts, checked 2026-11-13 against:
// https://huggingface.co/.well-known/meta.json
// https://huggingface.co/docs/hub/main/models-downloading
// Keep observed legacy hosts, but do not allow generic S3 or *.hf.co domains.
// This static policy never fetches a mutable allowlist during installation.
const huggingFaceDownloadHosts = new Set([
  'cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co', 'cdn-lfs-eu-1.hf.co',
  'transfer.xethub.hf.co', 'transfer.xethub-eu.hf.co',
  'aws.cdn.hf.co', 'us.aws.cdn.hf.co', 'us-east-1.aws.cdn.hf.co', 'us-west-2.aws.cdn.hf.co',
  'eu-west-3.aws.cdn.hf.co', 'ap-southeast-1.aws.cdn.hf.co',
  'us.gcp.cdn.hf.co', 'us-east1.us.gcp.cdn.hf.co', 'us-central1.us.gcp.cdn.hf.co',
  'us-west4.us.gcp.cdn.hf.co', 'europe-west4.us.gcp.cdn.hf.co', 'asia-southeast1.us.gcp.cdn.hf.co',
  'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co', 'cdn.hf.co',
]);

module.exports = { isHuggingFaceDownloadHost: hostname => huggingFaceDownloadHosts.has(hostname) };
