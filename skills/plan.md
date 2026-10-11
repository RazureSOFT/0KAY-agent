# plan
tags: planning research analysis

Produce an implementation plan for the request. This is a PLANNING run:
research is read-only and the final deliverable is the plan itself, not code.

1. Investigate the current state: read the relevant files, configs and docs
   before proposing anything. Cite concrete file paths and line-level facts.
2. Restate the goal and its acceptance criteria in one paragraph.
3. Produce the plan using the standard plan structure (title, status,
   problem, approach, step-by-step changes with exact file paths, verification,
   risks and rollback). The executor may be a less capable model with zero
   context — every step must be self-contained and unambiguous.
4. Call out open questions and assumptions explicitly.
5. Do NOT implement, do not modify or create files. If tool use would mutate
   state, stop and describe the action in the plan instead.
