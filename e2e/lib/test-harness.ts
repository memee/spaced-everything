/**
 * Standalone test harness — the second way to write e2e tests, alongside the
 * Playwright runner in `obsidian-fixture.ts`.
 *
 * `runTest(config, testFn)` handles the whole lifecycle:
 *   build → reset vault → launch Obsidian → connect over CDP → find the vault page →
 *   open a seed note → run the test body → screenshot → write results → tear down
 *
 * Scripts using it are plain executables (`npx tsx e2e/scripts/my-test.ts`) that
 * record outcomes with `ctx.pass()` / `ctx.fail()` and exit non-zero on failure.
 * Use this style for exploratory or debugging runs where the JSON result file and
 * screenshots matter more than Playwright's reporting; use spec files for the
 * regression suite.
 *
 * Ported from notor, minus its data.json backup/restore logic: this plugin's
 * data.json lives inside the disposable test vault, so it is simply written during
 * the reset and thrown away with the vault.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { closeObsidian, launchObsidian, type ObsidianProcess } from "./obsidian-launcher";
import { LogCollector } from "./log-collector";
import { resetVault } from "./vault-reset";
import {
	buildDefaultSettings,
	CDP_PORT,
	disableSettingsPopout,
	findVaultPage,
	LOGS_DIR,
	openNote,
	PROJECT_ROOT,
	RESULTS_DIR,
	USER_DATA_DIR,
	VAULT_PATH,
	waitForVaultReady,
} from "./test-helpers";

export interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
	screenshot?: string;
}

/** Handed to every test function: the page, the log collector, and result recording. */
export class TestContext {
	readonly page: Page;
	readonly browser: Browser;
	readonly obsidian: ObsidianProcess;
	readonly collector: LogCollector;
	readonly results: TestResult[];
	readonly vaultPath: string;
	readonly screenshotsDir: string;

	constructor(opts: {
		page: Page;
		browser: Browser;
		obsidian: ObsidianProcess;
		collector: LogCollector;
		results: TestResult[];
		vaultPath: string;
		screenshotsDir: string;
	}) {
		this.page = opts.page;
		this.browser = opts.browser;
		this.obsidian = opts.obsidian;
		this.collector = opts.collector;
		this.results = opts.results;
		this.vaultPath = opts.vaultPath;
		this.screenshotsDir = opts.screenshotsDir;
	}

	pass(name: string, detail: string, screenshot?: string): void {
		console.log(`  ✓ PASS: ${name} — ${detail}`);
		this.results.push({ name, passed: true, detail, screenshot });
	}

	fail(name: string, detail: string, screenshot?: string): void {
		console.error(`  ✗ FAIL: ${name} — ${detail}`);
		this.results.push({ name, passed: false, detail, screenshot });
	}

	/** Assert a condition, recording a pass or a fail either way. */
	check(name: string, condition: boolean, detail: string, screenshot?: string): boolean {
		if (condition) this.pass(name, detail, screenshot);
		else this.fail(name, detail, screenshot);
		return condition;
	}

	async screenshot(name: string): Promise<string> {
		fs.mkdirSync(this.screenshotsDir, { recursive: true });
		const file = path.join(this.screenshotsDir, `${name}.png`);
		await this.page.screenshot({ path: file, fullPage: true });
		return file;
	}
}

export interface TestConfig {
	/** Test name — used for the results file and screenshot directory. */
	name: string;

	/**
	 * Plugin settings overrides, merged into the plugin's defaults and written to the
	 * vault's data.json before launch. Pass `null` to leave data.json unwritten.
	 */
	settings?: Record<string, unknown> | null;

	/** Skip the build step (also settable with the `--skip-build` CLI flag). */
	skipBuild?: boolean;

	/**
	 * Note to open before the test body. Four of the five commands are
	 * editorCallback commands and need an active markdown view. `null` skips it.
	 */
	seedNote?: string | null;

	/** Create extra fixtures in the vault after the reset, before launch. */
	setupVault?: (vaultPath: string) => void;

	/** Keep `.obsidian/workspace.json` across the reset. */
	keepWorkspace?: boolean;

	/** Vault-relative paths to delete during teardown. */
	cleanupFiles?: string[];

	/** CDP port override (default: 9222, or the CDP_PORT env var). */
	cdpPort?: number;

	/** Obsidian launch timeout in ms (default: 30000). */
	launchTimeout?: number;
}

function printAndWriteResults(testName: string, results: TestResult[]): void {
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	console.log("\n=== Test Results ===");
	console.log(`Passed: ${passed}/${results.length}`);
	console.log(`Failed: ${failed}/${results.length}`);

	if (failed > 0) {
		console.log("\nFailed tests:");
		for (const r of results.filter((r) => !r.passed)) {
			console.log(`  ✗ ${r.name}: ${r.detail}`);
		}
	}

	if (results.length === 0) {
		console.log(
			"\nNo assertions ran — the harness hit a fatal error before the test body " +
			"(look for 'Fatal error' above).",
		);
	}

	const resultsPath = path.join(RESULTS_DIR, `${testName}-results.json`);
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.writeFileSync(
		resultsPath,
		JSON.stringify({ passed, failed, total: results.length, results }, null, 2),
	);
	console.log(`\nResults written to: ${resultsPath}`);

	if (failed > 0 || results.length === 0) process.exit(1);
}

export async function runTest(
	config: TestConfig,
	testFn: (ctx: TestContext) => Promise<void>,
): Promise<void> {
	const cdpPort = config.cdpPort ?? CDP_PORT;
	const screenshotsDir = path.join(RESULTS_DIR, "screenshots", config.name);
	const skipBuild = config.skipBuild ?? process.argv.includes("--skip-build");
	const results: TestResult[] = [];

	console.log(`=== ${config.name} ===\n`);

	if (!skipBuild) {
		console.log("[setup] Building plugin...");
		execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
	}

	console.log("[setup] Resetting vault from fixture...");
	resetVault(VAULT_PATH, {
		settings: config.settings === null ? null : buildDefaultSettings(config.settings ?? {}),
		keepWorkspace: config.keepWorkspace,
		quiet: true,
	});

	fs.mkdirSync(screenshotsDir, { recursive: true });
	fs.mkdirSync(LOGS_DIR, { recursive: true });

	if (config.setupVault) {
		config.setupVault(VAULT_PATH);
		console.log("[setup] Custom vault fixtures created");
	}

	// After setupVault, so a fixture that rewrites app.json cannot clobber the flag
	// that keeps the settings modal inside the main window.
	disableSettingsPopout(VAULT_PATH);

	let obsidian: ObsidianProcess | undefined;
	let browser: Browser | undefined;
	let collector: LogCollector | undefined;

	const signalCleanup = async () => {
		console.log("\n  Signal received — cleaning up...");
		if (obsidian) await closeObsidian(obsidian).catch(() => {});
		process.exit(1);
	};
	process.on("SIGINT", signalCleanup);
	process.on("SIGTERM", signalCleanup);

	try {
		console.log("[setup] Launching Obsidian...");
		obsidian = await launchObsidian({
			vaultPath: VAULT_PATH,
			cdpPort,
			userDataDir: USER_DATA_DIR,
			timeout: config.launchTimeout ?? 30_000,
		});

		browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

		collector = new LogCollector({ outputDir: path.join(LOGS_DIR, config.name) });
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) collector.attach(p);
			ctx.on("page", (p) => collector?.attach(p));
		}

		const page = await findVaultPage(browser);
		collector.attach(page);
		await waitForVaultReady(page);

		// Obsidian opens the Community plugins pane by itself on a newly trusted vault.
		await page.evaluate(() => {
			const app = (window as unknown as { app?: any }).app;
			app?.setting?.close?.();
		});

		if (config.seedNote !== null) {
			await openNote(page, config.seedNote ?? "Plain.md");
		}

		console.log("[setup] Ready\n");

		const ctx = new TestContext({
			page,
			browser,
			obsidian,
			collector,
			results,
			vaultPath: VAULT_PATH,
			screenshotsDir,
		});

		await testFn(ctx);
		await ctx.screenshot("99-final");

		await page.waitForTimeout(500);
		const summaryPath = collector.writeSummary();
		console.log(`\nLog summary: ${summaryPath}`);

		const pageErrors = collector.getPageErrors();
		if (pageErrors.length > 0) {
			console.log(`\nUncaught page errors (${pageErrors.length}):`);
			for (const e of pageErrors.slice(-10)) console.log(`  ${e.message}`);
		}
	} catch (err) {
		console.error("\nFatal error:", err);
	} finally {
		if (collector) await collector.dispose().catch(() => {});
		if (browser) await browser.close().catch(() => {});
		if (obsidian) await closeObsidian(obsidian).catch(() => {});

		for (const relPath of config.cleanupFiles ?? []) {
			const fullPath = path.join(VAULT_PATH, relPath);
			try {
				if (fs.existsSync(fullPath)) {
					const stat = fs.lstatSync(fullPath);
					if (stat.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
					else fs.unlinkSync(fullPath);
				}
			} catch {
				// Best-effort cleanup.
			}
		}

		process.removeListener("SIGINT", signalCleanup);
		process.removeListener("SIGTERM", signalCleanup);
	}

	printAndWriteResults(config.name, results);
}
