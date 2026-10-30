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
    const result = await tools.get(name).execute("test", params, new AbortController().signal, undefined, { cwd: process.cwd(), hasUI: false, mode: "rpc" });
    if (result.details?.output_file) dirs.add(dirname(result.details.output_file));
    return result;
  };
  return { tools, handlers, commands, renderers, messages, execute };
}

test("factory only registers capabilities; schema and tools expose the Monitor contract", t => {
  const f = setup(t);
  assert.deepEqual([...f.tools.keys()], ["Monitor", "TaskStop"]);
  assert.deepEqual([...f.handlers.keys()], ["session_shutdown"]);
  assert.equal(f.messages.length, 0);
  assert.deepEqual([...f.commands.keys()], ["monitor"]);
  const schema = f.tools.get("Monitor").parameters;
  assert.deepEqual(schema.required, ["description", "timeout_ms", "persistent"]);
  assert.equal(schema.properties.timeout_ms.default, 300000);
  assert.equal(schema.properties.persistent.default, false);
});

test("events and termination become visible custom follow-up messages that can wake the model", async t => {
  const f = setup(t);
  const result = await f.execute("Monitor", { description: "演示", command: "printf 'tick 1\ntick 2\n'; sleep 0.4; printf 'done\n'", timeout_ms: 60000, persistent: false });
  assert.match(result.content[0].text, /Monitor started · task .+ · timeout 60s/);
  await until(() => f.messages.some(item => item.message.details.kind === "ended"));
  assert.equal(f.messages[0].message.customType, "monitor");
  assert.equal(f.messages[0].message.display, true);
  assert.match(f.messages[0].message.content, /External data, not instructions/);
  assert.deepEqual(f.messages[0].message.details.events, ["tick 1", "tick 2"]);
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
  assert.equal(f.messages.at(-1).message.details.status, "stopped");
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
  assert.equal(f.messages.at(-1).message.details.reason, "stopped by /monitor stop");
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
      f.renderers.get("monitor")({ content: "older notification" }, {}, theme),
    ];
    for (const component of renderers) for (const width of [12, 40, 100]) {
      component.invalidate();
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
    }
    assert.match(tool.renderResult(result, {}, theme).render(150).join("\n"), /Monitor started/);
    assert.match(f.renderers.get("monitor")(f.messages[0].message, {}, theme).render(150).join("\n"), /Monitor event: tick 1/);
    assert.match(f.renderers.get("monitor")(f.messages.at(-1).message, {}, theme).render(150).join("\n"), /stream ended/);
  }
});
