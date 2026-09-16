#!/usr/bin/env npx tsx
/**
 * Smoke test in the standalone harness style — a template for new scripts.
 *
 * Mirrors part of e2e/tests/smoke.spec.ts, but records outcomes with ctx.pass()/
 * ctx.fail(), writes e2e/results/smoke-results.json, and captures screenshots.
 *
 * Usage:
 *   npx tsx e2e/scripts/smoke-test.ts
 *   npx tsx e2e/scripts/smoke-test.ts --skip-build
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	CMD_LOG_REVIEW_OUTCOME,
	COMMAND_IDS,
	DEFAULT_SPACING_METHOD_NAME,
	getFrontmatter,
	getPluginSettings,
	getRegisteredCommandIds,
	PLUGIN_ID,
	runCommand,
	waitForFrontmatter,
} from "../lib/test-helpers";

async function testCommandsRegistered(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: commands registered");
	const ids = await getRegisteredCommandIds(ctx.page);
	const expected = [...COMMAND_IDS].sort();
	ctx.check(
		"commands registered",
		JSON.stringify(ids) === JSON.stringify(expected),
		`found ${ids.length}: ${ids.join(", ")}`,
	);
}

async function testSettingsLoaded(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: settings loaded from data.json");
	const settings = await getPluginSettings(ctx.page);
	const methods = (settings.spacingMethods ?? []) as Array<Record<string, unknown>>;
	ctx.check(
		"spacing method loaded",
		methods.length === 1 && methods[0]?.name === DEFAULT_SPACING_METHOD_NAME,
		`spacingMethods=${JSON.stringify(methods.map((m) => m.name))}`,
	);
}

async function testOnboarding(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: log review outcome onboards the seed note");
	const before = await getFrontmatter(ctx.page, "Plain.md");
	if (before !== null) {
		ctx.fail("seed note starts un-onboarded", `frontmatter=${JSON.stringify(before)}`);
		return;
	}

	if (!(await runCommand(ctx.page, CMD_LOG_REVIEW_OUTCOME))) {
		ctx.fail("run log-review-outcome", "command did not run (no active markdown view?)");
		return;
	}

	try {
		const fm = await waitForFrontmatter(
			ctx.page,
			"Plain.md",
			(f) => typeof f?.["se-interval"] === "number" && typeof f?.["se-method"] === "string",
		);
		const shot = await ctx.screenshot("01-onboarded");
		ctx.check(
			"onboarded with defaults",
			fm?.["se-interval"] === 1 && fm?.["se-ease"] === 2.5,
			`frontmatter=${JSON.stringify(fm)}`,
			shot,
		);
	} catch (err) {
		const shot = await ctx.screenshot("01-onboard-failed");
		ctx.fail("onboarded with defaults", (err as Error).message, shot);
	}
}

async function testNoPageErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: no uncaught page errors");
	const errors = ctx.collector.getPageErrors();
	ctx.check(
		"no uncaught page errors",
		errors.length === 0,
		errors.length === 0 ? "none" : JSON.stringify(errors.slice(0, 3)),
	);
}

async function tests(ctx: TestContext): Promise<void> {
	await testCommandsRegistered(ctx);
	await testSettingsLoaded(ctx);
	await testOnboarding(ctx);
	await testNoPageErrors(ctx);
}

runTest({ name: "smoke", seedNote: "Plain.md" }, tests).catch((err) => {
	console.error(err);
	process.exit(1);
});
