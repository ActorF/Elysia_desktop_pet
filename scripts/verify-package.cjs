/** Verifies the final Windows portable archive and runs isolated, hidden smoke tests without sending keys. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const output = path.resolve(root, manifest.build.directories.output);
const artifacts = path.join(root, 'artifacts');
const filename = manifest.build.portable.artifactName.replace('${version}', manifest.version);
const executable = path.join(output, filename);
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const relative = file => path.relative(root, file).replaceAll('\\', '/');

function command(program, args) {
  return execFileSync(program, args, { cwd: root, windowsHide: true, encoding: 'utf8' });
}

function desktopProcesses() {
  const query = "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.Name -match 'Elysia|爱莉希雅|electron' -or ($_.Name -eq 'powershell.exe' -and ($_.CommandLine -like '*legacy-hotkeys.ps1 -ParentProcessId*' -or $_.CommandLine -like '*typed-keys.ps1 -ParentProcessId*' -or $_.CommandLine -like '*taskbar-order.ps1*' -or $_.CommandLine -like '*voice-environment.ps1*'))) } | Select-Object ProcessId,Name) -Depth 3";
  return JSON.parse(command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query]));
}

function filesWithin(directory) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `Unexpected resource link: ${file}`);
      if (entry.isDirectory()) visit(file);
      else { assert.ok(entry.isFile(), `Unexpected resource entry: ${file}`); files.push(path.relative(directory, file).replaceAll('\\', '/')); }
    }
  }
  visit(directory); return files.sort();
}

function excludesPrivateArtifacts(files, label) {
  assert.ok(!files.some(file => file.split(/[/\\]/).some(part => /^(artifacts|skin-oldbase(?:-|$)|daily-voice-preview|interaction-voice-preview)/i.test(part))), `${label} includes local drafts or the unapproved skin`);
}

function verifyAudioPack(pack, directories) {
  const source = path.join(root, 'assets', pack.folder), mapFile = path.join(source, 'final-audio-map.json');
  const mapBytes = fs.readFileSync(mapFile), map = JSON.parse(mapBytes);
  assert.equal(map.status, 'confirmed', `${pack.folder} is not approved`);
  assert.equal(map.confirmedBy, 'user'); assert.equal(map.confirmedCount, pack.ids.length);
  assert.ok(Array.isArray(map.lines)); assert.equal(map.lines.length, pack.ids.length);
  assert.deepEqual(map.lines.map(line => line.id).sort(), [...pack.ids].sort(), `${pack.folder} must contain every approved ID exactly once`);
  const expectedFiles = ['final-audio-map.json', ...pack.ids.map(id => `audio-final/${id}.wav`)].sort();
  const allDirectories = [source, ...directories.map(directory => path.join(directory, pack.folder))];
  for (const directory of allDirectories) {
    assert.deepEqual(fs.readdirSync(directory).sort(), ['audio-final', 'final-audio-map.json'], `Unexpected ${pack.folder} contents`);
    assert.deepEqual(filesWithin(directory), expectedFiles, `Unexpected ${pack.folder} recording allowlist`);
    assert.ok(fs.readFileSync(path.join(directory, 'final-audio-map.json')).equals(mapBytes), `Changed confirmation map: ${directory}`);
  }
  const hashes = {};
  for (const line of map.lines) {
    assert.equal(line.currentPath, `audio-final/${line.id}.wav`, `Invalid recording path: ${line.id}`);
    assert.match(line.currentSha256, /^[a-f0-9]{64}$/);
    assert.equal(line.currentSha256, line.originalSha256, `Original recording changed: ${line.id}`);
    const metadata = pack.catalog.get(line.id);
    assert.ok(metadata, `Missing catalog entry: ${line.id}`);
    assert.equal(line.text, metadata.text); assert.equal(line.groupId, metadata.groupId);
    const original = fs.readFileSync(path.join(source, line.currentPath));
    assert.equal(digest(original), line.currentSha256, `Source recording hash mismatch: ${line.id}`);
    for (const directory of allDirectories.slice(1)) {
      const bytes = fs.readFileSync(path.join(directory, line.currentPath));
      assert.equal(digest(bytes), line.currentSha256, `Bundled recording hash mismatch: ${directory}/${line.id}`);
      assert.ok(bytes.equals(original), `Bundled recording bytes changed: ${directory}/${line.id}`);
    }
    hashes[line.id] = line.currentSha256;
  }
  return { folder: pack.folder, recordings: pack.ids.length, confirmedBy: map.confirmedBy, originalAudioBytes: true,
    mapSha256: digest(mapBytes), fileHashes: hashes, resourceFiles: expectedFiles.map(file => `${pack.folder}/${file}`) };
}

function smoke(program, consoleRequired, flag, resultKey) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(program, [flag], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      if (settled) return; settled = true;
      // This PID belongs to this verifier; terminate only its own timed-out tree.
      try { command('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']); } catch { child.kill(); }
      reject(new Error(`${flag} exceeded 90 seconds\n${stdout}\n${stderr}`));
    }, 90000);
    child.on('error', error => { if (settled) return; settled = true; clearTimeout(timeout); reject(error); });
    child.on('close', exitCode => {
      if (settled) return; settled = true;
      clearTimeout(timeout);
      try {
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
        assert.equal(exitCode, 0, output);
        const results = stdout.split(/\r?\n/).flatMap(line => { try { const value = JSON.parse(line.trim()); return value && typeof value === 'object' && Object.hasOwn(value, resultKey) ? [value] : []; } catch { return []; } });
        const result = results.at(-1) ?? null;
        if (consoleRequired) assert.ok(result, `${flag} did not report its ${resultKey} JSON on stdout`);
        if (result) {
          assert.equal(result[resultKey], 'ok');
          if (Object.hasOwn(result, 'passed')) assert.equal(result.passed, true);
          if (resultKey === 'voiceSmoke') assert.equal(result.recordings, 54);
        }
        resolve({ flag, exitCode, result, stdout, stderr, output });
      } catch (error) { reject(error); }
    });
  });
}

(async () => {
  assert.equal(process.platform, 'win32', 'This verifier starts a Windows desktop executable');
  fs.mkdirSync(artifacts, { recursive: true });
  // A fresh inspection directory prevents earlier extractions from masking an
  // absent payload file without deleting any previous diagnostic artifacts.
  const inspection = fs.mkdtempSync(path.join(artifacts, 'package-inspection-'));
  // electron-builder installs electron-winstaller, whose full 7-Zip build can
  // read NSIS containers as well as their embedded 7z payloads.
  const sevenZip = require.resolve('electron-winstaller/vendor/7z.exe');
  command(sevenZip, ['e', executable, '$PLUGINSDIR\\app-64.7z', `-o${inspection}`, '-y']);
  const payload = path.join(inspection, 'app-64.7z');
  const listing = command(sevenZip, ['l', '-slt', payload]), separator = listing.indexOf('----------');
  assert.ok(separator >= 0, 'Cannot inspect the portable payload file list');
  const payloadFiles = listing.slice(separator).split(/\r?\n/).filter(line => line.startsWith('Path = ')).map(line => line.slice(7));
  assert.ok(payloadFiles.length > 0, 'Portable payload is empty');
  excludesPrivateArtifacts(payloadFiles, 'Portable payload');
  command(sevenZip, ['x', payload, 'resources/*', `-o${inspection}`, '-y']);
  const archive = path.join(inspection, 'resources/app.asar');
  const expected = [...new Set(manifest.build.files.flatMap(pattern => fs.globSync(pattern, { cwd: root })))]
    .filter(file => fs.statSync(path.join(root, file)).isFile()).map(file => file.replaceAll('\\', '/')).sort();
  const actual = asar.listPackage(archive).map(file => file.replace(/^[/\\]/, '').replaceAll('\\', '/'))
    .filter(file => !asar.statFile(archive, path.normalize(file)).files).sort();
  assert.deepEqual(actual, expected, 'Final EXE contains missing or unexpected files');
  excludesPrivateArtifacts(actual, 'Application archive');

  const hashes = {};
  for (const file of expected.filter(file => file !== 'package.json')) {
    const source = fs.readFileSync(path.join(root, file));
    assert.ok(source.equals(asar.extractFile(archive, path.normalize(file))), `Packaged bytes differ: ${file}`);
    hashes[file] = digest(source);
  }
  const packagedManifest = JSON.parse(asar.extractFile(archive, 'package.json'));
  for (const key of ['version', 'license', 'repository']) assert.deepEqual(packagedManifest[key], manifest[key]);
  assert.ok(fs.readFileSync(archive).equals(fs.readFileSync(path.join(output, 'win-unpacked/resources/app.asar'))), 'Portable and directory archives differ');

  const dailyCatalog = JSON.parse(fs.readFileSync(path.join(root, 'renderer', 'voice-catalog.json'), 'utf8'));
  const interactionCatalog = JSON.parse(fs.readFileSync(path.join(root, 'renderer', 'interaction-catalog.json'), 'utf8'));
  const directoryResources = path.join(output, 'win-unpacked', 'resources'), portableResources = path.join(inspection, 'resources');
  const audioPacks = [
    { folder: 'voice', ids: Array.from({ length: 12 }, (_, group) => Array.from({ length: 3 }, (_, line) => `${String(group + 1).padStart(2, '0')}-${line + 1}`)).flat(),
      catalog: new Map(dailyCatalog.groups.flatMap(group => group.lines.map(line => [line.id, { ...line, groupId: group.id }]))) },
    { folder: 'interaction-voice', ids: ['H', 'P', 'A'].flatMap(prefix => Array.from({ length: 6 }, (_, index) => `${prefix}0${index + 1}`)),
      catalog: new Map(interactionCatalog.map(line => [line.id, line])) },
  ].map(pack => verifyAudioPack(pack, [directoryResources, portableResources]));
  const unpacked = actual.filter(file => asar.statFile(archive, path.normalize(file)).unpacked).map(file => `app.asar.unpacked/${file}`);
  // electron-builder bundles its NSIS elevation helper alongside app resources.
  const expectedResources = ['app.asar', 'elevate.exe', ...unpacked, ...audioPacks.flatMap(pack => pack.resourceFiles)].sort();
  const resourceFiles = filesWithin(directoryResources);
  assert.deepEqual(resourceFiles, expectedResources, 'Directory build has missing or unexpected resources');
  assert.deepEqual(filesWithin(portableResources), expectedResources, 'Portable resources differ from the directory allowlist');
  excludesPrivateArtifacts(resourceFiles, 'Packaged resources');
  const resourceHashes = {};
  for (const file of resourceFiles) {
    const bytes = fs.readFileSync(path.join(directoryResources, file));
    assert.ok(bytes.equals(fs.readFileSync(path.join(portableResources, file))), `Portable and directory resource bytes differ: ${file}`);
    resourceHashes[file] = digest(bytes);
  }

  const before = desktopProcesses();
  const modes = [
    { name: 'desktop', flag: '--smoke-test', key: 'smoke' },
    { name: 'voice', flag: '--voice-smoke-test', key: 'voiceSmoke' },
    { name: 'interaction', flag: '--interaction-smoke-test', key: 'interactionSmoke' },
  ];
  const directory = {}, portable = {}, smokeLog = [];
  // All six runs are sequential. NSIS forwards exit status, not child stdout.
  for (const build of [
    { name: 'Directory', program: path.join(output, 'win-unpacked', `${manifest.productName}.exe`), consoleRequired: true, results: directory },
    { name: 'Portable', program: executable, consoleRequired: false, results: portable },
  ]) for (const mode of modes) {
    const result = await smoke(build.program, build.consoleRequired, mode.flag, mode.key);
    build.results[mode.name] = result;
    smokeLog.push(`${build.name} ${mode.flag} (exit ${result.exitCode}):\n${result.output}`);
    fs.writeFileSync(path.join(artifacts, 'package-smoke.log'), smokeLog.join('\n\n'));
  }
  const after = desktopProcesses();
  const previousIds = new Set(before.map(process => process.ProcessId));
  const newRemainingProcesses = after.filter(process => !previousIds.has(process.ProcessId));
  assert.deepEqual(newRemainingProcesses, [], 'A smoke process remained after exit');
  assert.ok(before.every(process => after.some(current => current.ProcessId === process.ProcessId)), 'The previous desktop process set changed during verification');

  const exeHash = digest(fs.readFileSync(executable));
  const report = {
    version: manifest.version, electron: manifest.devDependencies.electron,
    executable: relative(executable), bytes: fs.statSync(executable).size, sha256: exeHash,
    runtimeFiles: expected.filter(file => /^(electron|renderer)\//.test(file)),
    assetFiles: expected.filter(file => file.startsWith('assets/')),
    licenseFiles: expected.filter(file => ['LICENSE', 'ASSET-NOTICE.md'].includes(file)),
    exactFileList: true, exactSourceBytes: true, fileHashes: hashes,
    recordings: 54, dailyRecordings: 36, interactionRecordings: 18, originalAudioBytes: true, audioPacks,
    portableMatchesDirectory: true, excludesOtherArtifacts: true, resourceHashes, inspection: relative(inspection),
    smoke: { directoryExitCode: directory.desktop.exitCode, portableExitCode: portable.desktop.exitCode,
      renderer: directory.desktop.result.renderer, desktopChecks: directory.desktop.result.desktopChecks, security: directory.desktop.result.security,
      directory, portable, runs: 6, portableLogNote: 'The byte-identical directory build supplies detailed desktop, voice and interaction JSON; NSIS forwards each portable smoke child exit code.' },
    processes: { previousCount: before.length, previousInstancesPreserved: true, newRemainingProcesses },
    syntheticGlobalInput: false,
  };
  fs.writeFileSync(path.join(artifacts, 'release-check.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(executable + '.sha256', `${exeHash}  ${filename}\n`);
  console.log(JSON.stringify({ executable: report.executable, bytes: report.bytes, sha256: exeHash, runtimeFiles: report.runtimeFiles.length, pngFiles: report.assetFiles.filter(file => file.endsWith('.png')).length, licenseFiles: report.licenseFiles, recordings: 54, smokeRuns: 6, smoke: 'passed', report: 'artifacts/release-check.json' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
