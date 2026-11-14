import { afterAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildBwrapArgs,
	createAuditorSandbox,
	createSandboxedRunCommand,
	prepareModelSeed,
	sandboxCapability,
	validateSandboxPaths,
} from "../src/sandbox/index.mjs";

const roots = [];

function tempRoot(prefix = "herd-sbx-test-") {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function auditTmp() {
	const path = mkdtempSync(join(tmpdir(), "herd-audit-test-"));
	roots.push(path);
	return path;
}

function socketDir() {
	const path = join(tmpdir(), `h-${randomBytes(4).toString("hex")}`);
	mkdirSync(path, { mode: 0o700 });
	roots.push(path);
	return path;
}

function fixture() {
	const root = tempRoot();
	const evidence = join(root, "plans", "demo", "evidence", "CASE-01");
	mkdirSync(evidence, { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "contract\n");
	const config = {
		root,
		evidenceRoot: evidence,
		auditTmp: auditTmp(),
		socketDir: socketDir(),
		socketPath: null,
		sessionName: "herd-demo-CASE-01",
		cwd: root,
	};
	config.socketPath = join(config.socketDir, "s");
	return { root, evidence, config };
}

afterAll(() => {
	for (const root of roots) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("sandbox command construction", () => {
	it("reports the bwrap/tmux capability without starting either", async () => {
		const capability = await sandboxCapability();
		expect(capability.available).toBe(true);
		expect(capability.bwrap).toContain("bwrap");
		expect(capability.tmux).toContain("tmux");
	});

	it("builds a private mount/pid/net sandbox with a short socket", async () => {
		const { root, evidence, config } = fixture();
		const argv = await buildBwrapArgs({ ...config, command: "true" });
		expect(argv).toContain("--unshare-pid");
		expect(argv).toContain("--unshare-net");
		expect(argv).toContain("--unshare-ipc");
		expect(argv).toContain("--die-with-parent");
		expect(argv).toContain("--ro-bind");
		expect(argv).toContain(root);
		expect(argv).toContain(evidence);
		expect(argv).toContain(config.socketDir);
		expect(argv).not.toContain("--ro-bind / /");
		expect(Buffer.byteLength(config.socketPath)).toBeLessThan(108);
		const tmpIndex = argv.indexOf("--tmpfs");
		const rootIndex = argv.indexOf(root);
		expect(tmpIndex).toBeGreaterThan(-1);
		expect(rootIndex).toBeGreaterThan(tmpIndex);
	});

	it("mounts only the host runtime files and module trees", async () => {
		const { config } = fixture();
		const argv = await buildBwrapArgs({ ...config, command: "true" });
		const capability = await sandboxCapability();
		expect(argv).toContain(capability.bun);
		expect(argv).toContain(capability.omp);
		expect(argv).toContain(join(homedir(), "node_modules"));
		expect(argv).toContain(join(homedir(), ".cache", "herdchestra-lite", "node_modules"));
		expect(argv).not.toContain(join(homedir(), ".config", "omp"));
		expect(argv).not.toContain(join(homedir(), ".local", "share", "omp"));
		expect(argv).not.toContain(join(homedir(), ".cache", "herdchestra-lite", "gitdir"));
	});

	it("isolates the network only when requested", async () => {
		const { config } = fixture();
		const fakeOmp = join(config.auditTmp, "fake-omp");
		writeFileSync(fakeOmp, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const seed = await prepareModelSeed({
			auditTmp: config.auditTmp,
			socketDir: config.socketDir,
			model: {
				provider: "mistral",
				id: "deepseek-v4-1-flash-1017",
				baseUrl: "https://provider.test",
			},
			auth: { apiKey: "sk-test-not-real", envVar: "MISTRAL_API_KEY", env: {} },
			target: { host: "provider.test", port: 443 },
			realOmp: fakeOmp,
		});
		const egress = { host: "provider.test", port: 443, listenPort: 443, relaySocket: join(config.socketDir, "e") };
		const isolated = await buildBwrapArgs({ ...config, command: "true", network: "isolated" });
		expect(isolated).toContain("--unshare-net");
		const model = await buildBwrapArgs({
			...config,
			command: "true",
			network: "model",
			modelSeed: seed,
			modelEgress: egress,
		});
		expect(model).not.toContain("--unshare-net");
	});

	it("binds the writable audit roots", async () => {
		const { root, evidence, config } = fixture();
		const argv = await buildBwrapArgs({ ...config, command: "true" });
		expect(argv).toContain(config.auditTmp);
		expect(argv).toContain(evidence);
		expect(argv).toContain(root);
	});

	it("accepts an evidence root outside the repository", async () => {
		const { root, config } = fixture();
		const outside = tempRoot("herd-sbx-outside-");
		const resolved = await validateSandboxPaths({ ...config, evidenceRoot: outside });
		expect(resolved.evidenceRoot).toBe(realpathSync(outside));
		expect(root).toBeTruthy();
	});

	it("resolves a symlinked sandbox root instead of rejecting it", async () => {
		const { root, config } = fixture();
		const link = join(tempRoot("herd-sbx-link-"), "repo");
		symlinkSync(root, link);
		const resolved = await validateSandboxPaths({ ...config, root: link, cwd: root });
		expect(resolved.root).toBe(realpathSync(root));
	});

	it("accepts the host filesystem root as a mount source", async () => {
		const { config } = fixture();
		const resolved = await validateSandboxPaths({ ...config, root: "/" });
		expect(resolved.root).toBe("/");
	});

});

describe("sandboxed command", () => {
	it("writes evidence and the dedicated tmp but not the repository", async () => {
		const { root, evidence, config } = fixture();
		const marker = join(evidence, "probe.txt");
		const run = createSandboxedRunCommand(config);

		const allowed = await run(["/bin/sh", "-c", `printf ok > '${marker}'`], { cwd: root, signal: null, maxBytes: 1 << 20 });
		expect(allowed.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(true);

		const blocked = await run(["/bin/sh", "-c", `printf bad > '${root}/probe.txt'`], {
			cwd: root,
			signal: null,
			maxBytes: 1 << 20,
		});
		expect(blocked.exitCode).not.toBe(0);
		expect(blocked.stderr).toContain("Read-only file system");
		expect(existsSync(join(root, "probe.txt"))).toBe(false);

		const chmod = await run(["/bin/sh", "-c", `chmod 000 '${root}'`], { cwd: root, signal: null, maxBytes: 1 << 20 });
		expect(chmod.exitCode).not.toBe(0);
		expect(chmod.stderr).toContain("Read-only file system");
	});

	it("hides the host tmux socket behind the private /tmp", async () => {
		const { root, config } = fixture();
		const run = createSandboxedRunCommand(config);
		const hidden = await run(["/bin/sh", "-c", "test -e /tmp/tmux-1000/default"], {
			cwd: root,
			signal: null,
			maxBytes: 1024,
		});
		expect(hidden.exitCode).not.toBe(0);
	});

	it("rejects a hardlink from the read-only repo into the writable audit tmp", async () => {
		const { root, config } = fixture();
		const run = createSandboxedRunCommand(config);
		const target = join(config.auditTmp, "alias");
		const linked = await run(["/bin/sh", "-c", `ln '${join(root, "AGENTS.md")}' '${target}'`], {
			cwd: root,
			signal: null,
			maxBytes: 1024,
		});
		expect(linked.exitCode).not.toBe(0);
		expect(existsSync(target)).toBe(false);
	});

	it("allows a rename between directories inside the writable audit tmp", async () => {
		const { root, config } = fixture();
		const run = createSandboxedRunCommand(config);
		const fromDir = join(config.auditTmp, "from");
		const toDir = join(config.auditTmp, "to");
		const result = await run(
			["/bin/sh", "-c", `mkdir -p '${fromDir}' '${toDir}' && printf ok > '${fromDir}/f' && mv '${fromDir}/f' '${toDir}/f'`],
			{
				cwd: root,
				signal: null,
				maxBytes: 1 << 20,
			},
		);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(existsSync(join(toDir, "f"))).toBe(true);
	});

	it.skipIf(!existsSync(join(homedir(), "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json")))(
		"loads the host extension package from the minimal home mounts",
		async () => {
		const { config } = fixture();
		symlinkSync(join(homedir(), "node_modules"), join(config.auditTmp, "node_modules"));
		const run = createSandboxedRunCommand(config);
		const result = await run(
			["/bin/sh", "-c", `bun -e 'import("@oh-my-pi/pi-coding-agent/package.json").then(() => console.log("ok"), (error) => { console.error(error?.stack ?? error); process.exit(1); })'`],
			{ cwd: config.auditTmp, signal: null, maxBytes: 1 << 20 },
		);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("ok");
		const version = await run(["/bin/sh", "-c", "omp --version"], { cwd: config.auditTmp, signal: null, maxBytes: 1 << 20 });
		expect(version.exitCode, version.stderr).toBe(0);
		expect(version.stdout).toContain("omp/");
		const cherry = join(homedir(), "node_modules", "cherry-cljs", "cljs.core.js");
		const cherryResult = await run(
			["/bin/sh", "-c", `bun -e 'import(${JSON.stringify(cherry)}).then(() => console.log("ok"), (error) => { console.error(error?.stack ?? error); process.exit(1); })'`],
			{ cwd: config.auditTmp, signal: null, maxBytes: 1 << 20 },
		);
		expect(cherryResult.exitCode, cherryResult.stderr).toBe(0);
		expect(cherryResult.stdout).toContain("ok");
	});

	it("kills the process group on abort", async () => {
		const { root, config } = fixture();
		const run = createSandboxedRunCommand(config);
		const controller = new AbortController();
		const pending = run(["/bin/sh", "-c", "read x"], { cwd: root, signal: controller.signal, maxBytes: 1024 });
		queueMicrotask(() => controller.abort());
		const result = await pending;
		expect(result.aborted).toBe(true);
	});
});

describe("auditor sandbox factory", () => {
	it("refuses env-only provider credentials before spawning the sandbox", async () => {
		const { root, evidence } = fixture();
		const sandbox = await createAuditorSandbox({
			root,
			slug: "demo",
			batchId: "batch-a",
			caseId: "CASE-01",
			evidenceRoot: evidence,
			model: { provider: "aws", id: "audit-model", baseUrl: "https://8.8.8.8/v1" },
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, env: { AWS_SECRET_ACCESS_KEY: "secret" } }),
			},
		});
		await expect(sandbox.start()).rejects.toThrow(/host-proxied model auth/);
		await sandbox.stop();
		expect(existsSync(sandbox.auditTmp)).toBe(false);
		expect(existsSync(sandbox.socketDir)).toBe(false);
	});

	it("keeps exact long tmux session names for distinct long CASEs", async () => {
		const { root, evidence } = fixture();
		const slug = "a".repeat(64);
		const caseA = `CASE-${"A".repeat(100)}-one`;
		const caseB = `CASE-${"A".repeat(100)}-two`;
		const one = await createAuditorSandbox({
			root,
			slug,
			batchId: "batch-a",
			caseId: caseA,
			evidenceRoot: evidence,
		});
		const two = await createAuditorSandbox({
			root,
			slug,
			batchId: "batch-b",
			caseId: caseB,
			evidenceRoot: evidence,
		});
		expect(one.sessionName).toBe(`herd-${slug}-${caseA}`);
		expect(two.sessionName).toBe(`herd-${slug}-${caseB}`);
		expect(one.sessionName.length).toBeGreaterThan(80);
		expect(two.sessionName.length).toBeGreaterThan(80);
		expect(one.sessionName).not.toBe(two.sessionName);
		await one.stop();
		await two.stop();
		rmSync(one.auditTmp, { recursive: true, force: true });
		rmSync(two.auditTmp, { recursive: true, force: true });
	});
	it("creates a short private socket without starting tmux", async () => {
		const { root, evidence } = fixture();
		const sandbox = await createAuditorSandbox({
			root,
			slug: "demo",
			batchId: "audit-demo-token",
			caseId: "CASE-01",
			evidenceRoot: evidence,
		});
		expect(sandbox.available).toBe(true);
		expect(sandbox.sessionName).toBe("herd-demo-CASE-01");
		expect(sandbox.batchId).toBe("audit-demo-token");
		const auditTmpRoot = tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		expect(sandbox.auditTmp).toMatch(
			new RegExp(
				`^${auditTmpRoot}/herd-audit-demo-CASE-01-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
			),
		);
		expect(sandbox.auditTmp).not.toContain("audit-demo-token");
		expect(Buffer.byteLength(sandbox.socketPath)).toBeLessThan(108);
		expect(sandbox.socketPath.startsWith(sandbox.socketDir)).toBe(true);
		expect(existsSync(sandbox.auditTmp)).toBe(true);
		expect(existsSync(sandbox.socketDir)).toBe(true);
		await Promise.all([sandbox.stop(), sandbox.stop()]);
		expect(existsSync(sandbox.auditTmp)).toBe(false);
		expect(existsSync(sandbox.socketDir)).toBe(false);
	});
});
