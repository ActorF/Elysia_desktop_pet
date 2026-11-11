/** Owns only the quick-chat binding and its small, atomically saved preference file. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DEFAULT_QUICK_CHAT_SETTINGS = Object.freeze({ enabled: true, accelerator: 'Control+Alt+E' });
const MODIFIERS = Object.freeze({ ctrl: 'Control', control: 'Control', commandorcontrol: 'Control', cmdorctrl: 'Control',
  alt: 'Alt', option: 'Alt', shift: 'Shift', meta: 'Super', super: 'Super', command: 'Super', cmd: 'Super', win: 'Super' });
const ORDER = ['Control', 'Alt', 'Shift', 'Super'];
const NAMED_KEYS = Object.freeze(Object.fromEntries(['Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right'].map(key => [key.toLowerCase(), key])));
const KEY_ALIASES = Object.freeze({ return: 'Enter', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', spacebar: 'Space', del: 'Delete', ins: 'Insert' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeAccelerator(value) {
  if (typeof value !== 'string' || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('请按下修饰键与一个按键的组合。');
  const parts = value.split('+').map(part => part.trim());
  if (parts.length < 2 || parts.length > 5 || parts.some(part => !part)) throw new Error('快捷键需要 Ctrl、Alt 或 Win，再加一个按键。');
  const lookup = (table, key) => Object.hasOwn(table, key) ? table[key] : undefined;
  const rawKey = parts.pop().toLowerCase(), modifiers = parts.map(part => lookup(MODIFIERS, part.toLowerCase()));
  if (modifiers.some(modifier => !modifier) || new Set(modifiers).size !== modifiers.length
    || !modifiers.some(modifier => modifier !== 'Shift')) throw new Error('快捷键需要 Ctrl、Alt 或 Win，再加一个按键。');
  const key = /^[a-z0-9]$/.test(rawKey) ? rawKey.toUpperCase() : /^f(?:[1-9]|1\d|2[0-4])$/.test(rawKey)
    ? rawKey.toUpperCase() : lookup(NAMED_KEYS, rawKey) || lookup(KEY_ALIASES, rawKey);
  if (!key) throw new Error('这个按键不能用作快捷聊天快捷键，Esc 用于关闭输入框。');
  const ordered = ORDER.filter(modifier => modifiers.includes(modifier));
  if (ordered.join('+') === 'Control+Alt' && /^(?:P|[0-9]|F[1-6]|Backspace)$/.test(key)) {
    throw new Error('这个组合已用于桌宠恢复或互动操作，请选择其他快捷键。');
  }
  return [...ordered, key].join('+');
}

function validateSettings(patch, previous) {
  if (!object(patch)) throw new Error('快捷聊天设置格式无效。');
  const next = { ...previous };
  if (Object.hasOwn(patch, 'enabled')) {
    if (typeof patch.enabled !== 'boolean') throw new Error('快捷聊天开关须为开启或关闭。');
    next.enabled = patch.enabled;
  }
  if (Object.hasOwn(patch, 'accelerator')) next.accelerator = normalizeAccelerator(patch.accelerator);
  return next;
}

function createQuickChatShortcut({ globalShortcut, directory, onActivate, onChange = () => {} }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Shortcut settings directory must be absolute.');
  const file = path.join(directory, 'quick-chat-settings.json');
  let settings = { ...DEFAULT_QUICK_CHAT_SETTINGS }, capturing = false, disposed = false;
  let operationError = null, registrationError = null;
  const owned = new Set();
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('invalid-file');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!object(saved) || typeof saved.enabled !== 'boolean' || typeof saved.accelerator !== 'string') throw new Error('invalid-settings');
    settings = validateSettings(saved, settings);
  } catch (error) {
    if (error.code !== 'ENOENT') operationError = '快捷聊天设置读取失败，已使用默认快捷键；原文件保留到你重新保存设置。';
  }
  const getState = () => ({ ...settings, registered: settings.enabled && !capturing && owned.has(settings.accelerator), error: operationError || registrationError });
  function publish() { const snapshot = getState(); if (!disposed) onChange(snapshot); return snapshot; }
  function fail(message) { operationError = message; return publish(); }
  function register(accelerator) {
    try {
      if (!globalShortcut.register(accelerator, () => {
        if (disposed || capturing || !settings.enabled || settings.accelerator !== accelerator || !owned.has(accelerator)) return;
        try { void Promise.resolve(onActivate()).catch(() => { if (!disposed) fail('快捷聊天暂时无法打开，请重试。'); }); }
        catch { fail('快捷聊天暂时无法打开，请重试。'); }
      })) return false;
      owned.add(accelerator); return true;
    } catch { return false; }
  }
  function unregister(accelerator) {
    if (!owned.has(accelerator)) return;
    globalShortcut.unregister(accelerator); owned.delete(accelerator);
  }
  function save(next) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      const parent = fs.lstatSync(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('invalid-directory');
      try {
        const existing = fs.lstatSync(file);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('invalid-file');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function setSettings(patch) {
    if (disposed) return fail('快捷聊天快捷键已关闭。');
    let next;
    try { next = validateSettings(patch, settings); } catch (error) { return fail(error.message); }
    const requested = next.enabled ? next.accelerator : null;
    let added = null;
    if (requested && !owned.has(requested)) {
      if (!register(requested)) return fail('这个快捷键已被其他程序占用或无法注册，请选择其他组合。');
      added = requested;
    }
    try { save(next); }
    catch {
      if (added) unregister(added);
      return fail('快捷聊天设置未能保存，已保留原快捷键。请检查用户目录权限和磁盘空间。');
    }
    settings = next; operationError = null; registrationError = null;
    for (const accelerator of [...owned]) if (capturing || accelerator !== requested) unregister(accelerator);
    return publish();
  }
  function setCapturing(value) {
    if (disposed) return getState();
    if (typeof value !== 'boolean') return fail('快捷键录制状态无效。');
    if (capturing === value) return getState();
    capturing = value;
    if (capturing) {
      for (const accelerator of [...owned]) unregister(accelerator);
      operationError = null; registrationError = null;
    } else if (settings.enabled && !owned.has(settings.accelerator)) {
      registrationError = register(settings.accelerator) ? null : '快捷聊天快捷键已被其他程序占用，请在设置中更换。';
    }
    return publish();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const accelerator of [...owned]) unregister(accelerator);
  }
  if (settings.enabled && !register(settings.accelerator)) registrationError = '快捷聊天快捷键已被其他程序占用，请在设置中更换。';
  return { getState, setSettings, setCapturing, dispose };
}

module.exports = { createQuickChatShortcut, normalizeAccelerator, DEFAULT_QUICK_CHAT_SETTINGS };
