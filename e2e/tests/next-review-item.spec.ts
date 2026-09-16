/**
 * The "Open next review item" command: pick the most overdue note, or tell the user
 * there is nothing to review.
 *
 * Due date is `se-last-reviewed + se-interval days`, and the queue is sorted by it
 * ascending (openNextReviewItem in src/main.ts). The fixture vault is built so the
 * order is unambiguous:
 *
 *   Overdue.md        interval 1     reviewed 2020  → first
 *   Overdue Later.md  interval 1     reviewed 2021  → second
 *   Contextual.md     interval 1     reviewed 2022  → third
 *   Matured.md        interval 7     reviewed 2023  → fourth (due 2023-01-08)
 *   Not Due.md        interval 3650  reviewed 2025  → excluded
 *   Plain.md          no se-interval                → excluded
 */

import { expect, test } from "../lib/obsidian-fixture";
import {
	CMD_OPEN_NEXT_REVIEW_ITEM,
	getActiveFilePath,
	pollUntil,
	runCommand,
	setFrontmatter,
	waitForFrontmatter,
	waitForNotice,
} from "../lib/test-helpers";

const OVERDUE_NOTES = ["Overdue.md", "Overdue Later.md", "Contextual.md", "Matured.md"];

test.describe("open next review item", () => {
	test("opens the most overdue note", async ({ obsidianPage }) => {
		expect(await getActiveFilePath(obsidianPage)).toBe("Plain.md");

		expect(await runCommand(obsidianPage, CMD_OPEN_NEXT_REVIEW_ITEM)).toBe(true);

		await pollUntil(() => getActiveFilePath(obsidianPage), (p) => p === "Overdue.md", 10_000);
		expect(await getActiveFilePath(obsidianPage)).toBe("Overdue.md");
	});

	test("walks the queue in due-date order", async ({ obsidianPage }) => {
		// Reviewing the head of the queue pushes it to the back, so the next
		// invocation should surface the next-most-overdue note.
		expect(await runCommand(obsidianPage, CMD_OPEN_NEXT_REVIEW_ITEM)).toBe(true);
		await pollUntil(() => getActiveFilePath(obsidianPage), (p) => p === "Overdue.md", 10_000);

		await setFrontmatter(obsidianPage, "Overdue.md", {
			"se-last-reviewed": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		});
		await waitForFrontmatter(
			obsidianPage,
			"Overdue.md",
			(f) => String(f?.["se-last-reviewed"]).startsWith(String(new Date().getUTCFullYear())),
		);

		expect(await runCommand(obsidianPage, CMD_OPEN_NEXT_REVIEW_ITEM)).toBe(true);
		await pollUntil(
			() => getActiveFilePath(obsidianPage),
			(p) => p === "Overdue Later.md",
			10_000,
		);
	});

	test("reports an empty queue instead of opening a note", async ({ obsidianPage }) => {
		// Mark every overdue note as just reviewed; only Not Due.md and the
		// un-onboarded Plain.md are left, neither of which is due.
		const nowUtc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
		for (const note of OVERDUE_NOTES) {
			await setFrontmatter(obsidianPage, note, { "se-last-reviewed": nowUtc });
			await waitForFrontmatter(
				obsidianPage,
				note,
				(f) => f?.["se-last-reviewed"] === nowUtc,
			);
		}

		expect(await runCommand(obsidianPage, CMD_OPEN_NEXT_REVIEW_ITEM)).toBe(true);

		expect(await waitForNotice(obsidianPage, "No notes to review")).toContain(
			"enjoy some fresh air",
		);
		expect(await getActiveFilePath(obsidianPage)).toBe("Plain.md");
	});
});
