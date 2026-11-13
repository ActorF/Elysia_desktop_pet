/** Fixed release locations; an explicit fresh build never reuses an older output tree. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function resolveReleaseOutput({ root, manifest, env = process.env, requireFresh = false }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)
    || typeof manifest?.version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(manifest.version)) {
    throw new Error('A workspace and stable release version are required.');
  }
  root = path.resolve(root);
  const release = path.join(root, 'release'), expected = path.join(release, `build-v${manifest.version}`);
  const override = env.ELYSIA_RELEASE_OUTPUT;
  const configured = override === undefined ? manifest.build?.directories?.output : override;
  if (typeof configured !== 'string' || !configured || configured.includes('\0')
    || configured.split(/[\\/]/).some(part => part === '.' || part === '..')) throw new Error('Invalid release output path.');
  const output = path.resolve(root, configured), allowed = override === undefined ? release : expected;
  const equal = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!equal(output, allowed)) throw new Error('Release output must be release or the current version\'s dedicated build directory.');
  // Check every existing component, including the workspace and its ancestors.
  // Missing components are created later by the builder, never by a verifier.
  for (let current = output; ; current = path.dirname(current)) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Release output must use ordinary directories without links.');
    if (path.dirname(current) === current) break;
  }
  if (requireFresh && override !== undefined && fs.existsSync(output) && fs.readdirSync(output).length !== 0) {
    throw new Error('Dedicated release output is not empty; existing build files were preserved.');
  }
  return output;
}

module.exports = { resolveReleaseOutput };
