import type { DiffLine, FileDiff } from "../core/diff.ts"
import { anchorLine, countChanges } from "../core/diff.ts"
import type { ReviewState, Thread } from "../core/threads.ts"
import { threadsAtLine, threadsForFile } from "../core/threads.ts"

export type Row =
	| { kind: "file"; path: string; file: FileDiff; added: number; removed: number; threads: number }
	| { kind: "hunk"; path: string; header: string }
	| { kind: "line"; path: string; line: DiffLine }
	| { kind: "thread"; path: string; thread: Thread; messageIndex: number }
	| { kind: "spacer" }

export function buildRows(
	files: FileDiff[],
	state: ReviewState,
	collapsed: Set<string>,
): Row[] {
	const rows: Row[] = []

	for (const file of files) {
		const { added, removed } = countChanges(file)
		rows.push({
			kind: "file",
			path: file.path,
			file,
			added,
			removed,
			threads: threadsForFile(state, file.path).length,
		})

		if (collapsed.has(file.path)) {
			rows.push({ kind: "spacer" })
			continue
		}

		if (file.binary) {
			rows.push({ kind: "hunk", path: file.path, header: "binary file not shown" })
			rows.push({ kind: "spacer" })
			continue
		}

		for (const hunk of file.hunks) {
			rows.push({ kind: "hunk", path: file.path, header: hunk.header })
			for (const line of hunk.lines) {
				rows.push({ kind: "line", path: file.path, line })
				const anchor = anchorLine(line)
				const inline = threadsAtLine(state, file.path, anchor.line, anchor.side).filter(
					(thread) => thread.status !== "orphaned",
				)
				for (const thread of inline) {
					for (let index = 0; index < thread.messages.length; index++) {
						rows.push({ kind: "thread", path: file.path, thread, messageIndex: index })
					}
				}
			}
		}

		for (const thread of threadsForFile(state, file.path)) {
			if (thread.status !== "orphaned") continue
			for (let index = 0; index < thread.messages.length; index++) {
				rows.push({ kind: "thread", path: file.path, thread, messageIndex: index })
			}
		}

		rows.push({ kind: "spacer" })
	}

	return rows
}

export function isSelectable(row: Row): boolean {
	return row.kind === "file" || row.kind === "line" || row.kind === "thread"
}

export function nextSelectable(rows: Row[], from: number, direction: 1 | -1): number {
	let index = from + direction
	while (index >= 0 && index < rows.length) {
		if (isSelectable(rows[index]!)) return index
		index += direction
	}
	return from
}

export function nextHunk(rows: Row[], from: number, direction: 1 | -1): number {
	let index = from + direction
	while (index >= 0 && index < rows.length) {
		const row = rows[index]!
		if (row.kind === "hunk" || row.kind === "file") {
			return nextSelectable(rows, index, 1)
		}
		index += direction
	}
	return from
}
