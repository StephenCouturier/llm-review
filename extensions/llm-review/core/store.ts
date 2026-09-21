import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { FileDiff } from "./diff.ts"
import { findLineText } from "./diff.ts"
import type { ReviewState, Thread } from "./threads.ts"
import { createState } from "./threads.ts"

function slugify(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed"
}

export function statePath(baseDir: string, repoRoot: string, branch: string): string {
	return join(baseDir, "llm-review", slugify(repoRoot), `${slugify(branch)}.json`)
}

export async function loadState(
	file: string,
	repoRoot: string,
	branch: string,
	baseRef?: string,
): Promise<ReviewState> {
	try {
		const raw = await readFile(file, "utf-8")
		const parsed = JSON.parse(raw) as ReviewState
		if (parsed.version !== 1 || !Array.isArray(parsed.threads)) {
			return createState(repoRoot, branch, baseRef ?? "HEAD")
		}
		if (baseRef) parsed.baseRef = baseRef
		return parsed
	} catch {
		return createState(repoRoot, branch, baseRef ?? "HEAD")
	}
}

async function readThreadsOnDisk(file: string): Promise<Thread[]> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf-8")) as ReviewState
		return Array.isArray(parsed.threads) ? parsed.threads : []
	} catch {
		return []
	}
}

export async function saveState(
	file: string,
	state: ReviewState,
	deletedIds: Iterable<string> = [],
): Promise<void> {
	const deleted = new Set(deletedIds)
	const onDisk = await readThreadsOnDisk(file)
	const merged = new Map<string, Thread>()

	for (const thread of onDisk) {
		if (deleted.has(thread.id)) continue
		merged.set(thread.id, thread)
	}
	for (const thread of state.threads) {
		if (deleted.has(thread.id)) continue
		merged.set(thread.id, thread)
	}

	const threads = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
	state.threads = threads

	await mkdir(dirname(file), { recursive: true })
	const tmp = `${file}.${process.pid}.tmp`
	await writeFile(tmp, `${JSON.stringify({ ...state, threads }, null, 2)}\n`, "utf-8")
	await rename(tmp, file)
}

function reanchorThread(thread: Thread, file: FileDiff | undefined): void {
	if (!file) {
		if (thread.status !== "resolved") thread.status = "orphaned"
		return
	}

	const atSameLine = findLineText(file, thread.line, thread.side)
	if (atSameLine !== undefined && atSameLine === thread.anchorText) {
		if (thread.status === "orphaned") thread.status = "open"
		return
	}

	const candidates: number[] = []
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			const no = thread.side === "new" ? line.newNo : line.oldNo
			if (no !== null && line.text === thread.anchorText) candidates.push(no)
		}
	}

	if (candidates.length === 0) {
		if (thread.status !== "resolved") thread.status = "orphaned"
		return
	}

	let best = candidates[0]!
	for (const candidate of candidates) {
		if (Math.abs(candidate - thread.line) < Math.abs(best - thread.line)) best = candidate
	}
	thread.line = best
	if (thread.status === "orphaned") thread.status = "open"
}

export function reanchorThreads(state: ReviewState, files: Map<string, FileDiff>): void {
	for (const thread of state.threads) {
		reanchorThread(thread, files.get(thread.path))
	}
}
