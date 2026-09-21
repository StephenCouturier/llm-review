import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent"
import type { FileDiff } from "./core/diff.ts"
import { parseUnifiedDiff } from "./core/diff.ts"
import type { Exec, ReviewScope } from "./core/git.ts"
import { getFileDiff, getRepoBasics, getRepoInfo, listChangedFiles } from "./core/git.ts"
import { loadState, reanchorThreads, saveState, statePath } from "./core/store.ts"
import type { ReviewState, Thread } from "./core/threads.ts"
import {
	buildDispatchPrompt,
	dispatchStatus,
	isQuestion,
	parseAgentSections,
	settledStatus,
	setStatus,
} from "./core/threads.ts"
import { debugLog } from "./ui/debug.ts"
import { ReviewComponent } from "./ui/review-component.ts"

interface LoadedReview {
	state: ReviewState
	files: FileDiff[]
	file: string
}

interface ParsedArgs {
	scope: ReviewScope
	baseOverride?: string
}

function parseArgs(raw: string): ParsedArgs {
	const tokens = raw.trim().split(/\s+/).filter(Boolean)
	let scope: ReviewScope = "branch"
	let baseOverride: string | undefined

	for (const token of tokens) {
		if (token === "--local" || token === "-l") scope = "local"
		else if (token === "--branch" || token === "-b") scope = "branch"
		else if (!token.startsWith("-")) baseOverride = token
	}

	if (baseOverride) scope = "branch"
	return { scope, baseOverride }
}

export default function (pi: ExtensionAPI) {
	let pendingFix: string[] = []
	let invocation = 0

	const makeExec =
		(cwd: string, signal?: AbortSignal): Exec =>
		async (command, args) => {
			const result = await pi.exec(command, args, { cwd, signal, timeout: 30_000 })
			return { stdout: result.stdout, stderr: result.stderr, code: result.code }
		}

	async function load(
		ctx: ExtensionContext,
		args: ParsedArgs,
		signal?: AbortSignal,
	): Promise<LoadedReview> {
		const exec = makeExec(ctx.cwd, signal)
		const repo = await getRepoInfo(exec, { scope: args.scope, baseOverride: args.baseOverride })
		const changed = await listChangedFiles(exec, repo.diffBase)

		const files: FileDiff[] = []
		for (const entry of changed) {
			const raw = await getFileDiff(exec, repo.diffBase, entry)
			const parsed = parseUnifiedDiff(raw, entry.path, entry.oldPath)
			files.push(parsed)
		}

		const label = repo.scope === "local" ? "HEAD (local changes)" : repo.baseRef
		const file = statePath(getAgentDir(), repo.root, repo.branch)
		const state = await loadState(file, repo.root, repo.branch, label)
		state.repo = repo.root
		state.branch = repo.branch

		const byPath = new Map(files.map((entry) => [entry.path, entry]))
		reanchorThreads(state, byPath)
		await saveState(file, state)

		return { state, files, file }
	}

	function lastAssistantText(ctx: ExtensionContext): string | undefined {
		const branch = ctx.sessionManager.getBranch()
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]
			if (entry?.type !== "message") continue
			const message = entry.message as { role?: string; content?: unknown }
			if (message.role !== "assistant") continue
			const content = message.content
			if (typeof content === "string") return content
			if (Array.isArray(content)) {
				const text = content
					.filter(
						(part): part is { type: "text"; text: string } =>
							typeof part === "object" && part !== null && (part as { type?: string }).type === "text",
					)
					.map((part) => part.text)
					.join("\n")
					.trim()
				if (text) return text
			}
		}
		return undefined
	}

	pi.registerCommand("llm-review", {
		description: "Review branch changes and send comments to the agent (--local for uncommitted only)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "--local", label: "--local", description: "Only uncommitted changes (vs HEAD)" },
				{ value: "--branch", label: "--branch", description: "Whole branch vs its base (default)" },
			]
			const filtered = items.filter((item) => item.value.startsWith(prefix))
			return filtered.length > 0 ? filtered : null
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/llm-review requires the interactive TUI", "warning")
				return
			}

			const parsed = parseArgs(args)

			const loaded = await ctx.ui.custom<LoadedReview | Error | null>(
				(tui, theme, _keybindings, done) => {
					const message =
						parsed.scope === "local" ? "Loading local changes..." : "Loading branch diff..."
					const loader = new BorderedLoader(tui, theme, message)
					loader.onAbort = () => done(null)
					load(ctx, parsed, loader.signal)
						.then((result) => done(result))
						.catch((error) => done(error instanceof Error ? error : new Error(String(error))))
					return loader
				},
			)

			if (loaded === null) return
			if (loaded instanceof Error) {
				ctx.ui.notify(`llm-review: ${loaded.message}`, "error")
				return
			}
			if (loaded.files.length === 0) {
				ctx.ui.notify(
					parsed.scope === "local"
						? "No uncommitted changes"
						: `No changes against ${loaded.state.baseRef}`,
					"info",
				)
				return
			}

			const dispatch: { threads: Thread[] } = { threads: [] }
			const deleted = new Set<string>()

			invocation++
			debugLog("open", {
				invocation,
				files: loaded.files.length,
				threads: loaded.state.threads.length,
				stdoutRows: process.stdout.rows,
				stdoutCols: process.stdout.columns,
			})

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new ReviewComponent({
						tui,
						theme,
						files: loaded.files,
						state: loaded.state,
						onChange: (deletedId) => {
							if (deletedId) deleted.add(deletedId)
							void saveState(loaded.file, loaded.state, deleted)
						},
						onFix: (threads) => {
							dispatch.threads = threads
							done()
						},
						onClose: () => done(),
					}),
				{
					overlay: true,
					overlayOptions: { width: "96%", maxHeight: "94%", anchor: "center" },
					onHandle: (handle) => {
						debugLog("handle", { invocation, bounds: (handle as { bounds?: unknown }).bounds })
					},
				},
			)

			debugLog("closed", { invocation, dispatched: dispatch.threads.length })

			if (dispatch.threads.length === 0) return

			for (const thread of dispatch.threads) setStatus(thread, dispatchStatus(thread))
			await saveState(loaded.file, loaded.state, deleted)

			const prompt = buildDispatchPrompt(dispatch.threads, loaded.state.baseRef)
			pendingFix = prompt.order

			const questions = dispatch.threads.filter(isQuestion).length
			pi.appendEntry("llm-review-dispatch", {
				count: dispatch.threads.length,
				questions,
				fixes: dispatch.threads.length - questions,
				threads: dispatch.threads.map((thread) => ({
					id: thread.id,
					path: thread.path,
					line: thread.line,
					severity: thread.severity,
				})),
			})

			pi.sendUserMessage(prompt.text, ctx.isIdle() ? undefined : { deliverAs: "followUp" })
		},
	})

	pi.on("agent_settled", async (_event, ctx) => {
		if (pendingFix.length === 0) return
		const ids = pendingFix
		pendingFix = []

		try {
			const exec = makeExec(ctx.cwd)
			const repo = await getRepoBasics(exec)
			const file = statePath(getAgentDir(), repo.root, repo.branch)
			const state = await loadState(file, repo.root, repo.branch)

			const summary = lastAssistantText(ctx)
			const sections = summary ? parseAgentSections(summary) : new Map<number, string>()

			for (const thread of state.threads) {
				const position = ids.indexOf(thread.id)
				if (position < 0) continue
				const reply = sections.get(position + 1) ?? (sections.size > 0 ? undefined : summary)
				if (reply) thread.messages.push({ role: "agent", text: reply, ts: Date.now() })
				setStatus(thread, settledStatus(thread))
			}

			await saveState(file, state)
			const matched = sections.size > 0 ? ` (${sections.size} section(s) routed)` : ""
			ctx.ui.notify(`llm-review: ${ids.length} comment(s) settled${matched}`, "info")
		} catch {
			return
		}
	})
}
