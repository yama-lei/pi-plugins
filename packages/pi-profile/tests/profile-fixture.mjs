import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfileCommands } from '../commands.mjs';

export async function put(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
}
export const read = async path => JSON.parse(await readFile(path, 'utf8'));

export async function fixture(t, { answers = [], select = 0, hasUI = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project with spaces');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await put(join(agentDir, 'settings.json'), { packages: ['npm:unrelated'], defaultModel: 'keep' });
  await put(join(agentDir, 'auth.json'), 'private credentials');
  const calls = [];
  const notifications = [];
  const prompts = [];
  const messages = [];
  const commands = new Map();
  const tools = new Map();
  let reloads = 0;
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'pi') {
      const settingsPath = join(cwd, '.pi', 'settings.json');
      let settings;
      try { settings = await read(settingsPath); } catch (error) { if (error.code !== 'ENOENT') throw error; settings = {}; }
      settings.packages ??= [];
      if (!settings.packages.includes(args[1])) settings.packages.push(args[1]);
      await put(settingsPath, settings);
      await put(join(cwd, '.pi', 'npm', 'node_modules', args[1].slice(4), 'package.json'), { name: args[1].slice(4) });
    } else if (command === 'npx') {
      const names = args.slice(args.indexOf('--skill') + 1, args.indexOf('--agent'));
      for (const name of names) await put(join(cwd, '.agents', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\n`);
    } else throw new Error(`Unexpected command: ${command}`);
    return { code: 0, stdout: 'ok', stderr: '', killed: false };
  };
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool),
    sendUserMessage: (content, options) => messages.push({ content, options }),
    exec: (...args) => run(...args),
  };
  const ctx = {
    cwd, hasUI,
    waitForIdle: async () => {},
    reload: async () => { reloads++; },
    ui: {
      confirm: async (title, message) => { prompts.push({ title, message }); return answers.length ? answers.shift() : true; },
      select: async (_title, choices) => select === -1 ? undefined : choices[select],
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: () => {},
    },
  };
  registerProfileCommands(pi, {
    agentDir, parameters: {}, mutate: (_path, task) => task(), download: async () => '# Project instructions\n',
  });
  return { root, cwd, agentDir, calls, notifications, prompts, messages, commands, tools, run, ctx, pi, reloads: () => reloads };
}
