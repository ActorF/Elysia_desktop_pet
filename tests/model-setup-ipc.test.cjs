'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerModelSetupIpc } = require('../electron/model-setup-ipc.cjs');
const { createSetupDiagnostic } = require('../electron/setup-diagnostics.cjs');

test('model installation and cancellation are available only to the settings main frame', async () => {
  const frame = { url: 'file:///settings.html' }, webContents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false }, handlers = new Map(), calls = [];
  const setup = Object.fromEntries(['getState', 'inspect', 'installChatModel', 'cancel'].map(method => [method, () => { calls.push(method); return method; }]));
  const voiceSetup = { ...setup, install: () => { calls.push('voiceInstall'); return 'voiceInstall'; },
    repair: (...args) => { assert.deepEqual(args, []); calls.push('voiceRepair'); return 'voiceRepair'; } };
  registerModelSetupIpc({ ipcMain: { handle: (channel, action) => handlers.set(channel, action) },
    settingsWindow: { url: frame.url, getWindow: () => window }, setup, voiceSetup });
  for (const action of handlers.values()) {
    for (const event of [{ sender: {}, senderFrame: frame }, { sender: webContents, senderFrame: { url: frame.url } }]) assert.equal(await action(event), null);
  }
  assert.deepEqual(calls, []);
  assert.equal(await handlers.get('settings:model-setup-install')({ sender: webContents, senderFrame: frame }, 'https://untrusted.example/evil.exe'), 'installChatModel');
  assert.equal(await handlers.get('settings:voice-setup-install')({ sender: webContents, senderFrame: frame }, 'untrusted/archive.zip'), 'voiceInstall');
  assert.equal(await handlers.get('settings:voice-setup-repair')({ sender: webContents, senderFrame: frame }, 'C:\\untrusted', { deleteExisting: true }), 'voiceRepair');
  assert.deepEqual(calls, ['installChatModel', 'voiceInstall', 'voiceRepair']);
});

function diagnosticHarness(options = {}) {
  const url = 'file:///settings.html', frame = { url };
  const webContents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false }, handlers = new Map(), copied = [], calls = [];
  const state = { chat: { phase: 'error', diagnostic: null }, voice: { phase: 'error', diagnostic: null } };
  const services = Object.fromEntries(['chat', 'voice'].map(scope => [scope, {
    getState: () => { calls.push(`${scope}:get`); return state[scope]; },
    inspect: async () => state[scope],
    installChatModel: () => ({ ok: true, state: state[scope] }),
    install: () => ({ ok: true, state: state[scope] }),
    repair: () => ({ ok: true, state: state[scope] }),
    cancel: () => ({ ok: true, state: state[scope] }),
  }]));
  const clipboard = options.clipboard || { writeText: value => copied.push(value) };
  registerModelSetupIpc({ ipcMain: { handle: (channel, action) => handlers.set(channel, action) },
    settingsWindow: { url, getWindow: () => window }, setup: services.chat, voiceSetup: services.voice, clipboard,
    getAppInfo: options.getAppInfo || (() => ({ version: '1.4.4', mode: 'local-preview' })) });
  const event = { sender: webContents, senderFrame: frame };
  return { frame, webContents, window, handlers, state, services, copied, calls, event,
    invoke: (channel, ...args) => handlers.get(channel)(event, ...args),
    copy: (...args) => handlers.get('settings:setup-diagnostic-copy')(event, ...args) };
}

test('diagnostic copy has a fixed channel, exact component scope and settings-main-frame authorization', async () => {
  const h = diagnosticHarness(), action = h.handlers.get('settings:setup-diagnostic-copy');
  assert.deepEqual([...h.handlers.keys()].sort(), ['settings:model-setup-cancel', 'settings:model-setup-get',
    'settings:model-setup-inspect', 'settings:model-setup-install', 'settings:setup-diagnostic-copy',
    'settings:voice-setup-cancel', 'settings:voice-setup-get', 'settings:voice-setup-inspect', 'settings:voice-setup-install', 'settings:voice-setup-repair']);
  h.state.voice.diagnostic = createSetupDiagnostic('voice', 'storage-space');
  for (const event of [{ sender: {}, senderFrame: h.frame },
    { sender: h.webContents, senderFrame: { url: h.frame.url } }, { sender: h.webContents, senderFrame: null }]) {
    assert.equal(await action(event, 'voice'), null);
  }
  h.frame.url = 'https://untrusted.example/settings.html';
  assert.equal(await action(h.event, 'voice'), null);
  h.frame.url = 'file:///settings.html';
  h.window.isDestroyed = () => true; assert.equal(await action(h.event, 'voice'), null);
  h.window.isDestroyed = () => false;
  h.webContents.isDestroyed = () => true; assert.equal(await action(h.event, 'voice'), null);
  h.webContents.isDestroyed = () => false;
  for (const invalid of [undefined, null, '', 'model', 'VOICE', '../voice', {}, ['voice']]) assert.equal(await h.copy(invalid), null);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.copied, []);
});

test('voice repair accepts no renderer parameters and requires the live trusted settings main frame', async () => {
  const h = diagnosticHarness(), action = h.handlers.get('settings:voice-setup-repair'), repairs = [];
  h.services.voice.repair = (...args) => { repairs.push(args); return { ok: true }; };
  h.services.voice.install = () => assert.fail('repair must not use the ordinary install entry point');
  const payload = { directory: 'C:\\private', archive: 'https://untrusted.invalid/voice.zip', deleteExisting: true };
  for (const event of [{ sender: {}, senderFrame: h.frame }, { sender: h.webContents, senderFrame: { url: h.frame.url } },
    { sender: h.webContents, senderFrame: null }]) assert.equal(await action(event, payload), null);
  h.frame.url = 'https://untrusted.invalid/settings.html'; assert.equal(await action(h.event, payload), null);
  h.frame.url = 'file:///settings.html';
  h.window.isDestroyed = () => true; assert.equal(await action(h.event, payload), null); h.window.isDestroyed = () => false;
  h.webContents.isDestroyed = () => true; assert.equal(await action(h.event, payload), null); h.webContents.isDestroyed = () => false;
  assert.deepEqual(repairs, []);
  assert.deepEqual(await action(h.event, payload, 'arbitrary command'), { ok: true });
  assert.deepEqual(repairs, [[]]);
});

test('diagnostic copy includes app metadata and only the selected host-owned diagnostic', async () => {
  const h = diagnosticHarness();
  h.state.chat = { phase: 'error', diagnostic: createSetupDiagnostic('chat', 'network-http', { httpStatus: 429 }) };
  h.state.voice = { phase: 'error', diagnostic: createSetupDiagnostic('voice', 'installation-missing-files', {
    missingFiles: ['python/python.exe', 'models/cache/runtime.bin'], missingCount: 2, expectedVersion: 1, actualVersion: 2,
    requiredBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3,
  }) };
  for (const scope of ['chat', 'voice']) {
    assert.deepEqual(await h.copy(scope, { summary: 'renderer forged text' }), { ok: true });
    const report = JSON.parse(h.copied.at(-1));
    assert.deepEqual(Object.keys(report).sort(), ['appVersion', 'component', 'diagnostic', 'generatedAt', 'mode', 'phase', 'schemaVersion']);
    assert.equal(report.schemaVersion, 1); assert.equal(report.appVersion, '1.4.4'); assert.equal(report.mode, 'local-preview');
    assert.equal(report.component, scope); assert.equal(report.phase, 'error');
    assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(report.diagnostic, h.state[scope].diagnostic);
    assert.ok(report.diagnostic.action.length > 0); assert.doesNotMatch(h.copied.at(-1), /renderer forged/);
  }
  assert.equal(JSON.parse(h.copied[0]).diagnostic.details.httpStatus, 429);
  assert.deepEqual(JSON.parse(h.copied[1]).diagnostic.details.missingFiles, ['python/python.exe', 'models/cache/runtime.bin']);
});

test('diagnostic copy rebuilds safe text and filters private paths, signed URLs, tokens and chat content', async () => {
  const h = diagnosticHarness({ getAppInfo: () => ({ version: 'C:\\private-version', mode: 'https://private-mode?token=secret' }) });
  const canonical = createSetupDiagnostic('voice', 'validation-exit');
  h.state.voice = { phase: 'https://private-phase', conversations: ['private chat contents'], error: 'secret raw traceback',
    diagnostic: { ...canonical, scope: 'chat', stage: 'C:\\private-stage', summary: 'private summary', action: 'private action',
      details: { systemCode: 'EACCES', exitCode: 2, missingCount: 1,
        missingFiles: ['python/python.exe', 'C:\\Users\\private-user\\model.bin', '/private-path/model',
          '../private-parent', 'https://private-url?token=secret'],
        url: 'https://private-download?token=secret', token: 'private-token', stack: 'private traceback',
        chat: 'private chat contents', arbitraryPath: 'D:\\private-path', rawOutput: 'private child output',
        requiredBytes: 'https://private-storage?token=secret', availableBytes: -1 } } };
  assert.deepEqual(await h.copy('voice', 'private renderer text'), { ok: true });
  const report = JSON.parse(h.copied[0]);
  assert.equal(report.appVersion, 'unknown'); assert.equal(report.mode, 'unknown'); assert.equal(report.phase, 'unknown');
  assert.equal(report.diagnostic.scope, 'voice'); assert.equal(report.diagnostic.stage, 'validate');
  assert.equal(report.diagnostic.summary, canonical.summary); assert.equal(report.diagnostic.action, canonical.action);
  assert.deepEqual(report.diagnostic.details, { systemCode: 'EACCES', exitCode: 2, missingCount: 1, missingFiles: ['python/python.exe'] });
  assert.doesNotMatch(h.copied[0], /private|secret|traceback|https?:|C:\\|D:\\/i);
});

test('diagnostic copy reports absent diagnostics and clipboard failure without copying renderer text', async () => {
  const h = diagnosticHarness();
  assert.equal((await h.copy('chat', { code: 'FS-101' })).ok, false);
  h.state.chat.diagnostic = { code: 'FORGED-UNKNOWN', summary: 'private renderer text' };
  assert.equal((await h.copy('chat')).ok, false); assert.deepEqual(h.copied, []);
  const failed = diagnosticHarness({ clipboard: { writeText: () => { throw new Error('private clipboard failure'); } } });
  failed.state.chat.diagnostic = createSetupDiagnostic('chat', 'storage-permission');
  const result = await failed.copy('chat'); assert.equal(result.ok, false);
  assert.match(result.error, /复制/); assert.doesNotMatch(result.error, /private|clipboard/i);
});

test('a rejected preview installation can copy its top-level diagnostic and successful reinspection clears it', async () => {
  const h = diagnosticHarness();
  h.state.voice = { phase: 'needs-install', diagnostic: null, allowDownloads: false };
  h.services.voice.install = () => ({ ok: false, diagnostic: createSetupDiagnostic('voice', 'preview-disabled'), state: h.state.voice });
  const denied = await h.invoke('settings:voice-setup-install'); assert.equal(denied.ok, false);
  assert.deepEqual(await h.copy('voice'), { ok: true });
  assert.equal(JSON.parse(h.copied[0]).diagnostic.code, createSetupDiagnostic('voice', 'preview-disabled').code);
  assert.equal((await h.copy('chat')).ok, false, 'voice refusal must not replace the chat diagnostic');
  h.state.voice = { phase: 'ready', ready: true, diagnostic: null };
  await h.invoke('settings:voice-setup-inspect');
  assert.equal((await h.copy('voice')).ok, false); assert.equal(h.copied.length, 1);
});

test('a rejected preview repair copies only its canonical top-level refusal and clears after recovery', async () => {
  const h = diagnosticHarness();
  h.state.voice = { phase: 'needs-install', diagnostic: null, allowDownloads: false };
  h.services.voice.repair = (...args) => {
    assert.deepEqual(args, []);
    return { ok: false, diagnostic: { ...createSetupDiagnostic('voice', 'preview-disabled'),
      summary: 'private forged summary', details: { url: 'https://private.invalid/?token=secret', requiredBytes: 'secret', availableBytes: NaN } },
      state: h.state.voice };
  };
  const denied = await h.invoke('settings:voice-setup-repair', { force: true, directory: 'C:\\private' });
  assert.equal(denied.ok, false); assert.equal(denied.diagnostic.code, 'MODE-101');
  assert.deepEqual(await h.copy('voice', 'renderer secret'), { ok: true });
  const report = JSON.parse(h.copied[0]);
  assert.deepEqual(report.diagnostic, createSetupDiagnostic('voice', 'preview-disabled'));
  assert.doesNotMatch(h.copied[0], /private|secret|https?:/i);
  assert.equal((await h.copy('chat')).ok, false);
  h.state.voice = { phase: 'ready', ready: true, diagnostic: null };
  await h.invoke('settings:voice-setup-inspect');
  assert.equal((await h.copy('voice')).ok, false); assert.equal(h.copied.length, 1);
});

test('a newer host failure replaces a rejected operation diagnostic without another setup IPC call', async () => {
  for (const scope of ['chat', 'voice']) {
    const h = diagnosticHarness(), method = scope === 'chat' ? 'installChatModel' : 'install';
    const channel = scope === 'chat' ? 'settings:model-setup-install' : 'settings:voice-setup-install';
    const previous = { phase: 'needs-install', diagnostic: null, allowDownloads: false };
    h.state[scope] = previous;
    h.services[scope][method] = () => ({ ok: false, diagnostic: createSetupDiagnostic(scope, 'preview-disabled'), state: previous });
    assert.equal((await h.invoke(channel)).ok, false);
    h.state[scope] = { phase: 'error', diagnostic: createSetupDiagnostic(scope, 'storage-space') };
    assert.deepEqual(await h.copy(scope), { ok: true });
    const report = JSON.parse(h.copied[0]);
    assert.equal(report.phase, 'error'); assert.equal(report.diagnostic.code, 'FS-101');
    assert.deepEqual(report.diagnostic, h.state[scope].diagnostic);
  }
});

test('host recovery clears a rejected operation diagnostic without an extra get or inspect call', async () => {
  for (const scope of ['chat', 'voice']) {
    const h = diagnosticHarness(), method = scope === 'chat' ? 'installChatModel' : 'install';
    const channel = scope === 'chat' ? 'settings:model-setup-install' : 'settings:voice-setup-install';
    const previous = { phase: 'needs-install', diagnostic: null, allowDownloads: false };
    h.state[scope] = previous;
    h.services[scope][method] = () => ({ ok: false, diagnostic: createSetupDiagnostic(scope, 'preview-disabled'), state: previous });
    assert.equal((await h.invoke(channel)).ok, false);
    h.state[scope] = { phase: 'ready', ready: true, diagnostic: null };
    assert.equal((await h.copy(scope)).ok, false);
    assert.deepEqual(h.copied, [], 'a recovered environment must not copy its old refusal');
  }
});

test('a delayed rejection cannot replace a newer host failure or a recovered state', async () => {
  for (const scope of ['chat', 'voice']) {
    for (const recovered of [false, true]) {
      const h = diagnosticHarness(), method = scope === 'chat' ? 'installChatModel' : 'install';
      const channel = scope === 'chat' ? 'settings:model-setup-install' : 'settings:voice-setup-install';
      const previous = { phase: 'needs-install', diagnostic: null, allowDownloads: false };
      h.state[scope] = previous;
      let finish;
      h.services[scope][method] = () => new Promise(resolve => { finish = resolve; });
      const pending = h.invoke(channel);
      h.state[scope] = recovered ? { phase: 'ready', ready: true, diagnostic: null }
        : { phase: 'error', diagnostic: createSetupDiagnostic(scope, 'storage-space') };
      finish({ ok: false, diagnostic: createSetupDiagnostic(scope, 'preview-disabled'), state: previous });
      assert.equal((await pending).ok, false);
      const copied = await h.copy(scope);
      if (recovered) {
        assert.equal(copied.ok, false); assert.deepEqual(h.copied, []);
      } else {
        assert.deepEqual(copied, { ok: true });
        assert.equal(JSON.parse(h.copied[0]).diagnostic.code, 'FS-101');
      }
    }
  }
});
