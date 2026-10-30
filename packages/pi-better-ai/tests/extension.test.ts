import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { initTheme, OAuthSelectorComponent } from "@earendil-works/pi-coding-agent";
import { CATALOG_URL, matchModels, normalizeEndpoint, normalizeProviderName, parseCatalog, parseModelIds, routeSubmission } from "../catalog.ts";
import { customProvider } from "../provider.ts";
import extension from "../index.ts";
import { select } from "../picker.ts";
import { loadWebConfig, orderChannels, registerWebTools } from "../web.ts";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";

const known = {
  id: "known", name: "Known model", provider: "openai", api: "openai-responses",
  baseUrl: "https://upstream.example/v1", input: ["text", "image"], reasoning: true,
  contextWindow: 200000, maxTokens: 16384,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  headers: { Authorization: "must not copy" }, compat: { supportsStore: true },
};

function interaction(endpoint = "https://proxy.example", key = "test-key", name = "custom provider") {
  const answers = [name, endpoint, key];
  return { signal: new AbortController().signal, prompt: async () => answers.shift()!, notify() {} };
}

function fixture() {
  const original = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];
  let failing = false;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (failing && String(url) !== CATALOG_URL) return new Response("test-key", { status: 401 });
    return Response.json(String(url) === CATALOG_URL ? { openai: { known } } : { data: [{ id: "unknown" }, { id: "known" }] });
  };
  return { requests, fail: () => { failing = true; }, restore: () => { globalThis.fetch = original; } };
}

test("endpoint normalization, validation, and routing", () => {
  assert.equal(normalizeEndpoint("https://example.com"), "https://example.com/v1");
  assert.equal(normalizeEndpoint("https://example.com/custom/v1/models/"), "https://example.com/custom/v1");
  for (const url of ["no-url", "file:///tmp/key", "https://user:key@example.com", "https://example.com?key=x", "https://example.com#x"]) {
    assert.throws(() => normalizeEndpoint(url));
  }
  assert.equal(routeSubmission(" /login "), " /login ");
  assert.equal(routeSubmission("/model"), "/models");
  for (const text of ["/login openai", "/login self-define", "/model openai/gpt-4", "/models", "hello"]) {
    assert.equal(routeSubmission(text), text);
  }
});

test("provider names support Unicode, default on blank input, and reject unsafe or oversized names", () => {
  assert.equal(normalizeProviderName(" 我的代理 "), "我的代理");
  assert.equal(normalizeProviderName("  "), "custom provider");
  assert.equal(normalizeProviderName("a".repeat(80)), "a".repeat(80));
  for (const name of ["a".repeat(81), "bad\u001bname", "bad\u0000name", "bad\nname"]) {
    assert.throws(() => normalizeProviderName(name));
  }
});

test("catalog matching copies metadata, not upstream authentication/compatibility", () => {
  const catalog = parseCatalog({ openai: { known }, nonchat: { model: { ...known, type: "image" } } });
  assert.equal(catalog.length, 1);
  const models = matchModels(["unknown", "known", "other"], catalog, "https://proxy.example/v1");
  assert.deepEqual(models.map(model => model.id), ["known", "unknown", "other"]);
  assert.equal(models[0].api, "openai-completions");
  assert.equal(models[0].contextWindow, 200000);
  assert.equal(models[0].baseUrl, "https://proxy.example/v1");
  assert.equal(models[0].headers, undefined);
  assert.equal(models[0].compat, undefined);
  assert.equal(models[1].reasoning, false);
  assert.deepEqual(parseModelIds({ data: [{ id: "a" }, { id: "a" }] }), ["a"]);
  for (const body of [{}, { data: [] }, { data: [{ id: 1 }] }, { data: [{ id: "" }] }, { data: [{ id: "bad\u001bid" }] }]) {
    assert.throws(() => parseModelIds(body));
  }
  assert.throws(() => parseCatalog({ invalid: { x: { id: "x" } } }));
});

test("native pi-ai login saves name/endpoint/key and publishes ordered models during offline synchronization", async () => {
  const f = fixture();
  try {
    const provider = customProvider();
    const credentials = new InMemoryCredentialStore();
    const runtime = createModels({ credentials });
    runtime.setProvider(provider);
    await runtime.login(provider.id, "api_key", interaction("https://proxy.example", "test-key", "我的代理"));
    const storedCredential = await credentials.read(provider.id);
    assert.equal(storedCredential?.type, "api_key");
    assert.equal(storedCredential?.key, "test-key");
    assert.equal(storedCredential?.env?.ENDPOINT, "https://proxy.example/v1");
    assert.equal(storedCredential?.env?.PROVIDER_NAME, "我的代理");
    const result = await runtime.refresh({ allowNetwork: false });
    assert.equal(result.errors.size, 0);
    assert.deepEqual(provider.getModels().map(model => model.id), ["known", "unknown"]);
    const auth = await runtime.getAuth(provider.id);
    assert.equal(auth?.auth.baseUrl, "https://proxy.example/v1");
    assert.equal(auth?.auth.apiKey, "test-key");
    assert.equal(auth?.env?.PROVIDER_NAME, "我的代理");
    const restarted = createModels({ credentials });
    restarted.setProvider(customProvider());
    assert.equal((await restarted.getAuth(provider.id))?.env?.PROVIDER_NAME, "我的代理");
    assert.equal(f.requests[0].init.redirect, "error");
    assert.equal((f.requests[0].init.headers as Record<string, string>).Authorization, "Bearer test-key");
    assert.equal((f.requests[1].init.headers as Record<string, string>).Authorization, undefined);
    assert.equal((await runtime.getAvailable()).length, 2);

    f.fail();
    await assert.rejects(runtime.login(provider.id, "api_key", interaction("https://other.example", "different-key")), /HTTP 401/);
    assert.deepEqual(await credentials.read(provider.id), storedCredential);
    assert.deepEqual(provider.getModels().map(model => model.id), ["known", "unknown"]);
    await runtime.logout(provider.id);
    assert.equal((await runtime.getAvailable()).length, 0);
    await credentials.modify(provider.id, async () => ({
      type: "api_key", key: "test-key", env: { ENDPOINT: "https://proxy.example/v1" },
    }));
    assert.equal((await runtime.getAuth(provider.id))?.env?.PROVIDER_NAME, "custom provider");
  } finally { f.restore(); }
});

test("offline startup restores catalog; failed refresh retains it; stale endpoint cache is ignored", async () => {
  const f = fixture();
  try {
    const provider = customProvider();
    const credential = await provider.auth.apiKey!.login!(interaction());
    let stored;
    const ctx = {
      credential, stored, allowNetwork: false, signal: new AbortController().signal,
      publish: async publication => {
        if (publication.persist) stored = publication.persist;
        publication.update?.();
        return true;
      },
    };
    await provider.refreshModels!(ctx);
    assert(!JSON.stringify(stored).includes("test-key"));
    const restored = customProvider();
    await restored.refreshModels!({ ...ctx, stored });
    assert.equal(restored.getModels().length, 2);
    f.fail();
    await assert.rejects(restored.refreshModels!({ ...ctx, stored, allowNetwork: true, force: true }), /401/);
    assert.equal(restored.getModels().length, 2);
    await restored.refreshModels!({ ...ctx, stored, credential: { ...credential, env: { ENDPOINT: "https://new.example/v1" } } });
    assert.equal(restored.getModels().length, 0);
  } finally { f.restore(); }
});

test("pi.dev outage falls back to bundled models, cancellation never saves credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url) === CATALOG_URL ? new Response("", { status: 503 }) :
    Response.json({ data: [{ id: "unknown" }] });
  try {
    const provider = customProvider();
    const credential = await provider.auth.apiKey!.login!(interaction("https://proxy.example", "test-key", " "));
    assert.equal(credential.type, "api_key");
    assert.equal(credential.env?.PROVIDER_NAME, "custom provider");
    const cancelled = interaction();
    cancelled.signal = AbortSignal.abort();
    await assert.rejects(provider.auth.apiKey!.login!(cancelled));
    await assert.rejects(provider.auth.apiKey!.login!(interaction("https://proxy.example", "!echo test")));
    await assert.rejects(provider.auth.apiKey!.login!(interaction("https://proxy.example", "bad\u0000key")));
    for (const name of ["a".repeat(81), "bad\u001bname"]) {
      await assert.rejects(provider.auth.apiKey!.login!(interaction("https://proxy.example", "test-key", name)));
    }
  } finally { globalThis.fetch = original; }
});

test("extension registers menus; Provider → Models preserves unknown-last ordering and back navigation", async () => {
  const commands = new Map();
  const events = new Map();
  let selected;
  extension({ registerProvider() {}, registerTool() {}, on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    setModel: async model => { selected = model; return true; } } as any);
  assert(events.has("session_start"));
  assert(!commands.has("self-login"));
  assert(!commands.has("login"));
  const models = matchModels(["unknown", "known"], [known] as any, "https://proxy.example/v1");
  const dialogs: { title: string; options: string[] }[] = [];
  let providerName: string | undefined = "我的代理";
  const answers = ["我的代理 (self-define)", "← Providers", "我的代理 (self-define)", "known — Known model"];
  const ctx = {
    hasUI: true, scopedModels: [],
    ui: { select: async (title, options) => { dialogs.push({ title, options }); return answers.shift(); }, notify() {} },
    modelRegistry: { refresh: async () => ({ errors: new Map() }), getAvailable: () => models,
      getProviderDisplayName: () => "★ custom provider",
      getProviderAuth: async () => ({ env: { PROVIDER_NAME: providerName } }) },
  };
  await commands.get("models").handler("", ctx);
  assert.equal(selected.id, "known");
  assert(dialogs[0].title.includes("Provider"));
  assert.deepEqual(dialogs[0].options, ["我的代理 (self-define)"]);
  assert.deepEqual(dialogs[1].options, ["← Providers", "known — Known model", "unknown — unknown [unmatched]"]);
  providerName = undefined;
  answers.push("custom provider (self-define)", "known — Known model");
  await commands.get("models").handler("", ctx);
  assert.deepEqual(dialogs[4].options, ["custom provider (self-define)"]);
});

test("real custom editor routes model selection but preserves every native login command", async () => {
  const commands = new Map();
  const events = new Map();
  extension({ registerProvider() {}, registerTool() {}, on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command) } as any);
  let editor;
  const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
  const keybindings = getKeybindings();
  const ctx = { mode: "tui", ui: { setEditorComponent(factory) {
    editor = factory(tui, { borderColor: text => text }, keybindings);
  } } };
  events.get("session_start")({}, ctx);
  const forwarded: string[] = [];
  const originalSubmit = text => { forwarded.push(text); };
  editor.onSubmit = originalSubmit;
  for (const [input, output] of [["/login", "/login"], ["/model", "/models"], ["/login openai", "/login openai"], ["/login self-define", "/login self-define"], ["hello", "hello"]]) {
    editor.setText(input);
    editor.handleInput("\r");
    assert.equal(forwarded.at(-1), output);
    assert.equal(editor.onSubmit, originalSubmit);
  }
});

test("native API-key provider selector lists custom provider first, without adding it to OAuth", () => {
  const provider = customProvider();
  const providers = [...builtinProviders(), provider];
  assert(!provider.auth.oauth);
  assert(!providers.filter(entry => entry.auth.oauth).some(entry => entry.id === provider.id));
  // Same filter and alphabetical order as Pi's getLoginProviderOptions('api_key').
  const options = providers.filter(entry => entry.auth.apiKey).map(entry => ({
    id: entry.id, name: entry.name, authType: "api_key" as const, method: entry.auth.apiKey,
  })).sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(options[0].id, "self-define");
  assert.equal(options[0].name, "★ custom provider");
  initTheme("dark", false);
  let chosen;
  const selector = new OAuthSelectorComponent("login", options, (id, authType) => { chosen = { id, authType }; }, () => {});
  assert(selector.render(80).some(line => line.includes("custom provider")));
  selector.handleInput("\r");
  assert.deepEqual(chosen, { id: "self-define", authType: "api_key" });
});

test("search picker is bounded, supports filtering and IME focus, and fits narrow terminals", async () => {
  let component;
  const ctx = { mode: "tui", ui: { custom: factory => new Promise(resolve => {
    component = factory({ terminal: { rows: 24 }, requestRender() {} },
      { fg: (_color, text) => text }, getKeybindings(), resolve);
  }) } };
  const promise = select(ctx as any, "选择模型", Array.from({ length: 100 }, (_, i) => `model-${i}`));
  component.focused = true;
  assert.equal(component.focused, true);
  assert(component.render(20).length < 24);
  assert(component.render(20).every(line => visibleWidth(line) <= 20));
  component.handleInput("model-99");
  component.handleInput("\r");
  assert.equal(await promise, "model-99");
});

test("search picker fuzzy-matches partial model ids", async () => {
  let component;
  const ctx = { mode: "tui", ui: { custom: factory => new Promise(resolve => {
    component = factory({ terminal: { rows: 24 }, requestRender() {} },
      { fg: (_color, text) => text }, getKeybindings(), resolve);
  }) } };
  const promise = select(ctx as any, "选择模型", ["claude-sonnet-4", "gpt-4o", "gpt-5.6-sol"]);
  component.handleInput("5.6");
  component.handleInput("\r");
  assert.equal(await promise, "gpt-5.6-sol");
  const second = select(ctx as any, "选择模型", ["claude-sonnet-4", "gpt-4o", "gpt-5.6-sol"]);
  component.handleInput("gptsol");
  component.handleInput("\r");
  assert.equal(await second, "gpt-5.6-sol");
});

test("web tools: only active when a channel exists; fall back across channels; custom relay is probed", async () => {
  const tools = new Map(); const events = new Map(); const commands = new Map();
  let active = ["read", "web_search", "web_fetch"];
  const calls: string[] = [];
  const fakeFetch = (async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("deepseek")) return new Response("{}", { status: 500 });
    if (String(url).includes("chatgpt.com")) {
      assert.equal(JSON.parse(init.body).commands.search_query[0].q, "rust");
      return Response.json({ output: "Answer cite\ue202r1\ue201", results: [{ ref_id: "r1", url: "https://a.example", title: "A" }] });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const pi = { registerTool: tool => tools.set(tool.name, tool), on: (n, h) => events.set(n, h),
    registerCommand: (n, c) => commands.set(n, c), getActiveTools: () => active, setActiveTools: names => { active = names; } };
  registerWebTools(pi as any, fakeFetch, () => loadWebConfig(mkdtempSync(join(tmpdir(), "pba-"))));
  const registry = (keys: Record<string, string>, custom?: any) => ({
    getApiKeyForProvider: async id => keys[id], getProviderAuth: async () => custom });
  const ctx = (keys, custom?) => ({ modelRegistry: registry(keys, custom), ui: { notify() {} } });

  await events.get("session_start")({}, ctx({}));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(active, ["read"]);

  const both = ctx({ deepseek: "k1", "openai-codex": "t.e30.s" });
  await events.get("session_start")({}, both);
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(active, ["read", "web_search", "web_fetch"]);
  const result = await tools.get("web_search").execute("id", { query: "rust" }, undefined, undefined, both);
  assert.equal(result.details.channel, "openai-codex");
  assert(result.content[0].text.includes("Answer [1]") && result.content[0].text.includes("https://a.example"));
  await assert.rejects(tools.get("web_fetch").execute("id", { url: "file:///etc/passwd" }, undefined, undefined, both));

  const relay = ctx({}, { auth: { apiKey: "k", baseUrl: "https://relay.example/v1" } });
  await events.get("session_start")({}, relay);
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(active, ["read"]);
  assert(calls.includes("https://relay.example/v1/tools/search"));
});

test("web channel order: own provider first, then codex > deepseek > custom; config can reorder/disable", () => {
  const ch = ["deepseek", "custom", "openai-codex"].map(id => ({ id, label: id })) as any;
  const ids = (list) => list.map(c => c.id);
  const defaults = loadWebConfig(mkdtempSync(join(tmpdir(), "pba-")));
  assert.deepEqual(ids(orderChannels([...ch], undefined, defaults)), ["openai-codex", "deepseek", "custom"]);
  assert.deepEqual(ids(orderChannels([...ch], "deepseek", defaults)), ["deepseek", "openai-codex", "custom"]);
  assert.deepEqual(ids(orderChannels([...ch], "self-define", defaults)), ["custom", "openai-codex", "deepseek"]);
  const dir = mkdtempSync(join(tmpdir(), "pba-"));
  writeFileSync(join(dir, "pi-better-ai.json"), JSON.stringify({ web: { order: ["deepseek"], disabled: ["custom", "bogus"], preferCurrentProvider: false } }));
  const config = loadWebConfig(dir);
  assert.deepEqual(ids(orderChannels([...ch], "openai-codex", config)), ["deepseek", "openai-codex"]);
  writeFileSync(join(dir, "pi-better-ai.json"), "{not json");
  assert.deepEqual(loadWebConfig(dir), defaults);
});

test("web_fetch uses DeepSeek's /v1/tools/fetch", async () => {
  const tools = new Map();
  let body;
  const fakeFetch = (async (url, init) => {
    assert.equal(String(url), "https://api.deepseek.com/v1/tools/fetch");
    body = JSON.parse(init.body);
    return Response.json({ title: "T", content: "hello" });
  }) as typeof fetch;
  registerWebTools({ registerTool: tool => tools.set(tool.name, tool), on() {}, registerCommand() {} } as any, fakeFetch,
    () => loadWebConfig(mkdtempSync(join(tmpdir(), "pba-"))));
  const ctx = { modelRegistry: { getApiKeyForProvider: async id => id === "deepseek" ? "k" : undefined, getProviderAuth: async () => undefined } };
  const result = await tools.get("web_fetch").execute("id", { url: "https://example.com/a" }, undefined, undefined, ctx);
  assert.deepEqual(body, { url: "https://example.com/a" });
  assert.equal(result.content[0].text, "# T\n\nhello");
});

test("provider delegates real SSE response handling to pi-ai OpenAI completions", async () => {
  const f = fixture();
  try {
    const provider = customProvider();
    const runtime = createModels({ credentials: new InMemoryCredentialStore() });
    runtime.setProvider(provider);
    await runtime.login(provider.id, "api_key", interaction());
    await runtime.refresh({ allowNetwork: false });
    let requestedUrl;
    globalThis.fetch = async (url, init) => {
      requestedUrl = String(url);
      assert.equal((init?.headers as Record<string, string>).Authorization ?? new Headers(init?.headers).get("authorization"), "Bearer test-key");
      return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const model = runtime.getModel(provider.id, "unknown")!;
    const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Say OK", timestamp: Date.now() }] });
    assert.equal(result.stopReason, "stop");
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].text, "OK");
    assert.equal(requestedUrl, "https://proxy.example/v1/chat/completions");
  } finally { f.restore(); }
});
