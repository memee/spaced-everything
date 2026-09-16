/**
 * The "Log review outcome" command: onboarding a fresh note, and applying the
 * SuperMemo 2.0 update when an already-onboarded note is reviewed.
 *
 * Expected values come from updateInterval() in src/main.ts:
 *   newEase     = max(1.3, round4(prevEase + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))))
 *   newInterval = round4(max(1, prevInterval * newEase)), forced to 1 when q < 3
 *
 * With the fixture's prevInterval 1 and prevEase 2.5:
 *   Unfruitful (q=5) → ease 2.6,  interval 2.6
 *   Ignore     (q=3) → ease 2.36, interval 2.36
 *   Fruitful   (q=1) → ease 1.96, interval 1 (reset, because q < 3)
 */

import { expect, test } from "../lib/obsidian-fixture";
import {
	CMD_LOG_REVIEW_OUTCOME,
	DEFAULT_SPACING_METHOD_NAME,
	getFrontmatter,
	getSuggestionTexts,
	ISO_UTC_RE,
	isSuggesterOpen,
	openNote,
	pickSuggestion,
	readVaultFile,
	runCommand,
	waitForFrontmatter,
} from "../lib/test-helpers";

/** Seconds since a UTC timestamp written by formatTimestamp(). */
function ageSeconds(timestamp: unknown): number {
	return (Date.now() - Date.parse(String(timestamp))) / 1_000;
}

test.describe("log review outcome", () => {
	test("onboards a note that has no se-* frontmatter", async ({ obsidianPage }) => {
		expect(await getFrontmatter(obsidianPage, "Plain.md")).toBeNull();

		expect(await runCommand(obsidianPage, CMD_LOG_REVIEW_OUTCOME)).toBe(true);

		// Require every key onboarding writes: a lone key can be a mid-write snapshot.
		const fm = await waitForFrontmatter(
			obsidianPage,
			"Plain.md",
			(f) =>
				typeof f?.["se-interval"] === "number" &&
				typeof f?.["se-ease"] === "number" &&
				typeof f?.["se-method"] === "string",
		);

		expect(fm?.["se-interval"]).toBe(1);
		expect(fm?.["se-ease"]).toBe(2.5);
		expect(fm?.["se-method"]).toBe(DEFAULT_SPACING_METHOD_NAME);
		expect(String(fm?.["se-last-reviewed"])).toMatch(ISO_UTC_RE);
		expect(ageSeconds(fm?.["se-last-reviewed"])).toBeLessThan(120);

		// With no contexts configured and a single spacing method, onboarding asks
		// nothing (src/main.ts toggleNoteContexts / onboardNoteToSpacedEverything).
		expect(await isSuggesterOpen(obsidianPage)).toBe(false);

		const onDisk = readVaultFile("Plain.md");
		expect(onDisk.startsWith("---")).toBe(true);
		expect(onDisk).toContain(`se-method: ${DEFAULT_SPACING_METHOD_NAME}`);
	});

	test("Unfruitful grows the interval", async ({ obsidianPage }) => {
		await openNote(obsidianPage, "Overdue.md");

		expect(await runCommand(obsidianPage, CMD_LOG_REVIEW_OUTCOME)).toBe(true);
		expect(await getSuggestionTexts(obsidianPage)).toEqual([
			"Fruitful",
			"Ignore",
			"Unfruitful",
			"Remove",
		]);

		await pickSuggestion(obsidianPage, "Unfruitful");

		const fm = await waitForFrontmatter(
			obsidianPage,
			"Overdue.md",
			(f) => typeof f?.["se-interval"] === "number" && f["se-interval"] !== 1,
		);

		expect(fm?.["se-interval"] as number).toBeCloseTo(2.6, 4);
		expect(fm?.["se-ease"] as number).toBeCloseTo(2.6, 4);
		expect(String(fm?.["se-last-reviewed"])).toMatch(ISO_UTC_RE);
		expect(ageSeconds(fm?.["se-last-reviewed"])).toBeLessThan(120);
		expect(fm?.["se-method"]).toBe(DEFAULT_SPACING_METHOD_NAME);
	});

	test("Fruitful resets the interval to 1 and lowers ease", async ({ obsidianPage }) => {
		await openNote(obsidianPage, "Overdue Later.md");

		expect(await runCommand(obsidianPage, CMD_LOG_REVIEW_OUTCOME)).toBe(true);
		await pickSuggestion(obsidianPage, "Fruitful");

		// The interval stays 1 here, so key off the ease factor dropping instead.
		const fm = await waitForFrontmatter(
			obsidianPage,
			"Overdue Later.md",
			(f) => typeof f?.["se-ease"] === "number" && f["se-ease"] < 2.5,
		);

		expect(fm?.["se-interval"]).toBe(1);
		expect(fm?.["se-ease"] as number).toBeCloseTo(1.96, 4);
		expect(ageSeconds(fm?.["se-last-reviewed"])).toBeLessThan(120);
	});

	test("Ignore grows the interval more slowly", async ({ obsidianPage }) => {
		await openNote(obsidianPage, "Overdue.md");

		expect(await runCommand(obsidianPage, CMD_LOG_REVIEW_OUTCOME)).toBe(true);
		await pickSuggestion(obsidianPage, "Ignore");

		const fm = await waitForFrontmatter(
			obsidianPage,
			"Overdue.md",
			(f) => typeof f?.["se-interval"] === "number" && f["se-interval"] !== 1,
		);

		expect(fm?.["se-interval"] as number).toBeCloseTo(2.36, 4);
		expect(fm?.["se-ease"] as number).toBeCloseTo(2.36, 4);
	});

	test("Remove strips the review fields but leaves se-method", async ({ obsidianPage }) => {
		await openNote(obsidianPage, "Overdue.md");

		expect(await runCommand(obsidianPage, CMD_LOG_REVIEW_OUTCOME)).toBe(true);
		await pickSuggestion(obsidianPage, "Remove");

		// se-method must still be there, which also rules out an empty mid-write read.
		const fm = await waitForFrontmatter(
			obsidianPage,
			"Overdue.md",
			(f) => typeof f?.["se-method"] === "string" && f["se-interval"] === undefined,
		);

		expect(fm?.["se-interval"]).toBeUndefined();
		expect(fm?.["se-ease"]).toBeUndefined();
		expect(fm?.["se-last-reviewed"]).toBeUndefined();

		// removeNoteFromSpacedEverything() does not clear se-method (src/main.ts).
		expect(fm?.["se-method"]).toBe(DEFAULT_SPACING_METHOD_NAME);
	});
});
