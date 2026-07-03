/**
 * Client-side mutation ledger for incremental (delta) chat saves (unit R3.2).
 *
 * The ledger tracks WHICH messages changed since the last acknowledged save
 * of the current chat file, so saveChat can send only those lines to
 * /api/chats/save-delta instead of cloning and re-serializing the whole
 * multi-MB chat on every send/swipe/stop/edit.
 *
 * Correctness stance — FAIL CLOSED:
 * - The ledger stores indexes only, never message content; lines are
 *   serialized fresh from chat[] at save time.
 * - It arms ONLY after a full save whose exact on-disk state is known
 *   (worker-serialized save-raw ack). Anything uncertain — an unsupported
 *   mutation (middle insert/delete/move), a failed delta, an entry-count
 *   blowup, a chat switch — poisons it, and every save is a FULL save until
 *   the next successful full save re-arms it.
 * - At build time the chat must not have shrunk below the acknowledged
 *   base, and recorded indexes that sank below it (or past the end) in the
 *   CURRENT arm epoch mean an unrecorded delete happened: full save.
 *   Appended tail content is serialized positionally fresh from chat[],
 *   so no per-position record check is needed for correctness.
 * - Same-length in-place mutations from unknown writers are the one class
 *   the ledger cannot see; their exposure is bounded by reconciliation:
 *   a forced full save every RECONCILE_AFTER_DELTAS deltas /
 *   RECONCILE_AFTER_BYTES delta bytes / RECONCILE_IDLE_MS of quiet.
 */

const RECONCILE_AFTER_DELTAS = 10;
const RECONCILE_AFTER_BYTES = 1024 * 1024;
const RECONCILE_IDLE_MS = 60_000;
const MAX_TRACKED_ENTRIES = 2000;

let armed = false;
let unsupported = false;
/** @type {{chatKey: string, lineCount: number, fileSize: number, integrity: string|null, headerLine: string}|null} */
let base = null;
/** Arm generation — lets the build tell pre-arm leftovers apart from post-arm records. */
let armEpoch = 0;
/** @type {Map<number, number>} index -> armEpoch at record time */
let appendedIndexes = new Map();
/** @type {Map<number, number>} index -> armEpoch at record time */
let touchedIndexes = new Map();
let deltasSinceFullSave = 0;
let bytesSinceFullSave = 0;
let reconcileDue = false;
/**
 * Set when a record arrives while the ledger is unarmed — i.e. possibly
 * AFTER a poisoned full save took its snapshot but before it armed. Such
 * a mutation is absent from the snapshot and its record was dropped, so
 * arming on that snapshot would let the queued follow-up save noop it
 * away. beginFullSaveSnapshot() clears the flag at snapshot time;
 * armChatSaveLedger refuses to arm while it is set.
 */
let unarmedMutationSeen = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let idleTimer = null;

function clearIdleTimer() {
    if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function scheduleIdleReconcile() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
        reconcileDue = true;
    }, RECONCILE_IDLE_MS);
}

/**
 * Marks the ledger unusable until the next full-save ack. Called at every
 * in-tree mutation site the delta op vocabulary does not cover, and on any
 * delta failure.
 * @param {string} reason For the debug log
 */
export function poisonChatSaveLedger(reason) {
    if (armed) {
        console.debug(`Chat save ledger poisoned (${reason}); next save is a full save.`);
    }
    armed = false;
    base = null;
    appendedIndexes.clear();
    touchedIndexes.clear();
    clearIdleTimer();
}

/** Marks the server as not supporting delta saves (endpoint 404 / disabled). */
export function markChatSaveDeltaUnsupported() {
    unsupported = true;
    poisonChatSaveLedger('server-unsupported');
}

function guardTrackedEntryCap() {
    if (appendedIndexes.size + touchedIndexes.size > MAX_TRACKED_ENTRIES) {
        poisonChatSaveLedger('entry-cap');
    }
}

/**
 * Records that a message was appended at the given index.
 * @param {number} index Message index in chat[]
 */
export function recordChatAppend(index) {
    if (!armed) {
        unarmedMutationSeen = true;
        return;
    }
    appendedIndexes.set(index, armEpoch);
    guardTrackedEntryCap();
}

/**
 * Records that the message at the given index changed in place (edit, swipe
 * selection, streamed text, media attach, ...).
 * @param {number} index Message index in chat[]
 */
export function recordChatTouch(index) {
    if (!armed) {
        unarmedMutationSeen = true;
        return;
    }
    touchedIndexes.set(index, armEpoch);
    guardTrackedEntryCap();
}

/**
 * @param {string} headerLine Serialized header line
 * @returns {string|null} Integrity slug from the header, if any
 */
function parseIntegrity(headerLine) {
    try {
        const slug = JSON.parse(headerLine)?.chat_metadata?.integrity;
        return typeof slug === 'string' ? slug : null;
    } catch {
        return null;
    }
}

/**
 * Re-arms the ledger after a full save whose exact on-disk state is known.
 * @param {object} ack Ack data
 * @param {string} ack.chatKey Identity of the saved chat file
 * @param {number} ack.lineCount Lines on disk (header + messages)
 * @param {number} ack.fileSize Bytes on disk
 * @param {string} ack.headerLine The exact header line that was written
 */
/**
 * Marks the moment a full save snapshots the chat (synchronously, before
 * its first await). Records arriving after this moment while the ledger
 * is unarmed are NOT in the snapshot — they block the subsequent arm.
 */
export function beginFullSaveSnapshot() {
    unarmedMutationSeen = false;
}

export function armChatSaveLedger({ chatKey, lineCount, fileSize, headerLine }) {
    if (unsupported) return;
    if (unarmedMutationSeen) {
        // A mutation landed while this full save was in flight (its record
        // was dropped and its content is not in the written bytes). Stay
        // fail-closed: the queued follow-up save must be a full save.
        poisonChatSaveLedger('mutation-during-full-save');
        return;
    }
    if (!Number.isInteger(lineCount) || lineCount < 1 || !Number.isInteger(fileSize) || fileSize < 0) {
        poisonChatSaveLedger('bad-ack');
        return;
    }
    armed = true;
    armEpoch += 1;
    base = { chatKey, lineCount, fileSize, integrity: parseIntegrity(headerLine), headerLine };
    // Deliberately does NOT clear the recorded sets: entries may have been
    // recorded during the full save's awaits (their content is then not in
    // the written file). Pre-snapshot leftovers only cause a redundant
    // byte-identical resend or a fail-closed full save — never a lost write.
    deltasSinceFullSave = 0;
    bytesSinceFullSave = 0;
    reconcileDue = false;
    clearIdleTimer();
}

/**
 * Updates the base after a successful delta save. The entries the plan
 * consumed were already swapped out at build time; anything recorded while
 * the request was in flight stays queued for the next save.
 * @param {object} ack Ack data
 * @param {number} ack.lineCount Server-reported line count
 * @param {number} ack.fileSize Server-reported file size
 * @param {string} ack.headerLine Header line the file now carries
 * @param {number} ack.requestBytes Approximate delta request size
 */
export function ackChatDeltaSave({ lineCount, fileSize, headerLine, requestBytes }) {
    if (!armed || !base) return;
    if (!Number.isInteger(lineCount) || !Number.isInteger(fileSize)) {
        poisonChatSaveLedger('bad-delta-ack');
        return;
    }
    base.lineCount = lineCount;
    base.fileSize = fileSize;
    base.headerLine = headerLine;
    deltasSinceFullSave += 1;
    bytesSinceFullSave += Number(requestBytes) || 0;
    scheduleIdleReconcile();
}

/**
 * @typedef {object} ChatDeltaPlan
 * @property {boolean} [noop] True when nothing changed since the base — the save can be skipped entirely
 * @property {{lineCount: number, fileSize: number, integrity: string|null}} [base] Base the server must verify
 * @property {object[]} [ops] Base-relative ops in canonical order
 * @property {string} [headerLine] Header line this plan brings the file to
 * @property {number} [projectedLineCount] Line count after the delta applies
 */

/**
 * Decides whether the pending state can be saved as a delta, and builds the
 * request if so. Returns null when a FULL save is required.
 * @param {object} args Arguments
 * @param {string} args.chatKey Identity of the chat file being saved
 * @param {number} args.chatLength Current chat[] length
 * @param {string} args.headerLine Serialized header line for this save
 * @param {(index: number) => string} args.serializeMessage Serializes one message
 * @returns {ChatDeltaPlan|null} The plan, a noop marker, or null (full save)
 */
export function buildChatDeltaRequest({ chatKey, chatLength, headerLine, serializeMessage }) {
    if (!armed || !base || unsupported) return null;
    if (base.chatKey !== chatKey) return null;
    if (reconcileDue || deltasSinceFullSave >= RECONCILE_AFTER_DELTAS || bytesSinceFullSave >= RECONCILE_AFTER_BYTES) return null;

    const baseMessageCount = base.lineCount - 1;
    const appendCount = chatLength - baseMessageCount;
    // An append below the base line count is either a PRE-ARM leftover —
    // provably inside the arming full save's snapshot (mid-save appends
    // always land at >= baseMessageCount, since pushes extend the array
    // past the snapshot length), downgradable to a byte-identical touch —
    // or a POST-ARM record whose index only sank because an UNRECORDED
    // shrink happened: fail closed immediately.
    for (const [index, epoch] of [...appendedIndexes]) {
        if (!Number.isInteger(index) || index < 0) return null;
        if (index < baseMessageCount) {
            if (epoch >= armEpoch) return null;
            appendedIndexes.delete(index);
            touchedIndexes.set(index, epoch);
        } else if (index >= chatLength) {
            // Beyond the current end: pre-arm leftovers of messages that no
            // longer exist are droppable; a post-arm record out here means
            // an unrecorded shrink.
            if (epoch >= armEpoch) return null;
            appendedIndexes.delete(index);
        }
    }
    // The record COUNT must match the growth (a negative growth — an
    // unrecorded shrink — can never match either). An unrecorded GROWTH from an
    // unknown writer is not append-shaped in general — a middle INSERT
    // shifts every following row, and serializing only the tail would
    // write a shifted-stale middle to disk (real corruption, not merely
    // delayed persistence). Count equality forces those to a full save.
    // (No per-position check is needed beyond this: append ops serialize
    // every position in [baseMessageCount, chatLength) fresh from chat[].)
    if (appendedIndexes.size !== appendCount) return null;
    // Same pre-arm/post-arm split for touches that point past the end.
    for (const [index, epoch] of [...touchedIndexes]) {
        if (!Number.isInteger(index) || index < 0) return null;
        if (index >= chatLength) {
            if (epoch >= armEpoch) return null;
            touchedIndexes.delete(index);
        }
    }

    const headerChanged = headerLine !== base.headerLine;
    const replaceIndexes = [...touchedIndexes.keys()].filter(index => index < baseMessageCount).sort((a, b) => a - b);

    if (!headerChanged && replaceIndexes.length === 0 && appendCount === 0) {
        return { noop: true };
    }

    const ops = [];
    if (headerChanged) {
        ops.push({ op: 'header', line: headerLine });
    }
    for (const index of replaceIndexes) {
        ops.push({ op: 'replace', index, line: serializeMessage(index) });
    }
    if (appendCount > 0) {
        const lines = [];
        for (let index = baseMessageCount; index < chatLength; index++) {
            lines.push(serializeMessage(index));
        }
        ops.push({ op: 'append', lines });
    }

    // The consumed entries are swapped out so mutations landing while the
    // request is in flight accumulate separately (and survive the ack). On
    // failure the whole ledger is poisoned, so nothing needs restoring.
    appendedIndexes = new Map();
    touchedIndexes = new Map();

    return {
        base: { lineCount: base.lineCount, fileSize: base.fileSize, integrity: base.integrity },
        ops,
        headerLine,
        projectedLineCount: 1 + chatLength,
    };
}
