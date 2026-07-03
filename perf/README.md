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
--avatar default_Seraphina.png --chat-name PerfBench-200k --swipes 0`

`--swipes N` gives every assistant message N extra swipes — models a heavy
swipe user whose chat FILE is much larger than the visible conversation
(save/serialize cost scales with the file, not the visible text).

**Do NOT regenerate `PerfBench-200k.jsonl`.** The on-disk file has been
round-tripped through the app's own save (the save-chat scenario rewrites
it), so its bytes no longer match raw generator output — and all recorded
stage results in `perf/results/` were measured against those exact bytes
(md5 `23ac82b61f8c486dabd489493ec6eede`). If it gets clobbered, restore a
matching copy from `data/default-user/backups/`.

The phone-emulation fixture is separate and safe to (re)generate:

```bash
node perf/generate-fixtures.js --messages 1200 --chat-name PerfBench-300k --swipes 2
```

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
| `tokencache-save` | Token cache write to IndexedDB (per-chat shards, idle-deferred) | tokenizers.js |
| `stream-tick` | Accumulated per-tick streaming cost | script.js |
| `itemized-save` | Itemized-prompts array write to IndexedDB (whole array, every save) | itemized-prompts.js |

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
token-cache save. The JSON report is printed to the runner output and
attached as a test artifact. It is saved to
`perf/results/<stage>-<date>.json` **only when `PERF_STAGE` is set** —
plain regression-suite runs never overwrite recorded stage data.

Tag the stage when measuring:

```bash
PERF_STAGE=after-1.1 npx playwright test perf-baseline --workers 1
```

Manual scenarios (need a live LLM backend, not covered by the script):
long-reply streaming (`stream-tick`), non-OpenAI `checkPromptSize` overflow.

## 4. Phone emulation (production = Android/Termux)

`tests/frontend/perf-phone.e2e.js` reproduces the phone environment: CPU
throttled 6x via CDP (`PERF_CPU_RATE` to override), the 300k heavy-swipes
fixture, context raised to 300k. Measures the reported freeze actions end
to end (open chat, preflight cold/hot, swipe between existing replies,
append user message, bare save, stream + STOP) and quantifies main-thread
freezes per scenario with a `longtask` observer (`freeze.blockedMs`).
Skipped unless `PERF_PHONE` is set — it never runs in the plain suite:

```bash
cd tests && PERF_PHONE=1 PERF_STAGE=phone6x-optimized \
  npx playwright test perf-phone --workers 1
```

Chat saves are fulfilled locally in this spec (serialization + gzip still
run; only the server write is skipped), so fixture files stay byte-stable
across runs.

## Measurement discipline

- Record numbers per stage in `perf/results/` as `<stage>-<date>.json`
  (e.g. `baseline-2026-07-03.json`, `after-1.1-2026-07-04.json`).
- Same fixtures, same machine, browser DevTools closed, at least 2 runs —
  keep the second (warm caches for everything except the scenario itself).
- Cold-token-cache variants: run `resetTokenCache()` from the debug menu
  (or clear site data) before the scenario.
