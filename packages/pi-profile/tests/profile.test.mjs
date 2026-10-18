import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkSavePaths, downloadMarkdown, globalProfilesDir, listGlobalProfiles, projectProfilePath, readProfile, registeredProfilePath, saveProfile, syncProfile, validateProfile } from '../profile.mjs';
import { fixture, put, read } from './profile-fixture.mjs';

const profile = () => ({
  plugins: ['npm:@example/diff', 'npm:search'],
  skills: [{ source: 'vercel-labs/agent-skills', skills: ['web-design-guidelines'] }],
  'AGENTS.md': 'https://example.com/AGENTS.md',
});
const absent = async path => assert.rejects(access(path), { code: 'ENOENT' });

test('validates the complete profile before side effects and deduplicates selections', () => {
  const p = profile();
  p.plugins.push(p.plugins[0]);
  p.skills[0].skills.push('web-design-guidelines');
  assert.deepEqual(validateProfile(p), profile());
  for (const invalid of [
    null, [], { plugins: [], skills: [], mcp: {} },
    { plugins: ['./extensions/local'], skills: [] },
    { plugins: ['npm:thing@1.0.0'], skills: [] },
    { plugins: ['--dangerous'], skills: [] },
    { plugins: [], skills: ['matt/*'] },
    { plugins: [], skills: [{ source: '../private', skills: ['read'] }] },
    { plugins: [], skills: [{ source: 'https://user:password@example.com/repo', skills: ['read'] }] },
    { plugins: [], skills: [{ source: 'owner/repo', skills: ['../escape'] }] },
    { plugins: [], skills: [{ source: 'owner/repo', skills: ['*'] }] },
    { plugins: [], skills: [{ source: 'owner/repo', skills: ['read'], other: true }] },
    { plugins: [], skills: [{ source: 'owner/repo', skills: ['read'] }, { source: 'another/repo', skills: ['read'] }] },
    { plugins: [], skills: [], 'AGENTS.md': 'prompts/local.md' },
    { plugins: [], skills: [], 'AGENTS.md': 'http://example.com/AGENTS.md' },
  ]) assert.throws(() => validateProfile(invalid), undefined, JSON.stringify(invalid));
});

test('registered global profiles are JSON templates only; project/global files are never overwritten', async t => {
  const f = await fixture(t);
  await saveProfile({ ...f, profile: profile(), globalName: 'web-project' });
  assert.deepEqual(await readProfile(projectProfilePath(f.cwd)), profile());
  assert.deepEqual(await listGlobalProfiles(f.agentDir), ['web-project']);
  assert.deepEqual(await read(registeredProfilePath(f.agentDir, 'web-project')), profile());
  assert.deepEqual(f.calls, []);
  await assert.rejects(saveProfile({ ...f, profile: profile() }), /already exists/);
  const second = join(f.root, 'second');
  await mkdir(second);
  await assert.rejects(saveProfile({ ...f, cwd: second, profile: profile(), globalName: 'web-project' }), /already exists/);
  await absent(projectProfilePath(second));
  assert.deepEqual(await read(join(f.agentDir, 'settings.json')), { packages: ['npm:unrelated'], defaultModel: 'keep' });
  for (const name of ['../escape', 'A Name', '', 'x'.repeat(65)]) assert.throws(() => registeredProfilePath(f.agentDir, name));
});

test('oversized profile JSON is rejected both when saving and reading', async t => {
  const f = await fixture(t);
  const huge = { plugins: [], skills: [{ source: `https://example.com/${'x'.repeat(1024 * 1024)}`, skills: ['example'] }] };
  await assert.rejects(saveProfile({ ...f, profile: huge }), /exceeds 1 MiB/);
  await absent(projectProfilePath(f.cwd));
  await put(projectProfilePath(f.cwd), huge);
  await assert.rejects(readProfile(projectProfilePath(f.cwd)), /exceeds 1 MiB/);
  assert.deepEqual(f.calls, []);
});

test('registry listing ignores other files/directories and a missing registry is empty', async t => {
  const f = await fixture(t);
  assert.deepEqual(await listGlobalProfiles(f.agentDir), []);
  await put(registeredProfilePath(f.agentDir, 'z-last'), { plugins: [], skills: [] });
  await put(registeredProfilePath(f.agentDir, 'a-first'), { plugins: [], skills: [] });
  await put(join(globalProfilesDir(f.agentDir), 'README.md'), 'ignore');
  await mkdir(join(globalProfilesDir(f.agentDir), 'a-directory.json'));
  assert.deepEqual(await listGlobalProfiles(f.agentDir), ['a-first', 'z-last']);
});

test('sync installs project packages and copies skills locally, preserving personal and project settings', async t => {
  const f = await fixture(t);
  await saveProfile({ ...f, profile: profile() });
  await put(join(f.cwd, '.pi/settings.json'), { defaultModel: 'mine', packages: ['npm:unrelated-project'] });
  const result = await syncProfile({ ...f, download: async () => '# Instructions\n' });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[0].args, ['install', 'npm:@example/diff', '--local']);
  const skills = f.calls[2];
  assert.deepEqual(skills.args, ['--yes', 'skills', 'add', 'vercel-labs/agent-skills', '--skill', 'web-design-guidelines', '--agent', 'pi', '--copy', '--yes']);
  assert.ok(f.calls.every(c => c.options.cwd === f.cwd));
  assert.ok(!f.calls.some(c => c.args.includes('--global') || c.args.includes('-g')));
  assert.equal((await read(join(f.cwd, '.pi/settings.json'))).defaultModel, 'mine');
  assert.equal(await readFile(join(f.cwd, 'AGENTS.md'), 'utf8'), '# Instructions\n');
  assert.equal(await readFile(join(f.agentDir, 'auth.json'), 'utf8'), 'private credentials');
  assert.deepEqual(await read(join(f.agentDir, 'settings.json')), { packages: ['npm:unrelated'], defaultModel: 'keep' });
  assert.ok(result.includes('Downloaded project AGENTS.md.'));
  const again = await syncProfile({ ...f, download: async () => { throw new Error('must not fetch existing instructions'); } });
  assert.ok(again.some(line => line.startsWith('Skipped existing skill:')));
  assert.ok(again.some(line => line.startsWith('Skipped existing AGENTS.md')));
});

test('existing instructions, dangling links and local skills are skipped without overwriting', async t => {
  const f = await fixture(t);
  await saveProfile({ ...f, profile: { plugins: [], skills: profile().skills, 'AGENTS.md': profile()['AGENTS.md'] } });
  await symlink(join(f.root, 'missing'), join(f.cwd, 'AGENTS.md'));
  await put(join(f.cwd, '.pi/skills/web-design-guidelines/SKILL.md'), 'my edited skill');
  const result = await syncProfile({ ...f, download: async () => { throw new Error('must not fetch'); } });
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(join(f.cwd, '.pi/skills/web-design-guidelines/SKILL.md'), 'utf8'), 'my edited skill');
  assert.equal(result.length, 2);
});

test('unsafe project links are rejected before downloads or package operations', async t => {
  for (const name of ['.pi', '.agents']) {
    const f = await fixture(t);
    await symlink(f.agentDir, join(f.cwd, name), 'dir');
    await assert.rejects(checkSavePaths(f), /symlink/);
    assert.deepEqual(f.calls, []);
  }
  const f = await fixture(t);
  await symlink(f.cwd, globalProfilesDir(f.agentDir), 'dir');
  await assert.rejects(saveProfile({ ...f, profile: profile(), globalName: 'unsafe' }), /symlink/);
  await absent(projectProfilePath(f.cwd));
});

test('bad Markdown or command failures never report a successful complete install', async t => {
  const f = await fixture(t);
  await saveProfile({ ...f, profile: profile() });
  await assert.rejects(syncProfile({ ...f, download: async () => { throw new Error('HTTP 404'); } }), /HTTP 404/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(syncProfile({ ...f, download: async () => '# ok', run: async () => ({ code: 2, stderr: 'network failed' }) }), /Earlier successful installs are kept/);
  await absent(join(f.cwd, 'AGENTS.md'));
  await assert.rejects(syncProfile({ ...f, download: async () => '# ok', run: async () => ({ code: 0 }) }), /did not install/);
});

test('Markdown download enforces HTTPS, status, redirects, content type, size and nonempty content', async () => {
  const source = 'https://example.com/AGENTS.md';
  assert.equal(await downloadMarkdown(source, async () => new Response('# Hello')), '# Hello');
  let calls = 0;
  assert.equal(await downloadMarkdown(source, async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: '/raw.md' } })
    : new Response('# Redirected')), '# Redirected');
  for (const response of [
    () => new Response('missing', { status: 404 }),
    () => new Response('<html>not markdown</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response(' '.repeat(10)),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => new Response(null, { status: 302, headers: { location: 'http://example.com/plaintext' } }),
    () => new Response(null, { status: 302, headers: { location: '/loop' } }),
  ]) await assert.rejects(downloadMarkdown(source, async () => response()));
  await assert.rejects(downloadMarkdown('http://example.com/no', async () => { throw new Error('not reached'); }), /HTTPS/);
});

test('package manifests publish only the intended extension entry points', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const workspace = await read(join(root, '../../package.json'));
  assert.equal(workspace.private, true);
  assert.deepEqual(workspace.workspaces, ['packages/*']);
  assert.equal(workspace.pi, undefined);
  const main = await read(join(root, 'package.json'));
  assert.equal(main.name, '@yama-lei/pi-profile');
  assert.deepEqual(main.pi, { extensions: ['./index.ts'] });
  assert.deepEqual(main.files, ['*.mjs', 'index.ts', 'profiles', 'README.md']);
  for (const entry of main.pi.extensions) await access(join(root, entry));
  assert.equal(main.publishConfig.access, 'public');
  assert.equal(main.private, undefined);
  assert.ok(!main.dependencies);
  const better = await read(join(root, '../pi-better-ai/package.json'));
  assert.equal(better.name, '@yama-lei/pi-better-ai');
  assert.equal(better.publishConfig.access, 'public');
  assert.equal(better.private, undefined);
});

test('howaboua separates its 13 extensions from 15 explicitly selected source skills', async () => {
  const selected = await readProfile(fileURLToPath(new URL('../profiles/howaboua.json', import.meta.url)));
  assert.equal(selected.plugins.length, 13);
  assert.ok(!selected.plugins.some(plugin => /^npm:@howaboua\/pi-(stuff|extensions|skills|skill-.*)$/.test(plugin)));
  const sourceRoot = 'https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/';
  assert.deepEqual(selected.skills.map(entry => entry.source), [
    `${sourceRoot}pi-skill-chrome-cdp`,
    `${sourceRoot}pi-skill-code`,
    `${sourceRoot}pi-skill-foundations`,
    `${sourceRoot}pi-skill-harness-and-agent-engineering`,
  ]);
  assert.deepEqual(selected.skills.flatMap(entry => entry.skills).sort(), [
    'agent-session-diagnostics', 'agent-tool-design', 'agents-md', 'chrome-cdp', 'code-review',
    'codebase-hygiene', 'communication', 'extension-design', 'harness-checklist',
    'instruction-calibration', 'project-reference-research', 'prompt-caching',
    'repository-delivery', 'scratchpad', 'skill-creator',
  ]);
});

test('the four upstream examples validate and install only their declared project resources', async t => {
  const root = fileURLToPath(new URL('../profiles/', import.meta.url));
  const examples = {
    'ben-vargas.json': '@benvargas/',
    'gotgenes.json': '@gotgenes/',
    'howaboua.json': '@howaboua/',
    'narumiruna.json': '@narumitw/',
  };
  assert.deepEqual((await readdir(root)).filter(file => file.endsWith('.json')).sort(), Object.keys(examples));
  for (const [file, scope] of Object.entries(examples)) await t.test(file, async t => {
    const selected = await readProfile(join(root, file));
    assert.deepEqual(selected, await read(join(root, file)));
    assert.ok(selected.plugins.length > 0);
    assert.ok(selected.plugins.every(plugin => plugin.startsWith(`npm:${scope}`)));
    const f = await fixture(t);
    await syncProfile({ ...f, profile: selected });
    assert.deepEqual(f.calls.map(call => [call.command, call.args]), [
      ...selected.plugins.map(plugin => ['pi', ['install', plugin, '--local']]),
      ...selected.skills.map(entry => ['npx', ['--yes', 'skills', 'add', entry.source,
        '--skill', ...entry.skills, '--agent', 'pi', '--copy', '--yes']]),
    ]);
    for (const entry of selected.skills) for (const name of entry.skills) {
      await access(join(f.cwd, '.agents', 'skills', name, 'SKILL.md'));
    }
    assert.deepEqual(await read(join(f.cwd, '.pi/settings.json')), { packages: selected.plugins });
    assert.deepEqual(await listGlobalProfiles(f.agentDir), []);
    assert.deepEqual(await read(join(f.agentDir, 'settings.json')), { packages: ['npm:unrelated'], defaultModel: 'keep' });
    await absent(join(f.cwd, 'AGENTS.md'));
  });
});
