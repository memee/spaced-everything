/**
 * Playwright global setup: build the plugin once per run.
 *
 * The per-test fixture copies `main.js` + `manifest.json` from the repo root into
 * the test vault, so the build has to happen before any test resets the vault.
 * Set `E2E_SKIP_BUILD=1` to reuse whatever `main.js` is already on disk.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./lib/test-helpers";

export default function globalSetup(): void {
	if (process.env.E2E_SKIP_BUILD === "1") {
		console.log("[global-setup] E2E_SKIP_BUILD=1 — reusing existing main.js");
	} else {
		console.log("[global-setup] Building plugin...");
		execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
	}

	const mainJs = path.join(PROJECT_ROOT, "main.js");
	if (!fs.existsSync(mainJs)) {
		throw new Error(`main.js missing at ${mainJs} — run "npm run build" first`);
	}
}
