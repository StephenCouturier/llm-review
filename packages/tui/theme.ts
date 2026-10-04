/**
 * The slice of a theme the review UI needs. pi's Theme satisfies it structurally;
 * the standalone CLI uses the ANSI theme below.
 */
export type ThemeColor =
	| "accent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "toolTitle"
	| "mdLink"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"

export interface ReviewTheme {
	fg(color: ThemeColor, text: string): string
	bold(text: string): string
}

const ANSI: Record<ThemeColor, string> = {
	accent: "36",
	borderMuted: "90",
	success: "32",
	error: "31",
	warning: "33",
	muted: "37",
	dim: "90",
	text: "39",
	toolTitle: "97",
	mdLink: "35",
	toolDiffAdded: "32",
	toolDiffRemoved: "31",
	toolDiffContext: "39",
}

export const ansiTheme: ReviewTheme = {
	fg: (color, text) => `\x1b[${ANSI[color]}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
}
