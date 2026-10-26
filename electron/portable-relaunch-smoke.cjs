/** Hidden packaged regression: secondary NSIS wrappers must not delete the primary runtime before its first settings window opens. */
'use strict';
const assert = require('node:assert/strict');
// Hash physical runtime files, including the ASAR archive itself, without
// Electron interpreting app.asar as a virtual directory.
const fs = require('original-fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const FLAG = '--portable-relaunch-smoke-test';
const digest = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

function runtimeFiles(runtime) {
  const files = ['icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'snapshot_blob.bin', 'v8_context_snapshot.bin', 'resources/app.asar'];
  const locales = fs.readdirSync(path.join(runtime, 'locales')).filter(name => name.endsWith('.pak'));
  assert.ok(locales.includes('en-US.pak'), 'Packaged English locale is missing');
  files.push(...locales.map(name => `locales/${name}`));
  for (const script of ['chat-tts-worker.py', 'legacy-hotkeys.ps1', 'typed-keys.ps1', 'taskbar-order.ps1', 'voice-environment.ps1']) {
    files.push(`resources/app.asar.unpacked/electron/${script}`);
  }
  files.push('resources/voice/final-audio-map.json', 'resources/interaction-voice/final-audio-map.json');
  for (let group = 1; group <= 12; group++) for (let line = 1; line <= 3; line++) files.push(`resources/voice/audio-final/${String(group).padStart(2, '0')}-${line}.wav`);
  for (const prefix of ['H', 'P', 'A']) for (let line = 1; line <= 6; line++) files.push(`resources/interaction-voice/audio-final/${prefix}${String(line).padStart(2, '0')}.wav`);
  return files;
}

function launchSecondWrapper(executable) {
  return new Promise((resolve, reject) => {
    // NSIS must populate its own portable paths. This child inherits only the
    // same isolated smoke flag/profile, never the live production profile.
    const env = { ...process.env };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME', 'ELYSIA_PORTABLE_RELAUNCH_REPORT']) delete env[name];
    const child = spawn(executable, [FLAG], { cwd: path.dirname(executable), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false, diagnostic = '';
    child.stderr.on('data', bytes => { if (diagnostic.length < 2048) diagnostic += bytes.toString().slice(0, 2048 - diagnostic.length); });
    const timeout = setTimeout(() => {
      if (settled) return; settled = true;
      // Only this regression's exact child is touched; user-owned desktop
      // processes and temporary directories are never enumerated or removed.
      child.kill();
      reject(new Error('Second portable wrapper did not exit within 25 seconds'));
    }, 25000);
    child.on('error', error => {
      if (settled) return; settled = true; clearTimeout(timeout); reject(error);
    });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`Second portable wrapper exited ${code}: ${diagnostic}`)); return; }
      // close is deliberately used instead of observing the Electron child's
      // exit: the NSIS wrapper performs directory cleanup after ExecWait.
      resolve({ wrapperPid: child.pid, exitCode: code });
    });
  });
}

async function poll(label, read, matches, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`${label} did not become ready`);
}

/** Check the same portable build twice through its real wrapper and chat IPC, using only the dedicated smoke profile. */
async function checkPortableRelaunchRuntime({ app, pet, chatWindow, settingsWindow, root, directory, getSecondInstances }) {
  const runtime = path.dirname(process.execPath);
  const reportPath = process.env.ELYSIA_PORTABLE_RELAUNCH_REPORT;
  const saveReport = report => {
    if (!reportPath || !path.isAbsolute(reportPath)) return;
    fs.writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2));
    fs.renameSync(reportPath + '.tmp', reportPath);
  };
  const rounds = [];
  let firstSettingsId = null;
  try {
    assert.equal(process.platform, 'win32');
    assert.equal(app.isPackaged, true, 'Portable relaunch regression requires a packaged executable');
    assert.equal(path.basename(directory), 'elysia-pet-portable-relaunch-smoke');
    const executable = process.env.PORTABLE_EXECUTABLE_FILE;
    assert.ok(executable && path.isAbsolute(executable) && fs.existsSync(executable), 'Run this mode through the portable EXE, not win-unpacked');
    assert.notEqual(path.resolve(executable).toLowerCase(), path.resolve(process.execPath).toLowerCase(), 'The parent must be a portable wrapper');
    assert.equal(path.resolve(root).toLowerCase(), path.join(runtime, 'resources', 'app.asar').toLowerCase());
    assert.equal(pet.isVisible(), false); assert.equal(settingsWindow.getWindow(), null, 'Settings must never have been opened before the relaunch');
    if (reportPath) assert.ok(path.isAbsolute(reportPath), 'Regression report path must be absolute');
    const originalPetId = pet.webContents.id;
    const files = runtimeFiles(runtime);
    const hashes = new Map(files.map(relative => [relative, digest(path.join(runtime, relative))]));
    const verifyResources = () => {
      for (const [relative, hash] of hashes) {
        const filename = path.join(runtime, relative);
        assert.ok(fs.existsSync(filename), `A secondary wrapper removed the primary runtime file: ${relative}`);
        assert.equal(digest(filename), hash, `A secondary wrapper changed the primary runtime file: ${relative}`);
      }
    };
    const composer = await chatWindow.open();
    await poll('chat renderer', () => composer.webContents.executeJavaScript('document.documentElement.dataset.chatReady'), value => value === 'true');
    assert.equal(composer.isVisible(), false); assert.equal(settingsWindow.getWindow(), null);
    for (let round = 0; round < 2; round++) {
      const before = getSecondInstances().length;
      const child = await launchSecondWrapper(executable);
      const instances = await poll('second-instance notification', getSecondInstances, values => values.length === before + 1, 3000);
      const secondary = instances.at(-1);
      assert.ok(typeof secondary.runtimeDirectory === 'string' && path.isAbsolute(secondary.runtimeDirectory), 'Second instance did not report its runtime directory');
      const secondaryRuntime = path.resolve(secondary.runtimeDirectory);
      assert.notEqual(secondaryRuntime.toLowerCase(), runtime.toLowerCase(), 'Concurrent portable launches share an extraction directory');
      verifyResources();
      assert.equal(settingsWindow.getWindow(), null, 'Settings must be newly created after the secondary wrapper has completed cleanup');
      assert.equal(await composer.webContents.executeJavaScript('window.elysiaChat.openSettings()'), true, 'The real chat:open-settings IPC did not open settings');
      const settings = settingsWindow.getWindow();
      await poll('settings renderer', () => settings.webContents.executeJavaScript('({ready:document.documentElement.dataset.ready,chat:document.documentElement.dataset.chatSettingsReady})'), value => value.ready === 'true' && value.chat === 'true');
      assert.equal(settings.isVisible(), false); assert.equal(pet.isVisible(), false); assert.equal(composer.isVisible(), false);
      assert.equal(pet.webContents.id, originalPetId);
      if (round === 0) firstSettingsId = settings.webContents.id;
      else assert.notEqual(settings.webContents.id, firstSettingsId, 'The second round must recreate settings, not reuse the old renderer');
      await settings.webContents.executeJavaScript('window.elysiaSettings.windowControl("close"); true');
      await poll('settings closed', () => settingsWindow.getWindow(), value => value === null);
      rounds.push({ round: round + 1, ...child, runtimeDirectory: secondaryRuntime, settingsOpenedViaChat: true });
    }
    verifyResources();
    const report = { portableRelaunchSmoke: 'ok', distinctTempDirectories: true, runtimeFilesPreserved: true,
      settingsOpenedViaChat: true, settingsReopened: true, hiddenThroughout: true, isolatedProfile: true,
      secondInstances: rounds.length, checkedRuntimeFiles: files.length, primaryRuntimeDirectory: runtime,
      profileDirectory: directory, rounds };
    saveReport(report); return report;
  } catch (error) {
    saveReport({ portableRelaunchSmoke: 'error', error: error.message, primaryRuntimeDirectory: runtime, rounds });
    throw error;
  } finally {
    settingsWindow.getWindow()?.close(); chatWindow.getWindow()?.close();
  }
}

module.exports = { checkPortableRelaunchRuntime };
