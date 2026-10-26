/** Generate the Windows icon from exactly the same crop used by the native tray. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { nativeImage, app } = require('electron');
  const { createAppImage } = require('../electron/tray-icon.cjs');
  try {
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const frames = sizes.map(size => createAppImage(nativeImage, size).toPNG());
    const directory = Buffer.alloc(6 + 16 * frames.length);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(frames.length, 4);
    let offset = directory.length;
    frames.forEach((frame, index) => {
      const entry = 6 + index * 16;
      directory[entry] = directory[entry + 1] = sizes[index] % 256;
      directory.writeUInt16LE(1, entry + 4);
      directory.writeUInt16LE(32, entry + 6);
      directory.writeUInt32LE(frame.length, entry + 8);
      directory.writeUInt32LE(offset, entry + 12);
      offset += frame.length;
    });
    const destination = path.join(__dirname, '..', 'assets', 'ui', 'app-icon.ico');
    fs.writeFileSync(destination, Buffer.concat([directory, ...frames]));
    console.log(`Windows icon: ${sizes.join(', ')} px; ${offset} bytes.`);
    app.exit(0);
  } catch (error) { console.error(error.message); app.exit(1); }
}
