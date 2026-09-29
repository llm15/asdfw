// Shared Camoufox loader.
//
// camoufox's ESM build crashes under Node's ESM loader ("Dynamic require of
// \"events\" is not supported", a broken esbuild bundle of its `keyv`
// dependency) — load its working CJS build instead via createRequire.
//
// On top of that, camoufox 0.1.19 lags behind the browser builds that
// `npx camoufox fetch` installs: it still feeds the launcher properties newer
// builds removed (navigator.product, navigator.appCodeName,
// window.history.length, ...) — some from its BrowserForge mapping table,
// some hardcoded — and its validateConfig() aborts the launch with "Unknown
// property ... in config". The browser ignores properties it doesn't know, so
// relax that check to drop them instead of throwing: one patch that survives
// further removals rather than a fix per property. It has to be applied to the
// bundle on disk, since validateConfig isn't reachable from the module's API.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const STRICT_CHECK = `    if (!expectedType) {
      throw new UnknownProperty(\`Unknown property \${key} in config\`);
    }`;
const LENIENT_CHECK = `    if (!expectedType) {
      delete configMap[key];
      continue;
    }`;

function relaxConfigValidation() {
  // Bundle chunk names are content-hashed, so find the file by its contents.
  const dist = dirname(require.resolve("camoufox"));
  for (const name of readdirSync(dist).filter((n) => n.endsWith(".cjs"))) {
    const file = join(dist, name);
    const original = readFileSync(file, "utf8");
    if (!original.includes(STRICT_CHECK)) continue;
    writeFileSync(file, original.replace(STRICT_CHECK, LENIENT_CHECK));
    return;
  }
}

relaxConfigValidation();

export const { Camoufox } = require("camoufox");
