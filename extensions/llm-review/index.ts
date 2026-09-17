import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent"
import type { FileDiff } from "./core/diff.ts"
import { parseUnifiedDiff } from "./core/diff.ts"
import type { Exec } from "./core/git.ts"
import { getFileDiff, getRepoInfo, listChangedFiles } from "./core/git.ts"
import { loadState, reanchorThreads, saveState, statePath } from "./core/store.ts"
import type { ReviewState, Thread } from "./core/threads.ts"
import { buildFixPrompt, setStatus } from "./core/threads.ts"
import { ReviewComponent } from "./ui/review-component.ts"

interface LoadedReview {
	state: ReviewState
	files: FileDiff[]
	file: string
}

export default function (pi: ExtensionAPI) {
	let pendingFix: string[] = []

	const makeExec =
		(cwd: string, signal?: AbortSignal): Exec =>
		async (command, args) => {
			const result = await pi.exec(command, args, { cwd, signal, timeout: 30_000 })
			return { stdout: result.stdout, stderr: result.stderr, code: result.code }
		}

	async function load(
		ctx: ExtensionContext,
		baseOverride: string | undefined,
		signal?: AbortSignal,
	): Promise<LoadedReview> {
		const exec = makeExec(ctx.cwd, signal)
		const repo = await getRepoInfo(exec, baseOverride)
		const changed = await listChangedFiles(exec, repo.mergeBase)

		const files: FileDiff[] = []
		for (const entry of changed) {
			const raw = await getFileDiff(exec, repo.mergeBase, entry)
			const parsed = parseUnifiedDiff(raw, entry.path, entry.oldPath)
			files.push(parsed)
		}

		const file = statePath(getAgentDir(), repo.root, repo.branch)
		const state = await loadState(file, repo.root, repo.branch, repo.baseRef)
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
		description: "Review branch changes and send comments to the agent",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/llm-review requires the interactive TUI", "warning")
				return
			}

			const baseOverride = args.trim() || undefined

			const loaded = await ctx.ui.custom<LoadedReview | Error | null>(
				(tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(tui, theme, "Loading branch diff...")
					loader.onAbort = () => done(null)
					load(ctx, baseOverride, loader.signal)
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
				ctx.ui.notify(`No changes against ${loaded.state.baseRef}`, "info")
				return
			}

			const dispatch: { threads: Thread[] } = { threads: [] }

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new ReviewComponent({
						tui,
						theme,
						files: loaded.files,
						state: loaded.state,
						onChange: () => {
							void saveState(loaded.file, loaded.state)
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
				},
			)

			if (dispatch.threads.length === 0) return

			for (const thread of dispatch.threads) setStatus(thread, "fixing")
			await saveState(loaded.file, loaded.state)

			pendingFix = dispatch.threads.map((thread) => thread.id)
			const prompt = buildFixPrompt(dispatch.threads, loaded.state.baseRef)

			pi.appendEntry("llm-review-dispatch", {
				count: dispatch.threads.length,
				threads: dispatch.threads.map((thread) => ({
					id: thread.id,
					path: thread.path,
					line: thread.line,
					severity: thread.severity,
				})),
			})

			pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" })
		},
	})

	pi.on("agent_settled", async (_event, ctx) => {
		if (pendingFix.length === 0) return
		const ids = pendingFix
		pendingFix = []

		try {
			const exec = makeExec(ctx.cwd)
			const repo = await getRepoInfo(exec)
			const file = statePath(getAgentDir(), repo.root, repo.branch)
			const state = await loadState(file, repo.root, repo.branch, repo.baseRef)

			const summary = lastAssistantText(ctx)
			for (const thread of state.threads) {
				if (!ids.includes(thread.id)) continue
				if (summary) thread.messages.push({ role: "agent", text: summary, ts: Date.now() })
				setStatus(thread, "resolved")
			}

			await saveState(file, state)
			ctx.ui.notify(`llm-review: ${ids.length} comment(s) marked resolved`, "info")
		} catch {
			return
		}
	})
}
