import { appendFileSync } from "node:fs"

const ENABLED = process.env.LLM_REVIEW_DEBUG === "1"
const LOG_FILE = process.env.LLM_REVIEW_DEBUG_FILE ?? "/tmp/llm-review-debug.log"

export function debugLog(event: string, data: Record<string, unknown>): void {
	if (!ENABLED) return
	try {
		appendFileSync(LOG_FILE, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`)
	} catch {
		return
	}
}
