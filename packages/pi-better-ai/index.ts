import { CustomEditor, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PROVIDER_NAME, PROVIDER_ID, routeSubmission, UNMATCHED_SUFFIX } from "./catalog.ts";
import { customProvider } from "./provider.ts";
import { select } from "./picker.ts";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(customProvider());

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      class ProviderEditor extends CustomEditor {
        handleInput(data: string) {
          const submit = this.onSubmit;
          this.onSubmit = text => submit?.(routeSubmission(text));
          try { super.handleInput(data); }
          finally { this.onSubmit = submit; }
        }
      }
      return new ProviderEditor(tui, theme, keybindings);
    });
  });

  async function pickModel(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) {
      ctx.ui.notify("/models 需要交互式 UI", "warning");
      return;
    }
    const result = await ctx.modelRegistry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(15000) });
    if (result.errors.size) ctx.ui.notify("部分模型目录加载失败，使用现有可用模型。", "warning");
    const available = ctx.modelRegistry.getAvailable();
    const scoped = ctx.scopedModels;
    const models = scoped.length ? available.filter(model => scoped.some(entry =>
      entry.model.provider === model.provider && entry.model.id === model.id)) : available;
    if (!models.length) {
      ctx.ui.notify("没有可用模型，请先 /login。", "warning");
      return;
    }
    const providers = [...new Set(models.map(model => model.provider))].sort((a, b) =>
      a === PROVIDER_ID ? -1 : b === PROVIDER_ID ? 1 : a.localeCompare(b));
    const customAuth = providers.includes(PROVIDER_ID) ? await ctx.modelRegistry.getProviderAuth(PROVIDER_ID) : undefined;
    const providerLabels = providers.map(id => {
      const name = id === PROVIDER_ID ? customAuth?.env?.PROVIDER_NAME ?? DEFAULT_PROVIDER_NAME : ctx.modelRegistry.getProviderDisplayName(id);
      return `${name} (${id})`;
    });
    while (true) {
      const selectedProvider = await select(ctx, "Provider → Models · 选择 provider", providerLabels);
      if (!selectedProvider) return;
      const provider = providers[providerLabels.indexOf(selectedProvider)];
      const items = models.filter(model => model.provider === provider).sort((a, b) =>
        Number(a.name.endsWith(UNMATCHED_SUFFIX)) - Number(b.name.endsWith(UNMATCHED_SUFFIX)));
      const labels = items.map(model => `${model.id} — ${model.name}`);
      const selected = await select(ctx, `${selectedProvider} → Models`, ["← Providers", ...labels]);
      if (!selected || selected === "← Providers") continue;
      const model = items[labels.indexOf(selected)];
      if (!model) return;
      if (await pi.setModel(model)) ctx.ui.notify(`Model: ${model.provider}/${model.id}`, "info");
      else ctx.ui.notify("该 provider 尚未配置有效认证，请先 /login。", "error");
      return;
    }
  }

  pi.registerCommand("models", {
    description: "Provider → Models 两级模型选择",
    handler: async (_args, ctx) => {
      try { await pickModel(ctx); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "模型选择失败", "error"); }
    },
  });
}
