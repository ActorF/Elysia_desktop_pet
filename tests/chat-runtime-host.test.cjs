'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const host = path.resolve(__dirname, '../electron/chat-runtime-host.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(check, description, milliseconds = 12000) {
  const deadline = Date.now() + milliseconds;
  while (!check() && Date.now() < deadline) await pause(25);
  assert.ok(check(), description);
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-chat-host-'));
  const worker = path.join(directory, 'worker with spaces.cjs'), parentScript = path.join(directory, 'parent.cjs');
  const report = path.join(directory, 'worker.json');
  const argv = ['space value', 'quote"value', 'trailing\\', '', '中文', '$(not a command); & echo no'];
  fs.writeFileSync(worker, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,args:process.argv.slice(3)})); setInterval(()=>{},1000);');
  fs.writeFileSync(parentScript, `
    const {spawn}=require('node:child_process');
    const child=spawn(process.env.TEST_POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',process.env.TEST_HOST],{
      windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ELYSIA_CHAT_SERVER:process.execPath,
        ELYSIA_CHAT_ARGS:process.env.TEST_ARGUMENTS,ELYSIA_CHAT_PARENT_PID:String(process.pid)}});
    let stdout=''; child.stdout.on('data',chunk=>{stdout+=chunk;let end;while((end=stdout.indexOf('\\n'))!==-1){
      const row=stdout.slice(0,end);stdout=stdout.slice(end+1);try{const value=JSON.parse(row);process.send({hostPid:child.pid,...value});}catch{}}});
    child.stderr.on('data',chunk=>process.send({error:String(chunk)}));
    child.on('error',error=>process.send({error:error.message}));
    child.on('exit',code=>process.send({hostExit:code}));
    process.on('message',message=>{if(message==='exit')process.exit(0);});
    setInterval(()=>{},1000);
  `);
  const parent = spawn(process.execPath, [parentScript], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, TEST_POWERSHELL: powershell, TEST_HOST: host, TEST_ARGUMENTS: JSON.stringify([worker, report, ...argv]) } });
  const messages = []; parent.on('message', value => messages.push(value));
  let owned;
  t.after(async () => {
    if (alive(parent.pid)) parent.kill();
    if (owned?.hostPid && alive(owned.hostPid)) process.kill(owned.hostPid);
    await pause(500);
    if (owned?.pid && alive(owned.pid)) process.kill(owned.pid);
    await pause(100); fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitFor(() => messages.some(value => value.type === 'started') || messages.some(value => value.error || value.hostExit !== undefined), 'host should start promptly');
  owned = messages.find(value => value.type === 'started');
  assert.ok(owned, JSON.stringify(messages));
  await waitFor(() => fs.existsSync(report), 'worker should receive its argv');
  assert.deepEqual(JSON.parse(fs.readFileSync(report, 'utf8')).args, argv);
  return { parent, owned, messages };
}

for (const shutdown of ['normal-parent-exit', 'forced-parent-exit', 'forced-host-exit']) {
  test(`owned native worker exits after ${shutdown}, with argv preserved literally`, { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
    const f = await fixture(t);
    assert.ok(alive(f.owned.pid));
    if (shutdown === 'normal-parent-exit') f.parent.send('exit');
    if (shutdown === 'forced-parent-exit') f.parent.kill();
    if (shutdown === 'forced-host-exit') process.kill(f.owned.hostPid);
    await waitFor(() => !alive(f.owned.pid), 'the job must terminate its worker', 7000);
    await waitFor(() => !alive(f.owned.hostPid), 'the host must exit too', 7000);
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
