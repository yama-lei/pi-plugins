import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { MonitorManager, LIMITS, readOutputPreview, safeText, validateMonitor } from "../monitor.mjs";

async function until(predicate, timeout = 4000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for monitor");
    await sleep(10);
  }
}

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-monitor-test-"));
  const messages = [];
  const manager = new MonitorManager({ notify: m => messages.push(m), outputRoot: root, ...options });
  t.after(() => { manager.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return { manager, root, messages, events: () => messages.filter(m => m.kind === "events").flatMap(m => m.events), ended: () => messages.find(m => m.kind === "ended") };
}

class FakeSocket extends EventTarget {
  static instances = [];
  constructor(url, protocols) {
    super(); this.url = url; this.protocols = protocols; this.closed = false;
    FakeSocket.instances.push(this);
  }
  sendText(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  close() { this.closed = true; }
  end(code = 1000, reason = "") { const event = new Event("close"); Object.assign(event, { code, reason }); this.dispatchEvent(event); }
}

test("validation and defaults happen before file, process, or socket side effects", t => {
  const f = fixture(t);
  const valid = { description: "errors", command: "printf ok" };
  assert.equal(validateMonitor(valid).timeout_ms, 300000);
  assert.equal(validateMonitor(valid).persistent, false);
  assert.equal(validateMonitor({ ...valid, persistent: true, timeout_ms: -1 }).timeout_ms, -1);
  for (const input of [
    {}, { ...valid, description: "" }, { ...valid, description: "bad\nlabel" }, { ...valid, description: "a".repeat(201) },
    { ...valid, command: "" }, { ...valid, command: "x\0y" }, { ...valid, timeout_ms: 999 }, { ...valid, timeout_ms: 3600001 },
    { ...valid, timeout_ms: 1000.5 }, { ...valid, timeout_ms: NaN }, { ...valid, persistent: "true" },
    { ...valid, timeout_ms: null }, { ...valid, persistent: null }, { ...valid, extra: 1 },
    { ...valid, ws: { url: "wss://example.com" } }, { description: "no source" },
    ...["https://example.com", "ws://user:pass@example.com", "ws://example.com/#x", "oops"].map(url => ({ description: "x", ws: { url } })),
    { description: "x", ws: { url: "wss://example.com", protocols: ["v1", "v1"] } },
    { description: "x", ws: { url: "wss://example.com", protocols: ["bad token"] } },
    { description: "x", ws: { url: "wss://example.com", headers: {} } },
  ]) assert.throws(() => f.manager.start(input), undefined, JSON.stringify(input));
  assert.deepEqual(readdirSync(f.root), []);
  assert.throws(() => f.manager.start(valid, { signal: AbortSignal.abort() }), /cancelled/);
  assert.deepEqual(readdirSync(f.root), []);
});

test("command returns immediately, streams before exit, batches for 200ms, and preserves stderr only in file", async t => {
  const f = fixture(t);
  const start = Date.now();
  const task = f.manager.start({ description: "demo", command: "printf 'one\ntwo\n'; printf 'secret-error\n' >&2; sleep 0.6; printf 'three\n'" });
  assert.ok(Date.now() - start < 400);
  await until(() => f.messages.length > 0);
  assert.deepEqual(f.messages[0].events, ["one", "two"]);
  assert.ok(Date.now() - start >= LIMITS.batchMs - 20);
  assert.equal(f.ended(), undefined, "a notification must arrive before the process exits");
  await until(f.ended);
  assert.deepEqual(f.events(), ["one", "two", "three"]);
  assert.equal(f.ended().events, 3);
  assert.equal(f.ended().status, "ended");
  assert.equal(readFileSync(task.output_file, "utf8"), "one\ntwo\nthree\n");
  assert.equal(readFileSync(task.stderr_file, "utf8"), "secret-error\n");
  if (process.platform !== "win32") assert.equal(statSync(task.stderr_file).mode & 0o777, 0o600);
});

test("2>&1 merges stderr, CRLF and EOF fragments become events, command failures notify once", async t => {
  const f = fixture(t);
  f.manager.start({ description: "failure", command: "{ printf 'line\r\n'; printf 'Error\n' >&2; printf 'partial'; exit 7; } 2>&1" });
  await until(f.ended);
  assert.deepEqual(f.events(), ["line", "Error", "partial"]);
  assert.equal(f.ended().status, "error");
  assert.match(f.ended().reason, /exit 7/);
  await sleep(250);
  assert.equal(f.messages.filter(m => m.kind === "ended").length, 1);
});

test("incremental UTF-8 decoding and terminal control stripping retain original log bytes", async t => {
  const f = fixture(t);
  const code = "const b=Buffer.from('中文\\x1b[31m红色\\x1b[0m\\n');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30)";
  const task = f.manager.start({ description: "utf8", command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}` });
  await until(f.ended);
  assert.deepEqual(f.events(), ["中文红色"]);
  assert.match(readFileSync(task.output_file, "utf8"), /\x1b\[31m/);
  assert.equal(safeText("ok\x1b]0;evil\x07\x1b[2J\x00!"), "ok!");
});

test("spawn errors are terminal notifications, never uncaught error events", async t => {
  const f = fixture(t);
  f.manager.start({ description: "missing shell", command: "echo ok" }, { shell: { shell: "/nonexistent/pi-monitor-shell", args: ["-c"] } });
  await until(f.ended);
  assert.equal(f.ended().status, "error");
  assert.match(f.ended().reason, /ENOENT/);
  assert.equal(f.messages.length, 1);
});

test("timeout kills the process group, including pipeline children", async t => {
  const f = fixture(t);
  const task = f.manager.start({ description: "timeout", command: "sleep 30 & echo $!; wait", timeout_ms: 1000 });
  const internal = f.manager.tasks.get(task.task_id);
  await until(() => f.events().length);
  const pid = Number(f.events()[0]);
  await until(f.ended);
  assert.equal(f.ended().status, "timeout");
  assert.equal(f.manager.tasks.size, 0);
  if (process.platform !== "win32") {
    await until(() => {
      // Linux zombies can remain briefly until their parent/reaper collects them.
      try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z"; } catch { return true; }
    });
    await until(() => internal.child.exitCode !== null || internal.child.signalCode !== null);
  }
});

test("persistent ignores timeout; TaskStop flushes pending events and stops exactly once", async t => {
  const f = fixture(t, { WebSocket: FakeSocket });
  const task = f.manager.start({ description: "persistent", ws: { url: "ws://example.com" }, persistent: true, timeout_ms: 1 });
  const socket = FakeSocket.instances.at(-1);
  socket.sendText("one");
  await sleep(30);
  assert.equal(f.ended(), undefined);
  assert.equal(f.manager.tasks.get(task.task_id).timeout, undefined);
  assert.equal(f.manager.stop(task.task_id).status, "stopped");
  assert.equal(socket.closed, true);
  assert.deepEqual(f.events(), ["one"]);
  socket.sendText("late"); socket.end();
  assert.equal(f.messages.filter(m => m.kind === "ended").length, 1);
  assert.throws(() => f.manager.stop(task.task_id), /not running/);
});

test("shutdown is idempotent, cancels batching, closes resources, and suppresses stale notifications", async t => {
  const f = fixture(t, { WebSocket: FakeSocket });
  f.manager.start({ description: "shutdown", ws: { url: "ws://example.com" }, persistent: true });
  const socket = FakeSocket.instances.at(-1);
  socket.sendText("pending");
  f.manager.shutdown(); f.manager.shutdown();
  socket.sendText("late"); socket.end();
  await sleep(250);
  assert.equal(f.messages.length, 0);
  assert.equal(f.manager.tasks.size, 0);
  assert.equal(socket.closed, true);
  assert.throws(() => f.manager.start({ description: "late", command: "true" }), /session has ended/);
});

test("WebSocket protocols, multiline text messages, binary ignoring, clean and abnormal close", async t => {
  const f = fixture(t, { WebSocket: FakeSocket });
  const task = f.manager.start({ description: "ws", ws: { url: "wss://example.com/feed", protocols: ["v1"] } });
  const socket = FakeSocket.instances.at(-1);
  assert.deepEqual(socket.protocols, ["v1"]);
  socket.sendText("a\nb"); socket.sendText(new Uint8Array([1, 2])); socket.sendText(""); socket.end();
  assert.deepEqual(f.events(), ["a\nb", ""]);
  assert.equal(readFileSync(task.output_file, "utf8"), "a\nb\n\n");
  assert.equal(f.ended().status, "ended");
  f.manager.start({ description: "abnormal", ws: { url: "ws://example.com" } });
  FakeSocket.instances.at(-1).end(1006);
  assert.equal(f.messages.at(-1).status, "error");
  f.manager.start({ description: "error", ws: { url: "ws://example.com" } });
  FakeSocket.instances.at(-1).dispatchEvent(new Event("error"));
  assert.match(f.messages.at(-1).reason, /connection error/);
});

test("output limits stop floods and keep captured log files bounded", async t => {
  for (const [limits, payload, count, reason] of [
    [{ maxEventsPerSecond: 2 }, "x", 3, /rate/],
    [{ maxEvents: 2 }, "x", 3, /total event/],
    [{ maxEventBytes: 3 }, "four", 1, /event/],
    [{ maxBatchBytes: 3 }, "xx", 2, /batch/],
    [{ maxBytesPerSecond: 3 }, "four", 1, /rate/],
    [{ maxOutputBytes: 3 }, "four", 1, /file size/],
  ]) {
    const f = fixture(t, { WebSocket: FakeSocket, limits });
    const task = f.manager.start({ description: "limit", ws: { url: "ws://example.com" } });
    const socket = FakeSocket.instances.at(-1);
    for (let i = 0; i < count; i++) socket.sendText(payload);
    assert.equal(f.ended()?.status, "limit");
    assert.match(f.ended().reason, reason);
    assert.ok(statSync(task.output_file).size <= (limits.maxOutputBytes ?? LIMITS.maxOutputBytes));
    assert.equal(socket.closed, true);
  }
});

test("newline-free stdout and stderr floods also stop automatically", async t => {
  for (const command of ["printf 'abcdef'; sleep 10", "printf 'abcdef' >&2; sleep 10"]) {
    const f = fixture(t, { limits: { maxEventBytes: 3, maxOutputBytes: command.includes(">&2") ? 3 : 100 } });
    f.manager.start({ description: "flood", command });
    await until(f.ended);
    assert.equal(f.ended().status, "limit");
  }
});

test("active monitor cap rejects before creating more files", t => {
  const f = fixture(t, { WebSocket: FakeSocket, limits: { maxActive: 1 } });
  f.manager.start({ description: "first", ws: { url: "ws://example.com" } });
  assert.throws(() => f.manager.start({ description: "second", ws: { url: "ws://example.com" } }), /At most 1/);
  assert.equal(readdirSync(f.root).length, 1);
});

test("list and inspect retain completed task metadata, durations, source, and separate output", async t => {
  const f = fixture(t, { WebSocket: FakeSocket });
  const task = f.manager.start({ description: "retained title", ws: { url: "ws://example.com", protocols: ["v1"] }, persistent: true });
  const socket = FakeSocket.instances.at(-1);
  socket.sendText("first\nsecond");
  assert.equal(f.manager.list()[0].task_id, task.task_id);
  const initial = f.manager.get(task.task_id).duration_ms;
  await sleep(25);
  assert.ok(f.manager.get(task.task_id).duration_ms > initial);
  const active = f.manager.inspect(task.task_id);
  assert.equal(active.stdout.text, "first\nsecond\n");
  assert.equal(active.stderr.text, "");
  assert.equal(active.events, 1);
  assert.deepEqual(active.ws.protocols, ["v1"]);
  active.ws.protocols.push("mutated");
  assert.deepEqual(f.manager.get(task.task_id).ws.protocols, ["v1"]);
  f.manager.stop(task.task_id, "stopped by /monitor stop");
  const stopped = f.manager.get(task.task_id);
  assert.equal(stopped.reason, "stopped by /monitor stop");
  assert.equal(stopped.ended_at - stopped.started_at, stopped.duration_ms);
  await sleep(25);
  assert.equal(f.manager.list()[0].duration_ms, stopped.duration_ms);
  assert.equal(f.manager.tasks.size, 0);
  assert.equal(f.manager.history.size, 1);
  assert.equal("socket" in f.manager.history.get(task.task_id), false);
  assert.equal(f.manager.inspect(task.task_id).stdout.text, active.stdout.text);
});

test("completed history is bounded, active tasks are kept first, shutdown clears session metadata", t => {
  const f = fixture(t, { WebSocket: FakeSocket, limits: { maxHistory: 2 } });
  const first = f.manager.start({ description: "oldest", ws: { url: "ws://example.com" } });
  f.manager.stop(first.task_id);
  for (const description of ["second", "third"]) {
    const task = f.manager.start({ description, ws: { url: "ws://example.com" } });
    f.manager.stop(task.task_id);
  }
  const running = f.manager.start({ description: "running", ws: { url: "ws://example.com" } });
  assert.deepEqual(f.manager.list().map(task => task.description), ["running", "third", "second"]);
  assert.equal(f.manager.get(first.task_id), undefined);
  assert.throws(() => f.manager.inspect(first.task_id), /not available/);
  let closed = 0;
  f.manager.onShutdown(() => closed++);
  f.manager.shutdown(); f.manager.shutdown();
  assert.equal(closed, 1);
  assert.deepEqual(f.manager.list(), []);
  assert.equal(f.manager.get(running.task_id), undefined);
  assert.equal(f.manager.history.size, 0);
});

test("output previews are bounded UTF-8 tails, sanitized, and tolerate missing logs", t => {
  const f = fixture(t, { WebSocket: FakeSocket });
  const task = f.manager.start({ description: "preview", ws: { url: "ws://example.com" } });
  f.manager.stop(task.task_id);
  const data = "中".repeat(30000) + "\x1b[31mTAIL\x1b[0m\n";
  writeFileSync(task.output_file, data);
  const preview = readOutputPreview(task.output_file);
  assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(preview.text) <= LIMITS.previewBytes);
  assert.ok(!preview.text.includes("�"));
  assert.ok(!preview.text.includes("\x1b"));
  assert.ok(preview.text.endsWith("TAIL\n"));
  rmSync(task.output_file);
  assert.match(f.manager.inspect(task.task_id).stdout.error, /ENOENT/);
});

test("real Node WebSocket connects to a loopback server and delivers text before close", async t => {
  const server = createServer();
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  server.on("upgrade", (req, socket) => {
    const key = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\nSec-WebSocket-Protocol: v1\r\n\r\n`);
    socket.write(Buffer.from([0x81, 5, ...Buffer.from("hello")]));
    const timer = setTimeout(() => socket.end(Buffer.from([0x88, 2, 0x03, 0xe8])), 350);
    socket.on("close", () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const f = fixture(t);
  f.manager.start({ description: "native ws", ws: { url: `ws://127.0.0.1:${server.address().port}`, protocols: ["v1"] } });
  await until(() => f.events().length);
  assert.deepEqual(f.events(), ["hello"]);
  assert.equal(f.ended(), undefined);
  await until(f.ended);
  assert.equal(f.ended().status, "ended");
});
