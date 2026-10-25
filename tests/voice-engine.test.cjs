'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createVoiceEngine,simulateVoice,validBirthday,GROUPS} = require('../electron/voice-engine.cjs');
const MINUTE=60_000,HOUR=60*MINUTE,DAY=24*HOUR;
const local = (day=26,hour=8,minute=0) => new Date(2026,9,day,hour,minute).getTime();
const poll = (engine,now,extra={}) => engine.evaluate({now,idleSeconds:0,...extra});
function ready(now, saved={}) {
  const engine=createVoiceEngine({now:now-5000,saved,random:()=>0});
  poll(engine,now-5000);
  return engine;
}

test('all twelve manual scenarios pass the real evaluator without editing live history', () => {
  const engine=ready(local()), before=engine.exportState();
  for(const groupId of GROUPS) {
    const result=engine.simulate(groupId,{now:local()});
    assert.equal(result?.groupId,groupId);
    assert.match(result.lineId,new RegExp(`^${groupId}-[123]$`));
    assert.equal(result.simulation,true);
    assert.equal(engine.commit(result,result.createdAt),false);
  }
  assert.deepEqual(engine.exportState(),before);
});

test('startup needs five seconds and actual recent input; idle polling does not manufacture activity', () => {
  const start=local(), engine=createVoiceEngine({now:start});
  assert.equal(poll(engine,start),null);
  assert.equal(poll(engine,start+4999),null);
  assert.equal(poll(engine,start+5000,{idleSeconds:60}),null);
  assert.equal(poll(engine,start+6000,{idleSeconds:59})?.groupId,'01');
  const last=engine.exportState().lastActiveAt;
  poll(engine,start+HOUR,{idleSeconds:3600});
  assert.equal(engine.exportState().lastActiveAt,last);
  assert.equal(poll(engine,start+HOUR,{locked:true}),null);
});

test('time windows include their start and exclude their end', () => {
  for(const [hour,minute,group] of [[6,0,'01'],[10,0,null],[11,30,'04'],[13,0,null],
    [14,0,'07'],[16,0,null],[17,30,'04'],[18,0,'04'],[19,0,'02'],[22,0,null]]) {
    const time=local(26,hour,minute), result=poll(ready(time),time);
    assert.equal(result?.groupId??null,group,`${hour}:${minute}`);
  }
});

test('priority coalesces simultaneous greetings without consuming successful-play counters', () => {
  const time=local(26,18), engine=ready(time);
  const first=poll(engine,time); assert.equal(first.groupId,'04');
  assert.equal(engine.exportState().days['2026-10-26'],undefined);
  assert.equal(engine.commit(first,time),true);
  assert.equal(engine.commit(first,time),false);
  const saved=engine.exportState();
  assert.equal(saved.days['2026-10-26'].total,1);
  assert.equal(saved.days['2026-10-26'].groups['02'],undefined);
  assert.ok(saved.handled['02:2026-10-26']);
  assert.equal(poll(engine,time+21*MINUTE),null,'Suppressed evening does not play after the meal greeting');
});

test('Friday takes the evening slot; a restart preserves the weekly and daily records', () => {
  const time=local(30,18), engine=ready(time);
  const candidate=poll(engine,time); assert.equal(candidate.groupId,'08');
  engine.commit(candidate,time);
  const saved=engine.exportState();
  assert.ok(saved.handled['02:2026-10-30']);
  const restarted=ready(time+30*MINUTE,saved);
  assert.equal(poll(restarted,time+30*MINUTE),null);
  assert.equal(poll(ready(local(31,10)),local(31,10)).groupId,'09');
});

test('cooldown, disabled, DND and fullscreen defer within the window and do not consume quotas', () => {
  const time=local(), engine=ready(time,{lastAutomaticAt:time-19*MINUTE});
  assert.equal(poll(engine,time),null);
  for(const extra of [{enabled:false},{dnd:true},{fullscreen:true},{busy:true},{suspended:true}]) {
    assert.equal(poll(engine,time+MINUTE,extra),null);
  }
  assert.equal(engine.exportState().days['2026-10-26'],undefined);
  assert.equal(poll(engine,time+MINUTE+1).groupId,'01');
  const late=ready(local(26,9,59));
  assert.equal(poll(late,local(26,9,59),{dnd:true}),null);
  assert.equal(poll(late,local(26,10)),null,'Expired mornings are not queued');
});

test('daily six-greeting limit exempts birthdays and never exempts automatic cooldown', () => {
  const time=local(), saved={days:{'2026-10-26':{total:6,groups:{}}}};
  const engine=ready(time,saved);
  assert.equal(poll(engine,time),null);
  const birthday=poll(engine,time,{birthday:'10-26'});
  assert.equal(birthday.groupId,'11');
  engine.commit(birthday,time);
  assert.equal(engine.exportState().days['2026-10-26'].total,6);
  const cooling=ready(time,{lastAutomaticAt:time-MINUTE});
  assert.equal(poll(cooling,time,{birthday:'10-26'}),null);
});

test('automatic line bags survive restart and do not repeat before all eligible lines are used', () => {
  let saved={}, chosen=[];
  for(let day=26;day<=31;day++) {
    const time=local(day),engine=ready(time,saved),candidate=poll(engine,time);
    assert.equal(candidate.groupId,'01'); chosen.push(candidate.lineId);
    engine.commit(candidate,time); saved=engine.exportState();
  }
  assert.equal(new Set(chosen.slice(0,3)).size,3);
  assert.equal(new Set(chosen.slice(3,6)).size,3);
  const engine=ready(local(),saved),before=engine.exportState();
  const manual=Array.from({length:3},()=>engine.selectLine('01',{manual:true}));
  assert.equal(new Set(manual).size,3);
  assert.deepEqual(engine.exportState(),before);
});

test('birthday requires a real configured date; first year excludes the historical third line', () => {
  assert.equal(validBirthday('02-29'),true);
  assert.equal(validBirthday('02-30'),false);
  assert.equal(validBirthday('2-2'),false);
  const time=local(), first=ready(time,{bags:{'11':['11-3']}});
  const candidate=poll(first,time,{birthday:'10-26'});
  assert.ok(['11-1','11-2'].includes(candidate.lineId));
  first.commit(candidate,time);
  const restarted=ready(time+HOUR,first.exportState());
  assert.equal(poll(restarted,time+HOUR,{birthday:'10-26'}),null);
  const returning=ready(time,{birthdayYears:[2025],bags:{'11':['11-3']}});
  assert.equal(poll(returning,time,{birthday:'10-26'}).lineId,'11-3');
  const feb=new Date(2027,1,28,16,30).getTime();
  assert.notEqual(poll(ready(feb),feb,{birthday:'02-29'})?.groupId,'11');
});

test('birthday line 3 stays in the same shuffle cycle while awaiting prior-year history', () => {
  let saved={},selected=[];
  for(let year=2026;year<2029;year++) {
    const time=new Date(year,9,26,16,30).getTime();
    const engine=ready(time,saved),candidate=poll(engine,time,{birthday:'10-26'});
    selected.push(candidate.lineId); engine.commit(candidate,time); saved=engine.exportState();
  }
  assert.notEqual(selected[0],'11-3');
  assert.equal(new Set(selected).size,3);
});

test('welcome requires an observed half-hour absence, waits five seconds, expires after two minutes', () => {
  const time=local(26,16),engine=ready(time);
  poll(engine,time);
  poll(engine,time+MINUTE,{idleSeconds:60});
  poll(engine,time+31*MINUTE,{idleSeconds:31*60});
  assert.equal(poll(engine,time+32*MINUTE),null);
  assert.equal(poll(engine,time+32*MINUTE+4999),null);
  const welcome=poll(engine,time+32*MINUTE+5000);assert.equal(welcome.groupId,'05');
  assert.equal(poll(engine,time+34*MINUTE),null);
  const fresh=ready(time+32*MINUTE);
  assert.equal(poll(fresh,time+32*MINUTE),null,'Fresh app must not invent a welcome event');
});

test('lock and suspend absence count, and no greeting can play until unlocked and active', () => {
  for(const mode of ['locked','suspended']) {
    const time=local(26,16),engine=ready(time);
    poll(engine,time);
    poll(engine,time+1000,{[mode]:true});
    assert.equal(poll(engine,time+31*MINUTE,{[mode]:true}),null);
    assert.equal(poll(engine,time+31*MINUTE+1000),null);
    const result=poll(engine,time+31*MINUTE+6000);
    assert.equal(result.groupId,'05');
  }
});

test('long absence uses last actual input, needs history and beats ordinary greetings', () => {
  const time=local(), engine=createVoiceEngine({now:time,saved:{lastActiveAt:time-73*HOUR}});
  assert.equal(poll(engine,time),null);
  const candidate=poll(engine,time+5000);assert.equal(candidate.groupId,'10');
  engine.commit(candidate,time+5000);
  const restarted=ready(time+30*MINUTE,engine.exportState());
  assert.equal(poll(restarted,time+30*MINUTE),null);
  const initial=ready(time);
  assert.equal(poll(initial,time).groupId,'01');
  const expired=createVoiceEngine({now:time,saved:{lastActiveAt:time-73*HOUR}});
  poll(expired,time,{dnd:true});
  poll(expired,time+MINUTE,{dnd:true});
  assert.equal(poll(expired,time+2*MINUTE).groupId,'01');
});

test('late-night reminder counts only observed use in the midnight window and survives restart', () => {
  const time=local(27,0,1),engine=createVoiceEngine({now:time});
  for(let minute=0;minute<10;minute++) assert.equal(poll(engine,time+minute*MINUTE),null);
  const candidate=poll(engine,time+10*MINUTE);assert.equal(candidate.groupId,'03');
  engine.commit(candidate,time+10*MINUTE);
  const restarted=ready(time+20*MINUTE,engine.exportState());
  for(let minute=20;minute<=35;minute++) assert.equal(poll(restarted,time+minute*MINUTE),null);
});

test('rest timer requires an hour, resets on five-minute breaks and does not repeat in one phase', () => {
  const time=local(26,15),engine=createVoiceEngine({now:time});
  // Suppress the afternoon greeting so its cooldown does not interfere with this scenario.
  for(let minute=0;minute<60;minute++) assert.equal(poll(engine,time+minute*MINUTE,{dnd:true}),null);
  const candidate=poll(engine,time+HOUR);assert.equal(candidate.groupId,'06');
  engine.commit(candidate,time+HOUR);
  for(let minute=61;minute<120;minute++) assert.notEqual(poll(engine,time+minute*MINUTE)?.groupId,'06');
  poll(engine,time+120*MINUTE,{idleSeconds:300});
  for(let minute=121;minute<181;minute++) assert.notEqual(poll(engine,time+minute*MINUTE,{dnd:true})?.groupId,'06');
  const result=poll(engine,time+181*MINUTE);
  assert.equal(result.groupId,'04','Dinner wins over simultaneous rest, which must be coalesced');
  engine.commit(result,time+181*MINUTE);
  assert.equal(engine.exportState().days['2026-10-26'].groups['06'],1);
});

test('a timer gap or a truly idle computer cannot count as continuous use', () => {
  const time=local(26,16),engine=createVoiceEngine({now:time});
  poll(engine,time);
  assert.equal(poll(engine,time+HOUR),null,'An hour without presence observations is not an observed use hour');
  assert.equal(poll(engine,time+2*HOUR,{idleSeconds:3600}),null);
  assert.notEqual(poll(engine,time+2*HOUR+5000)?.groupId,'06');
});

test('welcome and rest reminders each respect their independent two-per-day caps', () => {
  const time=local(26,16), saved={days:{'2026-10-26':{total:4,groups:{'05':2,'06':2}}}};
  const returning=ready(time,saved);
  poll(returning,time); poll(returning,time+MINUTE,{idleSeconds:60});
  poll(returning,time+31*MINUTE,{idleSeconds:1860});
  poll(returning,time+32*MINUTE);
  assert.equal(poll(returning,time+32*MINUTE+5000),null);
  const working=createVoiceEngine({now:time,saved});
  for(let minute=0;minute<=60;minute++) assert.notEqual(poll(working,time+minute*MINUTE)?.groupId,'06');
});

test('system-clock corrections cannot mute greetings until an old future date catches up', () => {
  const time=local(),engine=ready(time,{lastAutomaticAt:time+DAY,lastActiveAt:time+DAY});
  assert.equal(poll(engine,time),null);
  assert.equal(poll(engine,time+20*MINUTE).groupId,'01');
  const before=local(26,9),running=ready(before);
  const candidate=poll(running,before);running.commit(candidate,before);
  assert.equal(poll(running,time),null);
  assert.ok(running.exportState().lastAutomaticAt<=time);
  assert.ok(running.exportState().lastActiveAt<=time);
});

test('failed or superseded playback never consumes a slot; busy sampling preserves the reservation', () => {
  const time=local(),engine=ready(time),candidate=poll(engine,time);
  assert.equal(poll(engine,time+1000,{busy:true}),null);
  assert.equal(engine.commit(candidate,time+1000),true);
  const failed=ready(time), first=poll(failed,time),replacement=poll(failed,time+1000);
  assert.equal(failed.commit(first,time+1000),false);
  assert.equal(failed.commit(replacement,time+1000),true);
});

test('farewell is explicit, skips busy/recent playback and has no daily limit', () => {
  const time=local(),engine=ready(time,{days:{'2026-10-26':{total:6,groups:{}}}});
  assert.equal(engine.farewell({now:time,busy:true}),null);
  assert.equal(engine.farewell({now:time,lastPlaybackEndedAt:time-9999}),null);
  assert.equal(engine.farewell({now:time,enabled:false}),null);
  const farewell=engine.farewell({now:time,lastPlaybackEndedAt:time-10000});
  assert.equal(farewell.groupId,'12');
  assert.equal(engine.commit(farewell,time),true);
  assert.equal(engine.exportState().days['2026-10-26'].total,6);
});
