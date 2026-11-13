import test from 'node:test';
import assert from 'node:assert/strict';
import { createPointerTracking } from '../renderer/pointer-tracking.mjs';
import { createPetState } from '../renderer/state.mjs';
import { createDesktopPointer } from '../electron/desktop-pointer.cjs';

const anchor = { gazeX: 300, gazeY: 250 };
const geometry = { width: 740, height: 800 };
const local = (x, time) => ({ ...geometry, localX: x, localY: 250, sampledAt: time });
const native = (x, sequence, time) => ({ ...local(x, time), sequence, clock: 'desktop-monotonic' });

test('production native gaze remains current through wall-clock rollback and forward correction', t => {
  let wall = 1_000_000, cursor = { x: 440, y: 250 };
  t.mock.method(Date, 'now', () => wall);
  const state = createPetState(), tracking = createPointerTracking(state, anchor), packets = [], accepted = [];
  const pointer = createDesktopPointer({ readCursor: () => cursor, getBounds: () => ({ x: 0, y: 0, ...geometry }),
    setPosition() {}, sendPointer(packet) { packets.push(packet); accepted.push(tracking.sample({ ...packet, ...geometry })); } });
  pointer.sample(); pointer.acknowledge(packets.at(-1).sequence);
  wall -= 60_000; cursor = { x: 210, y: 250 };
  pointer.sample(); pointer.acknowledge(packets.at(-1).sequence);
  assert.equal(state.target.x, -1, 'Fresh native coordinates survive a backward wall-clock adjustment');
  wall += 3_600_000; cursor = { x: 670, y: 250 };
  pointer.sample(); pointer.acknowledge(packets.at(-1).sequence);
  wall -= 3_600_000; cursor = { x: 440, y: 250 };
  pointer.sample();
  assert.deepEqual(accepted, [true, true, true, true]);
  assert.equal(state.target.x, 0);
  assert.ok(packets.every(packet => packet.clock === 'desktop-monotonic'));
  assert.ok(packets.every((packet, index) => !index || packet.sampledAt >= packets[index - 1].sampledAt));
});

test('native ordering rejects old or duplicate sequences and reversed monotonic timestamps', () => {
  const state = createPetState(), tracking = createPointerTracking(state, anchor);
  assert.equal(tracking.sample(native(670, 20, 100)), true);
  for (const packet of [native(210, 19, 101), native(210, 20, 100), native(210, 21, 99), native(210, 0, 102), native(210, NaN, 102)]) {
    assert.equal(tracking.sample(packet), false);
    assert.equal(state.target.x, 1);
  }
  assert.equal(tracking.sample(native(440, 21, 100)), true, 'Equal clock ticks remain ordered by sequence');
  assert.equal(state.target.x, 0);
});

test('local preview stays ordered, and a delayed first native packet cannot overwrite newer local input', () => {
  const state = createPetState(), tracking = createPointerTracking(state, anchor);
  assert.equal(tracking.sample(local(440, 1_000_000)), true);
  assert.equal(tracking.sample(local(670, 1_000_010)), true);
  assert.equal(tracking.sample(local(210, 1_000_005)), false);
  assert.equal(tracking.sample(native(210, 7, 30)), false, 'The first native packet may have waited behind the newer local event');
  assert.equal(state.target.x, 1);
  assert.equal(tracking.sample(native(440, 8, 40)), true);
  assert.equal(state.target.x, 0);
  assert.equal(tracking.sample(local(210, 9_000_000)), false, 'Local and native process time origins must never be compared');
  assert.equal(state.target.x, 0);
});

test('renderer reloads and host reset preserve ordering without sharing a document time origin', () => {
  let clock = 10, cursor = { x: 670, y: 250 }, current, packets = [];
  const pointer = createDesktopPointer({ readCursor: () => cursor, getBounds: () => ({ x: 0, y: 0, ...geometry }),
    setPosition() {}, now: () => clock, sendPointer(packet) { packets.push(packet); current.sample({ ...packet, ...geometry }); } });
  const firstState = createPetState(); current = createPointerTracking(firstState, anchor, () => 1_000_000);
  pointer.sample(); const old = packets.at(-1);
  const nextState = createPetState(); current = createPointerTracking(nextState, anchor, () => 5_000_000);
  current.sample(local(210, 5_000_000));
  pointer.reset(); clock = 20; cursor = { x: 440, y: 250 }; pointer.sample();
  assert.ok(packets.at(-1).sequence > old.sequence, 'Reset must not re-use the old acknowledgement sequence');
  assert.equal(nextState.target.x, -1, 'Only the potentially delayed first native sample is ignored');
  pointer.acknowledge(old.sequence); clock = 30; cursor = { x: 670, y: 250 }; pointer.sample();
  assert.equal(packets.length, 2, 'A stale ACK cannot release the replacement document packet');
  pointer.acknowledge(packets.at(-1).sequence); pointer.sample();
  assert.equal(nextState.target.x, 1);
  assert.equal(current.sample({ ...old, ...geometry }), false);
});

test('invalid native geometry cannot claim the source or poison either ordering guard', () => {
  const state = createPetState(), tracking = createPointerTracking(state, anchor);
  assert.equal(tracking.sample({ ...native(210, 50, 500), width: 0 }), false);
  assert.equal(tracking.sample(local(670, 200)), true);
  assert.equal(tracking.sample(native(210, 1, 10)), false);
  assert.equal(tracking.sample(native(440, 2, 11)), true);
  assert.equal(state.target.x, 0);
});

test('startup and reload synchronize a stationary native cursor after discarding the first in-flight sample', () => {
  let current, clock = 1;
  const packets = [];
  const pointer = createDesktopPointer({ readCursor: () => ({ x: 440, y: 250 }), getBounds: () => ({ x: 0, y: 0, ...geometry }),
    setPosition() {}, now: () => clock++, sendPointer(packet) { packets.push(packet); current.sample({ ...packet, ...geometry }); } });
  for (const origin of [1_000_000, 5_000_000]) {
    const state = createPetState(); current = createPointerTracking(state, anchor);
    current.sample(local(670, origin)); pointer.reset();
    pointer.sample(); assert.equal(state.target.x, 1);
    const first = packets.at(-1);
    pointer.acknowledge(first.sequence - 1); pointer.sample();
    assert.equal(packets.at(-1), first, 'A stale ACK cannot trigger a synchronization sample');
    pointer.acknowledge(first.sequence); pointer.sample();
    assert.equal(state.target.x, 0, 'The fresh stationary point replaces the preview fallback');
    pointer.acknowledge(packets.at(-1).sequence);
    const count = packets.length; pointer.sample();
    assert.equal(packets.length, count, 'No stationary polling flood after the one synchronization sample');
  }
});
