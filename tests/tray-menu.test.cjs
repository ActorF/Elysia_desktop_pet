'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {trayTemplate}=require('../electron/tray-menu.cjs');

test('the tray opens settings or the chat composer and exits without preference submenus',()=>{
  const calls=[];
  const menu=trayTemplate({openSettings:()=>calls.push('settings'),openChat:()=>calls.push('chat'),quit:()=>calls.push('quit')});
  assert.deepEqual(menu.map(item=>item.label),['设置','打开聊天框','退出']);
  assert.equal(menu.some(item=>item.submenu||item.type==='separator'||item.type==='checkbox'),false);
  menu[0].click();assert.deepEqual(calls,['settings']);
  menu[1].click();assert.deepEqual(calls,['settings','chat']);
  menu[2].click();assert.deepEqual(calls,['settings','chat','quit']);
});
