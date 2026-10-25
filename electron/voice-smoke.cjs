'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { INTERACTION_CATALOG } = require('./interaction-replies.cjs');

async function checkVoiceRuntime({ voices, voiceTestHooks, settingsWindow, pet, screen, placePet, root }) {
  const output = path.join(root, 'artifacts', 'validation-v1.3.0');
  // Packaged ASAR is read-only; reports belong alongside the launch workspace.
  const reportDir = root.includes('app.asar') ? path.join(process.cwd(), 'artifacts', 'validation-v1.3.0-packaged') : output;
  await fs.mkdir(reportDir, { recursive: true });
  const errors = [], checks = [];
  const capture = async window => {
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise(resolve => setTimeout(resolve, 150));
    return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
  };
  const poll = async (label, read, accept, ms = 10000) => {
    const deadline = Date.now() + ms;
    let value;
    do {
      value = await read(); if (accept(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify(value)}`);
  };
  const initial = voices.getState();
  assert.equal(initial.available, true, initial.error);
  assert.equal(initial.interactionAvailable, true, initial.interactionError);
  const history = voices.getHistory();
  const panel = await settingsWindow.open();
  panel.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  await poll('voice settings ready', () => panel.webContents.executeJavaScript('document.documentElement.dataset.voiceReady'), value => value === 'true');
  assert.equal(await panel.webContents.executeJavaScript('document.querySelectorAll("[data-voice-play], [data-voice-simulate]").length'), 0);
  assert.equal(await panel.webContents.executeJavaScript('typeof window.elysiaSettings.playVoice'), 'undefined');
  assert.equal(await panel.webContents.executeJavaScript('typeof window.elysiaSettings.simulateVoice'), 'undefined');
  assert.equal(typeof voices.playVoice, 'undefined'); assert.equal(typeof voices.simulateVoice, 'undefined');
  const catalog = voiceTestHooks.getCatalog();
  const request = (method, value) => {
    if (method === 'playVoice' || method === 'simulateVoice') return voiceTestHooks[method](value);
    return panel.webContents.executeJavaScript(`window.elysiaSettings.${method}(${JSON.stringify(value)})`);
  };
  checks.push('Production settings and controller expose no audition or simulation entry points; developer checks use injected main-process hooks');
  await request('setVoiceSettings', { dnd: true, volume: .35, birthday: '02-29' });
  assert.equal(voices.getState().settings.birthday, '02-29');
  await request('setVoiceSettings', { birthday: '02-30' });
  assert.equal(voices.getState().settings.birthday, '02-29');
  const lines = [...catalog.daily.groups.flatMap(group => group.lines), ...catalog.interaction];
  const byLength = [...lines].sort((a, b) => a.text.length - b.text.length);
  const layouts = [];
  let audioProbeInstalled = false;
  for (const line of lines) {
    await request('playVoice', line.id);
    await poll(`playing ${line.id}`, () => voices.getState().playback, value => value.status === 'playing' && value.lineId === line.id);
    const window = voices.getSpeechWindow();
    if (!audioProbeInstalled) {
      await window.webContents.executeJavaScript(`(() => {
        const NativeAudio=window.Audio, active=new Set();
        window.__voiceAudioProbe={maxConcurrent:0,started:0};
        window.Audio=function(...args) {
          const audio=new NativeAudio(...args), pause=audio.pause.bind(audio);
          audio.pause=()=>{active.delete(audio);pause();};
          audio.addEventListener('playing',()=>{if(audio.paused)return;active.add(audio);window.__voiceAudioProbe.started++;window.__voiceAudioProbe.maxConcurrent=Math.max(window.__voiceAudioProbe.maxConcurrent,active.size);});
          for(const event of ['ended','pause','error','emptied'])audio.addEventListener(event,()=>active.delete(audio));
          return audio;
        };
      })()`);
      audioProbeInstalled = true;
    }
    assert.equal(window.isVisible(), false, 'QA stays hidden');
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#line").textContent'), line.text);
    const layout = await window.webContents.executeJavaScript(`(() => {
      const line=document.querySelector('#line'), text=line.getBoundingClientRect(), card=document.querySelector('#speech').getBoundingClientRect();
      const style=getComputedStyle(line);
      return {bottom:text.bottom,cardBottom:card.bottom,background:getComputedStyle(document.querySelector('#speech')).backgroundColor,
        lineCount:Math.round(text.height/parseFloat(style.lineHeight)),textHeight:text.height,lineHeight:parseFloat(style.lineHeight),
        width:innerWidth,height:innerHeight,textWidth:line.clientWidth,scrollWidth:line.scrollWidth,textClientHeight:line.clientHeight,textScrollHeight:line.scrollHeight,
        hasControls:!!document.querySelector('#speech header, #speech button, #speech .name')};
    })()`);
    assert.ok(layout.bottom <= layout.cardBottom - 4, `Text fits: ${line.id}`);
    assert.ok(layout.textHeight <= layout.lineHeight * 2 + 1, `At most two full lines: ${line.id}`);
    assert.ok(layout.scrollWidth <= layout.textWidth, `No horizontal clipping: ${line.id}`);
    assert.ok(layout.textScrollHeight <= layout.textClientHeight, `Complete text without vertical truncation: ${line.id}`);
    assert.equal(layout.hasControls, false, 'Bubble contains no title, music decoration or close control');
    assert.equal(layout.background, 'rgb(255, 255, 255)');
    layouts.push({ id: line.id, ...layout });
    if (line.id === byLength[0].id || line.id === byLength.at(-1).id) {
      await fs.writeFile(path.join(reportDir, line.id === byLength[0].id ? 'speech-short.png' : 'speech-long.png'), await capture(window));
    }
    await request('stopVoice');
  }
  assert.ok(new Set(layouts.map(value => value.width)).size > 1, 'Bubble width adapts to the spoken line');
  assert.ok(new Set(layouts.map(value => value.height)).size > 1, 'Bubble height adapts to one or two lines');
  checks.push('All 54 confirmed recordings (36 daily + 18 interactions) decode and play with adaptive one/two-line captions');
  for (const group of catalog.daily.groups) {
    await request('simulateVoice', group.id);
    await poll(`simulation ${group.id}`, () => voices.getState().playback, value => value.status === 'playing' && value.lineId.startsWith(group.id + '-') && value.kind === 'simulation');
    await request('stopVoice');
  }
  assert.deepEqual(voices.getHistory(), history);
  checks.push('12 real-rule simulations, manual DND bypass, no automatic quota/history changes');
  await new Promise(resolve => setTimeout(resolve, 1250));
  const interact = kind => pet.webContents.executeJavaScript(`window.elysiaDesktop.interact(${JSON.stringify(kind)})`);
  const interactionLayouts = new Map();
  async function verifyInteraction(kind) {
    const state = await poll(`${kind} caption`, () => voices.getState().playback,
      value => value.kind === 'interaction' && value.status === 'playing');
    const line = INTERACTION_CATALOG.find(line => line.id === state.lineId);
    assert.ok(line, `Interaction line comes from the catalog: ${state.lineId}`);
    assert.equal(line.groupId, kind);
    const window = voices.getSpeechWindow();
    const layout = await window.webContents.executeJavaScript(`(() => {
      const line=document.querySelector('#line'), rect=line.getBoundingClientRect(), style=getComputedStyle(line);
      const card=document.querySelector('#speech').getBoundingClientRect();
      return {text:line.textContent,fontSize:parseFloat(style.fontSize),lineHeight:parseFloat(style.lineHeight),textHeight:rect.height,
        bottom:rect.bottom,cardBottom:card.bottom,textWidth:line.clientWidth,scrollWidth:line.scrollWidth,
        textClientHeight:line.clientHeight,textScrollHeight:line.scrollHeight,
        hasControls:!!document.querySelector('#speech header, #speech button, #speech .name')};
    })()`);
    assert.equal(layout.text,line.text);
    assert.equal(layout.fontSize,16,`Normal monitor keeps readable 16px text: ${line.id}`);
    assert.ok(layout.textHeight<=layout.lineHeight*2+1,`At most two full interaction lines: ${line.id}`);
    assert.ok(layout.bottom<=layout.cardBottom-4,`Interaction fits its bubble: ${line.id}`);
    assert.ok(layout.scrollWidth<=layout.textWidth && layout.textScrollHeight<=layout.textClientHeight,`No interaction truncation: ${line.id}`);
    assert.equal(layout.hasControls,false);
    interactionLayouts.set(line.id,{id:line.id,...layout});
    return line;
  }
  assert.equal(await interact('head-pat'), true);
  await verifyInteraction('head-pat');
  await fs.writeFile(path.join(reportDir, 'interaction-head-pat.png'), await capture(voices.getSpeechWindow()));
  assert.equal(await interact('poke-annoyed'), true);
  await verifyInteraction('poke-annoyed');
  await fs.writeFile(path.join(reportDir, 'interaction-annoyed.png'), await capture(voices.getSpeechWindow()));
  await poll('silent caption auto-hide', () => voices.getState().playback.status, value => value === 'idle', 5000);
  assert.equal(voices.getSpeechWindow().isVisible(), false);
  for (const kind of ['head-pat','poke','poke-annoyed']) {
    for (let index=0;index<6;index++) {
      await new Promise(resolve=>setTimeout(resolve,260));
      assert.equal(await interact(kind),true);
      await verifyInteraction(kind);
    }
  }
  assert.equal(interactionLayouts.size,18,'All eighteen interaction lines appear through independent six-line bags');
  await request('stopVoice');
  assert.deepEqual(voices.getHistory(), history);
  assert.equal(await interact('arbitrary-text'), false);
  checks.push('18 silent interaction captions fit at 16px in at most two complete lines; independent six-line rotation, escalation and expiry preserve voice history');
  await request('setVoiceSettings', { dnd: false, volume: .35 });
  const interactionPlaying = kind => poll(`audible ${kind}`, () => voices.getState(), value =>
    value.playback.kind === 'interaction' && value.playback.status === 'playing' && value.playback.textOnly === false
    && INTERACTION_CATALOG.find(line => line.id === value.playback.lineId)?.groupId === kind);
  const probeBefore = await voices.getSpeechWindow().webContents.executeJavaScript('window.__voiceAudioProbe.started');
  assert.equal(await interact('head-pat'), true);
  assert.equal(await interact('poke'), true);
  assert.equal(await interact('poke-annoyed'), true);
  assert.equal(await interact('head-pat'), false, 'An angry debounce cannot be overwritten by later gentle clicks');
  await interactionPlaying('poke-annoyed');
  assert.equal(await voices.getSpeechWindow().webContents.executeJavaScript('window.__voiceAudioProbe.started'), probeBefore + 1,
    'The rapid click burst creates exactly one audible reply');
  for (const kind of ['head-pat', 'poke', 'poke-annoyed']) assert.equal(await interact(kind), false);
  await request('stopVoice');
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.equal(await interact('head-pat'), true);
  await interactionPlaying('head-pat');
  assert.equal(await interact('poke'), false, 'No ordinary backlog during speech');
  assert.equal(await interact('poke-annoyed'), true);
  const queued = voices.getState().queuedInteraction;
  assert.equal(await interact('poke-annoyed'), false);
  assert.deepEqual(voices.getState().queuedInteraction, queued, 'Repeated anger never extends the one-slot queue');
  await poll('first interaction ended before queued response', () => voices.getState(), value =>
    value.playback.status === 'idle' && value.queuedInteraction?.kind === 'poke-annoyed');
  const firstEndedAt = Date.now();
  await interactionPlaying('poke-annoyed');
  assert.ok(Date.now() - firstEndedAt >= 1100, 'The next response leaves a 1.2 second speech gap');
  assert.equal(voices.getState().queuedInteraction, null);
  await request('stopVoice');
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.equal(await interact('head-pat'), true);
  await request('stopVoice');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(voices.getState().queuedInteraction, null);
  assert.equal(voices.getState().playback.status, 'idle', 'Stop cancels a not-yet-spoken response');
  assert.equal(await interact('head-pat'), true);
  await request('playVoice', 'H01');
  await poll('manual interaction overrides debounce', () => voices.getState().playback, value => value.kind === 'manual' && value.lineId === 'H01' && value.status === 'playing');
  assert.equal(voices.getState().queuedInteraction, null);
  assert.equal(await interact('poke-annoyed'), false, 'Audition has exclusive speech ownership');
  await request('stopVoice');
  assert.deepEqual(voices.getHistory(), history);
  checks.push('Real interaction audio: debounce coalesces clicks, ordinary clicks never queue, one angry response waits for the sentence and speech gap; stop and manual audition cancel waiting replies');
  const area = screen.getPrimaryDisplay().workArea;
  for (const side of ['left', 'right']) {
    placePet({ x: side === 'left' ? area.x + area.width - 440 : area.x + 10, y: area.y + 180 });
    await request('playVoice', '01-1');
    await poll('placement play', () => voices.getState().playback.status, value => value === 'playing');
    const bubble = voices.getSpeechWindow();
    assert.equal(await bubble.webContents.executeJavaScript('document.querySelector("#speech").dataset.side'), side);
    const bounds = bubble.getBounds();
    assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
    assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
    await fs.writeFile(path.join(reportDir, `speech-${side}.png`), await capture(bubble));
    await fs.writeFile(path.join(reportDir, `pet-${side}.png`), await capture(pet));
    await request('stopVoice');
  }
  checks.push('Native left/right placement remains on current display; own-window screenshots captured');
  await panel.webContents.executeJavaScript('document.querySelector("[data-tab=voice]").click()');
  await fs.writeFile(path.join(reportDir, 'voice-settings-native.png'), await capture(panel));
  await request('playVoice', '12-3');
  await poll('farewell audition playing', () => voices.getState().playback.status, value => value === 'playing');
  assert.equal(await interact('head-pat'), false, 'A physical interaction never replaces an existing spoken line');
  await poll('natural audio completion', () => voices.getState().playback.status, value => value === 'idle', 20000);
  assert.equal(pet.isDestroyed(), false, 'Farewell audition must never quit');
  checks.push('Natural ended event clears playback; auditioning farewell leaves pet running');
  await request('playVoice', '01-1');
  await request('playVoice', '03-2');
  await request('playVoice', '06-3');
  await poll('latest line wins', () => voices.getState().playback, value => value.lineId === '06-3' && value.status === 'playing');
  await request('stopVoice');
  assert.equal(voices.getState().playback.status, 'idle');
  checks.push('Rapid replacement, stop, persisted settings and hidden independent windows');
  const audioProbe = await voices.getSpeechWindow().webContents.executeJavaScript('window.__voiceAudioProbe');
  assert.equal(audioProbe.maxConcurrent, 1, 'No overlapping real Audio elements across auditions, simulations and interactions');
  checks.push('Instrumented native Audio playback never has more than one active voice');
  await request('setVoiceSettings', initial.settings);
  assert.deepEqual(errors, []);
  const report = { passed: true, checks, recordings: lines.length, audioProbe, layouts, interactionLayouts:[...interactionLayouts.values()], screenshots: reportDir, errors };
  await fs.writeFile(path.join(reportDir, 'voice-native-report.json'), JSON.stringify(report, null, 2));
  return { passed: report.passed, checks, recordings: lines.length, screenshots: reportDir, errors };
}
module.exports = { checkVoiceRuntime };
