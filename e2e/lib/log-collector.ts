/**
 * Log Collector
 *
 * Captures console output and uncaught page errors from Obsidian via Playwright's
 * CDP connection, writing them to JSONL files plus a `latest-summary.json` that is
 * cheap to read after a run.
 *
 * Ported from the notor plugin's e2e setup with one change: notor's plugin emits
 * JSON lines behind a `[NOTOR_LOG]` prefix, and the collector parsed those into
 * structured entries. This plugin has no console logger and its source is not
 * instrumented, so structured parsing is opt-in via `structuredPrefix`. Without it
 * the collector still records:
 *
 *   - every console message (`getRawLogs()`, `getConsoleErrors()`)
 *   - every uncaught exception, as a structured entry with source `page-error`
 *     (`getPageErrors()`, `hasErrors()`)
 *
 * which is enough to assert "the plugin loaded without blowing up".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Page, ConsoleMessage } from "playwright-core";

export interface CollectorOptions {
	/** Directory to write log files into */
	outputDir: string;
	/** Also capture non-structured console output (default: true) */
	captureAll?: boolean;
	/** Maximum log entries before rotating (default: 10000) */
	maxEntries?: number;
	/**
	 * Prefix identifying structured JSON log lines emitted by the plugin,
	 * e.g. `"[SE_LOG]"`. Omit (the default) when the plugin has no console
	 * logger — console output is then only captured raw.
	 */
	structuredPrefix?: string;
}

export interface LogEntry {
	timestamp: string;
	level: string;
	source: string;
	message: string;
	data?: unknown;
}

export interface RawConsoleEntry {
	timestamp: string;
	type: string;
	text: string;
}

type ResolvedOptions = Required<Omit<CollectorOptions, "structuredPrefix">> & {
	structuredPrefix?: string;
};

export class LogCollector {
	private structuredLogs: LogEntry[] = [];
	private rawLogs: RawConsoleEntry[] = [];
	private structuredStream: fs.WriteStream;
	private rawStream: fs.WriteStream | null = null;
	private options: ResolvedOptions;
	private disposed = false;
	/** Pages already wired up, so `attach()` is safe to call repeatedly. */
	private attachedPages = new WeakSet<Page>();

	constructor(options: CollectorOptions) {
		this.options = {
			captureAll: true,
			maxEntries: 10_000,
			...options,
		};

		fs.mkdirSync(this.options.outputDir, { recursive: true });

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.structuredStream = fs.createWriteStream(
			path.join(this.options.outputDir, `plugin-logs-${timestamp}.jsonl`),
			{ flags: "a" },
		);

		if (this.options.captureAll) {
			this.rawStream = fs.createWriteStream(
				path.join(this.options.outputDir, `console-all-${timestamp}.jsonl`),
				{ flags: "a" },
			);
		}
	}

	/**
	 * Attach to a Playwright page and start collecting console output.
	 * Idempotent — attaching the same page twice will not double-record.
	 */
	attach(page: Page): void {
		if (this.attachedPages.has(page)) return;
		this.attachedPages.add(page);

		page.on("console", (msg: ConsoleMessage) => {
			this.handleConsoleMessage(msg);
		});

		page.on("pageerror", (error: Error) => {
			this.writeStructured({
				timestamp: new Date().toISOString(),
				level: "error",
				source: "page-error",
				message: error.message,
				data: { stack: error.stack },
			});
		});
	}

	private handleConsoleMessage(msg: ConsoleMessage): void {
		const text = msg.text();
		const msgType = msg.type();

		if (this.options.captureAll && this.rawStream) {
			const raw: RawConsoleEntry = {
				timestamp: new Date().toISOString(),
				type: msgType,
				text,
			};
			this.rawLogs.push(raw);
			this.rawStream.write(JSON.stringify(raw) + "\n");
		}

		const prefix = this.options.structuredPrefix;
		if (prefix && text.startsWith(prefix)) {
			try {
				const entry: LogEntry = JSON.parse(text.slice(prefix.length).trim());
				this.writeStructured(entry);
			} catch (err) {
				this.writeStructured({
					timestamp: new Date().toISOString(),
					level: "warn",
					source: "log-collector",
					message: "Failed to parse structured log entry",
					data: { rawText: text, error: String(err) },
				});
			}
		}
	}

	private writeStructured(entry: LogEntry): void {
		if (this.disposed) return;

		this.structuredLogs.push(entry);
		this.structuredStream.write(JSON.stringify(entry) + "\n");

		if (this.structuredLogs.length > this.options.maxEntries) {
			this.structuredLogs = this.structuredLogs.slice(
				-Math.floor(this.options.maxEntries / 2),
			);
		}
	}

	/** All structured entries (page errors, plus parsed plugin logs if enabled). */
	getStructuredLogs(): LogEntry[] {
		return [...this.structuredLogs];
	}

	getLogsByLevel(level: string): LogEntry[] {
		return this.structuredLogs.filter((e) => e.level === level);
	}

	getLogsBySource(source: string): LogEntry[] {
		return this.structuredLogs.filter((e) => e.source === source);
	}

	/** Uncaught exceptions thrown in the Obsidian renderer. */
	getPageErrors(): LogEntry[] {
		return this.getLogsBySource("page-error");
	}

	/** Every console message, in order. */
	getRawLogs(): RawConsoleEntry[] {
		return [...this.rawLogs];
	}

	/** Console messages logged at error level (includes Obsidian's own errors). */
	getConsoleErrors(): RawConsoleEntry[] {
		return this.rawLogs.filter((e) => e.type === "error");
	}

	hasErrors(): boolean {
		return this.structuredLogs.some((e) => e.level === "error");
	}

	/**
	 * Write `latest-summary.json` — stats plus recent errors, for a quick
	 * post-run read (by a human or an agent) without parsing the JSONL files.
	 */
	writeSummary(): string {
		const summaryPath = path.join(this.options.outputDir, "latest-summary.json");

		const errors = this.getLogsByLevel("error");
		const warnings = this.getLogsByLevel("warn");
		const consoleErrors = this.getConsoleErrors();

		const summary = {
			generatedAt: new Date().toISOString(),
			stats: {
				totalEntries: this.structuredLogs.length,
				errors: errors.length,
				warnings: warnings.length,
				pageErrors: this.getPageErrors().length,
				consoleMessages: this.rawLogs.length,
				consoleErrors: consoleErrors.length,
				sources: [...new Set(this.structuredLogs.map((e) => e.source))],
			},
			recentErrors: errors.slice(-20),
			recentWarnings: warnings.slice(-10),
			recentConsoleErrors: consoleErrors.slice(-20),
			lastEntries: this.structuredLogs.slice(-30),
		};

		fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
		return summaryPath;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;

		this.writeSummary();
		this.disposed = true;

		return new Promise((resolve) => {
			this.structuredStream.end(() => {
				if (this.rawStream) {
					this.rawStream.end(() => resolve());
				} else {
					resolve();
				}
			});
		});
	}
}
