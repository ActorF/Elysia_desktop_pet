/** Cached native-window silhouette. No live-frame reads or moving-window work. */
import {RIG,composeCharacterFrame} from './faithful-character.mjs';
import {EXPRESSIONS} from './state.mjs';
import {meshAlphaToOccupancy} from './mesh-envelope.mjs';
import {drawKeyCloud,KEY_EFFECT_BOUNDS} from './key-cloud.mjs';
import {motionAmplitude} from './motion-settings.mjs';

const WIDTH=600,HEIGHT=800,CELL_SIZE=4;
const regions=new WeakMap();
const cloudRegions=new Map();
const effectBaseRegions=new WeakMap();

/** Cache the curved cloud and sound-wave envelope; animation never rebuilds the native window. */
export function withKeyCloudRegion(region,visible,pose='idle'){
 let base=effectBaseRegions.get(region);
 if(!base){
  base={...region,width:KEY_EFFECT_BOUNDS.width,originX:-KEY_EFFECT_BOUNDS.left,referenceWidth:WIDTH,
    rects:region.rects.map(rect=>({...rect,x:rect.x+KEY_EFFECT_BOUNDS.left}))};
  effectBaseRegions.set(region,base);
 }
 if(!visible)return base;
 const mode=pose==='megaphone'?'megaphone':'idle';
 let cloudRectangles=cloudRegions.get(mode);
 if(!cloudRectangles){
  const canvas=document.createElement('canvas');canvas.width=KEY_EFFECT_BOUNDS.width;canvas.height=HEIGHT;
  const ctx=canvas.getContext('2d');ctx.translate(KEY_EFFECT_BOUNDS.left,0);
  // At most 1.9 logical pixels between samples; the alpha padding fills subpixel gaps.
  for(let step=0;step<=(mode==='megaphone'?80:0);step++){
   drawKeyCloud(ctx,{character:'a',age:step/80,opacity:1},{silhouette:true,pose:mode});
  }
  cloudRectangles=rectanglesFromOccupancy(alphaToOccupancy(ctx.getImageData(0,0,canvas.width,HEIGHT).data,canvas.width,HEIGHT,{cellSize:2,padding:1}));
  cloudRegions.set(mode,cloudRectangles);
 }
 return {...base,rects:[...base.rects,...cloudRectangles]};
}

/** Quantize alpha conservatively, retaining holes and the empty window margins. */
export function alphaToOccupancy(rgba,width,height,{cellSize=2,threshold=4,padding=1}={}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||
    !Number.isInteger(cellSize)||cellSize<1||!Number.isInteger(padding)||padding<0||
    !Number.isFinite(threshold)||threshold<1||threshold>255||rgba.length!==width*height*4)
  throw new RangeError('Invalid alpha mask dimensions or options');
 const columns=Math.ceil(width/cellSize),rows=Math.ceil(height/cellSize),cells=new Uint8Array(columns*rows);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  if(rgba[(y*width+x)*4+3]<threshold)continue;
  const x0=Math.max(0,Math.floor((x-padding)/cellSize)),x1=Math.min(columns-1,Math.floor((x+padding)/cellSize));
  const y0=Math.max(0,Math.floor((y-padding)/cellSize)),y1=Math.min(rows-1,Math.floor((y+padding)/cellSize));
  for(let row=y0;row<=y1;row++)for(let column=x0;column<=x1;column++)cells[row*columns+column]=1;
 }
 return {cells,columns,rows,width,height,cellSize};
}

function runsToRectangles(mask,transpose){
 const {cells,columns,rows,width,height,cellSize}=mask;
 const across=transpose?rows:columns,down=transpose?columns:rows,finished=[];
 let active=new Map();
 for(let row=0;row<down;row++){
  const next=new Map();
  for(let x=0;x<across;){
   if(!cells[transpose?x*columns+row:row*columns+x]){x++;continue;}
   const start=x;
   while(x<across&&cells[transpose?x*columns+row:row*columns+x])x++;
   const key=`${start}:${x}`,previous=active.get(key),rect=previous??{x:start,y:row,width:x-start,height:0};
   rect.height++;next.set(key,rect);active.delete(key);
  }
  finished.push(...active.values());active=next;
 }
 finished.push(...active.values());
 return finished.map(rect=>{
  const x=(transpose?rect.y:rect.x)*cellSize,y=(transpose?rect.x:rect.y)*cellSize;
  return {x,y,width:Math.min((transpose?rect.height:rect.width)*cellSize,width-x),height:Math.min((transpose?rect.width:rect.height)*cellSize,height-y)};
 });
}

/** Merge identical runs in both directions; choose the smaller exact cover. */
export function rectanglesFromOccupancy(mask){
 const horizontal=runsToRectangles(mask,false),vertical=runsToRectangles(mask,true);
 return vertical.length<horizontal.length?vertical:horizontal;
}

function sourceAlpha(atlas,pose,cat){
 const canvas=document.createElement('canvas');canvas.width=RIG.width;canvas.height=RIG.height;
 const ctx=canvas.getContext('2d');
 for(const expression of [null,...EXPRESSIONS.map(item=>item.id)]){
  // The original composition only adds source-over pixels. Including a blink
  // and glasses therefore also covers their off states, without repainting or
  // changing the runtime's frame cache.
  const source=composeCharacterFrame(atlas.images,{pose,cat,expression,glasses:true},true);
  ctx.drawImage(source,0,0);source.width=0;source.height=0;
 }
 const rgba=ctx.getImageData(0,0,RIG.width,RIG.height).data;
 const alpha=new Uint8Array(RIG.width*RIG.height);
 for(let i=0;i<alpha.length;i++)alpha[i]=rgba[i*4+3];
 canvas.width=0;canvas.height=0;
 return alpha;
}

function drawDecorations(ctx,images,decoration,amplitude){
 if(!decoration)return;
 const steps=Math.ceil(4*amplitude);
 for(let step=0;step<=steps;step++){
  const drift=steps?2*amplitude*(2*step/steps-1):0;
  if(decoration==='dizzy'){ctx.drawImage(images.dizzyDecoration,57,6+drift,486,162);continue;}
  ctx.drawImage(images.sleepDecoration,427,8+drift,170,170);
  ctx.save();ctx.lineJoin='round';ctx.strokeStyle='#fff4f8';ctx.fillStyle='#663650';ctx.lineWidth=4;
  for(const [x,y,size]of [[78,145,30],[91,165,23],[103,181,17]]){
   ctx.font=`italic bold ${size}px Georgia`;ctx.strokeText('z',x,y+drift);ctx.fillText('z',x,y+drift);
  }
  ctx.restore();
 }
}

/**
 * Full motion envelope in the renderer's logical 600×800 coordinates.
 * The native host scales these rectangles to its content dimensions. Repeated
 * calls return the same object, so frame/position changes never need setShape.
 */
export function createCharacterHitRegion(atlas,state={},settings={}){
 let cache=regions.get(atlas);if(!cache){cache={results:new Map(),sources:new Map(),bodies:new Map(),decorations:new Map()};regions.set(atlas,cache);}
 const amplitude=motionAmplitude(settings),enabled=amplitude>0,pose=state.pose??'idle';
 const decoration=['sleep','dizzy'].includes(state.expression)?state.expression:'';
 const headTracking=settings.headTracking===true;
 const bodyKey=`${pose}:${!!state.cat}:${amplitude}:${headTracking}`,key=`${bodyKey}:${decoration}`;
 if(cache.results.has(key))return cache.results.get(key);
 const start=performance.now();
 const readMask=draw=>{
  const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;
  const ctx=canvas.getContext('2d');draw(ctx);
  // One readback per body envelope or decoration, never from the live canvas.
  return alphaToOccupancy(ctx.getImageData(0,0,WIDTH,HEIGHT).data,WIDTH,HEIGHT,{cellSize:CELL_SIZE});
 };
 let body=cache.bodies.get(bodyKey);
 if(!body){
  const sourceKey=`${pose}:${!!state.cat}`;
  let alpha=cache.sources.get(sourceKey);
  if(!alpha){alpha=sourceAlpha(atlas,pose,!!state.cat);cache.sources.set(sourceKey,alpha);}
  body=meshAlphaToOccupancy(alpha,{width:WIDTH,height:HEIGHT,cellSize:CELL_SIZE,padding:1,
   x:RIG.x,y:RIG.y,scale:RIG.scale,enabled,cat:!!state.cat,pose,motionAmplitude:amplitude,headTracking});
  cache.bodies.set(bodyKey,body);
 }
 let mask=body;
 if(decoration){
  const decorKey=`${decoration}:${amplitude}`;
  let decor=cache.decorations.get(decorKey);
  if(!decor){decor=readMask(ctx=>drawDecorations(ctx,atlas.images,decoration,amplitude));cache.decorations.set(decorKey,decor);}
  const cells=body.cells.slice();for(let i=0;i<cells.length;i++)cells[i]|=decor.cells[i];
  mask={...body,cells};
 }
 const rects=rectanglesFromOccupancy(mask).map(Object.freeze);
 const result=Object.freeze({width:WIDTH,height:HEIGHT,cellSize:CELL_SIZE,rects:Object.freeze(rects),buildMs:performance.now()-start});
 cache.results.set(key,result);return result;
}

/** Prepare every pose/skin silhouette while the loading screen is still shown. */
export async function prepareCharacterHitRegions(atlas,settings={}){
 for(const pose of ['idle','megaphone','cake','tea'])for(const cat of [false,true]){
  for(const expression of [null,'sleep','dizzy'])createCharacterHitRegion(atlas,{pose,cat,expression},settings);
  // Yield between independent appearances so input and loading UI remain live.
  await new Promise(resolve=>setTimeout(resolve,0));
 }
}
