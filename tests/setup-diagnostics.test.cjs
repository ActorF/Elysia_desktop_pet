'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSetupDiagnostic, classifySetupFailure, DEFINITIONS } = require('../electron/setup-diagnostics.cjs');

const allowedStages = new Set(['inspection', 'download', 'verify', 'extract', 'validate', 'start', 'storage']);
const diagnosticKinds = ['network-dns', 'network-connect', 'network-tls', 'network-timeout', 'network-idle-timeout',
  'network-total-timeout', 'network-http', 'network-redirect', 'network-range', 'network-truncated', 'network-unknown',
  'integrity-size', 'integrity-hash', 'storage-space', 'storage-permission', 'storage-busy', 'storage-path', 'storage-io'];

test('every catalog entry has a unique stable code, actionable text and an explicit retry decision', () => {
  const codes = new Set();
  for (const [kind, definition] of Object.entries(DEFINITIONS)) {
    assert.equal(definition.length, 5, kind);
    const [code, stage, summary, action, retryable] = definition;
    assert.match(code, /^[A-Z]+-\d{3}$/); assert.equal(codes.has(code), false, `duplicate code ${code}`); codes.add(code);
    assert.equal(allowedStages.has(stage), true); assert.equal(typeof retryable, 'boolean');
    assert.ok(typeof summary === 'string' && summary.trim().length > 4);
    assert.ok(typeof action === 'string' && action.trim().length > 4);
    assert.deepEqual(createSetupDiagnostic('voice', kind), { code, scope: 'voice', stage, summary, action, retryable, details: {} });
  }
});

test('every downloader diagnosis maps without becoming a generic setup error', () => {
  for (const kind of diagnosticKinds) {
    const error = Object.assign(new Error('private transport error'), { setupCode: kind.startsWith('storage-') ? 'storage' : 'download', diagnosticKind: kind });
    assert.equal(classifySetupFailure(error), kind);
    assert.equal(createSetupDiagnostic('chat', kind).code, DEFINITIONS[kind][0]);
    assert.notEqual(createSetupDiagnostic('chat', kind).code, 'SETUP-999');
  }
});

test('unknown kinds and inherited object keys remain a safe unknown diagnosis', () => {
  for (const kind of [undefined, null, '', 'not-a-known-kind', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(createSetupDiagnostic('chat', kind).code, 'SETUP-999');
    assert.equal(classifySetupFailure({ diagnosticKind: kind }), 'unknown');
    assert.equal(classifySetupFailure({}, kind), 'unknown');
  }
  assert.equal(createSetupDiagnostic('voice', 'installation-invalid-manifest').code, 'PKG-101');
});

test('diagnosis uses explicit metadata and system codes rather than guessing from error messages', () => {
  for (const message of ['ENOSPC disk full', 'Permission denied EACCES', 'HTTP 403', 'CERT_HAS_EXPIRED', 'DNS ENOTFOUND',
    'Out of memory', 'corrupt SHA256', 'C:\\Users\\Private\\token.txt']) {
    assert.equal(classifySetupFailure(new Error(message)), 'unknown');
  }
  assert.equal(classifySetupFailure({ cause: { message: 'ENOSPC' } }, 'extraction-exit'), 'extraction-exit');
  assert.equal(classifySetupFailure(null), 'unknown');
  assert.equal(classifySetupFailure('EACCES'), 'unknown');
});

test('nested filesystem evidence and memory errors receive specific classifications', () => {
  for (const [code, expected] of [['ENOSPC', 'storage-space'], ['EDQUOT', 'storage-space'], ['EACCES', 'storage-permission'],
    ['EPERM', 'storage-permission'], ['EROFS', 'storage-permission'], ['EBUSY', 'storage-busy'], ['ETXTBSY', 'storage-busy'],
    ['EEXIST', 'storage-busy'], ['ENOENT', 'storage-path'], ['ENOTDIR', 'storage-path'], ['EISDIR', 'storage-path'],
    ['ENAMETOOLONG', 'storage-path'], ['ELOOP', 'storage-path'], ['EINVAL', 'storage-path'], ['EIO', 'storage-io'], ['ENOMEM', 'memory-unavailable']]) {
    assert.equal(classifySetupFailure(new Error('outer', { cause: new Error('inner', { cause: { code } }) })), expected, code);
  }
  assert.equal(classifySetupFailure({ code: 'EACCES', cause: { code: 'ENOSPC' } }), 'storage-space', 'disk-full evidence takes precedence over a general access error');
  assert.equal(classifySetupFailure({ diagnosticKind: 'validation-exit', cause: { code: 'EACCES' } }), 'validation-exit', 'explicit operation diagnosis remains authoritative');
  for (const generic of ['unknown', 'network-unknown', 'storage-io', 'integrity-unknown']) {
    assert.equal(classifySetupFailure({ diagnosticKind: generic, cause: { code: 'ENOSPC' } }), 'storage-space', `${generic} must not hide confirmed disk exhaustion`);
    assert.equal(classifySetupFailure({ diagnosticKind: generic }), generic, 'keep the original fallback if there is no stronger evidence');
  }
});

test('cyclic or overly deep causes do not loop or accidentally expose nested payloads', () => {
  const cycle = { message: 'private' }; cycle.cause = cycle;
  assert.equal(classifySetupFailure(cycle), 'unknown');
  cycle.code = 'ENOSPC'; assert.equal(classifySetupFailure(cycle), 'storage-space');
  const chain = Array.from({ length: 7 }, () => ({}));
  for (let index = 0; index < chain.length - 1; index++) chain[index].cause = chain[index + 1];
  chain[6].code = 'ENOSPC'; assert.equal(classifySetupFailure(chain[0]), 'unknown', 'seventh node is outside the bounded inspection');
  chain[5].code = 'EACCES'; assert.equal(classifySetupFailure(chain[0]), 'storage-permission');
});

test('HTTP evidence distinguishes access, missing release files, throttling and server failures', () => {
  for (const [status, code, retryable] of [[401, 'NET-108', false], [403, 'NET-108', false], [404, 'NET-109', false],
    [410, 'NET-109', false], [429, 'NET-110', true], [500, 'NET-111', true], [502, 'NET-111', true], [503, 'NET-111', true],
    [599, 'NET-111', true], [408, 'NET-107', true]]) {
    const result = createSetupDiagnostic('voice', 'network-http', { httpStatus: status });
    assert.equal(result.code, code); assert.equal(result.retryable, retryable); assert.equal(result.details.httpStatus, status);
  }
  for (const status of ['503', 503.5, NaN, Infinity, 99, 600, {}, null]) {
    const result = createSetupDiagnostic('chat', 'network-http', { httpStatus: status });
    assert.equal(result.code, 'NET-107', `invalid HTTP evidence: ${String(status)}`);
    assert.equal(Object.hasOwn(result.details, 'httpStatus'), false);
  }
});

test('public diagnostic shape excludes raw errors, URLs, tokens, stacks and absolute paths', () => {
  const diagnostic = createSetupDiagnostic('voice', 'extraction-exit', {
    stage: 'extract', exitCode: 2, systemCode: 'EACCES', httpStatus: 403,
    missingFiles: ['python/python.exe', 'models\\voice.pth'], missingCount: 2,
    actualVersion: 1, expectedVersion: 2,
    requiredBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3,
    url: 'https://example.com/download?token=SECRET', token: 'SECRET', authorization: 'Bearer SECRET',
    stack: 'Error at C:\\Users\\Private\\source.js', message: 'SECRET', error: new Error('SECRET'),
    path: 'C:\\Users\\Private\\model', cause: { code: 'EACCES', token: 'SECRET' },
  });
  assert.deepEqual(Object.keys(diagnostic).sort(), ['action', 'code', 'details', 'retryable', 'scope', 'stage', 'summary']);
  assert.deepEqual(diagnostic.details, { httpStatus: 403, exitCode: 2, systemCode: 'EACCES',
    missingFiles: ['python/python.exe', 'models\\voice.pth'], missingCount: 2, actualVersion: 1, expectedVersion: 2,
    requiredBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|Private|https:|Bearer|source\.js/);
});

test('only bounded, relative resource names are included in missing-file details', () => {
  const safe = ['python/python.exe', 'models\\voice.pth', '资源/参考.wav',
    'runtime/Lib/site-packages/pandas/tests/io/data/legacy_pickle/1.2.4/empty_frame_v1_2_4-GH#42345.pkl'];
  const rejected = ['', '.', '..', '../private', 'models/../private', 'models\\..\\private', './private',
    '/etc/private', 'C:\\Users\\Private\\file', '\\\\server\\share\\file', '//server/share/file',
    'https://host/file?token=SECRET', 'downloads/file?token=SECRET', 'folder\\token=SECRET|file',
    'file\u0000secret', 'file\nsecret', 'double//slash', 'folder./file', 'folder /file', 'a'.repeat(241), null, 42];
  const result = createSetupDiagnostic('voice', 'installation-missing-files', { missingFiles: [...safe, ...rejected, ...safe], missingCount: safe.length });
  assert.deepEqual(result.details.missingFiles, safe);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|Private|private/);
  const many = createSetupDiagnostic('voice', 'installation-missing-files', { missingFiles: Array.from({ length: 40 }, (_, i) => `models/${i}.bin`) });
  assert.equal(many.details.missingFiles.length, 20);
});

test('invalid detail types and impossible counts are omitted instead of coerced', () => {
  for (const value of [-1, 201, 1.5, NaN, Infinity, '3', {}, null]) {
    const result = createSetupDiagnostic('voice', 'installation-missing-files', { missingCount: value });
    assert.equal(Object.hasOwn(result.details, 'missingCount'), false);
  }
  const result = createSetupDiagnostic('anything-private', 'unknown', {
    stage: 'SECRET', exitCode: 4294967296, httpStatus: '403', systemCode: 'EACCES C:\\Users\\Private',
    missingFiles: 'C:\\Users\\Private', missingCount: -4, actualVersion: '1', expectedVersion: 10001,
  });
  assert.equal(result.scope, 'chat'); assert.equal(result.stage, 'inspection'); assert.deepEqual(result.details, {});
  for (const exitCode of [-2147483648, 0, 2, 4294967295]) assert.equal(createSetupDiagnostic('chat', 'server-exit', { exitCode }).details.exitCode, exitCode);
  for (const context of [null, undefined, [], 'private']) assert.deepEqual(createSetupDiagnostic('chat', 'unknown', context).details, {});
});

test('storage byte details keep nonnegative safe integer boundaries and reject coercion or sensitive strings', () => {
  for (const value of [0, 1, 16 * 1024 ** 3, Number.MAX_SAFE_INTEGER]) {
    const diagnostic = createSetupDiagnostic('voice', 'storage-space', { requiredBytes: value, availableBytes: value });
    assert.deepEqual(diagnostic.details, { requiredBytes: value, availableBytes: value });
    assert.deepEqual(JSON.parse(JSON.stringify(diagnostic)).details, diagnostic.details);
  }
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, '0', 'https://private.invalid/?token=secret',
    null, undefined, true, false, [], {}, new Number(1), 1n]) {
    assert.deepEqual(createSetupDiagnostic('voice', 'storage-space', { requiredBytes: value, availableBytes: 0 }).details, { availableBytes: 0 });
    assert.deepEqual(createSetupDiagnostic('voice', 'storage-space', { requiredBytes: 0, availableBytes: value }).details, { requiredBytes: 0 });
  }
  const coercible = { valueOf() { assert.fail('byte counts must not coerce objects'); }, toString() { assert.fail('byte counts must not stringify objects'); } };
  assert.deepEqual(createSetupDiagnostic('voice', 'storage-space', { requiredBytes: coercible, availableBytes: coercible,
    directory: 'C:\\private', capacityBytes: 1024, freeDisk: 1024 }).details, {});
});
