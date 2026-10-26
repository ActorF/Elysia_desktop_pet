'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const server=createServer((req,res)=>{
  try {
    const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(!file.startsWith(root+path.sep))throw Error('outside');
    res.setHeader('Content-Type',({'.mjs':'text/javascript','.png':'image/png'})[path.extname(file)]||'text/html');
    res.end(fs.readFileSync(file));
  }catch{res.writeHead(404).end();}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,channel:process.platform==='darwin'?'chrome':'msedge'});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      window.__idleQA={now:100000,idle:null,interact:null,action:null,settings:null};
      Date.now=()=>window.__idleQA.now;Math.random=()=>0;
      const settings={eyeTracking:false,headTracking:false,hairMotion:false,keyDisplay:false,idleMoods:true,neglectMinutes:2,deviceIdleMinutes:5};
      window.elysiaDesktop={getState:async()=>({settings}),onPointer(){},onAction(cb){window.__idleQA.action=cb;},onSettings(cb){window.__idleQA.settings=cb;},
        onEnvironment(cb){window.__idleQA.idle=cb;},onAttention(cb){window.__idleQA.interact=cb;},setAppearance(){},setHitRegion:async()=>true,dragStart(){},dragEnd(){}};
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.waitForSelector('html[data-ready="true"]');
    const step=async(now,idleSeconds)=>page.evaluate(async({now,idleSeconds})=>{
      window.__idleQA.now=now;
      window.__idleQA.idle({idleSeconds,now});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {mood:window.elysiaPreview.idleMood(),face:window.elysiaPreview.snapshot().expression};
    },{now,idleSeconds});
    await page.evaluate(()=>window.__idleQA.action({type:'expression',id:'heart'}));
    assert.equal((await step(219999,0)).face,'heart');
    assert.deepEqual((await step(220000,0)).mood,{mode:'neglected',expression:'angry'});
    assert.deepEqual((await step(221000,300)).mood,{mode:'idle',expression:'sleep'});
    assert.deepEqual((await step(222000,0)).mood,{mode:'neglected',expression:'angry'});
    await page.evaluate(()=>window.__idleQA.interact());
    assert.equal((await step(223000,0)).face,'heart');
    await page.evaluate(()=>window.__idleQA.action({type:'expression',id:'smile'}));
    assert.deepEqual((await step(400000,0)).mood,{mode:'neglected',expression:'angry'});
    await page.evaluate(()=>window.__idleQA.settings({settings:{idleMoods:false,keyDisplay:false,hairMotion:false,eyeTracking:false}}));
    assert.equal((await step(700000,900)).face,'smile');
    assert.equal((await step(700001,900)).mood,null);
    assert.deepEqual(errors,[]);
    const report={neglect:true,deviceIdlePriority:true,wake:true,interactionRestores:true,manualFacePreserved:true,disabled:true,errors};
    const out=path.join(root,'artifacts/idle-mood');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
