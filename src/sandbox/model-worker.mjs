/**
 * Worker-side wrapper for the model-connected session host.
 *
 * The worker applies only the network/IPC Landlock layer, because bwrap still
 * has to create its mount namespace. The pathname UNIX-socket layer runs
 * inside bwrap through `src/sandbox/landlock.mjs` after the mounts exist; the
 * bwrap command contains that inner launcher.
 *
 * In `wait:false` mode the worker reports the bwrap host PID and exits; bwrap
 * remains a child of omp and `--die-with-parent` ties it to omp. In
 * `wait:true` mode the worker waits for the child and reports its exit code
 * (used by the network allowlist test).
 */

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { applyNetworkLandlock } from "./landlock.mjs";

const { argv, cwd, allowedTcpPorts, modelEnv, stderrLog, wait } = workerData ?? {};

try {
	if (!Array.isArray(argv) || argv.length === 0) throw new Error("model worker needs bwrap argv");
	applyNetworkLandlock({ allowedTcpPorts });
	const stderr = typeof stderrLog === "string" && stderrLog.length > 0 ? openSync(stderrLog, "w") : "ignore";
	const child = spawn(argv[0], argv.slice(1), {
		cwd,
		env: process.env,
		stdio: [typeof modelEnv === "string" ? "pipe" : "ignore", "ignore", stderr],
		detached: true,
	});
	if (wait === true) {
		if (typeof modelEnv === "string" && child.stdin) child.stdin.end(modelEnv);
		child.once("error", (error) => parentPort.postMessage({ error: error.message }));
		child.once("exit", (code, signal) => parentPort.postMessage({ exitCode: code, signal }));
	} else {
		// The worker must stay alive while bwrap lives: --die-with-parent binds
		// to the thread that spawned bwrap. An open message port keeps this
		// worker's event loop alive until stop() terminates it.
		parentPort.on("message", (message) => {
			if (message !== "shutdown") return;
			if (child.exitCode !== null || child.signalCode !== null) {
				process.exit(0);
			}
			const force = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already exited.
				}
				process.exit(0);
			}, 2000);
			force.unref?.();
			child.once("exit", () => {
				clearTimeout(force);
				parentPort.postMessage({ stopped: true });
				process.exit(0);
			});
			try {
				child.kill("SIGTERM");
			} catch {
				// The exit handler still runs if the child already exited.
			}
		});
		const ready = () => {
			child.unref();
			parentPort.postMessage({ pid: child.pid });
		};
		if (typeof modelEnv === "string" && child.stdin) {
			child.stdin.end(modelEnv, ready);
		} else {
			ready();
		}
	}
} catch (error) {
	parentPort.postMessage({ error: error?.message ?? String(error) });
}
