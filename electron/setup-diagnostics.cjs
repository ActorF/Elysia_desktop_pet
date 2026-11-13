/** Stable, shareable setup diagnoses. Never expose URLs, credentials, stack traces or absolute paths. */
'use strict';
const STAGES = new Set(['inspection', 'download', 'verify', 'extract', 'validate', 'start', 'storage']);
const DEFINITIONS = Object.freeze({
  'network-dns': ['NET-101', 'download', '无法解析资源网站地址。', '确认网络可以访问资源网站后重试；已下载的部分会保留。', true],
  'network-connect': ['NET-102', 'download', '连接资源网站失败或连接中断。', '网络恢复后重试，程序会继续使用已下载的部分。', true],
  'network-tls': ['NET-103', 'download', '资源网站的安全连接验证失败。', '检查电脑时间和网络证书设置，再重试。不要关闭证书验证。', true],
  'network-timeout': ['NET-104', 'download', '连接资源网站超时。', '稍后重试；已下载的部分会保留。', true],
  'network-idle-timeout': ['NET-105', 'download', '资源下载长时间没有收到新数据。', '网络稳定后重试，程序会尝试继续下载。', true],
  'network-total-timeout': ['NET-106', 'download', '本次资源下载超过最长等待时间。', '重试以继续下载，保留现有下载缓存。', true],
  'network-http': ['NET-107', 'download', '资源服务器拒绝请求或暂时不可用。', '请将错误编号和 HTTP 状态提供给开发者；保留下载缓存。', true],
  'network-http-auth': ['NET-108', 'download', '资源服务器拒绝访问。', '请将此错误信息提供给开发者检查下载地址；无需提供账号密码。', false],
  'network-http-missing': ['NET-109', 'download', '资源服务器上未找到所需文件。', '请将错误信息提供给开发者检查发布资源；重复点击重试通常无法解决。', false],
  'network-http-rate': ['NET-110', 'download', '资源服务器暂时限制了请求频率。', '稍等一段时间再重试，保留下载缓存。', true],
  'network-http-server': ['NET-111', 'download', '资源服务器暂时发生错误。', '稍后重试；已下载的部分会保留。', true],
  'network-redirect': ['NET-112', 'download', '资源下载被转向未获允许的地址或返回了无效跳转。', '请提供此错误信息，让开发者核对资源下载源。', false],
  'network-range': ['NET-113', 'download', '资源服务器返回的断点续传范围不正确。', '请保留下载缓存并反馈错误信息，不必先删除整个模型。', false],
  'network-truncated': ['NET-114', 'download', '资源传输提前结束，文件尚未完整下载。', '重试以继续下载，已收到的内容会尽量复用。', true],
  'network-unknown': ['NET-199', 'download', '资源下载失败，具体网络原因尚未确认。', '复制错误信息反馈，保留现有资源和下载缓存。', true],
  'integrity-size': ['CHK-101', 'verify', '下载资源的大小与清单不一致。', '本次文件不会安装；可重试使用其他下载源。', true],
  'integrity-hash': ['CHK-102', 'verify', '下载资源的内容校验未通过。', '本次文件不会安装；可重试，程序会重新校验下载内容。', true],
  'integrity-unknown': ['CHK-199', 'verify', '资源校验未通过，具体原因尚未确认。', '保留错误信息并反馈，不要跳过资源校验。', true],
  'storage-space': ['FS-101', 'storage', '保存资源时磁盘空间不足。', '为资源所在磁盘腾出空间后重试；无需先删除已下载的模型。', true],
  'storage-permission': ['FS-102', 'storage', '没有权限读取或写入资源目录。', '检查目录访问权限和安全软件的拦截记录，再重试。', true],
  'storage-busy': ['FS-103', 'storage', '资源文件被占用，暂时无法替换或移动。', '关闭其他正在使用桌宠资源的程序后重试。', true],
  'storage-path': ['FS-104', 'storage', '资源路径不存在，或文件与目录类型不符合预期。', '检查安装目录是否被移动或改名，保留现有文件并反馈诊断。', false],
  'storage-io': ['FS-105', 'storage', '读取或保存资源时发生文件系统错误。', '检查磁盘状态与目录权限，并提供错误信息。', true],
  'installation-invalid-directory': ['ENV-101', 'inspection', '现有语音目录的文件结构不正确。', '保留原文件，提供诊断报告确认需要恢复的路径。', false],
  'installation-linked-directory': ['ENV-102', 'inspection', '语音目录包含链接，无法确认资源完整性。', '请提供诊断报告核对实际安装位置，不要直接覆盖链接指向的文件。', false],
  'installation-unreadable-directory': ['ENV-103', 'inspection', '无法读取现有语音目录或必需文件。', '检查访问权限和安全软件的拦截记录后重新检测。', false],
  'installation-missing-marker': ['ENV-104', 'inspection', '语音目录已存在，但缺少安装完成记录。', '可使用“修复语音环境”重新准备，已有下载包会优先复用，原目录会保留。', false],
  'installation-invalid-marker': ['ENV-105', 'inspection', '语音环境的安装完成记录损坏或格式无效。', '可使用“修复语音环境”，不要手工补造完成记录；原目录会保留。', false],
  'installation-unreadable-marker': ['ENV-106', 'inspection', '无法读取语音环境的安装完成记录。', '检查访问权限或安全软件拦截记录，再重新检测。', false],
  'installation-version-mismatch': ['ENV-107', 'inspection', '现有安装记录的格式版本与程序不匹配。', '可使用“修复语音环境”准备当前版本要求的环境，旧目录保留为备份。', false],
  'installation-resource-mismatch': ['ENV-108', 'inspection', '现有语音资源版本与程序要求不一致。', '可使用“修复语音环境”，程序会校验安装包并保留旧资源备份。', false],
  'installation-missing-files': ['ENV-109', 'inspection', '已识别本程序的语音环境，但有必需文件缺失。', '可使用“修复语音环境”恢复；也可检查安全软件隔离记录，恢复文件后重新检测。', false],
  'installation-conflict': ['ENV-110', 'inspection', '配置期间资源目录发生变化。', '退出其他配置进程后重新检测，已存在的文件会保留。', false],
  'manifest-invalid': ['PKG-101', 'inspection', '程序内的资源清单缺失或无效。', '核对程序版本和完整发布文件，将错误信息提供给开发者。', false],
  'resources-unavailable': ['PKG-102', 'inspection', '所需的本地资源包未找到。', '检查是否使用完整发布包，保留已安装模型和下载缓存。', false],
  'extractor-missing': ['PKG-103', 'extract', '程序所需的解压工具缺失。', '检查安全软件隔离记录及程序文件是否完整。', false],
  'extractor-integrity': ['PKG-104', 'verify', '程序内的解压工具校验未通过。', '不要运行被改动的工具；核对程序发布文件后再配置。', false],
  'runtime-source-missing': ['PKG-105', 'inspection', '程序内的聊天运行环境资源包缺失。', '检查程序发布文件是否完整，保留已有模型。', false],
  'runtime-source-integrity': ['PKG-106', 'verify', '程序内的聊天运行环境资源包校验失败。', '核对程序发布文件，保留已有模型及缓存。', false],
  'dependencies-source-missing': ['PKG-107', 'inspection', '程序内的运行库资源包缺失。', '检查程序发布文件及安全软件隔离记录。', false],
  'dependencies-source-integrity': ['PKG-108', 'verify', '程序内的运行库资源包校验失败。', '核对完整发布包，不要跳过资源校验。', false],
  'extractor-launch': ['EXT-101', 'extract', '无法启动语音资源解压工具。', '检查程序权限和安全软件的拦截记录。', true],
  'extraction-launch': ['EXT-102', 'extract', '无法启动资源解压进程。', '检查程序权限和安全软件的拦截记录。', true],
  'extraction-timeout': ['EXT-103', 'extract', '资源解压超过最长等待时间。', '检查磁盘可用空间与繁忙程度，保留下载缓存后重试。', true],
  'extraction-exit': ['EXT-104', 'extract', '资源解压进程异常结束。', '提供错误编号和退出代码；退出代码本身不代表一定是磁盘不足。', true],
  'extraction-output': ['EXT-105', 'extract', '压缩包的文件列表超出可处理范围。', '不要手工解压覆盖现有目录，请提供错误信息核对资源包。', false],
  'archive-unsafe': ['EXT-106', 'extract', '压缩包中发现不允许的路径、链接或重复文件。', '该资源未部署；请提供错误信息核对发布资源，不要跳过检查。', false],
  'archive-layout': ['EXT-107', 'extract', '解压结果缺少规定的文件或目录结构。', '保留资源缓存与错误信息，核对发布包。', false],
  'validation-launch': ['VAL-101', 'validate', '无法启动语音环境完整性检查。', '检查本地解释器文件及安全软件的拦截记录。', true],
  'validation-timeout': ['VAL-102', 'validate', '语音环境完整性检查超时。', '检查磁盘状态后重试；该步骤只检查资源，不启动语音模型。', true],
  'validation-exit': ['VAL-103', 'validate', '语音环境完整性检查未通过。', '提供错误信息与退出代码，保留下载缓存。', false],
  'validation-output': ['VAL-104', 'validate', '语音完整性检查未返回有效结果。', '提供错误信息核对运行环境，程序不会把未确认的资源标为就绪。', false],
  'platform-unsupported': ['RUN-101', 'inspection', '当前系统或处理器架构不受本地模型支持。', '当前本地环境需要 Windows x64。', false],
  'runtime-missing': ['RUN-102', 'inspection', '聊天运行环境缺少必需文件。', '检查旧版本遗留目录及安全软件隔离记录，再准备运行环境。', true],
  'runtime-invalid': ['RUN-103', 'inspection', '聊天运行环境的安装记录或文件无效。', '保留现有模型，核对旧版安装状态与资源版本。', true],
  'model-missing': ['RUN-104', 'inspection', '聊天模型文件尚未完整准备。', '已有下载缓存可继续使用；确认安装状态后继续准备模型。', true],
  'model-invalid': ['RUN-105', 'verify', '已有聊天模型的大小或校验记录不匹配。', '保留原模型，重新校验或确认是否导入了其他模型。', false],
  'dependencies-missing': ['RUN-106', 'inspection', '聊天运行环境缺少运行库文件。', '检查安全软件隔离记录并恢复应用运行库，不必先删除聊天模型。', true],
  'dependencies-invalid': ['RUN-107', 'verify', '聊天运行库文件未通过检查。', '核对运行库资源及安装目录，保留聊天模型。', true],
  'runtime-unavailable': ['RUN-108', 'validate', '本地运行环境暂时无法使用。', '提供错误信息核对依赖与运行环境，保留已有资源。', false],
  'runtime-marker-missing': ['RUN-109', 'inspection', '聊天运行文件已存在，但缺少安装完成记录。', '核对旧版本遗留的运行目录，保留已有模型和缓存。', true],
  'runtime-marker-invalid': ['RUN-110', 'inspection', '聊天运行环境的安装完成记录无效。', '提供诊断确认旧版安装状态，不要手工补造完成记录。', true],
  'runtime-resource-mismatch': ['RUN-111', 'inspection', '现有聊天运行环境与当前程序要求的版本不同。', '核对升级前后版本，保留原文件并按新版流程准备运行环境。', true],
  'model-marker-missing': ['RUN-112', 'inspection', '聊天模型文件已存在，但没有有效校验记录。', '保留模型文件，使用配置流程重新校验，无需先手动删除。', true],
  'model-marker-invalid': ['RUN-113', 'verify', '聊天模型的校验记录无效。', '重新校验现有模型，不要把未确认的文件手工标记为完成。', true],
  'model-resource-mismatch': ['RUN-114', 'verify', '现有聊天模型的校验记录对应其他资源版本。', '核对是否沿用旧模型或自行导入了其他模型，保留原文件。', true],
  'server-port-busy': ['RUN-201', 'start', '本地聊天服务端口 18434 已被其他进程占用。', '关闭冲突的旧桌宠或服务后重试；不要重新下载模型。', true],
  'server-launch': ['RUN-202', 'start', '无法启动本地聊天服务进程。', '检查运行文件、权限及安全软件拦截记录。', true],
  'server-exit': ['RUN-203', 'start', '本地聊天服务进程异常退出。', '提供退出代码，检查可用内存、运行库和显卡驱动状态。', true],
  'server-timeout': ['RUN-204', 'start', '本地聊天服务未在规定时间内就绪。', '等待系统负载降低后重试，已下载的模型会保留。', true],
  'server-protocol': ['RUN-205', 'start', '本地服务响应与预期的聊天模型不匹配。', '核对端口上的服务和模型，避免同时运行冲突的旧版服务。', false],
  'memory-unavailable': ['RUN-206', 'start', '系统报告可用内存不足。', '关闭占用内存较多的程序后重试，无需重新下载模型。', true],
  'preview-disabled': ['MODE-101', 'inspection', '本地测试模式不允许下载或安装资源。', '此模式只复用已有资源；请先查看已有环境的诊断结果。', false],
  'preview-resources': ['MODE-102', 'inspection', '本地测试所需的已有资源不完整。', '先核对现有安装状态；本地测试模式不会重新下载或安装。', false],
  unknown: ['SETUP-999', 'inspection', '配置失败，具体原因尚未确认。', '复制错误信息反馈，保留现有资源和下载缓存。', false],
});

function failureChain(error) {
  const chain = [], seen = new Set();
  while (error && typeof error === 'object' && chain.length < 6 && !seen.has(error)) { seen.add(error); chain.push(error); error = error.cause; }
  return chain;
}
function classifySetupFailure(error, fallbackKind = 'unknown') {
  const chain = failureChain(error);
  const known = chain.map(item => item.diagnosticKind).filter(kind => typeof kind === 'string' && Object.hasOwn(DEFINITIONS, kind));
  const specific = known.find(kind => !['unknown', 'network-unknown', 'storage-io', 'integrity-unknown'].includes(kind));
  if (specific) return specific;
  const codes = chain.map(item => item.code);
  if (codes.some(code => ['ENOSPC', 'EDQUOT'].includes(code))) return 'storage-space';
  if (codes.some(code => ['EACCES', 'EPERM', 'EROFS'].includes(code))) return 'storage-permission';
  if (codes.some(code => ['EBUSY', 'ETXTBSY', 'EEXIST'].includes(code))) return 'storage-busy';
  if (codes.some(code => ['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'ELOOP', 'EINVAL'].includes(code))) return 'storage-path';
  if (codes.includes('EIO')) return 'storage-io';
  if (codes.includes('ENOMEM')) return 'memory-unavailable';
  if (known.length) return known[0];
  return Object.hasOwn(DEFINITIONS, fallbackKind) ? fallbackKind : 'unknown';
}
const relativeFile = value => typeof value === 'string' && value.length > 0 && value.length <= 240
  && !/[\x00-\x1f\x7f:?*<>"|]/.test(value) && !/^[\\/]/.test(value)
  && value.replace(/\\/g, '/').split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
function createSetupDiagnostic(scope, kind, context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) context = {};
  if (kind === 'installation-invalid-manifest') kind = 'manifest-invalid';
  if (kind === 'network-http' && Number.isInteger(context.httpStatus)) {
    const status = context.httpStatus;
    if ([401, 403].includes(status)) kind = 'network-http-auth';
    else if ([404, 410].includes(status)) kind = 'network-http-missing';
    else if (status === 429) kind = 'network-http-rate';
    else if (status >= 500 && status <= 599) kind = 'network-http-server';
  }
  const [code, defaultStage, summary, action, retryable] = typeof kind === 'string' && Object.hasOwn(DEFINITIONS, kind) ? DEFINITIONS[kind] : DEFINITIONS.unknown;
  const details = {};
  if (Number.isInteger(context.httpStatus) && context.httpStatus >= 100 && context.httpStatus <= 599) details.httpStatus = context.httpStatus;
  if (Number.isInteger(context.exitCode) && context.exitCode >= -2147483648 && context.exitCode <= 4294967295) details.exitCode = context.exitCode;
  if (typeof context.systemCode === 'string' && /^(?:E[A-Z0-9_]{1,35}|UND_ERR_[A-Z_]{1,35})$/.test(context.systemCode)) details.systemCode = context.systemCode;
  if (Array.isArray(context.missingFiles)) details.missingFiles = [...new Set(context.missingFiles.filter(relativeFile))].slice(0, 20);
  if (Number.isInteger(context.missingCount) && context.missingCount >= 0 && context.missingCount <= 200) details.missingCount = context.missingCount;
  for (const key of ['requiredBytes', 'availableBytes']) if (Number.isSafeInteger(context[key]) && context[key] >= 0) details[key] = context[key];
  for (const key of ['actualVersion', 'expectedVersion']) if (Number.isSafeInteger(context[key]) && context[key] >= 0 && context[key] <= 10000) details[key] = context[key];
  return { code, scope: scope === 'voice' ? 'voice' : 'chat', stage: STAGES.has(context.stage) ? context.stage : defaultStage,
    summary, action, retryable, details };
}
module.exports = { createSetupDiagnostic, classifySetupFailure, DEFINITIONS };
