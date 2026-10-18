import {
  createProvider,
  type ApiKeyCredential, type Model, type Provider, type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  CATALOG_URL, DEFAULT_PROVIDER_NAME, matchModels, normalizeEndpoint, normalizeProviderName,
  parseCatalog, parseModelIds, PROVIDER_ID,
} from "./catalog.ts";

type ChatModel = Model<"openai-completions">;

async function requestJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  // Don't print server bodies: they may echo credentials.
  if (!response.ok) throw new Error(`模型目录请求失败 (HTTP ${response.status})`);
  try { return await response.json(); }
  catch { throw new Error("模型目录没有返回有效 JSON"); }
}

function configured(credential?: ApiKeyCredential): credential is ApiKeyCredential & { key: string; env: { ENDPOINT: string } } {
  return !!credential?.key && typeof credential.env?.ENDPOINT === "string";
}

export function customProvider(): Provider<"openai-completions"> {
  let models: ChatModel[] = [];
  let pending: { credential: ApiKeyCredential; models: ChatModel[] } | undefined;

  async function discover(endpoint: string, key: string, signal: AbortSignal, interaction?: ProviderAuthInteraction) {
    const ids = parseModelIds(await requestJson(`${endpoint}/models`, {
      accept: "application/json", Authorization: `Bearer ${key}`,
    }, signal));
    let catalog;
    try {
      catalog = parseCatalog(await requestJson(CATALOG_URL, { accept: "application/json" }, signal));
    } catch {
      signal.throwIfAborted();
      catalog = getBuiltinProviders().flatMap(provider => getBuiltinModels(provider));
      interaction?.notify({ type: "info", message: "pi.dev 暂不可用，使用 pi-ai 内置模型目录匹配。" });
    }
    return matchModels(ids, catalog, endpoint);
  }

  const base = createProvider<"openai-completions">({
    id: PROVIDER_ID,
    // Pi sorts native login providers by name; the star pins this API-key-only entry first.
    name: `★ ${DEFAULT_PROVIDER_NAME}`,
    models: [],
    api: openAICompletionsApi(),
    auth: {
      apiKey: {
        name: DEFAULT_PROVIDER_NAME,
        async login(interaction) {
          const name = normalizeProviderName(await interaction.prompt({
            type: "text", message: "Provider name (optional)", placeholder: DEFAULT_PROVIDER_NAME,
          }));
          const endpoint = normalizeEndpoint(await interaction.prompt({
            type: "text", message: "OpenAI-compatible endpoint", placeholder: "https://api.example.com/v1",
          }));
          const key = (await interaction.prompt({ type: "secret", message: "API key" })).trim();
          if (!key || /^[!$]/.test(key) || /[^\x21-\x7e]/.test(key)) throw new Error("请输入有效的 API key（不接受命令或变量表达式）");
          if (endpoint.startsWith("http://")) {
            interaction.notify({ type: "info", message: "注意：HTTP 不加密，API key 将以明文发送。" });
          }
          interaction.notify({ type: "progress", message: "获取模型并匹配 pi.dev 目录…" });
          const discovered = await discover(endpoint, key, interaction.signal, interaction);
          interaction.signal.throwIfAborted();
          const credential: ApiKeyCredential = { type: "api_key", key, env: { ENDPOINT: endpoint, PROVIDER_NAME: name } };
          pending = { credential, models: discovered };
          return credential;
        },
        async check({ credential }) {
          return configured(credential) ? { type: "api_key", source: "auth.json" } : undefined;
        },
        async resolve({ credential }) {
          if (!configured(credential)) return undefined;
          return {
            auth: { apiKey: credential.key, baseUrl: normalizeEndpoint(credential.env.ENDPOINT) },
            env: { ...credential.env, PROVIDER_NAME: normalizeProviderName(credential.env.PROVIDER_NAME ?? "") },
            source: "auth.json",
          };
        },
      },
    },
  });

  return {
    ...base,
    getModels: () => models,
    getAllModels: () => models,
    async refreshModels(context) {
      const credential = context.credential?.type === "api_key" ? context.credential : undefined;
      if (!configured(credential)) return;
      const endpoint = normalizeEndpoint(credential.env.ENDPOINT);
      // Login synchronization is offline: publish its already-validated list here.
      if (pending?.credential.key === credential.key && pending.credential.env?.ENDPOINT === endpoint) {
        const discovered = pending.models;
        const published = await context.publish({
          persist: { models: discovered, checkedAt: Date.now() }, update: () => { models = discovered; },
        });
        if (published) pending = undefined;
        return;
      }
      const restored = (context.stored?.models ?? []).filter(model =>
        model.provider === PROVIDER_ID && model.api === "openai-completions" && model.baseUrl === endpoint &&
        (!model.type || model.type === "chat")) as ChatModel[];
      if (!await context.publish({ update: () => { models = restored; } })) return;
      if (!context.allowNetwork || context.signal.aborted) return;
      if (!context.force && restored.length && Date.now() - (context.stored?.checkedAt ?? 0) < 3600000) return;
      const discovered = await discover(endpoint, credential.key, context.signal);
      context.signal.throwIfAborted();
      await context.publish({
        persist: { models: discovered, checkedAt: Date.now() }, update: () => { models = discovered; },
      });
    },
  };
}
