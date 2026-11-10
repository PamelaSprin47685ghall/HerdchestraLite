/**
 * Register the three manual-acceptance submission tools.
 *
 * Inputs: the host `pi` extension API (tools, typebox schemas, session branch).
 * Output: none; the tools write `requirements.md`, `development-guide.md`, and
 * `coordination.md` under `docs/manual-acceptance/<goal_slug>/`.
 *
 * Argument validation runs twice on purpose. The wire schema rejects most
 * malformed calls, but the host injects `i` and strips it before execute, and a
 * `write xd://<tool>` call carries a JSON string instead of tool arguments.
 * The persisted branch is therefore the source of truth for shape. Every
 * rejection and success text is copied verbatim from the old implementation.
 */

import { messageOf } from "../util/errors.mjs";
import { unknownFields } from "../util/objects.mjs";
import {
	MANUAL_ACCEPTANCE_COORDINATION_FILE,
	MANUAL_ACCEPTANCE_GUIDE_FILE,
	MANUAL_ACCEPTANCE_REQUIREMENTS_FILE,
	MANUAL_SUBMISSION_ALLOWED_RAW_FIELDS,
} from "./constants.mjs";
import {
	manualAcceptanceDir,
	manualAcceptanceDocumentError,
	manualAcceptanceRelativePath,
	manualAcceptanceWriteDocument,
	manualAcceptanceWriteErrorText,
} from "./documents.mjs";
import { parseRequirementCases } from "./requirements.mjs";

function rawToolArguments(ctx, toolCallId, toolName) {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || block.id !== toolCallId) continue;
			if (block.name === toolName) return block.arguments;
			if (block.name !== "write") return undefined;
			const args = block.arguments;
			if (args.path !== `xd://${toolName}` || typeof args.content !== "string") return undefined;
			let parsed;
			try {
				parsed = JSON.parse(args.content);
			} catch {
				return undefined;
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
			return parsed;
		}
	}
	return undefined;
}

function manualAcceptanceRawArgumentsError(toolName, raw) {
	const unknown = unknownFields(raw, MANUAL_SUBMISSION_ALLOWED_RAW_FIELDS[toolName]);
	if (unknown.length > 0) return `unknown field(s): ${unknown.join(", ")}.`;
	if ("i" in raw && typeof raw.i !== "string") return "i must be a string.";
	if (typeof raw.goal_slug !== "string") return "goal_slug must be a string.";
	if (toolName === "submit_manual_requirements") {
		if (typeof raw.requirements_markdown !== "string") return "requirements_markdown must be a string.";
		const cases = raw.cases;
		if (!Array.isArray(cases)) return "cases must be an array.";
		for (let index = 0; index < cases.length; index += 1) {
			const item = cases[index];
			if (!item || typeof item !== "object" || Array.isArray(item)) {
				return `cases[${index}] must be an object.`;
			}
			const caseFields = unknownFields(item, ["id", "threshold", "path"]);
			if (caseFields.length > 0) {
				return `cases[${index}] has unknown field(s): ${caseFields.join(", ")}.`;
			}
			const id = "id" in item ? item.id : undefined;
			const threshold = "threshold" in item ? item.threshold : undefined;
			const path = "path" in item ? item.path : undefined;
			if (typeof id !== "string") return `cases[${index}].id must be a string.`;
			if (typeof threshold !== "number") return `cases[${index}].threshold must be a number.`;
			if (typeof path !== "string") return `cases[${index}].path must be a string.`;
		}
		return undefined;
	}
	const markdownField = toolName === "submit_development_guide" ? "guide_markdown" : "coordination_markdown";
	return typeof raw[markdownField] === "string" ? undefined : `${markdownField} must be a string.`;
}

function manualAcceptanceToolError(text) {
	return { isError: true, content: [{ type: "text", text }], details: {} };
}

function manualAcceptanceToolSuccess(text) {
	return { content: [{ type: "text", text }], details: {} };
}

function manualAcceptanceValidateCases(cases, markdown) {
	if (!Array.isArray(cases) || cases.length === 0) {
		return { ok: false, error: "cases must be a non-empty array." };
	}
	const submitted = [];
	const seen = new Set();
	for (let index = 0; index < cases.length; index += 1) {
		const raw = cases[index];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return { ok: false, error: `cases[${index}] must be an object.` };
		}
		const unknown = unknownFields(raw, ["id", "threshold", "path"]);
		if (unknown.length > 0) {
			return { ok: false, error: `cases[${index}] has unknown field(s): ${unknown.join(", ")}.` };
		}
		const id = "id" in raw ? raw.id : undefined;
		const threshold = "threshold" in raw ? raw.threshold : undefined;
		const path = "path" in raw ? raw.path : undefined;
		if (typeof id !== "string" || !/^CASE-[A-Za-z0-9_-]+$/.test(id)) {
			return { ok: false, error: `cases[${index}].id must be a CASE-* id.` };
		}
		if (seen.has(id)) {
			return { ok: false, error: `cases contains duplicate id ${id}.` };
		}
		seen.add(id);
		if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
			return { ok: false, error: `cases[${index}].threshold must be a number from 0 to 100.` };
		}
		if (typeof path !== "string" || path.trim().length === 0) {
			return { ok: false, error: `cases[${index}].path must be a non-empty string.` };
		}
		submitted.push({ id, threshold, path });
	}

	let parsed;
	try {
		parsed = parseRequirementCases(markdown);
	} catch (error) {
		return { ok: false, error: messageOf(error) };
	}
	const parsedById = new Map(parsed.map((item) => [item.id, item]));
	for (const item of submitted) {
		const fromMarkdown = parsedById.get(item.id);
		if (!fromMarkdown) {
			return {
				ok: false,
				error: `cases entry ${item.id} has no "### ${item.id}" heading in requirements_markdown.`,
			};
		}
		if (fromMarkdown.threshold !== item.threshold) {
			return {
				ok: false,
				error: `cases entry ${item.id} threshold ${item.threshold} does not match the markdown threshold ${fromMarkdown.threshold}/100.`,
			};
		}
		if (fromMarkdown.path !== item.path) {
			return {
				ok: false,
				error: `cases entry ${item.id} path "${item.path}" does not match the markdown path "${fromMarkdown.path}".`,
			};
		}
	}
	for (const item of parsed) {
		if (!seen.has(item.id)) {
			return {
				ok: false,
				error: `requirements_markdown has "### ${item.id}" but cases has no entry for it.`,
			};
		}
	}
	return { ok: true, cases: submitted };
}

export function registerManualAcceptanceTools(pi) {
	const { Type } = pi.typebox;
	const goalSlugParameters = Type.String({
		minLength: 1,
		maxLength: 64,
		pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
		description: "Goal slug; the directory name under docs/manual-acceptance.",
	});
	const caseParameters = Type.Object(
		{
			id: Type.String({
				minLength: 1,
				maxLength: 128,
				description: "CASE id from the markdown heading, for example CASE-01.",
			}),
			threshold: Type.Number({
				minimum: 0,
				maximum: 100,
				description: "PASS threshold from the markdown, in percent.",
			}),
			path: Type.String({
				minLength: 1,
				description: "Path category from the markdown, for example 正常.",
			}),
		},
		{ additionalProperties: false },
	);
	const requirementsParameters = Type.Object(
		{
			goal_slug: goalSlugParameters,
			requirements_markdown: Type.String({
				minLength: 1,
				description: "Complete requirements.md body, including every ### CASE-* heading.",
			}),
			cases: Type.Array(caseParameters, {
				minItems: 1,
				description: "One structured entry per CASE heading.",
			}),
		},
		{ additionalProperties: false },
	);
	const guideParameters = Type.Object(
		{
			goal_slug: goalSlugParameters,
			guide_markdown: Type.String({
				minLength: 1,
				description: "Complete development-guide.md body.",
			}),
		},
		{ additionalProperties: false },
	);
	const coordinationParameters = Type.Object(
		{
			goal_slug: goalSlugParameters,
			coordination_markdown: Type.String({
				minLength: 1,
				description: "Complete coordination.md body.",
			}),
		},
		{ additionalProperties: false },
	);

	pi.registerTool({
		name: "submit_manual_requirements",
		label: "Submit Manual Requirements",
		description:
			"Write docs/manual-acceptance/<goal_slug>/requirements.md. Every structured case must match one ### CASE-* heading, its PASS threshold, and its 路径 line in the markdown.",
		loadMode: "essential",
		parameters: requirementsParameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params || typeof params !== "object") {
				return manualAcceptanceToolError("submit_manual_requirements requires a JSON object.");
			}
			const raw = rawToolArguments(ctx, toolCallId, "submit_manual_requirements");
			if (raw !== undefined) {
				const rawError = manualAcceptanceRawArgumentsError("submit_manual_requirements", raw);
				if (rawError !== undefined) {
					return manualAcceptanceToolError(`submit_manual_requirements rejected: ${rawError}`);
				}
			}
			const unknown = unknownFields(params, ["i", "goal_slug", "requirements_markdown", "cases"]);
			if (unknown.length > 0) {
				return manualAcceptanceToolError(
					`submit_manual_requirements rejected: unknown field(s): ${unknown.join(", ")}.`,
				);
			}
			let dir;
			try {
				dir = manualAcceptanceDir(ctx.cwd, params.goal_slug);
			} catch (error) {
				return manualAcceptanceToolError(`submit_manual_requirements rejected: ${messageOf(error)}.`);
			}
			if (typeof params.requirements_markdown !== "string" || params.requirements_markdown.trim().length === 0) {
				return manualAcceptanceToolError(
					"submit_manual_requirements rejected: requirements_markdown must be a non-empty string.",
				);
			}
			const validation = manualAcceptanceValidateCases(params.cases, params.requirements_markdown);
			if (!validation.ok) {
				return manualAcceptanceToolError(`submit_manual_requirements rejected: ${validation.error}`);
			}
			const relativePath = manualAcceptanceRelativePath(params.goal_slug, MANUAL_ACCEPTANCE_REQUIREMENTS_FILE);
			let existed = false;
			try {
				existed = manualAcceptanceWriteDocument(dir, MANUAL_ACCEPTANCE_REQUIREMENTS_FILE, params.requirements_markdown);
			} catch (error) {
				return manualAcceptanceToolError(
					`submit_manual_requirements failed: ${manualAcceptanceWriteErrorText(relativePath, error)}.`,
				);
			}
			return manualAcceptanceToolSuccess(
				`${existed ? "replaced" : "wrote"} ${relativePath} with ${validation.cases.length} CASE entr${validation.cases.length === 1 ? "y" : "ies"}.`,
			);
		},
	});

	pi.registerTool({
		name: "submit_development_guide",
		label: "Submit Development Guide",
		description:
			"Write docs/manual-acceptance/<goal_slug>/development-guide.md. The markdown must be non-empty and contain at least one ## section.",
		loadMode: "essential",
		parameters: guideParameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params || typeof params !== "object") {
				return manualAcceptanceToolError("submit_development_guide requires a JSON object.");
			}
			const raw = rawToolArguments(ctx, toolCallId, "submit_development_guide");
			if (raw !== undefined) {
				const rawError = manualAcceptanceRawArgumentsError("submit_development_guide", raw);
				if (rawError !== undefined) {
					return manualAcceptanceToolError(`submit_development_guide rejected: ${rawError}`);
				}
			}
			const unknown = unknownFields(params, ["i", "goal_slug", "guide_markdown"]);
			if (unknown.length > 0) {
				return manualAcceptanceToolError(`submit_development_guide rejected: unknown field(s): ${unknown.join(", ")}.`);
			}
			let dir;
			try {
				dir = manualAcceptanceDir(ctx.cwd, params.goal_slug);
			} catch (error) {
				return manualAcceptanceToolError(`submit_development_guide rejected: ${messageOf(error)}.`);
			}
			const invalid = manualAcceptanceDocumentError(params.guide_markdown, "guide_markdown");
			if (invalid !== undefined) {
				return manualAcceptanceToolError(`submit_development_guide rejected: ${invalid}`);
			}
			const relativePath = manualAcceptanceRelativePath(params.goal_slug, MANUAL_ACCEPTANCE_GUIDE_FILE);
			let existed = false;
			try {
				existed = manualAcceptanceWriteDocument(dir, MANUAL_ACCEPTANCE_GUIDE_FILE, params.guide_markdown);
			} catch (error) {
				return manualAcceptanceToolError(
					`submit_development_guide failed: ${manualAcceptanceWriteErrorText(relativePath, error)}.`,
				);
			}
			return manualAcceptanceToolSuccess(`${existed ? "replaced" : "wrote"} ${relativePath}.`);
		},
	});

	pi.registerTool({
		name: "submit_coordination",
		label: "Submit Coordination",
		description:
			"Write docs/manual-acceptance/<goal_slug>/coordination.md. The markdown must be non-empty and contain at least one ## section.",
		loadMode: "essential",
		parameters: coordinationParameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params || typeof params !== "object") {
				return manualAcceptanceToolError("submit_coordination requires a JSON object.");
			}
			const raw = rawToolArguments(ctx, toolCallId, "submit_coordination");
			if (raw !== undefined) {
				const rawError = manualAcceptanceRawArgumentsError("submit_coordination", raw);
				if (rawError !== undefined) {
					return manualAcceptanceToolError(`submit_coordination rejected: ${rawError}`);
				}
			}
			const unknown = unknownFields(params, ["i", "goal_slug", "coordination_markdown"]);
			if (unknown.length > 0) {
				return manualAcceptanceToolError(`submit_coordination rejected: unknown field(s): ${unknown.join(", ")}.`);
			}
			let dir;
			try {
				dir = manualAcceptanceDir(ctx.cwd, params.goal_slug);
			} catch (error) {
				return manualAcceptanceToolError(`submit_coordination rejected: ${messageOf(error)}.`);
			}
			const invalid = manualAcceptanceDocumentError(params.coordination_markdown, "coordination_markdown");
			if (invalid !== undefined) {
				return manualAcceptanceToolError(`submit_coordination rejected: ${invalid}`);
			}
			const relativePath = manualAcceptanceRelativePath(params.goal_slug, MANUAL_ACCEPTANCE_COORDINATION_FILE);
			let existed = false;
			try {
				existed = manualAcceptanceWriteDocument(dir, MANUAL_ACCEPTANCE_COORDINATION_FILE, params.coordination_markdown);
			} catch (error) {
				return manualAcceptanceToolError(
					`submit_coordination failed: ${manualAcceptanceWriteErrorText(relativePath, error)}.`,
				);
			}
			return manualAcceptanceToolSuccess(`${existed ? "replaced" : "wrote"} ${relativePath}.`);
		},
	});
}
