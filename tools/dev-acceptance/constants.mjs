/**
 * Fixed names, patterns, and payload shapes shared by the independent
 * development-acceptance submission tools.
 *
 * This package is not an audit executor. It submits the three stage documents
 * and the final report; it does not parse scores, run auditors, or approve a
 * goal. Keep the vocabulary limited to that job.
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

// The host injects its intent field `i` into every wire schema and strips it
// before execute; the persisted branch may still carry it. `contract_line` is
// optional for submit_manual_report; when omitted, the tool reads the line
// embedded in one of the three stage documents.
export const MANUAL_SUBMISSION_ALLOWED_RAW_FIELDS = {
	submit_manual_requirements: ["i", "goal_slug", "requirements_markdown", "cases"],
	submit_development_guide: ["i", "goal_slug", "guide_markdown"],
	submit_coordination: ["i", "goal_slug", "coordination_markdown"],
	submit_manual_report: ["i", "goal_slug", "report_markdown", "contract_line"],
};
