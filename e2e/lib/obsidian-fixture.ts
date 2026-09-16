/**
 * Playwright fixtures for driving the plugin inside a real Obsidian instance.
 *
 * Each test gets a freshly reset vault and its own Obsidian process. That costs
 * roughly 10-15 seconds per test but buys hard isolation: a clean metadataCache, no
 * leaked modals, and no dependence on what an earlier test wrote to a note. Reset
 * happens on disk while Obsidian is down, so it cannot race Obsidian's own writes.
 *
 * Two option fixtures shape the environment, both settable per file or per describe
 * block with `test.use({ ... })`:
 *
 *   pluginSettings — overrides merged into buildDefaultSettings() and written to the
 *                    vault's data.json before launch, so the plugin loads with them
 *   seedNote       — a note to open before the test body runs (default "Plain.md").
 *                    Four of the five commands are editorCallback commands and will
 *                    not fire without an active markdown view. Pass null to skip.
 *
 * Usage:
 *   import { expect, test } from "../lib/obsidian-fixture";
 *   test("...", async ({ obsidianPage, logCollector }) => { ... });
 */

import { test as base, chromium, type Browser, type Page } from "@playwright/test";
import * as path from "node:path";
import { closeObsidian, launchObsidian, type ObsidianProcess } from "./obsidian-launcher";
import { LogCollector } from "./log-collector";
import { resetVault } from "./vault-reset";
import {
	buildDefaultSettings,
	CDP_PORT,
	findVaultPage,
	LOGS_DIR,
	openNote,
	USER_DATA_DIR,
	VAULT_PATH,
	waitForVaultReady,
} from "./test-helpers";

export type ObsidianOptions = {
	/** Plugin settings overrides, merged into the plugin's defaults. */
	pluginSettings: Record<string, unknown>;
	/** Note to open before the test body; null to leave the workspace empty. */
	seedNote: string | null;
};

export type ObsidianFixtures = {
	/** The Obsidian vault page, with the plugin loaded and the vault indexed. */
	obsidianPage: Page;
	/** Console output and uncaught errors for this test's Obsidian run. */
	logCollector: LogCollector;
};

export const test = base.extend<ObsidianOptions & ObsidianFixtures>({
	pluginSettings: [{}, { option: true }],
	seedNote: ["Plain.md", { option: true }],

	logCollector: async ({}, use, testInfo) => {
		const slug = testInfo.titlePath.join("__").replace(/[^\w.-]+/g, "_").slice(0, 120);
		const collector = new LogCollector({ outputDir: path.join(LOGS_DIR, slug) });

		await use(collector);

		const summaryPath = collector.writeSummary();
		await testInfo
			.attach("console-summary.json", { path: summaryPath, contentType: "application/json" })
			.catch(() => {});
		await collector.dispose();
	},

	obsidianPage: async ({ pluginSettings, seedNote, logCollector }, use, testInfo) => {
		resetVault(VAULT_PATH, { settings: buildDefaultSettings(pluginSettings), quiet: true });

		let obsidian: ObsidianProcess | undefined;
		let browser: Browser | undefined;

		try {
			obsidian = await launchObsidian({
				vaultPath: VAULT_PATH,
				cdpPort: CDP_PORT,
				userDataDir: USER_DATA_DIR,
				timeout: 30_000,
			});

			browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

			// Attach before locating the vault page so errors thrown while the plugin
			// is still loading are captured too.
			for (const ctx of browser.contexts()) {
				for (const p of ctx.pages()) logCollector.attach(p);
				ctx.on("page", (p) => logCollector.attach(p));
			}

			const page = await findVaultPage(browser);
			logCollector.attach(page);
			await waitForVaultReady(page);

			// Obsidian opens the Community plugins pane by itself the first time a vault
			// is trusted. Dismiss anything left open so tests start from a bare workspace.
			await page.evaluate(() => {
				const app = (window as unknown as { app?: any }).app;
				app?.setting?.close?.();
			});

			if (seedNote) await openNote(page, seedNote);

			await use(page);

			if (testInfo.status !== testInfo.expectedStatus) {
				const shot = testInfo.outputPath("final.png");
				await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
				await testInfo.attach("final.png", { path: shot, contentType: "image/png" }).catch(() => {});
			}
		} finally {
			if (browser) await browser.close().catch(() => {});
			if (obsidian) await closeObsidian(obsidian).catch(() => {});
		}
	},
});

export { expect } from "@playwright/test";
