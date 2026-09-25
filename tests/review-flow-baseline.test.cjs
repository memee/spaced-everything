/**
 * The "Log review outcome" command flow in src/main.ts, as shipped today.
 *
 * `logReviewOutcome()` is the only caller of `updateInterval()`, so it defines
 * what the interval calculation is actually fed and when its queued updates get
 * persisted. These tests pin that wiring: which prompt the user sees, which score
 * reaches the calculation, which paths skip it entirely, and — the easy one to
 * break — whether the frontmatter queue is flushed on each exit.
 *
 * The e2e suite covers this same command inside the real app. This file is the
 * fast version: it catches a wiring regression in milliseconds instead of an
 * Obsidian launch, and can cover branches that are awkward to reach through the
 * UI (a review option with no score, a vault with no active file).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createPluginHarness, defaultSpacingMethod } = require("./helpers/harness.cjs");

/** The default review options, in the order the settings ship them. */
const REVIEW_OPTION_NAMES = ["Fruitful", "Ignore", "Unfruitful"];

/** Frontmatter of a note already onboarded: `isNoteOnboarded` keys off se-interval. */
const ONBOARDED = {
	"se-interval": 7,
	"se-ease": 2.5,
	"se-last-reviewed": "2025-12-01T00:00:00Z",
	"se-method": "SuperMemo 2.0 (Simplified)",
};

/**
 * Record every `updateInterval` call while keeping the real implementation.
 * @returns {Array<{score: number, timestamp: string, method: object}>}
 */
function spyOnUpdateInterval(plugin) {
	const calls = [];
	const original = plugin.updateInterval.bind(plugin);

	plugin.updateInterval = async (file, frontmatter, score, timestamp, method) => {
		calls.push({ file, score, timestamp, method });
		return original(file, frontmatter, score, timestamp, method);
	};

	return calls;
}

test("an onboarded note is offered its review options plus Remove", async () => {
	const harness = createPluginHarness({ frontmatter: ONBOARDED });
	harness.answerSuggester("Unfruitful");

	await harness.plugin.logReviewOutcome();

	// Exactly one prompt: with a single spacing method and no contexts configured,
	// nothing else asks the user anything.
	assert.equal(harness.prompts.length, 1);
	assert.deepEqual(harness.prompts[0], {
		promptText: "Select review outcome:",
		items: [...REVIEW_OPTION_NAMES, "Remove"],
	});
});

test("the chosen option's score is what reaches the calculation", async () => {
	// Fruitful is score 1, Ignore 3, Unfruitful 5. The mapping is only defined in
	// settings, so a mix-up here would silently invert the whole scheduler.
	const expected = { Fruitful: 1, Ignore: 3, Unfruitful: 5 };

	for (const [choice, score] of Object.entries(expected)) {
		const harness = createPluginHarness({ frontmatter: ONBOARDED });
		const calls = spyOnUpdateInterval(harness.plugin);
		harness.answerSuggester(choice);

		await harness.plugin.logReviewOutcome();

		assert.equal(calls.length, 1, `${choice} should trigger exactly one update`);
		assert.equal(calls[0].score, score, `${choice} should map to score ${score}`);
		assert.equal(calls[0].file, harness.file);
	}
});

test("a review persists its schedule directly and flushes the remaining queue once", async () => {
	const harness = createPluginHarness({ frontmatter: ONBOARDED });
	harness.answerSuggester("Unfruitful");
	await harness.plugin.logReviewOutcome();
	assert.deepEqual(harness.processedQueue, [[]]);
	assert.deepEqual(harness.queued, []);
	assert.equal(harness.frontmatter["se-interval"], 18.2);
	assert.equal(harness.frontmatter["se-ease"], 2.6);
	assert.ok(harness.frontmatter["se-last-reviewed"]);
});

test("the timestamp handed to the calculation is a formatted UTC string", async () => {
	// updateInterval() stores this verbatim, so the formatting decision is made
	// here, by formatTimestamp() and the timestampTimeZone setting.
	const harness = createPluginHarness({
		frontmatter: ONBOARDED,
		settings: { timestampTimeZone: "UTC" },
	});
	const calls = spyOnUpdateInterval(harness.plugin);
	harness.answerSuggester("Ignore");

	await harness.plugin.logReviewOutcome();

	assert.match(calls[0].timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("choosing Remove strips the review fields but leaves se-method behind", async () => {
	const harness = createPluginHarness({ frontmatter: ONBOARDED });
	const calls = spyOnUpdateInterval(harness.plugin);
	harness.answerSuggester("Remove");

	await harness.plugin.logReviewOutcome();

	assert.deepEqual(calls, [], "Remove must not run the interval calculation");
	assert.deepEqual(harness.queued, [
		{
			file: harness.file,
			updates: {
				"se-interval": undefined,
				"se-ease": undefined,
				"se-last-reviewed": undefined,
				"se-contexts": undefined,
			},
		},
	]);

	// se-method is not in that list, so a removed note keeps it. Onboarding the
	// note again later will reuse the stale method name.
	assert.ok(!("se-method" in harness.queued[0].updates));
	assert.equal(harness.processedQueue.length, 1);
});

test("cancelling the prompt changes nothing and skips the queue flush", async () => {
	const harness = createPluginHarness({ frontmatter: ONBOARDED });
	const calls = spyOnUpdateInterval(harness.plugin);
	harness.answerSuggester(null); // Escape

	await harness.plugin.logReviewOutcome();

	assert.deepEqual(calls, []);
	assert.deepEqual(harness.queued, []);
	assert.deepEqual(harness.notices, ["Spaced Everything review cancelled by user"]);

	// The early return skips processFrontmatterQueue(). Harmless while nothing is
	// queued — but getActiveSpacingMethod() can queue an se-method fix before the
	// prompt opens, and that fix is then dropped. See the next test.
	assert.deepEqual(harness.processedQueue, []);
});

test("an se-method fix queued before a cancelled prompt is silently dropped", async () => {
	// getActiveSpacingMethod() repairs a missing or unknown se-method by queueing
	// an update. If the user then presses Escape, logReviewOutcome() returns
	// without flushing, so the repair never lands and the notice announcing it was
	// a lie. Recorded as current behavior.
	const harness = createPluginHarness({
		frontmatter: { "se-interval": 7, "se-ease": 2.5, "se-method": "Deleted method" },
	});
	harness.answerSuggester(null);

	await harness.plugin.logReviewOutcome();

	assert.deepEqual(harness.queued, [
		{ file: harness.file, updates: { "se-method": "SuperMemo 2.0 (Simplified)" } },
	]);
	assert.deepEqual(harness.processedQueue, [], "the repair is queued but never flushed");
	assert.ok(harness.notices.some((n) => n.includes("Set 'se-method'")));
});

test("a review option with no score is rejected before any update", async () => {
	const harness = createPluginHarness({
		frontmatter: ONBOARDED,
		settings: {
			spacingMethods: [
				defaultSpacingMethod({
					reviewOptions: [{ name: "Unscored", score: undefined }],
				}),
			],
		},
	});
	const calls = spyOnUpdateInterval(harness.plugin);
	harness.answerSuggester("Unscored");

	await harness.plugin.logReviewOutcome();

	assert.deepEqual(calls, []);
	assert.deepEqual(harness.queued, []);
	assert.ok(harness.notices.some((n) => n.includes("Review option score is not set")));
	assert.deepEqual(harness.processedQueue, [], "the early return also skips the flush");
});

test("a note with no se-interval is onboarded instead of reviewed", async () => {
	const harness = createPluginHarness({ frontmatter: { title: "Fresh note" } });
	const calls = spyOnUpdateInterval(harness.plugin);

	await harness.plugin.logReviewOutcome();

	assert.deepEqual(calls, [], "onboarding must not run the interval calculation");
	assert.equal(harness.queued.length, 1);

	const { updates } = harness.queued[0];
	assert.equal(updates["se-interval"], 1);
	assert.equal(updates["se-ease"], 2.5);
	assert.equal(updates["se-method"], "SuperMemo 2.0 (Simplified)");
	assert.match(updates["se-last-reviewed"], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

	assert.ok(harness.notices.some((n) => n.startsWith("Onboarded note to Spaced Everything")));
	assert.equal(harness.processedQueue.length, 1);
});

test("a note with frontmatter but no se-interval still counts as not onboarded", async () => {
	// isNoteOnboarded() checks for the se-interval key only. A note that kept
	// se-method and se-ease after a Remove is therefore onboarded again from
	// scratch, discarding nothing but reusing the defaults.
	const harness = createPluginHarness({
		frontmatter: { "se-ease": 2.6, "se-method": "SuperMemo 2.0 (Simplified)" },
	});
	const calls = spyOnUpdateInterval(harness.plugin);

	await harness.plugin.logReviewOutcome();

	assert.deepEqual(calls, []);
	assert.equal(harness.queued[0].updates["se-ease"], 2.5, "the stored 2.6 is overwritten");
});

test("no active file produces a notice and nothing else", async () => {
	const harness = createPluginHarness({ frontmatter: ONBOARDED });
	harness.plugin.app.workspace.getActiveFile = () => null;
	const calls = spyOnUpdateInterval(harness.plugin);

	await harness.plugin.logReviewOutcome();

	assert.deepEqual(calls, []);
	assert.deepEqual(harness.queued, []);
	assert.deepEqual(harness.notices, ["No active file to review."]);
	assert.deepEqual(harness.processedQueue, []);
});
