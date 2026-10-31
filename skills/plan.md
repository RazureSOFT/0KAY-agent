# plan
tags: planning research analysis

Produce an implementation plan for the request. This is a PLANNING run:
research is read-only and the final deliverable is the plan itself, not code.

1. Investigate the current state: read the relevant files, configs and docs
   before proposing anything. Cite concrete file paths and line-level facts.
2. Restate the goal and its acceptance criteria in one paragraph.
3. Produce the plan using the standard plan structure. A plan that will be
   executed by something with no conversation context has to cover all of:
   - **Problem / current state** — what is wrong or missing, with file paths.
   - **Scope and non-goals** — what this change will not touch, so the executor
     does not wander.
   - **Data model and interfaces** — shapes, fields, defaults, compatibility with
     data already on disk.
   - **Steps** — numbered, each with exact paths, what to change, and why. One
     concern per step.
   - **Migration and rollback** — what happens to existing data and config, and
     how to undo the change.
   - **Verification** — the exact commands to run and what passing looks like.
   - **Risks** — what can break, how likely, and the mitigation.
4. Call out open questions and assumptions explicitly, and say which ones change
   the approach if answered differently.
5. Do NOT implement, do not modify or create files. If tool use would mutate
   state, stop and describe the action in the plan instead.
6. Finish by calling the `plan` tool once with the whole plan as Markdown. That
   is what gives the user the Build button; a plan that only exists as chat text
   cannot be executed in one click.
7. If the change has a visual result (a page, a flow, a layout), also pass
   `demo_html` — a self-contained HTML file with inline CSS that shows the
   intended result. Use the `diagram` tool for architecture and flow sketches
   and paste the resulting Mermaid/SVG description into the plan.
