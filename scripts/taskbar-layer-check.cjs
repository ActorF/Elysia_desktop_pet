/** Native Windows integration for taskbar-relative layering. Run with Node. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`${name} requires a path.`);
  return process.argv[index + 1];
}
const appArchive = argument('--app-archive');
if (appArchive && !path.isAbsolute(appArchive)) throw new Error('--app-archive must be an absolute app.asar path.');
const runtimeRoot = appArchive || root;
const reportPath = path.resolve(argument('--report') || path.join(root, 'artifacts', 'taskbar-layer-check.json'));
const workerFlag = '--taskbar-layer-check-worker';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function launch() {
  if (process.platform !== 'win32') throw new Error('This native integration check requires Windows.');
  const executable = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [__filename, workerFlag, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}

function startProbe(hwnd) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'taskbar-order-probe.ps1'), '-TargetHwnd', hwnd, '-OwnerProcessId', String(process.pid)],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, stderr = '', closed = false, readyResolve, readyReject;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startupTimer = setTimeout(() => readyReject(new Error('Win32 probe startup timed out.')), 15000);
  function rejectPending(error) {
    readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-5000); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line.replace(/^\uFEFF/, '')); }
    catch { rejectPending(new Error(`Invalid probe response: ${line}`)); return; }
    if (response.ready) { clearTimeout(startupTimer); readyResolve(); return; }
    const item = pending.get(response.sequence);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(response.sequence);
    if (response.error) item.reject(new Error(response.error)); else item.resolve(response.snapshot);
  });
  child.once('error', rejectPending);
  child.once('exit', code => {
    clearTimeout(startupTimer);
    if (!closed) rejectPending(new Error(`Win32 probe exited (${code}): ${stderr}`));
  });
  return {
    ready,
    async read(action = 'snapshot', peerHwnd = null, peerProcessId = process.pid) {
      await ready;
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Win32 probe response timed out.')); }, 5000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ sequence: id, action, peerHwnd, peerProcessId }) + '\n');
      });
    },
    async close() {
      closed = true; clearTimeout(startupTimer); child.stdin.end();
      if (child.exitCode === null) await Promise.race([
        new Promise(resolve => child.once('exit', resolve)), delay(1000),
      ]);
      if (child.exitCode === null) child.kill();
      lines.close();
    },
  };
}

async function startExternalPeer() {
  const temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-taskbar-peer-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(__dirname, 'taskbar-layer-peer.cjs'), '--profile', temporaryProfile],
    { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', nextSequence = 0, readyResolve, readyReject;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startupTimer = setTimeout(() => readyReject(new Error('External test peer startup timed out.')), 15000);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  child.on('message', message => {
    if (message.ready) { clearTimeout(startupTimer); readyResolve(message); return; }
    const item = pending.get(message.sequence);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.sequence);
    if (message.error) item.reject(new Error(message.error)); else item.resolve(message);
  });
  function failed(error) {
    clearTimeout(startupTimer); readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  child.once('error', failed);
  child.once('exit', code => failed(new Error(`External test peer exited (${code}): ${stderr}`)));
  const peer = {
    child, temporaryProfile,
    async raise() {
      const sequence = ++nextSequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(sequence); reject(new Error('External peer command timed out.')); }, 3000);
        pending.set(sequence, { resolve, reject, timer }); child.send({ action: 'raise', sequence });
      });
    },
    async close() {
      clearTimeout(startupTimer);
      if (child.connected) child.send({ action: 'stop' });
      if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]);
      if (child.exitCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]); }
      if (child.exitCode !== null && path.dirname(temporaryProfile) === os.tmpdir() && path.basename(temporaryProfile).startsWith('elysia-taskbar-peer-')) {
        try { fs.rmSync(temporaryProfile, { recursive: true, force: true }); } catch {}
      }
    },
  };
  try {
    const identity = await ready;
    if (identity.processId !== child.pid || identity.processId === process.pid) throw new Error('External peer PID does not match its child process.');
    return Object.assign(peer, identity);
  } catch (error) { await peer.close(); throw error; }
}

async function worker() {
  const { app, BrowserWindow, screen } = require('electron');
  const { createTopmostController, REASSERT_INTERVAL_MS } = require(path.join(runtimeRoot, 'electron', 'window-layer.cjs'));
  const temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-taskbar-check-'));
  app.setPath('userData', temporaryProfile);
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const report = {
    status: 'running', startedAt: new Date().toISOString(), electron: process.versions.electron,
    platform: process.platform, controller: 'electron/window-layer.cjs',
    appArchive, runtimeRoot,
    scope: 'Invisible non-focusable test windows use isolated profiles. Native probe is read-only; no input is injected. The production controller may reorder visible topmost taskbars; their geometry, visibility and topmost styles must remain unchanged.',
    checks: [], samples: [], errors: [], focusEvents: 0,
  };
  let window, controller, probe, sibling, externalPeer, baselineForeground, baselineTaskbars;
  const nativeHandle = win => {
    const handle = win.getNativeWindowHandle();
    return '0x' + (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(16);
  };
  function check(name, passed, details) { report.checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) }); }
  const visibleTaskbars = snapshot => snapshot.taskbars.filter(taskbar => taskbar.visible && taskbar.topmost);
  function checkTaskbarState(label, snapshot) {
    const state = snapshot.taskbars.map(({ hwnd, processId, bounds, visible, topmost }) => ({ hwnd, processId, bounds, visible, topmost }))
      .sort((a, b) => a.hwnd.localeCompare(b.hwnd));
    if (!baselineTaskbars) baselineTaskbars = state;
    check(`${label}: taskbar geometry, visibility and styles unchanged`, JSON.stringify(state) === JSON.stringify(baselineTaskbars));
  }
  async function sample(label, expected = {}) {
    const started = Date.now();
    let snapshot = await probe.read();
    // The secondary-taskbar helper needs one PowerShell/Add-Type startup.
    // Require actual native convergence, rather than assuming a fixed delay.
    if (expected.order === 'below') {
      while (Date.now() - started < 5000 && !(snapshot.target?.topmost && visibleTaskbars(snapshot).length &&
          visibleTaskbars(snapshot).every(taskbar => snapshot.target.rank > taskbar.rank))) {
        await delay(50); snapshot = await probe.read();
      }
    }
    if (!baselineForeground) baselineForeground = snapshot.foreground.hwnd;
    const state = { label, ...snapshot, convergenceMs: Date.now() - started, electronVisible: window.isVisible(), electronAlwaysOnTop: window.isAlwaysOnTop(),
      enabled: controller?.enabled ?? false, taskbarInFront: controller?.taskbarInFront ?? null };
    report.samples.push(state);
    checkTaskbarState(label, snapshot);
    check(`${label}: complete native window walk`, snapshot.chainComplete && snapshot.target !== null);
    check(`${label}: test window never became foreground`, snapshot.foreground.hwnd !== snapshot.target?.hwnd);
    check(`${label}: foreground unchanged`, snapshot.foreground.hwnd === baselineForeground,
      snapshot.foreground.hwnd === baselineForeground ? undefined : 'External focus changes also fail this check; inspect samples before attributing them to the app.');
    if ('visible' in expected) check(`${label}: visibility`, snapshot.target?.visible === expected.visible && window.isVisible() === expected.visible);
    if ('topmost' in expected) check(`${label}: actual WS_EX_TOPMOST`, snapshot.target?.topmost === expected.topmost);
    if (expected.order) {
      check(`${label}: a visible topmost Windows taskbar was found`, visibleTaskbars(snapshot).length > 0);
      for (const taskbar of visibleTaskbars(snapshot)) {
        const passed = expected.order === 'above' ? snapshot.target.rank < taskbar.rank : snapshot.target.rank > taskbar.rank;
        check(`${label}: ${expected.order} ${taskbar.className} ${taskbar.hwnd}`, passed,
          { targetRank: snapshot.target.rank, taskbarRank: taskbar.rank, taskbarTopmost: taskbar.topmost });
      }
    }
    return state;
  }
  const settle = () => delay(60);
  const maintenance = () => delay(REASSERT_INTERVAL_MS + 250);
  try {
    await app.whenReady();
    report.displays = screen.getAllDisplays().map(({ id, bounds, scaleFactor }) => ({ id, bounds, scaleFactor }));
    const bounds = screen.getPrimaryDisplay().bounds;
    window = new BrowserWindow({ x: bounds.x + 8, y: bounds.y + 8, width: 32, height: 32,
      show: false, opacity: 0, frame: false, transparent: true, focusable: false, skipTaskbar: true,
      resizable: false, minimizable: false, maximizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.setIgnoreMouseEvents(true);
    window.on('focus', () => { report.focusEvents++; });
    const hwnd = nativeHandle(window);
    report.targetHwnd = hwnd;
    probe = startProbe(hwnd);
    await probe.ready;
    await sample('hidden baseline', { visible: false, topmost: false });
    controller = createTopmostController(window, { enabled: true, taskbarInFront: true,
      onError: error => report.errors.push(error.stack || error.message) });
    await sample('below-taskbar preference before showing', { visible: false, topmost: true });
    window.showInactive(); await settle();
    await sample('below-taskbar initial show', { visible: true, topmost: true, order: 'below' });
    await maintenance();
    await sample('below-taskbar periodic maintenance', { visible: true, topmost: true, order: 'below' });

    // Perturb only our own HWND to prove the timer repairs its ordering.
    window.moveTop();
    await sample('below-taskbar test-only displacement', { visible: true, topmost: true });
    await maintenance();
    await sample('below-taskbar timer repair', { visible: true, topmost: true, order: 'below' });

    // Use a separately owned process: same-process windows include legitimate
    // subtitles and cursor overlays, so they must not be treated as competitors.
    // The prior test only inserted a peer BELOW the taskbars, missing apps that
    // legitimately became topmost ABOVE the shell taskbars (the reported bug).
    externalPeer = await startExternalPeer();
    report.externalPeer = { processId: externalPeer.processId, hwnd: externalPeer.hwnd };
    let aboveTaskbarsObserved = false;
    for (let attempt = 0; attempt < 3 && !aboveTaskbarsObserved; attempt++) {
      const command = await externalPeer.raise();
      check(`external peer raise ${attempt + 1}: zero focus events`, command.focusEvents === 0);
      const snapshot = await probe.read('snapshot', externalPeer.hwnd, externalPeer.processId);
      report.samples.push({ label: 'independent topmost app above taskbars', ...snapshot });
      aboveTaskbarsObserved = snapshot.peer?.topmost && snapshot.peer.processId !== snapshot.target.processId &&
        visibleTaskbars(snapshot).length > 0 && visibleTaskbars(snapshot).every(taskbar => snapshot.peer.rank < taskbar.rank);
    }
    check('competing topmost app was observed above the taskbars', aboveTaskbarsObserved);
    await maintenance();
    const aboveTaskbarsRecovered = await probe.read('snapshot', externalPeer.hwnd, externalPeer.processId);
    report.samples.push({ label: 'pet recovers above app initially above taskbars', ...aboveTaskbarsRecovered });
    check('taskbars remain above pet and pet returns above independent topmost app', aboveTaskbarsRecovered.target?.topmost &&
      aboveTaskbarsRecovered.peer?.topmost && aboveTaskbarsRecovered.target.rank < aboveTaskbarsRecovered.peer.rank &&
      visibleTaskbars(aboveTaskbarsRecovered).every(taskbar => taskbar.rank < aboveTaskbarsRecovered.target.rank));
    check('above-taskbar competition did not change foreground', aboveTaskbarsRecovered.foreground.hwnd === baselineForeground);
    checkTaskbarState('external topmost competitor recovery', aboveTaskbarsRecovered);
    await externalPeer.close(); externalPeer = null;

    sibling = new BrowserWindow({ x: bounds.x + 8, y: bounds.y + 8, width: 32, height: 32,
      show: false, opacity: 0, frame: false, transparent: true, focusable: false, skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    sibling.setIgnoreMouseEvents(true); sibling.on('focus', () => { report.focusEvents++; });
    sibling.setAlwaysOnTop(true, 'screen-saver'); sibling.showInactive(); sibling.moveTop();
    const siblingHwnd = nativeHandle(sibling);
    const auxiliaryBefore = await probe.read('snapshot', siblingHwnd);
    report.samples.push({ label: 'same-process auxiliary initially above pet', ...auxiliaryBefore });
    const relevantOrder = snapshot => [snapshot.target, snapshot.peer, ...visibleTaskbars(snapshot)].sort((a, b) => a.rank - b.rank).map(info => info.hwnd);
    check('same-process auxiliary starts above pet', auxiliaryBefore.peer?.processId === auxiliaryBefore.target.processId &&
      auxiliaryBefore.peer.rank < auxiliaryBefore.target.rank);
    // An already running external app may legitimately trigger one repair that
    // moves the taskbars above this auxiliary. Compare subsequent maintenance
    // against the converged order, while always requiring auxiliary > pet.
    await maintenance();
    const auxiliarySettled = await probe.read('snapshot', siblingHwnd);
    report.samples.push({ label: 'same-process auxiliary after initial convergence', ...auxiliarySettled });
    check('auxiliary remains above pet during initial convergence', auxiliarySettled.peer.rank < auxiliarySettled.target.rank);
    checkTaskbarState('auxiliary initial convergence', auxiliarySettled);
    for (let cycle = 1; cycle <= 2; cycle++) {
      await maintenance();
      const snapshot = await probe.read('snapshot', siblingHwnd);
      report.samples.push({ label: `same-process auxiliary after maintenance ${cycle}`, ...snapshot });
      check(`auxiliary maintenance ${cycle}: auxiliary stays above pet`, snapshot.peer.rank < snapshot.target.rank);
      check(`auxiliary maintenance ${cycle}: relevant order remains unchanged`, JSON.stringify(relevantOrder(snapshot)) === JSON.stringify(relevantOrder(auxiliarySettled)));
      check(`auxiliary maintenance ${cycle}: foreground unchanged`, snapshot.foreground.hwnd === baselineForeground);
      checkTaskbarState(`auxiliary maintenance ${cycle}`, snapshot);
    }

    externalPeer = await startExternalPeer();
    let simultaneousObstructionObserved = false;
    for (let attempt = 0; attempt < 3 && !simultaneousObstructionObserved; attempt++) {
      const command = await externalPeer.raise();
      check(`external raise with auxiliary ${attempt + 1}: zero focus events`, command.focusEvents === 0);
      const snapshot = await probe.read('snapshot', externalPeer.hwnd, externalPeer.processId);
      report.samples.push({ label: 'independent topmost app raised with auxiliary present', ...snapshot });
      simultaneousObstructionObserved = snapshot.peer?.topmost && visibleTaskbars(snapshot).length > 0 &&
        visibleTaskbars(snapshot).every(taskbar => snapshot.peer.rank < taskbar.rank);
    }
    check('external competitor above taskbars observed while auxiliary exists', simultaneousObstructionObserved);
    await maintenance();
    const simultaneousRecovery = await probe.read('snapshot', externalPeer.hwnd, externalPeer.processId);
    report.samples.push({ label: 'external recovery with auxiliary present', ...simultaneousRecovery });
    check('external repair with auxiliary restores taskbars > pet > competitor', simultaneousRecovery.target?.topmost &&
      simultaneousRecovery.peer?.topmost && simultaneousRecovery.target.rank < simultaneousRecovery.peer.rank &&
      visibleTaskbars(simultaneousRecovery).every(taskbar => taskbar.rank < simultaneousRecovery.target.rank));
    const auxiliaryAfterRepair = await probe.read('snapshot', siblingHwnd);
    report.samples.push({ label: 'auxiliary preserved during external repair', ...auxiliaryAfterRepair });
    check('external repair preserves same-process auxiliary above pet', auxiliaryAfterRepair.peer.rank < auxiliaryAfterRepair.target.rank);
    check('external repair with auxiliary does not change foreground', auxiliaryAfterRepair.foreground.hwnd === baselineForeground);
    checkTaskbarState('external repair with auxiliary', auxiliaryAfterRepair);

    // Simulate an external native operation removing WS_EX_TOPMOST while the
    // preference/controller remains enabled. Cached Electron policy alone must
    // not leave the pet below every ordinary application indefinitely.
    let lostNativeTopmostObserved = false;
    for (let attempt = 0; attempt < 3 && !lostNativeTopmostObserved; attempt++) {
      window.setAlwaysOnTop(false);
      const snapshot = await probe.read('snapshot', externalPeer.hwnd, externalPeer.processId);
      report.samples.push({ label: 'native topmost deliberately removed while controller enabled', ...snapshot });
      lostNativeTopmostObserved = snapshot.target?.topmost === false;
    }
    check('native topmost loss observed with preference still enabled', lostNativeTopmostObserved && controller.enabled);
    await maintenance();
    const flagRecovery = await probe.read('snapshot', externalPeer.hwnd, externalPeer.processId);
    report.samples.push({ label: 'native topmost and taskbar order recover automatically', ...flagRecovery });
    check('enabled controller restores native topmost and taskbars > pet > competitor', flagRecovery.target?.topmost &&
      flagRecovery.peer?.topmost && flagRecovery.target.rank < flagRecovery.peer.rank &&
      visibleTaskbars(flagRecovery).every(taskbar => taskbar.rank < flagRecovery.target.rank));
    const auxiliaryAfterFlagRecovery = await probe.read('snapshot', siblingHwnd);
    report.samples.push({ label: 'auxiliary preserved during native topmost restoration', ...auxiliaryAfterFlagRecovery });
    check('native topmost restoration preserves auxiliary above pet', auxiliaryAfterFlagRecovery.peer.rank < auxiliaryAfterFlagRecovery.target.rank);
    check('native topmost restoration does not change foreground', flagRecovery.foreground.hwnd === baselineForeground);
    checkTaskbarState('native topmost restoration', flagRecovery);
    await externalPeer.close(); externalPeer = null;
    sibling.destroy(); sibling = null;

    controller.setTaskbarInFront(false); await settle();
    await sample('above-taskbar preference switch', { visible: true, topmost: true, order: 'above' });
    await maintenance();
    await sample('above-taskbar periodic maintenance', { visible: true, topmost: true, order: 'above' });
    window.setAlwaysOnTop(true, 'floating');
    await sample('above-taskbar test-only displacement', { visible: true, topmost: true });
    await maintenance();
    await sample('above-taskbar timer repair', { visible: true, topmost: true, order: 'above' });

    window.hide(); await maintenance();
    await sample('hidden stays hidden across timer interval', { visible: false, topmost: true });
    controller.setTaskbarInFront(true); await settle();
    await sample('hidden preference switch stays hidden', { visible: false, topmost: true });
    window.showInactive(); await settle();
    await sample('show restores below-taskbar preference', { visible: true, topmost: true, order: 'below' });

    controller.setEnabled(false); await settle();
    await sample('always-on-top disabled', { visible: true, topmost: false });
    controller.setTaskbarInFront(false);
    await sample('disabled preference switch above', { visible: true, topmost: false });
    controller.setTaskbarInFront(true);
    await sample('disabled preference switch below', { visible: true, topmost: false });
    check('taskbar preference cannot reenable always-on-top', controller.enabled === false && controller.taskbarInFront === true);
    await maintenance();
    await sample('disabled remains non-topmost across timer interval', { visible: true, topmost: false });
    controller.setEnabled(true); await settle();
    await sample('reenabling restores stored taskbar preference', { visible: true, topmost: true, order: 'below' });

    const rememberedPreference = controller.taskbarInFront;
    controller.dispose();
    controller = createTopmostController(window, { enabled: true, taskbarInFront: rememberedPreference,
      onError: error => report.errors.push(error.stack || error.message) });
    await settle();
    await sample('new controller restores passed saved preference', { visible: true, topmost: true, order: 'below' });
    controller.setTaskbarInFront(false); await settle();
    await sample('final switch above all visible taskbars', { visible: true, topmost: true, order: 'above' });
    controller.setTaskbarInFront(true); await settle();
    await sample('exit path with active below-taskbar helper', { visible: true, topmost: true, order: 'below' });
    const activeHelpers = await probe.read('helpers');
    report.activeHelpersBeforeDisposal = activeHelpers;
    check('exit path has an active helper owned by this test PID', activeHelpers.length === 1);
    controller.dispose(); window.hide(); await settle();
    await sample('disposed and hidden', { visible: false, topmost: false });
    check('test window received zero focus events', report.focusEvents === 0);
  } catch (error) {
    report.errors.push(error.stack || String(error));
  } finally {
    controller?.dispose();
    await externalPeer?.close();
    if (probe) {
      try {
        const started = Date.now();
        let remaining = await probe.read('helpers');
        while (remaining.length && Date.now() - started < 5000) { await delay(50); remaining = await probe.read('helpers'); }
        report.helperCleanup = { ownerProcessId: process.pid, elapsedMs: Date.now() - started, remaining };
        check('all taskbar helpers owned by this test exited after disposal', remaining.length === 0);
      } catch (error) { report.errors.push(error.stack || String(error)); }
    }
    if (sibling && !sibling.isDestroyed()) sibling.destroy();
    if (window && !window.isDestroyed()) window.destroy();
    await probe?.close();
    report.finishedAt = new Date().toISOString();
    report.failedChecks = report.checks.filter(item => !item.passed);
    report.status = report.errors.length || report.failedChecks.length ? 'failed' : 'passed';
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length,
      failed: report.failedChecks.length, errors: report.errors, report: reportPath }));
    // Remove only this script's explicitly created temporary profile.
    if (path.dirname(temporaryProfile) === os.tmpdir() && path.basename(temporaryProfile).startsWith('elysia-taskbar-check-')) {
      try { fs.rmSync(temporaryProfile, { recursive: true, force: true }); } catch {}
    }
    app.exit(report.status === 'passed' ? 0 : 1);
  }
}

if (process.versions.electron && process.argv.includes(workerFlag)) {
  worker().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  launch();
}
