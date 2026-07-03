# [INVESTIGATION / DISCUSSION] Round 3 — 14MB-scale bottleneck analysis (joint exploration requested)

NOT a plan review yet. The user asked us BOTH to freely explore the code,
then discuss root causes together, then converge on a plan. This doc is my
half of the investigation: measurements + code-path evidence + hypotheses
for you to confirm, refute, or extend. Explore anything else you suspect.

## User goal (verbatim intent)

After deploying round 2, the user reports the frontend still HARD-FREEZES
(cannot interact at all) on: send message, swipe for new reply, regenerate,
manual stop. Their real chat files (Termux ls): the main one is **14MB**
("冷刃映繁花/Branch #263"), plus 5.6M / 5.2M / 5.1M / 5.1M siblings. My
earlier fixtures were 2.5MB — 6x too small; round-2 wins were real but got
eaten by real-file scale.

Target the user set: (1) frontend never blocks on these actions; (2) the
backend (Node on the same phone) also stays smooth; (3) compress the whole
action flow to under ~1s if achievable — as fast as possible WITHOUT any
loss of functionality/behavior.

## New measurement (PerfBench-14M: 6800 messages, 13.97MB, swipes on every
assistant message; 6x CPU throttle; perf/results/phone6x-14M-2026-07-03.json)

```
scenario              freeze   longest  spans
open-chat             1576ms   1345ms   chat-render=737
assemble-cold          756ms    245ms   preflight=2914 wi-scan=655 oai-populate=2114
assemble-hot           817ms    817ms   preflight=816  wi-scan=204 oai-populate=511
swipe-existing        1897ms    665ms   chat-save=1098
send-user-message     1279ms    816ms   chat-save=2042
save-chat              884ms    830ms   chat-save=1837
streaming-run-4s      2105ms    355ms   (52.6% occupancy — R2.1 bound HELD)
streaming-stop        1312ms    828ms   chat-save=1877
```

Reference at 2.5MB (phone6x-final same day): save freeze ~140ms, preflight
~540ms, open-chat ~560ms. Everything that scales with file size scaled
~linearly. Streaming throttle is the one thing that held its bound.

## My code-path findings (verify these yourself, file:line given)

### F1 — Save pipeline rewrites the world on every action (top target)

Every send / swipe / stop / edit(1s debounce) triggers saveChat, which:

- CLIENT `public/script.js:7422-7464`: builds `[header, ...chat.slice()]`
  payload and structured-clones ~14MB into the R2.2b worker
  (`serializeChatSaveOffThread`). The CLONE is main-thread: that is the
  ~830ms freeze block appearing in every save-touching scenario above.
  (Worker then stringifies+gzips off-thread — that part is fine.)
- SERVER `src/endpoints/chats.js:457-468` (`trySaveChat`): re-serializes
  ALL 6800 messages (`chatData.map(JSON.stringify).join('\n')`) and
  `tryWriteFileSync` — a SYNCHRONOUS 14MB write on the Node event loop.
  Plus `getBackupFunction` throttled backup = ANOTHER synchronous 14MB
  write (`backupChat`, chats.js:41-61). Express also gunzips+JSON.parses
  the 14MB body first. On the phone, Node and the browser share the SoC;
  a save landing mid-stream blocks the SSE relay = visible stream hiccup.
  This is the "backend smoothness" half of the user's complaint.

Both halves scale linearly with file size and run per action. Structural
conclusion: full-file save per action is the wrong shape at 14MB.

### F2 — Preflight has O(total-messages) passes (816ms hot, grows with count)

- `public/script.js:4474`: `chat.filter(...)` over all 6800, then `:4479`
  `Promise.all(coreChat.map(...))` runs substituteParams/getRegexedString
  over EVERY message — a full 14MB regex/macro pass per send. Then a
  second full loop at `:4510`.
- `public/scripts/openai.js:562-616` `setOpenAIMessages(chat)`: walks ALL
  messages, per-message `content.replace(/\r/gm,'')` + name prefixing +
  object build — another full 14MB pass.
- `populateChatHistory` itself is token-budget-bounded (stops ~1500 msgs
  at 300k) — fine. wi-scan is depth-bounded (204ms) — fine.

Only ~1500 of 6800 messages can ever fit the budget; ~78% of both passes
is provably wasted work.

### F3 — Open-chat: 1345ms longest block

- SERVER `src/endpoints/chats.js:502-544`: sync read of 14MB + per-line
  JSON.parse + re-serialize as one JSON array to the response.
- CLIENT: JSON.parse of that array + `printMessages` (script.js:1477)
  renders last 100 via addOneMessage/messageFormatting = 737ms of it.
- Once per chat switch, not per action — lower priority than F1/F2, but
  the user DOES feel it.

### F4 — Facts that make a delta protocol feasible

- Integrity slug is set ONCE per chat (`script.js:7683-7684`,
  `if (!chat_metadata.integrity) integrity = uuidv4()`) — it does NOT
  rotate per save, so line 0 is not forced to change every save.
- Server integrity check only reads line 0 (`checkChatIntegrity`,
  chats.js:316-335) and compares a slug — cheap.
- saveChat already supports partial intent (`mesId` slice param) and all
  callers go through saveChat/saveChatConditional/saveChatDebounced.
- R1/R2 already fixed: token-cache save is sharded+idle (12-16ms now),
  itemized prompts dirty-gated (skips clean saves), streaming adaptive
  throttle held 52% at 14MB, worker gzip. Do not re-propose those.

## My hypotheses / candidate directions (challenge these)

H1 (primary): **Delta save protocol.** Client keeps a "dirty ledger"
(appended-from index, edited indices, structural flag, metadata flag) fed
by the ~dozen SEMANTIC mutation entry points (new message, swipe, edit
done, delete, regenerate finalize, ...). Fail-SAFE rule: a save request
with an empty/unknown ledger (e.g. an extension mutated chat[] directly
and called saveChat) = FULL save, today's behavior. New endpoint
`/api/chats/save-delta`: append case = fs.appendFile of the new lines
only (no read of the 14MB at all); edited-line / metadata case = server
does an async read-modify-write off the UI entirely; baseline mismatch
(server line-count != client's expected) → 409 → client transparently
falls back to full save. Periodic reconciliation full-save (chat switch /
app hide / every N deltas) bounds any missed-mark divergence. Backup
becomes fs.copyFile (kernel copy, no 14MB string in JS) for both paths.
Client cost per send/swipe/stop drops from clone(14MB)≈830ms to
clone(1 message)≈~0. Server cost drops from parse+stringify+write 14MB
to appending ~KB. Risks I already see: missed dirty marks (bounded by
reconciliation + fail-safe rule), group chats path (separate save
endpoint, chats.js:859?), branch/bookmark partial saves (mesId slice),
rename/import interplay, concurrent saves ordering (debounce + inflight
queue exists client-side?), CRLF/encoding parity of appended lines vs
full rewrite, integrity semantics on append.

H2: **Preflight lazy-map-from-end.** Build coreChat/openai messages
lazily from the END with a conservative char-budget cutoff (generous
multiple of token budget) so regex/macro/mapping passes touch only the
plausible window (~1500) instead of 6800, with exact-parity guarantee
(the real token-budget walk still decides inclusion; cutoff only skips
work that provably cannot be included). Must preserve: depth-indexed
injections, lastInContextMessageId, continue/tool-call edge cases,
IGNORE_SYMBOL handling, group name prefixes.

H3 (maybe defer): open-chat — server streams JSONL / client parses in
worker / render defers below-fold. Each has behavior-parity or
clone-cost caveats; possibly not worth it this round since it's
once-per-chat-switch. Your call whether anything cheap exists here.

H4 (server hygiene, small): make the full-save write path async
(write-file-atomic has an async form) so even full saves don't block the
event loop mid-stream; applies regardless of H1.

## What I ask of you

1. Independently explore the code (don't trust my line numbers, re-derive):
   the save pipeline end to end (client saveChat → express middleware →
   trySaveChat → backups), the Generate preflight (script.js:4200-4600,
   openai.js prepareOpenAIMessages/populateChatHistory), chat open
   (getChatResult/printMessages), group-chat save path, and anything I
   did NOT flag that is O(total-messages/bytes) on these hot paths
   (message edit path? addOneMessage? getMessageTimeStamp? swipe DOM?).
2. Confirm or refute F1-F4 and each H1-H4 with your own evidence.
3. For H1 specifically: adversarial pass on correctness — enumerate every
   writer of the chat file (client and server side, incl. group chats,
   bookmarks/branches, /api/chats/edit? imports, extensions server
   plugins?) and every reader that assumes full-rewrite semantics; tell
   me where a delta protocol silently corrupts, and what invariant set
   makes it safe (or argue it cannot be made safe and propose the
   alternative that reaches the same target).
4. Bring YOUR OWN candidate directions if different — especially any way
   to hit the user's <1s whole-flow target that is simpler than H1.
5. Return a structured analysis: findings (file:line), verdict per
   F/H item (confirm/refute/extend), risk register for the delta design,
   your recommended round-3 unit list with expected wins at 14MB scale.
   We then converge and I'll write the formal plan for [PLAN REVIEW].

Context files you can read directly:
- This doc: /Users/mxby/Desktop/SillyTavern/.ccb/claude-round3-investigation.md
- 14MB results: /Users/mxby/Desktop/SillyTavern/perf/results/phone6x-14M-2026-07-03.json
- 2.5MB same-day baseline: /Users/mxby/Desktop/SillyTavern/perf/results/phone6x-final-2026-07-03.json
- Round-2 plan (what's already done): /Users/mxby/Desktop/SillyTavern/.ccb/claude-round2-plan.md
- Measurement harness: /Users/mxby/Desktop/SillyTavern/tests/frontend/perf-phone.e2e.js
