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
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/settings.html`);
    const result=await page.evaluate(async()=>{
      const {loadCharacter,drawCharacter}=await import('./faithful-character.mjs');
      const {createPetState}=await import('./state.mjs');
      const {createCharacterHitRegion}=await import('./hit-region.mjs');
      const atlas=await loadCharacter();
      const settings={headTracking:true,eyeTracking:false,hairMotion:false};
      const c=document.createElement('canvas');c.width=600;c.height=800;
      const ctx=c.getContext('2d',{willReadFrequently:true});
      const sheet=document.createElement('canvas');sheet.width=900;sheet.height=410;
      const sc=sheet.getContext('2d');sc.fillStyle='#fff5fb';sc.fillRect(0,0,900,410);
      const state=createPetState();
      const draw=(x,y,enabled=true)=>{
        state.head={x,y};drawCharacter(ctx,atlas,state,{...settings,headTracking:enabled});
        return ctx.getImageData(0,0,600,800).data;
      };
      const center=draw(0,0),frames=[],region=createCharacterHitRegion(atlas,state,settings);
      const covered=(x,y)=>region.rects.some(r=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height);
      let missed=0;
      for(const [index,x] of [-1,0,1].entries()){
        const pixels=draw(x,0);let faceChanges=0,bodyChanges=0;
        for(let y=0;y<800;y++)for(let px=0;px<600;px++){
          const i=(y*600+px)*4;
          if(pixels[i+3]>128&&!covered(px,y))missed++;
          if(pixels[i]!==center[i]||pixels[i+1]!==center[i+1]||pixels[i+2]!==center[i+2]||pixels[i+3]!==center[i+3]){
            if(y<410)faceChanges++;else if(y>510)bodyChanges++;
          }
        }
        sc.drawImage(c,100,95,400,530,index*300,12,300,398);
        frames.push({x,faceChanges,bodyChanges});
      }
      const off=draw(1,1,false);let offChanges=0;
      for(let i=0;i<off.length;i++)if(off[i]!==center[i])offChanges++;
      return {accelerated:atlas.mesh.accelerated,frames,missed,offChanges,sheet:sheet.toDataURL()};
    });
    assert.equal(result.accelerated,true,'WebGL shader must compile');
    assert.ok(result.frames.filter(f=>f.x).every(f=>f.faceChanges>1000&&f.bodyChanges===0));
    assert.equal(result.offChanges,0,'Disable restores original render');
    assert.equal(result.missed,0,'Native shape must contain moving silhouette');
    assert.deepEqual(errors,[]);
    const out=path.join(root,'artifacts/head-tracking');fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'comparison.png'),Buffer.from(result.sheet.split(',')[1],'base64'));
    delete result.sheet;fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
