export type Severity = "critical" | "warning" | "suggestion"

export type ThreadStatus = "open" | "fixing" | "resolved" | "orphaned"

export interface ThreadMessage {
	role: "user" | "agent"
	text: string
	ts: number
}

export interface Thread {
	id: string
	path: string
	line: number
	side: "new" | "old"
	anchorText: string
	severity: Severity
	status: ThreadStatus
	messages: ThreadMessage[]
	createdAt: number
	updatedAt: number
}

export interface ReviewState {
	version: 1
	repo: string
	branch: string
	baseRef: string
	threads: Thread[]
}

export const SEVERITY_ORDER: Severity[] = ["critical", "warning", "suggestion"]

export const SEVERITY_LABEL: Record<Severity, string> = {
	critical: "CRITICAL",
	warning: "WARNING",
	suggestion: "SUGGESTION",
}

export function createState(repo: string, branch: string, baseRef: string): ReviewState {
	return { version: 1, repo, branch, baseRef, threads: [] }
}

function newId(): string {
	return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function addThread(
	state: ReviewState,
	input: {
		path: string
		line: number
		side: "new" | "old"
		anchorText: string
		severity: Severity
		text: string
	},
): Thread {
	const now = Date.now()
	const thread: Thread = {
		id: newId(),
		path: input.path,
		line: input.line,
		side: input.side,
		anchorText: input.anchorText,
		severity: input.severity,
		status: "open",
		messages: [{ role: "user", text: input.text, ts: now }],
		createdAt: now,
		updatedAt: now,
	}
	state.threads.push(thread)
	return thread
}

export function replyToThread(thread: Thread, role: ThreadMessage["role"], text: string): void {
	thread.messages.push({ role, text, ts: Date.now() })
	thread.updatedAt = Date.now()
	if (role === "user" && thread.status === "resolved") thread.status = "open"
}

export function setStatus(thread: Thread, status: ThreadStatus): void {
	thread.status = status
	thread.updatedAt = Date.now()
}

export function cycleSeverity(thread: Thread): void {
	const index = SEVERITY_ORDER.indexOf(thread.severity)
	thread.severity = SEVERITY_ORDER[(index + 1) % SEVERITY_ORDER.length]!
	thread.updatedAt = Date.now()
}

export function removeThread(state: ReviewState, id: string): void {
	const index = state.threads.findIndex((thread) => thread.id === id)
	if (index >= 0) state.threads.splice(index, 1)
}

export function threadsForFile(state: ReviewState, path: string): Thread[] {
	return state.threads.filter((thread) => thread.path === path)
}

export function threadsAtLine(
	state: ReviewState,
	path: string,
	line: number,
	side: "new" | "old",
): Thread[] {
	return state.threads.filter(
		(thread) => thread.path === path && thread.line === line && thread.side === side,
	)
}

export function openThreads(state: ReviewState): Thread[] {
	return state.threads.filter((thread) => thread.status === "open")
}

function formatThread(thread: Thread): string {
	const lines: string[] = []
	const location = `${thread.path}:${thread.line}`
	const firstIndex = thread.messages.findIndex((message) => message.role === "user")
	const first = firstIndex >= 0 ? thread.messages[firstIndex] : undefined
	lines.push(`**${SEVERITY_LABEL[thread.severity]}** \`${location}\``)
	if (thread.anchorText.trim()) {
		lines.push("")
		lines.push("```")
		lines.push(thread.anchorText)
		lines.push("```")
	}
	lines.push("")
	lines.push(first?.text ?? "")
	const rest = thread.messages.slice(firstIndex + 1)
	for (const message of rest) {
		lines.push("")
		lines.push(`> ${message.role === "user" ? "Reviewer" : "You"}: ${message.text.replace(/\n/g, "\n> ")}`)
	}
	return lines.join("\n")
}

export function buildFixPrompt(threads: Thread[], baseRef: string): string {
	const sorted = [...threads].sort((a, b) => {
		const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
		if (bySeverity !== 0) return bySeverity
		if (a.path !== b.path) return a.path.localeCompare(b.path)
		return a.line - b.line
	})

	const header =
		sorted.length === 1
			? "I left a review comment on the current branch. Address it."
			: `I left ${sorted.length} review comments on the current branch (diffed against \`${baseRef}\`). Address each one.`

	const body = sorted.map((thread, index) => `### ${index + 1}. ${formatThread(thread)}`).join("\n\n")

	const footer = [
		"",
		"Guidelines:",
		"- Fix each comment directly in the code; do not just describe the fix.",
		"- If a comment is wrong or you disagree, say so instead of making the change.",
		"- Keep changes scoped to the comment; do not refactor unrelated code.",
		"- When done, list each comment number with one line on what you changed.",
	].join("\n")

	return `${header}\n\n${body}\n${footer}`
}
