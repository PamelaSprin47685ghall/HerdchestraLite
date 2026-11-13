import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

beforeAll(async () => {
  globalThis.__pi = {
    tools: new Map(),
    hooks: new Map(),
    active: [],
    registerTool(definition) { this.tools.set(definition.name, definition); },
    on(name, handler) { this.hooks.set(name, handler); },
    getActiveTools() { return [...this.active]; },
    setActiveTools(next) { this.active = [...next]; },
  };
  nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
  await nbb.loadFile(fileURLToPath(new URL("../src/herd/bootstrap.cljs", import.meta.url)));
});

async function clj(form) {
  return nbb.loadString(form);
}

describe("time leap context projection", () => {
  it("trims messages at the anchor and appends the experience", async () => {
    await clj("(require '[herd.ariadne :as a])");
    await clj("(a/record-anchor! \"main\" \"ctx-anchor\" \"call-ctx\")");
    await clj("(a/time-leap! \"main\" {:target \"ctx-anchor\" :experience \"EXP\" :beacon_name \"ctx-beacon\" :beacon_description \"D\"})");
    const handler = globalThis.__pi.hooks.get("context");
    const messages = [
      { role: "user", content: "u0" },
      { role: "assistant", toolCallId: "call-ctx", content: "a1" },
      { role: "user", content: "u2" },
    ];
    const result = handler({ messages }, {});
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe("u2");
    expect(result.messages[1].content).toContain("EXP");
  });

  it("leaves messages untouched without a pending jump", async () => {
    const handler = globalThis.__pi.hooks.get("context");
    const messages = [{ role: "user", content: "same" }];
    const result = handler({ messages }, {});
    expect(result.messages).toBe(messages);
  });
});
