export type Severity = "critical" | "warning" | "suggestion" | "question"

export type ThreadKind = "fix" | "question"

export type ThreadStatus =
	| "open"
	| "fixing"
	| "resolved"
	| "orphaned"
	| "asking"
	| "answered"

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
	kind: ThreadKind
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

export const SEVERITY_ORDER: Severity[] = ["critical", "warning", "suggestion", "question"]

export const SEVERITY_LABEL: Record<Severity, string> = {
	critical: "CRITICAL",
	warning: "WARNING",
	suggestion: "SUGGESTION",
	question: "QUESTION",
}

export function kindForSeverity(severity: Severity): ThreadKind {
	return severity === "question" ? "question" : "fix"
}

export function isQuestion(thread: Thread): boolean {
	return (thread.kind ?? kindForSeverity(thread.severity)) === "question"
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
		kind: kindForSeverity(input.severity),
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
	if (role === "user" && (thread.status === "resolved" || thread.status === "answered")) {
		thread.status = "open"
	}
}

export function setStatus(thread: Thread, status: ThreadStatus): void {
	thread.status = status
	thread.updatedAt = Date.now()
}

export function cycleSeverity(thread: Thread): void {
	const index = SEVERITY_ORDER.indexOf(thread.severity)
	thread.severity = SEVERITY_ORDER[(index + 1) % SEVERITY_ORDER.length]!
	thread.kind = kindForSeverity(thread.severity)
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

export function dispatchStatus(thread: Thread): ThreadStatus {
	return isQuestion(thread) ? "asking" : "fixing"
}

export function settledStatus(thread: Thread): ThreadStatus {
	return isQuestion(thread) ? "answered" : "resolved"
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

function sortThreads(threads: Thread[]): Thread[] {
	return [...threads].sort((a, b) => {
		const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
		if (bySeverity !== 0) return bySeverity
		if (a.path !== b.path) return a.path.localeCompare(b.path)
		return a.line - b.line
	})
}

export interface DispatchPrompt {
	text: string
	order: string[]
}

export function buildDispatchPrompt(threads: Thread[], baseRef: string): DispatchPrompt {
	const fixes = sortThreads(threads.filter((thread) => !isQuestion(thread)))
	const questions = sortThreads(threads.filter((thread) => isQuestion(thread)))
	const order = [...fixes, ...questions]

	const total = order.length
	const header = `I reviewed the current branch (diffed against \`${baseRef}\`) and left ${total} comment${total === 1 ? "" : "s"}.`

	const sections: string[] = []
	let counter = 0

	if (fixes.length > 0) {
		const body = fixes
			.map((thread) => {
				counter++
				return `### ${counter}. ${formatThread(thread)}`
			})
			.join("\n\n")
		sections.push(`## Fix these\n\nChange the code to address each item below.\n\n${body}`)
	}

	if (questions.length > 0) {
		const body = questions
			.map((thread) => {
				counter++
				return `### ${counter}. ${formatThread(thread)}`
			})
			.join("\n\n")
		sections.push(
			`## Answer these\n\nThese are questions, not change requests. Do NOT modify any files for them. Investigate and answer.\n\n${body}`,
		)
	}

	const footer = [
		"## How to respond",
		"",
		"Reply with one section per comment, numbered exactly as above:",
		"",
		"```",
		"### 1. <what you changed, or your answer>",
		"### 2. ...",
		"```",
		"",
		"Guidelines:",
		"- Fix items: change the code directly, do not just describe the fix.",
		"- Question items: answer only. Do not edit files to answer a question.",
		"- If a comment is wrong or you disagree, say so instead of making the change.",
		"- Keep changes scoped to the comment; do not refactor unrelated code.",
	].join("\n")

	return {
		text: `${header}\n\n${sections.join("\n\n")}\n\n${footer}`,
		order: order.map((thread) => thread.id),
	}
}

export function parseAgentSections(reply: string): Map<number, string> {
	const sections = new Map<number, string>()
	const pattern = /^#{1,4}\s*(\d+)[.):]?\s*(.*)$/gm
	const matches = [...reply.matchAll(pattern)]

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index]!
		const number = Number.parseInt(match[1]!, 10)
		const start = (match.index ?? 0) + match[0].length
		const end = index + 1 < matches.length ? (matches[index + 1]!.index ?? reply.length) : reply.length
		const inline = (match[2] ?? "").trim()
		const body = reply.slice(start, end).trim()
		const text = [inline, body].filter(Boolean).join("\n").trim()
		if (text) sections.set(number, text)
	}

	return sections
}
