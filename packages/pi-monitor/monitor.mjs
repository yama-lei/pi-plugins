import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export const LIMITS = Object.freeze({
  batchMs: 200,
  maxActive: 8,
  maxHistory: 100,
  previewBytes: 64 * 1024,
  maxEventBytes: 16 * 1024,
  maxBatchBytes: 32 * 1024,
  maxEventsPerSecond: 100,
  maxEvents: 1000,
  maxBytesPerSecond: 1024 * 1024,
  maxOutputBytes: 10 * 1024 * 1024,
});

function object(value, name, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${name} field: ${key}`);
}

export function validateMonitor(input) {
  object(input, "Monitor", ["description", "timeout_ms", "persistent", "command", "ws"]);
  if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 200 || /[\x00-\x1f\x7f-\x9f]/u.test(input.description)) {
    throw new Error("description must be a nonempty single-line string, at most 200 characters");
  }
  const persistent = input.persistent === undefined ? false : input.persistent;
  const timeout_ms = input.timeout_ms === undefined ? 300000 : input.timeout_ms;
  if (typeof persistent !== "boolean") throw new Error("persistent must be boolean");
  // Persistent monitors ignore the timeout value, including its numeric range.
  if (typeof timeout_ms !== "number" || !Number.isFinite(timeout_ms) || (!persistent && (!Number.isInteger(timeout_ms) || timeout_ms < 1000 || timeout_ms > 3600000))) {
    throw new Error("timeout_ms must be an integer from 1000 to 3600000 unless persistent is true");
  }
  if ((input.command !== undefined) === (input.ws !== undefined)) throw new Error("Provide exactly one of command or ws");
  if (input.command !== undefined && (typeof input.command !== "string" || !input.command.trim() || input.command.includes("\0"))) {
    throw new Error("command must be a nonempty shell command without NUL");
  }
  let ws;
  if (input.ws !== undefined) {
    object(input.ws, "ws", ["url", "protocols"]);
    if (typeof input.ws.url !== "string") throw new Error("ws.url must be a ws:// or wss:// URL");
    let url;
    try { url = new URL(input.ws.url); } catch { throw new Error("ws.url must be a ws:// or wss:// URL"); }
    if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error("ws.url must use ws:// or wss:// without credentials or fragments");
    }
    const protocols = input.ws.protocols;
    if (protocols !== undefined && (!Array.isArray(protocols) || protocols.some(p => typeof p !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p)) || new Set(protocols).size !== protocols.length)) {
      throw new Error("ws.protocols must contain unique WebSocket protocol tokens");
    }
    ws = { url: url.href, ...(protocols === undefined ? {} : { protocols: [...protocols] }) };
  }
  return { description: input.description.trim(), persistent, timeout_ms, ...(ws ? { ws } : { command: input.command }) };
}

// Never send terminal control sequences from an external stream to a renderer.
export function safeText(text) {
  return String(text).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\uFFF9-\uFFFB]/g, "");
}

// Read only a bounded tail, even when a monitor has written megabytes of output.
export function readOutputPreview(path, maxBytes = LIMITS.previewBytes) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const offset = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    let start = 0;
    // A tail can start inside a UTF-8 code point. Drop its continuation bytes.
    if (offset) while (start < read && (buffer[start] & 0xc0) === 0x80) start++;
    return { text: safeText(buffer.subarray(start, read).toString("utf8")), truncated: offset > 0, bytes: size };
  } catch (error) {
    return { text: "", truncated: false, bytes: 0, error: safeText(error.message) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {});
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } }
  }
}

export class MonitorManager {
  constructor({ notify, WebSocket = globalThis.WebSocket, limits = {}, outputRoot = tmpdir() }) {
    this.notify = notify;
    this.WebSocket = WebSocket;
    this.limits = { ...LIMITS, ...limits };
    this.outputRoot = outputRoot;
    this.tasks = new Map();
    // Completed tasks retain metadata only, never processes, sockets, or output buffers.
    this.history = new Map();
    this.shutdownListeners = new Set();
    this.closed = false;
  }

  start(input, { cwd, shell = { shell: "/bin/sh", args: ["-c"] }, signal } = {}) {
    const params = validateMonitor(input);
    if (this.closed) throw new Error("Monitor session has ended");
    if (signal?.aborted) throw new Error("Monitor start cancelled");
    if (this.tasks.size >= this.limits.maxActive) throw new Error(`At most ${this.limits.maxActive} monitors may run at once`);
    if (params.ws && !this.WebSocket) throw new Error("This Node.js runtime does not provide WebSocket");
    const dir = mkdtempSync(join(this.outputRoot, "pi-monitor-"));
    const task = {
      ...params, task_id: randomUUID().slice(0, 8),
      output_file: join(dir, "stdout.log"), stderr_file: join(dir, "stderr.log"),
      fds: [], pending: [], pendingBytes: 0, line: "", decoder: new StringDecoder("utf8"),
      events: 0, bytes: 0, window: [], done: false, started_at: Date.now(),
    };
    // IDs remain unambiguous for both active tasks and retained history.
    while (this.tasks.has(task.task_id) || this.history.has(task.task_id)) task.task_id = randomUUID().slice(0, 8);
    try {
      task.fds.push(openSync(task.output_file, "wx", 0o600));
      task.fds.push(openSync(task.stderr_file, "wx", 0o600));
      this.tasks.set(task.task_id, task);
      if (params.command !== undefined) this.startCommand(task, cwd, shell);
      else this.startSocket(task);
      if (!params.persistent) task.timeout = setTimeout(() => this.finish(task, "timeout", `timed out after ${params.timeout_ms}ms`), params.timeout_ms);
      return this.snapshot(task);
    } catch (error) {
      this.finish(task, "error", `failed to start: ${error.message}`, false);
      throw error;
    }
  }

  snapshot(task) {
    return {
      task_id: task.task_id, description: task.description, persistent: task.persistent,
      timeout_ms: task.persistent ? null : task.timeout_ms,
      output_file: task.output_file, stderr_file: task.stderr_file,
      events: task.events, status: task.done ? task.status : "running",
      started_at: task.started_at, ended_at: task.ended_at ?? null,
      duration_ms: Math.max(0, (task.ended_at ?? Date.now()) - task.started_at),
      output_bytes: task.bytes, reason: task.reason ?? null,
      ...(task.command !== undefined ? { command: task.command } : { ws: { ...task.ws, protocols: [...(task.ws.protocols ?? [])] } }),
    };
  }

  list() {
    if (this.closed) return [];
    return [
      ...[...this.tasks.values()].sort((a, b) => b.started_at - a.started_at).map(task => this.snapshot(task)),
      ...[...this.history.values()].reverse().map(task => structuredClone(task)),
    ];
  }

  get(task_id) {
    if (this.closed) return undefined;
    const active = this.tasks.get(task_id);
    return active ? this.snapshot(active) : this.history.has(task_id) ? structuredClone(this.history.get(task_id)) : undefined;
  }

  inspect(task_id) {
    const task = this.get(task_id);
    if (!task) throw new Error(`Monitor task ${task_id} is not available in this session`);
    return { ...task, stdout: readOutputPreview(task.output_file, this.limits.previewBytes), stderr: readOutputPreview(task.stderr_file, this.limits.previewBytes) };
  }

  startCommand(task, cwd, shell) {
    const stdinCommand = shell.commandTransport === "stdin";
    task.child = spawn(shell.shell, stdinCommand ? shell.args : [...shell.args, task.command], {
      cwd, detached: process.platform !== "win32", windowsHide: true,
      stdio: [stdinCommand ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (stdinCommand) {
      task.child.stdin.on("error", () => {});
      task.child.stdin.end(`${task.command}\n`);
    }
    task.child.stdout.on("data", chunk => {
      if (this.capture(task, chunk, 0)) this.consume(task, task.decoder.write(chunk));
    });
    task.child.stderr.on("data", chunk => this.capture(task, chunk, 1));
    task.child.on("error", error => this.finish(task, "error", `command error: ${error.message}`));
    // 'close', not 'exit', guarantees stdout has drained before the terminal notification.
    task.child.on("close", (code, signal) => {
      if (task.done) return;
      this.consume(task, task.decoder.end());
      if (task.line) this.event(task, task.line.replace(/\r$/, ""));
      task.line = "";
      this.finish(task, code === 0 ? "ended" : "error", code === 0 ? "stream ended" : `stream ended: exit ${code ?? "null"}${signal ? `, signal ${signal}` : ""}`);
    });
  }

  startSocket(task) {
    task.socket = new this.WebSocket(task.ws.url, task.ws.protocols);
    task.socket.addEventListener("message", message => {
      if (task.done || typeof message.data !== "string") return;
      const chunk = Buffer.from(message.data + "\n");
      if (this.capture(task, chunk, 0)) this.event(task, message.data);
    });
    task.socket.addEventListener("error", () => this.finish(task, "error", "WebSocket connection error"));
    task.socket.addEventListener("close", event => this.finish(task, event.code === 1000 || event.code === 1005 ? "ended" : "error", `stream ended: WebSocket close ${event.code}${event.reason ? ` (${safeText(event.reason).slice(0, 200)})` : ""}`));
  }

  // A rolling one-second window prevents bursts straddling a fixed window boundary.
  allowance(task, bytes = 0, events = 0) {
    const now = Date.now();
    task.window = task.window.filter(item => now - item.at < 1000);
    const used = task.window.reduce((sum, item) => ({ bytes: sum.bytes + item.bytes, events: sum.events + item.events }), { bytes: 0, events: 0 });
    if (used.bytes + bytes > this.limits.maxBytesPerSecond || used.events + events > this.limits.maxEventsPerSecond) {
      this.finish(task, "limit", "automatically stopped: output rate limit exceeded");
      return false;
    }
    task.window.push({ at: now, bytes, events });
    return true;
  }

  capture(task, chunk, fd) {
    if (task.done) return false;
    const remaining = this.limits.maxOutputBytes - task.bytes;
    try {
      writeSync(task.fds[fd], chunk.subarray(0, Math.max(0, remaining)));
    } catch (error) {
      this.finish(task, "error", `output file error: ${error.message}`);
      return false;
    }
    task.bytes += chunk.length;
    if (task.bytes > this.limits.maxOutputBytes) {
      this.finish(task, "limit", "automatically stopped: output file size limit exceeded");
      return false;
    }
    return this.allowance(task, chunk.length);
  }

  consume(task, text) {
    if (task.done) return;
    const lines = (task.line + text).split("\n");
    task.line = lines.pop();
    for (const line of lines) {
      this.event(task, line.replace(/\r$/, ""));
      if (task.done) return;
    }
    if (Buffer.byteLength(task.line) > this.limits.maxEventBytes) this.finish(task, "limit", "automatically stopped: line size limit exceeded");
  }

  event(task, text) {
    if (task.done) return;
    const bytes = Buffer.byteLength(text);
    if (bytes > this.limits.maxEventBytes || task.pendingBytes + bytes > this.limits.maxBatchBytes || task.events >= this.limits.maxEvents) {
      this.finish(task, "limit", "automatically stopped: event, batch, or total event limit exceeded");
      return;
    }
    if (!this.allowance(task, 0, 1)) return;
    task.events++;
    task.pendingBytes += bytes;
    task.pending.push(safeText(text));
    if (!task.batch) task.batch = setTimeout(() => this.flush(task), this.limits.batchMs);
  }

  flush(task) {
    clearTimeout(task.batch);
    task.batch = undefined;
    if (!task.pending.length) return;
    const events = task.pending;
    task.pending = [];
    task.pendingBytes = 0;
    this.notify({ ...this.snapshot(task), kind: "events", events, count: task.events });
  }

  finish(task, status, reason, notify = true) {
    if (task.done) return;
    task.done = true;
    task.status = status;
    task.reason = safeText(reason);
    task.ended_at = Date.now();
    clearTimeout(task.timeout);
    clearTimeout(task.batch);
    killTree(task.child);
    if (task.socket) {
      // Suppress later callbacks, including error events from cancelling a handshake.
      try { task.socket.close(); } catch { /* May already be closed. */ }
    }
    for (const fd of task.fds) { try { closeSync(fd); } catch { /* Idempotent cleanup. */ } }
    this.tasks.delete(task.task_id);
    if (!this.closed) {
      this.history.set(task.task_id, this.snapshot(task));
      while (this.history.size > this.limits.maxHistory) this.history.delete(this.history.keys().next().value);
    }
    if (notify && !this.closed) {
      this.flush(task);
      this.notify({ ...this.snapshot(task), kind: "ended", reason: safeText(reason) });
    } else {
      task.pending = [];
    }
  }

  stop(task_id, reason = "stopped by TaskStop") {
    const task = this.tasks.get(task_id);
    if (!task) throw new Error(`Monitor task ${task_id} is not running in this session`);
    this.finish(task, "stopped", reason);
    return this.snapshot(task);
  }

  onShutdown(listener) {
    this.shutdownListeners.add(listener);
    return () => this.shutdownListeners.delete(listener);
  }

  shutdown() {
    this.closed = true;
    for (const task of this.tasks.values()) this.finish(task, "stopped", "session ended", false);
    this.history.clear();
    for (const listener of this.shutdownListeners) listener();
    this.shutdownListeners.clear();
  }
}
