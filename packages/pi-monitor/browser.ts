import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { MonitorManager, safeText } from "./monitor.mjs";

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  return `${days ? `${days}d ` : ""}${hours || days ? `${hours}h ` : ""}${minutes || hours || days ? `${minutes}m ` : ""}${seconds % 60}s`;
}

function summary(task: any): string {
  return `${task.task_id} · ${task.status} · ${formatDuration(task.duration_ms)} · ${task.events} events · ${task.persistent ? "persistent" : `timeout ${task.timeout_ms / 1000}s`}`;
}

/** Session-only browser. Closing this view never stops the monitors it displays. */
export class MonitorBrowser {
  private list?: SelectList;
  private listKey = "";
  private taskId?: string;
  private stream: "stdout" | "stderr" = "stdout";
  private previewKey = "";
  private output = new Text("", 0, 0);
  private metadata = new Text("", 0, 0);
  private scroll = 0;
  private follow = true;
  private totalLines = 0;
  private bodyHeight = 1;
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;

  constructor(private manager: MonitorManager, private tui: TUI, private theme: Theme, private kb: KeybindingsManager, private done: () => void) {
    this.timer = setInterval(() => {
      if (manager.closed) this.close();
      else tui.requestRender();
    }, 250);
    this.timer.unref?.();
    this.unsubscribe = manager.onShutdown(() => this.close());
  }

  private height() {
    return Math.max(1, Math.min(32, Math.floor(this.tui.terminal.rows * 0.8)));
  }

  private updateList() {
    const tasks = this.manager.list();
    const items = tasks.map(task => ({
      value: task.task_id,
      label: `${task.task_id}  ${task.status.padEnd(7)}  ${formatDuration(task.duration_ms).padStart(8)}  ${String(task.events).padStart(6)}  ${safeText(task.description)}`,
    }));
    const key = JSON.stringify([this.height(), items]);
    if (key !== this.listKey) {
      const selected = this.list?.getSelectedItem()?.value;
      this.list = new SelectList(items, Math.max(1, this.height() - 5), {
        selectedPrefix: text => this.theme.fg("accent", text),
        selectedText: text => this.theme.fg("accent", text),
        description: text => this.theme.fg("muted", text),
        scrollInfo: text => this.theme.fg("dim", text),
        noMatch: () => this.theme.fg("muted", "No monitors in this session."),
      });
      this.list.setSelectedIndex(Math.max(0, items.findIndex(item => item.value === selected)));
      this.list.onSelect = item => {
        this.taskId = item.value;
        this.stream = "stdout";
        this.previewKey = "";
        this.scroll = 0;
        this.follow = true;
      };
      this.list.onCancel = () => this.close();
      this.listKey = key;
    }
    return tasks;
  }

  private updatePreview(task: any) {
    const key = `${task.task_id}:${task.output_bytes}:${task.events}:${task.status}:${this.stream}`;
    if (key === this.previewKey) return;
    const detail = this.manager.inspect(task.task_id);
    const preview = detail[this.stream];
    const source = detail.command !== undefined ? `Command: ${detail.command}` : `WebSocket: ${detail.ws.url}\nProtocols: ${detail.ws.protocols.join(", ") || "none"}`;
    this.metadata.setText(safeText([
      `Started: ${new Date(detail.started_at).toISOString()}`,
      ...(detail.ended_at === null ? [] : [`Ended: ${new Date(detail.ended_at).toISOString()}`]),
      source.length > 4096 ? `${source.slice(0, 4096)} [source truncated]` : source,
      ...(detail.reason ? [`Reason: ${detail.reason}`] : []),
      `File: ${this.stream === "stdout" ? detail.output_file : detail.stderr_file}`,
      "",
      `${this.stream} · ${preview.bytes} bytes${preview.truncated ? " · showing last 64 KiB, earlier output omitted" : ""}`,
    ].join("\n")));
    this.output.setText(preview.error ? `[Unable to read output: ${preview.error}]` : preview.text || "[No output yet]");
    this.previewKey = key;
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const height = this.height();
    const tasks = this.updateList();
    let lines: string[];
    if (!this.taskId) {
      const running = tasks.filter(task => task.status === "running").length;
      lines = [
        this.theme.fg("accent", this.theme.bold(`Monitors · ${running} running · ${tasks.length - running} completed`)),
        this.theme.fg("muted", "  ID        STATUS   DURATION  EVENTS  TITLE"),
        "",
        ...this.list!.render(width),
        this.theme.fg("dim", "↑↓ select · Enter details · Esc close · /monitor stop <id>"),
      ];
    } else {
      const task = this.manager.get(this.taskId);
      if (!task) {
        lines = ["Monitor no longer available in this session.", "Esc returns to the list."];
      } else {
        this.updatePreview(task);
        this.bodyHeight = Math.max(1, height - 5);
        const content = [...this.metadata.render(width), "", ...this.output.render(width)];
        this.totalLines = content.length;
        const end = Math.max(0, content.length - this.bodyHeight);
        this.scroll = this.follow ? end : Math.min(this.scroll, end);
        lines = [
          this.theme.fg("accent", this.theme.bold(`Monitor details · ${safeText(task.description)}`)),
          this.theme.fg("muted", summary(task)),
          this.theme.fg("accent", this.stream === "stdout" ? "[stdout]  stderr" : " stdout  [stderr]"),
          ...content.slice(this.scroll, this.scroll + this.bodyHeight),
          this.theme.fg("dim", `Lines ${this.scroll + 1}–${Math.min(content.length, this.scroll + this.bodyHeight)}/${content.length} · ${this.follow ? "following output" : "scroll paused"}`),
          this.theme.fg("dim", "↑↓ scroll · PgUp/PgDn · Home/End · Tab stdout/stderr · Esc list"),
        ];
      }
    }
    return lines.slice(0, height).map(line => truncateToWidth(line, width));
  }

  handleInput(data: string) {
    if (this.disposed) return;
    this.updateList();
    if (!this.taskId) this.list!.handleInput(data);
    else if (this.kb.matches(data, "tui.select.cancel")) {
      this.taskId = undefined;
      this.previewKey = "";
    } else if (this.kb.matches(data, "tui.input.tab")) {
      this.stream = this.stream === "stdout" ? "stderr" : "stdout";
      this.previewKey = "";
      this.scroll = 0;
      this.follow = true;
    } else if (this.kb.matches(data, "tui.editor.cursorLineStart")) {
      this.scroll = 0;
      this.follow = false;
    } else if (this.kb.matches(data, "tui.editor.cursorLineEnd")) {
      this.follow = true;
    } else {
      let delta = 0;
      if (this.kb.matches(data, "tui.select.up")) delta = -1;
      else if (this.kb.matches(data, "tui.select.down")) delta = 1;
      else if (this.kb.matches(data, "tui.select.pageUp")) delta = -this.bodyHeight;
      else if (this.kb.matches(data, "tui.select.pageDown")) delta = this.bodyHeight;
      if (delta) {
        const end = Math.max(0, this.totalLines - this.bodyHeight);
        this.scroll = Math.max(0, Math.min(end, this.scroll + delta));
        this.follow = delta > 0 && this.scroll === end;
      }
    }
    this.tui.requestRender();
  }

  invalidate() {
    this.listKey = "";
    this.previewKey = "";
    this.output.invalidate();
    this.metadata.invalidate();
  }

  private close() {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.unsubscribe();
  }
}

export async function browseMonitors(manager: MonitorManager, ctx: ExtensionCommandContext) {
  if (ctx.mode === "tui") {
    await ctx.ui.custom<void>((tui, theme, kb, done) => new MonitorBrowser(manager, tui, theme, kb, () => done(undefined)), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" },
    });
  } else if (ctx.hasUI) {
    // RPC supports native dialogs, but not custom TUI components.
    while (!manager.closed) {
      const tasks = manager.list();
      if (!tasks.length) { ctx.ui.notify("No monitors in this session.", "info"); return; }
      const labels = tasks.map(task => `${safeText(task.description)} · ${summary(task)}`);
      const choice = await ctx.ui.select("Monitors · select to inspect", labels);
      const index = labels.indexOf(choice ?? "");
      if (index === -1 || manager.closed) return;
      const task = manager.inspect(tasks[index].task_id);
      const output = (name: "stdout" | "stderr") => {
        const preview = task[name];
        return `${name}${preview.truncated ? " [last 64 KiB]" : ""}:\n${preview.error ? `[Unable to read output: ${preview.error}]` : preview.text || "[No output yet]"}`;
      };
      const text = safeText(`${task.description}\n${summary(task)}\nStarted: ${new Date(task.started_at).toISOString()}\n${task.reason ?? ""}\n${task.command ?? task.ws.url}\nstdout file: ${task.output_file}\nstderr file: ${task.stderr_file}\n\n${output("stdout")}\n\n${output("stderr")}`);
      await ctx.ui.select(text, ["Back to monitors"]);
    }
  } else {
    ctx.ui.notify("/monitor ls needs TUI or an RPC client with selection dialogs.", "error");
  }
}
