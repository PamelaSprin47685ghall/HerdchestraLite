import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

globalThis.__bunTest = { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn };
globalThis.__herdNbb = nbb;
globalThis.__herdRequire = createRequire(import.meta.url);
globalThis.__herdEntryPath = fileURLToPath(new URL("../src/clj-main.mjs", import.meta.url));
nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
await nbb.loadFile(fileURLToPath(new URL("cljs/harness.cljs", import.meta.url)));
