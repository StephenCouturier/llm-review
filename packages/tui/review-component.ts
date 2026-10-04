import type { Component, Focusable, TUI } from "@earendil-works/pi-tui"
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import type { FileDiff } from "../core/diff.ts"
import { anchorLine } from "../core/diff.ts"
import type { ReviewState, Severity, Thread } from "../core/threads.ts"
import {
	addThread,
	cycleSeverity,
	isQuestion,
	openThreads,
	removeThread,
	replyToThread,
	SEVERITY_LABEL,
	setStatus,
	threadLocation,
} from "../core/threads.ts"
import type { ReviewTheme, ThemeColor } from "./theme.ts"
import type { Row } from "./rows.ts"
import { buildRows, isSelectable, nextHunk, nextSelectable } from "./rows.ts"
import { debugLog } from "./debug.ts"

export interface ReviewComponentOptions {
	tui: TUI
	theme: ReviewTheme
	files: FileDiff[]
	state: ReviewState
	onChange: (deletedId?: string) => void
	onFix: (threads: Thread[]) => void
	onClose: () => void
	/** Help-bar label for f/F, e.g. "send" inside an agent, "emit" for the standalone CLI. */
	sendLabel?: string
	/** Rows reserved for header/footer; the overlay inside pi needs more than a full-screen app. */
	chromeRows?: number
}

type Mode = "browse" | "compose"

const MIN_VIEWPORT = 8
const CHROME_ROWS = 10

export class ReviewComponent implements Component, Focusable {
	private isFocused = false

	get focused(): boolean {
		return this.isFocused
	}

	set focused(value: boolean) {
		this.isFocused = value
		if (this.input) this.input.focused = value
	}

	private readonly tui: TUI
	private readonly theme: ReviewTheme
	private files: FileDiff[]
	private readonly state: ReviewState
	private readonly onChange: (deletedId?: string) => void
	private readonly onFix: (threads: Thread[]) => void
	private readonly onClose: () => void
	private readonly sendLabel: string
	private readonly chromeRows: number

	private collapsed = new Set<string>()
	private rows: Row[] = []
	private cursor = 0
	private scrollTop = 0
	private mode: Mode = "browse"
	private input: Input | null = null
	private composeKind: "comment" | "reply" = "comment"
	private composeThread: Thread | null = null
	private notice = ""
	/** Row index where a range selection started (`v`), or null. */
	private mark: number | null = null

	constructor(options: ReviewComponentOptions) {
		this.tui = options.tui
		this.theme = options.theme
		this.files = options.files
		this.state = options.state
		this.onChange = options.onChange
		this.onFix = options.onFix
		this.onClose = options.onClose
		this.sendLabel = options.sendLabel ?? "send"
		this.chromeRows = options.chromeRows ?? CHROME_ROWS
		this.rebuild()
		this.cursor = isSelectable(this.rows[0] ?? { kind: "spacer" })
			? 0
			: nextSelectable(this.rows, 0, 1)
	}

	setFiles(files: FileDiff[]): void {
		this.files = files
		this.rebuild()
		this.clampCursor()
		this.tui.requestRender()
	}

	setNotice(text: string): void {
		this.notice = text
		this.tui.requestRender()
	}

	private rebuild(): void {
		this.rows = buildRows(this.files, this.state, this.collapsed)
	}

	private clampCursor(): void {
		if (this.cursor >= this.rows.length) this.cursor = Math.max(0, this.rows.length - 1)
		if (this.rows.length > 0 && !isSelectable(this.rows[this.cursor]!)) {
			const forward = nextSelectable(this.rows, this.cursor, 1)
			this.cursor = forward === this.cursor ? nextSelectable(this.rows, this.cursor, -1) : forward
		}
	}

	private viewportHeight(): number {
		const rows = this.tui.terminal.rows || 24
		return Math.max(MIN_VIEWPORT, rows - this.chromeRows)
	}

	private logGeometry(width: number, produced: number): void {
		debugLog("render", {
			mode: this.tui.mode,
			termRows: this.tui.terminal.rows,
			termCols: this.tui.terminal.columns,
			width,
			viewport: this.viewportHeight(),
			produced,
			rows: this.rows.length,
			cursor: this.cursor,
			scrollTop: this.scrollTop,
			modeUi: this.mode,
		})
	}

	private ensureVisible(): void {
		const height = this.viewportHeight()
		if (this.cursor < this.scrollTop) this.scrollTop = this.cursor
		if (this.cursor >= this.scrollTop + height) this.scrollTop = this.cursor - height + 1
		const maxTop = Math.max(0, this.rows.length - height)
		if (this.scrollTop > maxTop) this.scrollTop = maxTop
		if (this.scrollTop < 0) this.scrollTop = 0
	}

	private currentRow(): Row | undefined {
		return this.rows[this.cursor]
	}

	private currentFilePath(): string | undefined {
		const row = this.currentRow()
		if (!row || row.kind === "spacer") return undefined
		return row.path
	}

	private currentThread(): Thread | undefined {
		const row = this.currentRow()
		return row?.kind === "thread" ? row.thread : undefined
	}

	private severityColor(severity: Severity): ThemeColor {
		if (severity === "critical") return "error"
		if (severity === "warning") return "warning"
		if (severity === "question") return "mdLink"
		return "accent"
	}

	private statusBadge(thread: Thread): string {
		const map: Record<Thread["status"], [string, ThemeColor]> = {
			open: ["open", "warning"],
			fixing: ["fixing", "accent"],
			resolved: ["done", "success"],
			orphaned: ["moved", "error"],
			asking: ["asking", "accent"],
			answered: ["answered", "success"],
			wontfix: ["won't fix", "muted"],
			needs_info: ["needs info", "warning"],
			needs_review: ["check", "warning"],
		}
		const [label, color] = map[thread.status] ?? ["open", "warning"]
		return this.theme.fg(color, label)
	}

	private startCompose(kind: "comment" | "reply", thread: Thread | null): void {
		this.composeKind = kind
		this.composeThread = thread
		this.mode = "compose"
		const input = new Input({
			prompt: kind === "comment" ? "comment> " : "reply> ",
			placeholder: kind === "comment" ? "what should the agent fix here?" : "add to the thread",
		})
		input.focused = this.isFocused
		input.onSubmit = (value) => this.submitCompose(value)
		input.onEscape = () => this.cancelCompose()
		this.input = input
		this.tui.requestRender()
	}

	private cancelCompose(): void {
		this.mode = "browse"
		this.input = null
		this.tui.requestRender()
	}

	private submitCompose(value: string): void {
		const text = value.trim()
		if (!text) {
			this.cancelCompose()
			return
		}

		if (this.composeKind === "reply" && this.composeThread) {
			replyToThread(this.composeThread, "user", text)
		} else {
			const row = this.currentRow()
			const range = this.selectedRange()
			if (range) {
				addThread(this.state, { ...range, severity: "warning", text })
			} else if (row?.kind === "line") {
				const anchor = anchorLine(row.line)
				addThread(this.state, {
					path: row.path,
					line: anchor.line,
					side: anchor.side,
					anchorText: row.line.text,
					severity: "warning",
					text,
				})
			} else if (row?.kind === "file") {
				addThread(this.state, {
					path: row.path,
					line: 0,
					side: "new",
					anchorText: "",
					severity: "warning",
					text,
				})
			}
		}

		this.mode = "browse"
		this.input = null
		this.mark = null
		this.rebuild()
		this.clampCursor()
		this.onChange()
		this.tui.requestRender()
	}

	/** Line rows between the mark and the cursor (inclusive), in display order. */
	private markedRows(): Extract<Row, { kind: "line" }>[] {
		if (this.mark === null) return []
		const from = Math.min(this.mark, this.cursor)
		const to = Math.max(this.mark, this.cursor)
		return this.rows
			.slice(from, to + 1)
			.filter((row): row is Extract<Row, { kind: "line" }> => row.kind === "line")
	}

	/**
	 * The range selection as a thread anchor. Ranges are numbered on the new side when
	 * any selected line exists there; removed lines inside such a range are just context.
	 */
	private selectedRange():
		| { path: string; line: number; endLine: number; side: "new" | "old"; anchorText: string }
		| undefined {
		const rows = this.markedRows()
		if (rows.length < 2) return undefined
		const path = rows[0]!.path
		if (rows.some((row) => row.path !== path)) return undefined
		const onNew = rows.filter((row) => row.line.newNo !== null)
		const side: "new" | "old" = onNew.length > 0 ? "new" : "old"
		const anchored = side === "new" ? onNew : rows
		const numberOf = (row: Extract<Row, { kind: "line" }>) =>
			(side === "new" ? row.line.newNo : row.line.oldNo) ?? 0
		const first = anchored[0]!
		return {
			path,
			line: numberOf(first),
			endLine: numberOf(anchored[anchored.length - 1]!),
			side,
			anchorText: first.line.text,
		}
	}

	handleInput(data: string): void {
		if (this.mode === "compose") {
			this.input?.handleInput(data)
			this.tui.requestRender()
			return
		}

		this.notice = ""

		if (matchesKey(data, Key.escape) && this.mark !== null) {
			this.mark = null
			this.tui.requestRender()
			return
		}

		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.onClose()
			return
		}

		if (matchesKey(data, Key.down) || data === "j") {
			this.cursor = nextSelectable(this.rows, this.cursor, 1)
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.cursor = nextSelectable(this.rows, this.cursor, -1)
		} else if (data === "n") {
			this.cursor = nextHunk(this.rows, this.cursor, 1)
		} else if (data === "p") {
			this.cursor = nextHunk(this.rows, this.cursor, -1)
		} else if (data === "g") {
			this.cursor = isSelectable(this.rows[0] ?? { kind: "spacer" })
				? 0
				: nextSelectable(this.rows, 0, 1)
		} else if (data === "G") {
			this.cursor = nextSelectable(this.rows, this.rows.length, -1)
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			for (let i = 0; i < this.viewportHeight(); i++) {
				this.cursor = nextSelectable(this.rows, this.cursor, 1)
			}
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			for (let i = 0; i < this.viewportHeight(); i++) {
				this.cursor = nextSelectable(this.rows, this.cursor, -1)
			}
		} else if (matchesKey(data, Key.space)) {
			const path = this.currentFilePath()
			if (path) {
				if (this.collapsed.has(path)) this.collapsed.delete(path)
				else this.collapsed.add(path)
				this.mark = null
				this.rebuild()
				this.clampCursor()
			}
		} else if (data === "v") {
			const row = this.currentRow()
			if (this.mark !== null) this.mark = null
			else if (row?.kind === "line") this.mark = this.cursor
			else this.notice = "start a range on a diff line"
		} else if (data === "c") {
			const row = this.currentRow()
			if (this.mark !== null) {
				const rows = this.markedRows()
				if (rows.length > 0 && rows.some((entry) => entry.path !== rows[0]!.path)) {
					this.notice = "a range must stay within one file"
				} else if (rows.length > 0) {
					this.startCompose("comment", null)
				}
			} else if (row?.kind === "line" || row?.kind === "file") this.startCompose("comment", null)
			else if (row?.kind === "thread") this.startCompose("reply", row.thread)
		} else if (data === "r") {
			const thread = this.currentThread()
			if (thread) this.startCompose("reply", thread)
		} else if (data === "s") {
			const thread = this.currentThread()
			if (thread) {
				cycleSeverity(thread)
				this.onChange()
			}
		} else if (data === "x") {
			const thread = this.currentThread()
			if (thread) {
				setStatus(thread, thread.status === "resolved" ? "open" : "resolved")
				this.onChange()
			}
		} else if (data === "d") {
			const thread = this.currentThread()
			if (thread) {
				removeThread(this.state, thread.id)
				this.mark = null
				this.rebuild()
				this.clampCursor()
				this.onChange(thread.id)
			}
		} else if (data === "f") {
			const thread = this.currentThread()
			if (thread) this.onFix([thread])
			else this.notice = "no comment under cursor"
		} else if (data === "F") {
			const threads = openThreads(this.state)
			if (threads.length === 0) this.notice = "no open comments"
			else this.onFix(threads)
		}

		this.ensureVisible()
		this.tui.requestRender()
	}

	private inMarkedRange(index: number): boolean {
		if (this.mark === null) return false
		return index >= Math.min(this.mark, this.cursor) && index <= Math.max(this.mark, this.cursor)
	}

	private renderRow(row: Row, width: number, selected: boolean, marked = false): string[] {
		const theme = this.theme
		const marker = selected ? theme.fg("accent", "▌") : marked ? theme.fg("warning", "┃") : " "

		if (row.kind === "spacer") return [""]

		if (row.kind === "file") {
			const arrow = this.collapsed.has(row.path) ? "▸" : "▾"
			const stats = `${theme.fg("toolDiffAdded", `+${row.added}`)} ${theme.fg("toolDiffRemoved", `-${row.removed}`)}`
			const comments = row.threads > 0 ? theme.fg("warning", ` ${row.threads}◆`) : ""
			const label = theme.bold(theme.fg("toolTitle", row.path))
			return [truncateToWidth(`${marker}${arrow} ${label} ${stats}${comments}`, width)]
		}

		if (row.kind === "hunk") {
			return [truncateToWidth(`${marker}  ${theme.fg("dim", row.header)}`, width)]
		}

		if (row.kind === "line") {
			const line = row.line
			const no = line.origin === "del" ? line.oldNo : line.newNo
			const gutter = theme.fg("dim", String(no ?? "").padStart(5))
			const sign = line.origin === "add" ? "+" : line.origin === "del" ? "-" : " "
			const color =
				line.origin === "add"
					? "toolDiffAdded"
					: line.origin === "del"
						? "toolDiffRemoved"
						: "toolDiffContext"
			const body = theme.fg(color, `${sign} ${line.text.replace(/\t/g, "  ")}`)
			return [truncateToWidth(`${marker}${gutter} ${body}`, width)]
		}

		const thread = row.thread
		const message = thread.messages[row.messageIndex]!
		const isFirst = row.messageIndex === 0
		const bar = theme.fg(this.severityColor(thread.severity), "┃")
		const prefix = `${marker}      ${bar} `
		const available = Math.max(10, width - visibleWidth(prefix))

		const head = isFirst
			? `${theme.fg(this.severityColor(thread.severity), SEVERITY_LABEL[thread.severity])} ${this.statusBadge(thread)} ${theme.fg("dim", threadLocation(thread))}`
			: theme.fg("dim", message.role === "user" ? "reviewer" : "agent")

		const lines = [truncateToWidth(`${prefix}${head}`, width)]
		const text = message.text.split("\n")
		for (const part of text) {
			lines.push(
				truncateToWidth(
					`${prefix}${theme.fg(message.role === "agent" ? "muted" : "text", part)}`,
					width,
				),
			)
		}
		return lines
	}

	render(width: number): string[] {
		this.ensureVisible()
		const theme = this.theme
		const lines: string[] = []

		const counts = this.state.threads.reduce(
			(acc, thread) => {
				acc[thread.status] = (acc[thread.status] ?? 0) + 1
				return acc
			},
			{} as Record<string, number>,
		)
		const questions = this.state.threads.filter(isQuestion).length

		const title = theme.bold(theme.fg("accent", " llm-review "))
		const done = (counts.resolved ?? 0) + (counts.answered ?? 0)
		const summary = theme.fg(
			"muted",
			`${this.state.branch} ← ${this.state.baseRef} · ${this.files.length} files · ${counts.open ?? 0} open · ${questions} question(s) · ${done} done`,
		)
		lines.push(truncateToWidth(`${title}${summary}`, width))
		lines.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))))

		const height = this.viewportHeight()
		let rendered = 0
		let index = this.scrollTop
		while (rendered < height && index < this.rows.length) {
			const row = this.rows[index]!
			const rowLines = this.renderRow(row, width, index === this.cursor, this.inMarkedRange(index))
			for (const line of rowLines) {
				if (rendered >= height) break
				lines.push(line)
				rendered++
			}
			index++
		}
		while (rendered < height) {
			lines.push("")
			rendered++
		}

		lines.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))))

		if (this.mode === "compose" && this.input) {
			for (const line of this.input.render(width)) lines.push(line)
			lines.push(truncateToWidth(theme.fg("dim", " enter submit · esc cancel"), width))
			this.logGeometry(width, lines.length)
			return lines
		}

		const help =
			this.mark !== null
				? ` range: move to extend · c comment on ${this.markedRows().length} line(s) · v/esc cancel`
				: ` j/k move · n/p hunk · space fold · v range · c comment · r reply · s sev/question · x done · d del · f ${this.sendLabel} · F ${this.sendLabel} all · q quit`
		lines.push(truncateToWidth(theme.fg("dim", help), width))
		if (this.notice) lines.push(truncateToWidth(theme.fg("warning", ` ${this.notice}`), width))
		this.logGeometry(width, lines.length)
		return lines
	}

	invalidate(): void {}
}
