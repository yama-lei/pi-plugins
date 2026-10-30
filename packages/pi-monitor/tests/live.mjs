// Explicit opt-in integration test. Calls the real Pi CLI and gpt-6-luna.
// Never runs as part of npm test. Credentials are copied into a disposable agent directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "pi-monitor-live-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
mkdirSync(agentDir, { mode: 0o700 }); mkdirSync(project);
const source = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
for (const file of ["auth.json", "models-store.json", "models.json"]) {
  if (existsSync(join(source, file))) copyFileSync(join(source, file), join(agentDir, file));
}
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", enableAnalytics: false, enableInstallTelemetry: false, retry: { enabled: false } }));

const sockets = new Set();
const server = createServer();
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
server.on("upgrade", (req, socket) => {
  const key = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\nSec-WebSocket-Protocol: v1\r\n\r\n`);
  for (const text of ["ws-one", "ws-two"]) socket.write(Buffer.from([0x81, Buffer.byteLength(text), ...Buffer.from(text)]));
  const timer = setTimeout(() => socket.end(Buffer.from([0x88, 2, 0x03, 0xe8])), 1200);
  socket.on("close", () => clearTimeout(timer));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");
const child = spawn("pi", [
  "--mode", "rpc", "--no-session", "--offline", "--model", "openai-codex/gpt-6-luna", "--thinking", "low",
  "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-mcp", "--no-approve",
  "--tools", "Monitor,TaskStop",
], {
  cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  stdio: ["pipe", "pipe", "pipe"],
});
const records = [];
const pending = new Map();
let buffer = "", stderr = "", sequence = 0, exited = false;
let respondToDialog;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", chunk => { stderr += chunk; });
child.on("error", error => { stderr += error.message; });
child.on("close", () => { exited = true; });
child.stdout.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      records.push(event);
      if (event.type === "extension_ui_request" && event.method === "select" && respondToDialog) {
        child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, ...respondToDialog(event) }) + "\n");
      }
      if (event.type === "response" && pending.has(event.id)) {
        pending.get(event.id)(event); pending.delete(event.id);
      }
    } catch { stderr += `Non-JSON stdout: ${line.slice(0, 200)}`; }
  }
});
const deadline = Date.now() + 180000;
async function waitFor(predicate) {
  while (!predicate()) {
    if (exited) throw new Error(`Pi exited unexpectedly. ${stderr}`);
    if (Date.now() > deadline) throw new Error(`Live test deadline exceeded. ${stderr}`);
    await sleep(25);
  }
}
async function rpc(type, data = {}) {
  const id = String(++sequence);
  let response;
  pending.set(id, record => { response = record; });
  child.stdin.write(JSON.stringify({ type, id, ...data }) + "\n");
  await waitFor(() => response);
  if (!response.success) throw new Error(response.error);
  return response.data;
}
function notifications() {
  return records.filter(e => e.type === "message_end" && e.message?.customType === "monitor").map(e => e.message.details);
}
function toolResults(name) {
  return records.filter(e => e.type === "tool_execution_end" && e.toolName === name);
}

try {
  const state = await rpc("get_state");
  assert.equal(state.model.id, "gpt-6-luna");
  assert.equal(state.model.provider, "openai-codex");
  console.log(`Real Pi model: ${state.model.provider}/${state.model.id}`);
  await rpc("set_follow_up_mode", { mode: "all" });
  const wsUrl = `ws://127.0.0.1:${server.address().port}`;
  await rpc("prompt", { message: `Integration test. Use the Monitor tool, not shell polling. Start exactly these six independent monitors now. Use timeout_ms=60000 and persistent=false except where specified. Descriptions must match exactly.
1. description="demo", command="for i in 1 2 3; do sleep 2; printf 'tick %s\\n' \\"$i\\"; done; printf 'done\\n'". Write the shell quoting correctly so $i expands.
2. description="failure", command="printf 'visible\\n'; printf 'stderr-only\\n' >&2; exit 7".
3. description="timeout", command="sleep 30", timeout_ms=1000.
4. description="websocket", ws={"url":"${wsUrl}","protocols":["v1"]}.
5. description="manual-stop", command="sleep 30", persistent=true, timeout_ms=1000. Once started, call TaskStop on this task immediately.
6. description="command-stop", command="sleep 30", persistent=true, timeout_ms=1000. Do NOT stop this one, the test client will stop it using a slash command.
Do not start additional monitors or stop the other five. Reply STARTED after issuing the tools. When events later arrive, acknowledge briefly, never poll or restart anything. Only report received data, never infer unseen events.` });
  await waitFor(() => toolResults("Monitor").some(event => event.result?.details?.description === "command-stop"));
  const commandTask = toolResults("Monitor").find(event => event.result?.details?.description === "command-stop").result.details;
  const commandStop = await rpc("prompt", { message: `/monitor stop ${commandTask.task_id}` });
  assert.equal(commandStop.disposition, "handled");
  await waitFor(() => notifications().filter(n => n.kind === "ended").length === 6);
  // Ensure at least one model response has followed the event notifications.
  await waitFor(() => records.at(-1)?.type === "agent_settled");
  const starts = toolResults("Monitor");
  assert.equal(starts.length, 6);
  assert.ok(starts.every(r => !r.isError), "all Monitor calls must succeed");
  const events = description => notifications().filter(n => n.kind === "events" && n.description === description).flatMap(n => n.events);
  assert.deepEqual(events("demo"), ["tick 1", "tick 2", "tick 3", "done"]);
  assert.deepEqual(events("failure"), ["visible"]);
  assert.deepEqual(events("websocket"), ["ws-one", "ws-two"]);
  const ends = new Map(notifications().filter(n => n.kind === "ended").map(n => [n.description, n]));
  assert.equal(ends.get("demo").status, "ended");
  assert.equal(ends.get("failure").status, "error");
  assert.match(ends.get("failure").reason, /exit 7/);
  assert.equal(ends.get("timeout").status, "timeout");
  assert.equal(ends.get("manual-stop").status, "stopped");
  assert.equal(ends.get("command-stop").status, "stopped");
  assert.equal(ends.get("command-stop").reason, "stopped by /monitor stop");
  assert.equal(ends.get("websocket").status, "ended");
  assert.equal(toolResults("TaskStop").length, 1);
  assert.ok(!toolResults("TaskStop")[0].isError);
  assert.equal(readFileSync(ends.get("failure").stderr_file, "utf8"), "stderr-only\n");
  assert.ok(notifications().some(n => n.kind === "events" && n.events.length > 1), "must see a batched notification");
  const assistants = records.filter(e => e.type === "message_end" && e.message?.role === "assistant");
  assert.ok(assistants.every(e => e.message.model === "gpt-6-luna"), "no fallback model");
  assert.ok(!records.some(e => e.type === "extension_error"));
  const { commands } = await rpc("get_commands");
  assert.ok(commands.some(command => command.name === "monitor"));
  assert.ok(!commands.some(command => command.name === "monitor-stop"));
  for (const command of ["/monitor", "/monitor ls"]) {
    const dialogs = [];
    respondToDialog = request => {
      dialogs.push(request);
      if (dialogs.length === 1) return { value: request.options.find(option => option.startsWith("failure ·")) };
      if (dialogs.length === 2) return { value: request.options[0] };
      return { cancelled: true };
    };
    const result = await rpc("prompt", { message: command });
    assert.equal(result.disposition, "handled");
    assert.equal(dialogs.length, 3);
    assert.ok(dialogs[0].options.every(option => option.includes("events") && option.includes("s ·")));
    assert.match(dialogs[1].title, /visible/);
    assert.match(dialogs[1].title, /stderr-only/);
    assert.match(dialogs[1].title, /exit 7/);
    respondToDialog = undefined;
  }
  console.log(`PASS: ${starts.length} monitors, ${toolResults("TaskStop").length} TaskStop, ${notifications().length} notifications. Command events, batching, WebSocket, stderr, failure, timeout, /monitor stop, and both list/detail command paths verified.`);
} catch (error) {
  // This transcript contains only test commands and messages, not copied credentials.
  const transcript = join(tmpdir(), `pi-monitor-live-failure-${Date.now()}.jsonl`);
  writeFileSync(transcript, records.map(e => JSON.stringify(e)).join("\n"), { mode: 0o600 });
  console.error(`Live transcript: ${transcript}`);
  throw error;
} finally {
  child.stdin.end();
  for (let i = 0; i < 100 && !exited; i++) await sleep(50);
  if (!exited) child.kill("SIGTERM");
  for (const event of toolResults("Monitor")) {
    if (event.result?.details?.output_file) rmSync(dirname(event.result.details.output_file), { recursive: true, force: true });
  }
  for (const socket of sockets) socket.destroy();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
