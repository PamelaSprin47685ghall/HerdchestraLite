import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalSettingsPath } from "pi-goal-x/extensions/goal-settings.ts";

const importsPath = new URL("../src/host/imports.mjs", import.meta.url).pathname;
mock.module(importsPath, () => ({ goalSettingsPath }));

const { isGoalAuditorDisabled } = await import("../src/host/goal-settings.mjs");

let cwd;
let previousSettingsFile;

beforeEach(() => {
	previousSettingsFile = process.env.PI_GOAL_SETTINGS_FILE;
	delete process.env.PI_GOAL_SETTINGS_FILE;
	cwd = mkdtempSync(join(tmpdir(), "herdchestra-goal-settings-"));
});

afterEach(() => {
	if (previousSettingsFile === undefined) delete process.env.PI_GOAL_SETTINGS_FILE;
	else process.env.PI_GOAL_SETTINGS_FILE = previousSettingsFile;
	rmSync(cwd, { recursive: true, force: true });
});

function writeSettings(text) {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(goalSettingsPath(cwd), text);
}

describe("isGoalAuditorDisabled", () => {
	it("treats a missing settings file as not disabled", () => {
		expect(isGoalAuditorDisabled(cwd)).toBe(false);
	});

	it("returns true when disabled is true", () => {
		writeSettings(JSON.stringify({ disabled: true }));
		expect(isGoalAuditorDisabled(cwd)).toBe(true);
	});

	it("returns false when disabled is false", () => {
		writeSettings(JSON.stringify({ disabled: false }));
		expect(isGoalAuditorDisabled(cwd)).toBe(false);
	});

	it("returns undefined when the file is not valid JSON", () => {
		writeSettings("{");
		expect(isGoalAuditorDisabled(cwd)).toBeUndefined();
	});
});
