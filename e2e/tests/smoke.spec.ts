/**
 * Smoke tests: the plugin loads into a real Obsidian instance, registers its
 * commands, and picks up the settings the harness injected.
 *
 * These are the tests to check first when the whole suite starts failing — they
 * exercise the harness itself as much as the plugin.
 */

import { expect, test } from "../lib/obsidian-fixture";
import {
	COMMAND_IDS,
	DEFAULT_SPACING_METHOD_NAME,
	getPluginSettings,
	getRegisteredCommandIds,
	MANIFEST,
	PLUGIN_ID,
} from "../lib/test-helpers";

// A non-default value proves data.json injection reached the running plugin.
test.use({ pluginSettings: { timestampTimeZone: "Local" }, seedNote: null });

test.describe("plugin smoke tests", () => {
	test("plugin is enabled and loaded", async ({ obsidianPage }) => {
		const info = await obsidianPage.evaluate((id: string) => {
			const app = (window as unknown as { app?: any }).app;
			const plugin = app.plugins.plugins[id];
			return {
				enabled: app.plugins.enabledPlugins.has(id),
				loaded: Boolean(plugin),
				version: plugin?.manifest?.version ?? null,
				name: plugin?.manifest?.name ?? null,
			};
		}, PLUGIN_ID);

		expect(info.enabled).toBe(true);
		expect(info.loaded).toBe(true);
		expect(info.version).toBe(MANIFEST.version);
		expect(info.name).toBe(MANIFEST.name);
	});

	test("registers exactly its five commands", async ({ obsidianPage }) => {
		const ids = await getRegisteredCommandIds(obsidianPage);
		expect(ids).toEqual([...COMMAND_IDS].sort());
	});

	test("loads settings from the injected data.json", async ({ obsidianPage }) => {
		const settings = await getPluginSettings(obsidianPage);

		// Injected override.
		expect(settings.timestampTimeZone).toBe("Local");

		// Defaults the harness mirrors from DEFAULT_SETTINGS; a mismatch here means
		// buildDefaultSettings() has drifted from src/main.ts.
		const methods = settings.spacingMethods as Array<Record<string, unknown>>;
		expect(methods).toHaveLength(1);
		expect(methods[0].name).toBe(DEFAULT_SPACING_METHOD_NAME);
		expect(methods[0].defaultInterval).toBe(1);
		expect(methods[0].defaultEaseFactor).toBe(2.5);
		expect(methods[0].reviewOptions).toEqual([
			{ name: "Fruitful", score: 1 },
			{ name: "Ignore", score: 3 },
			{ name: "Unfruitful", score: 5 },
		]);
	});

	test("loads without throwing", async ({ obsidianPage, logCollector }) => {
		// The vault is indexed and the plugin is loaded by the time the fixture returns,
		// so anything captured here happened during startup.
		expect(logCollector.getPageErrors()).toEqual([]);

		// Obsidian logs errors of its own (update checks, telemetry), so only assert on
		// console errors that mention this plugin.
		const ours = logCollector
			.getConsoleErrors()
			.filter((e) => e.text.includes(PLUGIN_ID) || e.text.toLowerCase().includes("spaced"));
		expect(ours).toEqual([]);

		await obsidianPage.waitForTimeout(100);
	});
});
