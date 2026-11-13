// Native cursor sampling keeps dragging independent of rendering and IPC queues.
'use strict';
const {freeBounds,pointerPayload}=require('./host-policy.cjs');
const {performance}=require('node:perf_hooks');
const POINTER_INTERVAL_MS=16,DRAG_INTERVAL_MS=4;
function createDesktopPointer({readCursor,getBounds,setPosition,sendPointer,onDragEnd=()=>{},onDragState=()=>{},now=()=>performance.now(),constrainBounds=freeBounds}){
  let drag=null,sequence=0,pending=null,lastSent=null,resampleOnAck=true;
  const valid=point=>point&&Number.isFinite(point.x)&&Number.isFinite(point.y);
  function move(point){
    if(!drag||!valid(point))return;
    const next=constrainBounds({...drag.bounds,x:drag.bounds.x+point.x-drag.point.x,y:drag.bounds.y+point.y-drag.point.y});
    const current=getBounds();
    if(next.x!==current.x||next.y!==current.y)setPosition(next.x,next.y);
  }
  function sample(point=readCursor()){
    if(!valid(point))return;
    move(point);
    const payload=pointerPayload(point,getBounds()),sampledAt=now();
    // At most one unacknowledged cursor event. A busy renderer never accumulates
    // a trail of obsolete positions; after its ACK the next sample is current.
    if(pending)return;
    if(lastSent&&Object.keys(payload).every(key=>payload[key]===lastSent[key])&&!pending)return;
    const id=++sequence;pending={id};lastSent=payload;
    sendPointer({...payload,sequence:id,sampledAt,clock:'desktop-monotonic'});
  }
  function cancelDrag(){if(drag){drag=null;onDragState(false);}}
  return {
    sample,
    startDrag(point=readCursor()){if(valid(point)&&!drag){drag={point:{x:point.x,y:point.y},bounds:getBounds()};onDragState(true);}},
    endDrag(point=readCursor()){if(!drag)return;move(point);drag=null;onDragState(false);onDragEnd();},
    cancelDrag,
    acknowledge(id){
      if(pending?.id!==id)return;
      pending=null;
      // A new document may discard its first in-flight point after local input.
      // Sample once more after its ACK even if the cursor is now stationary.
      if(resampleOnAck){resampleOnAck=false;lastSent=null;}
    },
    reset(){cancelDrag();pending=null;lastSent=null;resampleOnAck=true;},
    get dragging(){return drag!==null;},
  };
}
module.exports={createDesktopPointer,POINTER_INTERVAL_MS,DRAG_INTERVAL_MS};
