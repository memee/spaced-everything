/** Numeric scheduling contract, independent of Obsidian and persistence. */
export interface ScheduleInput {
	/** Previous interval between reviews, in days (may be fractional). */
	readonly interval: number;
	/** Previous ease factor, which controls how quickly intervals grow. */
	readonly easeFactor: number;
	/** SM-2 quality score, conventionally 0–5; interpreted as writing feedback by the plugin. */
	readonly reviewScore: number;
}

export interface ScheduleResult {
	/** Next interval in days, with a minimum of one day for valid inputs. */
	interval: number;
	/** Adjusted ease factor, with a minimum of 1.3 for valid inputs. */
	easeFactor: number;
}

/**
 * Calculate the next review schedule using the plugin's simplified SM-2 variant.
 *
 * SM-2 uses a quality score to adjust an ease factor: higher scores allow faster
 * interval growth, while lower scores reduce ease. The plugin repurposes those
 * scores for writing: Fruitful (1) brings a note back tomorrow, Ignore (3)
 * lengthens the interval, and Unfruitful (5) lengthens it more aggressively.
 * These labels describe progress on a note rather than recall quality.
 *
 * Calculation, preserving the existing order of operations:
 * - adjustment = 0.1 - (5 - score) × (0.08 + (5 - score) × 0.02)
 * - nextEase = max(1.3, roundTo4Decimals(previousEase + adjustment))
 * - nextInterval = roundTo4Decimals(max(1, previousInterval × nextEase))
 * - For scores below 3, replace nextInterval with 1; ease still adjusts.
 *
 * This simplified variant multiplies by the newly adjusted, rounded ease factor.
 * It does not track a repetition count or implement SM-2's initial interval
 * sequence. The ease floor limits reductions in the growth multiplier; it does
 * not prevent low scores from resetting the interval to one day.
 *
 * This function has no Obsidian dependencies or side effects and does not mutate
 * its input. Callers resolve defaults and numeric conversion. Input validation
 * is intentionally unchanged by this extraction: values are not rejected or
 * clamped to the conventional score range here.
 *
 * @param input - Previous interval and ease factor, plus this review's score
 * @returns Next interval in days and adjusted ease factor
 *
 * @example
 * superMemo({ interval: 7, easeFactor: 2.5, reviewScore: 4 });
 * // { interval: 17.5, easeFactor: 2.5 } — ease remains unchanged
 *
 * superMemo({ interval: 7, easeFactor: 2.5, reviewScore: 1 });
 * // { interval: 1, easeFactor: 1.96 } — return tomorrow, with reduced ease
 *
 * superMemo({ interval: 7, easeFactor: 2.5, reviewScore: 5 });
 * // { interval: 18.2, easeFactor: 2.6 } — multiply 7 by the adjusted ease
 */
export function superMemo({ interval, easeFactor, reviewScore }: ScheduleInput): ScheduleResult {
	const adjustment = 0.1 - (5 - reviewScore) * (0.08 + (5 - reviewScore) * 0.02);
	const nextEase = Math.max(1.3, parseFloat((easeFactor + adjustment).toFixed(4)));
	const nextInterval = parseFloat(Math.max(1, interval * nextEase).toFixed(4));
	return { interval: reviewScore < 3 ? 1 : nextInterval, easeFactor: nextEase };
}
