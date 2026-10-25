'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { loadVoiceAssets, loadInteractionAssets } = require('../electron/voice-assets.cjs');
const catalog = require('../renderer/interaction-catalog.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Small inert byte fixtures exercise hashing and allowlists; no audio synthesis
// or access to the user's confirmed recordings is involved.
function fixture(t) {
  const temporaryDirectory = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'elysia-voice-assets-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved),temporaryDirectory);
    assert.ok(path.basename(resolved).startsWith('elysia-voice-assets-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  const directory = path.join(root,'assets','interaction-voice');
  fs.mkdirSync(path.join(root,'renderer'),{recursive:true});
  fs.mkdirSync(path.join(directory,'audio-final'),{recursive:true});
  fs.writeFileSync(path.join(root,'renderer','interaction-catalog.json'),JSON.stringify(catalog));
  const map = {status:'confirmed',confirmedBy:'user',confirmedCount:18,lines:catalog.map(line => {
    const bytes = Buffer.from(`inert interaction fixture ${line.id}`);
    fs.writeFileSync(path.join(directory,'audio-final',`${line.id}.wav`),bytes);
    return {...line,currentPath:`audio-final/${line.id}.wav`,currentSha256:hash(bytes),originalSha256:hash(bytes)};
  })};
  const save = value => fs.writeFileSync(path.join(directory,'final-audio-map.json'),JSON.stringify(value??map));
  save();
  return {root,directory,map,save,load:()=>loadInteractionAssets(root,directory)};
}
function unavailable(result) {
  assert.equal(result.available,false);
  assert.match(result.error,/互动语音素材暂不可用/);
  assert.equal(result.lines.size,0);assert.equal(result.allowedUrls.size,0);
}

test('confirmed interaction pack loads exactly eighteen fixed IDs from its own default directory',t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.directory,'audio-final','unrelated.wav'),'not in the manifest');
  const result=loadInteractionAssets(f.root);
  assert.equal(result.available,true);assert.equal(result.error,null);
  assert.equal(result.lines.size,18);assert.equal(result.allowedUrls.size,18);
  for(const line of catalog) {
    const audioUrl=pathToFileURL(path.join(f.directory,'audio-final',`${line.id}.wav`)).href;
    assert.deepEqual(result.lines.get(line.id),{...line,audioUrl});
    assert.equal(result.allowedUrls.has(audioUrl),true);
  }
  assert.equal([...result.allowedUrls].some(url=>url.includes('unrelated')),false);
  f.map.lines.reverse();f.save();assert.equal(f.load().available,true,'Manifest order does not change the fixed ID set');
});

test('interaction assets require explicit user approval and a complete array with count eighteen',t=>{
  const f=fixture(t);
  for(const patch of [{status:'pending'},{status:'draft'},{status:null},{confirmedBy:'assistant'},
    {confirmedBy:null},{confirmedCount:17},{confirmedCount:'18'},{lines:f.map.lines.slice(0,17)},
    {lines:{length:18}},{lines:[...f.map.lines,f.map.lines[0]]}]) {
    f.save({...f.map,...patch});unavailable(f.load());
  }
  f.save(null);assert.equal(f.load().available,true);
});

test('duplicate IDs, out-of-range IDs, wrong text and wrong categories fail without partial access',t=>{
  const f=fixture(t);
  for(const mutate of [
    lines=>{lines[17]={...lines[0]};},
    lines=>{lines[17].id='A07';lines[17].currentPath='audio-final/A07.wav';},
    lines=>{lines[17].id='a06';lines[17].currentPath='audio-final/a06.wav';},
    lines=>{lines[17].text+='未经确认的改词';},
    lines=>{lines[17].groupId='head-pat';},
    lines=>{lines[17]=null;},
  ]) {
    const next=structuredClone(f.map);mutate(next.lines);f.save(next);unavailable(f.load());
  }
});

test('only the exact approved relative filename is accepted, excluding escapes and alternate paths',t=>{
  const f=fixture(t);
  for(const currentPath of ['../H01.wav','audio-final/../H01.wav','audio-final/H02.wav',
    'audio-final\\H01.wav','audio-final/h01.wav','https://example.com/H01.wav',path.join(f.directory,'audio-final','H01.wav')]) {
    const next=structuredClone(f.map);next.lines[0].currentPath=currentPath;f.save(next);unavailable(f.load());
  }
});

test('missing, changed or unconfirmed bytes never expose a partial recording set',t=>{
  const f=fixture(t),file=path.join(f.directory,'audio-final','A06.wav'),bytes=fs.readFileSync(file);
  fs.unlinkSync(file);unavailable(f.load());
  fs.writeFileSync(file,Buffer.concat([bytes,Buffer.from(' changed')]));unavailable(f.load());
  fs.writeFileSync(file,bytes);
  for(const patch of [{currentSha256:'0'.repeat(64),originalSha256:'0'.repeat(64)},
    {currentSha256:'bad hash'},{originalSha256:'0'.repeat(64)},{originalSha256:null}]) {
    const next=structuredClone(f.map);Object.assign(next.lines[17],patch);f.save(next);unavailable(f.load());
  }
  f.save();assert.equal(f.load().available,true);
});

test('missing or malformed approval files and catalog metadata fail closed',t=>{
  const f=fixture(t),mapFile=path.join(f.directory,'final-audio-map.json');
  fs.unlinkSync(mapFile);unavailable(f.load());
  fs.writeFileSync(mapFile,'{unfinished');unavailable(f.load());
  fs.writeFileSync(mapFile,'null');unavailable(f.load());f.save();
  const catalogFile=path.join(f.root,'renderer','interaction-catalog.json');
  for(const next of [null,{},catalog.slice(0,17),[...catalog.slice(0,17),catalog[0]],
    catalog.map((line,index)=>index?line:{...line,groupId:'poke'})]) {
    fs.writeFileSync(catalogFile,JSON.stringify(next));unavailable(f.load());
  }
  fs.unlinkSync(catalogFile);unavailable(f.load());
});

test('the original daily loader remains independent of missing or invalid interaction recordings',t=>{
  const f=fixture(t),dailyDirectory=path.join(f.root,'assets','voice');
  fs.mkdirSync(path.join(dailyDirectory,'audio-final'),{recursive:true});
  const groups=Array.from({length:12},(_,groupIndex)=>({id:String(groupIndex+1).padStart(2,'0'),lines:
    Array.from({length:3},(_,lineIndex)=>({id:`${String(groupIndex+1).padStart(2,'0')}-${lineIndex+1}`,text:`每日问候 ${groupIndex+1} ${lineIndex+1}`}))}));
  fs.writeFileSync(path.join(f.root,'renderer','voice-catalog.json'),JSON.stringify({groups}));
  const map={confirmedCount:36,lines:groups.flatMap(group=>group.lines.map(line=>{
    const bytes=Buffer.from(`inert daily fixture ${line.id}`);
    fs.writeFileSync(path.join(dailyDirectory,'audio-final',`${line.id}.wav`),bytes);
    return {...line,groupId:group.id,currentPath:`audio-final/${line.id}.wav`,currentSha256:hash(bytes)};
  }))};
  fs.writeFileSync(path.join(dailyDirectory,'final-audio-map.json'),JSON.stringify(map));
  assert.equal(loadVoiceAssets(f.root).available,true,'Legacy daily manifests do not acquire interaction approval requirements');
  f.save({...f.map,status:'pending'});unavailable(f.load());
  assert.equal(loadVoiceAssets(f.root).lines.size,36);
  f.save();fs.unlinkSync(path.join(dailyDirectory,'audio-final','01-1.wav'));
  assert.equal(loadVoiceAssets(f.root).available,false);assert.equal(f.load().available,true);
});
