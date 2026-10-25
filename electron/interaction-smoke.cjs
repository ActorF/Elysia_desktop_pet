'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function checkInteractionSettings({ pet, voices, voiceTestHooks, cursorTrail, settingsWindow, screen, root, getState, updateSettings,
  settingsFile, buildMenu, action, ipcMain }) {
  const output = path.join(root.includes('app.asar') ? process.cwd() : root, 'artifacts', 'validation-v1.3.0-r9');
  await fs.mkdir(output, { recursive: true });
  const checks = [], errors = [], original = getState().settings, originalVoice = voices.getState().settings;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function poll(label, read, accept, timeout = 10000) {
    const deadline = Date.now() + timeout; let value;
    do { value = await read(); if (accept(value)) return value; await delay(25); } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify(value)}`);
  }
  const interact = kind => pet.webContents.executeJavaScript(`window.elysiaDesktop.interact(${JSON.stringify(kind)})`);
  try {
    const settingsChecks = await require('./settings-window-smoke.cjs').checkSettingsWindow({
      window: pet, getState, settingsFile, buildMenu, settingsWindow, updateSettings, action, ipcMain });
    assert.equal(settingsChecks.interactionSwitchPersistence, true);
    checks.push('Five settings tabs; independent switches and all three trail styles save through real IPC to disk and reappear after reopening');

    updateSettings({ interactionsEnabled: true, cursorTrailEnabled: false, clickThrough: false });
    voices.setSettings({ dnd: false, volume: .3 });
    assert.equal(await interact('head-pat'), true);
    assert.ok(voices.getState().queuedInteraction);
    updateSettings({ interactionsEnabled: false });
    await delay(380);
    assert.equal(voices.getState().queuedInteraction, null);
    assert.equal(voices.getState().playback.status === 'playing', false);
    for (const kind of ['head-pat', 'poke', 'poke-annoyed']) assert.equal(await interact(kind), false);
    assert.equal(cursorTrail.getState().enabled, false);
    checks.push('Disabling interactions cancels the pending reply and rejects all gesture types without toggling cursor effects');

    updateSettings({ interactionsEnabled: true });
    assert.equal(await interact('head-pat'), true);
    await poll('interaction audio starts', () => voices.getState().playback, value => value.kind === 'interaction' && value.status === 'playing');
    assert.equal(await interact('poke-annoyed'), true);
    updateSettings({ interactionsEnabled: false });
    assert.equal(voices.getState().queuedInteraction, null);
    assert.equal(voices.getState().playback.status, 'idle');
    await voiceTestHooks.playVoice('H01');
    await poll('manual audition remains available with interactions off', () => voices.getState().playback, value => value.kind === 'manual' && value.status === 'playing');
    voices.stopVoice();
    checks.push('Switching interactions off stops both current interaction audio and its queued angry reply; the developer playback hook stays isolated from production UI');

    updateSettings({ cursorTrailEnabled: true, cursorTrailDuration: 0.6 });
    cursorTrail.setBlocked(false);
    assert.equal(getState().settings.interactionsEnabled, false);
    const area = screen.getPrimaryDisplay().bounds;
    const start = { x: area.x + 40, y: area.y + Math.min(220, area.height * .3) };
    const hop = Math.min(500, (area.width - 80) / 2);
    assert.ok(hop > 180, 'Native test reproduces movement beyond the old 180-DIP cutoff');
    // A first fast fling finishes before awaiting the lazy overlay load. Its
    // path must survive loading even if the user has already stopped moving.
    cursorTrail.sample({ ...start, sampledAt: Date.now() });
    await delay(16);
    cursorTrail.sample({ x: start.x + hop, y: start.y, sampledAt: Date.now() });
    await delay(16);
    cursorTrail.sample({ x: start.x + hop * 2, y: start.y, sampledAt: Date.now() });
    await poll('trail window created', () => cursorTrail.getWindows().length, value => value > 0);
    const trail = cursorTrail.getWindows()[0];
    trail.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) errors.push(event.message); });
    await poll('trail renderer ready', () => trail.webContents.executeJavaScript('document.documentElement.dataset.ready'), value => value === 'true');
    const segmentPixels = async () => {
      // Smoke overlays stay hidden. Wake Chromium's compositor after hide()
      // without displaying the synthetic cursor trail over the desktop.
      await trail.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      return trail.webContents.executeJavaScript(`(() => {
      const canvas=document.querySelector('canvas'),context=canvas.getContext('2d');
      const ratioX=canvas.width/innerWidth,ratioY=canvas.height/innerHeight;
      const x=${start.x - area.x},y=${start.y - area.y},hop=${hop};
      return [.5,1.5].map(position=>{
        const left=Math.max(0,Math.round((x+position*hop-35)*ratioX));
        const top=Math.max(0,Math.round((y-45)*ratioY));
        const width=Math.min(canvas.width-left,Math.ceil(70*ratioX)),height=Math.min(canvas.height-top,Math.ceil(90*ratioY));
        const data=context.getImageData(left,top,width,height).data;
        let count=0;for(let index=3;index<data.length;index+=4)if(data[index]>0)count++;
        return count;
      });
    })()`);
    };
    const pixelCount = () => trail.webContents.executeJavaScript(`(() => {
      const canvas=document.querySelector('canvas'),context=canvas.getContext('2d');
      const data=context.getImageData(0,0,canvas.width,canvas.height).data;
      let count=0;for(let index=3;index<data.length;index+=4)if(data[index]>0)count++;
      return count;
    })()`);
    const coldSegments = await poll('first fast fling survives lazy load with visible segment interiors', segmentPixels, values => values.every(count => count > 0), 2000);
    const drawnPixels = await pixelCount();
    assert.ok(drawnPixels > 0, 'Cursor motion renders a visible trail');
    assert.equal(trail.isFocusable(), false);
    assert.equal(trail.isVisible(), false, 'Synthetic smoke does not draw over the user desktop');
    const security = trail.webContents.getLastWebPreferences();
    assert.equal(security.sandbox, true); assert.equal(security.contextIsolation, true); assert.equal(security.nodeIntegration, false);
    let extendedStyle = null;
    if (process.platform === 'win32') {
      const handle = trail.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
      const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TrailWindowStyle { [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Read(IntPtr hwnd, int index); }'; [TrailWindowStyle]::Read([IntPtr]${hwnd}, -20).ToInt64()`;
      extendedStyle = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }).trim());
      assert.ok(extendedStyle & 0x20, 'Native overlay has WS_EX_TRANSPARENT click-through');
      assert.ok(extendedStyle & 0x08000000, 'Native overlay has WS_EX_NOACTIVATE');
    }
    const styles = [];
    for (const style of ['pink', 'ribbon', 'stardust']) {
      updateSettings({ cursorTrailEnabled: false, cursorTrailStyle: style });
      assert.equal(cursorTrail.getState().style, style);
      updateSettings({ cursorTrailEnabled: true });
      cursorTrail.sample({ ...start, sampledAt: Date.now() });
      await delay(16);
      cursorTrail.sample({ x: start.x + hop, y: start.y, sampledAt: Date.now() });
      await delay(16);
      cursorTrail.sample({ x: start.x + hop * 2, y: start.y, sampledAt: Date.now() });
      const segments = await poll(`high-speed ${style} remains visible between samples`, segmentPixels, values => values.every(count => count > 0));
      await fs.writeFile(path.join(output, `cursor-trail-${style}-fast.png`), (await trail.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      await poll(`${style} fades and clears`, pixelCount, value => value === 0, 3000);
      // Polling a stationary cursor must refresh the baseline time without
      // keeping a trail alive; one fast movement after the pause still draws.
      cursorTrail.sample({ x: start.x + hop * 2, y: start.y, sampledAt: Date.now() });
      await delay(16);
      cursorTrail.sample({ ...start, sampledAt: Date.now() });
      const afterIdleSegments = await poll(`${style} first fast movement after a pause is visible`, segmentPixels, values => values.every(count => count > 0));
      await poll(`${style} clears again after the single fast movement`, pixelCount, value => value === 0, 3000);
      // Repeated 180-degree reversals exercise the live drawing workload and
      // ribbon self-overlap; a single static three-point stroke misses both.
      cursorTrail.sample({ ...start, sampledAt: Date.now() });
      const reversals = []; let reversalSamples = 0;
      // Keep sampling while the compositor is being inspected, as the real
      // main-process cursor timer does independently of renderer completion.
      const reversalTimer = setInterval(() => {
        cursorTrail.sample({ x: start.x + (reversalSamples++ % 2 ? 0 : hop * 2), y: start.y, sampledAt: Date.now() });
      }, 8);
      try {
        while (reversalSamples < 72 || reversals.length < 6) {
          await delay(96);
          const visible = await segmentPixels();
          assert.ok(visible.every(count => count > 0), `${style} stays visible during sustained fast reversals: ${visible}`);
          reversals.push(visible);
        }
      } finally { clearInterval(reversalTimer); }
      await poll(`${style} clears after sustained fast reversals`, pixelCount, value => value === 0, 3000);
      styles.push({ style, hopDip: hop, sampleIntervalMs: 16, segmentPixels: segments, afterIdleSegments,
        reversalSampleIntervalMs: 8, reversalSamples, reversals, cleared: true });
    }
    assert.ok(cursorTrail.getWindows().every(window => !window.isVisible()));
    checks.push('All three styles remain visible inside fast segments, first flings, and sustained 1000-DIP reversals at 8ms sampling; each fades fully');
    checks.push('Native overlay remains click-through, nonactivating and sandboxed');

    const durations = [];
    for (const seconds of [0.1, 1.5, 5]) {
      updateSettings({ cursorTrailDuration: seconds });
      assert.equal(cursorTrail.getState().duration, seconds);
      cursorTrail.sample({ ...start, sampledAt: Date.now() });
      await delay(8);
      cursorTrail.sample({ x: start.x + hop * 2, y: start.y, sampledAt: Date.now() });
      const movedAt = Date.now();
      await poll(`${seconds}s trail renders`, segmentPixels, values => values.every(count => count > 0), 1500);
      if (seconds > 0.6) {
        await delay(Math.max(0, movedAt + 750 - Date.now()));
        assert.ok(await pixelCount() > 0, `${seconds}s trail survives the old 600ms lifetime`);
      }
      await poll(`${seconds}s trail fully clears`, pixelCount, value => value === 0, seconds * 1000 + 1000);
      durations.push({ seconds, clearedAfterMs: Date.now() - movedAt });
    }
    updateSettings({ cursorTrailDuration: 5 });
    cursorTrail.sample({ ...start, sampledAt: Date.now() });
    await delay(8);
    cursorTrail.sample({ x: start.x + hop * 2, y: start.y, sampledAt: Date.now() });
    await poll('long trail starts before changing duration', segmentPixels, values => values.every(count => count > 0));
    updateSettings({ cursorTrailDuration: 0.6 });
    await poll('changing duration immediately clears the old trajectory', pixelCount, value => value === 0, 1500);
    checks.push('Decimal durations 0.1s, 1.5s and 5s control actual renderer expiry; changing duration clears previous effects');

    updateSettings({ cursorTrailEnabled: false });
    cursorTrail.sample({ x: start.x + 250, y: start.y, sampledAt: Date.now() });
    await delay(150);
    assert.equal(cursorTrail.getState().enabled, false);
    assert.ok(cursorTrail.getWindows().every(window => !window.isVisible()));
    assert.equal(getState().settings.interactionsEnabled, false);
    updateSettings({ cursorTrailEnabled: true });
    cursorTrail.setBlocked(true);
    cursorTrail.sample({ x: start.x + 270, y: start.y, sampledAt: Date.now() });
    await delay(150);
    assert.ok(cursorTrail.getWindows().every(window => !window.isVisible()));
    assert.equal(cursorTrail.getState().blocked, true);
    cursorTrail.setBlocked(false);
    checks.push('Disabling the trail or blocking the desktop clears it; the interaction switch stays independent');
    assert.deepEqual(errors, []);
    const report = { passed: true, checks, drawnPixels, coldSegments, styles, durations, extendedStyle, hiddenThroughout: true, syntheticGlobalInput: false, errors };
    await fs.writeFile(path.join(output, 'interaction-settings-native.json'), JSON.stringify(report, null, 2));
    return report;
  } finally {
    voices.stopVoice(); voices.setSettings(originalVoice); updateSettings(original);
  }
}
module.exports = { checkInteractionSettings };
