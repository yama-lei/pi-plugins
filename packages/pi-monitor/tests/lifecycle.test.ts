import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import extension from "../index.ts";

async function fixture(t: any, respond: (request: number, context: any) => Promise<any[]> | any[]) {
  const root = mkdtempSync(join(tmpdir(), "pi-monitor-lifecycle-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(project); mkdirSync(agentDir);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
  let requests = 0;
  runtime.registerProvider("monitor-test", {
    api: "openai-completions", apiKey: "local-test-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "scripted", name: "Scripted local test", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      const request = ++requests;
      void (async () => {
        const content = await respond(request, context);
        const message: any = {
          role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: content.some(item => item.type === "toolCall") ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      })().catch(error => stream.end({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", errorMessage: String(error), timestamp: Date.now() } as any));
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false }, followUpMode: "one-at-a-time", enableAnalytics: false });
  const loader = new DefaultResourceLoader({
    cwd: project, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [extension],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: project, agentDir, resourceLoader: loader, modelRuntime: runtime,
    model: runtime.getModel("monitor-test", "scripted"), thinkingLevel: "off", tools: ["Monitor", "TaskStop"],
    settingsManager, sessionManager: SessionManager.inMemory(project),
  });
  const errors: any[] = [];
  await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
  const dirs = new Set<string>();
  let settlements = 0;
  session.subscribe(event => {
    if (event.type === "agent_settled") settlements++;
    if (event.type === "tool_execution_end" && event.toolName === "Monitor" && event.result?.details?.output_file) dirs.add(dirname(event.result.details.output_file));
  });
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { session, errors, requests: () => requests, settlements: () => settlements };
}

const tool = (id: string, arguments_: any, name = "Monitor") => ({ type: "toolCall", id, name, arguments: arguments_ });
const done = [{ type: "text", text: "done" }];
const params = (description: string, command: string, notify = "events") => ({ description, command, notify, timeout_ms: 5000, persistent: false });

// These tests run the real Pi session and extension runner with an in-process,
// scripted provider. No external model, credentials, or resource installation.
test("real Pi consumes busy Monitor output as one boundary digest without queued follow-up requests", async t => {
  let deliveredContext = "";
  const f = await fixture(t, async (request, context) => {
    if (request === 1) return [
      tool("build", params("build", "printf 'progress\\n'; sleep 0.3; printf 'failed\\n'; exit 101")),
      tool("download", params("download", "printf 'ready\\n'", "completion")),
    ];
    if (request === 2) { await sleep(650); return done; }
    if (request === 3) { deliveredContext = JSON.stringify(context); return done; }
    throw new Error(`Unexpected extra model request ${request}`);
  });
  await f.session.prompt("start jobs and do other work");
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests(), 3, "two work requests and exactly one notification continuation");
  const notices = f.session.messages.filter((message: any) => message.customType === "monitor") as any[];
  assert.equal(notices.length, 1);
  assert.equal(notices[0].details.kind, "digest");
  assert.equal(notices[0].details.notifications.length, 2);
  assert.ok(notices[0].details.notifications.every((item: any) => item.kind === "ended"));
  assert.match(deliveredContext, /exit=101/);
  assert.match(deliveredContext, /ready/);
  assert.equal(f.session.agent.hasQueuedMessages(), false);
  await sleep(250);
  assert.equal(f.requests(), 3, "no stale notifications after the main task settles");
});

test("real Pi wakes once for an idle completion and exposes stderr and exit status", async t => {
  const f = await fixture(t, async request => {
    if (request === 1) return [tool("late", params("idle job", "sleep 0.5; printf 'result\\n'; printf 'diagnostic\\n' >&2; exit 7", "completion"))];
    if (request > 3) throw new Error(`Unexpected request ${request}`);
    return done;
  });
  await f.session.prompt("start a job");
  assert.equal(f.requests(), 2);
  const deadline = Date.now() + 4000;
  while (f.settlements() < 2 && Date.now() < deadline) await sleep(20);
  assert.equal(f.settlements(), 2);
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests(), 3);
  const notices = f.session.messages.filter((message: any) => message.customType === "monitor") as any[];
  assert.equal(notices.length, 1);
  assert.equal(notices[0].details.exit_code, 7);
  assert.match(notices[0].content, /diagnostic/);
  assert.equal(f.session.agent.hasQueuedMessages(), false);
});
