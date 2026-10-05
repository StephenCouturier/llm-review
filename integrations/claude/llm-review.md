---
description: Review your changes in llm-review, then have Claude address the comments
argument-hint: "[--branch] [--base <ref>]"
allowed-tools: Bash(llm-review popup:*), Bash(llm-review reply:*)
---
!`llm-review popup $ARGUMENTS`

The above is the output of a code review I just did on your changes in llm-review.

If it says the review was cancelled or could not open, tell me that in one line and stop.

Otherwise, work through every comment in it now. Follow the review's own instructions: fix the "Fix these" items, answer the "Answer these" items without editing files, and after handling each thread run the `llm-review reply` command it gives you with that thread's id.
