/**
 * The "Capture thought" command: a modal with a textarea that creates a note from
 * the configured templates, onboards it, and records the capture time.
 *
 * Enter submits; Shift+Enter inserts a newline (captureThought in src/main.ts).
 *
 * The directory is pinned to "Inbox" for these tests. With the default empty
 * directory, createNewNoteFile() builds `${dir}/${title}` and so produces a
 * leading-slash path — real behaviour, but not what these tests are about.
 */

import { expect, test } from "../lib/obsidian-fixture";
import {
	CMD_CAPTURE_THOUGHT,
	DEFAULT_SPACING_METHOD_NAME,
	getActiveFilePath,
	ISO_UTC_RE,
	listVaultFiles,
	pollUntil,
	readVaultFile,
	runCommand,
	waitForFrontmatter,
} from "../lib/test-helpers";

const MODAL_TEXTAREA = ".modal-container .modal textarea";

test.use({
	pluginSettings: {
		capturedThoughtDirectory: "Inbox",
		capturedThoughtTitleTemplate: "Thought {{unixtime}}",
	},
});

/** Open the capture modal and wait for its textarea to be focusable. */
async function openCaptureModal(page: import("playwright-core").Page): Promise<void> {
	expect(await runCommand(page, CMD_CAPTURE_THOUGHT)).toBe(true);
	await page.locator(MODAL_TEXTAREA).waitFor({ state: "visible", timeout: 8_000 });
}

/** Wait for exactly one note in Inbox/ and return its vault-relative path. */
async function waitForCapturedNote(): Promise<string> {
	const files = await pollUntil(() => listVaultFiles("Inbox"), (f) => f.length === 1, 10_000);
	return `Inbox/${files[0]}`;
}

test.describe("capture thought", () => {
	test("creates, opens and onboards a captured note", async ({ obsidianPage }) => {
		const thought = "E2E captured thought";

		await openCaptureModal(obsidianPage);
		await expect(obsidianPage.locator(".modal-container .modal h3")).toHaveText(
			"Capture thought",
		);

		await obsidianPage.locator(MODAL_TEXTAREA).fill(thought);
		await obsidianPage.locator(MODAL_TEXTAREA).press("Enter");
		await obsidianPage
			.locator(MODAL_TEXTAREA)
			.waitFor({ state: "detached", timeout: 8_000 });

		const notePath = await waitForCapturedNote();
		expect(notePath).toMatch(/^Inbox\/Thought \d{10}\.md$/);

		const contents = readVaultFile(notePath);
		expect(contents).toContain("## Captured thought");
		expect(contents).toContain(thought);

		const fm = await waitForFrontmatter(
			obsidianPage,
			notePath,
			(f) => f?.["se-capture-time"] !== undefined && typeof f?.["se-interval"] === "number",
		);

		// Onboarded on creation, with the same defaults as a manual onboarding.
		expect(fm?.["se-interval"]).toBe(1);
		expect(fm?.["se-ease"]).toBe(2.5);
		expect(fm?.["se-method"]).toBe(DEFAULT_SPACING_METHOD_NAME);
		expect(String(fm?.["se-last-reviewed"])).toMatch(ISO_UTC_RE);

		// Unix seconds, written as a string.
		expect(String(fm?.["se-capture-time"])).toMatch(/^\d{10}$/);

		// Short thoughts also become an alias (includeShortThoughtInAlias default).
		expect(fm?.["aliases"]).toEqual([thought]);

		// openCapturedThoughtInNewTab defaults to false → replaces the current tab.
		expect(await getActiveFilePath(obsidianPage)).toBe(notePath);
	});

	test("Shift+Enter adds a newline instead of submitting", async ({ obsidianPage }) => {
		await openCaptureModal(obsidianPage);

		const textarea = obsidianPage.locator(MODAL_TEXTAREA);
		await textarea.pressSequentially("line one");
		await textarea.press("Shift+Enter");
		await textarea.pressSequentially("line two");

		// Still open: Shift+Enter must not submit.
		await expect(textarea).toBeVisible();
		expect(await textarea.inputValue()).toBe("line one\nline two");
		expect(listVaultFiles("Inbox")).toEqual([]);

		await textarea.press("Enter");
		await textarea.waitFor({ state: "detached", timeout: 8_000 });

		const notePath = await waitForCapturedNote();
		expect(readVaultFile(notePath)).toContain("line one\nline two");
	});

	test("submitting an empty thought creates nothing", async ({ obsidianPage }) => {
		await openCaptureModal(obsidianPage);

		await obsidianPage.locator(MODAL_TEXTAREA).press("Enter");
		await obsidianPage.waitForTimeout(1_500);

		expect(listVaultFiles("Inbox")).toEqual([]);
		// The modal stays open so the thought is not lost.
		await expect(obsidianPage.locator(MODAL_TEXTAREA)).toBeVisible();
	});
});
