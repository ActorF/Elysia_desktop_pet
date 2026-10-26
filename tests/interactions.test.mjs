import test from 'node:test';
import assert from 'node:assert/strict';
import {createInteractions,createExpressionReaction,isHeadPoint,HEAD_ZONE,INTERACTION_LIMITS} from '../renderer/interactions.mjs';

function fixture() {
  const events=[],interactions=createInteractions({onReaction:event=>events.push(event),now:()=>0});
  const point=(x,now,extra={})=>interactions.sample({x,y:230,screenX:x,screenY:230,buttons:0,now,...extra});
  function click(start=0,extra={}) {
    const value={x:295,y:450,screenX:100,screenY:100,button:0,pointerId:1,...extra};
    interactions.pointerDown({...value,now:start});
    return interactions.pointerUp({...value,now:start+50});
  }
  return {events,interactions,point,click};
}

test('head zone follows the original upper hair in fixed character coordinates and excludes eyes/body',()=>{
  assert.equal(isHeadPoint(HEAD_ZONE.x,HEAD_ZONE.y),true);
  assert.equal(isHeadPoint(HEAD_ZONE.x+HEAD_ZONE.radiusX,HEAD_ZONE.y),true);
  assert.equal(isHeadPoint(295,110),true,'The upper crown is pettable, not only the bangs');
  assert.equal(isHeadPoint(295,285),true,'The lower fringe stays inside the petting region');
  assert.equal(isHeadPoint(292,326),false);
  assert.equal(isHeadPoint(295,500),false);
  assert.equal(isHeadPoint(HEAD_ZONE.x+HEAD_ZONE.radiusX,HEAD_ZONE.y+HEAD_ZONE.radiusY),false);
  assert.equal(isHeadPoint(NaN,230),false);
});

test('a short click on the head produces petting while a body click produces a poke',()=>{
  const f=fixture();f.click(0,{x:295,y:230});f.click(500,{x:295,y:450});
  assert.deepEqual(f.events,[{type:'head-pat',expression:'blush',duration:2400,now:50},
    {type:'poke',expression:'surprise',duration:1600,now:550}]);
});

test('hover never reacts, including deliberate back-and-forth head motion, passes and jitter',()=>{
  for(const xs of [[210,240,270,300,330,360,390],Array.from({length:30},(_,index)=>index%2?255:335),
    Array(30).fill(295),Array.from({length:30},(_,index)=>295+(index%2?3:-3))]) {
    const f=fixture();xs.forEach((x,index)=>f.point(x,index*100));assert.equal(f.events.length,0);
    assert.equal(f.interactions.snapshot().pokeCount,0);
  }
});

test('head classification uses the logical press position and is independent of screen origin',()=>{
  const f=fixture();
  f.interactions.pointerDown({x:295,y:230,screenX:-1500,screenY:700,now:0});
  assert.equal(f.interactions.snapshot().pressed.head,true);
  f.interactions.pointerUp({x:295,y:450,screenX:-1497,screenY:700,now:50});
  assert.equal(f.events[0].type,'head-pat');
  f.click(500,{x:295,y:450,screenX:-1000,screenY:-200});assert.equal(f.events[1].type,'poke');
});

test('four gentle head clicks still pet; the fifth within three seconds becomes angry',()=>{
  const f=fixture();for(let index=0;index<5;index++)f.click(index*500,{y:230});
  assert.deepEqual(f.events.map(event=>event.type),['head-pat','head-pat','head-pat','head-pat','poke-annoyed']);
  assert.equal(f.events[4].expression,'angry');assert.equal(f.events[4].duration,2600);
});

test('head and body clicks share one count so changing locations cannot avoid over-poking',()=>{
  const f=fixture();for(let index=0;index<5;index++)f.click(index*400,{y:index%2?450:230});
  assert.deepEqual(f.events.map(event=>event.type),['head-pat','poke','head-pat','poke','poke-annoyed']);
  assert.equal(f.interactions.snapshot().pokeCount,0);
});

test('all body clicks react, and the fifth uses the same angry response as excessive petting',()=>{
  const f=fixture();for(let index=0;index<5;index++)f.click(index*300);
  assert.deepEqual(f.events.map(event=>event.type),['poke','poke','poke','poke','poke-annoyed']);
});

test('angry cooldown ignores further head/body clicks without extending the cooldown',()=>{
  const f=fixture();for(let index=0;index<5;index++)f.click(index*200);
  const expires=f.interactions.snapshot().pokeCooldownUntil;
  f.click(1000,{y:230});f.click(2000);f.interactions.cancel();f.click(3000,{y:230});
  assert.equal(f.events.length,5);assert.equal(f.interactions.snapshot().pokeCooldownUntil,expires);
  f.click(expires-50,{y:230});assert.equal(f.events.length,6);assert.equal(f.events[5].type,'head-pat');
});

test('poke sequence uses a rolling three-second window, with an inclusive boundary',()=>{
  const exact=fixture();[0,750,1500,2250,3000].forEach(time=>exact.click(time));
  assert.equal(exact.events.at(-1).type,'poke-annoyed');
  const late=fixture();[0,750,1500,2250,3001].forEach(time=>late.click(time));
  assert.equal(late.events.filter(event=>event.type==='poke-annoyed').length,0);
  late.click(3500);assert.equal(late.events.at(-1).type,'poke-annoyed');
  const pause=fixture();[0,100,200,300,3401].forEach(time=>pause.click(time,{y:230}));
  assert.equal(pause.events.at(-1).type,'head-pat');assert.equal(pause.interactions.snapshot().pokeCount,1);
});

test('drag classification measures the maximum screen excursion even if local position never changes',()=>{
  const f=fixture();
  f.interactions.pointerDown({pointerId:1,screenX:100,screenY:100,now:0});
  f.point(295,100,{screenX:125,screenY:100,buttons:1});
  f.point(295,200,{screenX:100,screenY:100,buttons:1});
  assert.equal(f.interactions.snapshot().pressed.maximumDistance,25);
  f.interactions.pointerUp({pointerId:1,screenX:100,screenY:100,now:250});
  assert.equal(f.events.length,0);
  // Returning from a drag must also break an earlier rapid-poke streak.
  f.click(300);f.click(500);assert.equal(f.events.filter(event=>event.type==='poke-annoyed').length,0);
});

test('click distance and duration accept their stated thresholds and reject long presses',()=>{
  for(const [distance,duration,accepted] of [[6,500,true],[6.01,500,false],[0,501,false]]) {
    const f=fixture();f.interactions.pointerDown({screenX:100,screenY:100,now:0});
    f.interactions.pointerUp({screenX:100+distance,screenY:100,now:duration});
    assert.equal(f.events.length,accepted?1:0,`${distance} DIP, ${duration} ms`);
  }
});

test('right-click, missing screen coordinates, foreign pointer-up and cancel cannot create a click',()=>{
  const f=fixture();f.interactions.pointerUp({screenX:100,screenY:100,now:0});
  f.click(10,{button:2});assert.equal(f.events.length,0);
  f.interactions.pointerDown({x:100,y:100,now:100});
  f.interactions.pointerUp({x:100,y:100,now:150});assert.equal(f.events.length,0);
  f.interactions.pointerDown({pointerId:1,screenX:100,screenY:100,now:200});
  f.interactions.pointerUp({pointerId:2,screenX:100,screenY:100,now:250});assert.equal(f.events.length,0);
  f.interactions.cancel();f.interactions.pointerUp({pointerId:1,screenX:100,screenY:100,now:300});
  assert.equal(f.events.length,0);
  f.click(400,{blocked:true});assert.equal(f.events.length,0);
});

test('blocked samples invalidate a pending click and reset removes cooldown only when explicitly requested',()=>{
  const f=fixture();f.interactions.pointerDown({screenX:100,screenY:100,now:0});
  f.point(295,100,{blocked:true});f.interactions.pointerUp({screenX:100,screenY:100,now:150});
  assert.equal(f.events.length,0);
  [200,400,600,800,1000].forEach(time=>f.click(time));assert.equal(f.events.at(-1).type,'poke-annoyed');
  f.interactions.cancel();f.click(1200);assert.equal(f.events.length,5);
  f.interactions.reset();f.click(1400);assert.equal(f.events.length,6);
  assert.equal(INTERACTION_LIMITS.clickDistance,6);
});

test('old out-of-order pointer samples do not replace newer gesture state',()=>{
  const f=fixture();f.point(255,100);f.point(335,200);
  const before=f.interactions.snapshot();f.point(255,150);assert.deepEqual(f.interactions.snapshot(),before);
});

test('temporary expressions restore their previous expression and leave pose and skins untouched',()=>{
  let now=100,changes=0;
  const state={expression:'smile',pose:'tea',cat:true,glasses:true};
  const reaction=createExpressionReaction(state,{now:()=>now,onChange:()=>changes++});
  assert.equal(reaction.react('surprise',1600),true);assert.equal(state.expression,'surprise');
  reaction.tick(1699);assert.equal(state.expression,'surprise');
  reaction.tick(1700);assert.deepEqual(state,{expression:'smile',pose:'tea',cat:true,glasses:true});
  assert.equal(changes,2);assert.equal(reaction.snapshot(),null);
});

test('replacing one temporary expression with another still restores the original base',()=>{
  let now=0;const state={expression:null};const reaction=createExpressionReaction(state,{now:()=>now});
  reaction.react('surprise',1600);now=500;reaction.react('angry',2600);
  reaction.tick(1600);assert.equal(state.expression,'angry');
  reaction.tick(3100);assert.equal(state.expression,null);
});

test('explicit selections win whether cancelled before selection or detected during tick',()=>{
  const state={expression:'smile'},reaction=createExpressionReaction(state,{now:()=>0});
  reaction.react('blush',2400);reaction.cancel({restore:true});state.expression='wink';
  reaction.tick(3000);assert.equal(state.expression,'wink');
  reaction.react('blush',2400);state.expression='sleep';reaction.tick(3000);
  assert.equal(state.expression,'sleep');assert.equal(reaction.snapshot(),null);
  reaction.react('angry',2600);state.expression='heart';reaction.cancel({restore:true});
  assert.equal(state.expression,'heart');
});

test('cancelling without restore leaves the current expression and invalid reactions never overwrite it',()=>{
  const state={expression:null},reaction=createExpressionReaction(state,{now:()=>0});
  reaction.react('blush',2400);reaction.cancel({restore:false});reaction.tick(3000);
  assert.equal(state.expression,'blush');
  for(const [expression,duration] of [['missing',100],['angry',0],['angry',Infinity],['angry',-1]]) {
    assert.equal(reaction.react(expression,duration),false);assert.equal(state.expression,'blush');
  }
});

test('fine regions select the requested expression groups without changing voice groups',()=>{
  for(const [parts,expected] of [[['head','face','hand'],['blush','wink','heart','smile']],[['body','legs'],['surprise','blush']],[['prop'],['smile']]]){
    for(const part of parts)for(let i=0;i<expected.length;i++){
      const interaction=createInteractions({random:()=>(i+.5)/expected.length});
      interaction.pointerDown({part,screenX:10,screenY:10,pointerId:1,now:0});
      const result=interaction.pointerUp({screenX:10,screenY:10,pointerId:1,now:20});
      assert.equal(result.expression,expected[i]);assert.equal(result.part,part);
      assert.equal(result.type,['head','face'].includes(part)?'head-pat':'poke');
    }
  }
});

function heldReactionFixture() {
  let time=0,draws=0;
  const state={expression:'smile'},events=[];
  const reaction=createExpressionReaction(state,{now:()=>time});
  const interactions=createInteractions({now:()=>time,random:()=>{draws++;return .4;},
    canReact:at=>{reaction.tick(at);return !reaction.snapshot();},
    onReaction:event=>{events.push(event);reaction.react(event.expression,event.duration);},
  });
  const click=(at,part='head')=>{
    time=at;interactions.pointerDown({part,screenX:10,screenY:10,now:time});
    time=at+20;return interactions.pointerUp({screenX:10,screenY:10,now:time});
  };
  return {state,events,reaction,interactions,click,draws:()=>draws};
}

test('ordinary clicks keep the first expression and expiry while counting all regions without extra replies',()=>{
  const f=heldReactionFixture();f.click(0,'head');
  const first=f.state.expression,expiresAt=f.reaction.snapshot().expiresAt;
  for(const [at,part] of [[200,'body'],[400,'hand'],[600,'legs']])assert.equal(f.click(at,part),null);
  assert.equal(f.events.length,1);assert.equal(f.draws(),1);
  assert.equal(f.interactions.snapshot().pokeCount,4);
  assert.equal(f.state.expression,first);assert.equal(f.reaction.snapshot().expiresAt,expiresAt);
  f.reaction.tick(expiresAt);assert.equal(f.state.expression,'smile');
});

test('fifth mixed click interrupts the held face and later clicks cannot extend anger or cooldown',()=>{
  const f=heldReactionFixture();
  ['head','hand','body','legs','face'].forEach((part,index)=>f.click(index*100,part));
  assert.deepEqual(f.events.map(event=>event.type),['head-pat','poke-annoyed']);
  assert.equal(f.state.expression,'angry');
  const expiresAt=f.reaction.snapshot().expiresAt,cooldown=f.interactions.snapshot().pokeCooldownUntil;
  assert.equal(f.click(600,'prop'),null);assert.equal(f.click(1500,'head'),null);
  assert.equal(f.events.length,2);assert.equal(f.reaction.snapshot().expiresAt,expiresAt);
  assert.equal(f.interactions.snapshot().pokeCooldownUntil,cooldown);
  f.reaction.tick(expiresAt);assert.equal(f.state.expression,'smile');
  assert.equal(f.click(cooldown,'body').type,'poke');assert.notEqual(f.state.expression,'angry');
});

test('the next ordinary click works at exact expiry even before the next animation frame',()=>{
  const f=heldReactionFixture();f.click(0,'head');
  const expiresAt=f.reaction.snapshot().expiresAt;
  assert.equal(f.click(500,'body'),null);
  assert.equal(f.click(expiresAt-20,'body').type,'poke');
  assert.equal(f.events.length,2);assert.equal(f.state.expression,'surprise');
});

test('manual selection or disabling releases the hold but a cancelled gesture alone does not',()=>{
  const f=heldReactionFixture();f.click(0);
  f.interactions.cancel();assert.equal(f.click(200,'body'),null);
  f.interactions.cancel();f.reaction.cancel({restore:true});f.state.expression='heart';
  assert.equal(f.click(400,'body').type,'poke');
  f.reaction.tick(f.reaction.snapshot().expiresAt);assert.equal(f.state.expression,'heart');
  f.interactions.reset();f.reaction.cancel({restore:true});
  assert.equal(f.click(3000,'hand').type,'poke');
});

test('a first body or leg click never randomly selects anger',()=>{
  for(const part of ['body','legs'])for(const draw of [0,.25,.5,.75,.999999]){
    const interactions=createInteractions({random:()=>draw});
    interactions.pointerDown({part,screenX:10,screenY:10,now:0});
    const result=interactions.pointerUp({screenX:10,screenY:10,now:20});
    assert.ok(['surprise','blush'].includes(result.expression));assert.equal(result.type,'poke');
  }
});
test('fine regions retain shared fifth-click annoyance, cooldown and transparent-pixel rejection',()=>{
  const interaction=createInteractions({random:()=>0});let result;
  for(const [i,part] of ['head','hand','body','legs','face'].entries()){
    interaction.pointerDown({part,screenX:10,screenY:10,now:i*100});
    result=interaction.pointerUp({screenX:10,screenY:10,now:i*100+20});
  }
  assert.equal(result.type,'poke-annoyed');assert.equal(result.expression,'angry');
  interaction.pointerDown({part:'hand',screenX:10,screenY:10,now:500});
  assert.equal(interaction.pointerUp({screenX:10,screenY:10,now:520}),null);
  interaction.reset();interaction.pointerDown({part:null,screenX:10,screenY:10,now:1000});
  assert.equal(interaction.pointerUp({screenX:10,screenY:10,now:1020}),null);
});
