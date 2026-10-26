/** Independent face, action and skin composition; continuous motion runs after composition. */
import { createMeshRig } from './mesh-rig.mjs';
import { motionAmplitude, motionTime } from './motion-settings.mjs';
import { harmonizePoseOutfit } from './outfit-palette.mjs';
import { ellipse, path } from './drawing-primitives.mjs';
const INK = '#4a203d', W = 1090, H = 1443;
const EYES = [
  {x:413,y:555,rx:49,ry:64,angle:-.19,outer:-1},
  {x:647,y:520,rx:57,ry:67,angle:-.12,outer:1},
];
const REPAINTED = new Set(['angry','sleep','dizzy','surprise','cry']);
const NO_BLINK = new Set([...REPAINTED,'wink','smile','awkward']);
export const RIG = Object.freeze({width:W,height:H,x:38,y:68,scale:.48,gazeX:292,gazeY:326});
const makeCanvas=()=>{const c=document.createElement('canvas');c.width=W;c.height=H;return c;};
function cheek(ctx,x,y,strength=.25) {
  const fill=ctx.createRadialGradient(x,y,0,x,y,37);
  fill.addColorStop(0,`rgba(231,125,156,${strength})`);fill.addColorStop(1,'rgba(231,125,156,0)');
  ellipse(ctx,x,y,37,18,fill);
}
function glasses(ctx) {
  for(const eye of EYES) {
    ctx.save();ctx.translate(eye.x,eye.y);ctx.rotate(eye.angle);
    ellipse(ctx,0,0,eye.rx+21,eye.ry+16,'#f7dcff0b','#80576f',4);
    path(ctx,[['moveTo',eye.outer*(eye.rx+20),-15],['lineTo',eye.outer*(eye.rx+43),-30]],'#80576f',4);ctx.restore();
  }
  path(ctx,[['moveTo',484,543],['quadraticCurveTo',527,516,570,520]],'#80576f',4);
}
function awkwardFace(ctx) {
  for(const eye of EYES) {
    ctx.save();ctx.translate(eye.x,eye.y);ctx.rotate(eye.angle);
    path(ctx,[['moveTo',-43,-8],['lineTo',42,-10],['lineTo',34,24],['lineTo',-34,25],['closePath']],INK,6,'#fffbf4');
    path(ctx,[['moveTo',-41,-86-eye.outer*16],['quadraticCurveTo',0,-98,43,-86+eye.outer*16]],'#ae6f91',3);ctx.restore();
  }
  ctx.save();ctx.translate(536,636);ctx.rotate(-.15);
  path(ctx,[['moveTo',-18,-8],['lineTo',20,-8],['lineTo',18,16],['lineTo',-17,16],['closePath']],'#9c5e75',3.5,'#fff7ef');ctx.restore();
  path(ctx,[['moveTo',744,474],['bezierCurveTo',731,494,721,514,736,519],['bezierCurveTo',754,523,754,503,744,474]],'#91b5d4',2,'#c3e4f4');
}
function facePatch(ctx,image,includeMouth=true,side='both',pose='idle',preserveMouth=false) {
  // Expressions share the exact neutral body. Import the complete expression face
  // so brows, lid creases and eye corners stay coherent with its artwork.
  // The lower notch preserves the active mouth during an automatic blink.
  const patch=document.createElement('canvas');patch.width=W;patch.height=H;
  const mask=document.createElement('canvas');mask.width=W;mask.height=H;
  const mc=mask.getContext('2d');mc.shadowColor='#fff';mc.shadowBlur=12;
  const lowerFace=includeMouth
    ? [['quadraticCurveTo',716,641,623,664],['quadraticCurveTo',513,702,380,654],['quadraticCurveTo',330,644,307,619]]
    : [['quadraticCurveTo',716,633,623,600],['quadraticCurveTo',551,574,484,600],['quadraticCurveTo',400,663,307,619]];
  // Cross the plain pink area above the fine fringe strands, never their
  // dark starting points (which otherwise acquire a clipped join).
  path(mc,[['moveTo',304,300],['quadraticCurveTo',541,245,779,280],['lineTo',790,588],...lowerFace,['closePath']],null,0,'#fff');
  if(side==='right')mc.clearRect(0,0,530,H);
  if(pose==='megaphone') {
    // The megaphone overlaps the left cheek. Keep its foreground silhouette
    // while replacing both of the old angular eyes with the shared artwork.
    mc.shadowBlur=0;mc.globalCompositeOperation='destination-out';
    path(mc,[['moveTo',0,450],['lineTo',149,470],['lineTo',320,572],['lineTo',369,606],['quadraticCurveTo',398,614,400,670],['lineTo',420,820],['lineTo',0,820],['closePath']],null,0,'#fff');
    // This pose's open shouting mouth sits higher than the neutral smile.
    if(preserveMouth)mc.clearRect(480,578,120,107);
  }
  // A drinking mouth stays attached to its short straw, and the cake bite/fork
  // stays in front of the face for every expression.
  mc.shadowBlur=0;mc.globalCompositeOperation='destination-out';
  if(pose==='tea')path(mc,[['moveTo',509,610],['lineTo',548,603],['lineTo',579,637],['lineTo',629,636],['lineTo',686,717],['lineTo',624,826],['lineTo',526,797],['closePath']],null,0,'#fff');
  if(pose==='cake')path(mc,[['moveTo',566,629],['quadraticCurveTo',592,617,610,640],['lineTo',620,654],['lineTo',701,694],['lineTo',702,738],['lineTo',553,700],['lineTo',547,659],['closePath']],null,0,'#fff');
  const pc=patch.getContext('2d');pc.drawImage(image,0,0,W,H);
  pc.globalCompositeOperation='destination-in';pc.drawImage(mask,0,0);
  ctx.drawImage(patch,0,0);
}
function heartDetails(ctx,image) {
  // Keep the neutral artwork as the base. Only the two small pupil interiors
  // and the mouth receive painted pixels; the original eyelids, lashes, iris
  // edges, highlights and surrounding face remain exactly the same.
  const patch=document.createElement('canvas');patch.width=W;patch.height=H;
  const mask=document.createElement('canvas');mask.width=W;mask.height=H;
  const mc=mask.getContext('2d');
  for(const [x,y,rx,ry] of [[414,565,29,30],[648,526,30,30],[537,634,49,38]]) {
    mc.save();mc.translate(x,y);mc.scale(rx,ry);
    const fill=mc.createRadialGradient(0,0,.84,0,0,1);
    fill.addColorStop(0,'#fff');fill.addColorStop(1,'#ffffff00');
    mc.fillStyle=fill;mc.beginPath();mc.arc(0,0,1,0,Math.PI*2);mc.fill();mc.restore();
  }
  const pc=patch.getContext('2d');pc.drawImage(image,0,0,W,H);
  pc.globalCompositeOperation='destination-in';pc.drawImage(mask,0,0);
  ctx.drawImage(patch,0,0);
}

function catSkin(ctx,image) {
  // Replace the old tuft, including the transparent opening inside its curl.
  // Painting source-over alone leaves the neutral curl visible through it.
  // End inside the shared opaque curl base, before the two source images'
  // outer hair contours separate; clearing farther down creates a hard step.
  ctx.clearRect(875,105,90,110);
  // Only the two ears/crown belong in front of the selected action.
  const skin=makeCanvas(), sc=skin.getContext('2d');
  sc.drawImage(image,0,0,W,H);
  sc.globalCompositeOperation='destination-in';
  const mask=makeCanvas(),mc=mask.getContext('2d');
  const fade=mc.createLinearGradient(0,276,0,322);
  fade.addColorStop(0,'#fff');fade.addColorStop(1,'#ffffff00');
  mc.fillStyle=fade;mc.fillRect(0,0,W,322);
  sc.drawImage(mask,0,0);ctx.drawImage(skin,0,0);
  // Keep the full tail outline inside a loose crop instead of tracing through
  // its fur with a tight mask. The active cloak and rear hair cover its root;
  // source clothing cannot paint over the selected action's foreground.
  ctx.save();ctx.globalCompositeOperation='destination-over';
  ctx.beginPath();
  ctx.moveTo(790,1010);ctx.lineTo(845,1010);ctx.lineTo(920,1065);
  ctx.lineTo(960,1065);ctx.lineTo(960,970);ctx.lineTo(1090,970);
  ctx.lineTo(1090,1230);ctx.lineTo(870,1230);ctx.lineTo(805,1170);
  ctx.lineTo(790,1120);ctx.closePath();ctx.clip();
  ctx.drawImage(image,0,0,W,H);
  ctx.restore();
}

/** Source composition is shared by the runtime, screenshots and pixel audits. */
export function composeCharacterFrame(images,state,blink=false) {
  const {expression=null,pose='idle',cat=false,glasses:wearGlasses=false}=state;
  const canvas=makeCanvas(),ctx=canvas.getContext('2d');
  const base=pose==='idle'?images.neutral:images[pose];
  ctx.drawImage(base,0,0,W,H);
  // Keep each action's contact mouth by default. An explicitly selected face
  // replaces its expression, while the props remain protected foreground art.
  if(expression) {
    const face=pose==='idle'?canvas:makeCanvas(),fc=face.getContext('2d');
    if(pose!=='idle')fc.drawImage(images.neutral,0,0,W,H);
    if(REPAINTED.has(expression))facePatch(fc,images[expression]);
    else if(expression==='wink'||expression==='smile')facePatch(fc,images.closed,expression==='smile',expression==='wink'?'right':'both');
    else if(expression==='heart')heartDetails(fc,images.heart);
    else if(expression==='awkward'){facePatch(fc,images.clean);awkwardFace(fc);}
    else if(expression==='blush'){cheek(fc,398,643,.46);cheek(fc,659,614,.46);}
    if(pose!=='idle')facePatch(ctx,face,pose!=='tea','both',pose);
  } else if(pose==='megaphone')facePatch(ctx,images.closed,false,'both',pose,true);
  if(blink)facePatch(ctx,images.closed,false,'both',pose,pose==='megaphone');
  if(cat)catSkin(ctx,images.cat);
  if(wearGlasses) {
    const layer=makeCanvas();glasses(layer.getContext('2d'));
    facePatch(ctx,layer,true,'both',pose);
  }
  return canvas;
}

/** Loads common artwork once; action clothes are colour matched before use. */
export async function loadCharacter() {
  const sources={
    neutral:'character/character-neutral',clean:'character/character-face-clean',
    tea:'character/character-tea',cake:'character/character-cake',cat:'character/character-cat',megaphone:'character/character-megaphone',
    closed:'character/character-closed',cry:'character/character-cry',heart:'character/character-heart',surprise:'character/character-surprise',
    sleep:'character/character-sleep',angry:'character/character-angry',dizzy:'character/character-dizzy',
    sleepDecoration:'character/sleep-decoration',dizzyDecoration:'character/dizzy-decoration',
  };
  const images={};
  await Promise.all(Object.entries(sources).map(async([key,name])=>{
    const image=new Image();image.src=new URL(`../assets/${name}.png`,import.meta.url).href;
    await image.decode();images[key]=image;
  }));
  const normalize=image=>{const c=makeCanvas();c.getContext('2d').drawImage(image,0,0,W,H);return c;};
  const neutral=normalize(images.neutral);
  for(const id of ['tea','cake','cat','megaphone'])images[id]=harmonizePoseOutfit(normalize(images[id]),neutral);
  const mesh=createMeshRig();
  return {images,mesh,renderer:mesh,cache:new Map(),normal:mesh,megaphone:mesh};
}

/** Every face/action/skin combination has its own bounded cached composition. */
export function drawCharacter(ctx,rigs,state,settings={}) {
  const pose=state.pose??'idle',expression=state.expression??null;
  const blink=state.blink>.72&&!NO_BLINK.has(expression)&&!(pose==='megaphone'&&!expression);
  const key=JSON.stringify([pose,expression,!!state.cat,!!state.glasses,blink]);
  let source=rigs.cache.get(key);
  if(!source){
    source=composeCharacterFrame(rigs.images,state,blink);rigs.cache.set(key,source);
    if(rigs.cache.size>12)rigs.cache.delete(rigs.cache.keys().next().value);
  }
  const gaze=!blink&&!NO_BLINK.has(expression)&&!(pose==='megaphone'&&!expression);
  const frame=rigs.mesh.draw(source,key,state,settings,gaze);
  ctx.clearRect(0,0,600,800);
  ctx.save();ctx.translate(RIG.x,RIG.y);ctx.scale(RIG.scale,RIG.scale);
  ctx.drawImage(frame,0,0,W,H);ctx.restore();
  drawCharacterDecorations(ctx,rigs.images,state,settings);
}

/** Screen-plane artwork is shared by painting and on-demand click exclusion. */
export function drawCharacterDecorations(ctx,images,state,settings={}) {
  const expression=state.expression??null;
  // Decorations live in their own screen plane, outside the character rig.
  const drift=Math.sin(motionTime(state,settings)*.8)*2*motionAmplitude(settings);
  if(expression==='sleep') {
    ctx.drawImage(images.sleepDecoration,427,8+drift,170,170);
    ctx.save();ctx.lineJoin='round';ctx.strokeStyle='#fff4f8';ctx.fillStyle='#663650';ctx.lineWidth=4;
    for(const [x,y,size] of [[78,145,30],[91,165,23],[103,181,17]]) {
      ctx.font=`italic bold ${size}px Georgia`;ctx.strokeText('z',x,y+drift);ctx.fillText('z',x,y+drift);
    }
    ctx.restore();
  } else if(expression==='dizzy')ctx.drawImage(images.dizzyDecoration,57,6+drift,486,162);
}
