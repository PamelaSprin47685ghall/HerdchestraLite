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

import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRunCommand } from "../clj-sandbox/vfs.mjs";
import { herdError } from "../util/errors.mjs";
import { landlockCapability } from "./landlock.mjs";

const BWRAP_FALLBACKS = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];
const TMUX_FALLBACKS = ["/usr/bin/tmux", "/usr/local/bin/tmux", "/bin/tmux"];
const BUN_FALLBACKS = [join(homedir(), ".bun/bin/bun"), "/usr/bin/bun", "/usr/local/bin/bun"];
const OMP_FALLBACKS = [
	join(homedir(), ".local/bin/omp"),
	join(homedir(), ".bun/bin/omp"),
	"/usr/local/bin/omp",
	"/usr/bin/omp",
];
const SOCKET_DIR_PATTERN = /^h-[0-9a-f]{8}$/;
const AUDIT_TMP_PREFIX = "herd-audit-";
const MAX_SOCKET_PATH = 100;
const LANDLOCK_SCOPE_LAUNCHER = fileURLToPath(new URL("./landlock.mjs", import.meta.url));
const LANDLOCK_SCOPE_BASENAME = ".herd-landlock-scope.mjs";
const SANDBOX_RELAY_SCRIPT = fileURLToPath(new URL("./sandbox-relay.mjs", import.meta.url));

function findExecutable(candidates, name) {
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
			accessSync(path, constants.X_OK);
			return realpathSync(path);
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

export function findBwrap() {
	return findExecutable(BWRAP_FALLBACKS, "bwrap");
}

export function findTmux() {
	return findExecutable(TMUX_FALLBACKS, "tmux");
}

export function findBun() {
	return findExecutable(BUN_FALLBACKS, "bun");
}

export function findOmp() {
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
			accessSync(candidate, constants.X_OK);
			const real = realpathSync(candidate);
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
 * Required: bwrap, tmux, bun, a mounted omp executable, and Landlock ABI 2.
 * The ABI 2 file-reparent layer is mandatory: a writable bind on the same
 * filesystem can otherwise hardlink a read-only file and rewrite it through
 * the writable alias. Bwrap's private netns, private mount namespace, and the
 * fixed in-process relay form the host-service boundary; `landlockNetwork`/
 * `landlockScopes`/`landlockPathnameUnix` report which additional layers
 * exist.
 */
export function sandboxCapability() {
	const bwrap = findBwrap();
	const tmux = findTmux();
	const bun = findBun();
	const omp = findOmp();
	const landlock = landlockCapability();
	const landlockReady = landlock.abi >= 2;
	const available = bwrap !== null && tmux !== null && bun !== null && omp !== null && landlockReady;
	return {
		available,
		bwrap,
		tmux,
		bun,
		omp,
		landlockAbi: landlock.abi,
		landlockNetwork: landlock.network,
		landlockScopes: landlock.scopes,
		landlockPathnameUnix: landlock.pathnameUnix,
		reason: available
			? null
			: bwrap === null
				? "bwrap is not executable on PATH"
				: tmux === null
					? "tmux is not executable on PATH"
					: bun === null
						? "bun is not executable on PATH"
						: omp === null
							? "omp is not executable under a mounted path"
							: "Landlock ABI 2 is required to enforce read-only bindings",
	};
}

function unavailable(detail) {
	return herdError("CAPABILITY_DENIED", "auditor sandbox requires bwrap, tmux, bun, omp, and Landlock ABI 2", {
		detail,
		next: "install the missing host capability, or keep the S5 audit disabled; never fall back to an unsandboxed shell",
	});
}

function isWithin(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realDirectory(path, label) {
	let stats;
	try {
		stats = lstatSync(path);
	} catch {
		throw herdError("INVALID_ARGUMENT", `${label} must be an existing directory`, { path });
	}
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw herdError("INVALID_ARGUMENT", `${label} must be a real directory, not a symlink`, { path });
	}
	return realpathSync(path);
}

function realFileOrDirectory(path, label) {
	let stats;
	try {
		stats = lstatSync(path);
	} catch {
		throw herdError("INVALID_ARGUMENT", `${label} must exist`, { path });
	}
	if (stats.isSymbolicLink()) {
		throw herdError("INVALID_ARGUMENT", `${label} must not be a symlink`, { path });
	}
	return realpathSync(path);
}

function validateCwd(cwd, root, auditTmp) {
	const real = realFileOrDirectory(cwd, "cwd");
	if (!isWithin(root, real) && !isWithin(auditTmp, real)) {
		throw herdError("PATH_ESCAPE", "cwd must stay inside the repository or the audit temp directory", {
			cwd: real,
			root,
			auditTmp,
		});
	}
	return real;
}

/**
 * Validate every host path that becomes a mount source. The caller controls
 * the slug/case id, but a symlink or a stale directory must never redirect a
 * read-only bind or a writable bind into a user path.
 */
export function validateSandboxPaths({ root, evidenceRoot, auditTmp, socketDir, socketPath, cwd }) {
	const realRoot = realDirectory(root, "root");
	if (realRoot === "/") {
		throw herdError("PATH_ESCAPE", "root must not be the host filesystem root", { root: realRoot });
	}
	const realEvidence = realDirectory(evidenceRoot, "evidenceRoot");
	if (realEvidence === realRoot || !isWithin(realRoot, realEvidence)) {
		throw herdError("PATH_ESCAPE", "evidenceRoot must be a strict child of root", {
			root: realRoot,
			evidenceRoot: realEvidence,
		});
	}
	const realAuditTmp = realDirectory(auditTmp, "auditTmp");
	const realTmpRoot = realpathSync(tmpdir());
	if (isWithin(realAuditTmp, realTmpRoot)) {
		throw herdError(
			"CAPABILITY_DENIED",
			"auditor sandbox cannot be nested inside its own audit temp directory; the nested omp is the test subject, not the auditor",
			{
				auditTmp: realAuditTmp,
				tmpdir: realTmpRoot,
				next: "run auditor tools in the host subagent and use the nested omp only to observe the product",
			},
		);
	}
	if (dirname(realAuditTmp) !== realTmpRoot || !basename(realAuditTmp).startsWith(AUDIT_TMP_PREFIX)) {
		throw herdError("PATH_ESCAPE", "auditTmp must be a dedicated directory under the system temp dir", {
			auditTmp: realAuditTmp,
		});
	}
	const auditStats = statSync(realAuditTmp);
	if ((auditStats.mode & 0o077) !== 0) {
		throw herdError("INVALID_ARGUMENT", "auditTmp must be private to the current user", {
			auditTmp: realAuditTmp,
			mode: auditStats.mode & 0o777,
		});
	}
	const realSocketDir = realDirectory(socketDir, "socketDir");
	if (dirname(realSocketDir) !== realpathSync(tmpdir()) || !SOCKET_DIR_PATTERN.test(basename(realSocketDir))) {
		throw herdError("PATH_ESCAPE", "socketDir must be a short dedicated directory under the system temp dir", {
			socketDir: realSocketDir,
		});
	}
	const socketStats = statSync(realSocketDir);
	if ((socketStats.mode & 0o077) !== 0) {
		throw herdError("INVALID_ARGUMENT", "socketDir must be private to the current user", {
			socketDir: realSocketDir,
			mode: socketStats.mode & 0o777,
		});
	}
	if (dirname(socketPath) !== realSocketDir || basename(socketPath) !== "s") {
		throw herdError("INVALID_ARGUMENT", "socketPath must be <socketDir>/s", { socketPath });
	}
	if (Buffer.byteLength(socketPath, "utf8") >= MAX_SOCKET_PATH) {
		throw herdError("INVALID_ARGUMENT", "socketPath is too long for a Unix domain socket", {
			socketPath,
			bytes: Buffer.byteLength(socketPath, "utf8"),
			limit: MAX_SOCKET_PATH,
		});
	}
	const realCwd = validateCwd(cwd, realRoot, realAuditTmp);
	return {
		root: realRoot,
		evidenceRoot: realEvidence,
		auditTmp: realAuditTmp,
		socketDir: realSocketDir,
		socketPath,
		cwd: realCwd,
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

function runtimeArgs(home) {
	const args = [];
	const executables = new Set([findBun(), findOmp()].filter((path) => path !== null));
	for (const executable of executables) {
		args.push("--ro-bind", executable, executable);
	}
	// The nested extension imports the host package tree and the repository's
	// own dependency tree. Nothing else from HOME is exposed.
	for (const path of ["node_modules", ".cache/herdchestra-lite/node_modules"]) {
		const source = join(home, path);
		args.push("--ro-bind-try", source, source);
	}
	return args;
}

function etcArgs() {
	const paths = [
		"passwd",
		"group",
		"nsswitch.conf",
		"hosts",
		"localtime",
		"ld.so.cache",
		"ssl",
		"ca-certificates",
		"fonts",
		"terminfo",
		"inputrc",
		"services",
		"protocols",
		"resolv.conf",
		"bash.bashrc",
		"profile",
		"environment",
		"omp",
	];
	const args = ["--dir", "/etc"];
	for (const path of paths) {
		const target = join("/etc", path);
		args.push("--ro-bind-try", target, target);
	}
	return args;
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
	if (network === "model") env.HERD_AUDIT_MODEL_SEED = join(real.auditTmp, "model-seed.json");
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

function sandboxBunPath() {
	const executable = findBun() ?? "bun";
	return sandboxMountedPath(executable) ? executable : "bun";
}

function sandboxLauncherPath(real) {
	return join(real.auditTmp, LANDLOCK_SCOPE_BASENAME);
}

function unixSocketScopeArgs(real, capability) {
	const refer = capability.landlockAbi >= 2;
	const unix = capability.landlockPathnameUnix;
	if (!refer && !unix) return [];
	const args = [sandboxBunPath(), sandboxLauncherPath(real)];
	if (refer) args.push("--refer-path", real.auditTmp, "--refer-path", real.evidenceRoot);
	if (unix) args.push("--unix-path", real.auditTmp, "--unix-path", real.socketDir);
	args.push("--");
	return args;
}

function modelBootstrapScript(real, modelSeed, modelEgress, targetArgs) {
	const readyPath = join(real.socketDir, "relay.ready");
	const listenPort = modelEgress.listenPort ?? modelEgress.port;
	const relay = [sandboxBunPath(), modelSeed.relayScriptDest, modelEgress.relaySocket, String(listenPort), readyPath];
	const target = targetArgs.map(shellQuote).join(" ");
	const lines = [
		`rm -f ${shellQuote(readyPath)}`,
		`${relay.map(shellQuote).join(" ")} &`,
		"relay_pid=$!",
		"attempt=0",
		`while [ ! -e ${shellQuote(readyPath)} ] && [ "$attempt" -lt 100 ]; do sleep 0.05; attempt=$((attempt+1)); done`,
		`if [ ! -e ${shellQuote(readyPath)} ]; then kill "$relay_pid" 2>/dev/null; exit 1; fi`,
		`exec ${target}`,
	];
	return lines.join("\n");
}

/**
 * Build the complete bwrap argv. `sessionHost` selects the foreground
 * `tmux -D` server; otherwise `command` runs under `/bin/sh -c` in a fresh
 * per-call sandbox.
 */
export function buildBwrapArgs({
	root,
	evidenceRoot,
	auditTmp,
	socketDir,
	socketPath,
	sessionName,
	cwd,
	command,
	sessionHost = false,
	network = "isolated",
	modelSeed,
	modelEgress,
}) {
	if (network !== "isolated" && network !== "model") {
		throw herdError("INVALID_ARGUMENT", "network must be isolated or model", { network });
	}
	if (network === "model" && (!modelSeed || !modelEgress)) {
		throw herdError("INVALID_ARGUMENT", "model network needs a model seed and an egress target", {});
	}
	const capability = sandboxCapability();
	if (!capability.available) throw unavailable(capability.reason);
	const real = validateSandboxPaths({ root, evidenceRoot, auditTmp, socketDir, socketPath, cwd });
	const env = sandboxEnv(real, real.socketDir, network);
	const args = [
		capability.bwrap,
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup-try",
		"--die-with-parent",
	];
	if (network === "isolated") {
		args.push("--unshare-net");
	} else {
		args.push("--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net");
	}
	if (sessionHost) args.push("--as-pid-1");
	args.push("--clearenv", ...envArgs(env));
	args.push("--hostname", "herd-audit");
	args.push("--ro-bind", "/usr", "/usr");
	args.push("--symlink", "usr/bin", "/bin");
	args.push("--symlink", "usr/bin", "/sbin");
	args.push("--symlink", "usr/lib", "/lib");
	args.push("--symlink", "usr/lib", "/lib64");
	args.push(...etcArgs());
	args.push(...runtimeArgs(homedir()));
	args.push("--tmpfs", "/tmp");
	args.push("--ro-bind", real.root, real.root);
	args.push("--bind", real.evidenceRoot, real.evidenceRoot);
	args.push("--bind", real.auditTmp, real.auditTmp);
	const scopeArgs = unixSocketScopeArgs(real, capability);
	if (scopeArgs.length > 0) {
		args.push("--ro-bind", LANDLOCK_SCOPE_LAUNCHER, sandboxLauncherPath(real));
	}
	args.push("--bind", real.socketDir, real.socketDir);
	if (network === "model") {
		args.push("--ro-bind", modelSeed.wrapperPath, modelSeed.wrapperDest);
		args.push("--ro-bind", SANDBOX_RELAY_SCRIPT, modelSeed.relayScriptDest);
		args.push("--ro-bind-data", "0", modelSeed.secretDest);
		args.push("--ro-bind", modelSeed.hostsPath, "/etc/hosts");
	}
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
	} else {
		if (typeof command !== "string" || command.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "command must be a non-empty string", {});
		}
		target = ["/bin/sh", "-c", command];
	}
	const bootstrap = network === "model" ? modelBootstrapScript(real, modelSeed, modelEgress, target) : null;
	if (bootstrap === null) {
		args.push(...scopeArgs, ...target);
	} else {
		args.push(...scopeArgs, "/bin/sh", "-c", bootstrap);
	}
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
	return (command, options = {}) => {
		const cwd = options.cwd ?? config.root;
		const argv = buildBwrapArgs({
			...config,
			cwd,
			command,
			sessionHost: false,
			network: "isolated",
		});
		return defaultRunCommand(command, { ...options, cwd, argv });
	};
}

/**
 * Run one setup command through the same per-call sandbox. Used to create the
 * tmux session after the session host socket appears; never used as a proof.
 */
export function runSandboxedSetup(config, command, { cwd = config.root, maxBytes = 1 << 20, signal = null } = {}) {
	const argv = buildBwrapArgs({ ...config, cwd, command, sessionHost: false, network: "isolated" });
	return defaultRunCommand(command, { cwd, signal, maxBytes, argv });
}

export const SANDBOX_LIMITS = Object.freeze({ maxSocketPath: MAX_SOCKET_PATH, socketDirPattern: SOCKET_DIR_PATTERN });
