import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[2] ?? 'help';
const pkg = process.env.RELEASE_PACKAGE ?? 'all';
const version = process.env.RELEASE_VERSION ?? 'patch';
const confirm = process.env.RELEASE_CONFIRM ?? '';

// Packages are discovered from packages/*/package.json; nothing is hard-coded.
function discover() {
  const base = join(root, 'packages');
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map(entry => {
      const dir = join(base, entry.name);
      const { name, version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      return { dir, dirName: entry.name, short: entry.name.replace(/^pi-/, ''), name, version };
    })
    .sort((a, b) => a.dirName.localeCompare(b.dirName));
}

function select(all, spec) {
  if (spec === 'all') return all;
  const picked = [];
  for (const token of spec.split(/[,\s]+/).filter(Boolean)) {
    const found = all.find(p => [p.short, p.dirName, p.name].includes(token));
    if (!found) throw new Error(`未知的包 "${token}"；可用：${all.map(p => p.short).join('、')}（运行 make list 查看）。`);
    if (!picked.includes(found)) picked.push(found);
  }
  if (!picked.length) throw new Error('PACKAGE 不能为空。');
  return picked;
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = code => text => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

const results = [];
const started = Date.now();
const secs = ms => `${(ms / 1000).toFixed(1)}s`;

function npm(args, cwd = root) {
  const where = cwd === root ? 'workspace root' : cwd.replace(root, '').replace(/\/$/, '');
  console.log(`\n${cyan('▶')} ${bold(`npm ${args.join(' ')}`)} ${dim(`(${where})`)}`);
  const t = Date.now();
  try {
    execFileSync('npm', args, { cwd, stdio: 'inherit' });
  } catch (error) {
    results.push({ ok: false, label: `npm ${args.join(' ')}`, where, time: Date.now() - t });
    throw error;
  }
  results.push({ ok: true, label: `npm ${args.join(' ')}`, where, time: Date.now() - t });
  console.log(`${green('✓')} ${dim(secs(Date.now() - t))}`);
}

function summary() {
  if (!results.length) return;
  console.log(`\n${bold('Summary')}`);
  for (const r of results) {
    console.log(`  ${r.ok ? green('✓') : red('✗')} ${r.label.padEnd(36)} ${dim(r.where.padEnd(32))} ${dim(secs(r.time))}`);
  }
  console.log(dim(`  total ${secs(Date.now() - started)}`));
}

try {
  if (task === 'help') {
    console.log(`make check / test / verify   语法检查 / 测试 / 两者
make list                   列出自动发现的包
make pack                   打包预览
make bump                   只修改本地版本
make publish                发布当前版本（首次发布用它）
make release                增加版本后发布

PACKAGE=all（默认）| 包名，可用逗号分隔多个（名称见 make list）
VERSION=patch（默认）| minor | major | X.Y.Z
例如：make release PACKAGE=profile,monitor VERSION=patch
发布前输入 publish 确认；CONFIRM=publish 可跳过交互确认。
不会自动登录、提交 Git 或更新已安装的插件。`);
    process.exit(0);
  }
  if (process.argv.length > 3 || !['list', 'check', 'test', 'verify', 'pack', 'bump', 'publish', 'release'].includes(task)) {
    throw new Error('未知任务；运行 make help 查看用法。');
  }
  const all = discover();
  if (task === 'list') {
    const w = Math.max(...all.map(p => p.short.length)) + 2;
    for (const p of all) console.log(`${bold(cyan(p.short.padEnd(w)))}${p.name}${dim('@')}${green(p.version)}  ${dim(`packages/${p.dirName}`)}`);
    process.exit(0);
  }
  const selected = select(all, pkg);
  if (['bump', 'release'].includes(task) && !/^(patch|minor|major|(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.test(version)) {
    throw new Error('VERSION 必须是 patch、minor、major 或 X.Y.Z。');
  }
  if (confirm && confirm !== 'publish') throw new Error('CONFIRM 只能留空或设为 publish。');

  const dirs = selected.map(p => p.dir);
  const publishing = task === 'publish' || task === 'release';

  if (task === 'check' || task === 'verify' || publishing) npm(['run', 'check']);
  if (task === 'test' || task === 'verify' || publishing) {
    for (const dir of dirs) npm(['test', '--if-present'], dir);
  }
  if (task === 'pack' || publishing) {
    for (const dir of dirs) npm(['pack', '--dry-run'], dir);
  }

  if (publishing) {
    npm(['whoami']);
    console.log(`\n${yellow('⚠')} ${bold('即将发布（账号见上方）：')}`);
    for (const { name, version: current } of selected) {
      console.log(`  ${cyan('•')} ${name}${dim('@')}${current}${task === 'release' ? ` ${dim('→')} ${yellow(`npm version ${version}`)}` : ''}`);
    }
    if (confirm !== 'publish') {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('非交互终端不会发布；请在终端确认或显式传 CONFIRM=publish。');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if ((await terminal.question('输入 publish 确认：')).trim() !== 'publish') throw new Error('已取消；未修改版本、未发布。');
      } finally {
        terminal.close();
      }
    }
  }

  if (task === 'bump' || task === 'release') {
    for (const dir of dirs) npm(['version', version, '--no-git-tag-version'], dir);
  }
  if (task === 'release') {
    for (const dir of dirs) npm(['pack', '--dry-run'], dir);
  }
  if (publishing) {
    for (const dir of dirs) {
      npm(['publish', '--access', 'public'], dir);
      console.log(`${green('✔ 发布成功')} ${dim(dir)}`);
    }
  }
} catch (error) {
  summary();
  console.error(`\n${red('✗')} ${bold(red(error.message))}`);
  console.error(dim('已停止；之前完成的版本修改和发布不会回滚。发布失败时请核对 npm 实际状态再重试。'));
  process.exitCode = 1;
}
if (!process.exitCode && results.length) {
  summary();
  console.log(`\n${green('✓')} ${bold('完成')}`);
}
