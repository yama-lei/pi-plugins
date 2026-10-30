import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { MonitorManager } from "../monitor.mjs";
import { MonitorBrowser, browseMonitors, formatDuration } from "../browser.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;

function fixture(t: any, rows = 40) {
  const root = mkdtempSync(join(tmpdir(), "pi-monitor-browser-test-"));
  const manager = new MonitorManager({ notify() {}, outputRoot: root });
  let frames = 0, closed = 0;
  const terminal = { rows };
  const view = new MonitorBrowser(manager, { terminal, requestRender() { frames++; } } as any, theme, getKeybindings(), () => closed++);
  t.after(() => { view.dispose(); manager.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return { manager, view, terminal, frames: () => frames, closed: () => closed, text: (width = 160) => view.render(width).join("\n") };
}

async function until(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 4000) throw new Error("Timed out waiting for monitor browser");
    await sleep(10);
  }
}

test("duration formatting includes seconds, minutes, hours, and days", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(65000), "1m 5s");
  assert.equal(formatDuration(3601000), "1h 0m 1s");
  assert.equal(formatDuration(86400000), "1d 0h 0m 0s");
  assert.equal(formatDuration(-1), "0s");
});

test("list -> Enter details -> stdout/stderr -> Esc list, live updates, completed history", async t => {
  const f = fixture(t);
  const task = f.manager.start({ description: "部署错误日志", command: "printf 'first-output\n'; printf 'stderr-warning\n' >&2; sleep 0.6; printf 'new-live-output\n'; sleep 30", persistent: true });
  await until(() => f.manager.get(task.task_id).events > 0);
  assert.match(f.text(), /ID\s+STATUS\s+DURATION\s+EVENTS\s+TITLE/);
  assert.match(f.text(), /部署错误日志/);
  assert.match(f.text(), new RegExp(`${task.task_id}.*running.*0s.*1`));
  f.view.handleInput("\r");
  assert.match(f.text(), /Monitor details · 部署错误日志/);
  assert.match(f.text(), /first-output/);
  assert.match(f.text(), /Started:/);
  assert.match(f.text(), /Command:/);
  assert.match(f.text(), /File:/);
  assert.match(f.text(), /\[stdout\]/);
  assert.ok(!/^stderr-warning\s*$/m.test(f.text()), "stderr must not be mixed into the stdout preview");
  f.view.handleInput("\t");
  assert.match(f.text(), /\[stderr\]/);
  assert.match(f.text(), /stderr-warning/);
  f.view.handleInput("\t");
  await until(() => /^new-live-output\s*$/m.test(f.text()));
  assert.ok(f.frames() > 0, "a visible browser requests refreshed renders");
  f.manager.stop(task.task_id);
  assert.match(f.text(), /stopped/);
  assert.match(f.text(), /Reason: stopped by TaskStop/);
  assert.match(f.text(), /Ended:/);
  f.view.handleInput("\x1b");
  assert.match(f.text(), /0 running · 1 completed/);
  assert.match(f.text(), /部署错误日志/);
  f.view.handleInput("\r");
  assert.match(f.text(), /first-output/);
  f.view.handleInput("\x1b");
  f.view.handleInput("\x1b");
  assert.equal(f.closed(), 1);
  const frames = f.frames();
  await sleep(300);
  assert.equal(f.frames(), frames);
});

test("empty list, selection identity across refresh, narrow widths, resize, and shutdown cleanup", async t => {
  const f = fixture(t);
  assert.match(f.text(), /No monitors/);
  const first = f.manager.start({ description: "first", command: "sleep 30", persistent: true });
  f.text();
  await sleep(5);
  const second = f.manager.start({ description: "second", command: "sleep 30", persistent: true });
  // Refreshing and resorting the list must not silently change the selected task.
  f.text();
  f.view.handleInput("\r");
  assert.match(f.text(), /Monitor details · first/);
  f.view.handleInput("\x1b");
  f.manager.stop(first.task_id);
  f.text();
  f.view.handleInput("\r");
  assert.match(f.text(), /Monitor details · first/);
  for (const rows of [4, 12, 30]) for (const width of [1, 12, 40, 100]) {
    f.terminal.rows = rows;
    f.view.invalidate();
    const lines = f.view.render(width);
    assert.ok(lines.length <= Math.max(1, Math.floor(rows * 0.8)));
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  f.manager.shutdown();
  assert.equal(f.closed(), 1);
  assert.equal(f.manager.get(second.task_id), undefined);
  assert.deepEqual(f.view.render(40), []);
  const frames = f.frames();
  await sleep(300);
  assert.equal(f.frames(), frames);
});

test("output scrolling pauses follow mode, Home/End navigate, Enter never stops a task", async t => {
  const f = fixture(t, 20);
  const task = f.manager.start({ description: "long output", command: "for i in $(seq 1 50); do echo row-$i; done; sleep 30", persistent: true });
  await until(() => f.manager.get(task.task_id).events === 50);
  f.text(); f.view.handleInput("\r");
  assert.match(f.text(), /row-50/);
  f.view.handleInput("\x1b[A");
  assert.match(f.text(), /scroll paused/);
  f.view.handleInput("\x1b[H");
  assert.match(f.text(), /Started:/);
  assert.ok(!/^row-50\s*$/m.test(f.text()));
  f.view.handleInput("\x1b[6~");
  assert.ok(!f.text().includes("Started:"));
  f.view.handleInput("\x1b[F");
  assert.match(f.text(), /row-50/);
  assert.match(f.text(), /following output/);
  f.view.handleInput("\x1b"); f.view.handleInput("\x1b");
  assert.equal(f.manager.get(task.task_id).status, "running", "closing the browser must not stop a monitor");
});

test("TUI entry creates a disposable overlay, RPC uses supported dialogs, no-UI is explicit", async t => {
  const f = fixture(t);
  const task = f.manager.start({ description: "RPC task", command: "printf 'RPC-visible\n'; printf 'RPC-stderr\n' >&2", persistent: false });
  await until(() => f.manager.get(task.task_id).status === "ended");
  let component: any, options: any;
  const opened = browseMonitors(f.manager, {
    mode: "tui", hasUI: true,
    ui: { custom: (factory: any, opts: any) => new Promise(resolve => {
      options = opts;
      component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, getKeybindings(), resolve);
    }) },
  } as any);
  assert.equal(options.overlay, true);
  assert.match(component.render(100).join("\n"), /Monitors/);
  component.handleInput("\x1b"); await opened;
  const dialogs: any[] = [];
  let step = 0;
  await browseMonitors(f.manager, { mode: "rpc", hasUI: true, ui: {
    select: async (title: string, choices: string[]) => {
      dialogs.push({ title, choices });
      return step++ < 2 ? choices[0] : undefined;
    },
  } } as any);
  assert.match(dialogs[0].choices[0], /RPC task.*ended/);
  assert.match(dialogs[0].choices[0], new RegExp(task.task_id));
  assert.match(dialogs[1].title, /RPC-visible/);
  assert.match(dialogs[1].title, /RPC-stderr/);
  const notices: any[] = [];
  await browseMonitors(f.manager, { mode: "print", hasUI: false, ui: { notify: (...args: any[]) => notices.push(args) } } as any);
  assert.equal(notices[0][1], "error");
});
