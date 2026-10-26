'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),output=path.join(root,'artifacts','overlay-picking-check');
const {DEFAULT_SETTINGS}=require(path.join(root,'electron/host-policy.cjs'));
const report={passed:false,checks:[],errors:[]};
const server=createServer((req,res)=>{try{
  const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!file.startsWith(root+path.sep))throw Error('outside');
  res.setHeader('Content-Type',({'.mjs':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png'})[path.extname(file)]||'text/plain');
  res.end(fs.readFileSync(file));
}catch{res.writeHead(404).end();}});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    async function fresh({scale=1,x=140,y=0,clipped=false}={}){
      await page?.close();page=await browser.newPage({viewport:{width:740,height:800}});
      page.on('pageerror',error=>report.errors.push(error.message));
      await page.addInitScript(({defaults,scale,x,y,clipped})=>{
        Math.random=()=>0;
        const callbacks={},host={settings:{...defaults,hairMotion:false,eyeTracking:false,scale},hotkeys:{typing:{active:true}},
          viewport:{characterX:x,characterY:y,characterWidth:600*scale,characterHeight:800*scale,width:740,height:800,clipped}};
        const qa=window.__overlayQA={now:1000,calls:[],starts:0,ends:0,type:key=>callbacks.typed(key),action:value=>callbacks.action(value)};
        const nativeFrame=requestAnimationFrame.bind(window);
        performance.now=()=>qa.now;window.requestAnimationFrame=callback=>nativeFrame(()=>callback(qa.now));
        window.elysiaDesktop={getState:async()=>structuredClone(host),onPointer:cb=>callbacks.pointer=cb,onAction:cb=>callbacks.action=cb,
          onSettings:cb=>callbacks.settings=cb,onTypedKey:cb=>callbacks.typed=cb,onViewport:cb=>callbacks.viewport=cb,
          setAppearance(){},setHitRegion:async()=>true,dragStart(){qa.starts++;},dragEnd(){qa.ends++;},
          interact:async kind=>qa.calls.push(kind)};
      },{defaults:DEFAULT_SETTINGS,scale,x,y,clipped});
      await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
      await page.waitForSelector('html[data-ready="true"]');
    }
    const step=delta=>page.evaluate(async delta=>{
      window.__overlayQA.now+=delta;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    },delta);
    const sample=point=>page.evaluate(point=>({part:window.elysiaPreview.partAt(point.x,point.y),calls:[...window.__overlayQA.calls],
      face:window.elysiaPreview.snapshot().expression,starts:window.__overlayQA.starts,ends:window.__overlayQA.ends}),point);
    for(const view of [{scale:1,x:140,y:0},{scale:.65,x:180,y:110},{scale:2,x:-500,y:-350,clipped:true}]){
      await fresh(view);
      const point={x:view.x+422*view.scale,y:view.y+370*view.scale};
      assert.equal((await sample(point)).part,'head');
      await page.evaluate(()=>window.__overlayQA.type('A'));await step(0);
      assert.equal((await sample(point)).part,null);
      await page.mouse.click(point.x,point.y,{delay:30});
      const blocked=await sample(point);
      assert.deepEqual(blocked.calls,[]);assert.equal(blocked.face,null);
      assert.equal(blocked.starts,1);assert.equal(blocked.ends,1,'overlay press still releases native drag');
      await step(1001);assert.equal((await sample(point)).part,'head');
      await page.mouse.click(point.x,point.y,{delay:30});
      assert.deepEqual((await sample(point)).calls,['head-pat']);
      report.checks.push({name:'cloud exclusion and expiry at viewport scale',...view});
    }
    await fresh();
    const corner={x:140+382,y:310};const cornerPart=(await sample(corner)).part;
    assert.ok(cornerPart);
    await page.evaluate(()=>window.__overlayQA.type('A'));await step(0);
    assert.equal((await sample(corner)).part,cornerPart,'transparent corner of cloud bounding box stays interactive');
    report.checks.push({name:'transparent cloud bounding-box corner is not blocked'});

    // Sample actual painted masks to find opaque overlay/body intersections.
    // A bounding-box implementation would also fail the transparent-corner case above.
    async function overlap(kind,age=0){
      return page.evaluate(async({kind,age})=>{
        const {loadCharacter,composeCharacterFrame,drawCharacterDecorations,RIG}=await import('./faithful-character.mjs');
        const {drawKeyCloud}=await import('./key-cloud.mjs');
        const atlas=window.__overlayAtlas??=await loadCharacter();
        const state=window.elysiaPreview.snapshot(),settings=window.elysiaPreview.settings();
        const body=document.createElement('canvas'),overlay=document.createElement('canvas');body.width=overlay.width=740;body.height=overlay.height=800;
        const bc=body.getContext('2d'),oc=overlay.getContext('2d');
        bc.translate(140+RIG.x,RIG.y);bc.scale(RIG.scale,RIG.scale);bc.drawImage(composeCharacterFrame(atlas.images,state,false),0,0);
        oc.translate(140,0);
        if(kind==='cloud')drawKeyCloud(oc,{character:'A',age},{pose:state.pose});
        else drawCharacterDecorations(oc,atlas.images,state,settings);
        const a=bc.getImageData(0,0,740,800).data,b=oc.getImageData(0,0,740,800).data,candidates=[];
        for(let y=0;y<800;y++)for(let x=0;x<740;x++){
          const i=(y*740+x)*4;if(a[i+3]>200&&b[i+3]>128)candidates.push({x:x+.5,y:y+.5});
        }
        return {count:candidates.length,point:candidates[Math.floor(candidates.length/2)]};
      },{kind,age});
    }
    for(const expression of ['sleep','dizzy']){
      await fresh();await page.evaluate(id=>window.__overlayQA.action({type:'expression',id}),expression);await step(0);
      const result=await overlap('decoration');assert.ok(result.count>0,`${expression} must overlap opaque character`);
      assert.equal((await sample(result.point)).part,null);
      await page.mouse.click(result.point.x,result.point.y,{delay:30});
      assert.deepEqual((await sample(result.point)).calls,[]);
      assert.equal((await sample(result.point)).face,expression);
      report.checks.push({name:'visible expression decoration is excluded',expression,overlapPixels:result.count,point:result.point});
    }
    for(const age of [0,.25]){
      await fresh();await page.evaluate(()=>window.__overlayQA.action({type:'pose',id:'megaphone'}));await step(0);
      await page.evaluate(()=>window.__overlayQA.type('A'));await step(age*1000);
      const result=await overlap('cloud',age);assert.ok(result.count>0,'megaphone cloud must overlap horn');
      assert.equal((await sample(result.point)).part,null);
      await page.mouse.click(result.point.x,result.point.y,{delay:30});
      assert.deepEqual((await sample(result.point)).calls,[]);
      report.checks.push({name:'moving megaphone cloud is excluded',age,overlapPixels:result.count,point:result.point});
    }
    await fresh();await page.evaluate(()=>window.__overlayQA.action({type:'pose',id:'megaphone'}));await step(0);
    await page.evaluate(()=>window.__overlayQA.type('A'));await step(0);
    const frozen=await overlap('cloud',0);assert.ok(frozen.count>0);
    await page.mouse.move(frozen.point.x,frozen.point.y);await page.mouse.down();await step(250);
    assert.equal(await page.evaluate(()=>window.elysiaPreview.keyDisplay().age),.25);
    assert.equal((await sample(frozen.point)).part,null,'drag-frozen image keeps the painted cloud position');
    await page.mouse.up();assert.deepEqual((await sample(frozen.point)).calls,[]);
    report.checks.push({name:'drag freeze uses the last painted cloud instead of its live age'});
    assert.deepEqual(report.errors,[]);report.passed=true;
  }catch(error){report.error=error.stack;process.exitCode=1;}
  finally{
    await browser?.close();server.close();fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
