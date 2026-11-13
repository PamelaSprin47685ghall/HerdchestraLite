import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

beforeAll(() => {
  nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
});

async function evalJson(form) {
  await nbb.loadString("(require '[herd.ariadne :as a])");
  const json = await nbb.loadString(`(js/JSON.stringify (clj->js ${form}))`);
  return JSON.parse(json);
}

describe("Ariadne anchors and beacons", () => {
  it("records an anchor and queues a time leap", async () => {
    const result = await evalJson(`(do
      (herd.ariadne/record-anchor! \"test\" \"anchor-1\" \"call-1\")
      (herd.ariadne/time-leap! \"test\" {:target "anchor-1"
                                :experience "e"
                                :beacon_name "beacon-1"
                                :beacon_description "d"}))`);
    expect(result.state).toBe("leaped");
    expect(result.target).toBe("anchor-1");
    expect(result.beacon).toBe("beacon-1");
  });

  it("consumes the pending jump exactly once", async () => {
    const first = await evalJson("(herd.ariadne/consume-jump! \"test\")");
    const second = await evalJson("(herd.ariadne/consume-jump! \"test\")");
    expect(first.target).toBe("anchor-1");
    expect(second).toBe(null);
  });

  it("rejects unknown targets and duplicate beacons", async () => {
    const unknown = await evalJson(`(try
      (herd.ariadne/time-leap! \"test\" {:target "missing" :experience "e"})
      (catch :default e {:code (:code (ex-data e))}))`);
    expect(unknown.code).toBe("STALE_CONTROL");
    const duplicate = await evalJson(`(try
      (herd.ariadne/time-leap! \"test\" {:target "anchor-1"
                                :experience "e"
                                :beacon_name "beacon-1"
                                :beacon_description "d"})
      (catch :default e {:code (:code (ex-data e))}))`);
    expect(duplicate.code).toBe("NAME_TAKEN");
  });

  it("returns beacon descriptions and rejects unknown beacons", async () => {
    const found = await evalJson("(herd.ariadne/ask-beacon \"test\" {:target \"beacon-1\" :question \"q\"})");
    expect(found.description).toBe("d");
    const missing = await evalJson(`(try
      (herd.ariadne/ask-beacon \"test\" {:target "missing" :question "q"})
      (catch :default e {:code (:code (ex-data e))}))`);
    expect(missing.code).toBe("INVALID_ARGUMENT");
  });
});
