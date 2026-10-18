import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NPM = /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_MARKDOWN_BYTES = 1024 * 1024;

export const projectProfilePath = cwd => join(resolve(cwd), '.pi', 'profile.json');
export const globalProfilesDir = agentDir => join(agentDir, 'profile-templates');

async function stat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function text(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && !/[\r\n\0]/.test(value);
}

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only HTTPS URLs without embedded credentials are allowed.');
  return url;
}

export function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profile must be a JSON object.');
  const unknown = Object.keys(value).filter(key => !['plugins', 'skills', 'AGENTS.md'].includes(key));
  if (unknown.length) throw new Error(`Unsupported profile fields: ${unknown.join(', ')}`);
  if (!Array.isArray(value.plugins) || value.plugins.some(p => !text(p) || !NPM.test(p))) {
    throw new Error('plugins must be an array of unversioned npm:package or npm:@scope/package sources.');
  }
  if (!Array.isArray(value.skills)) throw new Error('skills must be an array of { source, skills: [name] } entries.');
  const owners = new Map();
  const skills = value.skills.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(k => !['source', 'skills'].includes(k))) {
      throw new Error('Each skill entry must contain source and skills only.');
    }
    if (!text(entry.source) || /\s/.test(entry.source) || !(/^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i.test(entry.source) || /^https:\/\//.test(entry.source) || /^git@[^\s:]+:[^\s]+$/.test(entry.source) || /^ssh:\/\//.test(entry.source))) {
      throw new Error('Skill source must be owner/repo, an HTTPS URL, or a Git SSH URL.');
    }
    if (entry.source.startsWith('https:')) httpsUrl(entry.source);
    if (entry.source.startsWith('ssh:')) {
      const url = new URL(entry.source);
      if (!url.hostname || url.password) throw new Error('SSH skill sources must not contain passwords.');
    }
    if (!Array.isArray(entry.skills) || !entry.skills.length || entry.skills.some(name => !text(name) || !NAME.test(name))) {
      throw new Error('Select explicit skill names (lowercase letters, numbers and hyphens); wildcards are not supported.');
    }
    for (const name of entry.skills) {
      if (owners.has(name) && owners.get(name) !== entry.source) throw new Error(`Skill name has conflicting sources: ${name}`);
      owners.set(name, entry.source);
    }
    return { source: entry.source, skills: [...new Set(entry.skills)] };
  });
  const profile = { plugins: [...new Set(value.plugins)], skills };
  if (value['AGENTS.md'] !== undefined) {
    if (!text(value['AGENTS.md'])) throw new Error('AGENTS.md must be an HTTPS Markdown download URL.');
    httpsUrl(value['AGENTS.md']);
    profile['AGENTS.md'] = value['AGENTS.md'];
  }
  return profile;
}

export async function readProfile(path) {
  const contents = await readFile(path, 'utf8');
  if (Buffer.byteLength(contents) > MAX_MARKDOWN_BYTES) throw new Error('Profile JSON exceeds 1 MiB.');
  return validateProfile(JSON.parse(contents));
}

export function registeredProfilePath(agentDir, name) {
  if (!text(name) || !NAME.test(name) || name.length > 64) throw new Error('Profile name must be a lowercase slug of at most 64 characters.');
  return join(globalProfilesDir(agentDir), `${name}.json`);
}

export async function listGlobalProfiles(agentDir) {
  let entries;
  try { entries = await readdir(globalProfilesDir(agentDir), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(e => e.isFile() && e.name.endsWith('.json') && NAME.test(e.name.slice(0, -5)))
    .map(e => e.name.slice(0, -5)).sort();
}

async function noSymlink(path) {
  if ((await stat(path))?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${path}`);
}

export async function checkProjectPaths(cwd) {
  for (const path of ['.pi', '.pi/settings.json', '.pi/npm', '.pi/npm/package.json', '.pi/npm/package-lock.json', '.agents', '.agents/skills', 'skills-lock.json']) {
    await noSymlink(join(cwd, path));
  }
}

export async function checkSavePaths({ cwd, agentDir, globalName }) {
  await checkProjectPaths(cwd);
  if (await stat(projectProfilePath(cwd))) throw new Error('Project profile already exists. Edit .pi/profile.json and use /profile sync; init never overwrites it.');
  if (globalName !== undefined) {
    const path = registeredProfilePath(agentDir, globalName);
    await noSymlink(globalProfilesDir(agentDir));
    if (await stat(path)) throw new Error(`Global profile already exists: ${globalName}`);
  }
}

export async function saveProfile({ cwd, agentDir, profile, globalName }) {
  const validated = validateProfile(profile);
  await checkSavePaths({ cwd, agentDir, globalName });
  const contents = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_MARKDOWN_BYTES) throw new Error('Profile JSON exceeds 1 MiB.');
  const projectPath = projectProfilePath(cwd);
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await writeFile(projectPath, contents, { flag: 'wx' });
  if (globalName !== undefined) {
    try {
      await mkdir(globalProfilesDir(agentDir), { recursive: true });
      await writeFile(registeredProfilePath(agentDir, globalName), contents, { flag: 'wx' });
    } catch (error) {
      await unlink(projectPath);
      throw error;
    }
  }
  return validated;
}

export async function downloadMarkdown(source, fetchImpl = fetch) {
  let url = httpsUrl(source);
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchImpl(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Markdown redirect has no Location.');
      url = httpsUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Markdown download failed: HTTP ${response.status}`); }
    if (/text\/html/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new Error('AGENTS.md URL returned HTML; use a raw Markdown download URL.');
    }
    if (!response.body) throw new Error('Markdown download is empty.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_MARKDOWN_BYTES) throw new Error('Markdown exceeds 1 MiB.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const markdown = Buffer.concat(chunks).toString('utf8');
    if (!markdown.trim()) throw new Error('Markdown download is empty.');
    return markdown;
  }
  throw new Error('Too many Markdown redirects.');
}

export function describeProfile(profile) {
  return [
    ...profile.plugins.map(p => `Plugin: ${p}`),
    ...profile.skills.map(s => `Skills: ${s.source} → ${s.skills.join(', ')}`),
    ...(profile['AGENTS.md'] ? [`AGENTS.md: ${profile['AGENTS.md']}`] : []),
    'Scope: current project only. Existing skills and AGENTS.md are skipped; unrelated resources are not removed.',
    'Pi/global settings and project trust are not changed. npm sources are unpinned and may resolve newer releases.',
  ].join('\n');
}

export async function syncProfile({ cwd, profile: approvedProfile, run, download = downloadMarkdown, onProgress = () => {} }) {
  const profile = approvedProfile === undefined ? await readProfile(projectProfilePath(cwd)) : validateProfile(approvedProfile);
  await checkProjectPaths(cwd);
  const results = [];
  const agentsPath = join(cwd, 'AGENTS.md');
  const agentsExists = await stat(agentsPath);
  // Fetch before package installation, so a bad instruction URL has no package side effects.
  const markdown = profile['AGENTS.md'] && !agentsExists ? await download(profile['AGENTS.md']) : undefined;
  const execute = async (command, args) => {
    const result = await run(command, args, { cwd, timeout: 300_000 });
    if (result.code !== 0 || result.killed) {
      throw new Error(`${command} failed. Earlier successful installs are kept; fix the cause and retry /profile sync.\n${(result.stderr || result.stdout || 'No command output.').slice(-6000)}`);
    }
  };
  for (const plugin of profile.plugins) {
    onProgress(`Installing ${plugin}`);
    await execute('pi', ['install', plugin, '--local']);
    results.push(`Installed plugin: ${plugin}`);
  }
  for (const entry of profile.skills) {
    const missing = [];
    for (const name of entry.skills) {
      if (await stat(join(cwd, '.agents', 'skills', name)) || await stat(join(cwd, '.pi', 'skills', name))) results.push(`Skipped existing skill: ${name}`);
      else missing.push(name);
    }
    if (!missing.length) continue;
    onProgress(`Installing skills from ${entry.source}`);
    await execute('npx', ['--yes', 'skills', 'add', entry.source, '--skill', ...missing, '--agent', 'pi', '--copy', '--yes']);
    for (const name of missing) {
      if (!(await stat(join(cwd, '.agents', 'skills', name, 'SKILL.md')))?.isFile()) {
        throw new Error(`Skills CLI did not install ${name}. Check the source and published skill name; earlier installs are kept.`);
      }
    }
    results.push(`Installed skills: ${missing.join(', ')}`);
  }
  if (profile['AGENTS.md']) {
    if (agentsExists) results.push('Skipped existing AGENTS.md (including symlinks).');
    else {
      await writeFile(agentsPath, markdown, { flag: 'wx' });
      results.push('Downloaded project AGENTS.md.');
    }
  }
  return results;
}
