// Optional setup UI. First-run preparation is owned by the host; inspection alone never downloads.
const desktop = window.elysiaSettings;
const required = ['getModelSetup', 'inspectModelSetup', 'installChatModel', 'cancelModelSetup', 'onModelSetup'];
const stageNames = { inspection: '检测安装', download: '下载资源', verify: '校验资源', extract: '解压资源', validate: '检查完整性', start: '启动服务', storage: '读取或保存文件' };
function createDiagnosticPanel(component) {
  const panel = document.createElement('div'); panel.className = 'model-setup-diagnostic'; panel.id = `${component}-setup-diagnostic`; panel.hidden = true;
  const action = document.createElement('p'); action.className = 'hint'; action.id = `${component}-setup-recovery`;
  const meta = document.createElement('p'); meta.className = 'hint'; meta.id = `${component}-setup-error-code`;
  const details = document.createElement('details'), title = document.createElement('summary'), content = document.createElement('pre');
  title.textContent = '查看问题详情'; details.append(title, content);
  const row = document.createElement('div'); row.className = 'model-setup-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'text-button'; copy.textContent = '复制错误信息'; copy.id = `${component}-setup-copy-error`;
  const feedback = document.createElement('span'); feedback.className = 'hint'; feedback.setAttribute('role', 'status');
  row.append(copy, feedback); panel.append(action, meta, details, row);
  let key = '', revision = 0, copying = false;
  copy.addEventListener('click', async () => {
    const captured = revision; copying = true; copy.disabled = true; feedback.textContent = '';
    try {
      const result = await desktop.copySetupDiagnostic(component === 'model' ? 'chat' : 'voice');
      if (captured === revision) feedback.textContent = result?.ok ? '已复制，可粘贴给开发者。' : result?.error || '复制失败，请重试。';
    } catch { if (captured === revision) feedback.textContent = '复制失败，请重试。'; }
    finally { copying = false; copy.disabled = false; }
  });
  function render(value) {
    const valid = value && typeof value.code === 'string' && typeof value.summary === 'string' && typeof value.action === 'string';
    const nextKey = valid ? JSON.stringify(value) : '';
    if (nextKey !== key) { key = nextKey; revision++; feedback.textContent = ''; details.open = false; }
    panel.hidden = !valid;
    if (!valid) return;
    action.textContent = value.action;
    meta.textContent = `错误编号：${value.code} · 阶段：${stageNames[value.stage] || '未确认'}`;
    const extra = value.details || {}, lines = [];
    if (Number.isInteger(extra.httpStatus)) lines.push(`服务器响应：HTTP ${extra.httpStatus}`);
    if (typeof extra.systemCode === 'string') lines.push(`系统错误：${extra.systemCode}`);
    if (Number.isInteger(extra.exitCode)) lines.push(`进程退出代码：${extra.exitCode}`);
    if (Number.isInteger(extra.actualVersion)) lines.push(`安装记录版本：${extra.actualVersion}`);
    if (Number.isInteger(extra.expectedVersion)) lines.push(`需要的记录版本：${extra.expectedVersion}`);
    if (Number.isSafeInteger(extra.requiredBytes)) lines.push(`本步骤需要可用空间：${(extra.requiredBytes / 1024 ** 3).toFixed(2)} GB`);
    if (Number.isSafeInteger(extra.availableBytes)) lines.push(`当前可用空间：${(extra.availableBytes / 1024 ** 3).toFixed(2)} GB`);
    if (Array.isArray(extra.missingFiles) && extra.missingFiles.length) lines.push('缺失文件：', ...extra.missingFiles);
    if (Number.isInteger(extra.missingCount) && extra.missingCount > (extra.missingFiles?.length || 0)) lines.push(`共缺少 ${extra.missingCount} 个文件。`);
    content.textContent = lines.join('\n'); details.hidden = lines.length === 0;
    copy.hidden = typeof desktop.copySetupDiagnostic !== 'function'; copy.disabled = copying;
  }
  return { panel, render };
}
async function initializeChatModelSetup() {
if (desktop && required.every(method => typeof desktop[method] === 'function')) {
  const LOCAL_SETTINGS = { baseUrl: 'http://127.0.0.1:18434', model: 'elysia-chat' };
  const element = (tag, className, text) => {
    const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  const card = element('section', 'card model-setup-card'); card.id = 'model-setup-card'; card.setAttribute('aria-labelledby', 'model-setup-title');
  const heading = element('div', 'section-heading'), title = element('h2', '', '本地聊天模型'); title.id = 'model-setup-title';
  const badge = element('span', 'voice-badge', '正在检查'); badge.id = 'model-setup-badge'; heading.append(title, badge);
  const description = element('p', 'hint', '首次运行自动准备所需模型，可在这里查看进度或取消。聊天模型约 5.8 GB，之后随桌宠在后台启动。');
  const status = element('p', 'model-setup-status'); status.id = 'model-setup-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const meter = element('div', 'model-setup-progress'); meter.hidden = true;
  const progress = element('progress'); progress.id = 'model-setup-progress'; progress.max = 100; progress.setAttribute('aria-label', '模型配置进度');
  const progressText = element('span', 'hint'); progressText.id = 'model-setup-progress-text'; meter.append(progress, progressText);
  const error = element('p', 'voice-error'); error.id = 'model-setup-error'; error.hidden = true; error.setAttribute('role', 'alert');
  const diagnosticPanel = createDiagnosticPanel('model');
  const actions = element('div', 'model-setup-actions');
  const install = element('button', 'primary-button', '准备本地模型'); install.id = 'model-setup-install'; install.type = 'button'; install.disabled = true;
  const cancel = element('button', 'text-button', '取消'); cancel.id = 'model-setup-cancel'; cancel.type = 'button'; cancel.hidden = true;
  const inspect = element('button', 'text-button', '重新检测'); inspect.id = 'model-setup-inspect'; inspect.type = 'button';
  const useLocal = element('button', 'primary-button', '使用本地模型'); useLocal.id = 'model-setup-use-local'; useLocal.type = 'button'; useLocal.hidden = true;
  actions.append(install, useLocal, cancel, inspect);
  const voiceNote = element('p', 'hint model-setup-voice', '聊天模型就绪后可以文字聊天，语音环境单独配置。');
  card.append(heading, description, status, meter, error, diagnosticPanel.panel, actions, voiceNote);
  document.querySelector('#chat-settings-form').before(card);
  let state = null, chatState = null, revision = 0, pending = false, localError = null, localDiagnostic = null;
  const labels = { idle: '待检测', checking: '正在检测', 'needs-install': '待安装', 'needs-model': '待下载', 'downloading-installer': '正在下载', 'verifying-installer': '正在校验', installing: '正在安装', starting: '正在启动', 'pulling-model': '正在下载', ready: '已就绪', cancelled: '已取消', error: '未完成' };
  const messages = {
    idle: '检查这台电脑上的聊天环境。', checking: '正在检查聊天环境…', 'needs-install': '本地聊天环境尚未准备好，可以重新开始配置。',
    'needs-model': '聊天运行环境已就绪，模型尚待准备。', 'downloading-installer': '正在下载聊天运行环境…', 'verifying-installer': '正在校验下载内容…',
    installing: '正在解压聊天运行环境，请稍候…', starting: '正在加载本地聊天模型…', 'pulling-model': '正在下载聊天模型，所需时间取决于网络速度。',
    ready: '本地聊天模型已就绪。', cancelled: '已取消，可以稍后继续配置。', error: '配置尚未完成，请重试。',
  };
  const bytes = value => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${(value / 1e6).toFixed(1)} MB`;
  function render() {
    const phase = state?.phase || 'idle', busy = state?.busy === true;
    const current = chatState?.settings?.baseUrl === LOCAL_SETTINGS.baseUrl && chatState?.settings?.model === LOCAL_SETTINGS.model;
    badge.textContent = labels[phase] || '配置中';
    status.textContent = phase === 'ready' && current ? '已就绪，当前聊天正在使用本地模型。' : state?.message || messages[phase] || '正在配置聊天环境…';
    install.hidden = phase === 'ready' || state?.allowDownloads === false; install.disabled = !state || pending || busy || state?.allowDownloads === false;
    description.textContent = state?.allowDownloads === false ? '本地测试仅使用这台电脑已有的聊天资源，不会下载或安装。' : '首次运行自动准备所需模型，可在这里查看进度或取消。聊天模型约 5.8 GB，之后随桌宠在后台启动。';
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
    const diagnosis = localDiagnostic || state?.diagnostic;
    const problem = diagnosis?.summary || localError || state?.error; error.hidden = !problem; error.textContent = typeof problem === 'string' ? problem : problem ? '配置暂未完成，请重试。' : '';
    status.hidden = Boolean(diagnosis && status.textContent === diagnosis.summary);
    diagnosticPanel.render(problem ? diagnosis : null);
  }
  function receive(value) { if (!value || typeof value.phase !== 'string') return; state = value; revision++;
    localError = null; localDiagnostic = null;
    render(); }
  async function run(operation) {
    if (pending) return null;
    pending = true; localError = null; localDiagnostic = null; render();
    const before = revision;
    try {
      const result = await operation();
      if (before !== revision) return result;
      const next = result?.state || result;
      if (next?.phase) receive(next);
      if (result === false || result?.ok === false) { localDiagnostic = result?.diagnostic ?? null; localError = result?.error || '配置暂未完成，请重试。'; return null; }
      return result;
    } catch (failure) { if (before === revision) localError = failure?.message || '配置暂未完成，请重试。'; return null; }
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
  const diagnosticPanel = createDiagnosticPanel('voice');
  const actions = element('div', 'model-setup-actions');
  const install = element('button', 'primary-button', '准备语音环境'); install.id = 'voice-setup-install'; install.type = 'button'; install.disabled = true;
  const repair = element('button', 'primary-button', '修复语音环境'); repair.id = 'voice-setup-repair'; repair.type = 'button'; repair.hidden = true;
  const cancel = element('button', 'text-button', '取消'); cancel.id = 'voice-setup-cancel'; cancel.type = 'button'; cancel.hidden = true;
  const inspect = element('button', 'text-button', '重新检测'); inspect.id = 'voice-setup-inspect'; inspect.type = 'button';
  actions.append(install, repair, cancel, inspect);
  const note = element('p', 'hint model-setup-voice', '准备完成后可手动朗读回复，也可开启“朗读聊天回复”。仅准备资源不会启动语音模型。');
  card.append(heading, description, status, meter, error, diagnosticPanel.panel, actions, note);
  document.querySelector('#chat-settings-form').before(card);
  let state = null, revision = 0, pending = false, localError = null, localDiagnostic = null;
  const labels = { idle: '待检测', 'needs-install': '待准备', checking: '正在检测', verifying: '正在校验', downloading: '正在下载', extracting: '正在解压', validating: '正在检查', finishing: '正在完成', ready: '已就绪', cancelled: '已取消', error: '未完成' };
  const messages = {
    idle: '检查这台电脑上的语音环境。', 'needs-install': '语音资源尚未准备好，可以重新开始配置。', checking: '正在检查语音环境…',
    verifying: '正在校验语音资源…', downloading: '正在下载语音资源，完成后会自动配置。', extracting: '正在解压语音资源…', validating: '正在检查语音环境是否完整…',
    ready: '本地语音资源已准备好。朗读仍需满足当前语音和屏幕状态要求。', cancelled: '已取消语音配置，文字聊天不受影响。', error: '语音配置尚未完成，文字聊天仍可使用。',
  };
  const bytes = value => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${(value / 1e6).toFixed(1)} MB`;
  function render() {
    const phase = state?.phase || 'idle', busy = state?.busy === true, ready = phase === 'ready' && state?.ready === true;
    const existing = state?.installation?.exists === true, needsAttention = existing && !ready;
    const downloadsDisabled = state?.allowDownloads === false;
    const repairAvailable = state?.repairAvailable === true && !downloadsDisabled && typeof desktop.repairVoiceSetup === 'function';
    badge.textContent = phase === 'ready' && !ready ? '未完成' : labels[phase] || '配置中';
    status.textContent = phase === 'ready' && !ready ? '语音环境尚未确认就绪。' : state?.message || messages[phase] || '正在配置语音环境…';
    description.textContent = downloadsDisabled ? '本地测试仅使用这台电脑已有的语音资源，不会下载或安装。'
      : existing ? ready ? '正在使用本机已有的语音资源。' : '检测到已有语音文件，请先查看安装状态。'
        : '首次运行自动准备朗读所需资源，进度与聊天模型分别显示。' + (state?.expectedBytes > 0 ? `资源下载约 ${bytes(state.expectedBytes)}。` : '');
    install.hidden = ready || needsAttention || downloadsDisabled; install.disabled = !state || pending || busy || needsAttention || downloadsDisabled;
    install.textContent = busy ? '正在配置…' : ['error', 'cancelled', 'needs-install'].includes(phase) ? '重试配置' : '准备语音环境';
    repair.hidden = !repairAvailable || ready; repair.disabled = !repairAvailable || pending || busy;
    note.textContent = repairAvailable ? '修复优先复用已下载的安装包，缺失或损坏时才下载。新环境检查通过后切换，旧目录保留为备份。'
      : needsAttention ? '现有文件已保留；修复缺失文件或安装记录后点击“重新检测”。请勿删除模型或下载缓存。'
      : downloadsDisabled && !ready ? '请先确认已有语音环境的安装状态，再点击“重新检测”。文字聊天仍可使用。'
        : '准备完成后可手动朗读回复，也可开启“朗读聊天回复”。仅准备资源不会启动语音模型。';
    cancel.hidden = !busy; cancel.disabled = pending || !state?.canCancel;
    inspect.disabled = pending || busy; meter.hidden = !busy;
    const completed = Math.max(0, Number(state?.completedBytes) || 0), total = Math.max(0, Number(state?.totalBytes) || 0);
    const percentage = total > 0 ? completed / total * 100 : Number.isFinite(state?.progress) ? state.progress * 100 : null;
    if (percentage === null) progress.removeAttribute('value'); else progress.value = Math.max(0, Math.min(100, percentage));
    progressText.textContent = total > 0 ? `${bytes(completed)} / ${bytes(total)} · ${Math.min(100, Math.round(completed / total * 100))}%` : '';
    const diagnosis = localDiagnostic || state?.diagnostic;
    const problem = diagnosis?.summary || localError || state?.error;
    error.hidden = !problem; error.textContent = typeof problem === 'string' ? problem : problem ? '语音配置暂未完成，请重试。' : '';
    status.hidden = Boolean(diagnosis && status.textContent === diagnosis.summary);
    diagnosticPanel.render(problem ? diagnosis : null);
  }
  function receive(value) { if (!value || typeof value.phase !== 'string') return; state = value; revision++;
    localError = null; localDiagnostic = null;
    render(); }
  async function run(operation) {
    if (pending) return;
    pending = true; localError = null; localDiagnostic = null; render();
    const before = revision;
    try {
      const result = await operation();
      if (before !== revision) return;
      const next = result?.state || result;
      if (next?.phase) receive(next);
      if (result === false || result?.ok === false) { localDiagnostic = result?.diagnostic ?? null; localError = result?.error || '语音配置暂未完成，请重试。'; }
    } catch (failure) { if (before === revision) localError = failure?.message || '语音配置暂未完成，请重试。'; }
    finally { pending = false; render(); }
  }
  install.addEventListener('click', () => void run(() => desktop.installVoiceSetup()));
  repair.addEventListener('click', () => void run(() => desktop.repairVoiceSetup()));
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
