'use strict';
function trayTemplate({ openSettings, openChat, quit }) {
  return [
    { label: '设置', click: openSettings },
    { label: '打开聊天框', click: openChat },
    { label: '退出', click: quit },
  ];
}
module.exports = { trayTemplate };
