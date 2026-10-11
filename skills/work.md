# work
tags: focused execution single-pass

Complete the task directly in one focused pass. This mode optimizes for
getting the concrete work done without agent-style exploration or multi-phase
orchestration.

1. Do the task immediately with the smallest set of tool calls that suffices.
2. Prefer direct answers and direct edits over intermediate summaries.
3. Ask the user with `question` only when genuinely blocked; otherwise make
   the reasonable assumption and note it in one line.
4. Verify the result when a cheap check exists (build, test, open the file).
5. Report what changed in at most a few sentences.
