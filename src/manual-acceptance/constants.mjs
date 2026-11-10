/**
 * Fixed names, patterns, and payload shapes shared by the manual-acceptance
 * modules.
 *
 * Inputs: none; this module only declares values.
 * Output: constant exports.
 *
 * Every string, regex, schema key, and array entry is copied verbatim from the
 * old vibe-workers.ts implementation. Do not reflow, reorder object keys, or
 * "tidy" the patterns: the parser and the user-visible rejection texts depend
 * on these exact values.
 */

export const MANUAL_ACCEPTANCE_ROOT_DIR = "docs/manual-acceptance";
export const MANUAL_ACCEPTANCE_REQUIREMENTS_FILE = "requirements.md";
export const MANUAL_ACCEPTANCE_GUIDE_FILE = "development-guide.md";
export const MANUAL_ACCEPTANCE_COORDINATION_FILE = "coordination.md";
export const MANUAL_ACCEPTANCE_REPORT_FILE = "report.md";
export const MANUAL_ACCEPTANCE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MANUAL_CASE_HEADING_RE = /^###\s+(CASE-[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/;
export const MANUAL_CASE_THRESHOLD_RE = /^-\s*PASS threshold\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*\/\s*100\s*$/i;
export const MANUAL_CASE_PATH_RE = /^-\s*路径\s*[:：]\s*(.+?)\s*$/;
export const MANUAL_CASE_RUBRIC_RE = /^-\s*评分细则\s*[:：]\s*(.+?)\s*$/;

/**
 * Structured yield contract for the visible auditor. `runSubprocess` validates
 * this schema before it returns the subagent result.
 */
export const MANUAL_REPORT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["report_markdown", "scores"],
	properties: {
		report_markdown: { type: "string", minLength: 1 },
		scores: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["case_id", "user_score", "developer_score"],
				properties: {
					case_id: { type: "string", minLength: 1 },
					user_score: { type: "number", minimum: 0, maximum: 100 },
					developer_score: { type: "number", minimum: 0, maximum: 100 },
				},
			},
		},
	},
};

// The host injects its intent field `i` into every wire schema (INTENT_FIELD)
// and strips it before execute; the persisted toolCall arguments still carry it.
export const MANUAL_SUBMISSION_ALLOWED_RAW_FIELDS = {
	submit_manual_requirements: ["i", "goal_slug", "requirements_markdown", "cases"],
	submit_development_guide: ["i", "goal_slug", "guide_markdown"],
	submit_coordination: ["i", "goal_slug", "coordination_markdown"],
};

export const AUTOMATED_ACCEPTANCE_PATTERNS = [
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
	/\b(?:pytest|jest|vitest|playwright|cypress)\b/i,
	/\b(?:automated|automatic|auto|unit|integration|e2e|end-to-end)[\s-]+tests?\b/i,
	/\bci\b/i,
	/\btest[\s-]+suite\b/i,
	/自动化测试|自动测试|自动化验收|自动验收|测试套件|单元测试|集成测试|端到端测试/,
];

export const MANUAL_ACCEPTANCE_CONTRACT_RE = /^Verification contract:\s*(.+)$/im;
export const MANUAL_ACCEPTANCE_MARKER_RE = /^MANUAL ACCEPTANCE\b/i;
// A slug may not contain "/", so traversal never forms a valid document path.
// The optional group carries the sha256 token that must follow a document path.
export const MANUAL_ACCEPTANCE_DOCUMENT_PATH_RE =
	/docs\/manual-acceptance\/([^/\s"'`]+)\/([^/\s"'`;,()；，、：]+)(?:\s+sha256=([0-9a-fA-F]+)(?!\w))?/g;
// Sentence and emphasis marks that may follow a path in prose, not in the path.
export const MANUAL_ACCEPTANCE_PATH_TRAILER_RE = /[.,;:。，；：、*）)\]】》]+$/;
export const MANUAL_ACCEPTANCE_SHA_RE = /^[0-9a-f]{64}$/i;
// Hash keys are case-insensitive and may carry spaces around "=".
export const MANUAL_ACCEPTANCE_HASH_TOKEN_RE = /\bsha256\s*=\s*/gi;
export const MANUAL_ACCEPTANCE_DOCUMENTS = new Set([
	MANUAL_ACCEPTANCE_REQUIREMENTS_FILE,
	MANUAL_ACCEPTANCE_GUIDE_FILE,
	MANUAL_ACCEPTANCE_COORDINATION_FILE,
]);
export const MANUAL_ACCEPTANCE_WORD_RE = /manual|手工/i;
export const MANUAL_ACCEPTANCE_CONTRACT_MISSING =
	"a single-line `Verification contract: MANUAL ACCEPTANCE` line naming requirements.md, development-guide.md, and coordination.md for one slug";
export const MANUAL_ACCEPTANCE_HASH_REQUIREMENT =
	"the verification contract must include sha256=<64hex> for each document (requirements.md, development-guide.md, coordination.md)";
export const MANUAL_ACCEPTANCE_CONTRACT_TEMPLATE =
	"Verification contract: MANUAL ACCEPTANCE — requirements: docs/manual-acceptance/<slug>/requirements.md sha256=<64hex>; development-guide: docs/manual-acceptance/<slug>/development-guide.md sha256=<64hex>; coordination: docs/manual-acceptance/<slug>/coordination.md sha256=<64hex>; execute every CASE and score it out of 100; automated tests are NOT acceptance evidence.";
