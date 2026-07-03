# Round 3 plan — kill the "rewrite the world per action" shape at 14MB scale

Converged from the joint investigation (my F1-F4 + your verdicts/extensions:
group save off-worker, body-parser parse, mutable header line, interceptor/
macro gates, no-trailing-newline parity, per-file queues + revision checks,
copyFile backups). Targets the user's goal: no frontend blocking on
send/swipe/regenerate/stop, smooth backend on the same phone, whole action
flow toward <1s, ZERO behavior loss.

Baseline (14MB fixture, 6x throttle, perf/results/phone6x-14M-2026-07-03.json):
save freeze ~830ms block per action (client clone) + server 14MB
parse+stringify+sync-write+sync-backup per save; preflight 816ms hot;
itemized store grows unbounded (push-only, itemized-prompts.js:58) and
rewrites fully every generation.

## Unit R3.1 — Server delta/raw persistence foundation (new endpoints only)

**A. POST `/api/chats/save-delta`** (solo chats v1). Request:
`{ file_name, avatar_url, base: { lineCount, fileSize, integrity }, ops: [...] }`
Ops vocabulary (applied in order, one request = one atomic file transition):
- `{op:'append', lines:[serialized message JSON strings]}`
- `{op:'replaceLast', line}` (swipe select / regenerate / continue / edit-last)
- `{op:'replace', index, line}` (mid-chat edit)
- `{op:'truncate', fromIndex}` (delete-from-tail)
- `{op:'header', line}` (chat_metadata line 0 — changes every generation via
  lastInContextMessageId, script.js:6101, so this is a HOT op)

Server mechanics:
- Base check first: `fs.stat` size === base.fileSize, cached/verified line
  count === base.lineCount, line-0 integrity slug === base.integrity.
  ANY mismatch → 409 `{error:'base-mismatch'}` → client full-saves. External
  writes are caught by the stat check (mtime/size cache invalidation).
- Per-file line-offset index cache `{mtimeMs, size, offsets[]}`, built by one
  streaming byte scan on first delta op (no JSON parse), updated
  incrementally per op, dropped on any stat mismatch.
- Pure-append requests (only `append` ops): base check + journaled append —
  JSONL parity preserved (file has NO trailing newline today; append inserts
  exactly one separator; golden tests pin this). O(delta-bytes) — no read of
  the 14MB at all.
  **Append journal (your required revision #3 — no unjournaled partial
  append):** before touching the chat file, write a tiny sidecar
  `<chat>.jsonl.append-journal` containing `{baseSize, byteLength, crc32}` +
  the exact append bytes, fsync it, then append to the chat file, then unlink
  the journal. Recovery (run on any subsequent access of the file by the
  delta/raw endpoints and on chat load): journal present + complete (crc/
  length valid) → `ftruncate(baseSize)` + re-apply the journaled bytes (ZERO
  loss); journal present but itself partial → `ftruncate(baseSize)` (file is
  exactly the clean pre-append state; the client never got an ack so its
  ledger still holds the un-acked ops and the next save carries them).
  Newest-message loss without an explicit failure is thereby off the table.
- Any other op mix: byte-stream surgery — stream old file bytes into a temp
  file swapping the replaced/truncated/header ranges (offsets from the index,
  zero JSON parse/stringify), then atomic rename. Always-atomic (temp+rename)
  — I considered and REJECTED in-place header pwrite (padding trick): breaks
  atomicity for a metadata line; not worth it when a streamed 14MB copy is
  ~50-100ms of async, backpressured IO with near-zero CPU.
- Per-file async op queue (promise chain per path) so concurrent requests
  serialize; queue shared with save-raw below.
- Crash exposure after the journal: stream-surgery ops are temp+rename
  atomic; appends are journal-recovered (above). No silent-loss window
  remains in either path.

**B. POST `/api/chats/save-raw`** — full save WITHOUT the 14MB JSON parse.
**Request contract (your required revision #1 — must actually bypass the
global JSON parser):** the client does NOT reuse `getRequestHeaders()`
verbatim (it pins `Content-Type: application/json`, script.js:647-650, which
would hand the body to `bodyParser.json`, server-main.js:110). Instead:
`Content-Type: application/x-ndjson`, body = the JSONL bytes (the R2.2b
worker already produces them, optionally gzipped with
`Content-Encoding: gzip` — `express.raw({ type: 'application/x-ndjson',
inflate: true, limit: '500mb' })` inflates for free and the global JSON
parser never matches the type). CSRF stays intact (the token travels in the
`X-CSRF-Token` header from getRequestHeaders, not the body). Routing
metadata moves OUT of the body into URL-encoded query parameters:
`?file_name=…&avatar_url=…&force=0|1` (solo) / `?group_id=…` (group) —
query strings handle unicode names via encodeURIComponent; the endpoint
validates them exactly like `/save` (sanitize + isPathUnderParent).
Server parses ONLY line 0 of the body (integrity check, same semantics
incl. the force/OVERWRITE flow), then writes the received bytes with an
ASYNC atomic write (H4). Used by: solo full saves (fallback/reconciliation)
AND group saves. Group client path (group-chats.js:637, currently inline
stringify — your finding) moves onto the existing R2.2b worker + this
endpoint; group delta wiring is NOT in v1.

**C. Backups become `fs.copyFile`** of the just-persisted file (async,
throttled per handle exactly as today, after successful write) — removes the
second synchronous 14MB string write (chats.js:41-61) for ALL paths,
including legacy `/save` which stays untouched otherwise.

Kill-switch: `performance.chatSaveDelta` config key (default true on the
fork); client also feature-detects (404/disabled → permanent full-save path)
so mixed client/server versions degrade gracefully.

## Unit R3.2 — Client mutation ledger + hot-action wiring

New module `chat-save-ledger.js`, module-private state:
`{ baseAck: {lineCount, fileSize, integrity, metadataSnapshot}, entries: [],
provable: boolean, deltaCount }`.
- Semantic record points (the ONLY writers; everything else never records):
  user send append (script.js:5915), generation-final append (5573),
  streaming-final append (3789), swipe select replaceLast (~10121),
  edit-done replace(index) (8450), regenerate/continue replaceLast,
  delete-from-tail truncate. Each records `{type, index?}` — message
  CONTENT is read at save time from `chat[]` (single source of truth; the
  ledger stores indices, never copies).
- **Poison discipline (your required revision #2 — no save-time
  inference):** every KNOWN in-tree mutation site that the op vocabulary
  does not cover calls `poisonChatSaveLedger()` AT the mutation, before any
  save can run: arbitrary-index delete (script.js:1660), mid-chat user
  insert (5909), edit-clone insert (12000), slash-command message deletion
  (slash-commands.js:5073) and insertion (6003), message move/branch
  surgery, group-member message ops. Poison ⇒ every save full-saves until
  the next successful full save re-arms the base. Belt-and-braces on top,
  not instead: at save time the ledger's implied length
  (baseAck.lineCount − 1 + net recorded delta) must equal `chat.length`,
  else full save — this also catches UNKNOWN writers (extensions mutating
  `chat[]` via getContext) that change the message count. Same-length
  unknown mutations remain covered by reconciliation only, stated honestly.
  Pinned regression (your requirement): an unsupported middle mutation
  followed by a supported append must produce a FULL save, not a delta.
- `saveChat` delta path: eligible only when un-poisoned AND the length
  invariant holds AND every entry since baseAck is a recorded hot op.
  Serializes ONLY the touched messages
  (JSON.stringify of 1-2 objects, no worker, no clone) + header op included
  iff `JSON.stringify(chat_metadata)` differs from the acked snapshot
  (content-compare beats inference — updateChatMetadata at 8995 and
  extensions can replace metadata wholesale). Ack updates base from the
  server's returned `{lineCount, fileSize}`.
- FAIL-CLOSED everywhere: save with empty/unproven ledger (extension mutated
  `chat[]` via getContext and called saveChat — st-context.js:114), slice
  saves (`mesId` param), branch/bookmark/rename/import flows, group chats,
  409, worker failure, network error → full save via worker→save-raw,
  identical to today. Mid-chat mutations outside recorded sites are the one
  real risk class; bounded by reconciliation:
- Reconciliation full save (your calibration adopted): fires on whichever
  comes first — 10 delta saves, ~1MB of accumulated delta bytes, chat
  switch, manual save, before rename/branch/bookmark — plus an idle-timer
  reconciliation when the app has been quiet after deltas. N may relax to
  25 after phone-scale confidence. (pagehide reconciliation is impossible —
  keepalive caps at 64KB — same reality R2.2a documented.)

## Unit R3.3 — Preflight tail window (OpenAI path, fail-closed gates)

Today every send runs three O(total) passes over 6800 messages: coreChat
filter+regex/macro map (script.js:4474/4479), the depth loop (4510), and
setOpenAIMessages' full walk with per-message `.replace(/\r/gm,'')`
(openai.js:562-607) — while the token-budget walk can only ever include
~1500. Change: compute a conservative tail window (context tokens ×
generous chars/token safety factor, so the cutoff provably cannot exclude
an includable message) and run those passes only inside it. The budget walk
(populateChatHistory) is unchanged → identical final prompt.
Fail-closed gates (any → legacy full pass):
- any generation interceptor registered (interceptors receive the full
  transformed array today, script.js:4542 — extension-visible),
- any SKIPPED message contains `'{{'` (macros in old messages execute today
  = side effects; detection = cheap indexOf scan, per-message boolean cached
  and invalidated via R3.2's ledger marks; cache absent → scan once),
- main_api !== 'openai' (text-completion full-history formatting is a
  different beast; out of scope this round).
Parity pinned by request-body-equality tests (windowed vs legacy) across
fixture configs incl. depth injections, IGNORE_SYMBOL, names_behavior,
continue mode, and a `{{setvar}}`-in-old-message case that must take the
legacy gate.

## Unit R3.4 — Itemized prompts: per-entry shards + lazy load

Push-only growth (itemized-prompts.js:58) means every generation rewrites an
ever-growing array (MB-scale entries at 300k context) into IndexedDB, and
chat open loads all of it into memory. Change storage layout only, zero
behavior change: each entry under its own key (`${chatId}#${mesId}` + a
small per-chat index key), generation writes ONLY the new/updated entry
(R2.3's dirty flag becomes per-entry), delete/swap/clear/rename handle
shards, one-time lazy migration from the legacy array key on first load.
Retention unchanged (no cap — capping would lose user-visible data).
Preserved behaviors called out by your review (#4), all pinned by tests:
- Bookmark/checkpoint/branch copies (bookmarks.js:282/460) copy the FULL
  entry set to the alternate chat key — shard-aware copy (index + all
  entries), never touching the source chat's dirty state (same alternate-key
  semantics R2.3 established).
- The popup's diff needs the nearest PRIOR raw-prompt entry
  (itemized-prompts.js:348-353) and the copy/show actions need the current
  raw prompt (372-405): the lazy loader fetches the requested entry PLUS the
  nearest prior entry via the per-chat index (mesId-ordered), not a full
  array load.
- The message-button visibility / click gate currently keyed off the
  in-memory array length (421-425) is driven by the per-chat INDEX instead
  (cheap, loaded at chat open), so buttons appear exactly as today.
- Edge cases in scope: current-entry missing, legacy migration mid-popup,
  rename/delete/clear, index shifts on message deletion, a generation
  writing a new shard while the popup is open, mobile popup path, and
  ITEMIZED_PROMPTS_LOADED/SAVED event semantics unchanged.

## Deferred

- R3.5 open-chat (1576ms once per switch): revisit with real-phone feedback
  after R3.1-R3.4; candidates were listed in the investigation (streamed
  JSONL, deferred below-fold render) — agreed to defer, virtual scrolling
  stays last resort.

## Expected wins at 14MB/6x (same-day A/B to verify)

- send/swipe/stop/edit saves: ~830ms clone block → ~0 (delta serializes
  KBs); server per-save 14MB parse+stringify+2×sync-write → stat + append
  (or streamed byte copy) + async copyFile backup. Event loop stays free
  mid-stream (the "backend smoothness" half).
- preflight hot 816ms → target ≤ ~450ms (window ~2-3k of 6800 + cheap scan).
- generation-time itemized write: full array → single entry.
- streaming occupancy already held (52%) — untouched this round.

## Validation

- Golden byte-equivalence (server, Jest, temp dirs): scripted op sequences
  (pure appends / swipe replaceLast / mid edit / truncate / header change /
  mixed) — file bytes after delta ops === file bytes after a legacy full
  save of the same end state; separator/no-trailing-newline parity pinned.
- Journal recovery (server, Jest): simulated crash at each stage (journal
  written but append absent / append partial / journal itself partial) —
  recovery yields either the fully-applied state or the exact pre-append
  state, never a corrupt or silently-shortened file.
- Poison regression (e2e): unsupported middle mutation followed by a
  supported append ⇒ FULL save on the wire, not a delta; length-invariant
  breach from an unrecorded push ⇒ full save.
- e2e: 409 → transparent full-save fallback (tampered base, no data loss,
  no user-visible error); fail-closed ledger (direct chat[] mutation + generic
  saveChat → full save); reconciliation counter fires; group save through
  worker+raw parity; integrity-mismatch OVERWRITE popup flow preserved;
  R3.4 shard round-trip + migration + popup lazy load; R3.3 request-body
  equality matrix.
- Mutation testing per unit (ledger marks, base checks, gates, shard
  invalidation) — every added guard bitten by a test.
- Full suite + lint + Jest per unit; 14MB fixture A/B same-day, quiet
  machine; final real-phone verification by the user.

## Sequencing & merge discipline

R3.1 → R3.2 → R3.4 → R3.3, each an independent branch off perf-main with
its own review, A/B, and rollback point. New files (2 endpoints in
chats.js, ledger module, shard layer) + narrow touchpoints at the five hot
sites keep upstream-merge friction low; legacy /save untouched.

## Resolved decisions (from review round 1)

1. Op vocabulary: keep the explicit five (append / header / replaceLast /
   replace / truncate) with message-index addressing and header separate;
   middle inserts/deletes are POISONED to full save in v1 (no replaceFrom —
   your recommendation adopted).
2. Reconciliation: min(10 deltas, ~1MB delta bytes) + chat switch + manual
   save + pre-rename/branch/bookmark + idle timer; relax later.
3. Append journal with crc + truncate/replay recovery replaces the
   "accepted partial-append window" — zero silent loss.
4. save-raw contract: application/x-ndjson + query-param routing metadata +
   CSRF header preserved; never touches bodyParser.json.
