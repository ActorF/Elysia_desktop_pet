const desktop = window.elysiaSettings;
const section = document.querySelector('#quick-chat-settings');
const find = id => document.getElementById(id);
const supported = ['getQuickChatSettings', 'setQuickChatSettings', 'onQuickChatSettings', 'setQuickChatCapture']
  .every(key => typeof desktop?.[key] === 'function');

// Older settings hosts can keep using the other tabs without this optional bridge.
if (section && supported) {
  const enabled = find('quick-chat-enabled'), record = find('quick-chat-record');
  const save = find('quick-chat-save'), reset = find('quick-chat-reset'), open = find('quick-chat-open');
  const status = find('quick-chat-settings-status'), error = find('quick-chat-settings-error');
  const help = find('quick-chat-help'), key = find('quick-chat-key'), recordLabel = find('quick-chat-record-label');
  const dirty = new Set();
  let snapshot = null, draft = { enabled: true, accelerator: 'Control+Alt+E' };
  let pending = false, capturing = false, captureStarting = false, captureEnding = false, captureToken = 0;
  let revision = 0, localError = '', captureHint = '';
  const readable = accelerator => accelerator.split('+').map(part => ({ Control: 'Ctrl', Super: 'Win', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: '空格' })[part] || part).join(' + ');
  const valid = value => value && typeof value.enabled === 'boolean' && typeof value.accelerator === 'string';
  const plainError = value => typeof value === 'string' ? value : '';

  function render() {
    const recording = capturing || captureStarting || captureEnding;
    enabled.checked = draft.enabled;
    enabled.disabled = !snapshot || pending || recording;
    record.disabled = !snapshot || pending || captureStarting || captureEnding;
    record.setAttribute('aria-pressed', String(capturing));
    recordLabel.textContent = capturing ? '取消编辑' : captureStarting ? '准备编辑…' : '更换快捷键';
    key.textContent = capturing ? '按下组合键…' : readable(draft.accelerator);
    help.textContent = captureHint || (capturing ? '按住 Ctrl、Alt 或 Win，再按一个键；按 Esc 取消本次编辑。'
      : dirty.has('accelerator') ? '新快捷键尚未保存；点击「保存快捷键」后生效。'
      : '点击「更换快捷键」→ 按下新组合键 → 点击「保存快捷键」。');
    save.disabled = !snapshot || pending || recording || !dirty.size;
    reset.disabled = !snapshot || pending || recording;
    open.disabled = !snapshot || pending || recording;
    status.textContent = captureStarting ? '正在准备编辑…' : capturing ? '正在编辑，原快捷键暂时停用' : captureEnding ? '正在恢复快捷键…' : pending ? '正在保存…'
      : !snapshot ? '正在读取…' : dirty.size ? '等待保存' : !snapshot.enabled ? '快捷键已关闭，仍可点击「打开输入框」使用' : snapshot.registered ? '快捷键已生效' : '快捷键暂未生效';
    const message = localError || plainError(snapshot?.error);
    error.textContent = message; error.hidden = !message;
  }
  function receive(value) {
    if (!valid(value)) return;
    snapshot = value; revision++;
    for (const field of ['enabled', 'accelerator']) if (!dirty.has(field)) draft[field] = value[field];
    render();
  }
  function change(field, value) {
    draft[field] = value;
    if (snapshot?.[field] === value) dirty.delete(field); else dirty.add(field);
  }
  async function releaseCapture() {
    const token = ++captureToken;
    const wasRecording = capturing || captureStarting || captureEnding;
    capturing = false; captureStarting = false;
    if (!wasRecording) return;
    captureEnding = true; captureHint = ''; render();
    try {
      const value = await desktop.setQuickChatCapture(false);
      if (token === captureToken && valid(value)) receive(value);
      if (value === false || value?.error) throw new Error('restore');
    } catch { if (token === captureToken) localError = '快捷键暂时未能恢复，请重新编辑或保存。'; }
    finally { if (token === captureToken) captureEnding = false; render(); }
  }
  async function beginCapture() {
    if (!snapshot || pending || captureStarting || captureEnding) return;
    if (capturing) { await releaseCapture(); return; }
    const token = ++captureToken;
    captureStarting = true; captureHint = ''; localError = ''; render();
    try {
      const value = await desktop.setQuickChatCapture(true);
      // Blur can happen before this reply returns. A newer edit owns its own
      // suspension; restoring this old request must not interrupt that edit.
      if (token !== captureToken) {
        if (!capturing && !captureStarting) await desktop.setQuickChatCapture(false);
        return;
      }
      if (value === false || value?.error) throw new Error('capture');
      captureStarting = false; capturing = true;
      record.focus({ preventScroll: true }); render();
    } catch {
      if (token === captureToken) {
        localError = '暂时无法编辑快捷键，请重试。';
        await releaseCapture();
      }
    }
  }
  async function savePatch(patch, fields) {
    if (!snapshot || pending || capturing || captureStarting || captureEnding) return;
    pending = true; localError = ''; render();
    try {
      const value = await desktop.setQuickChatSettings(patch);
      if (valid(value)) receive(value);
      if (!valid(value) || value.error || (value.enabled && !value.registered)) {
        localError = plainError(value?.error) || '这个快捷键暂不可用，请换一个组合后重试。';
        return;
      }
      for (const field of fields) { dirty.delete(field); draft[field] = value[field]; }
    } catch { localError = '快捷输入设置未能保存，修改已保留，请重试。'; }
    finally { pending = false; render(); }
  }
  function acceleratorFor(event) {
    if (!(event.ctrlKey || event.altKey || event.metaKey)) return null;
    let value = '';
    // Latin letters follow the active layout (AZERTY A is code KeyQ). Keep a
    // physical fallback for non-Latin input methods and shifted number keys.
    if (/^[a-z0-9]$/i.test(event.key)) value = event.key.toUpperCase();
    else if (/^Key[A-Z]$/.test(event.code)) value = event.code.slice(3);
    else if (/^Digit[0-9]$/.test(event.code)) value = event.code.slice(5);
    else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.key)) value = event.key;
    else value = ({ ' ': 'Space', Spacebar: 'Space', Enter: 'Enter', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab' })[event.key] || '';
    return value ? [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', value].filter(Boolean).join('+') : null;
  }
  function captureKey(event) {
    if (!capturing) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.isComposing || event.keyCode === 229 || event.repeat) return;
    if (event.key === 'Escape') { void releaseCapture(); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    const accelerator = acceleratorFor(event);
    if (!accelerator) { captureHint = '请同时按住 Ctrl、Alt 或 Win，再按字母、数字或功能键。'; render(); return; }
    change('accelerator', accelerator);
    void releaseCapture();
  }

  section.hidden = false;
  open.hidden = typeof desktop.openQuickChat !== 'function';
  record.addEventListener('click', () => void beginCapture());
  enabled.addEventListener('change', () => {
    change('enabled', enabled.checked);
    // Toggling the switch does not silently save an unfinished shortcut edit.
    void savePatch({ enabled: draft.enabled, accelerator: snapshot.accelerator }, ['enabled']);
  });
  save.addEventListener('click', () => void savePatch({ ...draft }, ['enabled', 'accelerator']));
  reset.addEventListener('click', () => { change('accelerator', 'Control+Alt+E'); void savePatch({ ...draft }, ['enabled', 'accelerator']); });
  open.addEventListener('click', async () => {
    localError = ''; render();
    try {
      const value = await desktop.openQuickChat();
      if (value === false || value?.error) { localError = plainError(value?.error) || '暂时无法打开输入框，请重试。'; render(); }
    } catch { localError = '暂时无法打开输入框，请重试。'; render(); }
  });
  document.addEventListener('keydown', captureKey, true);
  window.addEventListener('blur', () => void releaseCapture());
  document.addEventListener('visibilitychange', () => { if (document.hidden) void releaseCapture(); });
  const panel = document.querySelector('#panel-chat');
  const observer = new MutationObserver(() => { if (panel.hidden) void releaseCapture(); });
  observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  const unsubscribe = desktop.onQuickChatSettings(receive);
  window.addEventListener('pagehide', () => { void releaseCapture(); unsubscribe?.(); observer.disconnect(); document.removeEventListener('keydown', captureKey, true); }, { once: true });
  try {
    const before = revision, value = await desktop.getQuickChatSettings();
    if (before === revision) receive(value);
    if (!snapshot) throw new Error('unavailable');
    document.documentElement.dataset.quickChatSettingsReady = 'true';
  } catch { localError = '暂时无法读取快捷输入设置，请重新打开设置窗口。'; render(); }
}
