# science
tags: science research paper docx figures literature

Self-directed research that produces figures and a .docx paper.

Use the `research` tool for the artifacts (figures, tables, the .docx). It is the
deterministic "make a chart / three-line table / figure-backed paper" tool call;
do NOT hand-write make_figures.py or make_docx.py unless `research` is unavailable.

Workflow:
1. Scope: restate the question; list objectives, hypotheses and success criteria.
2. Evidence: for a scientific/literature question use the papersearch tool first (arXiv/Crossref/OpenAlex) to get citable papers; use apidocsearch for library/API signatures; use websearch and webfetch for general facts and specific pages. Record title, url and year for each citation.
3. Workspace: create ./research/<slug>/ and keep everything there; write raw data as CSV.
4. Analysis: write Python and run it with the bash tool (Windows: python script.py). Prefer numpy/pandas; fall back to the stdlib (csv, statistics, math).
5. Figures: call the research tool with action="figure" and a spec; it renders a publication PNG (CJK font ready) under `out`. Kinds: line, bar, grouped_bar, scatter, heatmap. Examples:
   - {"action":"figure","out":"research/<slug>/figures","spec":{"kind":"line","x":[0,1,2,3],"series":{"基线":[0.1,0.3,0.5,0.7],"干预":[0.1,0.2,0.25,0.3]},"title":"...","xlabel":"天","ylabel":"指标","path":"fig1.png"}}
   - {"action":"figure","out":"research/<slug>/figures","spec":{"kind":"bar","labels":["A","B","C"],"values":[1,2,3],"title":"...","path":"fig2.png"}}
   Only if a chart cannot be expressed this way, write a matplotlib script and run it with bash (dpi=200, no seaborn), still writing into figures/.
6. Tables: call the research tool with action="table" and spec {"header":[...],"rows":[[...]],"caption":"...","stem":"table1"} to get .docx/.html/.tex.
7. Manuscript: write the draft to research/<slug>/<slug>.md (Title, Abstract, Introduction, Related Work, Methods, Results, Discussion, Conclusion, References). Reference every figure inline as ![图注](figures/figN.png) so it is embedded. To place 2-3 small figures side by side, write their lines consecutively with no blank line between them — they become 图N(a)/(b) in one row; add {width=30%} to control a share, otherwise the row is split equally.
8. Polish (do this before exporting): run the academic-humanizer pass over the manuscript.
   - Strip AI tells: formulaic openers ("In recent years...", "随着……不断发展"), empty intensifiers
     ("extensive experiments", "显著提高"), significance hype ("paves the way", "具有重要意义"), novelty
     padding ("to the best of our knowledge"), rule-of-three padding, and em-dashes.
   - Bind every empirical claim to its evidence: a number, table, figure, or citation, and no verb
     stronger than the data (prove -> show empirically; 证明 -> 表明).
   - Never change a number, equation, or citation. Keep evidence-tied hedging ("suggests", "表明"),
     passive voice where the actor is irrelevant, and "we".
   - English draft: call the `skill` tool with name=academic-humanizer. Chinese draft:
     name=academic-humanizer-zh. NSF/NIH proposal: use that skill's proposal mode (keep the vision,
     enforce claim <-> feasibility).
   - Keep a short change log (patterns removed, claims given evidence pointers) to report with the paper.
9. DOCX: call the research tool with action="paper" and spec {"markdown_path":"research/<slug>/<slug>.md","title":"...","stem":"<slug>"} — it produces <slug>.docx (figures embedded) and <slug>.html.
10. Verify the .docx exists, then report its absolute path, the figure list, the source list and the polish change log.

Rules:
- For an academic topic, prefer papersearch over websearch; do not rely on web snippets for citations when a paper record is available.
- Prefer the research tool over writing make_docx.py/make_figures.py by hand.
- Never fabricate data or citations. Label any illustrative or synthetic data explicitly.
- Every figure must come from a script/spec you actually ran; mention its path.
- Keep the scripts, CSV data and figures so the result is reproducible.
- If Python or a library is unavailable, say so and still deliver the markdown draft plus whatever figures were produced.
- Do not skip the polish step: an unpolished draft still carries AI tells, and the change log is part of the deliverable.
