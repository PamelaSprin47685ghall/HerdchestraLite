import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const SCENARIO = `${import.meta.dir}/fixtures/s5-wiring-scenario.mjs`;

describe("S5 cross-module wiring (automated integration, not manual acceptance)", () => {
	it("joins a real worktree, aggregates real B3/T4 submissions, refuses FAIL, then writes the report and issues the real approval", () => {
		const result = spawnSync(process.execPath, [SCENARIO], {
			encoding: "utf8",
			timeout: 180_000,
			env: process.env,
		});
		expect(result.status).toBe(0);
		const summary = JSON.parse(result.stdout.trim());
		expect(summary.ok).toBe(true);
		expect(summary.join.sliceId).toBe("slice-a");
		expect(summary.join.ffCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(summary.join.report).toContain("Slice slice-a report");
		expect(summary.failure.verdict).toBe("FAIL");
		expect(summary.failure.repairSpec).toBe(true);
		expect(summary.failure.mappedCases).toEqual(["CASE-02"]);
		expect(summary.failure.reportWritten).toBe(false);
		expect(summary.success.verdict).toBe("PASS");
		expect(summary.success.reportPath).toBe("plans/s5-wiring/s5-report.md");
		expect(summary.success.approvalToken.length).toBeGreaterThan(0);
		expect(summary.success.missionStage).toBe("completed");
	});
});
