import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// Reuse the installed Pi modules, like Pi's extension loader; no duplicate host dependencies.
let host = process.env.PI_HOST_DIR ?? dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(host, "package.json"))) {
  const parent = dirname(host);
  if (parent === host) throw new Error("测试需要 npm 版 Pi；请用 PI_HOST_DIR 指定 Pi 包目录。");
  host = parent;
}
const require = createRequire(join(host, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-ai/providers/all": join(host, "node_modules/@earendil-works/pi-ai/dist/providers/all.js"),
    "@earendil-works/pi-ai/compat": join(host, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-ai": join(host, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-coding-agent": join(host, "dist/index.js"),
    "@earendil-works/pi-tui": join(host, "node_modules/@earendil-works/pi-tui/dist/index.js"),
    typebox: join(host, "node_modules/typebox/build/index.mjs"),
  },
});
await jiti.import("./extension.test.ts");
