/**
 * The call contract of `updateInterval()` in src/main.ts, as shipped today.
 *
 * Companion to scheduling-baseline.test.cjs: that file pins the arithmetic, this
 * one pins everything around it — where the prior scheduling state is read from,
 * how missing values are resolved, what gets queued rather than written, what the
 * user is told, and when the log line is emitted.
 *
 * Both files exist to make behavior-preserving refactors of this method
 * checkable. Anything asserted here is current behavior, including the parts that
 * look like bugs; those are called out in comments rather than fixed, because a
 * test that quietly encodes a wish is worse than no test.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createPluginHarness } = require("./helpers/harness.cjs");

/** A spacing method whose defaults are distinguishable from the hardcoded ones. */
const METHOD = { name: "Test method", defaultInterval: 3, defaultEaseFactor: 2 };

const TIMESTAMP = "2026-01-01T12:00:00Z";

test("prior state comes from the file, not from the caller's frontmatter argument", async () => {
	// The callback parameter shadows the `frontmatter` argument, so the snapshot
	// the caller passes in is never read for scheduling. logReviewOutcome() hands
	// over a metadataCache snapshot that can be stale; this is why that does not
	// matter here.
	const harness = createPluginHarness({ frontmatter: { "se-interval": 7, "se-ease": 2.5 } });
	const staleSnapshot = { "se-interval": 999, "se-ease": 9.99 };

	const result = await harness.plugin.updateInterval(
		harness.file,
		staleSnapshot,
		4,
		TIMESTAMP,
		METHOD,
	);

	assert.deepEqual(result, { newInterval: 17.5, newEaseFactor: 2.5 });
});

test("missing values fall back to the spacing method's defaults, then to 1 and 2.5", async () => {
	const withMethod = createPluginHarness({ frontmatter: {} });
	assert.deepEqual(
		await withMethod.plugin.updateInterval(withMethod.file, {}, 4, TIMESTAMP, METHOD),
		{ newInterval: 6, newEaseFactor: 2 },
		"should use the method's 3 / 2.0",
	);

	const noMethod = createPluginHarness({ frontmatter: {} });
	assert.deepEqual(
		await noMethod.plugin.updateInterval(noMethod.file, {}, 4, TIMESTAMP, undefined),
		{ newInterval: 2.5, newEaseFactor: 2.5 },
		"should use the hardcoded 1 / 2.5 when no method is supplied",
	);
});

test("falsy stored values fall back to defaults instead of being used", async () => {
	// `frontmatter['se-interval'] || default` treats 0 and "" as absent. A note
	// deliberately set to a zero interval therefore gets the default instead.
	// Recorded as current behavior; changing it is a behavior change, not a
	// refactor.
	for (const falsy of [0, "", null, false]) {
		const harness = createPluginHarness({
			frontmatter: { "se-interval": falsy, "se-ease": falsy },
		});

		assert.deepEqual(
			await harness.plugin.updateInterval(harness.file, {}, 4, TIMESTAMP, METHOD),
			{ newInterval: 6, newEaseFactor: 2 },
			`se-interval ${JSON.stringify(falsy)} should fall through to the default`,
		);
	}

	// The same applies one level down: zeroed method defaults fall through to 1 / 2.5.
	const zeroDefaults = createPluginHarness({ frontmatter: {} });
	assert.deepEqual(
		await zeroDefaults.plugin.updateInterval(zeroDefaults.file, {}, 4, TIMESTAMP, {
			defaultInterval: 0,
			defaultEaseFactor: 0,
		}),
		{ newInterval: 2.5, newEaseFactor: 2.5 },
	);
});

test("numeric strings in frontmatter are coerced", async () => {
	// Hand-edited frontmatter, or a note synced from another tool, can quote these.
	const harness = createPluginHarness({ frontmatter: { "se-interval": "7", "se-ease": "2.5" } });

	assert.deepEqual(
		await harness.plugin.updateInterval(harness.file, {}, 5, TIMESTAMP, METHOD),
		{ newInterval: 18.2, newEaseFactor: 2.6 },
	);
});

test("non-numeric frontmatter yields NaN, and NaN is written and announced", async () => {
	// Recorded, not endorsed: nothing validates the coercion, so `se-interval: soon`
	// silently corrupts the note's schedule and shows the user "from NaN to NaN".
	const harness = createPluginHarness({
		frontmatter: { "se-interval": "soon", "se-ease": "easy" },
	});

	const { newInterval, newEaseFactor } = await harness.plugin.updateInterval(
		harness.file,
		{},
		4,
		TIMESTAMP,
		METHOD,
	);

	assert.ok(Number.isNaN(newInterval));
	assert.ok(Number.isNaN(newEaseFactor));
	assert.ok(Number.isNaN(harness.queued[0].updates["se-interval"]));
	assert.deepEqual(harness.notices, ["Interval updated from NaN to NaN"]);
});

test("the new schedule is queued, not written, and only three keys are touched", async () => {
	const harness = createPluginHarness({
		frontmatter: { "se-interval": 7, "se-ease": 2.5, "se-method": "Test method", title: "keep" },
	});
	const before = { ...harness.frontmatter };

	await harness.plugin.updateInterval(harness.file, {}, 5, TIMESTAMP, METHOD);

	// updateInterval() opens processFrontMatter but must not write through it;
	// persistence is the caller's job via processFrontmatterQueue().
	assert.deepEqual(harness.frontmatter, before, "updateInterval must not write frontmatter directly");

	assert.deepEqual(harness.queued, [
		{
			file: harness.file,
			updates: {
				"se-interval": 18.2,
				"se-ease": 2.6,
				"se-last-reviewed": TIMESTAMP,
			},
		},
	]);

	// The caller decides when to flush. updateInterval() on its own does not.
	assert.deepEqual(harness.processedQueue, []);
});

test("the timestamp is stored verbatim, without reformatting", async () => {
	// formatTimestamp() already applied the timestampTimeZone setting; this method
	// must not second-guess it.
	const harness = createPluginHarness({ frontmatter: { "se-interval": 1, "se-ease": 2.5 } });
	const localTimestamp = "2026-01-01T12:00:00+13:00";

	await harness.plugin.updateInterval(harness.file, {}, 3, localTimestamp, METHOD);

	assert.equal(harness.queued[0].updates["se-last-reviewed"], localTimestamp);
});

test("the notice reports the resolved previous interval and the new one", async () => {
	const stored = createPluginHarness({ frontmatter: { "se-interval": 30, "se-ease": 2.5 } });
	await stored.plugin.updateInterval(stored.file, {}, 1, TIMESTAMP, METHOD);
	assert.deepEqual(stored.notices, ["Interval updated from 30 to 1"]);

	// When the stored value was absent, the notice shows the default that was used
	// rather than saying nothing was there.
	const defaulted = createPluginHarness({ frontmatter: {} });
	await defaulted.plugin.updateInterval(defaulted.file, {}, 5, TIMESTAMP, METHOD);
	assert.deepEqual(defaulted.notices, ["Interval updated from 3 to 6.3"]);
});

test("the review is logged only when a log file is configured", async () => {
	const off = createPluginHarness({
		frontmatter: { "se-interval": 7, "se-ease": 2.5 },
		settings: { logFilePath: "" },
	});
	await off.plugin.updateInterval(off.file, {}, 5, TIMESTAMP, METHOD);
	assert.deepEqual(off.logs, [], "no log call when logFilePath is empty");

	const on = createPluginHarness({
		frontmatter: { "se-interval": 7, "se-ease": 2.5 },
		settings: { logFilePath: "logs/reviews.jsonl" },
	});
	await on.plugin.updateInterval(on.file, {}, 5, TIMESTAMP, METHOD);

	assert.equal(on.logs.length, 1);
	const [action, file, loggedFrontmatter, score, interval, ease] = on.logs[0];
	assert.equal(action, "review");
	assert.equal(file, on.file);
	assert.equal(score, 5);
	assert.equal(interval, 18.2);
	assert.equal(ease, 2.6);

	// The log receives the live frontmatter object from the callback — the note's
	// state *before* this review, since nothing has been written yet.
	assert.deepEqual(loggedFrontmatter, { "se-interval": 7, "se-ease": 2.5 });
});

test("the log line is emitted before the update is queued or announced", async () => {
	// Ordering matters for the log's meaning: the entry describes the transition,
	// so it must be written while the pre-review frontmatter is still intact.
	const harness = createPluginHarness({
		frontmatter: { "se-interval": 7, "se-ease": 2.5 },
		settings: { logFilePath: "logs/reviews.jsonl" },
	});
	const order = [];

	harness.plugin.logger = { log: () => order.push("log") };
	const add = harness.plugin.frontmatterQueue.add;
	harness.plugin.frontmatterQueue.add = (...args) => {
		order.push("queue");
		return add(...args);
	};

	await harness.plugin.updateInterval(harness.file, {}, 5, TIMESTAMP, METHOD);
	order.push(`notice:${harness.notices.length}`);

	assert.deepEqual(order, ["log", "queue", "notice:1"]);
});

test("the returned values are the ones queued", async () => {
	// logReviewOutcome() currently ignores the return value, but it is part of the
	// method's signature and must stay consistent with what lands in the note.
	const harness = createPluginHarness({ frontmatter: { "se-interval": 7, "se-ease": 2.5 } });

	const result = await harness.plugin.updateInterval(harness.file, {}, 3, TIMESTAMP, METHOD);
	const { updates } = harness.queued[0];

	assert.equal(result.newInterval, updates["se-interval"]);
	assert.equal(result.newEaseFactor, updates["se-ease"]);
});
