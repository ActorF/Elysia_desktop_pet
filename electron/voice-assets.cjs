'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// Explicit allowlist: runtime voices come only from the approved resource pack.
function loadVoiceAssets(root, directory = path.join(root, 'assets', 'voice')) {
  let catalog = { groups: [] };
  const lines = new Map(), allowedUrls = new Set();
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(root, 'renderer', 'voice-catalog.json'), 'utf8'));
    const map = JSON.parse(fs.readFileSync(path.join(directory, 'final-audio-map.json'), 'utf8'));
    if (map.confirmedCount !== 36 || map.lines?.length !== 36) throw new Error('需要完整的 36 句已确认录音。');
    for (const line of map.lines) {
      if (!/^(0[1-9]|1[0-2])-[1-3]$/.test(line.id) || lines.has(line.id)
        || line.currentPath !== `audio-final/${line.id}.wav`) throw new Error('录音映射无效。');
      const metadata = catalog.groups.flatMap(group => group.lines).find(value => value.id === line.id);
      if (!metadata || metadata.text !== line.text) throw new Error(`台词不一致：${line.id}`);
      const file = path.join(directory, 'audio-final', `${line.id}.wav`);
      const bytes = fs.readFileSync(file);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== line.currentSha256) throw new Error(`录音校验失败：${line.id}`);
      const audioUrl = pathToFileURL(file).href;
      allowedUrls.add(audioUrl);
      lines.set(line.id, { id: line.id, text: line.text, groupId: line.groupId, groupName: line.groupName, audioUrl });
    }
    return { catalog, lines, allowedUrls, available: true, error: null };
  } catch (error) {
    return { catalog, lines: new Map(), allowedUrls: new Set(), available: false, error: `语音素材暂不可用：${error.message}` };
  }
}

// Interaction recordings have their own explicit approval and asset boundary.
// A missing or rejected interaction pack never changes the original daily pack.
function loadInteractionAssets(root, directory = path.join(root, 'assets', 'interaction-voice')) {
  const lines = new Map(), allowedUrls = new Set();
  const groupForPrefix = { H:'head-pat', P:'poke', A:'poke-annoyed' };
  const expected = new Set(Object.keys(groupForPrefix).flatMap(prefix =>
    Array.from({length:6},(_,index)=>`${prefix}0${index+1}`)));
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'renderer', 'interaction-catalog.json'), 'utf8'));
    if (!Array.isArray(catalog) || catalog.length !== expected.size) throw new Error('互动台词目录需要完整的 18 句。');
    const metadataById = new Map();
    for (const line of catalog) {
      if (!line || !expected.has(line.id) || metadataById.has(line.id)
        || line.groupId !== groupForPrefix[line.id[0]] || typeof line.text !== 'string' || !line.text.trim()) {
        throw new Error('互动台词目录无效。');
      }
      metadataById.set(line.id,line);
    }
    const map = JSON.parse(fs.readFileSync(path.join(directory, 'final-audio-map.json'), 'utf8'));
    if (map?.status !== 'confirmed' || map?.confirmedBy !== 'user') throw new Error('互动录音尚未获得用户试听确认。');
    if (map.confirmedCount !== expected.size || !Array.isArray(map.lines) || map.lines.length !== expected.size) {
      throw new Error('需要完整的 18 句已确认互动录音。');
    }
    for (const line of map.lines) {
      if (!line || !expected.has(line.id) || lines.has(line.id)
        || line.currentPath !== `audio-final/${line.id}.wav`) throw new Error('互动录音映射无效。');
      const metadata = metadataById.get(line.id);
      if (line.text !== metadata.text || line.groupId !== metadata.groupId) throw new Error(`互动台词或类别不一致：${line.id}`);
      if (typeof line.currentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(line.currentSha256)
        || line.originalSha256 !== line.currentSha256) throw new Error(`互动录音确认校验无效：${line.id}`);
      const file = path.join(directory, 'audio-final', `${line.id}.wav`);
      const bytes = fs.readFileSync(file);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== line.currentSha256) throw new Error(`互动录音校验失败：${line.id}`);
      const audioUrl = pathToFileURL(file).href;
      lines.set(line.id,{id:line.id,groupId:line.groupId,text:line.text,audioUrl});
      allowedUrls.add(audioUrl);
    }
    return {lines,allowedUrls,available:true,error:null};
  } catch (error) {
    return {lines:new Map(),allowedUrls:new Set(),available:false,error:`互动语音素材暂不可用：${error.message}`};
  }
}

module.exports = { loadVoiceAssets, loadInteractionAssets };
