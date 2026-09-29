// Shared Camoufox loader.
//
// camoufox's ESM build crashes under Node's ESM loader ("Dynamic require of
// \"events\" is not supported", a broken esbuild bundle of its `keyv`
// dependency) — load its working CJS build instead via createRequire.
//
// On top of that, camoufox 0.1.19 still maps BrowserForge's `navigator.product`
// into the browser config, but recent Camoufox browser builds removed that
// property, so every launch fails with "Unknown property navigator.product in
// config". `npx camoufox fetch` always installs the newest browser, so the
// stale mapping has to be dropped from the package's data file before camoufox
// reads it at import time.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const BROWSERFORGE_YML = join(dirname(require.resolve("camoufox")), "..", "data-files", "browserforge.yml");
const original = readFileSync(BROWSERFORGE_YML, "utf8");
const patched = original.replace(/^[ \t]*product:[ \t]*navigator\.product[ \t]*\r?\n/m, "");
if (patched !== original) writeFileSync(BROWSERFORGE_YML, patched);

export const { Camoufox } = require("camoufox");
