/**
 * Landlock layers for the auditor sandbox.
 *
 * There are two independent domains because bwrap must finish its mount setup
 * before pathname UNIX socket rules can be applied:
 *
 * The file-reparent layer is mandatory for the auditor boundary: without it a
 * writable bind on the same filesystem can hardlink a read-only file and then
 * modify it through the writable alias. ABI 2 adds `REFER`, which denies that
 * reparent by default. The network and pathname-UNIX layers are optional
 * strengthenings on top of bwrap's private namespaces; capability reporting
 * tells the caller which layers exist.
 *
 * 1. `applyNetworkLandlock` runs in the session worker before bwrap starts.
 *    ABI 4 adds a TCP connect/bind allowlist; ABI 6 adds abstract-socket and
 *    signal scopes. It leaves filesystem rights empty so bwrap can mount.
 * 2. `applyUnixSocketLandlock` runs inside bwrap, after the mount namespace
 *    exists. ABI 2 adds the file-reparent rule for the writable directories;
 *    ABI 9 additionally adds pathname UNIX socket resolution, letting it allow
 *    the sandbox's own temp/socket directories while denying host sockets
 *    visible through a read-only mount.
 *
 * On older kernels the missing layers are reported in `sandboxCapability`,
 * never silently assumed. The auditor sandbox refuses to start without the
 * ABI 2 file-reparent layer.
 */

import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, constants, openSync, realpathSync } from "node:fs";

const SYS_LANDLOCK_CREATE_RULESET = 444;
const SYS_LANDLOCK_ADD_RULE = 445;
const SYS_LANDLOCK_RESTRICT_SELF = 446;
const LANDLOCK_CREATE_RULESET_VERSION = 1;
const LANDLOCK_RULE_PATH_BENEATH = 1;
const LANDLOCK_RULE_NET_PORT = 2;
const LANDLOCK_ACCESS_FS_REFER = 1n << 13n;
const LANDLOCK_ACCESS_FS_RESOLVE_UNIX = 1n << 16n;
const LANDLOCK_ACCESS_NET_BIND_TCP = 1n << 0n;
const LANDLOCK_ACCESS_NET_CONNECT_TCP = 1n << 1n;
const LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET = 1n << 0n;
const LANDLOCK_SCOPE_SIGNAL = 1n << 1n;
const PR_SET_NO_NEW_PRIVS = 38;
const REFER_ABI = 2;
const NETWORK_ABI = 4;
const SCOPE_ABI = 6;
const PATHNAME_ABI = 9;
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);
function sandboxError(code, message, detail = {}) {
	const error = new Error(message);
	error.code = code;
	error.detail = detail;
	return error;
}

let handlesCache;
let abiCache;

function handles() {
	if (handlesCache !== undefined) return handlesCache;
	if (!SUPPORTED_ARCHES.has(process.arch)) {
		handlesCache = null;
		return null;
	}
	try {
		const create = dlopen("libc.so.6", {
			syscall: {
				args: [FFIType.i64, FFIType.ptr, FFIType.i64, FFIType.i64],
				returns: FFIType.i64,
			},
			prctl: {
				args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
				returns: FFIType.i32,
			},
			__errno_location: { args: [], returns: FFIType.ptr },
		});
		const add = dlopen("libc.so.6", {
			syscall: {
				args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.i64],
				returns: FFIType.i64,
			},
		});
		handlesCache = { create, add };
		return handlesCache;
	} catch {
		handlesCache = null;
		return null;
	}
}

function errnoOf(libs) {
	try {
		return read.i32(libs.create.symbols.__errno_location());
	} catch {
		return 0;
	}
}

export function landlockAbi() {
	if (abiCache !== undefined) return abiCache;
	const libs = handles();
	if (libs === null) {
		abiCache = 0;
		return abiCache;
	}
	const value = Number(
		libs.create.symbols.syscall(SYS_LANDLOCK_CREATE_RULESET, null, 0, LANDLOCK_CREATE_RULESET_VERSION),
	);
	abiCache = Number.isInteger(value) && value > 0 ? value : 0;
	return abiCache;
}

/**
 * Static capability summary. It never starts a process and never treats a
 * probe as proof that a sandbox is active.
 */
export function landlockCapability() {
	const abi = landlockAbi();
	return {
		available: abi >= NETWORK_ABI,
		abi,
		minimumAbi: NETWORK_ABI,
		network: abi >= NETWORK_ABI,
		scopes: abi >= SCOPE_ABI,
		pathnameUnix: abi >= PATHNAME_ABI,
	};
}

function normalizePorts(value) {
	const list = Array.isArray(value) ? value : value == null ? [] : String(value).split(",");
	const ports = [];
	for (const item of list) {
		if (typeof item === "string" && item.trim() === "") continue;
		const port = Number(item);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw sandboxError("INVALID_ARGUMENT", "sandbox ports must be integers in 1..65535", {
				value: item,
			});
		}
		if (!ports.includes(port)) ports.push(port);
	}
	return ports;
}

function normalizePaths(value) {
	const list = Array.isArray(value) ? value : value == null ? [] : [value];
	const paths = [];
	for (const item of list) {
		if (typeof item !== "string" || item.length === 0) {
			throw sandboxError("INVALID_ARGUMENT", "sandbox UNIX paths must be non-empty paths", {
				value: item,
			});
		}
		const real = realpathSync(item);
		if (!paths.includes(real)) paths.push(real);
	}
	return paths;
}

function addNetRule(libs, rulesetFd, port, access) {
	const attr = Buffer.alloc(16);
	attr.writeBigUInt64LE(access, 0);
	attr.writeBigUInt64LE(BigInt(port), 8);
	const result = Number(libs.add.symbols.syscall(SYS_LANDLOCK_ADD_RULE, rulesetFd, LANDLOCK_RULE_NET_PORT, attr, 0));
	if (result !== 0) {
		throw sandboxError("CAPABILITY_DENIED", "Landlock rejected a network port rule", {
			port,
			access: String(access),
			errno: errnoOf(libs),
		});
	}
}

function addPathRule(libs, rulesetFd, path, access) {
	const pathFd = openSync(path, constants.O_PATH | constants.O_CLOEXEC);
	try {
		const attr = Buffer.alloc(12);
		attr.writeBigUInt64LE(access, 0);
		attr.writeInt32LE(pathFd, 8);
		const result = Number(
			libs.add.symbols.syscall(SYS_LANDLOCK_ADD_RULE, rulesetFd, LANDLOCK_RULE_PATH_BENEATH, attr, 0),
		);
		if (result !== 0) {
			throw sandboxError("CAPABILITY_DENIED", "Landlock rejected a path rule", {
				path,
				access: String(access),
				errno: errnoOf(libs),
			});
		}
	} finally {
		try {
			closeSync(pathFd);
		} catch {
			// Best effort; the ruleset already owns the reference.
		}
	}
}

function installRuleset({ handledFs, handledNet, scoped, requiredAbi, addRules }) {
	const capability = landlockCapability();
	if (capability.abi < requiredAbi) {
		throw sandboxError("CAPABILITY_DENIED", "the kernel Landlock ABI is too old for this layer", {
			abi: capability.abi,
			requiredAbi,
		});
	}
	const libs = handles();
	if (libs === null) {
		throw sandboxError("CAPABILITY_DENIED", "Landlock support is unavailable in this runtime", {});
	}
	const attrBytes = capability.scopes ? 24 : 16;
	const attr = Buffer.alloc(attrBytes);
	attr.writeBigUInt64LE(handledFs, 0);
	attr.writeBigUInt64LE(handledNet, 8);
	if (attrBytes >= 24) attr.writeBigUInt64LE(scoped, 16);
	const rulesetFd = Number(libs.create.symbols.syscall(SYS_LANDLOCK_CREATE_RULESET, attr, attrBytes, 0));
	if (rulesetFd < 0) {
		throw sandboxError("CAPABILITY_DENIED", "Landlock could not create a ruleset", {
			errno: errnoOf(libs),
		});
	}
	try {
		addRules(libs, rulesetFd);
		const noNewPrivileges = libs.create.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
		if (noNewPrivileges !== 0) {
			throw sandboxError("CAPABILITY_DENIED", "could not set no_new_privs before Landlock", {
				errno: errnoOf(libs),
			});
		}
		const restricted = Number(libs.add.symbols.syscall(SYS_LANDLOCK_RESTRICT_SELF, rulesetFd, 0, 0, 0, 0));
		if (restricted !== 0) {
			throw sandboxError("CAPABILITY_DENIED", "Landlock refused to restrict the sandbox", {
				errno: errnoOf(libs),
			});
		}
	} finally {
		try {
			closeSync(rulesetFd);
		} catch {
			// Best effort; the domain is already installed.
		}
	}
	return capability.abi;
}

/**
 * Network and IPC layer. Runs before bwrap, so it deliberately leaves
 * `handled_access_fs` empty; bwrap still has to mount the sandbox root.
 */
export function applyNetworkLandlock({ allowedTcpPorts = [] } = {}) {
	const capability = landlockCapability();
	if (!capability.network) {
		return { applied: false, abi: capability.abi, reason: "landlock-abi" };
	}
	const ports = normalizePorts(allowedTcpPorts);
	const scoped = capability.scopes ? LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL : 0n;
	const abi = installRuleset({
		handledFs: 0n,
		handledNet: LANDLOCK_ACCESS_NET_CONNECT_TCP | LANDLOCK_ACCESS_NET_BIND_TCP,
		scoped,
		requiredAbi: NETWORK_ABI,
		addRules: (libs, rulesetFd) => {
			for (const port of ports) {
				addNetRule(libs, rulesetFd, port, LANDLOCK_ACCESS_NET_CONNECT_TCP);
				addNetRule(libs, rulesetFd, port, LANDLOCK_ACCESS_NET_BIND_TCP);
			}
			addNetRule(libs, rulesetFd, 0, LANDLOCK_ACCESS_NET_BIND_TCP);
		},
	});
	return { applied: true, abi, allowedTcpPorts: ports, scopes: capability.scopes };
}

/**
 * File-reparent and pathname UNIX socket layer. Runs inside bwrap, after its
 * mount namespace is ready, and before the session command. The REFER rules
 * let per-call sandboxes reparent files inside the writable audit directories
 * without granting a hardlink path out of a read-only bind. In the model
 * session the pre-bwrap network layer already denies every reparent by
 * default, so these rules only matter where that layer is absent. New sockets
 * created inside the same domain stay reachable without a rule, so the UNIX
 * rules only admit directories whose external sockets must remain usable (the
 * private tmux socket and the per-auditor temp tree).
 */
export function applyUnixSocketLandlock({ allowedSocketPaths = [], allowedReferPaths = [] } = {}) {
	const capability = landlockCapability();
	const unixPaths = normalizePaths(allowedSocketPaths);
	const referPaths = normalizePaths(allowedReferPaths);
	if (unixPaths.length > 0 && !capability.pathnameUnix) {
		throw sandboxError("CAPABILITY_DENIED", "pathname UNIX hardening requires Landlock ABI 9", {
			abi: capability.abi,
		});
	}
	if (referPaths.length > 0 && capability.abi < REFER_ABI) {
		throw sandboxError("CAPABILITY_DENIED", "file-reparent hardening requires Landlock ABI 2", {
			abi: capability.abi,
		});
	}
	const handledFs =
		(unixPaths.length > 0 ? LANDLOCK_ACCESS_FS_RESOLVE_UNIX : 0n) |
		(referPaths.length > 0 ? LANDLOCK_ACCESS_FS_REFER : 0n);
	if (handledFs === 0n) {
		throw sandboxError("INVALID_ARGUMENT", "Landlock launcher needs at least one path rule", {});
	}
	const abi = installRuleset({
		handledFs,
		handledNet: 0n,
		scoped: 0n,
		requiredAbi: unixPaths.length > 0 ? PATHNAME_ABI : REFER_ABI,
		addRules: (libs, rulesetFd) => {
			for (const path of referPaths) addPathRule(libs, rulesetFd, path, LANDLOCK_ACCESS_FS_REFER);
			for (const path of unixPaths) addPathRule(libs, rulesetFd, path, LANDLOCK_ACCESS_FS_RESOLVE_UNIX);
		},
	});
	return { abi, allowedSocketPaths: unixPaths, allowedReferPaths: referPaths };
}

export function parseSocketLandlockArgs(argv) {
	const unixPaths = [];
	const referPaths = [];
	let index = 0;
	while (index < argv.length) {
		const arg = argv[index];
		if (arg === "--") {
			index += 1;
			break;
		}
		if (arg === "--unix-path") {
			index += 1;
			if (index >= argv.length) {
				throw sandboxError("INVALID_ARGUMENT", "--unix-path needs a value", {});
			}
			unixPaths.push(argv[index]);
			index += 1;
			continue;
		}
		if (arg === "--refer-path") {
			index += 1;
			if (index >= argv.length) {
				throw sandboxError("INVALID_ARGUMENT", "--refer-path needs a value", {});
			}
			referPaths.push(argv[index]);
			index += 1;
			continue;
		}
		throw sandboxError("INVALID_ARGUMENT", "unknown Unix socket scope option", { arg });
	}
	if (index >= argv.length) {
		throw sandboxError("INVALID_ARGUMENT", "Unix socket scope needs a command after --", {});
	}
	return { unixPaths, referPaths, command: argv[index], commandArgs: argv.slice(index) };
}

if (import.meta.main) {
	try {
		const parsed = parseSocketLandlockArgs(process.argv.slice(2));
		applyUnixSocketLandlock({
			allowedSocketPaths: parsed.unixPaths,
			allowedReferPaths: parsed.referPaths,
		});
		process.execve(parsed.command, parsed.commandArgs, { ...process.env });
		throw new Error("execve returned without replacing the process");
	} catch (error) {
		const message = error?.message ?? String(error);
		process.stderr.write(`herd sandbox unix-scope launcher: ${message}\n`);
		process.exit(1);
	}
}
