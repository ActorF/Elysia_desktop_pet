// Optional setup UI. First-run preparation is owned by the host; inspection alone never downloads.
const desktop = window.elysiaSettings;
const required = ['getModelSetup', 'inspectModelSetup', 'installChatModel', 'cancelModelSetup', 'onModelSetup'];
async function initializeChatModelSetup() {
if (desktop && required.every(method => typeof desktop[method] === 'function')) {
  const LOCAL_SETTINGS = { baseUrl: 'http://localhost:11434', model: 'tobestyledintro/qwen3.8-9b-distill:latest' };
  const element = (tag, className, text) => {
    const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  const card = element('section', 'card model-setup-card'); card.id = 'model-setup-card'; card.setAttribute('aria-labelledby', 'model-setup-title');
  const heading = element('div', 'section-heading'), title = element('h2', '', '本地聊天模型'); title.id = 'model-setup-title';
  const badge = element('span', 'voice-badge', '正在检查'); badge.id = 'model-setup-badge'; heading.append(title, badge);
  const description = element('p', 'hint', '首次运行自动准备所需模型，可在这里查看进度或取消。聊天模型约 6.7 GB，另需下载 Ollama。');
  const status = element('p', 'model-setup-status'); status.id = 'model-setup-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const meter = element('div', 'model-setup-progress'); meter.hidden = true;
  const progress = element('progress'); progress.id = 'model-setup-progress'; progress.max = 100; progress.setAttribute('aria-label', '模型配置进度');
  const progressText = element('span', 'hint'); progressText.id = 'model-setup-progress-text'; meter.append(progress, progressText);
  const error = element('p', 'voice-error'); error.id = 'model-setup-error'; error.hidden = true; error.setAttribute('role', 'alert');
  const actions = element('div', 'model-setup-actions');
  const install = element('button', 'primary-button', '准备本地模型'); install.id = 'model-setup-install'; install.type = 'button'; install.disabled = true;
  const cancel = element('button', 'text-button', '取消'); cancel.id = 'model-setup-cancel'; cancel.type = 'button'; cancel.hidden = true;
  const inspect = element('button', 'text-button', '重新检测'); inspect.id = 'model-setup-inspect'; inspect.type = 'button';
  const useLocal = element('button', 'primary-button', '使用本地模型'); useLocal.id = 'model-setup-use-local'; useLocal.type = 'button'; useLocal.hidden = true;
  actions.append(install, useLocal, cancel, inspect);
  const voiceNote = element('p', 'hint model-setup-voice', '聊天模型就绪后可以文字聊天，语音环境单独配置。');
  card.append(heading, description, status, meter, error, actions, voiceNote);
  document.querySelector('#chat-settings-form').before(card);
  let state = null, chatState = null, revision = 0, pending = false, localError = null;
  const labels = { idle: '待检测', checking: '正在检测', 'needs-install': '待安装', 'needs-model': '待下载', 'downloading-installer': '正在下载', 'verifying-installer': '正在校验', installing: '正在安装', starting: '正在启动', 'pulling-model': '正在下载', ready: '已就绪', cancelled: '已取消', error: '未完成' };
  const messages = {
    idle: '检查这台电脑上的聊天环境。', checking: '正在检查聊天环境…', 'needs-install': '本地聊天环境尚未准备好，可以重新开始配置。',
    'needs-model': 'Ollama 已就绪，聊天模型尚待准备。', 'downloading-installer': '正在下载 Ollama…', 'verifying-installer': '正在校验下载内容…',
    installing: '正在安装 Ollama，请稍候…', starting: '正在启动本地聊天服务…', 'pulling-model': '正在下载聊天模型，所需时间取决于网络速度。',
    ready: '本地聊天模型已就绪。', cancelled: '已取消，可以稍后继续配置。', error: '配置尚未完成，请重试。',
  };
  const bytes = value => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${(value / 1e6).toFixed(1)} MB`;
  function render() {
    const phase = state?.phase || 'idle', busy = state?.busy === true;
    const current = chatState?.settings?.baseUrl === LOCAL_SETTINGS.baseUrl && chatState?.settings?.model === LOCAL_SETTINGS.model;
    badge.textContent = labels[phase] || '配置中';
    status.textContent = phase === 'ready' && current ? '已就绪，当前聊天正在使用本地模型。' : messages[phase] || '正在配置聊天环境…';
    install.hidden = phase === 'ready'; install.disabled = !state || pending || busy;
    install.textContent = ['error', 'cancelled', 'needs-install', 'needs-model'].includes(phase) ? '重试配置' : busy ? '正在配置…' : '准备本地模型';
    cancel.hidden = !busy; cancel.disabled = pending || !state?.canCancel;
    cancel.title = busy && !state?.canCancel ? '当前步骤完成后可取消' : '取消配置';
    inspect.disabled = pending || busy;
    useLocal.hidden = phase !== 'ready'; useLocal.disabled = pending || !!chatState?.busy || current;
    useLocal.textContent = current ? '当前已使用' : '使用本地模型';
    meter.hidden = !busy;
    const completed = Math.max(0, Number(state?.completedBytes) || 0), total = Math.max(0, Number(state?.totalBytes) || 0);
    const percentage = total > 0 ? completed / total * 100 : Number.isFinite(state?.progress) ? state.progress * 100 : null;
    if (percentage === null) progress.removeAttribute('value'); else progress.value = Math.max(0, Math.min(100, percentage));
    progressText.textContent = total > 0 ? `${bytes(completed)} / ${bytes(total)} · ${Math.min(100, Math.round(completed / total * 100))}%` : '';
    const problem = localError || state?.error; error.hidden = !problem; error.textContent = typeof problem === 'string' ? problem : problem ? '配置暂未完成，请重试。' : '';
  }
  function receive(value) { if (!value || typeof value.phase !== 'string') return; state = value; revision++; render(); }
  async function run(operation) {
    if (pending) return null;
    pending = true; localError = null; render();
    try {
      const before = revision, result = await operation();
      const next = result?.state || result;
      if (before === revision && next?.phase) receive(next);
      if (result === false || result?.ok === false) throw new Error(result?.error || '配置暂未完成，请重试。');
      return result;
    } catch (failure) { localError = failure?.message || '配置暂未完成，请重试。'; return null; }
    finally { pending = false; render(); }
  }
  install.addEventListener('click', () => void run(() => desktop.installChatModel()));
  cancel.addEventListener('click', () => void run(() => desktop.cancelModelSetup()));
  inspect.addEventListener('click', () => void run(() => desktop.inspectModelSetup()));
  useLocal.addEventListener('click', () => void run(async () => {
    const result = await desktop.setChatSettings(LOCAL_SETTINGS);
    if (!result?.settings || result.error || result.storageError) throw new Error(result?.storageError || result?.error || '暂时无法保存聊天设置，请重试。');
    chatState = result; return result;
  }));
  try {
    const stopSetup = desktop.onModelSetup(receive);
    const stopChat = desktop.onChatState?.(value => { chatState = value; render(); });
    const before = revision;
    const [initial, initialChat] = await Promise.all([desktop.getModelSetup(), desktop.getChatState?.()]);
    if (!chatState && initialChat?.settings) chatState = initialChat;
    if (before === revision) receive(initial);
    if (!state || state.phase === 'idle') await run(() => desktop.inspectModelSetup()); else render();
    document.documentElement.dataset.modelSetupReady = 'true';
    window.addEventListener('pagehide', () => { stopSetup?.(); stopChat?.(); }, { once: true });
  } catch (failure) { localError = failure?.message || '暂时无法检测聊天环境。'; render(); }
}
}

async function initializeVoiceSetup() {
  const methods = ['getVoiceSetup', 'inspectVoiceSetup', 'installVoiceSetup', 'cancelVoiceSetup', 'onVoiceSetup'];
  if (!desktop || !methods.every(method => typeof desktop[method] === 'function')) return;
  const element = (tag, className, text) => {
    const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  const card = element('section', 'card model-setup-card'); card.id = 'voice-setup-card'; card.setAttribute('aria-labelledby', 'voice-setup-title');
  const heading = element('div', 'section-heading'), title = element('h2', '', '本地语音环境'); title.id = 'voice-setup-title';
  const badge = element('span', 'voice-badge', '正在检测'); badge.id = 'voice-setup-badge'; heading.append(title, badge);
  const description = element('p', 'hint', '首次运行自动准备朗读所需资源，进度与聊天模型分别显示。');
  const status = element('p', 'model-setup-status'); status.id = 'voice-setup-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const meter = element('div', 'model-setup-progress'); meter.hidden = true;
  const progress = element('progress'); progress.id = 'voice-setup-progress'; progress.max = 100; progress.setAttribute('aria-label', '语音配置进度');
  const progressText = element('span', 'hint'); progressText.id = 'voice-setup-progress-text'; meter.append(progress, progressText);
  const error = element('p', 'voice-error'); error.id = 'voice-setup-error'; error.hidden = true; error.setAttribute('role', 'alert');
  const actions = element('div', 'model-setup-actions');
  const install = element('button', 'primary-button', '准备语音环境'); install.id = 'voice-setup-install'; install.type = 'button'; install.disabled = true;
  const cancel = element('button', 'text-button', '取消'); cancel.id = 'voice-setup-cancel'; cancel.type = 'button'; cancel.hidden = true;
  const inspect = element('button', 'text-button', '重新检测'); inspect.id = 'voice-setup-inspect'; inspect.type = 'button';
  actions.append(install, cancel, inspect);
  const note = element('p', 'hint model-setup-voice', '准备完成后可手动朗读回复，也可开启“朗读聊天回复”。仅准备资源不会启动语音模型。');
  card.append(heading, description, status, meter, error, actions, note);
  document.querySelector('#chat-settings-form').before(card);
  let state = null, revision = 0, pending = false, localError = null;
  const labels = { idle: '待检测', 'needs-install': '待准备', checking: '正在检测', verifying: '正在校验', downloading: '正在下载', extracting: '正在解压', validating: '正在检查', ready: '已就绪', cancelled: '已取消', error: '未完成' };
  const messages = {
    idle: '检查这台电脑上的语音环境。', 'needs-install': '语音资源尚未准备好，可以重新开始配置。', checking: '正在检查语音环境…',
    verifying: '正在校验语音资源…', downloading: '正在下载语音资源，完成后会自动配置。', extracting: '正在解压语音资源…', validating: '正在检查语音环境是否完整…',
    ready: '本地语音环境已就绪，可以朗读聊天回复。', cancelled: '已取消语音配置，文字聊天不受影响。', error: '语音配置尚未完成，文字聊天仍可使用。',
  };
  const bytes = value => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${(value / 1e6).toFixed(1)} MB`;
  function render() {
    const phase = state?.phase || 'idle', busy = state?.busy === true, ready = phase === 'ready' && state?.ready === true;
    badge.textContent = phase === 'ready' && !ready ? '未完成' : labels[phase] || '配置中';
    status.textContent = phase === 'ready' && !ready ? '语音环境尚未确认就绪。' : messages[phase] || '正在配置语音环境…';
    description.textContent = '首次运行自动准备朗读所需资源，进度与聊天模型分别显示。' + (state?.expectedBytes > 0 ? `资源下载约 ${bytes(state.expectedBytes)}。` : '');
    install.hidden = ready; install.disabled = !state || pending || busy;
    install.textContent = busy ? '正在配置…' : ['error', 'cancelled', 'needs-install'].includes(phase) ? '重试配置' : '准备语音环境';
    cancel.hidden = !busy; cancel.disabled = pending || !state?.canCancel;
    inspect.disabled = pending || busy; meter.hidden = !busy;
    const completed = Math.max(0, Number(state?.completedBytes) || 0), total = Math.max(0, Number(state?.totalBytes) || 0);
    const percentage = total > 0 ? completed / total * 100 : Number.isFinite(state?.progress) ? state.progress * 100 : null;
    if (percentage === null) progress.removeAttribute('value'); else progress.value = Math.max(0, Math.min(100, percentage));
    progressText.textContent = total > 0 ? `${bytes(completed)} / ${bytes(total)} · ${Math.min(100, Math.round(completed / total * 100))}%` : '';
    const problem = localError || state?.error;
    error.hidden = !problem; error.textContent = typeof problem === 'string' ? problem : problem ? '语音配置暂未完成，请重试。' : '';
  }
  function receive(value) { if (!value || typeof value.phase !== 'string') return; state = value; revision++; render(); }
  async function run(operation) {
    if (pending) return;
    pending = true; localError = null; render();
    try {
      const before = revision, result = await operation(), next = result?.state || result;
      if (before === revision && next?.phase) receive(next);
      if (result === false || result?.ok === false) throw new Error(result?.error || '语音配置暂未完成，请重试。');
    } catch (failure) { localError = failure?.message || '语音配置暂未完成，请重试。'; }
    finally { pending = false; render(); }
  }
  install.addEventListener('click', () => void run(() => desktop.installVoiceSetup()));
  cancel.addEventListener('click', () => void run(() => desktop.cancelVoiceSetup()));
  inspect.addEventListener('click', () => void run(() => desktop.inspectVoiceSetup()));
  try {
    const stop = desktop.onVoiceSetup(receive), before = revision;
    const initial = await desktop.getVoiceSetup(); if (before === revision) receive(initial);
    if (!state || state.phase === 'idle') await run(() => desktop.inspectVoiceSetup()); else render();
    document.documentElement.dataset.voiceSetupReady = 'true';
    window.addEventListener('pagehide', () => stop?.(), { once: true });
  } catch (failure) { localError = failure?.message || '暂时无法检测语音环境。'; render(); }
}

void initializeChatModelSetup();
void initializeVoiceSetup();
