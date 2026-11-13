import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCljTools } from '../src/clj-main.mjs';
import { createAriadneStore } from '../src/scope/ariadne.mjs';
import { BEACON_TOOL_SCOLD, queryBeacon } from '../src/scope/beacon-query.mjs';

describe('Time Leap++ pending resolve + Ariadne thread + read-only beacons', () => {
	const activeHosts = [];
	let root;

	function fakeHost(extraDeps = {}) {
		const tools = new Map();
		const hooks = new Map();
		const pi = {
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			on(name, fn) {
				const list = hooks.get(name) ?? [];
				list.push(fn);
				hooks.set(name, list);
			},
			getActiveTools() {
				return [];
			},
			async setActiveTools() {},
		};
		const state = registerCljTools(pi, { ownerId: 'time-leap-test', ...extraDeps });
		activeHosts.push(state);
		return { tools, hooks, state };
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'time-leap-test-'));
	});

	afterEach(() => {
		while (activeHosts.length > 0) activeHosts.pop().terminate?.();
		rmSync(root, { recursive: true, force: true });
	});

	it('registers a pending leap and resolves it against the real messages', () => {
		const store = createAriadneStore();
		const sk = 's1';
		store.validateAndApplyFork(sk, { ariadne_budget: 5, ariadne_goal: 'goal-1' }, 'p1', 'c1', 'clj_plan');
		store.settleTurn(sk);
		store.validateAndApplyFork(sk, { ariadne_budget: 2, ariadne_goal: 'goal-2' }, 'p2', 'c2', 'clj_plan');
		store.settleTurn(sk);

		expect(() => store.timeLeap(sk, { target: 'p2', experience: 'go back' })).toThrow(/beacon/);
		expect(() =>
			store.timeLeap(sk, { target: 'p2', experience: 'go back', beacon_name: 'b1', beacon_description: 'b', ariadne_budget: 3 }),
		).toThrow(/ariadne_budget/);

		const pending = store.timeLeap(sk, {
			target: 'p2',
			experience: 'approach A failed; try B',
			beacon_name: 'alpha',
			beacon_description: 'Redis race details live here',
		});
		expect(pending).toMatchObject({ pending: true, target: 'p2', beaconName: 'alpha' });

		const messages = [
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'clj_plan', arguments: { name: 'p1', ariadne_goal: 'goal-1' } }] },
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'clj_plan', arguments: { name: 'p2', ariadne_goal: 'goal-2' } }] },
		];
		const resolved = store.resolvePendingLeap(sk, messages);
		expect(resolved.found).toBe(true);
		expect(resolved.messages).toHaveLength(2);
		expect(resolved.messages[1].content[0].text).toContain('Goal: goal-2');
		expect(resolved.messages[1].content[0].text).toContain('approach A failed; try B');
		expect(resolved.remaining).toBe(5);
		expect(store.listBeacons(sk).map((b) => b.name)).toEqual(['alpha']);
		expect(() =>
			store.timeLeap(sk, { target: 'alpha', experience: 'resurrect', beacon_name: 'b2', beacon_description: 'b2' }),
		).toThrow(/NAME_TAKEN/);
	});

	it('resolves only anchors present in the actual messages', () => {
		const store = createAriadneStore();
		const sk = 's-compact';
		const pre = { role: 'assistant', content: [{ type: 'toolCall', id: 'c-pre', name: 'clj_plan', arguments: { name: 'pre-anchor' } }] };
		const post = { role: 'assistant', content: [{ type: 'toolCall', id: 'c-post', name: 'clj_plan', arguments: { name: 'post-anchor' } }] };

		store.timeLeap(sk, { target: 'pre-anchor', experience: 'back', beacon_name: 'b1', beacon_description: 'b' });
		expect(store.resolvePendingLeap(sk, [post])).toMatchObject({ found: false, target: 'pre-anchor' });

		store.timeLeap(sk, { target: 'post-anchor', experience: 'back', beacon_name: 'b2', beacon_description: 'b' });
		const resolved = store.resolvePendingLeap(sk, [post]);
		expect(resolved.found).toBe(true);
		expect(resolved.messages[0].content[0].text).toContain('back');
	});

	it('acts as a soft gate at remaining <= 0 without blocking tools', async () => {
		const { tools, hooks } = fakeHost();
		const cljDevops = tools.get('clj_devops');
		const ctx = { cwd: root };

		await cljDevops.execute('c1', { name: 'start', code: '1', ariadne_budget: 1, ariadne_goal: 'finish quickly' }, undefined, undefined, ctx);
		await hooks.get('turn_end')[0]({}, ctx);
		await cljDevops.execute('c2', { name: 'step2', code: '2', ariadne_budget: 1, ariadne_goal: 'finish quickly' }, undefined, undefined, ctx);
		await hooks.get('turn_end')[0]({}, ctx);
		const r3 = await cljDevops.execute('c3', { name: 'step3', code: '3', ariadne_budget: 1, ariadne_goal: 'finish quickly' }, undefined, undefined, ctx);
		expect(r3.isError).not.toBe(true);
		await hooks.get('turn_end')[0]({}, ctx);

		const ctxRes = await hooks.get('context')[0]({ messages: [{ role: 'user', content: 'hi' }] }, ctx);
		const blocks = ctxRes.messages[1].content;
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toContain('<skill version="1.0">');
		expect(blocks[0].text).toContain('出门太久忘本了');
	});

	it('rewrites messages forward-cleanly at resolve time', () => {
		const store = createAriadneStore();
		const sk = 's-cut';
		store.timeLeap(sk, { target: 'p1', experience: 'use approach B', beacon_name: 'b1', beacon_description: 'b' });
		const messages = [
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-p1', name: 'clj_plan', arguments: { name: 'p1', ariadne_goal: 'fix login' } }] },
			{ role: 'toolResult', toolCallId: 'call-p1', toolName: 'clj_plan', content: [{ type: 'text', text: 'old-p1' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'dead end' }] },
		];
		const resolved = store.resolvePendingLeap(sk, messages);
		expect(resolved.found).toBe(true);
		expect(resolved.messages).toHaveLength(2);
		expect(resolved.messages[1].role).toBe('user');
		expect(resolved.messages[1].content[0].text).toContain('Goal: fix login');
		expect(resolved.messages[1].content[0].text).toContain('use approach B');
	});

	it('ask_beacon reuses cached prefix, scolds on first tool call, and fails if the Beacon disobeys twice', async () => {
		const cachedMessages = [
			{ role: 'user', content: [{ type: 'text', text: 'investigate bug' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'found it at src/foo.mjs:42' }] },
		];
		const beacon = { name: 'alpha', description: 'has exact line number', messagesSnapshot: cachedMessages };

		const calls1 = [];
		const mockComplete1 = async (_model, context) => {
			calls1.push(context.messages);
			if (calls1.length === 1) {
				return { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'bad-1', name: 'clj_plan', arguments: { code: '1' } }] };
			}
			return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'src/foo.mjs:42' }] };
		};
		const okRes = await queryBeacon({ beacon, question: 'which line?', model: { id: 'mock' }, systemPrompt: 'sys', complete: mockComplete1 });
		expect(okRes.answer).toBe('src/foo.mjs:42');
		expect(okRes.retried).toBe(true);
		expect(calls1[0].slice(0, 2)).toEqual(cachedMessages);
		const scoldResult = calls1[1].find((m) => m.role === 'toolResult' && m.toolCallId === 'bad-1');
		expect(scoldResult.isError).toBe(true);
		expect(scoldResult.content[0].text).toBe(BEACON_TOOL_SCOLD);

		const mockComplete2 = async () => ({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'bad-2', name: 'clj_worker', arguments: { code: '2' } }] });
		await expect(queryBeacon({ beacon, question: 'which line?', model: { id: 'mock' }, systemPrompt: 'sys', complete: mockComplete2 })).rejects.toMatchObject({ code: ':CAPABILITY_DENIED' });
	});

	it('wires time_leap as pending and resolves it in the context hook', async () => {
		const seenPrompts = [];
		const { tools, hooks } = fakeHost({
			completeSimple: async (_model, context) => {
				seenPrompts.push(context);
				return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Line 42 in src/foo.mjs' }] };
			},
		});
		expect(tools.has('verse_jump')).toBe(false);
		expect(tools.has('time_leap')).toBe(true);
		expect(tools.has('ask_beacon')).toBe(true);

		const ctx = { cwd: root, model: { id: 'mock-model' }, modelRegistry: { async getApiKey() { return 'k'; } } };
		await tools.get('clj_devops').execute('c1', { name: 'p1', code: '1', ariadne_budget: 3, ariadne_goal: 'solve' }, undefined, undefined, ctx);
		const leapRes = await tools.get('time_leap').execute('tl-1', { target: 'p1', experience: 'retry clean', beacon_name: 'alpha', beacon_description: 'alpha knew line 42' }, undefined, undefined, ctx);
		expect(leapRes.isError).not.toBe(true);
		expect(leapRes.content[0].text).toContain(':time-leap-pending true');

		const beforeLeapMessages = [
			{ role: 'user', content: [{ type: 'text', text: 'go' }] },
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'clj_devops', arguments: { name: 'p1', code: '1' } }] },
			{ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '1' }] },
		];
		const ctxRes = await hooks.get('context')[0]({ messages: beforeLeapMessages }, ctx);
		expect(ctxRes.messages[1].content[0].text).toContain('Goal:');
		expect(ctxRes.messages[1].content[0].text).toContain('retry clean');

		const askRes = await tools.get('ask_beacon').execute('ab-1', { target: 'alpha', question: 'what line was it?' }, undefined, undefined, ctx);
		expect(askRes.isError).not.toBe(true);
		expect(askRes.content[0].text).toBe('Line 42 in src/foo.mjs');
		expect(seenPrompts[0].messages.slice(0, 2)).toEqual(beforeLeapMessages.slice(0, 2));
	});
});
