import test from 'node:test';
import assert from 'node:assert/strict';
import host from '../electron/host-policy.cjs';
import {createPetState, setGazeTarget, advance} from '../renderer/state.mjs';
import {headOffset, deformPoint, meshPointMotionBounds, MESH_GRID} from '../renderer/mesh-rig.mjs';

test('head following is opt-in, boolean-only and survives saved settings and unrelated patches', () => {
  assert.equal(host.sanitizeSettings({}).headTracking, false);
  const saved = host.sanitizeSettings({headTracking:true, eyeTracking:false, hairMotion:false});
  assert.deepEqual(host.sanitizeSettings(JSON.parse(JSON.stringify(saved))), saved);
  assert.equal(host.sanitizeSettings({scale:.3}, saved).headTracking, true);
  for (const value of ['false', 0, null, {}]) assert.equal(host.sanitizeSettings({headTracking:value}, saved).headTracking, true);
  assert.equal(host.sanitizeSettings({headTracking:false}, saved).headTracking, false);
});

test('head responds smoothly without eye or idle motion, reverses and resets when disabled', () => {
  const state = createPetState();
  setGazeTarget(state,1,-1);
  const settings = {headTracking:true, eyeTracking:false, hairMotion:false};
  advance(state,1/60,settings);
  assert.ok(state.head.x>0 && state.head.x<.3);
  assert.deepEqual(state.gaze,{x:0,y:0});
  for(let i=0;i<60;i++) advance(state,1/60,settings);
  assert.ok(state.head.x>.99 && state.head.y<-.99);
  setGazeTarget(state,-1,1);
  for(let i=0;i<60;i++) advance(state,1/60,settings);
  assert.ok(state.head.x<-.99 && state.head.y>.99);
  advance(state,1/60,{...settings,headTracking:false});
  assert.deepEqual(state.head,{x:0,y:0});
});

test('whole face follows while lower body stays fixed, and native shape bounds contain every head direction', () => {
  assert.ok(headOffset(540,450,{x:1,y:0})[0]>25);
  assert.ok(headOffset(540,450,{x:-1,y:0})[0]<-25);
  assert.ok(headOffset(540,450,{x:0,y:1})[1]>15);
  assert.ok(headOffset(540,1100,{x:1,y:1}).every(value=>value===0));
  const {width,height,columns,rows}=MESH_GRID;
  for(const pose of ['idle','megaphone','tea','cake']) for(const cat of [false,true]) {
    for(let j=0;j<=rows;j+=2) for(let i=0;i<=columns;i+=2) {
      const x=width*i/columns,y=height*j/rows;
      const bounds=meshPointMotionBounds(x,y,true,cat,pose,2,true);
      for(const gx of [-1,0,1]) for(const gy of [-1,0,1]) {
        const moved=deformPoint(x,y,1.2,true,cat,pose,2,{x:gx,y:gy});
        for(let axis=0;axis<2;axis++) assert.ok(moved[axis]-[x,y][axis]>=bounds[axis]-1e-5 && moved[axis]-[x,y][axis]<=bounds[axis+2]+1e-5);
      }
    }
  }
});

test('extreme head directions keep top-of-canvas cat-ear landmarks inside the source',()=>{
  for(const [x,y] of [[852,11],[205,48],[902,80]])for(const gx of [-1,1])for(const gy of [-1,1]){
    const delta=headOffset(x,y,{x:gx,y:gy});
    assert.ok(y+delta[1]>=0 && x+delta[0]>=0 && x+delta[0]<1090);
  }
});
