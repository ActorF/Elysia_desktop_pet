// Attention and computer inactivity are separate clocks. Only the main process
// supplies global idle duration; keyboard contents and permissions are unrelated.
import { createExpressionReaction } from './interactions.mjs';

const CHOICES = Object.freeze({ neglected: ['angry', 'cry'], idle: ['sleep', 'dizzy'] });
const RESELECT_MS = 30000;
const minutes = (value, fallback) => Number.isFinite(value) ? Math.max(1, Math.min(120, value)) : fallback;

export function createIdleMood(state, { onChange = () => {}, now = Date.now, random = Math.random } = {}) {
  const reaction = createExpressionReaction(state, { onChange, now });
  let lastInteraction = now(), sample = null, mode = null, nextChoice = 0;
  function clear() { mode = null; reaction.cancel({ restore: true }); }
  function interact() {
    lastInteraction = now(); sample = null;
    clear(); // An old OS sample must not put a freshly clicked pet back to sleep.
  }
  function observe(value) {
    if (!value || !Number.isFinite(value.now) || (sample && value.now < sample.now)) return;
    sample = { ...value };
  }
  function tick(settings = {}, blocked = false) {
    const time = now(), active = reaction.snapshot();
    // Preserve explicit appearance changes even if a future caller forgets to notify us.
    if (active && state.expression !== active.expression) { interact(); return; }
    if (settings.idleMoods === false) { clear(); lastInteraction = time; return; }
    if (blocked) return;
    const age = sample ? time - sample.now : Infinity;
    const fresh = age >= 0 && age <= 3000;
    if (fresh && (sample.locked || sample.suspended || sample.fullscreen || sample.monitorReady === false)) { clear(); return; }
    const idle = fresh && Number.isFinite(sample.idleSeconds) && sample.idleSeconds >= 0 ? sample.idleSeconds : null;
    const wanted = idle !== null && idle >= minutes(settings.deviceIdleMinutes, 5) * 60 ? 'idle'
      : time - lastInteraction >= minutes(settings.neglectMinutes, 2) * 60000 ? 'neglected' : null;
    if (!wanted) { clear(); return; }
    if (mode !== wanted || time >= nextChoice) {
      mode = wanted; nextChoice = time + RESELECT_MS;
      const choices = CHOICES[mode], draw = Number(random());
      const index = Math.min(choices.length - 1, Math.floor(Math.max(0, Number.isFinite(draw) ? draw : 0) * choices.length));
      // Reuse upstream restoration/cancellation. This mode owns the lifetime,
      // while repeated selections keep the original manual expression underneath.
      reaction.react(choices[index], RESELECT_MS);
    }
  }
  return { interact, observe, tick, snapshot: () => mode ? { mode, expression: state.expression } : null };
}
