'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {settingsAction,isSettingsSender,settingsWindowBounds}=require('../electron/settings-policy.cjs');
const {createSettingsWindow}=require('../electron/settings-window.cjs');

test('settings actions allow only the existing appearance commands and discard extra fields',()=>{
  for(const value of [null,[],{},'reset',{type:'quit'},{type:'expression',id:null},{type:'expression',id:'pat'},{type:'pose',id:'cat'},{type:'toggle-skin',id:'tea'},{type:'__proto__',id:'x'}])assert.equal(settingsAction(value),null);
  for(const value of [{type:'expression',id:'blush'},{type:'pose',id:'cake'},{type:'toggle-skin',id:'glasses'}])assert.deepEqual(settingsAction({...value,script:'ignored'}),value);
  assert.deepEqual(settingsAction({type:'reset',id:'ignored'}),{type:'reset'});
});

test('settings IPC rejects the pet, subframes, navigated documents and destroyed windows',()=>{
  const url='file:///settings.html',frame={url};
  const contents={mainFrame:frame,isDestroyed:()=>false};
  const window={webContents:contents,isDestroyed:()=>false};
  const event={sender:contents,senderFrame:frame};
  assert.equal(isSettingsSender(event,window,url),true);
  assert.equal(isSettingsSender({...event,sender:{}},window,url),false);
  assert.equal(isSettingsSender({...event,senderFrame:{url}},window,url),false);
  assert.equal(isSettingsSender(event,window,'file:///other.html'),false);
  assert.equal(isSettingsSender(event,null,url),false);
  assert.equal(isSettingsSender(event,{...window,isDestroyed:()=>true},url),false);
  assert.equal(isSettingsSender(event,{...window,webContents:{...contents,isDestroyed:()=>true}},url),false);
});

test('settings window fits the chosen monitor and recovers saved offscreen bounds',()=>{
  const area={x:-1920,y:-100,width:1920,height:1040};
  assert.deepEqual(settingsWindowBounds(area),{x:-1260,y:30,width:600,height:780,minWidth:500,minHeight:540});
  const restored=settingsWindowBounds(area,{x:5000,y:-5000,width:900,height:2000});
  assert.deepEqual(restored,{x:-900,y:-100,width:900,height:1040,minWidth:500,minHeight:540});
  assert.deepEqual(settingsWindowBounds({x:0,y:0,width:400,height:300}),{x:0,y:0,width:400,height:300,minWidth:400,minHeight:300});
});

class FakeWindow extends EventEmitter {
  constructor(options){super();this.options=options;this.destroyed=false;this.calls=[];this.bounds={x:options.x,y:options.y,width:options.width,height:options.height};this.webContents=new EventEmitter();this.webContents.mainFrame={url:''};this.webContents.isDestroyed=()=>this.destroyed;this.webContents.sent=[];this.webContents.send=(...args)=>this.webContents.sent.push(args);this.webContents.setWindowOpenHandler=fn=>{this.windowOpen=fn;};}
  setMenu(menu){this.menu=menu;}
  loadURL(url){this.url=url;this.webContents.mainFrame.url=url;return Promise.resolve();}
  isDestroyed(){return this.destroyed;}
  isMinimized(){return !!this.minimized;}
  isMaximized(){return !!this.maximized;}
  minimize(){this.calls.push('minimize');this.minimized=true;}
  restore(){this.calls.push('restore');this.minimized=false;this.emit('restore');}
  maximize(){this.calls.push('maximize');this.normalBounds={...this.bounds};this.maximized=true;this.bounds={x:0,y:0,width:1920,height:1040};this.emit('maximize');}
  unmaximize(){this.calls.push('unmaximize');this.maximized=false;this.bounds={...this.normalBounds};this.emit('unmaximize');}
  show(){this.calls.push('show');}
  focus(){this.calls.push('focus');}
  getBounds(){return {...this.bounds};}
  getNormalBounds(){return {...(this.maximized?this.normalBounds:this.bounds)};}
  close(){this.emit('close');this.destroy();}
  destroy(){this.destroyed=true;this.emit('closed');}
}
function fixture(isSmokeTest=false){
  const windows=[],screen={getCursorScreenPoint:()=>({x:100,y:100}),getDisplayNearestPoint:()=>({workArea:{x:0,y:0,width:1920,height:1040}}),getDisplayMatching:()=>({workArea:{x:0,y:0,width:1920,height:1040}})};
  const snapshot={settings:{eyeWarpStrength:.5},appearance:{pose:'tea'}};
  class Window extends FakeWindow{constructor(options){super(options);windows.push(this);}}
  const controller=createSettingsWindow({BrowserWindow:Window,screen,root:path.resolve(__dirname,'..'),isSmokeTest,getState:()=>snapshot});
  return {controller,windows,snapshot};
}

test('settings renderer crashes discard the failed document while preserving normal window bounds',async t=>{
  const f=fixture();t.after(()=>f.controller.dispose());
  const previous=await f.controller.open();
  previous.bounds={x:20,y:30,width:700,height:800};previous.maximize();
  previous.webContents.emit('render-process-gone',{}, {reason:'crashed'});
  assert.equal(f.controller.getWindow(),null);assert.equal(previous.destroyed,true);
  const next=await f.controller.open();
  assert.notEqual(next,previous);assert.deepEqual(next.getNormalBounds(),{x:20,y:30,width:700,height:800});
  previous.webContents.emit('render-process-gone',{}, {reason:'crashed'});
  assert.equal(f.controller.getWindow(),next);
});

test('settings window is a sandboxed, frameless, independent singleton and can close and reopen without another app window',async()=>{
  const f=fixture();
  const [first,second]=await Promise.all([f.controller.open(),f.controller.open()]);
  assert.equal(first,second);assert.equal(f.windows.length,1);
  assert.equal(first.options.parent,undefined);assert.equal(first.options.modal,undefined);
  assert.equal(first.options.frame,false);assert.equal(first.options.roundedCorners,true);assert.equal(first.options.thickFrame,true);
  assert.equal(first.options.title,'设置');assert.equal(first.options.icon,undefined);
  assert.equal(first.options.movable,true);assert.equal(first.options.resizable,true);
  assert.equal(first.options.webPreferences.sandbox,true);assert.equal(first.options.webPreferences.contextIsolation,true);assert.equal(first.options.webPreferences.nodeIntegration,false);
  assert.equal(first.menu,null);assert.deepEqual(first.windowOpen({url:'https://example.com'}),{action:'deny'});
  let denied=0;for(const event of ['will-navigate','will-redirect','will-attach-webview'])first.webContents.emit(event,{preventDefault(){denied++;}});
  assert.equal(denied,3);
  first.minimized=true;await f.controller.open();assert.deepEqual(first.calls.slice(-3),['restore','show','focus']);
  first.bounds={x:20,y:30,width:700,height:800};first.close();assert.equal(f.controller.getWindow(),null);
  const reopened=await f.controller.open();assert.notEqual(reopened,first);assert.equal(f.windows.length,2);
  assert.deepEqual(reopened.getBounds(),{x:20,y:30,width:700,height:800});
  assert.deepEqual(reopened.webContents.sent.at(-1),['settings:state',f.snapshot]);
  f.controller.dispose();assert.equal(reopened.isDestroyed(),true);assert.equal(await f.controller.open(),null);
});

test('custom window controls allow only minimize, toggle-maximize and close for the independent settings window',async()=>{
  const f=fixture();
  assert.equal(f.controller.windowControl('close'),false);
  const window=await f.controller.open();
  const before=[...window.calls];
  for(const invalid of [null,undefined,'quit','maximize','restore','destroy',{action:'close'},['close']])assert.equal(f.controller.windowControl(invalid),false);
  assert.deepEqual(window.calls,before);assert.equal(window.isDestroyed(),false);
  assert.equal(f.controller.windowControl('minimize'),true);assert.equal(window.isMinimized(),true);
  assert.equal(window.isDestroyed(),false);await f.controller.open();assert.equal(window.isMinimized(),false);
  assert.equal(f.controller.windowControl('toggle-maximize'),true);assert.equal(window.isMaximized(),true);
  assert.equal(f.controller.windowControl('toggle-maximize'),true);assert.equal(window.isMaximized(),false);
  assert.equal(f.controller.windowControl('close'),true);assert.equal(window.isDestroyed(),true);assert.equal(f.controller.getWindow(),null);
  const reopened=await f.controller.open();assert.notEqual(reopened,window);f.controller.dispose();
  assert.equal(f.controller.windowControl('minimize'),false);
});

test('native maximize events update the bridge and reopening a maximized window restores normal bounds',async()=>{
  const f=fixture(),window=await f.controller.open();
  const normal={x:44,y:61,width:700,height:800};window.bounds={...normal};
  assert.deepEqual(f.controller.getWindowState(),{maximized:false});
  window.maximize();
  assert.deepEqual(f.controller.getWindowState(),{maximized:true});
  assert.deepEqual(window.webContents.sent.at(-1),['settings:window-state',{maximized:true}]);
  window.unmaximize();
  assert.deepEqual(window.webContents.sent.at(-1),['settings:window-state',{maximized:false}]);
  window.maximize();window.close();
  const reopened=await f.controller.open();
  assert.deepEqual(reopened.getBounds(),normal,'Closing while maximized must retain the normal position and size');
  assert.deepEqual(f.controller.getWindowState(),{maximized:false});
  assert.ok(reopened.webContents.sent.some(([channel,value])=>channel==='settings:window-state'&&value.maximized===false));
  f.controller.dispose();assert.deepEqual(f.controller.getWindowState(),{maximized:false});
});

test('smoke settings windows stay hidden while still receiving updates and reopen independently',async()=>{
  const f=fixture(true),window=await f.controller.open();
  window.minimized=true;await f.controller.open();assert.deepEqual(window.calls,[]);
  const update={settings:{clickThrough:true},appearance:{expression:'heart'}};
  f.controller.publish(update);assert.deepEqual(window.webContents.sent.at(-1),['settings:state',update]);
  const count=window.webContents.sent.length;window.close();f.controller.publish(update);assert.equal(window.webContents.sent.length,count);
  const reopened=await f.controller.open();assert.deepEqual(reopened.calls,[]);f.controller.dispose();
});
