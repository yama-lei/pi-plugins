import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// Resolve host dependencies exactly as the existing pi-better-ai tests do.
let host = process.env.PI_HOST_DIR ?? dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(host, "package.json"))) {
  const parent = dirname(host);
  if (parent === host) throw new Error("Tests need an installed npm Pi. Set PI_HOST_DIR to its package directory.");
  host = parent;
}
process.env.PI_TEST_HOST_DIR = host;
const require = createRequire(join(host, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(host, "dist/index.js"),
    "@earendil-works/pi-tui": join(host, "node_modules/@earendil-works/pi-tui/dist/index.js"),
    typebox: join(host, "node_modules/typebox/build/index.mjs"),
  },
});
await jiti.import("./extension.test.ts");
await jiti.import("./browser.test.ts");
