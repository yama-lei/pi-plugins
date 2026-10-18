import type { Api, Model } from "@earendil-works/pi-ai";

// Keep existing credentials, cached models and session references compatible.
export const PROVIDER_ID = "self-define";
export const DEFAULT_PROVIDER_NAME = "custom provider";
export const CATALOG_URL = "https://pi.dev/api/models";
export const UNMATCHED_SUFFIX = " [unmatched]";

export function normalizeProviderName(value: string): string {
  const name = value.trim() || DEFAULT_PROVIDER_NAME;
  if (name.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new Error("Provider 名称不能超过 80 个字符，也不能包含控制字符");
  }
  return name;
}

export function normalizeEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Endpoint 必须是完整的 http:// 或 https:// URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Endpoint 只允许 HTTP(S)，不能包含账号、密码、查询参数或 fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/models$/, "") || "/v1";
  return url.toString().replace(/\/+$/, "");
}

export function parseModelIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throw new Error("模型接口必须返回 OpenAI 格式的 { data: [{ id: ... }] }");
  }
  const data = (body as { data: unknown[] }).data;
  if (data.some(entry => !entry || typeof entry !== "object" ||
    typeof (entry as { id?: unknown }).id !== "string" || !(entry as { id: string }).id.trim() ||
    /[\u0000-\u001f\u007f-\u009f]/.test((entry as { id: string }).id))) {
    throw new Error("模型列表含无效 id");
  }
  const ids = [...new Set(data.map(entry => (entry as { id: string }).id))];
  if (!ids.length) throw new Error("Endpoint 没有返回可用模型");
  return ids;
}

export function parseCatalog(body: unknown): Model<Api>[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("pi.dev 模型目录格式无效");
  const models = Object.values(body).flatMap(group => {
    if (!group || typeof group !== "object") return [];
    const entries = Array.isArray(group) ? group : Object.values(group);
    return entries.filter((entry): entry is Model<Api> => {
      if (!entry || typeof entry !== "object") return false;
      const model = entry as Model<Api>;
      return (!model.type || model.type === "chat") && typeof model.id === "string" &&
        typeof model.name === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(model.name) && typeof model.reasoning === "boolean" &&
        Array.isArray(model.input) && model.input.includes("text") &&
        Number.isFinite(model.contextWindow) && model.contextWindow > 0 &&
        Number.isFinite(model.maxTokens) && model.maxTokens > 0 &&
        !!model.cost && [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite]
          .every(value => Number.isFinite(value) && value >= 0);
    });
  });
  if (!models.length) throw new Error("pi.dev 模型目录为空或无效");
  return models;
}

export function matchModels(ids: string[], catalog: readonly Model<Api>[], endpoint: string): Model<"openai-completions">[] {
  const matched: Model<"openai-completions">[] = [];
  const unmatched: Model<"openai-completions">[] = [];
  for (const id of ids) {
    const candidates = catalog.filter(model => model.id === id);
    const known = candidates.find(model => model.api === "openai-completions") ?? candidates[0];
    const model: Model<"openai-completions"> = {
      id, provider: PROVIDER_ID, api: "openai-completions", baseUrl: endpoint,
      name: known?.name ?? `${id}${UNMATCHED_SUFFIX}`,
      reasoning: known?.reasoning ?? false,
      input: known ? [...known.input] : ["text"],
      contextWindow: known?.contextWindow ?? 32768,
      maxTokens: known?.maxTokens ?? 4096,
      cost: known ? { ...known.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    (known ? matched : unmatched).push(model);
  }
  return [...matched, ...unmatched];
}

export function routeSubmission(text: string): string {
  const command = text.trim();
  if (command === "/model") return "/models";
  return text;
}
