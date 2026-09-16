#!/usr/bin/env npx tsx
/**
 * Standalone debug runner: build, launch Obsidian, watch it for N seconds, report.
 *
 * Useful when you want to see the plugin running in a real vault without writing a
 * test — and it is the script to use for the one-time "Trust author" dialog, since it
 * leaves Obsidian open long enough to click it.
 *
 * Writes:
 *   e2e/results/logs/latest-summary.json       page errors + console errors
 *   e2e/results/screenshots/obsidian-*.png     start and end of the capture window
 *
 * Usage:
 *   npx tsx e2e/run-and-collect.ts                   # 15s capture
 *   npx tsx e2e/run-and-collect.ts --duration 60     # 60s (time to click dialogs)
 *   npx tsx e2e/run-and-collect.ts --skip-build      # reuse the current main.js
 *   npx tsx e2e/run-and-collect.ts --vault /path     # a different vault
 *   npx tsx e2e/run-and-collect.ts --port 9333       # a different CDP port
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Page } from "playwright-core";
import { closeObsidian, launchObsidian, type ObsidianProcess } from "./lib/obsidian-launcher";
import { LogCollector } from "./lib/log-collector";
import { resetVault } from "./lib/vault-reset";
import {
	CDP_PORT,
	findVaultPage,
	LOGS_DIR,
	MANIFEST,
	PROJECT_ROOT,
	RESULTS_DIR,
	USER_DATA_DIR,
	VAULT_PATH,
} from "./lib/test-helpers";

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
	const idx = args.indexOf(`--${name}`);
	const value = idx !== -1 ? args[idx + 1] : undefined;
	return value ?? defaultVal;
}
function hasFlag(name: string): boolean {
	return args.includes(`--${name}`);
}

const DURATION_S = parseInt(getArg("duration", "15"), 10);
const SKIP_BUILD = hasFlag("skip-build");
const VAULT = path.resolve(getArg("vault", VAULT_PATH));
const PORT = parseInt(getArg("port", String(CDP_PORT)), 10);
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots");

async function main(): Promise<void> {
	console.log(`=== ${MANIFEST.name} E2E debug runner ===`);
	console.log(`Duration: ${DURATION_S}s | Vault: ${VAULT} | CDP port: ${PORT}`);

	if (!SKIP_BUILD) {
		console.log("\n[1/5] Building plugin...");
		try {
			execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
		} catch {
			console.error("Build failed — fix build errors first.");
			process.exit(1);
		}
	} else {
		console.log("\n[1/5] Skipping build (--skip-build)");
	}

	console.log("\n[2/5] Resetting vault from fixture...");
	resetVault(VAULT, { quiet: true });

	console.log("\n[3/5] Launching Obsidian...");
	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		obsidian = await launchObsidian({
			vaultPath: VAULT,
			cdpPort: PORT,
			userDataDir: USER_DATA_DIR,
			timeout: 30_000,
		});

		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);

		console.log("\n[4/5] Collecting console output...");
		collector = new LogCollector({ outputDir: LOGS_DIR });

		// Attach to every page now and to any that open later: Obsidian may replace
		// the initial page with a vault window, and we do not want to miss its logs.
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) collector.attach(p);
			ctx.on("page", (p) => collector?.attach(p));
		}

		let page: Page | undefined;
		try {
			page = await findVaultPage(browser, 30_000);
			console.log("Found the vault page with the plugin loaded.");
		} catch (err) {
			console.warn(`Could not confirm the plugin loaded: ${(err as Error).message}`);
			const allPages = browser.contexts().flatMap((c) => c.pages());
			page = allPages[allPages.length - 1];
		}
		if (page) collector.attach(page);

		fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
		if (page) {
			await page
				.screenshot({ path: path.join(SCREENSHOTS_DIR, "obsidian-startup.png"), fullPage: true })
				.catch((e: Error) => console.log(`[screenshot] startup failed: ${e.message}`));
		}

		console.log(`Watching for ${DURATION_S}s (the window is interactive)...`);
		await new Promise((r) => setTimeout(r, DURATION_S * 1_000));

		if (page) {
			await page
				.screenshot({ path: path.join(SCREENSHOTS_DIR, "obsidian-after-capture.png"), fullPage: true })
				.catch((e: Error) => console.log(`[screenshot] after-capture failed: ${e.message}`));
		}

		console.log("\n[5/5] Writing summary and shutting down...");
		const summaryPath = collector.writeSummary();
		const pageErrors = collector.getPageErrors();
		const consoleErrors = collector.getConsoleErrors();

		console.log("\n=== Results ===");
		console.log(`Console messages: ${collector.getRawLogs().length}`);
		console.log(`Console errors:   ${consoleErrors.length}`);
		console.log(`Page errors:      ${pageErrors.length}`);
		console.log(`Summary:          ${summaryPath}`);
		console.log(`Screenshots:      ${SCREENSHOTS_DIR}`);

		if (pageErrors.length > 0) {
			console.log("\n=== Uncaught page errors ===");
			for (const err of pageErrors.slice(-10)) {
				console.log(`  ${err.message}`);
			}
		}
		if (consoleErrors.length > 0) {
			console.log("\n=== Console errors (last 10) ===");
			for (const err of consoleErrors.slice(-10)) {
				console.log(`  ${err.text}`);
			}
		}

		await collector.dispose();
		await browser.close().catch(() => {});
	} catch (err) {
		console.error("\nFatal error:", err);
		if (collector) await collector.dispose().catch(() => {});
		process.exitCode = 1;
	} finally {
		if (obsidian) await closeObsidian(obsidian);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
