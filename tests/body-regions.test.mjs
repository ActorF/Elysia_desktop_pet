import test from 'node:test';
import assert from 'node:assert/strict';
import {partAtSource,sourceAtPointer,sourceAtMeshPoint} from '../renderer/body-regions.mjs';
import {createPetState} from '../renderer/state.mjs';
import {deformPoint,MESH_GRID} from '../renderer/mesh-rig.mjs';

test('pose-specific hands and props take precedence over face/body and invalid coordinates are rejected',()=>{
  assert.equal(partAtSource(540,200),'head');assert.equal(partAtSource(540,550),'face');
  assert.equal(partAtSource(540,900),'body');assert.equal(partAtSource(540,1250),'legs');
  assert.equal(partAtSource(770,752),'hand');assert.equal(partAtSource(635,741,'tea'),'hand');
  assert.equal(partAtSource(702,750,'cake'),'hand');assert.equal(partAtSource(337,751,'megaphone'),'hand');
  assert.equal(partAtSource(560,714,'tea'),'prop');assert.equal(partAtSource(390,760,'cake'),'prop');
  assert.equal(partAtSource(200,623,'megaphone'),'prop');
  assert.equal(partAtSource(250,1100),'body');assert.equal(partAtSource(980,900),'head');
  for(const p of [[NaN,0],[0,Infinity],[-1,0],[1090,10],[0,1443]])assert.equal(partAtSource(...p),null);
});

test('picking follows animated mesh vertices including head rotation and maps clipped/scaled viewports',()=>{
  const state=createPetState();state.head={x:1,y:-1};state.motionTime=1.1;
  const settings={headTracking:true,motionAmplitude:1.5};
  for(const pose of ['idle','tea','cake','megaphone']){
    state.pose=pose;
    for(const [i,j] of [[32,15],[32,32],[46,46],[33,76]]){
      const x=i*MESH_GRID.width/MESH_GRID.columns,y=j*MESH_GRID.height/MESH_GRID.rows;
      const moved=deformPoint(x,y,1.1,true,false,pose,1.5,state.head);
      const point=sourceAtMeshPoint(...moved,state,settings);
      assert.ok(Math.hypot(point.x-x,point.y-y)<1e-5);
      for(const scale of [.2,.7,4]){
        const rig={x:38,y:68,scale:.48},ox=-300,oy=50;
        const viewport={characterX:ox,characterY:oy,characterWidth:600*scale,characterHeight:800*scale};
        const local=[ox+(38+moved[0]*.48)*scale,oy+(68+moved[1]*.48)*scale];
        const selected=sourceAtPointer(...local,900,800,viewport,rig,state,settings);
        assert.ok(Math.hypot(selected.x-x,selected.y-y)<1e-5);
      }
    }
  }
  assert.equal(sourceAtMeshPoint(-100,-100,state,settings),null);
});
