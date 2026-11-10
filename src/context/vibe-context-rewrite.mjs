const OLD_WORKER_LINE = "drive two worker CLIs";
const NEW_WORKER_LINE = "direct as many worker CLIs as the work needs";

const OLD_CONCURRENCY_LINE = "Run sessions concurrently — normally one `fast` and one `good` on different workstreams.";
const NEW_CONCURRENCY_LINE =
	"Run independent workstreams concurrently. For decomposable work, use more and more workers aggressively.";

/**
 * Apply the two vibe-mode wording updates in their original order.
 *
 * This function only handles the `vibe-mode-context` custom message body. If
 * neither phrase matches, it returns the input string unchanged.
 *
 * @param {string} content
 * @returns {string}
 */
export function rewriteVibeModeContext(content) {
	const rewritten = content
		.replace(OLD_WORKER_LINE, NEW_WORKER_LINE)
		.replace(OLD_CONCURRENCY_LINE, NEW_CONCURRENCY_LINE);
	return rewritten === content ? content : rewritten;
}
