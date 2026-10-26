/** Audit the formal NSIS installer against the verified release without installing over a user's app. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const output = path.resolve(root, manifest.build.directories.output);
const artifacts = path.join(root, 'artifacts', `validation-v${manifest.version}`);
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const artifactName = target => {
  const name = manifest.build[target].artifactName.replaceAll('${version}', manifest.version);
  assert.equal(path.basename(name), name); assert.ok(!name.includes('${'));
  return name;
};
const filename = artifactName('nsis'), executable = path.join(output, filename);
const portable = JSON.parse(fs.readFileSync(path.join(artifacts, 'release-check.json'), 'utf8'));
assert.equal(process.platform, 'win32', 'This verifier audits the Windows release');
assert.equal(portable.version, manifest.version, 'The portable report is for another release');
assert.equal(portable.electron, manifest.devDependencies.electron);
assert.equal(portable.executable, relative(path.join(output, artifactName('portable'))));
assert.equal(digest(path.join(root, portable.executable)), portable.sha256, 'Verify the current portable release first');
assert.equal(portable.exactFileList, true); assert.equal(portable.exactSourceBytes, true);
assert.equal(portable.recordings, 54); assert.equal(portable.originalAudioBytes, true);
assert.equal(portable.excludesOtherArtifacts, true); assert.equal(portable.processes.previousInstancesPreserved, true);
assert.deepEqual(portable.processes.newRemainingProcesses, []);
assert.ok(portable.smoke.modes.includes('chat') && portable.smoke.modes.includes('portable-relaunch'));
for (const [file, sha256] of Object.entries(portable.fileHashes)) assert.equal(digest(path.join(root, file)), sha256, `Source changed after portable verification: ${file}`);

fs.mkdirSync(artifacts, { recursive: true });
const inspection = fs.mkdtempSync(path.join(artifacts, 'setup-inspection-'));
const sevenZip = require.resolve('electron-winstaller/vendor/7z.exe');
const run = args => execFileSync(sevenZip, args, { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
run(['e', executable, '$PLUGINSDIR/app-64.7z', '-o' + inspection, '-y']);
const payload = path.join(inspection, 'app-64.7z');
const listing = run(['l', '-slt', payload]);
const separator = listing.indexOf('----------');
assert.ok(separator >= 0, 'Cannot inspect the installer payload');
const payloadFiles = listing.slice(separator).split(/\r?\n/).filter(line => line.startsWith('Path = ')).map(line => line.slice(7));
assert.ok(payloadFiles.length > 0);
assert.ok(!payloadFiles.some(file => file.split(/[/\\]/).some(part => /^(artifacts|skin-oldbase(?:-|$)|daily-voice-preview|interaction-voice-preview)/i.test(part))), 'Installer includes private drafts or unapproved skin');
const appExecutableName = `${manifest.productName}.exe`;
run(['x', payload, 'resources/*', appExecutableName, '-o' + inspection, '-y']);
assert.equal(digest(path.join(inspection, appExecutableName)), portable.appExecutableSha256, 'Installer application executable differs from verified portable');
assert.equal(digest(path.join(output, 'win-unpacked', appExecutableName)), portable.appExecutableSha256, 'Directory executable changed after portable verification');
const resources = path.join(inspection, 'resources'), directoryResources = path.join(output, 'win-unpacked', 'resources');
const actual = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else { assert.ok(entry.isFile()); actual.push(path.relative(resources, full).replaceAll('\\', '/')); }
  }
}
walk(resources);
assert.deepEqual(actual.sort(), Object.keys(portable.resourceHashes).sort(), 'Installer resource allowlist differs');
for (const file of Object.keys(portable.resourceHashes)) {
  assert.equal(digest(path.join(resources, file)), portable.resourceHashes[file], `Installer differs: ${file}`);
  assert.equal(digest(path.join(directoryResources, file)), portable.resourceHashes[file], `Directory resource changed after portable verification: ${file}`);
}
const repository = new URL((typeof manifest.repository === 'string' ? manifest.repository : manifest.repository.url).replace(/^git\+/, ''));
assert.equal(repository.hostname, 'github.com');
const [owner, repo, ...extra] = repository.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
assert.ok(owner && repo && extra.length === 0);
const updateConfig = yaml.load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
const updateTarget = { provider: updateConfig.provider, owner: updateConfig.owner, repo: updateConfig.repo };
assert.deepEqual(updateTarget, { provider: 'github', owner, repo });
assert.deepEqual(updateTarget, portable.updateTarget);

// A combined build has one byte-identical win-unpacked directory. Its full
// desktop/voice/interaction/chat checks and portable process cleanup are already
// recorded above; rerunning that same directory would not exercise NSIS install.
const sha256 = digest(executable);
fs.writeFileSync(executable + '.sha256', `${sha256}  ${filename}\n`);
const report = { version: manifest.version, electron: manifest.devDependencies.electron,
  executable: relative(executable), bytes: fs.statSync(executable).size, sha256,
  installerMatchesVerifiedPortable: true, exactResources: actual.length, bundledVoiceAssets: true,
  sourceBytesMatchVerifiedPortable: true, recordings: 54, originalAudioBytes: true,
  updateTarget, excludesOtherArtifacts: true, inspection: relative(inspection),
  smoke: { inheritedFrom: relative(path.join(artifacts, 'release-check.json')), modes: portable.smoke.modes,
    directory: portable.smoke.directory, portable: portable.smoke.portable },
  processes: portable.processes, cleanWindowsInstallTested: false };
const reportFile = path.join(artifacts, 'setup-check.json');
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ version: report.version, executable: report.executable, bytes: report.bytes, sha256,
  exactResources: report.exactResources, installerMatchesVerifiedPortable: true, report: relative(reportFile) }));
