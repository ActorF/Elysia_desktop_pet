// Pure host policy: validated preferences, screen placement and face / skin / pose shortcuts.
'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const DEFAULT_SETTINGS = Object.freeze({
  alwaysOnTop: true, taskbarInFront: false, clickThrough: false, scale: 1, legacyHotkeys: true, alternateHotkeys: false,
  eyeTracking: true, eyeWarpStrength: 1, hairMotion: true, motionAmplitude: 1, motionSpeed: 1, keyDisplay: true, cat: false, glasses: false,
  interactionsEnabled: true, cursorTrailEnabled: true, cursorTrailStyle: 'pink', cursorTrailDuration: 0.6,
});
const EXPRESSION_KEYS = Object.freeze({
  '1': 'blush', '2': 'angry', '3': 'sleep', '4': 'surprise', '5': 'dizzy',
  '6': 'wink', '7': 'cry', '8': 'heart', '9': 'smile', '0': 'awkward',
});
const SKIN_KEYS = Object.freeze({ F1: 'cat', F2: 'glasses' });
const POSE_KEYS = Object.freeze({ F3: 'idle', F4: 'megaphone', F5: 'cake', F6: 'tea' });

function sanitizeAppearance(input = {}) {
  return {
    expression: Object.values(EXPRESSION_KEYS).includes(input?.expression) ? input.expression : null,
    pose: Object.values(POSE_KEYS).includes(input?.pose) ? input.pose : 'idle',
    cat: input?.cat === true, glasses: input?.glasses === true,
  };
}

function sanitizeSettings(input = {}, previous = DEFAULT_SETTINGS) {
  const next = { ...DEFAULT_SETTINGS, ...previous };
  for (const key of ['alwaysOnTop', 'taskbarInFront', 'clickThrough', 'legacyHotkeys', 'alternateHotkeys', 'eyeTracking', 'hairMotion', 'keyDisplay', 'cat', 'glasses', 'interactionsEnabled', 'cursorTrailEnabled']) {
    if (typeof input[key] === 'boolean') next[key] = input[key];
  }
  const trailStyles = ['pink', 'ribbon', 'stardust'];
  if (trailStyles.includes(input.cursorTrailStyle)) next.cursorTrailStyle = input.cursorTrailStyle;
  else if (!trailStyles.includes(next.cursorTrailStyle)) next.cursorTrailStyle = DEFAULT_SETTINGS.cursorTrailStyle;
  // Keep sub-percent wheel increments. The only upper boundary is finite
  // arithmetic for virtual geometry; it is not a user-facing zoom limit.
  if (Number.isFinite(input.scale)) next.scale = Math.min(Number.MAX_VALUE / 2 ** 20, Math.max(0.01, input.scale));
  for (const [key, minimum, maximum] of [['eyeWarpStrength', 0, 2], ['motionAmplitude', 0, 2], ['motionSpeed', 0.25, 3], ['cursorTrailDuration', 0.1, 5]]) {
    // Missing fields in older settings preserve the original effects. Invalid patches
    // keep the previous valid choice without coercing strings or other values.
    const value = Number.isFinite(input[key]) ? input[key]
      : Number.isFinite(next[key]) ? next[key] : DEFAULT_SETTINGS[key];
    next[key] = Math.min(maximum, Math.max(minimum, value));
  }
  return next;
}

function dimensions(scale) {
  return { width: Math.round(420 * scale), height: Math.round(560 * scale) };
}

/** Native integer coordinates, deliberately independent of all monitor edges. */
function freeBounds(bounds) {
  const coordinate = value => Math.round(Math.max(-2147483648, Math.min(2147483647, Number.isFinite(value) ? value : 0)));
  return { ...bounds, x: coordinate(bounds.x), y: coordinate(bounds.y) };
}

/** Explicit recovery only. Oversize windows keep their size and expose their top-left controls. */
function fitBounds(bounds, workArea) {
  return {
    ...bounds,
    x: Math.round(Math.min(Math.max(bounds.x, workArea.x), workArea.x + Math.max(0, workArea.width - bounds.width))),
    y: Math.round(Math.min(Math.max(bounds.y, workArea.y), workArea.y + Math.max(0, workArea.height - bounds.height))),
  };
}

const validArea = area => area && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(area[key])) && area.width > 0 && area.height > 0;
const physicalArea = display => {
  const area = display?.bounds ?? display?.workArea ?? display;
  return validArea(area) ? area : null;
};
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const rectangleDistance = (a, b) => Math.max(0, b.x - a.x - a.width, a.x - b.x - b.width) ** 2
  + Math.max(0, b.y - a.y - a.height, a.y - b.y - b.height) ** 2;
const centerDistance = (a, b) => (a.x + a.width / 2 - b.x - b.width / 2) ** 2
  + (a.y + a.height / 2 - b.y - b.height / 2) ** 2;

/** Bring the pet back to the nearest available work area, even if still partially visible. */
function recoverBounds(bounds, displays = [], coordinateBounds = freeBounds) {
  const desired = coordinateBounds(bounds);
  const available = displays.map(display => ({ display, area: physicalArea(display) })).filter(item => item.area);
  available.sort((a, b) => overlapArea(desired, b.area) - overlapArea(desired, a.area)
    || rectangleDistance(desired, a.area) - rectangleDistance(desired, b.area)
    || centerDistance(desired, a.area) - centerDistance(desired, b.area));
  if (!available.length) return desired;
  const { display, area } = available[0];
  return fitBounds(desired, validArea(display.workArea) ? display.workArea : area);
}

/**
 * Restart/display-change policy, never the drag policy. Preserve every visible
 * portion, including taskbar overlap and narrow edge slivers. Only a completely
 * unreachable saved position (for example on a removed monitor) is recovered.
 */
function restoreBounds(bounds, displays = [], coordinateBounds = freeBounds) {
  const desired = coordinateBounds(bounds);
  return displays.some(display => { const area = physicalArea(display); return area && overlapArea(desired, area) > 0; })
    ? desired : recoverBounds(desired, displays, coordinateBounds);
}

function pointerPayload(point, bounds) {
  const localX = point.x - bounds.x;
  const localY = point.y - bounds.y;
  return {
    x: point.x, y: point.y, localX, localY, width: bounds.width, height: bounds.height,
    inside: localX >= 0 && localY >= 0 && localX < bounds.width && localY < bounds.height,
  };
}

function actionForKey(key) {
  if (Object.hasOwn(EXPRESSION_KEYS, key)) return { type: 'expression', id: EXPRESSION_KEYS[key] };
  if (Object.hasOwn(SKIN_KEYS, key)) return { type: 'toggle-skin', id: SKIN_KEYS[key] };
  if (Object.hasOwn(POSE_KEYS, key)) return { type: 'pose', id: POSE_KEYS[key] };
  if (key === 'Backspace') return { type: 'reset' };
  return null;
}

function isLocalResource(url, root) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || parsed.host) return false;
    const relative = path.relative(path.resolve(root), path.resolve(fileURLToPath(parsed)));
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  } catch { return false; }
}

module.exports = { DEFAULT_SETTINGS, EXPRESSION_KEYS, SKIN_KEYS, POSE_KEYS, sanitizeAppearance, sanitizeSettings, dimensions, freeBounds, fitBounds, restoreBounds, recoverBounds, pointerPayload, actionForKey, isLocalResource };
