# Unit tests

Fast, hermetic tests for the plugin's logic. No Obsidian, no vault, no network:
`npm test` runs the whole suite in well under a second.

```bash
npm test                                          # everything
node --test tests/scheduling-baseline.test.cjs    # one file
node --test --test-name-pattern "golden" tests/*.test.cjs
```

## Relationship to `e2e/`

| | `tests/` | `e2e/` |
| --- | --- | --- |
| Runs against | `src/*.ts`, bundled in memory | the built `main.js` inside real Obsidian |
| Obsidian API | substituted (`tests/helpers/harness.cjs`) | the real thing |
| Cost | ~100 ms for the suite | ~10–15 s per test (app launch) |
| Catches | wrong arithmetic, wrong wiring, wrong contract | anything that only breaks inside the app |

They are complements. A calculation change should fail here first; a change to how
frontmatter actually lands on disk, or to a settings pane, needs `e2e/`.

## How the harness works

There is no `obsidian` module outside the app, so `tests/helpers/harness.cjs`
bundles the TypeScript with esbuild — already a devDependency, and configured to
match the real build (`format: "cjs"`, `platform: "node"`) — and substitutes a
minimal stand-in for `obsidian`. Nothing is generated on disk.

`createPluginHarness()` returns a plugin instance plus recorders for everything
the code under test reaches for:

| Field | What it holds |
| --- | --- |
| `plugin` | The plugin, constructed without `onload()` |
| `file` | The `TFile`-shaped note under test |
| `frontmatter` | The note's live frontmatter — mutated only if the code writes directly |
| `queued` | Every `queueFrontmatterUpdate()` call, in order |
| `processedQueue` | One entry per `processFrontmatterQueue()` call |
| `notices` | Every `new Notice(...)` message, in order |
| `logs` | Every `logger.log()` call, as argument arrays |
| `prompts` | Every suggester opened, as `{ promptText, items }` |
| `answerSuggester(...choices)` | Answer the next prompt(s); `null` means Escape |

An unanswered suggester throws instead of hanging, so an unexpected prompt fails
loudly rather than timing out.

Two things the harness deliberately mirrors rather than fixes:

- **Non-strict CJS.** `suggester()` in `src/suggester.ts` reads `this.app` from an
  unbound function call, which resolves to the global object at runtime. The
  harness sets `globalThis.app` so that keeps working. Change the bundle format
  and the plugin breaks in the app, not just here.
- **Hand-mirrored `DEFAULT_SETTINGS`.** It is not exported from `src/main.ts`, so
  `defaultSettings()` duplicates it — the same trade-off `e2e/lib/test-helpers.ts`
  makes with `buildDefaultSettings()`. Keep both in sync.

## The `*-baseline.test.cjs` files

These are **characterization tests**. Their expected values were recorded from the
implementation as it shipped, not derived from a specification, and that includes
behavior that looks wrong:

- `se-interval: 0` falls back to the default, because the code uses `||`.
- `se-interval: soon` produces `NaN` and writes it to the note.
- Review scores are not validated or clamped to 0–5.
- A cancelled review drops an `se-method` repair that was already queued.

Each of those is marked in a comment as recorded-not-endorsed. The point is to make
refactors checkable: if a change is meant to preserve behavior, every assertion
here must still pass untouched. If an assertion has to change, the change is a
behavior change — which may be the right call, but it should be a decision rather
than a side effect.

So: **do not "fix" a baseline expectation to make a build green.** Either the code
regressed, or the behavior change is intentional and the updated vector plus a note
about why is the record of it.

| File | Pins |
| --- | --- |
| `scheduling-baseline.test.cjs` | The SM-2 arithmetic: 96 golden vectors plus rounding order, the 1.3 ease floor, the 1-day interval floor, and out-of-range scores |
| `update-interval-baseline.test.cjs` | `updateInterval()`'s contract: where prior state is read, default resolution, queue-don't-write, the notice text, and log ordering |
| `review-flow-baseline.test.cjs` | `logReviewOutcome()`: the prompt, score mapping, Remove, cancel, onboarding, and whether the queue gets flushed |
