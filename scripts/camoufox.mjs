// Shared Camoufox loader.
//
// camoufox's ESM build crashes under Node's ESM loader ("Dynamic require of
// \"events\" is not supported", a broken esbuild bundle of its `keyv`
// dependency) — load its working CJS build instead via createRequire.
//
// On top of that, camoufox 0.1.19's BrowserForge mapping table still lists
// properties that recent Camoufox browser builds removed (navigator.product,
// navigator.appCodeName, ...), and `npx camoufox fetch` always installs the
// newest browser, so every launch dies in validateConfig with "Unknown
// property ... in config". The browser ships the authoritative property list
// in properties.json, so drop any mapping it doesn't know about — that
// survives further removals instead of needing a fix per property. It has to
// happen before camoufox reads the mapping table at import time.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Mirrors camoufox's own userCacheDir()/getPath() install-dir resolution. */
function propertiesFile() {
  if (process.platform === "win32") {
    return join(homedir(), "AppData", "Local", "camoufox", "camoufox", "Cache", "properties.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "camoufox", "Camoufox.app", "Contents", "Resources", "properties.json");
  }
  return join(homedir(), ".cache", "camoufox", "properties.json");
}

function knownProperties() {
  const file = propertiesFile();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.map((entry) => entry.property));
  } catch {
    return null;
  }
}

function pruneBrowserforgeMappings() {
  const known = knownProperties();
  if (!known || known.size === 0) return;

  const yml = join(dirname(require.resolve("camoufox")), "..", "data-files", "browserforge.yml");
  const original = readFileSync(yml, "utf8");
  const patched = original
    .split(/\r?\n/)
    .filter((line) => {
      const target = line.match(/^[ \t]+[\w-]+:[ \t]+(\S+)[ \t]*$/)?.[1];
      return !target || known.has(target);
    })
    .join("\n");
  if (patched !== original) writeFileSync(yml, patched);
}

pruneBrowserforgeMappings();

export const { Camoufox } = require("camoufox");
