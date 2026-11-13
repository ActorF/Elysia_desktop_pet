/** @fileoverview Tests independent face / pose / skin state, shortcut parity and animation stability. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPRESSIONS, SKINS, POSES, createPetState, applyAction, actionForKey, advance, setGazeTarget } from '../renderer/state.mjs';
import { createPointerTracking } from '../renderer/pointer-tracking.mjs';
import { restoreAppearance } from '../renderer/state.mjs';

test('renderer recovery restores supported faces and exclusive poses while preserving saved skin preferences', () => {
  const state = createPetState();
  restoreAppearance(state, { expression: 'blush', pose: 'tea', cat: false, glasses: false }, { cat: true, glasses: true });
  assert.deepEqual([state.expression, state.pose, state.cat, state.glasses], ['blush', 'tea', true, true]);
  applyAction(state, { type: 'expression', id: 'blush' });
  assert.equal(state.expression, null, 'The restored face still toggles normally');
  applyAction(state, { type: 'pose', id: 'cake' });
  assert.equal(state.pose, 'cake');
  restoreAppearance(state, { expression: '__proto__', pose: 'untrusted', target: { x: 999 }, cat: true }, { cat: 'true', glasses: false });
  assert.deepEqual([state.expression, state.pose, state.cat, state.glasses], [null, 'idle', false, false]);
  assert.deepEqual(state.target, { x: 0, y: 0 }, 'Restoring appearance cannot inject other renderer state');
});
import hostPolicy from '../electron/host-policy.cjs';

test('number row and keypad map faces; F keys exclusively map skins and poses on both hosts', () => {
  assert.equal(EXPRESSIONS.length, 10);
  assert.deepEqual(EXPRESSIONS.map(item => item.key), ['1','2','3','4','5','6','7','8','9','0']);
  for (const item of EXPRESSIONS) {
    const expected = { type: 'expression', id: item.id };
    assert.deepEqual(actionForKey(`Digit${item.key}`), expected);
    assert.deepEqual(actionForKey(`Numpad${item.key}`), expected);
    assert.deepEqual(hostPolicy.actionForKey(item.key), expected);
  }
  for (const [items, type] of [[SKINS, 'toggle-skin'], [POSES, 'pose']]) for (const item of items) {
    assert.deepEqual(actionForKey(item.key), { type, id: item.id });
    assert.deepEqual(hostPolicy.actionForKey(item.key), { type, id: item.id });
  }
  for (const removed of ['KeyM', 'Minus', 'Equal', 'F7']) assert.equal(actionForKey(removed), null);
});

test('each face and face reset preserve the selected pose and both skin switches', () => {
  for (const pose of POSES) {
    const state = createPetState();
    applyAction(state, { type: 'pose', id: pose.id });
    for (const skin of SKINS) applyAction(state, { type: 'toggle-skin', id: skin.id });
    for (const face of EXPRESSIONS) {
      applyAction(state, { type: 'expression', id: face.id });
      assert.equal(state.expression, face.id);
      assert.equal(state.pose, pose.id); assert.equal(state.cat, true); assert.equal(state.glasses, true);
      applyAction(state, { type: 'expression', id: face.id });
      assert.equal(state.expression, null);
      assert.equal(state.pose, pose.id); assert.equal(state.cat, true); assert.equal(state.glasses, true);
    }
  }
});

test('poses are idempotent exclusive selections and skins toggle independently of faces and poses', () => {
  const state = createPetState();
  applyAction(state, { type: 'expression', id: 'cry' });
  applyAction(state, { type: 'toggle-skin', id: 'cat' });
  for (const pose of POSES) {
    for (let i = 0; i < 2; i++) {
      applyAction(state, { type: 'pose', id: pose.id });
      assert.equal(state.pose, pose.id); assert.equal(state.expression, 'cry'); assert.equal(state.cat, true);
    }
  }
  applyAction(state, { type: 'toggle-skin', id: 'glasses' });
  assert.equal(state.cat, true); assert.equal(state.glasses, true);
  applyAction(state, { type: 'toggle-skin', id: 'cat' });
  assert.equal(state.cat, false); assert.equal(state.glasses, true); assert.equal(state.expression, 'cry'); assert.equal(state.pose, 'tea');
  const snapshot = structuredClone(state);
  for (const action of [null, {type:'pose',id:'cat'}, {type:'toggle-skin',id:'pose'}, ...['pat','squint','star','glasses','tea','missing'].map(id=>({type:'expression',id}))]) applyAction(state, action);
  assert.deepEqual(state, snapshot, 'Removed expressions and malformed actions cannot alter the live state');
  applyAction(state, { type: 'reset' });
  assert.equal(state.expression, null); assert.equal(state.pose, 'idle'); assert.equal(state.cat, false); assert.equal(state.glasses, false);
});

test('cursor and spring stay bounded through long pauses and disabled tracking returns to center', () => {
  const state = createPetState(); state.target = { x: 10000, y: -10000 };
  for (let i = 0; i < 2000; i++) advance(state, i % 37 ? 1 / 60 : 400);
  assert.ok(state.gaze.x <= 1 && state.gaze.y >= -1);
  assert.ok(Number.isFinite(state.hair) && Math.abs(state.hair) < .2);
  for (let i = 0; i < 300; i++) advance(state, 1 / 60, { eyeTracking: false, hairMotion: false });
  assert.ok(Math.abs(state.gaze.x) < 1e-5);
  assert.ok(Math.abs(state.hair) < 1e-5);
});

test('gaze reaches the newest cursor in one paint and reverses without easing or overshoot',()=>{
  const state=createPetState();
  for(const target of [{x:1,y:-1},{x:-1,y:1},{x:.17,y:-.28},{x:0,y:0}]){
    setGazeTarget(state,target.x,target.y);advance(state,1/144);
    assert.deepEqual(state.gaze,target);
  }
  setGazeTarget(state,1,1);advance(state,1/60,{eyeTracking:false});
  assert.deepEqual(state.gaze,{x:0,y:0},'Disabling tracking centers on the next paint');
  advance(state,400,{eyeTracking:true});
  assert.deepEqual(state.gaze,{x:1,y:1},'A long pause applies the latest point, not old motion');
  setGazeTarget(state,Infinity,NaN);advance(state,NaN);
  assert.deepEqual(state.gaze,{x:0,y:0});assert.ok(Number.isFinite(state.time));
});

test('high-frequency cursor bursts retain only their last point and ignore stale host samples',()=>{
  const state=createPetState(),anchor={gazeX:292,gazeY:326};
  const tracking=createPointerTracking(state,anchor,()=>10000);
  for(let i=0;i<1000;i++)tracking.sample({localX:i%2?0:600,localY:i%3?0:800,width:600,height:800,sampledAt:1000+i});
  advance(state,1/60);
  assert.deepEqual(state.gaze,{x:-1,y:1});
  assert.equal(tracking.sample({localX:600,localY:0,width:600,height:800,sampledAt:1998}),false);
  advance(state,1/60);assert.deepEqual(state.gaze,{x:-1,y:1},'Delayed IPC cannot undo newer local movement');
  assert.equal(tracking.sample({localX:600,localY:0,width:600,height:800,sampledAt:2001}),true);
  advance(state,1/60);assert.deepEqual(state.gaze,{x:1,y:-1});
});

test('cursor mapping keeps its original canvas anchor at every aspect ratio and rejects invalid geometry',()=>{
  for(const [width,height]of [[420,560],[600,800],[900,800],[600,1000]]){
    const state=createPetState(),anchor={gazeX:292,gazeY:326};
    const tracking=createPointerTracking(state,anchor),scale=Math.min(width/740,height/800);
    assert.equal(tracking.sample({localX:(width-740*scale)/2+(140+292)*scale,localY:(height-800*scale)/2+326*scale,width,height,sampledAt:1}),true);
    advance(state,1/60);assert.ok(Math.abs(state.gaze.x)<1e-12&&Math.abs(state.gaze.y)<1e-12);
    const centered={...state.gaze};
    for(const malformed of [{width:0},{height:-1},{localX:NaN},{localY:Infinity}]){
      assert.equal(tracking.sample({localX:0,localY:0,width,height,sampledAt:2,...malformed}),false);
      advance(state,1/60);assert.deepEqual(state.gaze,centered);
    }
  }
});
