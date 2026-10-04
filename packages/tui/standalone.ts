import { TuiMainScreen } from "@earendil-works/pi-tui"
import type { LoadedReview } from "../core/review.ts"
import { saveState } from "../core/store.ts"
import type { Thread } from "../core/threads.ts"
import { ReviewComponent } from "./review-component.ts"
import { ansiTheme } from "./theme.ts"
import { TtyTerminal } from "./tty-terminal.ts"

export interface TuiResult {
	/** Threads picked with f/F, or empty when the user quit without sending. */
	threads: Thread[]
	deleted: Set<string>
}

/** Run the review UI full-screen on /dev/tty until the user sends or quits. */
export function runReviewTui(loaded: LoadedReview, options: { sendLabel?: string } = {}): Promise<TuiResult> {
	const terminal = new TtyTerminal()
	const tui = new TuiMainScreen(terminal)
	const deleted = new Set<string>()

	return new Promise((resolve) => {
		let finished = false
		const finish = (threads: Thread[]) => {
			if (finished) return
			finished = true
			tui.stop()
			terminal.close()
			resolve({ threads, deleted })
		}

		const component = new ReviewComponent({
			tui,
			theme: ansiTheme,
			files: loaded.files,
			state: loaded.state,
			sendLabel: options.sendLabel,
			chromeRows: 5,
			onChange: (deletedId) => {
				if (deletedId) deleted.add(deletedId)
				void saveState(loaded.file, loaded.state, deleted)
			},
			onFix: (threads) => finish(threads),
			onClose: () => finish([]),
		})

		tui.addChild(component)
		tui.setFocus(component)
		tui.start()
		tui.requestRender()
	})
}
