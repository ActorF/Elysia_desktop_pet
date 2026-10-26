/** Build the approved local release; publishing always remains an explicit separate action. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const builder = require('electron-builder');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'build-resources', 'voice-bootstrap');
for (const relative of ['Elysia-voice-assets-v1.zip', 'tools/7za.exe', 'tools/LICENSE.txt', 'tools/COPYING']) {
  if (!fs.existsSync(path.join(resources, relative))) throw new Error(`Missing local build resource ${relative}; run npm run prepare:voice first.`);
}
const targets = process.argv.includes('--portable') ? ['portable'] : process.argv.includes('--setup') ? ['nsis'] : ['portable', 'nsis'];
// Pinned builder 26.15.3 uses true to omit UNPACK_DIR_NAME and extract each
// portable launch under its own $PLUGINSDIR. Its type comment says otherwise;
// the packaged relaunch regression verifies the actual behavior.
builder.build({ targets: builder.Platform.WINDOWS.createTarget(targets), publish: 'never' })
  .catch(error => { console.error(error); process.exitCode = 1; });
