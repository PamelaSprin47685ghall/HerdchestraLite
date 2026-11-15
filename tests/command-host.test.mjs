import { describe, expect, it } from "bun:test";
import { createCommandHost, normalizeCommandResult } from "../src/bridge/command-host.mjs";

describe("bridge command host", () => {
	it("returns the same core result for five backends", () => {
		const backends = ["tui", "print", "rpc", "acp", "subagent"];
		const results = backends.map((backend) => normalizeCommandResult("herd", backend, {
			mode: "herd",
			status: "ok",
			output: "switched",
		}));
		for (const result of results) {
			expect(result.command).toBe("herd");
			expect(result.mode).toBe("herd");
			expect(result.status).toBe("ok");
			expect(result.consumed).toBe(true);
			expect(result.output).toBe("switched");
		}
		expect(results.map((result) => result.backend)).toEqual(backends);
		expect(results.filter((result) => result.ui === "present")).toHaveLength(1);
	});

	it("degrades UI without rejecting the command", async () => {
		const host = createCommandHost({
			dispatch: async ({ backend }) => ({ mode: "herd", status: "ok", ui: backend === "tui" ? "missing" : "none" }),
		});
		const result = await host.handleTui("herd", {}, {});
		expect(result.status).toBe("ok");
		expect(result.ui).toBe("missing");
		expect(result.missing_deps).toEqual([]);
	});

	it("fails closed when no dispatcher is installed", async () => {
		const host = createCommandHost();
		const result = await host.handle("herd", {}, {});
		expect(result.status).toBe("error");
		expect(result.error).toBe("no-dispatch");
	});
});
