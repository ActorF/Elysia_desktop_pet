import test from 'node:test';
import assert from 'node:assert/strict';
import {createExpressionReaction} from '../renderer/interactions.mjs';
import {createIdleMood} from '../renderer/idle-mood.mjs';
import host from '../electron/host-policy.cjs';
function fixture(){
  let now=100000,random=0,changes=0;
  const state={expression:'heart',actionAge:0};
  const mood=createIdleMood(state,{onChange:()=>changes++,now:()=>now,random:()=>random});
  return {state,mood,time:t=>now=t,random:v=>random=v,sample:seconds=>mood.observe({idleSeconds:seconds,now:now}),changes:()=>changes};
}
test('lack of pet interaction uses its own clock and selects both neglected expressions',()=>{
  const f=fixture();f.time(219999);f.sample(0);f.mood.tick();assert.equal(f.state.expression,'heart');
  f.time(220000);f.sample(0);f.mood.tick();assert.equal(f.state.expression,'angry');
  f.time(249999);f.sample(0);f.mood.tick();assert.equal(f.changes(),1);
  f.time(250000);f.random(.99);f.sample(0);f.mood.tick();assert.equal(f.state.expression,'cry');
  f.mood.interact();assert.equal(f.state.expression,'heart');assert.equal(f.mood.snapshot(),null);
});
test('OS inactivity wins over neglect and wake returns to neglected or original state as appropriate',()=>{
  const f=fixture();f.time(500000);f.sample(300);f.mood.tick();assert.equal(f.state.expression,'sleep');
  f.time(530000);f.random(.99);f.sample(330);f.mood.tick();assert.equal(f.state.expression,'dizzy');
  f.time(531000);f.sample(0);f.mood.tick();assert.equal(f.state.expression,'cry');
  f.mood.interact();assert.equal(f.state.expression,'heart');
  f.time(532000);f.sample(0);f.mood.tick();assert.equal(f.state.expression,'heart');
});
test('device inactivity is independent from keyboard cloud permissions and earlier pet interaction',()=>{
  const f=fixture();f.sample(300);f.mood.tick({keyDisplay:false});assert.equal(f.state.expression,'sleep');
  f.mood.interact();f.mood.tick({keyDisplay:false});assert.equal(f.state.expression,'heart','old idle report cannot immediately undo an interaction');
});
test('invalid or stale OS reports never infer sleep; disabling restores face and blocked reactions are respected',()=>{
  const f=fixture();f.sample(300);f.time(104000);f.mood.tick();assert.equal(f.state.expression,'heart');
  f.mood.observe({idleSeconds:Infinity,now:104000});f.mood.tick();assert.equal(f.state.expression,'heart');
  f.sample(300);f.mood.tick({},true);assert.equal(f.state.expression,'heart');
  f.mood.tick();assert.equal(f.state.expression,'sleep');
  f.mood.tick({idleMoods:false});assert.equal(f.state.expression,'heart');
  f.state.expression='wink';f.mood.interact();f.time(224000);f.sample(0);f.mood.tick();
  f.mood.interact();assert.equal(f.state.expression,'wink','restore the latest manually chosen face');
});
test('idle preferences migrate, clamp and persist without depending on each other',()=>{
  assert.equal(host.sanitizeSettings({}).idleMoods,true);
  const saved=host.sanitizeSettings({idleMoods:false,neglectMinutes:3,deviceIdleMinutes:1});
  assert.deepEqual(host.sanitizeSettings(JSON.parse(JSON.stringify(saved))),saved);
  assert.equal(host.sanitizeSettings({idleMoods:'true'},saved).idleMoods,false);
  assert.equal(host.sanitizeSettings({neglectMinutes:Infinity},saved).neglectMinutes,3);
  assert.equal(host.sanitizeSettings({neglectMinutes:0}).neglectMinutes,1);
  assert.equal(host.sanitizeSettings({deviceIdleMinutes:900}).deviceIdleMinutes,120);
});

test('locked, suspended, fullscreen and unready monitors pause automatic expressions',()=>{
  for(const flag of ['locked','suspended','fullscreen','monitorReady']){
    const f=fixture();f.time(500000);
    f.mood.observe({now:500000,idleSeconds:400,[flag]:flag==='monitorReady'?false:true});
    f.mood.tick();assert.equal(f.state.expression,'heart');
  }
});
test('upstream restoration guard keeps external expression changes instead of overwriting them',()=>{
  const f=fixture();f.time(500000);f.sample(300);f.mood.tick();
  f.state.expression='smile';f.mood.tick();assert.equal(f.state.expression,'smile');assert.equal(f.mood.snapshot(),null);
});

test('upstream click reaction takes priority and returns to the manual face after an automatic mood',()=>{
  let time=100000;const state={expression:'heart'},now=()=>time;
  const mood=createIdleMood(state,{now,random:()=>0}),click=createExpressionReaction(state,{now});
  time+=120000;mood.tick();assert.equal(state.expression,'angry');
  mood.interact();click.react('wink',1800);time+=1000;
  mood.tick({},!!click.snapshot());assert.equal(state.expression,'wink');
  time+=1000;click.tick();mood.tick();assert.equal(state.expression,'heart');
});
