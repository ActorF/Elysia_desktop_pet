// Normal voice preferences and current playback share the independent settings window.
const desktop = window.elysiaSettings;
const find = selector => document.querySelector(selector);
const errorNode = find('#voice-error'), interactionError = find('#voice-interaction-error');
const enabled = find('#voice-enabled'), dnd = find('#voice-dnd');
const volume = find('#voice-volume'), volumeValue = find('#voice-volume-value');
const birthdayMonth = find('#voice-birthday-month'), birthdayDay = find('#voice-birthday-day');
const birthdayHint = find('#voice-birthday-hint');
const status = find('#voice-playback-status'), subtitle = find('#voice-playback-line');
const stopButton = find('#voice-stop');
let snapshot = null, revision = 0, pending = Promise.resolve();

function fail(error) {
  errorNode.textContent = error?.message || String(error || '语音操作未完成，请重试。');
  errorNode.hidden = false;
}
function command(operation) {
  errorNode.hidden = true;
  pending = pending.then(async () => {
    const before = revision;
    const result = await operation();
    if (result === false || result?.ok === false) throw new Error(result?.error || '语音操作未完成，请重试。');
    // A state broadcast that arrived during this request is more current than its reply.
    if (before === revision && result?.settings) receive(result);
    if (result?.error) fail(new Error(result.error));
  }).catch(fail);
  return pending;
}
const patch = value => command(() => desktop.setVoiceSettings(value));

enabled.addEventListener('change', () => void patch({ enabled: enabled.checked }));
dnd.addEventListener('change', () => void patch({ dnd: dnd.checked }));
volume.addEventListener('input', () => { volumeValue.value = volume.value + '%'; });
volume.addEventListener('change', () => void patch({ volume: Number(volume.value) / 100 }));
find('#voice-birthday-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!birthdayMonth.value && !birthdayDay.value) { void patch({ birthday: '' }); return; }
  const month = birthdayMonth.valueAsNumber, day = birthdayDay.valueAsNumber;
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    fail(new Error('请填写有效的生日月、日，例如 5 月 20 日。')); return;
  }
  birthdayMonth.blur(); birthdayDay.blur();
  void patch({ birthday: String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0') });
});
find('#voice-clear-birthday').addEventListener('click', () => {
  birthdayMonth.value = ''; birthdayDay.value = ''; void patch({ birthday: '' });
});
stopButton.addEventListener('click', () => void command(() => desktop.stopVoice()));

function receive(value) {
  if (!value || typeof value !== 'object') return;
  snapshot = value; revision++;
  const settings = value.settings || {};
  enabled.checked = settings.enabled !== false; dnd.checked = settings.dnd === true;
  if (document.activeElement !== volume) {
    volume.value = String(Math.round((Number.isFinite(settings.volume) ? settings.volume : .8) * 100));
    volumeValue.value = volume.value + '%';
  }
  const birthday = typeof settings.birthday === 'string' ? settings.birthday : '';
  const parts = birthday.split('-');
  if (![birthdayMonth, birthdayDay].includes(document.activeElement)) {
    birthdayMonth.value = parts[0] ? String(Number(parts[0])) : '';
    birthdayDay.value = parts[1] ? String(Number(parts[1])) : '';
  }
  birthdayHint.textContent = birthday ? '已保存：' + Number(parts[0]) + ' 月 ' + Number(parts[1]) + ' 日。' + (birthday === '02-29' ? '仅在闰年的 2 月 29 日祝福。' : '每年生日当天自动祝福一次。') : '未设置生日。只在此电脑保存月、日。';
  interactionError.hidden = value.interactionAvailable !== false;
  interactionError.textContent = value.interactionAvailable === false ? (value.interactionError || '互动语音暂不可用，点击时仍可显示文字。请完整保留互动录音后重新启动。') : '';
  const playback = value.playback || {}, environment = value.environment || {};
  const playing = ['loading', 'playing', 'starting', 'showing'].includes(playback.status);
  const queued = Boolean(value.queuedInteraction);
  const mode = playback.kind === 'interaction' ? (playback.textOnly ? '互动字幕' : '互动语音')
    : { auto: '自动问候', automatic: '自动问候', farewell: '告别' }[playback.kind] || '语音';
  status.textContent = playing ? (playback.status === 'loading' || playback.status === 'starting' ? '正在准备' : '正在播放') + ' · ' + mode
    : queued ? '稍后回应 · 已记住这次互动'
    : playback.status === 'error' ? '语音播放未完成'
    : value.available === false ? (value.interactionAvailable === true ? '日常语音暂不可用 · 点击互动仍可回应' : '语音暂不可用')
    : environment.locked ? '锁屏期间暂停语音'
    : environment.suspended ? '休眠期间暂停语音'
    : settings.dnd ? '勿扰中 · 互动保留文字回应'
    : settings.enabled === false ? '自动问候已关闭'
    : settings.volume === 0 ? '静音中 · 自动问候暂停'
    : environment.monitorReady === false ? '屏幕状态暂未就绪 · 自动问候暂缓'
    : environment.fullscreen ? '全屏期间暂停自动问候'
    : '等待下一次问候';
  subtitle.textContent = playing ? (playback.text || '')
    : queued ? '稍后回应这次互动；「停止播放」也可取消等待。'
    : value.available === false ? '请完整保留程序的日常语音文件，补齐后重新启动。'
    : environment.locked || environment.suspended ? '回到桌面后恢复。'
    : settings.enabled !== false && !settings.dnd && environment.monitorReady === false ? '屏幕状态就绪后自动恢复；长时间未恢复可重新启动桌宠。'
    : '';
  stopButton.disabled = !playing && !queued;
  if (value.error || playback.error) fail(new Error(value.error || playback.error));
}

try {
  if (!desktop?.getVoiceState) throw new Error('请从桌宠托盘的“设置”打开语音设置。');
  const unsubscribe = desktop.onVoiceState(receive);
  const before = revision;
  const initial = await desktop.getVoiceState();
  if (before === revision) receive(initial);
  if (!snapshot) throw new Error('暂时无法读取语音设置。');
  document.documentElement.dataset.voiceReady = 'true';
  window.addEventListener('pagehide', () => unsubscribe?.(), { once: true });
} catch (error) {
  enabled.disabled = true; dnd.disabled = true; volume.disabled = true;
  status.textContent = '语音暂不可用'; fail(error);
}
