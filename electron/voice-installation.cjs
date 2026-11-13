/** Read-only classification of a managed voice directory; never repairs or executes it. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED = Object.freeze(['config/settings.py', 'python/python.exe', 'python/python314.zip', 'voice/managed_gpt_sovits.py',
  'scripts/gpt_sovits_worker.py', 'workspace/settings/voice-profiles.json', 'models/cache/GPT-SoVITS-v2-240821/runtime/python.exe']);
const MARKER = 'voice-setup-complete.json';
const MESSAGES = Object.freeze({
  absent: '尚未配置本地语音环境。',
  ready: '本地语音环境已就绪。',
  'invalid-directory': '语音资源目录结构不正确，已保留原文件；请检查安装目录。',
  'linked-directory': '语音资源路径包含链接或重解析目录，暂时无法确认安装状态；已保留原文件。',
  'unreadable-directory': '无法读取语音资源目录，请检查访问权限或安全软件的拦截记录；已保留原文件。',
  'missing-marker': '语音目录已存在，但缺少安装完成标记，暂时无法确认资源是否完整；已保留原文件。',
  'invalid-marker': '语音环境的安装完成标记无效，暂时无法确认资源是否完整；已保留原文件。',
  'unreadable-marker': '无法读取语音环境的安装完成标记，请检查访问权限或安全软件的拦截记录；已保留原文件。',
  'version-mismatch': '语音环境的安装标记版本与当前程序不匹配，已保留原文件。',
  'resource-mismatch': '语音目录中的资源版本与当前程序不匹配，已保留原文件。',
  'missing-files': '本地语音环境不完整，缺少必需文件；已保留现有资源。',
  'invalid-manifest': '语音资源清单无效，暂时无法确认安装状态。',
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const missing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

function safeEntry(name) {
  // A hash sign is legal in resource filenames and is present in the pinned runtime.
  if (typeof name !== 'string' || !name || name.length > 240 || /[\u0000-\u001f\u007f:?*<>"|]/.test(name) || /^[\\/]/.test(name)) return false;
  return name.replace(/\\/g, '/').split('/').every(part => part && !['.', '..'].includes(part) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function inspectVoiceInstallation(projectRoot, manifest) {
  const result = (code, details = {}) => ({ code, ready: code === 'ready', exists: true, recognized: false,
    missingFiles: [], missingCount: 0, message: MESSAGES[code], ...details });
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return result('invalid-directory', { exists: false });
  let directory, directoryError;
  try { directory = fs.lstatSync(projectRoot); } catch (error) { directoryError = error; }
  const exists = Boolean(directory) || !missing(directoryError);
  if (!record(manifest) || manifest.version !== 1 || !digest(manifest.assets?.sha256) || !digest(manifest.runtime?.sha256)) {
    return result('invalid-manifest', { exists });
  }
  if (directoryError) return result(missing(directoryError) ? 'absent' : 'unreadable-directory', { exists });
  if (directory.isSymbolicLink()) return result('linked-directory');
  if (!directory.isDirectory()) return result('invalid-directory');

  const marker = path.join(projectRoot, MARKER);
  let markerStat;
  try { markerStat = fs.lstatSync(marker); }
  catch (error) { return result(missing(error) ? 'missing-marker' : 'unreadable-marker'); }
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size <= 0 || markerStat.size > 65536) return result('invalid-marker');
  let source, value;
  try { source = fs.readFileSync(marker, 'utf8'); }
  catch { return result('unreadable-marker'); }
  try { value = JSON.parse(source); } catch { return result('invalid-marker'); }
  if (!record(value) || !Number.isSafeInteger(value.version) || value.version < 1) return result('invalid-marker');
  if (value.version !== manifest.version) return result('version-mismatch', { actualVersion: value.version, expectedVersion: manifest.version });
  if (!digest(value.assets) || !digest(value.runtime) || !Array.isArray(value.required)
    || value.required.length < REQUIRED.length || value.required.length > 200 || !value.required.every(safeEntry)) return result('invalid-marker');
  const entries = value.required.map(relative => relative.replace(/\\/g, '/'));
  const keys = new Set(entries.map(relative => relative.toLowerCase()));
  if (!REQUIRED.every(relative => keys.has(relative.toLowerCase()))) return result('invalid-marker');
  if (value.assets.toLowerCase() !== manifest.assets.sha256.toLowerCase() || value.runtime.toLowerCase() !== manifest.runtime.sha256.toLowerCase()) {
    return result('resource-mismatch');
  }

  // A trusted marker identifies an installation even when antivirus, cleanup,
  // or a damaged disk has removed one of its files. Check every path component
  // rather than following a link to a directory outside this installation.
  const missingFiles = [], visited = new Set();
  for (const relative of entries) {
    const key = relative.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    const parts = relative.split('/');
    let current = projectRoot;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (missing(error)) { missingFiles.push(relative); break; }
        return result('unreadable-directory', { recognized: true,
          message: `无法读取语音资源路径 ${parts.slice(0, index + 1).join('/')}，请检查访问权限或安全软件的拦截记录；已保留原文件。` });
      }
      if (stat.isSymbolicLink()) return result('linked-directory', { recognized: true,
        message: `语音资源路径 ${parts.slice(0, index + 1).join('/')} 包含链接或重解析目录，暂时无法确认安装状态；已保留原文件。` });
      if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return result('invalid-directory', { recognized: true,
        message: `语音资源路径 ${parts.slice(0, index + 1).join('/')} 的文件或目录类型不正确；已保留原文件。` });
    }
  }
  if (missingFiles.length) return result('missing-files', { recognized: true, missingFiles, missingCount: missingFiles.length,
    message: `本地语音环境不完整，缺少 ${missingFiles.slice(0, 3).join('、')}${missingFiles.length > 3 ? ' 等' : ''}，共 ${missingFiles.length} 个必需文件；已保留现有资源。` });
  return result('ready', { recognized: true });
}

module.exports = { REQUIRED, inspectVoiceInstallation };
