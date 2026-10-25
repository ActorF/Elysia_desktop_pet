import { createTrailState, drawTrail } from './cursor-trail-paint.mjs';

const bridge = window.elysiaCursorTrail;
const canvas = document.querySelector('#trail'), context = canvas.getContext('2d');
const trail = createTrailState();
let frameId = null, previousBounds = null, ratio = 1;
function resize() {
  ratio = Math.min(devicePixelRatio || 1, 2, 8192 / Math.max(1, innerWidth), 8192 / Math.max(1, innerHeight), Math.sqrt(12000000 / Math.max(1, innerWidth * innerHeight)));
  canvas.width = Math.max(1, Math.ceil(innerWidth * ratio)); canvas.height = Math.max(1, Math.ceil(innerHeight * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0); previousBounds = null;
}
function erase() {
  if (previousBounds) context.clearRect(previousBounds.x, previousBounds.y, previousBounds.width, previousBounds.height);
  previousBounds = null;
}
function clearSurface() {
  if (frameId !== null) cancelAnimationFrame(frameId);
  frameId = null; erase();
}
function frame(now) {
  frameId = null; erase();
  const snapshot = trail.frame(now);
  if (snapshot.points.length || snapshot.sparks.length) {
    previousBounds = drawTrail(context, snapshot, now);
    frameId = requestAnimationFrame(frame);
  }
}
function receive(packet) {
  const revision = trail.revision;
  const accepted = trail.receive(packet, performance.now(), { width: innerWidth, height: innerHeight });
  if (trail.revision !== revision) clearSurface();
  if (accepted && frameId === null) frameId = requestAnimationFrame(frame);
}
resize();
bridge?.onSample(receive);
bridge?.onClear(value => { if (trail.clear(value)) clearSurface(); });
bridge?.onStyle?.(value => { if (trail.changeStyle(value)) clearSurface(); });
bridge?.onDuration?.(value => { if (trail.changeDuration(value)) clearSurface(); });
window.addEventListener('resize', () => { trail.clear(); clearSurface(); resize(); });
window.addEventListener('pagehide', () => { trail.clear(); clearSurface(); });
document.documentElement.dataset.ready = 'true';
