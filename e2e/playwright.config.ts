/**
 * Playwright configuration for Obsidian E2E testing.
 *
 * This is NOT a typical browser-based Playwright config. Obsidian is an Electron
 * app backed by Chromium, so instead of launching a browser we spawn the installed
 * Obsidian binary with `--remote-debugging-port` and attach over the Chrome
 * DevTools Protocol (see `lib/obsidian-launcher.ts` and `lib/obsidian-fixture.ts`).
 *
 * Consequences of the CDP approach:
 *   - `use.browserName` / `use.trace` / `use.video` do nothing; Playwright does not
 *     own the browser, so it cannot instrument it. The fixture captures a screenshot
 *     on failure and attaches a console-log summary instead.
 *   - `workers: 1` is mandatory: one Obsidian instance owns the CDP port and the
 *     test vault at a time.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	// A single test pays for an Obsidian launch (~10-15s) plus vault reset.
	timeout: 90_000,
	retries: 0,
	workers: 1,
	fullyParallel: false,
	globalSetup: "./global-setup.ts",
	reporter: [["list"], ["json", { outputFile: "results/test-results.json" }]],
	outputDir: "results/artifacts",
});
