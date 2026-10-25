'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createInteractionReplies,interactionDuration,INTERACTION_CATALOG}=require('../electron/interaction-replies.cjs');
const groups=['head-pat','poke','poke-annoyed'];

test('the interaction catalog has eighteen stable, unique, text-only lines',()=>{
  assert.equal(INTERACTION_CATALOG.length,18);
  assert.equal(new Set(INTERACTION_CATALOG.map(line=>line.id)).size,18);
  for(const [index,groupId] of groups.entries()) {
    const lines=INTERACTION_CATALOG.filter(line=>line.groupId===groupId);
    assert.deepEqual(lines.map(line=>line.id),Array.from({length:6},(_,n)=>`${['H','P','A'][index]}0${n+1}`));
    for(const line of lines) {
      assert.deepEqual(Object.keys(line).sort(),['groupId','id','text']);
      assert.ok([...line.text].length<=30);assert.equal(Object.isFrozen(line),true);
    }
  }
});

test('each independent six-line bag exhausts before repeating, across many cycles',()=>{
  let randomState=123456;
  const replies=createInteractionReplies({random:()=>{randomState=(1664525*randomState+1013904223)>>>0;return randomState/2**32;}});
  const picked=Object.fromEntries(groups.map(groupId=>[groupId,[]]));
  for(let index=0;index<60;index++)for(const groupId of groups) {
    const line=replies.reserve(groupId);assert.equal(line.groupId,groupId);
    assert.equal(replies.commit(line),true);picked[groupId].push(line.id);
  }
  for(const groupId of groups) {
    const ids=picked[groupId];
    for(let index=0;index<ids.length;index+=6)assert.equal(new Set(ids.slice(index,index+6)).size,6);
    for(let index=1;index<ids.length;index++)assert.notEqual(ids[index],ids[index-1]);
  }
});

test('refilling a bag actively prevents the previous last line becoming the next first line',()=>{
  let count=0;const replies=createInteractionReplies({random:()=>count++<5?0:.999});
  let last;
  for(let index=0;index<6;index++){last=replies.reserve('head-pat');replies.commit(last);}
  assert.equal(last.id,'H01');
  const next=replies.reserve('head-pat');assert.notEqual(next.id,last.id);
});

test('unshown reservations, invalid groups and duplicate callbacks do not consume a line',()=>{
  const replies=createInteractionReplies({random:()=>0});
  assert.equal(replies.reserve('__proto__'),null);assert.equal(replies.reserve(null),null);
  const first=replies.reserve('head-pat'),snapshot=replies.snapshot();
  const retry=replies.reserve('head-pat');assert.equal(retry.id,first.id);assert.deepEqual(replies.snapshot(),snapshot);
  assert.equal(replies.commit(first),false,'Superseded reservation cannot consume');
  assert.equal(replies.commit({...retry,id:'H99'}),false);
  assert.equal(replies.commit(retry),true);assert.equal(replies.commit(retry),false);
  assert.notEqual(replies.reserve('head-pat').id,first.id);
  const bodyBefore=replies.snapshot().poke;replies.reserve('poke-annoyed');
  assert.deepEqual(replies.snapshot().poke,bodyBefore);
});

test('caption duration follows reading length, capped at 2400–4600 milliseconds',()=>{
  assert.equal(interactionDuration('你好。'),2400);
  assert.equal(interactionDuration('好'.repeat(20)),3300);
  assert.equal(interactionDuration('好'.repeat(40)),4600);
  for(const line of INTERACTION_CATALOG)assert.equal(interactionDuration(line.text),Math.max(2400,Math.min(4600,[...line.text].length*120+900)));
});
