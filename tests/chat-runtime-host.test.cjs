'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const host = path.resolve(__dirname, '../electron/chat-runtime-host.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
// Hosted Windows can spend more than 12 seconds on its first PowerShell/Add-Type
// launch while other test files run. This allowance does not relax job cleanup.
const HOST_STARTUP_MS = 45000, WORKER_STARTUP_MS = 12000, SHUTDOWN_MS = 7000;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(check, description, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (!check() && Date.now() < deadline) await pause(25);
  assert.ok(check(), typeof description === 'function' ? description() : description);
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-chat-host-'));
  const worker = path.join(directory, 'worker with spaces.cjs'), parentScript = path.join(directory, 'parent.cjs');
  const report = path.join(directory, 'worker.json');
  const argv = ['space value', 'quote"value', 'trailing\\', '', '中文', '$(not a command); & echo no'];
  fs.writeFileSync(worker, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,args:process.argv.slice(3)})); setInterval(()=>{},1000);');
  fs.writeFileSync(parentScript, `
    const {spawn}=require('node:child_process');
    const report=value=>{if(process.connected){try{process.send(value,()=>{});}catch{}}};
    const child=spawn(process.env.TEST_POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',process.env.TEST_HOST],{
      windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ELYSIA_CHAT_SERVER:process.execPath,
        ELYSIA_CHAT_ARGS:process.env.TEST_ARGUMENTS,ELYSIA_CHAT_PARENT_PID:String(process.pid)}});
    report({type:'host-spawned',hostPid:child.pid});
    let stdout=''; child.stdout.on('data',chunk=>{stdout+=chunk;let end;while((end=stdout.indexOf('\\n'))!==-1){
      const row=stdout.slice(0,end);stdout=stdout.slice(end+1);try{const value=JSON.parse(row);report({hostPid:child.pid,...value});}catch{}}});
    child.stderr.on('data',chunk=>report({error:String(chunk).slice(-2048)}));
    child.on('error',error=>report({error:error.message}));
    child.on('exit',(code,signal)=>report({hostExit:code,signal}));
    process.on('message',message=>{if(message==='exit')process.exit(0);});
    setInterval(()=>{},1000);
  `);
  const parent = spawn(process.execPath, [parentScript], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, TEST_POWERSHELL: powershell, TEST_HOST: host, TEST_ARGUMENTS: JSON.stringify([worker, report, ...argv]) } });
  const messages = []; let owned, hostPid, parentFailure;
  parent.on('message', value => {
    messages.push(value);
    if (value.hostPid) hostPid = value.hostPid;
    if (value.type === 'started') owned = value;
  });
  parent.once('error', error => { parentFailure = error.message; });
  parent.once('exit', (code, signal) => { parentFailure = `parent exited: code=${code}, signal=${signal}`; });
  t.after(async () => {
    if (alive(parent.pid)) parent.kill();
    // Track the host before its READY packet, including a late cold start. Give
    // its parent-death guard a chance before forcing only this fixture's host.
    const deadline = Date.now() + SHUTDOWN_MS;
    while (hostPid && alive(hostPid) && Date.now() < deadline) await pause(25);
    if (hostPid && alive(hostPid)) process.kill(hostPid);
    if (owned?.pid && alive(owned.pid)) process.kill(owned.pid);
    await waitFor(() => !alive(parent.pid) && (!hostPid || !alive(hostPid)) && (!owned?.pid || !alive(owned.pid)),
      'fixture processes must exit before removing their files', SHUTDOWN_MS);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const diagnostics = () => JSON.stringify({ parentPid: parent.pid, hostPid, parentFailure, messages });
  const startupHealthy = () => {
    assert.ok(!parentFailure && !messages.some(value => value.error || Object.hasOwn(value, 'hostExit')),
      `native host exited or failed during startup: ${diagnostics()}`);
  };
  await waitFor(() => { startupHealthy(); return !!owned; },
    () => `native host did not start within ${HOST_STARTUP_MS} ms: ${diagnostics()}`, HOST_STARTUP_MS);
  await waitFor(() => { startupHealthy(); return fs.existsSync(report); },
    () => `worker did not receive its argv: ${diagnostics()}`, WORKER_STARTUP_MS);
  assert.deepEqual(JSON.parse(fs.readFileSync(report, 'utf8')).args, argv);
  return { parent, owned, messages };
}

for (const shutdown of ['normal-parent-exit', 'forced-parent-exit', 'forced-host-exit']) {
  test(`owned native worker exits after ${shutdown}, with argv preserved literally`, { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
    const f = await fixture(t);
    assert.ok(alive(f.owned.pid));
    if (shutdown === 'normal-parent-exit') f.parent.send('exit');
    if (shutdown === 'forced-parent-exit') f.parent.kill();
    if (shutdown === 'forced-host-exit') process.kill(f.owned.hostPid);
    await waitFor(() => !alive(f.owned.pid), 'the job must terminate its worker', SHUTDOWN_MS);
    await waitFor(() => !alive(f.owned.hostPid), 'the host must exit too', SHUTDOWN_MS);
  });
}

test('an absent parent fails before launching a worker', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      ELYSIA_CHAT_SERVER: process.execPath, ELYSIA_CHAT_ARGS: JSON.stringify(['-e', 'setInterval(()=>{},1000)']), ELYSIA_CHAT_PARENT_PID: '2147483647' } });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.notEqual(code, 0); assert.doesNotMatch(output, /"started"/);
});
