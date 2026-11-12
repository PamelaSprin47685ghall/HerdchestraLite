/**
 * Independent development-acceptance plugin entry.
 *
 * This package is not a product entry. It is linked in a separate HOME for
 * `docs/manual-acceptance/**` submission and report writing only. It must not
 * be added to the root `omp.extensions` / `pi.extensions` list.
 */

import { registerManualAcceptanceTools } from "./tools.mjs";

export default function devAcceptance(pi) {
	registerManualAcceptanceTools(pi);
}
