/** Analytic alpha envelope for the character's weighted triangle mesh. */
import {MESH_GRID,meshPointMotionBounds} from './mesh-rig.mjs';

/** Each displacement bound is affine inside the same triangle as the GPU. */
export function meshBoundsAtPoint(grid,x,y){
 const {columns,rows,width,height,vertices}=grid;
 const gx=Math.max(0,Math.min(columns,x*columns/width));
 const gy=Math.max(0,Math.min(rows,y*rows/height));
 const i=Math.min(columns-1,Math.floor(gx)),j=Math.min(rows-1,Math.floor(gy));
 const u=gx-i,v=gy-j,k=j*(columns+1)+i;
 const indices=u+v<=1?[k,k+1,k+columns+1]:[k+1,k+columns+2,k+columns+1];
 const weights=u+v<=1?[1-u-v,u,v]:[1-v,u+v-1,1-u];
 const result=[0,0,0,0];
 for(let corner=0;corner<3;corner++)for(let axis=0;axis<4;axis++)
  result[axis]+=vertices[indices[corner]*4+axis]*weights[corner];
 return result;
}

export function createMeshBounds({enabled=true,cat=false,pose='idle',motionAmplitude=1,headTracking=false}={}){
 const {columns,rows,width,height}=MESH_GRID;
 const vertices=new Float64Array((columns+1)*(rows+1)*4);
 for(let j=0;j<=rows;j++)for(let i=0;i<=columns;i++){
  const bounds=meshPointMotionBounds(width*i/columns,height*j/rows,enabled,cat,pose,motionAmplitude,headTracking);
  // Float32 vertex storage and shader arithmetic are below a hundredth of a
  // source pixel. Keep that allowance separate from the one logical pixel AA.
  vertices.set([bounds[0]-.01,bounds[1]-.01,bounds[2]+.01,bounds[3]+.01],(j*(columns+1)+i)*4);
 }
 return {...MESH_GRID,vertices};
}

/**
 * Bounds a rectangle contained in one mesh cell. A piecewise affine extremum
 * lies at a rectangle corner or where its edge crosses the mesh diagonal.
 */
export function meshRectangleBounds(grid,x0,y0,x1,y1,i,j){
 const sx=grid.width/grid.columns,sy=grid.height/grid.rows;
 const left=i*sx,top=j*sy,points=[[x0,y0],[x1,y0],[x0,y1],[x1,y1]];
 for(const x of [x0,x1]){
  const y=top+sy*(1-(x-left)/sx);
  if(y>y0&&y<y1)points.push([x,y]);
 }
 for(const y of [y0,y1]){
  const x=left+sx*(1-(y-top)/sy);
  if(x>x0&&x<x1)points.push([x,y]);
 }
 const result=[Infinity,Infinity,-Infinity,-Infinity];
 for(const [x,y]of points){
  const b=meshBoundsAtPoint(grid,x,y);
  result[0]=Math.min(result[0],x+b[0]);result[1]=Math.min(result[1],y+b[1]);
  result[2]=Math.max(result[2],x+b[2]);result[3]=Math.max(result[3],y+b[3]);
 }
 return result;
}

/**
 * Source alpha is read once during preparation. Horizontal opaque runs retain
 * holes, then split at mesh cells/triangles before their local motion bounds
 * are added. No frame sampling, live canvas readback or global fat rectangle.
 */
export function meshAlphaToOccupancy(rgba,{
 width=600,height=800,cellSize=4,padding=1,x=38,y=68,scale=.48,
 enabled=true,cat=false,pose='idle',motionAmplitude=1,headTracking=false,
}={}){
 const grid=createMeshBounds({enabled,cat,pose,motionAmplitude,headTracking}),sw=grid.width,sh=grid.height;
 const stride=rgba.length===sw*sh?1:4,offset=stride-1;
 if(rgba.length!==sw*sh*stride)throw new RangeError('Invalid mesh alpha dimensions');
 const columns=Math.ceil(width/cellSize),rows=Math.ceil(height/cellSize),cells=new Uint8Array(columns*rows);
 const sx=sw/grid.columns,sy=sh/grid.rows;
 const mark=b=>{
  const x0=Math.max(0,Math.floor((x+b[0]*scale-padding)/cellSize));
  const y0=Math.max(0,Math.floor((y+b[1]*scale-padding)/cellSize));
  const x1=Math.min(columns,Math.ceil((x+b[2]*scale+padding)/cellSize));
  const y1=Math.min(rows,Math.ceil((y+b[3]*scale+padding)/cellSize));
  if(x1<=x0||y1<=y0)return;
  for(let row=y0;row<y1;row++)cells.fill(1,row*columns+x0,row*columns+x1);
 };
 for(let row=0;row<sh;row++)for(let column=0;column<sw;){
  if(!rgba[(row*sw+column)*stride+offset]){column++;continue;}
  const start=column;
  while(column<sw&&rgba[(row*sw+column)*stride+offset])column++;
  // A nonzero texel influences another half source pixel in either direction
  // under the original GL LINEAR sampler. Final raster AA gets padding above.
  const left=Math.max(0,start-.5),right=Math.min(sw,column+.5);
  const top=Math.max(0,row-.5),bottom=Math.min(sh,row+1.5);
  const i0=Math.floor(left/sx),i1=Math.min(grid.columns-1,Math.floor(right/sx));
  const j0=Math.floor(top/sy),j1=Math.min(grid.rows-1,Math.floor(bottom/sy));
  for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
   const x0=Math.max(left,i*sx),y0=Math.max(top,j*sy),x1=Math.min(right,(i+1)*sx),y1=Math.min(bottom,(j+1)*sy);
   if(x1>x0&&y1>y0)mark(meshRectangleBounds(grid,x0,y0,x1,y1,i,j));
  }
 }
 return {cells,columns,rows,width,height,cellSize};
}
