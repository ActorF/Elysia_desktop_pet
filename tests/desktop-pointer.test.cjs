'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDesktopPointer,POINTER_INTERVAL_MS,DRAG_INTERVAL_MS}=require('../electron/desktop-pointer.cjs');
function setup(){
 let cursor={x:100,y:100},bounds={x:30,y:50,width:420,height:560},clock=0,saves=0;
 const events=[],moves=[],dragStates=[];
 const pointer=createDesktopPointer({readCursor:()=>cursor,getBounds:()=>({...bounds}),setPosition:(x,y)=>{moves.push([x,y]);bounds={...bounds,x,y};},sendPointer:p=>events.push(p),onDragEnd:()=>saves++,onDragState:active=>dragStates.push(active),now:()=>clock});
 return {pointer,events,moves,dragStates,get bounds(){return bounds;},get saves(){return saves;},cursor:p=>{cursor=p;},time:t=>{clock=t;}};
}
test('rapid native drag uses latest cursor independently of unacknowledged renderer events',()=>{
 const s=setup();s.pointer.startDrag();s.pointer.sample();
 for(const [x,y]of [[-3000,-2000],[8000,5000],[-800,900]]){s.cursor({x,y});s.pointer.sample();assert.deepEqual([s.bounds.x,s.bounds.y],[x-70,y-50]);}
 assert.equal(s.events.length,1,'a stalled renderer must not queue stale movement');
 s.pointer.acknowledge(s.events[0].sequence);s.pointer.sample();
 assert.deepEqual([s.events[1].x,s.events[1].y],[-800,900]);
 assert.equal(s.events[1].localX,70);assert.equal(s.events[1].localY,50);
 assert.equal(DRAG_INTERVAL_MS,4);assert.equal(POINTER_INTERVAL_MS,16);
});

test('drag state changes once per gesture, resumes on cancel/reset, and cannot reset the grab offset twice',()=>{
 const s=setup();s.pointer.startDrag();s.cursor({x:150,y:140});s.pointer.startDrag();s.pointer.sample();
 assert.deepEqual([s.bounds.x,s.bounds.y],[80,90]);assert.deepEqual(s.dragStates,[true]);
 s.pointer.endDrag();s.pointer.endDrag();assert.deepEqual(s.dragStates,[true,false]);
 s.pointer.startDrag();s.pointer.cancelDrag();s.pointer.cancelDrag();
 s.pointer.startDrag();s.pointer.reset();assert.deepEqual(s.dragStates,[true,false,true,false,true,false]);
});
test('release applies final native position once and stops further movement',()=>{
 const s=setup();s.pointer.startDrag();s.cursor({x:900,y:-700});s.pointer.endDrag();
 assert.deepEqual([s.bounds.x,s.bounds.y],[830,-750]);assert.equal(s.saves,1);
 s.cursor({x:300,y:300});s.pointer.sample();s.pointer.endDrag();
 assert.deepEqual([s.bounds.x,s.bounds.y],[830,-750]);assert.equal(s.saves,1);
});
test('stationary cursor events are suppressed but changed window bounds are transmitted',()=>{
 const s=setup();s.pointer.sample();s.pointer.acknowledge(s.events[0].sequence);s.pointer.sample();assert.equal(s.events.length,2,'one fresh sample follows initial synchronization');
 s.pointer.acknowledge(s.events[1].sequence);s.pointer.sample();assert.equal(s.events.length,2,'stationary suppression resumes after synchronization');
 s.pointer.startDrag();s.cursor({x:101,y:100});s.pointer.sample();assert.equal(s.events.length,3);
 s.pointer.acknowledge(-1);s.cursor({x:102,y:100});s.pointer.sample();assert.equal(s.events.length,3);
 s.pointer.acknowledge(s.events[2].sequence);s.pointer.sample();assert.equal(s.events.length,4);
});
test('invalid coordinates, canceled drags and renderer reloads remain recoverable without a stalled queue',()=>{
 const s=setup();s.pointer.startDrag({x:Infinity,y:0});assert.equal(s.pointer.dragging,false);
 s.pointer.startDrag();s.pointer.cancelDrag();s.cursor({x:-9999,y:NaN});s.pointer.sample();assert.equal(s.events.length,0);
 s.cursor({x:1,y:2});s.pointer.sample();
 for(let seconds=1;seconds<=5;seconds++){s.time(seconds*1000);s.cursor({x:seconds*100,y:seconds*100});s.pointer.sample();}
 assert.equal(s.events.length,1,'even a five-second renderer stall retains only one unacknowledged sample');
 s.pointer.acknowledge(s.events[0].sequence);s.pointer.sample();assert.deepEqual([s.events[1].x,s.events[1].y],[500,500]);
 s.pointer.reset();s.pointer.sample();assert.equal(s.events.length,3);
});
