# Performance benchmark toolkit

Tooling for the perf-optimization branch. Provides reproducible fixtures,
runtime instrumentation, and a scripted baseline so every optimization stage
can be measured against identical workloads.

## 1. Generate fixtures

```bash
node perf/generate-fixtures.js
```

Creates (deterministic — same args, same bytes):

- `data/default-user/chats/default_Seraphina/PerfBench-200k.jsonl` — ~1000
  messages, ~250k tokens (guesstimate), with quoted speech, emphasis, code
  blocks, and World Info trigger keywords sprinkled in.
- `data/default-user/worlds/PerfBench.json` — 300 entries: 60% never-matching
  keys, 30% keys matching chat keywords, 7% recursion-only, 3% constant.

Options: `--messages 1000 --entries 300 --data-root ./data --user default-user
--avatar default_Seraphina.png`

## 2. Instrumentation

`public/scripts/perf-metrics.js` — zero-cost unless enabled. In the browser
console:

```js
localStorage.setItem('perfTrace', '1'); location.reload();  // enable
__perfReport();   // aggregated table: count / total / avg / max per span
__perfReset();    // clear between scenarios
localStorage.removeItem('perfTrace'); location.reload();    // disable
```

Instrumented spans:

| Span | Meaning | Location |
|---|---|---|
| `pm-dryrun` | Prompt manager dry-run generation (the config-switch freeze) | PromptManager.js |
| `pm-render` | Prompt manager DOM rebuild | PromptManager.js |
| `wi-scan` | World Info scan per generation/dry-run | world-info.js |
| `oai-populate` | Chat completion population incl. token counting | openai.js |
| `gen-preflight` | Generate() from entry until request data ready | script.js |
| `chat-render` | Full chat (re)render | script.js |
| `chat-save` | Chat serialization + upload | script.js |
| `tokencache-save` | Full token cache write to IndexedDB | tokenizers.js |
| `stream-tick` | Accumulated per-tick streaming cost | script.js |

## 3. Scripted baseline

```bash
npm start                      # terminal 1 — server on 127.0.0.1:8000
cd tests && npm install        # first time only
npx playwright test perf-baseline --workers 1   # terminal 2
```

Scenarios covered: open 200k chat (render), switch completion source ×2
(dry-run), model change (dry-run), drawer open after config changes
(deferred dry-run replay under the lazy-render optimization), prompt
assembly via dry-run Generate (the pre-network cost of a send), chat +
token-cache save. The JSON report is printed to the runner output, attached
as a test artifact, and saved to `perf/results/<stage>-<date>.json`.

Tag the stage when measuring after an optimization:

```bash
PERF_STAGE=after-1.1 npx playwright test perf-baseline --workers 1
```

Manual scenarios (need a live LLM backend, not covered by the script):
long-reply streaming (`stream-tick`), non-OpenAI `checkPromptSize` overflow.

## Measurement discipline

- Record numbers per stage in `perf/results/` as `<stage>-<date>.json`
  (e.g. `baseline-2026-07-03.json`, `after-1.1-2026-07-04.json`).
- Same fixtures, same machine, browser DevTools closed, at least 2 runs —
  keep the second (warm caches for everything except the scenario itself).
- Cold-token-cache variants: run `resetTokenCache()` from the debug menu
  (or clear site data) before the scenario.
