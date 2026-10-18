import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { projectProfilePath, registeredProfilePath, saveProfile } from '../profile.mjs';
import { setupPrompt } from '../setup.mjs';
import { fixture, put, read } from './profile-fixture.mjs';

const profile = { plugins: ['npm:search'], skills: [] };
const absent = async path => assert.rejects(access(path), { code: 'ENOENT' });
const command = (f, args) => f.commands.get('profile').handler(args, f.ctx);
const saveTool = (f, input, signal) => f.tools.get('profile_save').execute('call', input, signal, undefined, f.ctx);

test('init selects a global template, confirms, installs locally, and reloads automatically', async t => {
  const f = await fixture(t);
  await put(registeredProfilePath(f.agentDir, 'web'), profile);
  await command(f, 'init');
  assert.deepEqual(await read(projectProfilePath(f.cwd)), profile);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reloads(), 1);
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].message, /current project only/);
  assert.deepEqual(await read(registeredProfilePath(f.agentDir, 'web')), profile);
});

test('init with no templates offers the same LLM setup as the dedicated command', async t => {
  const f = await fixture(t);
  await command(f, 'init');
  assert.match(f.messages[0].content, /profile_save/);
  assert.deepEqual(f.calls, []);
  await absent(projectProfilePath(f.cwd));
  await f.commands.get('profile-setup-with-llm').handler('I prefer TypeScript', f.ctx);
  assert.match(f.messages[1].content, /I prefer TypeScript/);
  assert.equal(f.messages[0].content, setupPrompt(f.cwd, f.agentDir));
});

test('LLM prompt asks before saving, checks sources/compatibility, and does not invent browsing', () => {
  const prompt = setupPrompt('/project', '/agent');
  for (const text of ['https://pi.dev/packages', 'https://awesome-skills.com/', 'https://skills.sh/', 'If browsing is unavailable', 'ask whether to register', 'never replace', 'Existing skills and AGENTS.md', 'MCP', 'Do not write the profile through other tools']) assert.ok(prompt.includes(text), text);
});

test('cancelled selection or confirmation does not write or install anything', async t => {
  const selected = await fixture(t, { select: -1 });
  await command(selected, 'init');
  assert.deepEqual(selected.messages, []);
  const f = await fixture(t, { answers: [false] });
  await put(registeredProfilePath(f.agentDir, 'web'), profile);
  await command(f, 'init web');
  await absent(projectProfilePath(f.cwd));
  assert.deepEqual(f.calls, []);
  assert.equal(f.reloads(), 0);
});

test('sync uses project JSON without registering resources globally', async t => {
  const f = await fixture(t);
  await saveProfile({ ...f, profile });
  await command(f, 'sync');
  assert.equal(f.calls[0].command, 'pi');
  assert.equal(f.reloads(), 1);
  await absent(join(f.agentDir, 'profile-templates'));
  assert.deepEqual(await read(join(f.agentDir, 'settings.json')), { packages: ['npm:unrelated'], defaultModel: 'keep' });
});

test('the save tool registers JSON only, then queues sync with command expansion', async t => {
  const f = await fixture(t);
  const result = await saveTool(f, { profile, globalName: 'my-workflow' });
  assert.equal(result.details.saved, true);
  assert.match(result.content[0].text, /not complete yet/);
  assert.deepEqual(await read(registeredProfilePath(f.agentDir, 'my-workflow')), profile);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.messages, [{ content: '/profile sync', options: { deliverAs: 'followUp', expandPromptTemplates: true } }]);
  await command(f, f.messages[0].content.slice('/profile '.length));
  assert.equal(f.calls.length, 1);
  assert.equal(f.reloads(), 1);
});

test('tool handoff works when Pi dispatches the follow-up command immediately', async t => {
  const f = await fixture(t);
  let pending;
  f.pi.sendUserMessage = (content, options) => {
    assert.equal(options.expandPromptTemplates, true);
    pending = command(f, content.slice('/profile '.length));
  };
  await saveTool(f, { profile });
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.reloads(), 1);
  assert.ok(!f.notifications.some(n => n.level === 'error'));
});

test('installation uses the approved preview even if project JSON changes during confirmation', async t => {
  const f = await fixture(t);
  await saveProfile({ ...f, profile });
  f.ctx.ui.confirm = async () => {
    await put(projectProfilePath(f.cwd), { plugins: ['npm:not-approved'], skills: [] });
    return true;
  };
  await command(f, 'sync');
  assert.deepEqual(f.calls[0].args, ['install', 'npm:search', '--local']);
  assert.equal(f.calls.length, 1);
});

test('save cancellation, invalid JSON and conflicts cannot bypass validation or approval', async t => {
  const f = await fixture(t, { answers: [false] });
  const result = await saveTool(f, { profile, globalName: 'no' });
  assert.equal(result.details.saved, false);
  await absent(projectProfilePath(f.cwd));
  await absent(registeredProfilePath(f.agentDir, 'no'));
  assert.deepEqual(f.messages, []);
  await assert.rejects(saveTool(f, { profile: { plugins: ['./evil'], skills: [] } }), /npm:/);
  await saveProfile({ ...f, profile });
  await assert.rejects(saveTool(f, { profile }), /already exists/);
  assert.deepEqual(await read(projectProfilePath(f.cwd)), profile);
});

test('tool abort after confirmation does not save files', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(saveTool(f, { profile }, controller.signal), { name: 'AbortError' });
  await absent(projectProfilePath(f.cwd));
});

test('non-interactive modes cannot install or save without confirmation', async t => {
  const f = await fixture(t, { hasUI: false });
  await saveProfile({ ...f, profile });
  await command(f, 'sync');
  assert.match(f.notifications[0].message, /interactive confirmation/);
  await assert.rejects(saveTool(f, { profile }), /interactive confirmation/);
  assert.deepEqual(f.calls, []);
});

test('invalid commands, templates and failed installs give errors without claiming success/reloading', async t => {
  const f = await fixture(t);
  await command(f, 'switch study');
  await command(f, 'init ../escape');
  await command(f, 'sync');
  assert.ok(f.notifications.every(n => n.level === 'error'));
  await saveProfile({ ...f, profile });
  f.pi.exec = async () => ({ code: 1, stderr: 'offline' });
  await command(f, 'sync');
  assert.match(f.notifications.at(-1).message, /offline/);
  assert.equal(f.reloads(), 0);
});

test('a second operation cannot overlap an active installation', async t => {
  const f = await fixture(t);
  await saveProfile({ ...f, profile });
  let release;
  let started;
  const installing = new Promise(resolve => { started = resolve; });
  f.pi.exec = async () => {
    started();
    await new Promise(resolve => { release = resolve; });
    return { code: 0 };
  };
  const first = command(f, 'sync');
  await installing;
  await command(f, 'sync');
  assert.match(f.notifications.at(-1).message, /in progress/);
  release();
  await first;
  assert.equal(f.reloads(), 1);
});

test('setup refuses to run while an installation is active', async t => {
  const f = await fixture(t);
  await saveProfile({ ...f, profile });
  let release;
  let started;
  const installing = new Promise(resolve => { started = resolve; });
  f.pi.exec = async () => { started(); await new Promise(resolve => { release = resolve; }); return { code: 0 }; };
  const first = command(f, 'sync');
  await installing;
  await f.commands.get('profile-setup-with-llm').handler('', f.ctx);
  assert.equal(f.messages.length, 0);
  release();
  await first;
});

test('init never replaces an existing project profile', async t => {
  const f = await fixture(t);
  await saveProfile({ ...f, profile });
  await put(registeredProfilePath(f.agentDir, 'another'), { plugins: [], skills: [] });
  await command(f, 'init another');
  assert.match(f.notifications.at(-1).message, /already exists/);
  assert.equal(await readFile(projectProfilePath(f.cwd), 'utf8'), `${JSON.stringify(profile, null, 2)}\n`);
  assert.deepEqual(f.calls, []);
});
