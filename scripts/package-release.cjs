/** Build the approved local release; publishing always remains an explicit separate action. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const builder = require('electron-builder');
const { prepareChatBootstrap } = require('./prepare-chat-bootstrap.cjs');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'build-resources', 'voice-bootstrap');
for (const relative of ['Elysia-voice-assets-v1.zip', 'tools/7za.exe', 'tools/LICENSE.txt', 'tools/COPYING']) {
  if (!fs.existsSync(path.join(resources, relative))) throw new Error(`Missing local build resource ${relative}; run npm run prepare:voice first.`);
}
const targets = process.argv.includes('--portable') ? ['portable'] : process.argv.includes('--setup') ? ['nsis'] : ['portable', 'nsis'];
// Pinned builder 26.15.3 uses true to omit UNPACK_DIR_NAME and extract each
// portable launch under its own $PLUGINSDIR. Its type comment says otherwise;
// the packaged relaunch regression verifies the actual behavior.
// Reuse the pinned Windows Electron already installed for local development.
// Avoid downloading a second distribution or filling the system-drive cache.
const localElectron = process.platform === 'win32' ? require('electron') : null;
const config = localElectron && fs.existsSync(localElectron) ? {
  electronDist: path.dirname(localElectron),
  afterPack: async ({ appOutDir }) => {
    const output = path.resolve(appOutDir), allowed = path.join(root, 'release');
    const relative = path.relative(allowed, output);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw new Error('Unexpected application output directory.');
    // Custom Electron distributions retain their demo app; remove it only from
    // the generated release tree, keeping the development runtime untouched.
    for (const name of ['resources/default_app.asar', 'version']) {
      const file = path.join(output, name);
      try {
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected generated Electron resource.');
        await fs.promises.unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  },
} : {};
prepareChatBootstrap().then(() => builder.build({ targets: builder.Platform.WINDOWS.createTarget(targets), config, publish: 'never' }))
  .catch(error => { console.error(error); process.exitCode = 1; });
