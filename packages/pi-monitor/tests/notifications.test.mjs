import assert from "node:assert/strict";
import { test } from "node:test";
import { MonitorNotifications } from "../notifications.mjs";
import { LIMITS } from "../monitor.mjs";

const event = (id, extra = {}) => ({
  task_id: id, description: id, kind: "events", events: ["tick"], status: "running",
  exit_code: null, occurred_at: 1000, output_file: `/tmp/${id}/stdout.log`, stderr_file: `/tmp/${id}/stderr.log`,
  ...extra,
});

test("notifications merge per task without merging different failures, with occurrence and delivery times", () => {
  const queue = new MonitorNotifications();
  queue.add(event("one"));
  queue.add(event("one", { kind: "ended", events: 2, output: ["failed one"], exit_code: 101, status: "error", reason: "exit 101", occurred_at: 2000 }));
  queue.add(event("two", { kind: "ended", events: 1, output: ["failed two"], exit_code: 7, status: "error", reason: "exit 7" }));
  const message = queue.drain(10000);
  assert.equal(queue.size, 0);
  assert.equal(message.details.kind, "digest");
  assert.equal(message.details.notifications.length, 2);
  assert.deepEqual(message.details.notifications[0].output, ["tick", "failed one"]);
  assert.match(message.content, /1970-01-01T00:00:01.000Z to 1970-01-01T00:00:02.000Z/);
  assert.match(message.content, /Delivered: 1970-01-01T00:00:10.000Z/);
  assert.match(message.content, /exit=101/);
  assert.match(message.content, /exit=7/);
  assert.equal(queue.drain(), undefined);
});

test("pending buffers and delivered output stay bounded with valid UTF-8 and explicit truncation", () => {
  const queue = new MonitorNotifications();
  for (let i = 0; i < 10; i++) for (let batch = 0; batch < 10; batch++) {
    queue.add(event(String(i), { events: ["中".repeat(5000)], stderr: "错".repeat(5000) }));
  }
  for (const item of queue.pending.values()) assert.ok(Buffer.byteLength(item.output.join("\n")) <= 8192);
  const message = queue.drain();
  const output = message.details.notifications.map(item => item.output.join("\n") + item.stderr).join("");
  assert.ok(Buffer.byteLength(output) <= LIMITS.maxBatchBytes);
  assert.ok(!output.includes("�"));
  assert.match(message.content, /Output truncated/);
  assert.equal(message.details.notifications.length, 10, "status and log paths survive exhausted output budget");
});

test("bounded task metadata reports overflow and recent distinct failures", () => {
  const queue = new MonitorNotifications();
  for (let i = 0; i < 120; i++) queue.add(event(String(i), { kind: "ended", status: "error", events: 1, reason: `failure ${i}` }));
  assert.equal(queue.pending.size, LIMITS.maxHistory + LIMITS.maxActive);
  const message = queue.drain();
  assert.equal(message.details.omitted, 12);
  assert.equal(message.details.omitted_failures.length, 8);
  assert.match(message.content, /failure 11/);
  assert.match(message.content, /12 older task notifications omitted/);
});

test("stopped task progress and shutdown data can be discarded", () => {
  const queue = new MonitorNotifications();
  queue.add(event("one")); queue.add(event("two"));
  queue.remove("one");
  assert.equal(queue.drain().details.task_id, "two");
  queue.add(event("three"));
  queue.clear();
  assert.equal(queue.drain(), undefined);
});
