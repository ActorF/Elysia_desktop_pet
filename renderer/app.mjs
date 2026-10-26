/** Desktop IPC, tray-selected appearance, native dragging and right-button wheel zoom. */
import { EXPRESSIONS, POSES, createPetState, applyAction, actionForKey, advance } from './state.mjs';
import { loadCharacter, drawCharacter, composeCharacterFrame, RIG } from './faithful-character.mjs';
import { createPointerTracking } from './pointer-tracking.mjs';
import { createCharacterHitRegion, prepareCharacterHitRegions, withKeyCloudRegion } from './hit-region.mjs';
import { characterView, canvasBacking } from './viewport.mjs';
import { createKeyDisplay, drawKeyCloud, KEY_EFFECT_BOUNDS } from './key-cloud.mjs';
import { sourceAtPointer, partAtSource } from './body-regions.mjs';
import { createInteractions, createExpressionReaction } from './interactions.mjs';

const desktop = window.elysiaDesktop;
const state = createPetState();
const pointerTracking = createPointerTracking(state, RIG);
const canvas = document.querySelector('#pet');
const ctx = canvas.getContext('2d');
let settings = { eyeTracking:true, eyeWarpStrength:1, hairMotion:true, motionAmplitude:1, motionSpeed:1, alwaysOnTop:true, clickThrough:false, legacyHotkeys:true, keyDisplay:true, interactionsEnabled:true, scale:1, cat:false, glasses:false };
let hotkeys = {}, viewport = null;
let dragging = null, rightPointer = null;
let characterAtlas = null, dragRenderPaused = false, redrawRequested = true, shapeScheduled = false;
let spaceHeld = false, restoringAppearance = Boolean(desktop);
let settingsEpoch = 0, viewportEpoch = 0, settingsWrite = 0;
let zoomSteps = 0, zoomAnchor = null, zoomScheduled = false, zoomBusy = false;
let updateCanvas = () => {};
const pendingActions = [];
const keyDisplay=createKeyDisplay();
let keyCloudVisible=false;
const expressionReaction = createExpressionReaction(state, { onChange: syncAppearance, now: () => performance.now() });
const interactions = createInteractions({ now: () => performance.now(), onReaction(reaction) {
  if (restoringAppearance || settings.clickThrough || settings.interactionsEnabled === false) return;
  expressionReaction.react(reaction.expression, reaction.duration);
  void Promise.resolve(desktop?.interact?.(reaction.type)).catch(console.error);
} });
let pickSource = null, pickSourceKey = null;
function partAtPointer(x, y) {
  if (!characterAtlas) return null;
  const point = sourceAtPointer(x,y,innerWidth,innerHeight,viewport,RIG,state,settings,characterAtlas.mesh.accelerated);
  if (!point) return null;
  const key = JSON.stringify([state.pose,state.expression,state.cat,state.glasses]);
  if (key !== pickSourceKey) { pickSource = composeCharacterFrame(characterAtlas.images,state,false); pickSourceKey = key; }
  const sx = Math.floor(point.x), sy = Math.floor(point.y);
  // Native shapes cover the complete motion envelope. Check source alpha too,
  // so a transparent gap, decoration or key cloud is never treated as a body part.
  if (sx < 0 || sy < 0 || sx >= RIG.width || sy >= RIG.height
    || pickSource.getContext('2d').getImageData(sx,sy,1,1).data[3] < 32) return null;
  return partAtSource(point.x,point.y,state.pose);
}
function interactionPoint(event, pick = false) {
  const view = characterView(innerWidth, innerHeight, viewport);
  const blocked = restoringAppearance || settings.clickThrough || settings.interactionsEnabled === false || spaceHeld || rightPointer !== null;
  // Mesh inversion runs once at press, never for every pointermove/animation frame.
  const part = pick && !blocked ? partAtPointer(event.clientX,event.clientY) : undefined;
  return { x: (event.clientX - view.x) / view.scale, y: (event.clientY - view.y) / view.scale,
    screenX: event.screenX, screenY: event.screenY, button: event.button, buttons: event.buttons,
    pointerId: event.pointerId, now: performance.now(), blocked: blocked || (pick && part === null),
    ...(pick ? {part} : {}) };
}

function receiveTypedKey(character){
  if(settings.keyDisplay===false||!keyDisplay.receive(character,performance.now()))return;
  redrawRequested=true;
  if(!keyCloudVisible){keyCloudVisible=true;scheduleHitRegion();}
}

function pauseDragRendering(active) { dragRenderPaused = Boolean(active); if (!dragRenderPaused) redrawRequested = true; }
function publishHitRegion() {
  if (!desktop?.setHitRegion || !characterAtlas) return Promise.resolve(false);
  const shape = withKeyCloudRegion(createCharacterHitRegion(characterAtlas, state, settings),keyCloudVisible,state.pose);
  // The host projects these cached logical rectangles into the visible window.
  return Promise.resolve(desktop.setHitRegion({width:shape.width, height:shape.height,
    originX:shape.originX, referenceWidth:shape.referenceWidth, rects:shape.rects, space:'character'}));
}
function scheduleHitRegion() {
  if (shapeScheduled || !desktop?.setHitRegion) return;
  shapeScheduled = true;
  requestAnimationFrame(() => { shapeScheduled = false; void publishHitRegion().catch(console.error); });
}
function syncAppearance() {
  redrawRequested = true; scheduleHitRegion();
  desktop?.setAppearance({expression:state.expression, pose:state.pose, cat:state.cat, glasses:state.glasses});
}
function receiveViewport(next) {
  if (!next) return;
  const before = characterView(innerWidth, innerHeight, viewport);
  const wasClipped = viewport?.clipped;
  viewport = {...next}; viewportEpoch++;
  const after = characterView(innerWidth, innerHeight, viewport);
  if (before.x !== after.x || before.y !== after.y || before.scale !== after.scale) interactions.cancel();
  // Ordinary native dragging moves the existing bitmap without repainting it.
  if (before.x !== after.x || before.y !== after.y || before.scale !== after.scale || wasClipped !== viewport.clipped) redrawRequested = true;
  updateCanvas();
}
function receiveSettings(snapshot, includeViewport = true) {
  if (snapshot?.settings) { settings = {...snapshot.settings}; settingsEpoch++; }
  if(settings.keyDisplay===false){keyDisplay.clear();keyCloudVisible=false;}
  if(settings.interactionsEnabled===false){interactions.reset();expressionReaction.cancel({restore:true});}
  else if(settings.clickThrough){interactions.cancel();expressionReaction.cancel({restore:true});}
  hotkeys = snapshot?.hotkeys ?? hotkeys;
  if (includeViewport && snapshot?.viewport) receiveViewport(snapshot.viewport);
  redrawRequested = true; scheduleHitRegion();
}
async function updateSettings(patch) {
  const write = ++settingsWrite, epoch = settingsEpoch, viewEpoch = viewportEpoch;
  try {
    if (desktop) {
      const result = await desktop.setSettings(patch);
      // IPC broadcasts are authoritative; a late invoke reply cannot undo them.
      if (write === settingsWrite && epoch === settingsEpoch) receiveSettings(result, viewEpoch === viewportEpoch);
    } else receiveSettings({settings:{...settings, ...patch}});
  } catch (error) { console.error('Could not save preferences:', error); }
}
function act(action) {
  if (!action || !['expression','pose','toggle-skin','reset'].includes(action.type)) return;
  if (restoringAppearance) { pendingActions.push(action); return; }
  interactions.cancel(); expressionReaction.cancel({restore:true});
  applyAction(state, action); syncAppearance();
  if (action.type === 'toggle-skin' || action.type === 'reset') void updateSettings({cat:state.cat, glasses:state.glasses});
}

function queueZoom() {
  if (zoomScheduled || zoomBusy || !zoomSteps) return;
  zoomScheduled = true;
  requestAnimationFrame(async () => {
    zoomScheduled = false;
    if (!zoomSteps) return;
    const steps = zoomSteps, anchor = zoomAnchor;
    zoomSteps = 0; zoomBusy = true;
    const epoch = settingsEpoch, viewEpoch = viewportEpoch;
    try {
      if (desktop?.zoomBy) {
        const snapshot = await desktop.zoomBy({steps, anchorX:anchor.x, anchorY:anchor.y});
        if (epoch === settingsEpoch) receiveSettings(snapshot, viewEpoch === viewportEpoch);
      } else if (!desktop) {
        const nextScale = Math.max(.01, settings.scale * Math.pow(1.1, steps));
        if (Number.isFinite(nextScale * 800)) {
          const old = characterView(innerWidth, innerHeight, viewport), ratio = nextScale / settings.scale;
          receiveSettings({settings:{...settings,scale:nextScale},viewport:{width:innerWidth,height:innerHeight,
            characterX:anchor.x-(anchor.x-old.x)*ratio,characterY:anchor.y-(anchor.y-old.y)*ratio,
            characterWidth:600*old.scale*ratio,characterHeight:800*old.scale*ratio,scale:nextScale,clipped:true}});
        }
      }
    } catch (error) { console.error('Could not resize pet:', error); }
    finally { zoomBusy = false; queueZoom(); }
  });
}
function samplePointer(event) {
  pointerTracking.sample({...event,viewport});
  // Native dragging can keep local coordinates stationary. Track screen travel
  // during a press so a drag away and back never becomes a poke on release.
  if (dragging && Number.isFinite(event.x) && Number.isFinite(event.y)) {
    interactions.sample({x:-1,y:-1,screenX:event.x,screenY:event.y,buttons:1,now:performance.now(),blocked:settings.clickThrough||settings.interactionsEnabled===false});
  }
}
canvas.addEventListener('pointermove', event => {
  const samples = event.getCoalescedEvents?.();
  const latest = samples?.length ? samples[samples.length-1] : event;
  samplePointer({localX:latest.clientX,localY:latest.clientY,width:innerWidth,height:innerHeight,sampledAt:performance.timeOrigin+latest.timeStamp});
  interactions.sample(interactionPoint(latest));
});
canvas.addEventListener('pointerleave', () => { if (!dragging) interactions.sample({x:-1,y:-1,buttons:0,now:performance.now()}); });
canvas.addEventListener('pointerdown', event => {
  if (event.button === 2) { interactions.cancel(); rightPointer = event.pointerId; canvas.setPointerCapture(event.pointerId); return; }
  if (event.button !== 0) return;
  interactions.pointerDown(interactionPoint(event,true));
  dragging = {pointerId:event.pointerId}; pauseDragRendering(true);
  canvas.setPointerCapture(event.pointerId); desktop?.dragStart();
});
function endDrag() {
  if (dragging) desktop?.dragEnd();
  dragging = null; pauseDragRendering(false);
}
canvas.addEventListener('pointerup', event => {
  if (event.button === 2) rightPointer = null;
  if (event.button === 0) { interactions.pointerUp(interactionPoint(event)); endDrag(); }
  if (!dragging && rightPointer === null && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener('pointercancel', () => { interactions.cancel(); rightPointer = null; zoomSteps = 0; endDrag(); });
canvas.addEventListener('lostpointercapture', () => { rightPointer = null; if (dragging) {interactions.cancel();endDrag();} });
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => {
  if (rightPointer === null || !Number.isFinite(event.deltaY) || !event.deltaY) return;
  interactions.cancel();
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
  zoomSteps -= event.deltaY * unit / 100;
  zoomAnchor = {x:event.clientX,y:event.clientY}; queueZoom();
}, {passive:false});
document.addEventListener('keydown', event => {
  // The native listener owns desktop input. Browsers/non-Windows retain a local preview fallback.
  if(!hotkeys.typing?.active&&!event.ctrlKey&&!event.altKey&&!event.metaKey)receiveTypedKey(event.key);
  if (event.code === 'Space') { event.preventDefault(); spaceHeld = true; return; }
  const chord = spaceHeld ? actionForKey(event.code) : null;
  if (chord) event.preventDefault();
  if (desktop && settings.legacyHotkeys && hotkeys.legacy?.active) return;
  if (chord && !event.repeat) act(chord);
});
document.addEventListener('keyup', event => { if (event.code === 'Space') {event.preventDefault();spaceHeld=false;} });
window.addEventListener('blur', () => {interactions.cancel();spaceHeld=false;rightPointer=null;zoomSteps=0;endDrag();});

if (desktop) {
  desktop.onPointer(samplePointer);
  desktop.onDragState?.(active => pauseDragRendering(active));
  desktop.onAction(act);
  desktop.onViewport?.(receiveViewport);
  desktop.onSettings(receiveSettings);
  desktop.onTypedKey?.(receiveTypedKey);
  const epoch = settingsEpoch, viewEpoch = viewportEpoch;
  const snapshot = await desktop.getState();
  if (epoch === settingsEpoch) receiveSettings(snapshot, viewEpoch === viewportEpoch);
  state.cat = settings.cat === true; state.glasses = settings.glasses === true;
  restoringAppearance = false;
  for (const action of pendingActions.splice(0)) act(action);
}
syncAppearance();

try {
  const atlas = await loadCharacter(state);
  await prepareCharacterHitRegions(atlas, settings); characterAtlas = atlas;
  document.querySelector('#loading').hidden = true;
  let transformKey = '', clearCanvasBeforePaint = false;
  updateCanvas = () => {
    const backing = canvasBacking(innerWidth, innerHeight, devicePixelRatio);
    const resized = canvas.width !== backing.width || canvas.height !== backing.height;
    if (resized) {
      canvas.width = backing.width; canvas.height = backing.height; redrawRequested = true;
    }
    const view = characterView(innerWidth, innerHeight, viewport);
    const sx = canvas.width / innerWidth, sy = canvas.height / innerHeight;
    const key = [view.x,view.y,view.scale,sx,sy].join(',');
    if (key !== transformKey) {
      ctx.setTransform(sx*view.scale,0,0,sy*view.scale,sx*view.x,sy*view.y);
      transformKey = key; redrawRequested = true;
      // Windows retains a minimum native window even for a 1% pet. A smaller
      // character must erase the old footprint when that window does not resize.
      if (!resized) clearCanvasBeforePaint = true;
    }
  };
  window.addEventListener('resize', () => { updateCanvas(); scheduleHitRegion(); }); updateCanvas();
  let clippedSource = null;
  function paintCharacter(display) {
    const view = characterView(innerWidth, innerHeight, viewport);
    const rx = canvas.width / innerWidth, ry = canvas.height / innerHeight;
    if (!viewport?.clipped) {
      if(clearCanvasBeforePaint){ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);}
      clearCanvasBeforePaint=false;
      ctx.setTransform(rx*view.scale,0,0,ry*view.scale,rx*view.x,ry*view.y);
      ctx.clearRect(-KEY_EFFECT_BOUNDS.left,0,KEY_EFFECT_BOUNDS.left,800);
      drawCharacter(ctx,atlas,state,settings);drawKeyCloud(ctx,display,{pose:state.pose});return;
    }
    // Keep all drawing coordinates small even at extreme zoom. Rasterize the
    // existing rig at a fixed resolution, then sample only its visible portion.
    // Huge Canvas transforms lose precision and can silently produce no pixels.
    if (!clippedSource) {
      clippedSource = document.createElement('canvas');
      clippedSource.width = KEY_EFFECT_BOUNDS.width*2; clippedSource.height = 1600;
      clippedSource.getContext('2d').scale(2,2);
      clippedSource.getContext('2d').translate(KEY_EFFECT_BOUNDS.left,0);
    }
    clippedSource.getContext('2d').clearRect(-KEY_EFFECT_BOUNDS.left,0,KEY_EFFECT_BOUNDS.left,800);
    drawCharacter(clippedSource.getContext('2d'),atlas,state,settings);
    drawKeyCloud(clippedSource.getContext('2d'),display,{pose:state.pose});
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
    clearCanvasBeforePaint=false;
    const x=Math.max(0,view.x-KEY_EFFECT_BOUNDS.left*view.scale),y=Math.max(0,view.y);
    const width=Math.min(innerWidth,view.x+600*view.scale)-x,height=Math.min(innerHeight,view.y+800*view.scale)-y;
    if (width<=0 || height<=0) return;
    const sx=((x-view.x)/view.scale+KEY_EFFECT_BOUNDS.left)*2,sy=(y-view.y)/view.scale*2;
    // Below a subpixel footprint the whole visible image is effectively one
    // sample. A small positive footprint avoids GPU float rounding to zero.
    const sw=Math.min(clippedSource.width-sx,Math.max(1/64,width/view.scale*2));
    const sh=Math.min(1600-sy,Math.max(1/64,height/view.scale*2));
    if(sw>0&&sh>0)ctx.drawImage(clippedSource,sx,sy,sw,sh,x*rx,y*ry,width*rx,height*ry);
  }
  let previous = performance.now();
  function frame(now) {
    const elapsed = (now-previous)/1000; previous = now;
    expressionReaction.tick(now);
    const display=settings.keyDisplay===false?null:keyDisplay.snapshot(now);
    if(keyCloudVisible!==Boolean(display)){keyCloudVisible=Boolean(display);redrawRequested=true;scheduleHitRegion();}
    if (!dragRenderPaused || redrawRequested) {
      advance(state,dragRenderPaused?0:elapsed,settings);
      paintCharacter(display); redrawRequested = false;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  await publishHitRegion();
  window.elysiaPreview = {
    rendering:{mode:atlas.renderer.mode,eyeTracking:atlas.renderer.eyeTrackingAvailable},
    snapshot:() => JSON.parse(JSON.stringify(state)),
    settings:() => ({...settings}),
    viewport:() => viewport ? {...viewport} : null,
    partAt:(x,y)=>partAtPointer(x,y),
    keyDisplay:()=>keyDisplay.snapshot(performance.now()),
    render:(expressionOrOptions,megaphone=false,time=0,resolutionScale=1) => {
      const options = expressionOrOptions && typeof expressionOrOptions==='object' ? expressionOrOptions : {expression:expressionOrOptions,pose:megaphone?'megaphone':'idle',time};
      const preview = createPetState();
      if (EXPRESSIONS.some(item=>item.id===options.expression)) preview.expression=options.expression;
      if (POSES.some(item=>item.id===options.pose)) preview.pose=options.pose;
      preview.cat=options.cat===true;preview.glasses=options.glasses===true;
      preview.blink=Number.isFinite(options.blink)?Math.min(1,Math.max(0,options.blink)):0;
      preview.time=Number.isFinite(options.time)?options.time:0;
      const factor=Math.min(3,Math.max(1,Number(options.resolutionScale??resolutionScale)||1));
      const effectLeft=typeof options.key==='string'&&preview.pose==='megaphone'?KEY_EFFECT_BOUNDS.left:0;
      const target=document.createElement('canvas');target.width=(600+effectLeft)*factor;target.height=800*factor;
      const previewContext=target.getContext('2d');previewContext.scale(factor,factor);
      previewContext.translate(effectLeft,0);
      drawCharacter(previewContext,atlas,preview,settings);
      if(typeof options.key==='string')drawKeyCloud(previewContext,{character:options.key,age:options.keyAge??0},{pose:preview.pose});
      return target.toDataURL();
    },
  };
  document.documentElement.dataset.ready='true';
} catch (error) {
  document.querySelector('#loading').textContent=`人物素材加载失败：${error.message}。请完整保留 assets 文件夹。`;
}
