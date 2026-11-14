/**
 * Build the bwrap command line for one auditor sandbox.
 *
 * The only long-lived process in an auditor sandbox is the tmux server started
 * with `-D` (foreground, no fork). bwrap stays alive as the sandbox shell and
 * `--die-with-parent` ties the whole tree to the omp process. There is no
 * keeper, no supervisor, and no host-side command broker.
 *
 * The sandbox has a private mount, PID, IPC, UTS, and network namespace. The
 * model-connected session host uses `--unshare-net` (bwrap brings loopback
 * up), so no host interface or host TCP service is reachable. Its only egress
 * is the host process's fixed-provider UNIX-socket relay. Landlock layers
 * restrict the sandbox: a network/IPC domain applied by the session worker
 * before bwrap starts, and a file-reparent/pathname-UNIX domain applied inside
 * the mount namespace before tmux starts. The per-call `call` clients use the same
 * private network namespace. They share the private socket directory with the
 * session host because they must reach its tmux socket; that directory also
 * exposes the framework's fixed provider relay, so a per-call command can
 * reach that relay but no host TCP service or host Unix socket.
 *
 * The sandbox's own tmux socket lives in a short private directory so
 * `sockaddr_un.sun_path` stays below 108 bytes.
 */

import { access, constants, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRunCommand } from "../clj-sandbox/vfs.mjs";
import { herdError } from "../util/errors.mjs";

const BWRAP_FALLBACKS = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];
const TMUX_FALLBACKS = ["/usr/bin/tmux", "/usr/local/bin/tmux", "/bin/tmux"];
const BUN_FALLBACKS = [join(homedir(), ".bun/bin/bun"), "/usr/bin/bun", "/usr/local/bin/bun"];
const OMP_FALLBACKS = [
	join(homedir(), ".local/bin/omp"),
	join(homedir(), ".bun/bin/omp"),
	"/usr/local/bin/omp",
	"/usr/bin/omp",
];
const MAX_SOCKET_PATH = 100;
const REPO_NODE_MODULES = fileURLToPath(new URL("../../node_modules", import.meta.url));

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function findExecutable(candidates, name) {
	const seen = new Set();
	const paths = [];
	if (typeof name === "string" && typeof Bun !== "undefined" && typeof Bun.which === "function") {
		const which = Bun.which(name);
		if (typeof which === "string" && which.length > 0) paths.push(which);
	}
	paths.push(...candidates);
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		try {
			await access(path, constants.X_OK);
			return await realpath(path);
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

export async function findBwrap() {
	return findExecutable(BWRAP_FALLBACKS, "bwrap");
}

export async function findTmux() {
	return findExecutable(TMUX_FALLBACKS, "tmux");
}

export async function findBun() {
	return findExecutable(BUN_FALLBACKS, "bun");
}

export async function findOmp() {
	const candidates = [];
	const execPath = typeof process.execPath === "string" ? process.execPath : "";
	if (execPath.length > 0 && basename(execPath) === "omp") candidates.push(execPath);
	candidates.push(...OMP_FALLBACKS);
	if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
		const which = Bun.which("omp");
		if (typeof which === "string" && which.length > 0) candidates.push(which);
	}
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			const real = await realpath(candidate);
			if (sandboxMountedPath(real)) return real;
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

/**
 * Capability check only. It never starts bwrap, tmux, or a probe.
 *
 * The sandbox trusts the host: bwrap provides the namespace boundary and the
 * explicit mount list is the contract. No Landlock layer, path policing, or
 * suspicious-path probing is required.
 */
export async function sandboxCapability() {
	const bwrap = await findBwrap();
	const tmux = await findTmux();
	const bun = await findBun();
	const omp = await findOmp();
	const available = bwrap !== null && tmux !== null && bun !== null && omp !== null;
	return {
		available,
		bwrap,
		tmux,
		bun,
		omp,
		reason: available
			? null
			: bwrap === null
				? "bwrap is not executable on PATH"
				: tmux === null
					? "tmux is not executable on PATH"
					: bun === null
						? "bun is not executable on PATH"
						: "omp is not executable under a mounted path",
	};
}

function unavailable(detail) {
	return herdError("CAPABILITY_DENIED", "auditor sandbox requires bwrap, tmux, bun, and omp", {
		detail,
		next: "install the missing host capability, or keep the S5 audit disabled; never fall back to an unsandboxed shell",
	});
}

function isWithin(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolvePath(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw herdError("INVALID_ARGUMENT", `${label} must be a non-empty path`, { [label]: value });
	}
	const absolute = resolve(value);
	try {
		return await realpath(absolute);
	} catch {
		return absolute;
	}
}

/**
 * Resolve the mount sources. No existence, ownership, symlink, or containment
 * audit: the caller is trusted and bwrap mounts exactly what is named here.
 */
export async function validateSandboxPaths({ root, evidenceRoot, auditTmp, socketDir, socketPath, cwd }) {
	if (typeof socketPath !== "string" || socketPath.length === 0) {
		throw herdError("INVALID_ARGUMENT", "socketPath must be a non-empty path", { socketPath });
	}
	if (Buffer.byteLength(socketPath, "utf8") >= MAX_SOCKET_PATH) {
		throw herdError("INVALID_ARGUMENT", "socketPath is too long for a Unix domain socket", {
			socketPath,
			bytes: Buffer.byteLength(socketPath, "utf8"),
			limit: MAX_SOCKET_PATH,
		});
	}
	return {
		root: await resolvePath(root, "root"),
		evidenceRoot: await resolvePath(evidenceRoot, "evidenceRoot"),
		auditTmp: await resolvePath(auditTmp, "auditTmp"),
		socketDir: await resolvePath(socketDir, "socketDir"),
		socketPath,
		cwd: await resolvePath(cwd, "cwd"),
	};
}

function envArgs(env) {
	const args = [];
	for (const [key, value] of Object.entries(env)) {
		args.push("--setenv", key, value);
	}
	for (const key of ["TMUX", "TMUX_PANE", "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "DOCKER_HOST"]) {
		args.push("--unsetenv", key);
	}
	return args;
}

async function runtimeArgs(home) {
	const args = [];
	const executables = new Set((await Promise.all([findBun(), findOmp()])).filter((path) => path !== null));
	for (const executable of executables) {
		args.push("--ro-bind", executable, executable);
	}
	// The nested extension imports the host package tree and the repository's
	// own dependency tree. Nothing else from HOME is exposed.
	for (const path of ["node_modules", ".cache/herdchestra-lite/node_modules"]) {
		const source = join(home, path);
		args.push("--ro-bind-try", source, source);
	}
	// The host may not populate $HOME/node_modules while the plugin repository
	// does. Mount the repository's own dependency tree at the conventional home
	// location so nested extension imports resolve without exposing the repo.
	if (!(await pathExists(join(home, "node_modules"))) && (await pathExists(REPO_NODE_MODULES))) {
		args.push("--ro-bind", REPO_NODE_MODULES, join(home, "node_modules"));
	}
	return args;
}

function etcArgs() {
	return ["--ro-bind", "/etc", "/etc"];
}

export function sandboxPath(realAuditTmp) {
	return [
		join(realAuditTmp, "bin"),
		join(homedir(), ".bun/bin"),
		join(homedir(), ".cache/.bun/bin"),
		join(homedir(), ".local/bin"),
		"/usr/bin",
		"/bin",
	].join(":");
}

function sandboxEnv(real, socketDir, network) {
	const home = join(real.auditTmp, "home");
	const path = sandboxPath(real.auditTmp);
	const env = {
		PATH: path,
		HOME: home,
		TMPDIR: join(real.auditTmp, "tmp"),
		XDG_RUNTIME_DIR: join(real.auditTmp, "run"),
		XDG_CACHE_HOME: join(real.auditTmp, "cache"),
		XDG_STATE_HOME: join(real.auditTmp, "state"),
		XDG_DATA_HOME: join(real.auditTmp, "data"),
		XDG_CONFIG_HOME: join(real.auditTmp, "config"),
		TMUX_TMPDIR: socketDir,
		TERM: "xterm-256color",
		LANG: process.env.LANG ?? "C.UTF-8",
		TZ: process.env.TZ ?? "UTC",
	};
	return env;
}

const SANDBOX_MOUNT_PREFIXES = Object.freeze([
	join(homedir(), ".bun"),
	join(homedir(), ".cache/.bun"),
	join(homedir(), ".cache/herdchestra-lite/node_modules"),
	join(homedir(), ".local/bin"),
	join(homedir(), "node_modules"),
	"/usr",
	"/bin",
]);

export function sandboxMountedPath(path) {
	return SANDBOX_MOUNT_PREFIXES.some((prefix) => isWithin(prefix, path));
}

async function sandboxBunPath() {
	const executable = (await findBun()) ?? "bun";
	return sandboxMountedPath(executable) ? executable : "bun";
}

/**
 * Build the complete bwrap argv. `sessionHost` selects the foreground
 * `tmux -D` server; otherwise `command` runs under `/bin/sh -c` in a fresh
 * per-call sandbox.
 */
export async function buildBwrapArgs({
	root,
	evidenceRoot,
	auditTmp,
	socketDir,
	socketPath,
	sessionName,
	cwd,
	argv,
	command,
	sessionHost = false,
	network = "isolated",
	modelSeed,
	modelEgress,
}) {
	if (network !== "isolated" && network !== "model") {
		throw herdError("INVALID_ARGUMENT", "network must be isolated or model", { network });
	}
	const capability = await sandboxCapability();
	if (!capability.available) throw unavailable(capability.reason);
	const real = await validateSandboxPaths({ root, evidenceRoot, auditTmp, socketDir, socketPath, cwd });
	const env = sandboxEnv(real, real.socketDir, network);
	const args = [
		capability.bwrap,
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup-try",
		"--die-with-parent",
	];
	if (network === "isolated") args.push("--unshare-net");
	if (sessionHost) args.push("--as-pid-1");
	args.push(...envArgs(env));
	args.push("--hostname", "herd-audit");
	args.push("--ro-bind", "/usr", "/usr");
	args.push("--symlink", "usr/bin", "/bin");
	args.push("--symlink", "usr/bin", "/sbin");
	args.push("--symlink", "usr/lib", "/lib");
	args.push("--symlink", "usr/lib", "/lib64");
	args.push(...etcArgs());
	args.push(...(await runtimeArgs(homedir())));
	args.push("--tmpfs", "/tmp");
	args.push("--ro-bind", real.root, real.root);
	args.push("--bind", real.evidenceRoot, real.evidenceRoot);
	args.push("--bind", real.auditTmp, real.auditTmp);
	args.push("--bind", real.socketDir, real.socketDir);
	args.push("--tmpfs", "/run");
	args.push("--dir", "/var");
	args.push("--symlink", "/run", "/var/run");
	args.push("--tmpfs", "/var/tmp");
	args.push("--proc", "/proc");
	args.push("--dev", "/dev");
	args.push("--cap-drop", "ALL");
	if (network === "model") args.push("--cap-add", "CAP_NET_BIND_SERVICE");
	args.push("--chdir", real.cwd);
	args.push("--");
	let target;
	if (sessionHost) {
		if (typeof sessionName !== "string" || sessionName.length === 0) {
			throw herdError("INVALID_ARGUMENT", "sessionName is required for a session host", {});
		}
		target = [capability.tmux, "-D", "-S", real.socketPath, "-f", "/dev/null"];
	} else if (Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string")) {
		target = [...argv];
	} else {
		if (typeof command !== "string" || command.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "argv must be a non-empty string array", { argv });
		}
		target = ["/bin/sh", "-c", command];
	}
	args.push(...target);
	return args;
}

export function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Turn `call` into a bwrap client. The returned function keeps the existing
 * VFS `runCommand` contract: same stdout/stderr/exit/abort/truncation fields.
 * Per-call clients stay network-isolated; only the session host may reach the
 * model provider.
 */
export function createSandboxedRunCommand(config) {
	return async (argv, options = {}) => {
		const cwd = options.cwd ?? config.root;
		const bwrapArgv = await buildBwrapArgs({
			...config,
			cwd,
			argv,
			sessionHost: false,
			network: "isolated",
		});
		return defaultRunCommand(bwrapArgv, { ...options, cwd });
	};
}

/**
 * Run one setup command through the same per-call sandbox. Used to create the
 * tmux session after the session host socket appears; never used as a proof.
 */
export async function runSandboxedSetup(config, command, { cwd = config.root, maxBytes = 1 << 20, signal = null } = {}) {
	const argv = await buildBwrapArgs({ ...config, cwd, command, sessionHost: false, network: "isolated" });
	return defaultRunCommand(argv, { cwd, signal, maxBytes });
}

export const SANDBOX_LIMITS = Object.freeze({ maxSocketPath: MAX_SOCKET_PATH });
