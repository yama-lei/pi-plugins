import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Text } from "@earendil-works/pi-tui";

export async function select(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
  if (ctx.mode !== "tui") return ctx.ui.select(title, options);
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const input = new Input({ prompt: "Search: ", placeholder: "输入名称筛选（支持模糊/部分 ID，如 5.6）" });
    const visibleRows = Math.max(1, Math.min(12, tui.terminal.rows - 6));
    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
    const container = new Container();
    const buildList = (query: string) => {
      // SelectList only supports prefix filtering, so rebuild it from a fuzzy-ranked subset.
      const matches = query.trim() ? fuzzyFilter(options, query.trim(), value => value) : options;
      const next = new SelectList(matches.map(value => ({ value, label: value })), visibleRows, listTheme);
      next.onSelect = item => done(item.value);
      next.onCancel = () => done(undefined);
      return next;
    };
    let list = buildList("");
    container.addChild(new Text(theme.fg("accent", title), 0, 0));
    container.addChild(input);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 返回"), 0, 0));
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const)
          .some(action => keybindings.matches(data, action))) {
          list.handleInput(data);
        } else {
          const before = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== before) {
            container.removeChild(list);
            list = buildList(input.getValue());
            container.children.splice(2, 0, list);
          }
        }
        tui.requestRender();
      },
    };
  });
}
