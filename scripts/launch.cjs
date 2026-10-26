// Start the independent app using this project's pinned Electron runtime.
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
let executable;
try { executable = require('electron'); } catch {}
if (!executable) {
  console.error('请先在项目目录运行 npm ci，然后运行 npm start。');
  process.exit(1);
}
if(process.platform==='darwin'){
  try{require('./build-macos-helper.cjs').buildMacHelper();}
  catch(error){console.error(error.message);}
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [path.resolve(__dirname, '..'), ...process.argv.slice(2)], {
  env, stdio: 'inherit', windowsHide: true,
});
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 0));
