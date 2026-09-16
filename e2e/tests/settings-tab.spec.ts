/**
 * The settings tab: it registers under the plugin id, renders its sections, and
 * closes cleanly.
 *
 * Two Obsidian facts drive the approach here (both ported from notor's e2e notes):
 *   - Settings must be opened via `app.setting.openTabById`. The `Meta+,` hotkey
 *     works over CDP but lands on the About tab.
 *   - Queries must be scoped to SETTINGS_CONTENT_SELECTOR, because Obsidian's
 *     settings sidebar search renders `.setting-item` rows of its own.
 */

import { expect, test } from "../lib/obsidian-fixture";
import {
	closeSettings,
	getActiveSettingsTabId,
	MANIFEST,
	openPluginSettings,
	PLUGIN_ID,
	SETTINGS_CONTENT_SELECTOR,
} from "../lib/test-helpers";

test.use({ seedNote: null });

test.describe("settings tab", () => {
	test("opens on the plugin's own tab", async ({ obsidianPage }) => {
		expect(await openPluginSettings(obsidianPage)).toBe(true);
		expect(await getActiveSettingsTabId(obsidianPage)).toBe(PLUGIN_ID);

		// Rendered inline rather than in a popout window, so it is screenshottable
		// and queryable from this page (see disableSettingsPopout).
		await expect(obsidianPage.locator(".modal.mod-settings")).toBeVisible();
		await expect(
			obsidianPage.locator(".vertical-tab-nav-item", { hasText: MANIFEST.name }),
		).toHaveCount(1);
	});

	test("renders the plugin's settings sections", async ({ obsidianPage }) => {
		expect(await openPluginSettings(obsidianPage)).toBe(true);

		const content = obsidianPage.locator(SETTINGS_CONTENT_SELECTOR);
		const headings = (
			await content.locator(".setting-item-heading .setting-item-name").allInnerTexts()
		).map((t) => t.trim());

		expect(headings).toContain("Spacing methods");
		expect(headings).toContain("Contexts");

		// A rough floor: the tab renders far more rows than the sidebar search would.
		expect(await content.locator(".setting-item").count()).toBeGreaterThan(5);
	});

	test("closes via the app API", async ({ obsidianPage }) => {
		expect(await openPluginSettings(obsidianPage)).toBe(true);
		await closeSettings(obsidianPage);

		await expect(obsidianPage.locator(".modal.mod-settings")).toHaveCount(0);
	});
});
