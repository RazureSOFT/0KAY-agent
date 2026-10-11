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
8. DOCX: call the research tool with action="paper" and spec {"markdown_path":"research/<slug>/<slug>.md","title":"...","stem":"<slug>"} — it produces <slug>.docx (figures embedded) and <slug>.html.
9. Verify the .docx exists, then report its absolute path, the figure list and the source list.

Rules:
- For an academic topic, prefer papersearch over websearch; do not rely on web snippets for citations when a paper record is available.
- Prefer the research tool over writing make_docx.py/make_figures.py by hand.
- Never fabricate data or citations. Label any illustrative or synthetic data explicitly.
- Every figure must come from a script/spec you actually ran; mention its path.
- Keep the scripts, CSV data and figures so the result is reproducible.
- If Python or a library is unavailable, say so and still deliver the markdown draft plus whatever figures were produced.
