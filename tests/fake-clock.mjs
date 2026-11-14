// Explicit test clock. No wall-clock waits: tests advance time by hand.
export function installFakeClock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map();
	let timerWaiters = [];
	const clock = {
		now: () => now,
		performanceNow: () => now,
		setTimeout: (fn, ms) => {
			const id = ++nextId;
			timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
			for (const resolve of timerWaiters) resolve();
			timerWaiters = [];
			return id;
		},
		clearTimeout: (id) => {
			timers.delete(id);
		},
		waitForTimer: () =>
			new Promise((resolve) => {
				if (timers.size > 0) resolve();
				else timerWaiters.push(resolve);
			}),
		advance: (ms) => {
			now += ms;
			let ran = true;
			while (ran) {
				ran = false;
				for (const [id, timer] of [...timers]) {
					if (timer.at <= now) {
						timers.delete(id);
						timer.fn();
						ran = true;
					}
				}
			}
		},
		pending: () => timers.size,
		reset: () => {
			now = 0;
			nextId = 0;
			timers.clear();
		},
	};
	globalThis.__herdClock = clock;
	return clock;
}

export function uninstallFakeClock() {
	delete globalThis.__herdClock;
}
