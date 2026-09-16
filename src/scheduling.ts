/** Numeric scheduling contract, independent of Obsidian and persistence. */
export interface ScheduleInput {
	readonly interval: number;
	readonly easeFactor: number;
	readonly reviewScore: number;
}

export interface ScheduleResult {
	interval: number;
	easeFactor: number;
}

/**
 * Preserve the plugin's simplified SM-2 variant, including rounding order.
 * Scores below 3 reset the interval to one day; other scores multiply by the
 * newly adjusted ease. For example, (7 days, ease 2.5, score 5) yields 18.2 days.
 * Callers resolve defaults and numeric conversion before invoking this function.
 */
export function superMemo({ interval, easeFactor, reviewScore }: ScheduleInput): ScheduleResult {
	const adjustment = 0.1 - (5 - reviewScore) * (0.08 + (5 - reviewScore) * 0.02);
	const nextEase = Math.max(1.3, parseFloat((easeFactor + adjustment).toFixed(4)));
	const nextInterval = parseFloat(Math.max(1, interval * nextEase).toFixed(4));
	return { interval: reviewScore < 3 ? 1 : nextInterval, easeFactor: nextEase };
}
