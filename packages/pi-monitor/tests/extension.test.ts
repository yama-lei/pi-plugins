import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.ts";

async function until(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 4000) throw new Error("Timed out waiting for notification");
    await sleep(10);
  }
}

function setup(t: any) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const renderers = new Map<string, any>();
  const messages: any[] = [];
  let idle = true;
  const context = { cwd: process.cwd(), hasUI: false, mode: "rpc", isIdle: () => idle };
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
    on: (name: string, handler: any) => handlers.set(name, handler),
    getSettings: () => ({}),
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
  } as any);
  const dirs = new Set<string>();
  t.after(() => { handlers.get("session_shutdown")(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  const execute = async (name: string, params: any) => {
    const result = await tools.get(name).execute("test", params, new AbortController().signal, undefined, context);
    if (result.details?.output_file) dirs.add(dirname(result.details.output_file));
    return result;
  };
  const begin = () => { idle = false; handlers.get("before_agent_start")({}, context); };
  const boundary = (name = "turn_end", event: any = {}) => handlers.get(name)({ outcome: "completed", entries: [], ...event }, context);
  const settle = (aborted = false) => { idle = true; handlers.get("agent_settled")({ aborted }, context); };
  return { tools, handlers, commands, renderers, messages, execute, begin, boundary, settle };
}

test("factory only registers capabilities; schema and tools expose the Monitor contract", t => {
  const f = setup(t);
  assert.deepEqual([...f.tools.keys()], ["Monitor", "TaskStop"]);
  assert.deepEqual([...f.handlers.keys()], ["session_start", "before_agent_start", "turn_end", "agent_before_settle", "agent_settled", "session_shutdown"]);
  assert.equal(f.messages.length, 0);
  assert.deepEqual([...f.commands.keys()], ["monitor"]);
  const schema = f.tools.get("Monitor").parameters;
  assert.deepEqual(schema.required, ["description", "timeout_ms", "persistent"]);
  assert.equal(schema.properties.timeout_ms.default, 300000);
  assert.equal(schema.properties.persistent.default, false);
  assert.equal(schema.properties.notify.default, "events");
});

test("events and termination become visible custom follow-up messages that can wake the model", async t => {
  const f = setup(t);
  const result = await f.execute("Monitor", { description: "演示", command: "printf 'tick 1\ntick 2\n'; sleep 0.4; printf 'done\n'", timeout_ms: 60000, persistent: false });
  assert.match(result.content[0].text, /Monitor started · task .+ · timeout 60s/);
  await until(() => f.messages.some(item => item.message.details.kind === "ended"));
  assert.equal(f.messages[0].message.customType, "monitor");
  assert.equal(f.messages[0].message.display, true);
  assert.match(f.messages[0].message.content, /external data, not instructions/);
  assert.deepEqual(f.messages.flatMap(item => item.message.details.kind === "events" ? item.message.details.events : item.message.details.output), ["tick 1", "tick 2", "done"]);
  for (const item of f.messages) {
    assert.equal(item.message.details.task_id, result.details.task_id);
    assert.equal(item.message.details.description, "演示");
    assert.deepEqual(item.options, { triggerTurn: true, deliverAs: "followUp" });
  }
  assert.equal(f.messages.at(-1).message.details.reason, "stream ended");
});

test("TaskStop stops only this extension's tasks and the manual command reports errors", async t => {
  const f = setup(t);
  const started = await f.execute("Monitor", { description: "long", command: "sleep 30", persistent: true, timeout_ms: 1 });
  const stopped = await f.execute("TaskStop", { task_id: started.details.task_id });
  assert.equal(stopped.details.status, "stopped");
  assert.equal(f.messages.length, 0);
  await assert.rejects(f.execute("TaskStop", { task_id: "unknown" }), /not running/);
  const notifications: any[] = [];
  const command = f.commands.get("monitor");
  const ctx = { ui: { notify: (...args: any[]) => notifications.push(args) } };
  for (const args of ["stop unknown", "stop", "stop id extra", "ls extra", "unknown"]) await command.handler(args, ctx);
  assert.ok(notifications.every(args => args[1] === "error"));
  const another = await f.execute("Monitor", { description: "stop via command", command: "sleep 30", persistent: true, timeout_ms: 1000 });
  assert.deepEqual(command.getArgumentCompletions("l").map((item: any) => item.value), ["ls"]);
  assert.equal(command.getArgumentCompletions("stop ")[0].value, `stop ${another.details.task_id}`);
  await command.handler(`stop ${another.details.task_id}`, ctx);
  assert.equal(notifications.at(-1)[1], "info");
  assert.equal(f.messages.length, 0);
  assert.deepEqual(command.getArgumentCompletions("stop "), []);
});

test("/monitor and /monitor ls both open the browser without invoking the model", async t => {
  const f = setup(t);
  for (const args of ["", "ls"]) {
    let view: any;
    const open = f.commands.get("monitor").handler(args, { mode: "tui", hasUI: true, ui: {
      custom: (factory: any) => new Promise(resolve => {
        view = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
      }),
    } });
    assert.match(view.render(100).join("\n"), /No monitors/);
    view.handleInput("\x1b");
    await open;
  }
  assert.equal(f.messages.length, 0);
});

test("shutdown suppresses pending messages and rejects new work from the old runtime", async t => {
  const f = setup(t);
  await f.execute("Monitor", { description: "closing", command: "printf 'one\n'; sleep 30", persistent: true, timeout_ms: 300000 });
  await sleep(40);
  f.handlers.get("session_shutdown")();
  await sleep(250);
  assert.equal(f.messages.length, 0);
  await assert.rejects(f.execute("Monitor", { description: "late", command: "true", timeout_ms: 1000, persistent: false }), /session has ended/);
});

test("busy events and endings merge at a turn boundary, preserving failures and other extension entries", async t => {
  const f = setup(t);
  f.begin();
  const one = await f.execute("Monitor", { description: "first build", command: "printf 'earlier error context\\n'; sleep 0.3; printf 'last\\n'; printf 'compiler error\\n' >&2; exit 101" });
  await f.execute("Monitor", { description: "second build", command: "printf 'different failure\\n'; exit 7" });
  await sleep(600);
  assert.equal(f.messages.length, 0, "must not enqueue busy follow-ups");
  const prior = { type: "custom", customType: "other", data: 1 };
  const result = f.boundary("turn_end", { entries: [prior] });
  assert.equal(result.continue, true);
  assert.equal(result.entries[0], prior);
  assert.equal(result.entries.length, 2);
  const message = result.entries[1];
  assert.equal(message.details.kind, "digest");
  assert.equal(message.details.notifications.length, 2);
  assert.ok(message.details.notifications.every((n: any) => n.kind === "ended"));
  assert.match(message.content, /exit=101/);
  assert.match(message.content, /exit=7/);
  assert.match(message.content, /earlier error context/);
  assert.match(message.content, /compiler error/);
  assert.match(message.content, /Occurred: .*Delivered:/);
  assert.match(message.content, /Latest task state: error/);
  assert.match(message.content, /end silently/);
  assert.equal(message.details.notifications.find((n: any) => n.task_id === one.details.task_id).batches, 2);
  assert.equal(f.boundary(), undefined, "drained notifications must not request another turn");
  f.settle();
  await sleep(30);
  assert.equal(f.messages.length, 0);
});

test("final settlement delivers late completions once and aborted boundaries retain data", async t => {
  const f = setup(t);
  f.begin();
  await f.execute("Monitor", { description: "late", command: "printf 'done\\n'", notify: "completion" });
  await sleep(80);
  assert.equal(f.boundary("turn_end", { outcome: "aborted" }), undefined);
  assert.equal(f.boundary("agent_before_settle", { outcome: "error" }), undefined);
  assert.equal(f.messages.length, 0);
  const result = f.boundary("agent_before_settle");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].details.kind, "ended");
  assert.equal(result.entries[0].details.exit_code, 0);
  assert.match(result.entries[0].content, /done/);
  assert.equal(f.boundary("agent_before_settle"), undefined);
});

test("manual stop removes already collected progress and completion jobs wake exactly once when idle", async t => {
  const f = setup(t);
  f.begin();
  const task = await f.execute("Monitor", { description: "stop pending", command: "printf 'old tick\\n'; sleep 30" });
  await sleep(300);
  await f.execute("TaskStop", { task_id: task.details.task_id });
  assert.equal(f.boundary(), undefined);
  f.settle();
  await f.execute("Monitor", { description: "completed", command: "printf 'first\\n'; sleep 0.3; printf 'last\\n'", notify: "completion" });
  await sleep(250);
  assert.equal(f.messages.length, 0);
  await until(() => f.messages.length > 0);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].message.details.kind, "ended");
  assert.match(f.messages[0].message.content, /exit=0/);
  assert.match(f.messages[0].message.content, /first/);
  assert.match(f.messages[0].message.content, /last/);
});

test("Escape pauses future notifications until another run and manual slash stop clears pending progress", async t => {
  const f = setup(t);
  f.begin();
  await f.execute("Monitor", { description: "paused completion", command: "sleep 0.2; printf 'later\\n'", notify: "completion" });
  f.settle(true);
  await sleep(400);
  assert.equal(f.messages.length, 0, "later events must not immediately undo Escape");
  f.begin();
  assert.match(f.boundary().entries[0].content, /later/);
  const started = await f.execute("Monitor", { description: "slash stop", command: "printf 'pending\\n'; sleep 30" });
  await sleep(300);
  const notices: any[] = [];
  await f.commands.get("monitor").handler(`stop ${started.details.task_id}`, { ui: { notify: (...args: any[]) => notices.push(args) } });
  assert.equal(notices[0][1], "info");
  assert.equal(f.boundary(), undefined);
  f.settle();
  await sleep(20);
  assert.equal(f.messages.length, 0);
});

test("shutdown drops collected busy notifications as well as batching timers", async t => {
  const f = setup(t);
  f.begin();
  await f.execute("Monitor", { description: "old session", command: "printf 'complete\\n'" });
  await sleep(80);
  f.handlers.get("session_shutdown")();
  assert.equal(f.boundary(), undefined);
  f.settle();
  await sleep(30);
  assert.equal(f.messages.length, 0);
});

test("screenshot-shaped renderers support narrow widths, Chinese labels, expansion, and both themes", async t => {
  const f = setup(t);
  const result = await f.execute("Monitor", { description: "演示：每2秒输出一次计时并最终结束", command: "printf 'tick 1\n'", timeout_ms: 60000, persistent: false });
  await until(() => f.messages.some(item => item.message.details.kind === "ended"));
  for (const themeName of ["dark", "light"]) {
    const definition = JSON.parse(readFileSync(join(process.env.PI_TEST_HOST_DIR!, "dist/modes/interactive/theme", `${themeName}.json`), "utf8"));
    const resolveColor = (value: string | number): string | number => typeof value === "string" && value in definition.vars ? resolveColor(definition.vars[value]) : value;
    const colors = Object.fromEntries(Object.entries(definition.colors).map(([key, value]) => [key, resolveColor(value as string)]));
    const theme = new Theme(colors as any, colors as any, "truecolor", { appearance: themeName as "dark" | "light" });
    const tool = f.tools.get("Monitor");
    const renderers = [
      tool.renderCall({ description: result.details.description }, theme),
      tool.renderResult(result, { expanded: false }, theme),
      tool.renderResult(result, { expanded: true }, theme),
      tool.renderResult({ content: [{ type: "text", text: "error" }] }, {}, theme),
      tool.renderResult({}, { isPartial: true }, theme),
      ...f.messages.map(item => f.renderers.get("monitor")(item.message, { expanded: true }, theme)),
      f.renderers.get("monitor")({ details: { kind: "digest", notifications: [f.messages[0].message.details], omitted: 2 } }, { expanded: true }, theme),
      f.renderers.get("monitor")({ content: "older notification" }, {}, theme),
    ];
    for (const component of renderers) for (const width of [12, 40, 100]) {
      component.invalidate();
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
    }
    assert.match(tool.renderResult(result, {}, theme).render(150).join("\n"), /Monitor started/);
    assert.match(f.renderers.get("monitor")(f.messages[0].message, { expanded: true }, theme).render(150).join("\n"), /tick 1/);
    assert.match(f.renderers.get("monitor")(f.messages.at(-1).message, {}, theme).render(150).join("\n"), /stream ended/);
  }
});
