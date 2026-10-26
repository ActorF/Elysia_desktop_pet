/** Source-space body regions; inverse mesh picking keeps them attached during animation. */
import {MESH_GRID, deformPoint} from './mesh-rig.mjs';
import {motionAmplitude, motionTime} from './motion-settings.mjs';
import {characterView} from './viewport.mjs';

const ellipse=(x,y,cx,cy,rx,ry)=>((x-cx)/rx)**2+((y-cy)/ry)**2<=1;
// Source coordinates use the 1090×1443 artwork, before RIG and viewport scaling.
// Foreground hands/props take precedence over the shared face and torso ranges.
const HANDS={idle:[[770,752,65,70],[274,905,58,45]],tea:[[635,741,48,72],[274,905,58,45]],cake:[[702,750,45,65],[377,824,61,38]],megaphone:[[770,752,65,70],[337,751,52,48]]};

export function partAtSource(x,y,pose='idle') {
  if(![x,y].every(Number.isFinite)||x<0||y<0||x>=1090||y>=1443)return null;
  if((HANDS[pose]??HANDS.idle).some(args=>ellipse(x,y,...args)))return 'hand';
  if(pose==='tea'&&ellipse(x,y,560,714,57,85))return 'prop';
  if(pose==='cake'&&(ellipse(x,y,390,760,110,55)||ellipse(x,y,597,675,65,42)))return 'prop';
  if(pose==='megaphone'&&ellipse(x,y,200,623,185,130))return 'prop';
  if(ellipse(x,y,531,552,206,143))return 'face';
  if(y<730)return 'head';
  if(y>1050&&x>385&&x<755)return 'legs';
  if(x>330&&x<810&&y<1100)return 'body';
  // Long hair extends behind the coat; avoid treating the coat hem as hair.
  if((x>875&&y<1145)||(x<335&&y>1170))return 'head';
  return 'body';
}

function barycentric(px,py,a,b,c) {
  const denominator=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  if(Math.abs(denominator)<1e-8)return null;
  const u=((b[1]-c[1])*(px-c[0])+(c[0]-b[0])*(py-c[1]))/denominator;
  const v=((c[1]-a[1])*(px-c[0])+(a[0]-c[0])*(py-c[1]))/denominator;
  return u>=-1e-6&&v>=-1e-6&&u+v<=1+1e-6?[u,v,1-u-v]:null;
}

/** Reverse the same triangles that WebGL draws, including head and idle motion. */
export function sourceAtMeshPoint(x,y,state,settings={},accelerated=true) {
  if(![x,y].every(Number.isFinite))return null;
  if(!accelerated)return x>=0&&y>=0&&x<1090&&y<1443?{x,y}:null;
  const {width,height,columns,rows}=MESH_GRID,vertices=[];
  const amplitude=motionAmplitude(settings),head=settings.headTracking===true?state.head:{};
  for(let j=0;j<=rows;j++)for(let i=0;i<=columns;i++){
    const sx=i*width/columns,sy=j*height/rows;
    vertices.push({source:[sx,sy],point:deformPoint(sx,sy,motionTime(state,settings),amplitude>0,!!state.cat,state.pose,amplitude,head)});
  }
  for(let j=rows-1;j>=0;j--)for(let i=columns-1;i>=0;i--){
    const k=j*(columns+1)+i;
    // Later triangles win in the (rare) case of overlapping geometry.
    for(const indices of [[k+1,k+columns+2,k+columns+1],[k,k+1,k+columns+1]]){
      const v=indices.map(index=>vertices[index]),p=v.map(value=>value.point);
      if(x<Math.min(...p.map(a=>a[0]))||x>Math.max(...p.map(a=>a[0]))||y<Math.min(...p.map(a=>a[1]))||y>Math.max(...p.map(a=>a[1])))continue;
      const weights=barycentric(x,y,...p);
      if(weights)return {x:v.reduce((s,a,n)=>s+a.source[0]*weights[n],0),y:v.reduce((s,a,n)=>s+a.source[1]*weights[n],0)};
    }
  }
  return null;
}

export function sourceAtPointer(localX,localY,width,height,viewport,rig,state,settings,accelerated=true){
  const view=characterView(width,height,viewport);
  return sourceAtMeshPoint(((localX-view.x)/view.scale-rig.x)/rig.scale,((localY-view.y)/view.scale-rig.y)/rig.scale,state,settings,accelerated);
}
