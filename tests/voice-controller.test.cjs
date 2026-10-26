'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createVoiceEngine } = require('../electron/voice-engine.cjs');
const { createInteractionReplies, interactionDuration, INTERACTION_CATALOG } = require('../electron/interaction-replies.cjs');

// Exercise the real controller and real time-rule engine. Only platform windows,
// filesystem persistence and the wall clock are replaced; no Electron process,
// user's preferences, actual speaker or native listener is touched by these tests.
function fixture({ saved = {}, available = true, interactionAvailable = available, delayed = false, delayedText = false, testAccess = true } = {}) {
  let now = new Date(2026,9,26,8).getTime(), nextTimer = 0, quitCount = 0;
  let speechHooks, environmentHooks, active = null, replies;
  const intervals = new Map(), timeouts = new Map(), stored = new Map();
  const lines = new Map(), played = [], stopped = [], published = [], volumeChanges = [];
  const interactionLines = new Map(INTERACTION_CATALOG.map(line=>[line.id,{...line,audioUrl:`file:///interaction/${line.id}.wav`} ]));
  const assetCalls = [];
  const environment = {idleSeconds:0,locked:false,suspended:false,fullscreen:false,monitorReady:true};
  const preferences = {};
  const directory = path.resolve('voice-controller-unit-profile'), file = path.join(directory,'voice-state.json');
  stored.set(file,JSON.stringify(saved));
  for(let group=1;group<=12;group++) for(let index=1;index<=3;index++) {
    const id=`${String(group).padStart(2,'0')}-${index}`;
    lines.set(id,{id,groupId:id.slice(0,2),text:`测试台词 ${id}`,audioUrl:`file:///voice/${id}.wav`});
  }
  const timers = (collection, fn, delay) => {const id=++nextTimer;collection.set(id,{fn,delay,dueAt:now+delay});return id;};
  const fakeFs = {
    readFileSync(name) {if(!stored.has(name))throw new Error('ENOENT');return stored.get(name);},
    mkdirSync() {}, writeFileSync(name,value) {stored.set(name,value);},
    renameSync(from,to) {stored.set(to,stored.get(from));stored.delete(from);},
  };
  function finish(record = active, status = 'ended', error = null) {
    if (!record) return;
    if(active === record)active=null;
    speechHooks.onFinished({token:record.token,lineId:record.line.id,kind:record.kind,status,...(error?{error}:{})});
  }
  const speech = {
    showText(line,options) {
      const record={...options,line,textOnly:true};played.push(record);active=record;
      return delayedText ? new Promise((resolve,reject)=>{record.resolve=resolve;record.reject=reject;}) : Promise.resolve({ok:true,token:options.token});
    },
    play(line,options) {
      const record={...options,line};played.push(record);active=record;
      return delayed ? new Promise((resolve,reject)=>{record.resolve=resolve;record.reject=reject;}) : Promise.resolve({ok:true,token:options.token});
    },
    stop(reason='stopped') {stopped.push(reason);finish(active,reason);},
    setVolume(value) {volumeChanges.push(value);},
    reposition() {}, getWindow() {return null;}, dispose() {speech.stop();},
  };
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const entry = path.resolve(__dirname,'../electron/voice-controller.cjs');
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(entry,'utf8'),{
    module,exports:module.exports,__dirname:path.dirname(entry),console,Date:Clock,
    setInterval:(fn,delay)=>timers(intervals,fn,delay),clearInterval:id=>intervals.delete(id),
    setTimeout:(fn,delay)=>timers(timeouts,fn,delay),clearTimeout:id=>timeouts.delete(id),
    require(name) {
      if(name==='node:fs')return fakeFs;
      if(name==='node:path')return path;
      if(name==='./voice-engine.cjs')return {createVoiceEngine};
      if(name==='./interaction-replies.cjs')return {INTERACTION_CATALOG,createInteractionReplies:()=>{replies=createInteractionReplies({random:()=>0});return replies;}};
      if(name==='./voice-assets.cjs')return {
        loadVoiceAssets:()=>({lines,catalog:[],available,error:available?null:'missing audio',allowedUrls:new Set([...lines.values()].map(line=>line.audioUrl))}),
        loadInteractionAssets:(root,directory)=>{assetCalls.push({root,directory});return {lines:interactionAvailable?interactionLines:new Map(),
          available:interactionAvailable,error:interactionAvailable?null:'missing interaction audio',
          allowedUrls:new Set(interactionAvailable?[...interactionLines.values()].map(line=>line.audioUrl):[])};},
      };
      if(name==='./speech-window.cjs')return {createSpeechWindow:options=>{speechHooks=options;return speech;}};
      if(name==='./voice-environment.cjs')return {createVoiceEnvironment:options=>{environmentHooks=options;return {sample:()=>({now,...environment}),dispose(){}};}};
      throw new Error(`Unexpected dependency ${name}`);
    },
  },{filename:entry});
  const testHooks = testAccess ? {} : undefined;
  const productionController=module.exports.createVoiceController({root:path.resolve(__dirname,'..'),userData:directory,
    interactionAssetDirectory:path.resolve('voice-controller-unit-interaction-assets'),
    getCharacterBounds:()=>({x:100,y:100,width:420,height:560}),getPreferences:()=>preferences,
    publish:value=>published.push(value),quit:()=>quitCount++,testHooks});
  const controller={...productionController,...testHooks};
  controller.start();
  const flush=async()=>{await Promise.resolve();await Promise.resolve();};
  async function advance(milliseconds=0) {
    const target=now+milliseconds;let count=0;
    while(true) {
      const due=[...timeouts].filter(([,entry])=>entry.dueAt<=target).sort((a,b)=>a[1].dueAt-b[1].dueAt)[0];
      if(!due)break;
      assert.ok(++count<10000,'Timers must advance rather than spinning at the same timestamp');
      const [id,entry]=due;now=Math.max(now,entry.dueAt);timeouts.delete(id);entry.fn();await flush();
    }
    now=target;await flush();
  }
  return {
    controller,productionController,testHooks,played,stopped,published,volumeChanges,intervals,timeouts,environment,preferences,assetCalls,
    replyHistory:()=>replies.snapshot(),
    get now(){return now;},get quitCount(){return quitCount;},
    persisted:()=>JSON.parse(stored.get(file)),
    async tick(milliseconds=1000,patch={}) {Object.assign(environment,patch);await advance(milliseconds);for(const {fn} of [...intervals.values()])fn();await flush();},
    started(record=active) {speechHooks.onStarted({token:record.token,lineId:record.line.id,kind:record.kind});},
    finish,flush,advance,
    block(reason) {environment[reason]=true;environmentHooks.onBlocked(reason);},
    fireTimeout:advance,
  };
}
const playedToday = f => f.controller.getHistory().days['2026-10-26']?.total ?? 0;

test('non-object JSON voice profiles fall back safely and do not prevent normal automatic playback', async()=>{
  for(const saved of [null, [], 'old malformed state', 7, false]) {
    const f=fixture({saved,testAccess:false});
    const settings=f.controller.getState().settings;
    assert.equal(settings.enabled,true);assert.equal(settings.volume,.8);assert.equal(settings.dnd,false);
    await f.tick(5000);assert.equal(f.played.length,1);assert.equal(f.played[0].kind,'automatic');
    f.started();assert.equal(playedToday(f),1);f.controller.dispose();
  }
});

test('production controller exposes no audition, simulation, or sample catalog while normal greetings still play', async()=>{
  const f=fixture({testAccess:false});
  assert.equal(typeof f.productionController.playVoice,'undefined');
  assert.equal(typeof f.productionController.simulateVoice,'undefined');
  assert.equal(typeof f.productionController.getCatalog,'undefined');
  const state=f.controller.getState();
  for(const key of ['catalog','interactionCatalog','sample'])assert.equal(Object.hasOwn(state,key),false);
  await f.tick(5000);assert.equal(f.played.length,1);assert.equal(f.played[0].kind,'automatic');
  assert.equal(f.controller.getState().playback.text,f.played[0].line.text);
  f.started();assert.equal(playedToday(f),1);
  f.controller.dispose();
});

test('developer playback hooks are explicitly injected and never attached to the production controller', async()=>{
  const f=fixture();
  assert.equal(typeof f.productionController.playVoice,'undefined');assert.equal(typeof f.productionController.simulateVoice,'undefined');
  assert.equal(typeof f.testHooks.playVoice,'function');assert.equal(typeof f.testHooks.simulateVoice,'function');
  assert.equal(f.testHooks.getCatalog().interaction.length,18);
  await f.testHooks.playVoice('H01');assert.equal(f.played.at(-1).line.id,'H01');
  assert.equal(playedToday(f),0);f.controller.dispose();
});

test('interaction captions work without audio assets and never consume automatic history', async()=>{
  const f=fixture({available:false,saved:{settings:{dnd:true,volume:0}}}), before=f.controller.getHistory();
  assert.equal(await f.controller.interact('head-pat'),true);
  const head=f.played.at(-1);assert.equal(head.textOnly,true);assert.equal(head.kind,'interaction');
  const line=INTERACTION_CATALOG.find(line=>line.id===head.line.id);
  assert.equal(line.groupId,'head-pat');assert.equal(head.duration,interactionDuration(line.text));f.started(head);
  assert.equal(f.controller.getState().playback.text,line.text);
  assert.equal(await f.controller.interact('head-pat'),false,'Repeated same-tick text is throttled');
  assert.equal(await f.controller.interact('poke-annoyed'),true,'Angry escalation replaces the gentle caption immediately');
  const angry=f.played.at(-1);f.started(angry);f.finish(angry);
  assert.deepEqual(f.controller.getHistory(),before);assert.equal(f.quitCount,0);
  assert.equal(await f.controller.interact('__proto__'),false);
  assert.equal(await f.controller.interact({text:'untrusted'}),false);
  f.controller.dispose();
});

test('interaction bags advance only for displayed captions and rejected clicks leave all groups intact',async()=>{
  const f=fixture({available:false});
  await f.controller.interact('head-pat');const first=f.played.at(-1),before=f.replyHistory();
  assert.equal(before['head-pat'].remaining.length,6);
  assert.equal(await f.controller.interact('head-pat'),false);assert.deepEqual(f.replyHistory(),before);
  f.started(first);assert.equal(f.replyHistory()['head-pat'].remaining.length,5);
  f.started(first);assert.equal(f.replyHistory()['head-pat'].remaining.length,5);
  for(const block of ['locked','suspended','clickThrough']) {
    if(block==='clickThrough')f.preferences.clickThrough=true;else f.environment[block]=true;
    const snapshot=f.replyHistory();assert.equal(await f.controller.interact('poke'),false);assert.deepEqual(f.replyHistory(),snapshot);
    f.preferences.clickThrough=false;f.environment.locked=false;f.environment.suspended=false;
  }
  await f.tick(250);await f.controller.interact('head-pat');
  assert.notEqual(f.played.at(-1).line.id,first.line.id);f.started();
  assert.equal(f.replyHistory()['head-pat'].remaining.length,4);
  assert.equal(f.replyHistory().poke.remaining.length,0);f.controller.dispose();
});

test('caption failure or replacement before prepared retries the unconsumed line and ignores late started',async()=>{
  const f=fixture({available:false,delayedText:true});
  const failed=f.controller.interact('head-pat'),first=f.played.at(-1);
  first.resolve({ok:false,error:'layout failed'});assert.equal(await failed,false);
  await f.tick(250);
  const retry=f.controller.interact('head-pat'),second=f.played.at(-1);
  assert.equal(second.line.id,first.line.id);second.resolve({ok:true});await retry;
  // Escalation bypasses 250 ms throttling and replaces the not-yet-shown head caption.
  const escalation=f.controller.interact('poke-annoyed'),angry=f.played.at(-1);
  angry.resolve({ok:true});await escalation;f.started(second);f.started(angry);
  assert.equal(f.replyHistory()['head-pat'].remaining.length,6);
  assert.equal(f.replyHistory()['poke-annoyed'].remaining.length,5);
  await f.tick(250);const thirdRequest=f.controller.interact('head-pat'),third=f.played.at(-1);
  assert.equal(third.line.id,first.line.id);third.resolve({ok:true});await thirdRequest;f.started(third);
  assert.equal(f.replyHistory()['head-pat'].remaining.length,5);f.controller.dispose();
});

test('interactions do not interrupt a spoken line, a locked session or pending quit', async()=>{
  const f=fixture();await f.controller.playVoice('01-1');f.started();
  const record=f.played.at(-1),stops=f.stopped.length;
  assert.equal(await f.controller.interact('head-pat'),false);
  assert.equal(f.played.at(-1),record);assert.equal(f.stopped.length,stops);
  f.finish(record);f.environment.locked=true;
  assert.equal(await f.controller.interact('poke'),false);
  f.environment.locked=false;f.controller.requestQuit();
  assert.equal(await f.controller.interact('poke-annoyed'),false);
  assert.equal(f.quitCount,1);f.controller.dispose();
});

test('automatic audio commits only after actual started, survives busy polling and persists exactly once', async()=>{
  const f=fixture();
  await f.tick(1000);assert.equal(f.played.length,0);
  await f.tick(4000);assert.equal(f.played.length,1);
  const record=f.played[0];assert.equal(record.kind,'automatic');
  assert.equal(f.controller.getState().playback.status,'loading');
  assert.equal(playedToday(f),0);
  await f.tick();assert.equal(f.played.length,1);assert.equal(playedToday(f),0);
  f.started(record);assert.equal(playedToday(f),1);
  assert.equal(f.persisted().history.days['2026-10-26'].total,1);
  f.started(record);assert.equal(playedToday(f),1,'Duplicate native started cannot double-count');
  f.finish(record);assert.equal(f.controller.getState().playback.status,'idle');
  await f.tick();assert.equal(f.played.length,1);
  f.controller.dispose();
});

test('load failures and pre-start audio errors keep automatic quotas and line rotation untouched', async()=>{
  for(const kind of ['result','rejection','event']) {
    const f=fixture({delayed:true});await f.tick(5000);
    const record=f.played[0],bags=f.controller.getHistory().bags;
    if(kind==='result')record.resolve({ok:false,error:'cannot load'});
    if(kind==='rejection')record.reject(new Error('cannot load'));
    if(kind==='event'){f.finish(record,'error','cannot decode');record.resolve({ok:false,error:'cannot decode'});}
    await f.flush();
    assert.equal(playedToday(f),0);assert.deepEqual(f.controller.getHistory().bags,bags);
    assert.equal(f.controller.getState().playback.status,'error');
    await f.tick(29_000);assert.equal(f.played.length,1,'Failed audio should not retry on every poll');
    await f.tick(1000);assert.equal(f.played.length,2);
    f.controller.dispose();
  }
});

test('an error after audible playback starts retains its quota and does not replay the same event', async()=>{
  const f=fixture();await f.tick(5000);const record=f.played[0];
  f.started(record);f.finish(record,'error','device disconnected after playback began');
  assert.equal(playedToday(f),1);
  assert.equal(f.controller.getState().playback.status,'error');
  await f.tick(31_000);assert.equal(f.played.length,1);
  f.controller.dispose();
});

test('disabled, DND, zero volume, fullscreen and missing assets do not spend automatic slots', async()=>{
  for(const options of [{settings:{enabled:false}},{settings:{dnd:true}},{settings:{volume:0}},
    {environment:{fullscreen:true}},{available:false}]) {
    const f=fixture({saved:{settings:options.settings},available:options.available??true});
    await f.tick(5000,options.environment??{});
    assert.equal(f.played.length,0,JSON.stringify(options));
    assert.equal(playedToday(f),0);
    f.controller.dispose();
  }
});

test('disabling, DND or muting a loading greeting cancels it; its late started event cannot count', async()=>{
  for(const patch of [{enabled:false},{dnd:true},{volume:0}]) {
    const f=fixture({delayed:true});await f.tick(5000);const record=f.played[0];
    f.controller.setSettings(patch);
    assert.equal(f.controller.getState().playback.status,'idle',JSON.stringify(patch));
    f.started(record);record.resolve({ok:false,error:'cancelled'});await f.flush();
    assert.equal(playedToday(f),0);assert.equal(f.controller.getState().playback.status,'idle');
    f.controller.dispose();
  }
});

test('manual auditions and all twelve simulated scenarios never change automatic history or quit the app', async()=>{
  const f=fixture(),before=f.controller.getHistory();
  await f.controller.playVoice('01-3');f.started();f.finish();
  for(let group=1;group<=12;group++) {
    await f.controller.simulateVoice(String(group).padStart(2,'0'));
    const record=f.played.at(-1);assert.equal(record.kind,'simulation');
    f.started(record);f.finish(record);
  }
  assert.deepEqual(f.controller.getHistory(),before);assert.equal(f.quitCount,0);
  assert.equal(f.played.length,13);
  await f.controller.playVoice('../../outside.wav');await f.controller.simulateVoice('13');
  assert.equal(f.played.length,13);
  f.controller.dispose();
});

test('replacing an automatic load with a manual line ignores all delayed callbacks from the old request', async()=>{
  const f=fixture({delayed:true});await f.tick(5000);const old=f.played[0];
  const nextRequest=f.controller.playVoice('07-2'),next=f.played[1];
  assert.equal(next.kind,'manual');assert.equal(f.stopped.at(-1),'replaced');
  f.started(old);f.finish(old,'error','late decoder failure');old.reject(new Error('late load failure'));
  await f.flush();
  assert.equal(f.controller.getState().playback.lineId,'07-2');
  assert.equal(f.controller.getState().playback.status,'loading');assert.equal(playedToday(f),0);
  next.resolve({ok:true});await nextRequest;f.started(next);
  assert.equal(f.controller.getState().playback.status,'playing');assert.equal(playedToday(f),0);
  f.controller.dispose();
});

test('locking, suspending or fullscreen blocks a pending automatic load before started can spend quota', async()=>{
  for(const reason of ['locked','suspended','fullscreen']) {
    const f=fixture({delayed:true});await f.tick(5000);const record=f.played[0];
    f.block(reason);f.started(record);record.resolve({ok:false,error:'cancelled'});await f.flush();
    assert.equal(f.controller.getState().playback.status,'idle');assert.equal(playedToday(f),0);
    await f.tick();assert.equal(f.played.length,1);
    f.controller.dispose();
  }
});

test('farewell is played once on explicit quit and can be skipped without duplicate quit calls', async()=>{
  const f=fixture();f.controller.requestQuit();await f.flush();
  const record=f.played[0];assert.equal(record.kind,'farewell');assert.equal(f.quitCount,0);
  f.started(record);assert.equal(playedToday(f),0);
  f.controller.requestQuit();assert.equal(f.quitCount,1);assert.equal(f.stopped.at(-1),'skipped');
  f.finish(record);f.controller.requestQuit();await f.fireTimeout(30000);
  assert.equal(f.quitCount,1);assert.equal(f.played.length,1);
  f.controller.dispose();
});

test('farewell ends, fails or reaches watchdog timeout with exactly one quit', async()=>{
  for(const outcome of ['ended','error','timeout']) {
    const f=fixture();f.controller.requestQuit();await f.flush();const record=f.played[0];
    if(outcome==='timeout')await f.fireTimeout(30000);else f.finish(record,outcome,outcome==='error'?'decode failed':null);
    assert.equal(f.quitCount,1);f.controller.requestQuit();f.finish(record);await f.fireTimeout(30000);
    assert.equal(f.quitCount,1);assert.equal(f.played.length,1);
    f.controller.dispose();
  }
});

test('busy, recently played or muted quit skips farewell, and another quit request cannot start it later', async()=>{
  for(const reason of ['busy','recent','muted','disabled','dnd','locked']) {
    const f=fixture();
    if(reason==='busy'||reason==='recent') {
      await f.controller.playVoice('01-1');f.started();
      if(reason==='recent')f.finish();
    }
    if(reason==='muted')f.controller.setSettings({volume:0});
    if(reason==='disabled')f.controller.setSettings({enabled:false});
    if(reason==='dnd')f.controller.setSettings({dnd:true});
    if(reason==='locked')f.environment.locked=true;
    const before=f.played.length;f.controller.requestQuit();await f.flush();
    assert.equal(f.quitCount,1,reason);assert.equal(f.played.length,before,reason);
    if(reason==='busy')f.finish();
    await f.tick(11_000);f.controller.requestQuit();await f.flush();
    assert.equal(f.quitCount,1);assert.equal(f.played.length,before,'An already requested quit must remain final');
    f.controller.dispose();
  }
});

test('dispose cancels callbacks and timers and never permits a new playback or quit request', async()=>{
  const f=fixture({delayed:true});await f.tick(5000);const record=f.played[0];
  f.controller.dispose();const published=f.published.length;
  f.started(record);record.resolve({ok:false,error:'destroyed'});await f.flush();
  await f.controller.playVoice('02-1');f.controller.requestQuit();await f.fireTimeout(30000);
  assert.equal(f.played.length,1);assert.equal(f.quitCount,0);assert.equal(f.published.length,published);
  assert.equal(f.intervals.size,0);assert.equal(f.timeouts.size,0);
});

test('interaction recordings and their error state are independent of the daily asset pack',async()=>{
  const f=fixture({available:false,interactionAvailable:true});
  const state=f.controller.getState();
  assert.equal(state.available,false);assert.equal(state.interactionAvailable,true);assert.equal(state.interactionError,null);
  assert.equal(f.testHooks.getCatalog().interaction.length,18);assert.equal(state.queuedInteraction,null);
  assert.equal(f.assetCalls[0].directory,path.resolve('voice-controller-unit-interaction-assets'));
  assert.equal(f.controller.allowsUrl('file:///interaction/H01.wav'),true);
  assert.equal(f.controller.allowsUrl('file:///interaction/H07.wav'),false);
  await f.controller.interact('head-pat');await f.advance(300);
  assert.equal(f.played.length,1);assert.equal(f.played[0].textOnly,undefined);f.controller.dispose();
  const missing=fixture({interactionAvailable:false});
  assert.equal(missing.controller.getState().available,true);
  assert.equal(missing.controller.getState().interactionAvailable,false);
  assert.equal(missing.controller.getState().interactionError,'missing interaction audio');
  assert.equal(missing.controller.allowsUrl('file:///interaction/H01.wav'),false);missing.controller.dispose();
});

test('rapid gentle clicks debounce into the latest kind and consume only the line that actually starts',async()=>{
  const f=fixture({available:false,interactionAvailable:true});
  assert.equal(await f.controller.interact('head-pat'),true);assert.equal(f.played.length,0);
  await f.advance(100);assert.equal(await f.controller.interact('poke'),true);
  await f.advance(100);assert.equal(await f.controller.interact('head-pat'),true);
  assert.equal(f.controller.getState().queuedInteraction.kind,'head-pat');
  await f.advance(299);assert.equal(f.played.length,0);
  await f.advance(1);assert.equal(f.played.length,1);assert.match(f.played[0].line.id,/^H0[1-6]$/);
  assert.equal(f.controller.getState().queuedInteraction,null);
  assert.equal(f.replyHistory()['head-pat'].remaining.length,6);assert.equal(f.replyHistory().poke.remaining.length,0);
  f.started();assert.equal(f.replyHistory()['head-pat'].remaining.length,5);f.started();
  assert.equal(f.replyHistory()['head-pat'].remaining.length,5);assert.equal(playedToday(f),0);f.controller.dispose();
});

test('an annoyed request wins the debounce slot without later clicks extending or replacing it',async()=>{
  const f=fixture();
  await f.controller.interact('head-pat');await f.advance(100);
  assert.equal(await f.controller.interact('poke-annoyed'),true);
  const queued=f.controller.getState().queuedInteraction;
  assert.equal(queued.kind,'poke-annoyed');assert.equal(queued.expiresAt-f.now,6000);
  await f.advance(100);
  for(const kind of ['head-pat','poke','poke-annoyed'])assert.equal(await f.controller.interact(kind),false);
  assert.deepEqual(f.controller.getState().queuedInteraction,queued);
  await f.advance(199);assert.equal(f.played.length,0);
  await f.advance(1);assert.equal(f.played.length,1);assert.match(f.played[0].line.id,/^A0[1-6]$/);
  assert.equal(f.replyHistory()['head-pat'].remaining.length,0);f.started();
  assert.equal(f.replyHistory()['poke-annoyed'].remaining.length,5);f.controller.dispose();
});

test('spoken interactions reject normal interruption and keep one annoyed follow-up until ended plus 1200 ms',async()=>{
  const f=fixture();await f.controller.interact('head-pat');await f.advance(300);f.started();
  const head=f.played[0],before=f.replyHistory(),stopCount=f.stopped.length;
  for(const kind of ['head-pat','poke'])assert.equal(await f.controller.interact(kind),false);
  assert.deepEqual(f.replyHistory(),before);assert.equal(f.stopped.length,stopCount);
  assert.equal(await f.controller.interact('poke-annoyed'),true);
  const expiry=f.controller.getState().queuedInteraction.expiresAt;
  await f.advance(100);
  for(const kind of ['head-pat','poke','poke-annoyed'])assert.equal(await f.controller.interact(kind),false);
  assert.equal(f.controller.getState().queuedInteraction.expiresAt,expiry);
  assert.equal(f.played.length,1);f.finish(head);
  await f.advance(1199);assert.equal(f.played.length,1);
  await f.advance(1);assert.equal(f.played.length,2);assert.match(f.played[1].line.id,/^A0[1-6]$/);
  f.started();assert.equal(await f.controller.interact('poke-annoyed'),false,'An already speaking annoyed line cannot queue another');
  assert.equal(f.controller.getState().queuedInteraction,null);f.controller.dispose();
});

test('an annoyed follow-up expires after six seconds instead of playing after a long interaction',async()=>{
  const f=fixture();await f.controller.interact('head-pat');await f.advance(300);f.started();
  await f.controller.interact('poke-annoyed');const expires=f.controller.getState().queuedInteraction.expiresAt;
  await f.advance(5000);assert.equal(await f.controller.interact('poke-annoyed'),false);
  assert.equal(f.controller.getState().queuedInteraction.expiresAt,expires);
  await f.advance(1001);f.finish();await f.advance(1200);
  assert.equal(f.played.length,1);assert.equal(f.controller.getState().queuedInteraction,null);
  assert.equal(f.replyHistory()['poke-annoyed'].remaining.length,0);f.controller.dispose();
});

test('quiet time rejects normal clicks but can accept one annoyed reply after a completed interaction',async()=>{
  const f=fixture();await f.controller.interact('poke');await f.advance(300);f.started();f.finish();
  assert.equal(await f.controller.interact('head-pat'),false);assert.equal(await f.controller.interact('poke'),false);
  assert.equal(await f.controller.interact('poke-annoyed'),true);
  await f.advance(1199);assert.equal(f.played.length,1);
  await f.advance(1);assert.equal(f.played.length,2);assert.match(f.played[1].line.id,/^A0[1-6]$/);f.controller.dispose();
});

test('automatic greetings wait behind both the interaction debounce slot and the post-audio gap',async()=>{
  const f=fixture();await f.advance(4900);await f.controller.interact('head-pat');
  await f.tick(100);assert.equal(f.played.length,0,'Queued interaction owns the upcoming speaking slot');
  await f.advance(200);assert.equal(f.played[0].kind,'interaction');f.started();f.finish();
  await f.tick(1199);assert.equal(f.played.length,1);
  await f.tick(1);assert.equal(f.played.length,2);assert.equal(f.played[1].kind,'automatic');f.controller.dispose();
});

test('daily manual, automatic, simulation and farewell speech reject interactions rather than queue them',async()=>{
  for(const kind of ['manual','automatic','simulation','farewell']) {
    const f=fixture();
    if(kind==='manual')await f.controller.playVoice('01-1');
    if(kind==='automatic')await f.tick(5000);
    if(kind==='simulation')await f.controller.simulateVoice('01');
    if(kind==='farewell'){f.controller.requestQuit();await f.flush();}
    const before=f.replyHistory(),count=f.played.length;
    for(const interaction of ['head-pat','poke','poke-annoyed'])assert.equal(await f.controller.interact(interaction),false);
    assert.equal(f.played.length,count);assert.equal(f.controller.getState().queuedInteraction,null);
    assert.deepEqual(f.replyHistory(),before);f.controller.dispose();
  }
});

test('manual audition of all eighteen interaction lines is immediate and does not consume any bag or daily quota',async()=>{
  const f=fixture(),history=f.controller.getHistory(),bags=f.replyHistory();
  for(const line of INTERACTION_CATALOG) {
    await f.controller.playVoice(line.id);const record=f.played.at(-1);
    assert.equal(record.kind,'manual');assert.equal(record.line.id,line.id);assert.equal(record.textOnly,undefined);
    assert.equal(f.controller.getState().queuedInteraction,null);f.started(record);f.finish(record);
  }
  assert.equal(f.played.length,18);assert.deepEqual(f.replyHistory(),bags);assert.deepEqual(f.controller.getHistory(),history);
  f.controller.dispose();
});

test('manual, simulation, stop, quit and dispose clear an annoyed queue and late ended cannot revive it',async()=>{
  for(const action of ['interaction-audition','daily-audition','simulate','stop','quit','dispose']) {
    const f=fixture();await f.controller.interact('head-pat');await f.advance(300);const old=f.played[0];f.started(old);
    await f.controller.interact('poke-annoyed');assert.equal(f.controller.getState().queuedInteraction.kind,'poke-annoyed');
    if(action==='interaction-audition')await f.controller.playVoice('P01');
    if(action==='daily-audition')await f.controller.playVoice('01-1');
    if(action==='simulate')await f.controller.simulateVoice('01');
    if(action==='stop')f.controller.stopVoice();
    if(action==='quit')f.controller.requestQuit();
    if(action==='dispose')f.controller.dispose();
    assert.equal(f.controller.getState().queuedInteraction,null,action);
    f.finish(old);f.started(old);await f.advance(7200);
    assert.equal(f.played.filter(record=>/^A/.test(record.line.id)).length,0,action);
    assert.equal(f.replyHistory()['poke-annoyed'].remaining.length,0);f.controller.dispose();
  }
});

test('lock, suspend, fullscreen, DND and volume zero cancel queued and active interaction audio',async()=>{
  for(const reason of ['locked','suspended','fullscreen','dnd','muted']) {
    const f=fixture();await f.controller.interact('head-pat');await f.advance(300);const old=f.played[0];f.started(old);
    await f.controller.interact('poke-annoyed');
    if(reason==='dnd')f.controller.setSettings({dnd:true});
    else if(reason==='muted')f.controller.setSettings({volume:0});
    else f.block(reason);
    assert.equal(f.controller.getState().queuedInteraction,null,reason);
    assert.equal(f.controller.getState().playback.status,'idle',reason);
    f.finish(old);f.started(old);await f.advance(7200);
    assert.equal(f.played.length,1,reason);f.controller.dispose();
  }
});

test('turning off only daily automatic greetings leaves explicit interaction audio and its one-slot queue intact',async()=>{
  const f=fixture();await f.controller.interact('head-pat');await f.advance(300);f.started();
  await f.controller.interact('poke-annoyed');f.controller.setSettings({enabled:false});
  assert.equal(f.controller.getState().playback.status,'playing');
  assert.equal(f.controller.getState().queuedInteraction.kind,'poke-annoyed');
  f.finish();await f.advance(1200);assert.equal(f.played.length,2);assert.match(f.played[1].line.id,/^A/);
  assert.equal(f.played[1].textOnly,undefined);f.controller.dispose();
});

test('DND, mute, fullscreen, monitor-unready and unavailable audio use silent captions without overlapping speech',async()=>{
  for(const mode of ['dnd','muted','fullscreen','monitor-unready','unavailable']) {
    const f=fixture({interactionAvailable:mode!=='unavailable'});
    if(mode==='dnd')f.controller.setSettings({dnd:true});
    if(mode==='muted')f.controller.setSettings({volume:0});
    if(mode==='fullscreen')f.environment.fullscreen=true;
    if(mode==='monitor-unready')f.environment.monitorReady=false;
    assert.equal(await f.controller.interact('head-pat'),true,mode);
    assert.equal(f.played.length,1);assert.equal(f.played[0].textOnly,true);assert.equal(f.controller.getState().queuedInteraction,null);
    f.started();assert.equal(await f.controller.interact('poke'),false,'The 250 ms caption throttle remains in force');
    assert.equal(await f.controller.interact('poke-annoyed'),true,'An annoyed caption can replace gentle text immediately');
    assert.equal(f.played[1].textOnly,true);
    await f.controller.playVoice('01-1');const count=f.played.length;
    assert.equal(await f.controller.interact('head-pat'),false,'Fallback text cannot interrupt manual audio');
    assert.equal(f.played.length,count);f.controller.dispose();
  }
});

test('interaction audio completion suppresses immediate farewell, while completed silent text does not',async()=>{
  const audible=fixture();await audible.controller.interact('head-pat');await audible.advance(300);audible.started();audible.finish();
  audible.controller.requestQuit();await audible.flush();assert.equal(audible.quitCount,1);assert.equal(audible.played.length,1);audible.controller.dispose();
  const text=fixture({interactionAvailable:false});await text.controller.interact('head-pat');text.started();text.finish();
  text.controller.requestQuit();await text.flush();assert.equal(text.quitCount,0);assert.equal(text.played[1].kind,'farewell');text.controller.dispose();
});

test('an interaction error clears its queued follow-up and does not consume an unstarted line',async()=>{
  const f=fixture();await f.controller.interact('head-pat');await f.advance(300);const old=f.played[0];
  await f.controller.interact('poke-annoyed');f.finish(old,'error','decoder failed');
  assert.equal(f.controller.getState().queuedInteraction,null);assert.equal(f.replyHistory()['head-pat'].remaining.length,6);
  f.started(old);f.finish(old);await f.advance(7200);
  assert.equal(f.played.length,1);assert.equal(f.replyHistory()['poke-annoyed'].remaining.length,0);f.controller.dispose();
});

test('late interaction promises and callbacks cannot clear manual playback or resurrect a cancelled annoyed queue',async()=>{
  const f=fixture({delayed:true});await f.controller.interact('head-pat');await f.advance(300);const old=f.played[0];
  await f.controller.interact('poke-annoyed');const audition=f.controller.playVoice('P01'),manual=f.played[1];
  assert.equal(f.controller.getState().queuedInteraction,null);
  old.reject(new Error('late load failure'));f.started(old);f.finish(old,'error','late decoder error');await f.flush();
  assert.equal(f.controller.getState().playback.lineId,'P01');assert.equal(f.controller.getState().playback.status,'loading');
  manual.resolve({ok:true});await audition;f.started(manual);await f.advance(7200);
  assert.equal(f.played.length,2);assert.equal(f.controller.getState().playback.status,'playing');
  assert.equal(f.replyHistory()['head-pat'].remaining.length,6);assert.equal(f.replyHistory()['poke-annoyed'].remaining.length,0);
  f.controller.dispose();
});

test('cancelled or replaced debounce callbacks stay inert even if a stale native timer invokes them directly',async()=>{
  for(const action of ['manual','simulate','stop','dispose','locked','suspended','fullscreen']) {
    const f=fixture();await f.controller.interact('head-pat');
    const stale=[...f.timeouts.values()].find(entry=>entry.delay===300).fn;
    if(action==='manual')await f.controller.playVoice('H01');
    if(action==='simulate')await f.controller.simulateVoice('01');
    if(action==='stop')f.controller.stopVoice();
    if(action==='dispose')f.controller.dispose();
    if(['locked','suspended','fullscreen'].includes(action))f.block(action);
    const count=f.played.length;await f.advance(300);stale();await f.flush();
    assert.equal(f.played.length,count,action);assert.equal(f.controller.getState().queuedInteraction,null);
    assert.equal(f.replyHistory()['head-pat'].remaining.length,0);f.controller.dispose();
  }
  const replaced=fixture();await replaced.controller.interact('head-pat');
  const stale=[...replaced.timeouts.values()].find(entry=>entry.delay===300).fn;
  await replaced.advance(100);await replaced.controller.interact('poke');await replaced.advance(200);
  stale();await replaced.flush();assert.equal(replaced.played.length,0);
  assert.equal(replaced.controller.getState().queuedInteraction.kind,'poke');
  await replaced.advance(100);assert.equal(replaced.played.length,1);assert.match(replaced.played[0].line.id,/^P/);
  replaced.controller.dispose();
});

test('the post-speech gap can expire an annoyed request even when the preceding line ended before its deadline',async()=>{
  const f=fixture();await f.controller.interact('head-pat');await f.advance(300);f.started();
  await f.controller.interact('poke-annoyed');await f.advance(5000);f.finish();
  assert.equal(f.controller.getState().queuedInteraction.kind,'poke-annoyed');
  await f.advance(1200);assert.equal(f.played.length,1);assert.equal(f.controller.getState().queuedInteraction,null);
  assert.equal(f.replyHistory()['poke-annoyed'].remaining.length,0);f.controller.dispose();
});

test('the interaction preference rejects every physical response without consuming lines or blocking daily greetings',async()=>{
  for(const interactionAvailable of [true,false]) {
    const f=fixture({interactionAvailable}),before=f.replyHistory();
    f.preferences.interactionsEnabled=false;f.controller.preferencesChanged();
    for(const kind of ['head-pat','poke','poke-annoyed'])assert.equal(await f.controller.interact(kind),false);
    assert.equal(f.played.length,0);assert.equal(f.controller.getState().queuedInteraction,null);assert.deepEqual(f.replyHistory(),before);
    await f.tick(5000);assert.equal(f.played.length,1);assert.equal(f.played[0].kind,'automatic');
    f.controller.dispose();
  }
});

test('disabling interactions clears debounce and old timers cannot revive it after re-enabling',async()=>{
  const f=fixture();await f.controller.interact('head-pat');
  const stale=[...f.timeouts.values()].find(entry=>entry.delay===300).fn;
  f.preferences.interactionsEnabled=false;f.controller.preferencesChanged();
  assert.equal(f.controller.getState().queuedInteraction,null);
  f.preferences.interactionsEnabled=true;f.controller.preferencesChanged();
  await f.advance(300);stale();await f.flush();assert.equal(f.played.length,0);
  assert.equal(f.replyHistory()['head-pat'].remaining.length,0);
  assert.equal(await f.controller.interact('poke'),true);await f.advance(300);
  assert.equal(f.played.length,1);assert.match(f.played[0].line.id,/^P/);f.controller.dispose();
});

test('the queued timer rechecks the preference even before the settings-change hook is delivered',async()=>{
  const f=fixture();await f.controller.interact('head-pat');
  f.preferences.interactionsEnabled=false;await f.advance(300);
  assert.equal(f.played.length,0);assert.equal(f.controller.getState().queuedInteraction,null);
  assert.equal(f.replyHistory()['head-pat'].remaining.length,0);f.controller.dispose();
});

test('disabling interactions stops its current audio and cancels an annoyed follow-up',async()=>{
  const f=fixture();await f.controller.interact('head-pat');await f.advance(300);const old=f.played[0];f.started(old);
  await f.controller.interact('poke-annoyed');const stops=f.stopped.length;
  f.preferences.interactionsEnabled=false;f.controller.preferencesChanged();
  assert.equal(f.stopped.length,stops+1);assert.equal(f.controller.getState().playback.status,'idle');
  assert.equal(f.controller.getState().queuedInteraction,null);
  f.started(old);f.finish(old);await f.advance(7200);
  assert.equal(f.played.length,1);assert.equal(f.replyHistory()['poke-annoyed'].remaining.length,0);
  f.preferences.interactionsEnabled=true;f.controller.preferencesChanged();
  assert.equal(await f.controller.interact('head-pat'),true);await f.advance(300);
  assert.equal(f.played.length,2);f.controller.dispose();
});

test('disabling interactions also hides silent text and a fresh enable does not retain its text throttle',async()=>{
  const f=fixture({available:false});await f.controller.interact('head-pat');f.started();
  assert.equal(f.played[0].textOnly,true);
  f.preferences.interactionsEnabled=false;f.controller.preferencesChanged();
  assert.equal(f.controller.getState().playback.status,'idle');
  assert.equal(await f.controller.interact('poke-annoyed'),false);
  f.preferences.interactionsEnabled=true;f.controller.preferencesChanged();
  assert.equal(await f.controller.interact('poke'),true);
  assert.equal(f.played.length,2);assert.equal(f.played[1].textOnly,true);f.controller.dispose();
});

test('manual interaction auditions, daily audio, simulations and farewell are not stopped by the interaction switch',async()=>{
  for(const mode of ['daily-audition','interaction-audition','automatic','simulation','farewell']) {
    const f=fixture();
    if(mode==='daily-audition')await f.controller.playVoice('01-1');
    if(mode==='interaction-audition')await f.controller.playVoice('H01');
    if(mode==='automatic')await f.tick(5000);
    if(mode==='simulation')await f.controller.simulateVoice('01');
    if(mode==='farewell'){f.controller.requestQuit();await f.flush();}
    f.started();const stops=f.stopped.length,lineId=f.controller.getState().playback.lineId,settings=f.controller.getState().settings;
    f.preferences.interactionsEnabled=false;f.controller.preferencesChanged();
    assert.equal(f.stopped.length,stops,mode);assert.equal(f.controller.getState().playback.status,'playing',mode);
    assert.equal(f.controller.getState().playback.lineId,lineId);assert.deepEqual(f.controller.getState().settings,settings);
    f.controller.dispose();
  }
});

test('turning interactions off while audio loads rejects its late started callback and promise result',async()=>{
  const f=fixture({delayed:true});await f.controller.interact('head-pat');await f.advance(300);const old=f.played[0];
  f.preferences.interactionsEnabled=false;f.controller.preferencesChanged();
  f.started(old);old.reject(new Error('obsolete load failed'));await f.flush();
  assert.equal(f.controller.getState().playback.status,'idle');assert.equal(f.replyHistory()['head-pat'].remaining.length,6);
  assert.equal(f.controller.getState().queuedInteraction,null);f.controller.dispose();
});

test('disabling interactions hides its trailing subtitle after the audio has already ended',async()=>{
  const f=fixture();await f.controller.interact('head-pat');await f.advance(300);f.started();f.finish();
  assert.equal(f.controller.getState().playback.kind,'interaction');assert.equal(f.controller.getState().playback.status,'idle');
  const stops=f.stopped.length;f.preferences.interactionsEnabled=false;f.controller.preferencesChanged();
  assert.equal(f.stopped.length,stops+1,'The host also clears the text retained briefly after natural audio completion');
  assert.equal(f.controller.getState().queuedInteraction,null);f.controller.dispose();
});

test('external speech blocks daily greetings without changing preferences or spending a voice quota, then releases the slot', async()=>{
  const f=fixture();
  const original={...f.controller.getState().settings};
  assert.equal(f.controller.getState().externalSpeechBusy,false);
  f.controller.setExternalSpeechBusy(true);
  assert.equal(f.controller.getState().externalSpeechBusy,true);
  await f.tick(5000);await f.tick(5000);
  assert.equal(f.played.length,0);assert.equal(playedToday(f),0);
  assert.deepEqual({...f.controller.getState().settings},original);
  assert.deepEqual(f.persisted().settings,original);
  assert.equal(Object.hasOwn(f.persisted(),'externalSpeechBusy'),false);
  assert.equal(Object.hasOwn(f.persisted().settings,'externalSpeechBusy'),false);
  for(const value of [null,undefined,1,'false',{}])f.controller.setExternalSpeechBusy(value);
  assert.equal(f.controller.getState().externalSpeechBusy,true);
  f.controller.setExternalSpeechBusy(false);await f.tick(1000);
  assert.equal(f.played.length,1);assert.equal(f.played[0].kind,'automatic');
  f.started();assert.equal(playedToday(f),1);f.controller.dispose();
});

test('external speech stops an active interaction and drops the annoyed queue, while clicks retain immediate silent captions', async()=>{
  const f=fixture();
  await f.controller.interact('head-pat');await f.advance(300);const spoken=f.played[0];f.started(spoken);
  await f.controller.interact('poke-annoyed');assert.equal(f.controller.getState().queuedInteraction.kind,'poke-annoyed');
  f.controller.setExternalSpeechBusy(true);
  assert.equal(f.stopped.at(-1),'external-speech');
  assert.equal(f.controller.getState().playback.status,'idle');assert.equal(f.controller.getState().queuedInteraction,null);
  await f.advance(250);
  assert.equal(await f.controller.interact('poke'),true,'A text response need not wait for the interrupted audio gap');
  const caption=f.played.at(-1);assert.equal(caption.textOnly,true);f.started(caption);
  assert.equal(await f.controller.interact('poke-annoyed'),true);assert.equal(f.played.at(-1).textOnly,true);
  const count=f.played.length,stops=f.stopped.length;
  f.controller.setExternalSpeechBusy(true);
  assert.equal(f.stopped.length,stops,'Repeated busy broadcasts must not clear a visible caption');
  f.finish(spoken);f.started(spoken);await f.advance(7200);
  assert.equal(f.played.length,count);assert.equal(f.controller.getState().queuedInteraction,null);
  assert.equal(f.played.filter(record=>!record.textOnly).length,1);
  f.finish();f.controller.setExternalSpeechBusy(false);
  assert.equal(await f.controller.interact('head-pat'),true);await f.advance(300);
  assert.equal(f.played.at(-1).textOnly,undefined);assert.equal(f.played.at(-1).kind,'interaction');
  f.controller.dispose();
});

test('external speech cancels queued timers and late loading callbacks cannot restore audio or consume history', async()=>{
  const queued=fixture();await queued.controller.interact('head-pat');
  const stale=[...queued.timeouts.values()].find(entry=>entry.delay===300).fn;
  queued.controller.setExternalSpeechBusy(true);await queued.advance(300);stale();await queued.flush();
  assert.equal(queued.played.length,0);assert.equal(queued.controller.getState().queuedInteraction,null);
  queued.controller.setExternalSpeechBusy(false);stale();await queued.flush();
  assert.equal(queued.played.length,0,'Releasing the external slot cannot resurrect an obsolete request');queued.controller.dispose();
  const loading=fixture({delayed:true});await loading.tick(5000);const old=loading.played[0];
  loading.controller.setExternalSpeechBusy(true);
  loading.started(old);old.reject(new Error('obsolete load'));loading.finish(old);await loading.flush();
  assert.equal(loading.controller.getState().playback.status,'idle');assert.equal(playedToday(loading),0);
  await loading.tick(10000);assert.equal(loading.played.length,1);
  loading.controller.setExternalSpeechBusy(false);await loading.tick(1000);
  assert.equal(loading.played.length,2);loading.played[1].resolve({ok:true});await loading.flush();loading.controller.dispose();
});

test('developer audition and simulation cannot bypass the external audio slot', async()=>{
  const f=fixture();f.controller.setExternalSpeechBusy(true);
  await f.controller.playVoice('01-1');await f.controller.playVoice('H01');await f.controller.simulateVoice('01');
  assert.equal(f.played.length,0);
  f.controller.setExternalSpeechBusy(false);await f.controller.playVoice('01-1');
  assert.equal(f.played.length,1);assert.equal(f.played[0].kind,'manual');f.controller.dispose();
});
