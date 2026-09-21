# llm-review

A [pi](https://pi.dev) extension for reviewing your branch's changes in a TUI and handing the comments to the agent to fix.

Run `/llm-review`, walk the diff, leave line-anchored comments, hit `F`. The agent gets your comments as a structured work list, fixes them in the same session with full context, and its reply is attached back onto each comment thread.

## Install

```sh
pi install git:github.com/StephenCouturier/llm-review
```

Or try it for a single run without installing:

```sh
pi -e git:github.com/StephenCouturier/llm-review
```

## Usage

```
/llm-review              review the branch against its auto-detected base
/llm-review --local      review only uncommitted changes (staged, unstaged, untracked)
/llm-review origin/dev   review against an explicit base ref
```

By default the diff covers everything on the branch: commits since the merge base, plus staged, unstaged, and untracked files. With `--local` (or `-l`) it covers only what you haven't committed yet, diffed against `HEAD`.

Comments live in the same per-branch file regardless of scope, so a comment left in `--local` is still there when you open the full branch review.

### Keys

| Key | Action |
| --- | --- |
| `j` / `k` / `↓` / `↑` | Move cursor |
| `n` / `p` | Next / previous hunk |
| `g` / `G` | Jump to top / bottom |
| `ctrl+d` / `ctrl+u` | Page down / up |
| `space` | Fold / unfold the current file |
| `c` | Comment on the current line |
| `r` | Reply to the comment thread under the cursor |
| `s` | Cycle severity (critical → warning → suggestion → question) |
| `x` | Toggle resolved |
| `d` | Delete the thread |
| `f` | Send the thread under the cursor to the agent |
| `F` | Send all open threads to the agent |
| `q` / `esc` | Close |

## Questions vs. fixes

Cycle a thread's severity to `question` with `s` and it becomes a question instead of a change request.

On dispatch the prompt is split into two sections: **Fix these** (change the code) and **Answer these** ("these are questions, not change requests — do NOT modify any files"). Question threads move `open → asking → answered`; fix threads move `open → fixing → resolved`.

The agent is asked to reply with one numbered section per comment, and each section is routed back to the thread it belongs to, so every comment gets its own answer rather than a copy of the whole response.

## How it works

Comments are threads, not one-shot notes. Each has a severity, a status (`open` → `fixing` → `resolved`), and a message list that both you and the agent append to.

When you dispatch, the extension builds a prompt in `CRITICAL` / `WARNING` / `SUGGESTION` form with `file.ts:42` anchors and the relevant source line quoted, then sends it into the current pi session with `sendUserMessage`. Because it's the same session, the agent already has the context of the code it just wrote.

The review UI closes while the agent works, so you can watch the transcript. Reopen with `/llm-review` to see the result: threads are re-anchored onto the new line numbers by matching their source line, and any thread whose anchor disappeared is flagged `moved` rather than silently dropped.

## State

Reviews persist per repo and branch at:

```
~/.pi/agent/llm-review/<repo>/<branch>.json
```

Nothing is written into the repository you're reviewing.

Saves merge against what is already on disk, keyed by thread id, so two pi sessions reviewing the same branch cannot clobber each other's comments. A thread is only removed when you explicitly delete it with `d`.

Set `LLM_REVIEW_DEBUG=1` to append render/geometry diagnostics to `/tmp/llm-review-debug.log` (override with `LLM_REVIEW_DEBUG_FILE`).

## Requirements

- pi >= 0.85
- git

## Known limitations

- Comments are single-line input; use `r` to add detail across multiple replies.
- No intra-line (word-level) diff highlighting, just line-level colors.
- Very large diffs are not capped and may be slow to open.
- Threads are re-anchored by matching their source line; if the agent rewrites a line beyond recognition the thread is flagged `moved` rather than relocated.

## License

MIT
