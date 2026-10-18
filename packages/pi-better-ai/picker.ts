import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text } from "@earendil-works/pi-tui";

export async function select(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
  if (ctx.mode !== "tui") return ctx.ui.select(title, options);
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const input = new Input({ prompt: "Search: ", placeholder: "输入名称筛选" });
    const list = new SelectList(options.map(value => ({ value, label: value })),
      Math.max(1, Math.min(12, tui.terminal.rows - 6)), {
        selectedPrefix: text => theme.fg("accent", text),
        selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text),
        scrollInfo: text => theme.fg("dim", text),
        noMatch: text => theme.fg("warning", text),
      });
    list.onSelect = item => done(item.value);
    list.onCancel = () => done(undefined);
    const container = new Container();
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
          input.handleInput(data);
          list.setFilter(input.getValue());
        }
        tui.requestRender();
      },
    };
  });
}
