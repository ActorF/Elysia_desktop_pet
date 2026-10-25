import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrailState, smoothTrail, ribbonGeometry, ribbonColor, paintSections, drawTrail, TRAIL_LIMITS } from '../renderer/cursor-trail-paint.mjs';

const bounds = { width: 16000, height: 10000 };
const point = (x, y, sequence, age = 0, disconnected = false) => ({ x, y, sequence, age, break: disconnected });

test('a 400-DIP same-screen flick in 16ms remains a continuous stroke with a visible midpoint', () => {
  for (const style of ['pink', 'ribbon', 'stardust']) {
    const state = createTrailState({ random: () => .5 });
    assert.equal(state.receive({ style, generation: 1, points: [point(100, 100, 1, 16, true), point(500, 100, 2)] }, 1000, bounds), true);
    const snapshot = state.frame(1000), chains = smoothTrail(snapshot.points);
    assert.equal(chains.length, 1); assert.equal(snapshot.points[1].break, false);
    assert.ok(chains[0].some(value => value.x > 285 && value.x < 315), `${style} must bridge the middle of a fast stroke`);
    assert.ok(snapshot.sparks.length > 0, `${style} sprinkles are distributed along the travelled distance`);
    if (style === 'stardust') assert.ok(snapshot.sparks.length >= 16);
  }
});

test('loaded batches retain historical continuity and explicit breaks; legacy packets retain time-gap detection', () => {
  const state = createTrailState({ random: () => .5 });
  state.receive({ generation: 1, points: [point(100, 100, 1, 500, true), point(500, 130, 2, 484), point(900, 150, 3, 468)] }, 1000, bounds);
  assert.equal(smoothTrail(state.frame(1000).points).length, 1, 'Loading age is not a gap between adjacent samples');
  state.receive({ generation: 1, points: [point(1000, 100, 4, 0, true), point(1400, 100, 5)] }, 1000, bounds);
  assert.equal(smoothTrail(state.frame(1000).points).length, 2);
  state.receive({ generation: 1, ...point(1500, 100, 6) }, 1200, bounds);
  assert.equal(smoothTrail(state.frame(1200).points).length, 2, 'Expired historical first stroke is removed and the 200ms gap opens a new one');
});

test('uneven IPC delays cannot break a valid high-speed stroke when reconstructed sample times go backwards', () => {
  const state = createTrailState({ random: () => .5 });
  state.receive({ generation: 1, ...point(100, 100, 1, 0, true) }, 1000, bounds);
  state.receive({ generation: 1, points: [point(500, 100, 2, 12), point(900, 100, 3, 0)] }, 1001, bounds);
  const snapshot = state.frame(1001);
  assert.equal(smoothTrail(snapshot.points).length, 1);
  assert.equal(snapshot.points[1].break, false); assert.equal(snapshot.points[2].break, false);
  assert.ok(snapshot.points[1].at >= snapshot.points[0].at);
  assert.equal(snapshot.points.at(-1).x, 900);
});

test('a batch delivered 250ms late stays connected when the host reports continuous 16ms samples', () => {
  const state = createTrailState({ random: () => .5 });
  state.receive({ generation: 1, points: [point(100, 100, 1, 0, true)] }, 1000, bounds);
  // The second point was sampled 16ms later, but its IPC arrives 250ms late.
  state.receive({ generation: 1, points: [point(500, 100, 2)] }, 1266, bounds);
  const snapshot = state.frame(1266), chains = smoothTrail(snapshot.points);
  assert.equal(chains.length, 1);
  assert.equal(snapshot.points[1].break, false);
  assert.ok(chains[0].some(value => value.x > 285 && value.x < 315));
  state.receive({ generation: 1, points: [point(900, 100, 3, 0, true)] }, 1282, bounds);
  assert.equal(smoothTrail(state.frame(1282).points).length, 2, 'An explicit host boundary still opens a new stroke');
});

test('single-point legacy packets remain compatible and stale generations/sequences cannot revive cleared trails', () => {
  const state = createTrailState();
  state.receive({ generation: 1, ...point(10, 10, 1, 0, true) }, 1000, bounds);
  state.receive({ generation: 1, ...point(20, 10, 2) }, 1016, bounds);
  assert.equal(state.frame(1016).points.length, 2);
  assert.equal(state.changeStyle({ style: 'ribbon', generation: 2 }), true);
  assert.equal(state.frame(1016).points.length, 0);
  assert.equal(state.receive({ generation: 1, style: 'pink', ...point(30, 10, 99) }, 1020, bounds), false);
  assert.equal(state.frame(1020).style, 'ribbon');
  assert.equal(state.receive({ generation: 2, style: 'ribbon', ...point(30, 10, 1) }, 1020, bounds), true, 'A new generation may restart sequence numbering');
  state.clear({ generation: 2 });
  assert.equal(state.receive({ generation: 2, ...point(40, 10, 1) }, 1021, bounds), false);
  assert.equal(state.changeStyle({ generation: 2, style: 'unknown' }), false);
  assert.equal(state.frame(1021).points.length, 0);
});

test('even repeated full-screen flicks stay within global source, interpolation and particle budgets', () => {
  const state = createTrailState({ random: () => .5 });
  for (let index = 0; index < 300; index++) {
    state.receive({ generation: 1, style: 'stardust', ...point(index % 2 ? 15900 : 100, 200 + index, index + 1, 0, index === 0) }, index, bounds);
  }
  const snapshot = state.frame(300), chains = smoothTrail(snapshot.points);
  assert.ok(snapshot.points.length <= TRAIL_LIMITS.points);
  assert.ok(snapshot.sparks.length <= TRAIL_LIMITS.sparks);
  assert.ok(chains.flat().length <= TRAIL_LIMITS.smoothPoints);
  assert.equal(chains[0].at(-1).x, snapshot.points.at(-1).x, 'Budgeting preserves the newest cursor endpoint');
  assert.ok(snapshot.sparks.some(value => value.x > 6000 && value.x < 10000), 'Particle cap still distributes stars across the long segment');
});

test('0.1, 0.6, 1.5 and 5 seconds retain their complete fast-circle history with bounded recent detail', () => {
  for (const duration of [.1, .6, 1.5, 5]) for (const style of ['pink', 'ribbon', 'stardust']) {
    const state = createTrailState({ random: () => .5 });
    const lifetime = duration * 1000, elapsed = Math.ceil(lifetime * 3 / 8) * 8;
    let snapshot;
    for (let now = 0; now <= elapsed; now += 8) {
      const angle = now / 500 * Math.PI * 2;
      state.receive({ generation: 1, style, duration, points: [point(900 + 500 * Math.cos(angle), 600 + 400 * Math.sin(angle), now / 8 + 1, 0, now === 0)] }, now, bounds);
      snapshot = state.frame(now);
      assert.ok(snapshot.points.length <= TRAIL_LIMITS.points);
      assert.ok(snapshot.sparks.length <= TRAIL_LIMITS.sparks);
    }
    assert.equal(snapshot.duration, duration);
    const span = elapsed - snapshot.points[0].at;
    assert.ok(span >= lifetime - lifetime / TRAIL_LIMITS.recentPoints - 16, `${style} ${duration}s must retain full duration, got ${span}ms`);
    assert.equal(snapshot.points.at(-1).at, elapsed);
    const recent = snapshot.points.slice(-Math.min(TRAIL_LIMITS.recentPoints, snapshot.points.length));
    for (let index = 1; index < recent.length; index++) assert.equal(recent[index].at - recent[index - 1].at, 8, 'Recent turns retain every sample');
    const chains = smoothTrail(snapshot.points);
    assert.equal(chains.length, 1); assert.ok(chains.flat().length <= TRAIL_LIMITS.smoothPoints);
    assert.ok(paintSections(chains).length <= TRAIL_LIMITS.paintSections);
    if (duration > .6) assert.ok(elapsed - snapshot.sparks[0].at > lifetime * .4, `${style} must retain older particles as well as new particles`);
    assert.ok(state.frame(elapsed + lifetime - 1).points.length > 0);
    const ended = state.frame(elapsed + lifetime); assert.equal(ended.points.length, 0); assert.equal(ended.sparks.length, 0);
  }
});

test('duration updates immediately clear old history and reject late generations while preserving style', () => {
  const state = createTrailState();
  state.receive({ generation: 1, style: 'ribbon', duration: 5, points: [point(100, 100, 1, 4500, true), point(500, 100, 2)] }, 5000, bounds);
  assert.equal(state.frame(5000).points.length, 2);
  assert.equal(state.changeDuration({ generation: 2, duration: .1 }), true);
  assert.deepEqual(state.frame(5000).points, []); assert.equal(state.frame(5000).style, 'ribbon');
  assert.equal(state.receive({ generation: 1, duration: 5, points: [point(900, 100, 3)] }, 5010, bounds), false);
  assert.equal(state.changeDuration({ generation: 1, duration: 5 }), false);
  assert.equal(state.changeDuration({ generation: 2, duration: NaN }), false);
  state.changeStyle({ generation: 3, style: 'stardust', duration: 1.5 });
  assert.equal(state.frame(5010).duration, 1.5);
  state.changeDuration({ generation: 4, duration: 50 }); assert.equal(state.frame(5010).duration, 5);
  state.changeDuration({ generation: 5, duration: -5 }); assert.equal(state.frame(5010).duration, .1);
});

test('archiving preserves explicit breaks and the global paint cap even with many separate strokes', () => {
  const state = createTrailState();
  for (let index = 0; index < 1000; index++) state.receive({ generation: 1, duration: 5, points: [point(100 + index % 2 * 500, 100, index + 1, 0, index % 4 === 0)] }, index * 4, bounds);
  const snapshot = state.frame(4000), chains = smoothTrail(snapshot.points);
  assert.ok(snapshot.points.length <= TRAIL_LIMITS.points); assert.ok(chains.length > 1);
  assert.ok(chains.flat().length <= TRAIL_LIMITS.smoothPoints); assert.ok(paintSections(chains).length <= TRAIL_LIMITS.paintSections);
  const separate = Array.from({ length: 96 }, (_, index) => [{ x: 0, y: index, at: index, break: true }, { x: 100, y: index, at: index + 1 }]);
  assert.equal(paintSections(separate).length, TRAIL_LIMITS.paintSections);
});

test('ribbon thickness tapers by path progress even when every sample is only 16ms apart', () => {
  const source = [{ x: 100, y: 100, at: 984, break: true }, { x: 1100, y: 100, at: 1000, break: false }];
  const chain = smoothTrail(source)[0], fresh = ribbonGeometry(chain, 1000), fading = ribbonGeometry(chain, 1300);
  assert.ok(fresh.widths.at(-1) > fresh.widths[0] * 10);
  assert.ok(fresh.widths.at(-1) > 7, 'Fresh cursor end is a substantial continuous ribbon');
  assert.ok(fresh.widths[0] < 1, 'The oldest end is thin even on a very short fast stroke');
  assert.ok(fading.widths.at(-1) < fresh.widths.at(-1));
  assert.equal(fresh.left.length, fresh.right.length);
});

test('all styles fully expire at 600ms, and expired queued packets produce no new effects', () => {
  for (const style of ['pink', 'ribbon', 'stardust']) {
    const state = createTrailState({ random: () => .5 });
    state.receive({ generation: 1, style, points: [point(100, 100, 1, 16, true), point(1200, 200, 2)] }, 1000, bounds);
    assert.ok(state.frame(1000).points.length > 0);
    const ended = state.frame(1600); assert.equal(ended.points.length, 0); assert.equal(ended.sparks.length, 0);
    assert.equal(state.receive({ generation: 1, style, ...point(1300, 200, 3, 601) }, 1600, bounds), false);
    assert.equal(state.frame(1600).points.length, 0);
  }
});

test('folded ribbon color follows cumulative travel rather than screen-space projection', () => {
  const chain = smoothTrail([{ x: 100, y: 200, at: 968, break: true }, { x: 1100, y: 200, at: 984 }, { x: 100, y: 200, at: 1000 }])[0];
  const sections = paintSections([chain]);
  assert.equal(sections[0].start, 0); assert.equal(sections.at(-1).end, 1);
  assert.ok(sections.length <= 32);
  assert.equal(ribbonColor(0), 'rgba(255,57,150,1)');
  assert.equal(ribbonColor(1), 'rgba(113,35,232,1)');
  for (let index = 1; index < sections.length; index++) {
    assert.equal(sections[index].start, sections[index - 1].end);
    assert.deepEqual(sections[index].points[0], sections[index - 1].points.at(-1));
  }
  assert.ok(sections.some(section => section.points.some(point => point.x >= 1100)), 'The centerline includes the exact reversal');
  assert.notEqual(ribbonColor(sections[0].start), ribbonColor(sections.at(-1).end), 'Head and tail may share screen coordinates but retain their distinct path colors');
});

test('many disjoint or fast zigzag strokes stay within a global paint budget and never use raster blur', () => {
  const points = Array.from({ length: TRAIL_LIMITS.points }, (_, index) => ({ x: index % 2 ? 15900 : 100, y: 200 + Math.sin(index) * 100, at: 900 + index, break: index % 12 === 0 }));
  const chains = smoothTrail(points), sections = paintSections(chains);
  assert.ok(sections.length <= TRAIL_LIMITS.paintSections);
  for (const style of ['pink', 'ribbon', 'stardust']) {
    const calls = [], context = { shadowBlur: 0, createLinearGradient() { return { addColorStop() {} }; } };
    for (const name of ['beginPath', 'moveTo', 'lineTo', 'closePath', 'arc', 'setLineDash']) context[name] = () => {};
    for (const name of ['fill', 'stroke']) context[name] = () => { assert.equal(context.shadowBlur, 0); calls.push(name); };
    const result = drawTrail(context, { style, points, sparks: [] }, 1000);
    assert.ok(calls.filter(name => name === 'stroke').length <= TRAIL_LIMITS.paintSections * 3 + chains.length);
    assert.equal(calls.filter(name => name === 'fill').length, 2, 'Only the head uses fills; folded centerlines are round strokes that cannot cut transparent holes');
    assert.equal(context.lineCap, 'round'); assert.equal(context.lineJoin, 'round');
    assert.ok(result.x <= 100 && result.x + result.width >= 15900);
  }
});
