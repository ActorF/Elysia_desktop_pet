import { EXPRESSIONS, SKINS, POSES } from './state.mjs';

const desktop = window.elysiaSettings;
for (const button of document.querySelectorAll('[data-window-control]')) {
  button.addEventListener('click', () => desktop?.windowControl(button.dataset.windowControl));
}
function renderWindowState(state) {
  const button = document.querySelector('[data-window-control=toggle-maximize]');
  const maximized = state?.maximized === true;
  button.dataset.maximized = String(maximized);
  button.setAttribute('aria-label', maximized ? '还原' : '最大化');
  button.title = maximized ? '还原' : '最大化';
}
let snapshot = null, revision = 0, pending = 0, requests = Promise.resolve();
let patchFrame = 0, pendingPatch = {};
const status = document.querySelector('#save-status');
const errorMessage = document.querySelector('#error-message');
const controls = new Map(), rangeControls = new Map();
const trailStyles = ['pink', 'ribbon', 'stardust'];
const format = n => Number(n.toPrecision(7)).toString();
function element(tag, attributes = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function fail(error) {
  errorMessage.textContent = error?.message || '暂时无法保存，请重试。';
  errorMessage.hidden = false; status.textContent = '未能应用'; status.classList.add('error');
}
function command(operation) {
  pending++; status.textContent = '正在应用…'; status.classList.remove('error'); errorMessage.hidden = true;
  requests = requests.then(async () => {
    const before = revision, result = await operation();
    // Broadcasts are authoritative: an older invoke reply cannot undo them.
    if (before === revision && result?.settings) receive(result);
  }).catch(fail).finally(() => {
    pending--; if (!pending && errorMessage.hidden) status.textContent = '自动保存';
  });
  return requests;
}
function patch(key, value) { return command(() => desktop.setSettings({ [key]: value })); }
function schedulePatch(key, value) {
  pendingPatch[key] = value;
  if (patchFrame) return;
  patchFrame = requestAnimationFrame(() => {
    patchFrame = 0; const value = pendingPatch; pendingPatch = {};
    void command(() => desktop.setSettings(value));
  });
}
function appearanceAction(value) { return command(() => desktop.action(value)); }
function makeChoice(item, type) {
  const button = element('button', { class: 'choice', 'aria-pressed': 'false', 'data-action': type, 'data-id': item.id });
  button.append(element('span', { class: 'choice-label' }, item.label),
    element('span', { class: 'shortcut', 'aria-hidden': 'true' }, item.key));
  button.addEventListener('click', () => void appearanceAction({ type, id: item.id }));
  return button;
}
for (const item of EXPRESSIONS) document.querySelector('#expressions').append(makeChoice(item, 'expression'));
for (const item of POSES) document.querySelector('#poses').append(makeChoice(item, 'pose'));
function makeToggle(target, key, title, description, actionType = null) {
  const row = element('label', { class: 'toggle-row' });
  const copy = element('span', { class: 'toggle-copy' });
  copy.append(element('span', { class: 'toggle-title' }, title));
  if (description) copy.append(element('span', { class: 'toggle-description' }, description));
  const holder = element('span', { class: 'switch' });
  const input = element('input', { type: 'checkbox', name: key, 'data-setting': key, 'aria-label': title });
  holder.append(input, element('i', { 'aria-hidden': 'true' })); row.append(copy, holder); target.append(row);
  input.addEventListener('change', () => {
    if (actionType) void appearanceAction({ type: actionType, id: key });
    else void patch(key, input.checked);
  });
  controls.set(key, input);
}
for (const skin of SKINS) makeToggle(document.querySelector('#skins'), skin.id, skin.label, `空格 + ${skin.key}`, 'toggle-skin');
const toggles = [
  ['#eye-toggle', 'eyeTracking', '目光跟随鼠标', '保持原来的眼神效果，可以单独调整幅度。'],
  ['#motion-toggle', 'hairMotion', '头发、衣摆与腿部摆动', '上半身与下半身保持同向轻摆。'],
  ['#key-toggle', 'keyDisplay', '按键云朵', '只显示最近输入的一个字符，约一秒后消失。'],
  ['#interactions-toggle', 'interactionsEnabled', '点击互动', '关闭后，摸头和戳戳不再触发表情、字幕和声音；拖动与缩放仍可使用。'],
  ['#cursor-trail-toggle', 'cursorTrailEnabled', '鼠标流光', '鼠标移动时出现流光，停下后逐渐淡出。流光不影响鼠标点击或拖动。'],
  ['#topmost-toggle', 'alwaysOnTop', '始终置顶', '让桌宠显示在其他普通窗口上方。'],
  ['#passthrough-toggle', 'clickThrough', '鼠标穿透人物', '设置窗口仍可操作；Ctrl + Alt + P 可恢复人物操作。'],
  ['#legacy-toggle', 'legacyHotkeys', '空格全局组合键', '空格 + 数字切换表情，空格 + F1–F6 切换装扮和动作。'],
  ['#alternate-toggle', 'alternateHotkeys', '备用 Ctrl + Alt 组合键', '搭配数字、F1–F6 或退格键，作为另一套操作方式。'],
];
for (const [target, ...args] of toggles) makeToggle(document.querySelector(target), ...args);
function makeRange(target, key, title, min, max, step, factor, unit, defaultValue = 1) {
  const heading = element('div', { class: 'range-heading' });
  const id = `range-${key}`;
  heading.append(element('label', { for: id }, title));
  const values = element('div', { class: 'range-values' });
  const reset = element('button', { class: 'range-reset', type: 'button', 'aria-label': `恢复默认${title}` }, '默认');
  reset.addEventListener('click', () => void patch(key, defaultValue));
  const numberHolder = element('label', { class: 'number-field' });
  const number = element('input', { type: 'number', name: `${key}Value`, min, max, step, 'aria-label': `${title}数值` });
  numberHolder.append(number, element('span', {}, unit)); values.append(reset, numberHolder); heading.append(values);
  const row = element('div', { class: 'range-row' });
  const slider = element('input', { type: 'range', id, name: key, 'data-setting': key, min, max, step });
  row.append(element('span', {}, `${min}${unit}`), slider, element('span', {}, `${max}${unit}`));
  target.append(heading, row);
  slider.addEventListener('input', () => { number.value = slider.value; schedulePatch(key, Number(slider.value) / factor); });
  number.addEventListener('change', () => {
    if (number.value === '' || !Number.isFinite(number.valueAsNumber)) {
      const current = Number.isFinite(snapshot?.settings?.[key]) ? snapshot.settings[key] : defaultValue;
      number.value = format(current * factor); slider.value = number.value; return;
    }
    const value = Math.max(min, Math.min(max, number.valueAsNumber));
    number.value = String(value); slider.value = String(value); void patch(key, value / factor);
  });
  rangeControls.set(key, { slider, number, factor, defaultValue });
}
makeRange(document.querySelector('#eye-range'), 'eyeWarpStrength', '眼睛跟随幅度', 0, 200, 1, 100, '%');
makeRange(document.querySelector('#amplitude-range'), 'motionAmplitude', '摆动幅度', 0, 200, 1, 100, '%');
makeRange(document.querySelector('#speed-range'), 'motionSpeed', '摆动速度', .25, 3, .05, 1, '×');
makeRange(document.querySelector('#cursor-trail-duration'), 'cursorTrailDuration', '轨迹保留时间', .1, 5, .1, 1, '秒', .6);
for (const input of document.querySelectorAll('#cursor-trail-duration input')) input.setAttribute('aria-describedby', 'cursor-trail-duration-hint');
document.querySelector('[name=cursorTrailDurationValue]').inputMode = 'decimal';
document.querySelector('[name=cursorTrailDurationValue]').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
});

function render() {
  if (!snapshot) return;
  const { settings, appearance = {} } = snapshot;
  for (const [key, input] of controls) input.checked = key === 'cat' || key === 'glasses' ? Boolean(appearance[key])
    : key === 'interactionsEnabled' || key === 'cursorTrailEnabled' ? settings[key] !== false : Boolean(settings[key]);
  for (const [key, { slider, number, factor, defaultValue }] of rangeControls) {
    const value = Number.isFinite(settings[key]) ? settings[key] * factor : defaultValue * factor;
    if (document.activeElement !== slider) slider.value = format(value);
    if (document.activeElement !== number && document.activeElement !== slider) number.value = format(value);
  }
  for (const button of document.querySelectorAll('.choice')) button.setAttribute('aria-pressed', String(appearance[button.dataset.action] === button.dataset.id));
  const neutral = document.querySelector('#neutral-face'); neutral.disabled = !appearance.expression;
  neutral.textContent = appearance.expression ? '恢复默认表情' : '当前：默认表情';
  const size = document.querySelector('#scale-percent');
  if (document.activeElement !== size) size.value = format(settings.scale * 100);
  for (const button of document.querySelectorAll('[data-scale]')) button.setAttribute('aria-pressed', String(Math.abs(settings.scale - Number(button.dataset.scale)) < 1e-10));
  for (const radio of document.querySelectorAll('[name=taskbarInFront]')) radio.checked = settings.taskbarInFront === (radio.value === 'true');
  const trailStyle = trailStyles.includes(settings.cursorTrailStyle) ? settings.cursorTrailStyle : 'pink';
  for (const radio of document.querySelectorAll('[name=cursorTrailStyle]')) radio.checked = radio.value === trailStyle;
  document.querySelector('#taskbar-fieldset').disabled = !settings.alwaysOnTop;
  document.querySelector('#taskbar-hint').textContent = settings.alwaysOnTop ? '决定人物与任务栏重叠时的前后顺序。' : '开启“始终置顶”后可以选择。';
}
function receive(next) { if (!next?.settings) return; snapshot = next; revision++; render(); }
document.querySelector('#neutral-face').addEventListener('click', () => {
  if (snapshot?.appearance?.expression) void appearanceAction({ type: 'expression', id: snapshot.appearance.expression });
});
document.querySelector('[data-action=reset]').addEventListener('click', () => void appearanceAction({ type: 'reset' }));
for (const radio of document.querySelectorAll('[name=taskbarInFront]')) radio.addEventListener('change', () => { if (radio.checked) void patch('taskbarInFront', radio.value === 'true'); });
for (const radio of document.querySelectorAll('[name=cursorTrailStyle]')) radio.addEventListener('change', () => {
  if (radio.checked && trailStyles.includes(radio.value)) void patch('cursorTrailStyle', radio.value);
});
for (const button of document.querySelectorAll('[data-recover]')) button.addEventListener('click', () => void command(() => desktop.recover(button.dataset.recover === 'true')));
for (const button of document.querySelectorAll('[data-scale]')) button.addEventListener('click', () => void command(() => desktop.resize(Number(button.dataset.scale))));
for (const button of document.querySelectorAll('[data-resize-factor]')) button.addEventListener('click', () => void command(() => desktop.resize(snapshot.settings.scale * Number(button.dataset.resizeFactor))));
document.querySelector('#size-form').addEventListener('submit', event => {
  event.preventDefault(); const field = document.querySelector('#scale-percent'), value = field.valueAsNumber;
  if (!Number.isFinite(value) || value < 1) { fail(new Error('请输入至少 1% 的有效大小。')); return; }
  field.blur(); void command(() => desktop.resize(value / 100));
});
function selectTab(button, focus = false) {
  for (const tab of document.querySelectorAll('[role=tab]')) {
    const selected = tab === button; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
  document.querySelector('main').scrollTop = 0;
  if (focus) button.focus();
}
const tabs = [...document.querySelectorAll('[role=tab]')];
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next], true);
  });
}
try {
  if (!desktop) throw new Error('请从桌宠托盘的“设置”打开此窗口。');
  let windowRevision = 0;
  const stopWindowState = desktop.onWindowState(state => { windowRevision++; renderWindowState(state); });
  const initialWindowRevision = windowRevision;
  const initialWindowState = await desktop.getWindowState();
  if (windowRevision === initialWindowRevision) renderWindowState(initialWindowState);
  const stop = desktop.onState(receive), initialRevision = revision;
  const initial = await desktop.getState(); if (revision === initialRevision) receive(initial);
  if (!snapshot) throw new Error('暂时无法读取桌宠设置。');
  document.documentElement.dataset.ready = 'true';
  window.addEventListener('pagehide', () => { stop?.(); stopWindowState?.(); if (patchFrame) { cancelAnimationFrame(patchFrame); void desktop.setSettings(pendingPatch); } }, { once: true });
} catch (error) { fail(error); }
