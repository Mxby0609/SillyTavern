import { getRequestCompressionConfig } from './request-compression.js';

/**
 * Off-main-thread serializer for chat-save payloads (unit R2.2b; JSONL
 * contract since R3.2 — the worker now produces the chat FILE bytes for
 * /api/chats/save-raw and reports their uncompressed size/line count so
 * the delta ledger can arm on them).
 *
 * The main thread hands the message array to a dedicated worker via
 * structured clone and receives the finished request body back as a
 * transferred Uint8Array (zero-copy). The per-message JSON.stringify +
 * UTF-8 encode + gzip that used to freeze the UI for the duration of the
 * save happen in the worker. NOTE: at multi-MB chat sizes the structured
 * clone itself is the dominant remaining main-thread cost of a FULL save —
 * which is why hot actions go through the delta ledger and skip this
 * entirely.
 *
 * Scope (per plan review): serialization and compression ONLY. Fetch,
 * request headers/CSRF, and the save-integrity flow stay in saveChat on
 * the main thread, unchanged.
 *
 * Every failure path returns null and the caller falls back to the
 * original inline path (JSON.stringify + compressRequest), so a broken or
 * slow worker can never lose a save:
 * - worker construction fails -> permanently marked broken, null forever
 * - postMessage clone fails (exotic payload) -> null for this call
 * - worker errors or replies malformed -> null for this call
 * - no reply within SERIALIZE_TIMEOUT_MS -> null for this call (a late
 *   reply is dropped; slow is not treated as broken)
 */

const SERIALIZE_TIMEOUT_MS = 10000;

/** @type {Worker|null} */
let worker = null;
let workerBroken = false;
let nextRequestId = 0;
/** @typedef {{body: Uint8Array, gzip: boolean, rawByteLength: number, rawLineCount: number}} SerializedChatSave */
/** @type {Map<number, { resolve: (value: SerializedChatSave) => void, reject: (reason: Error) => void }>} */
const pendingRequests = new Map();

function rejectAllPending(reason) {
    for (const entry of pendingRequests.values()) {
        entry.reject(new Error(reason));
    }
    pendingRequests.clear();
}

/** @returns {Worker|null} */
function getWorker() {
    if (workerBroken) {
        return null;
    }
    if (worker) {
        return worker;
    }
    try {
        worker = new Worker(new URL('./chat-save-worker.js', import.meta.url), { type: 'module' });
        worker.addEventListener('message', (event) => {
            const { id, ok, body, gzip, rawByteLength, rawLineCount, error } = event.data ?? {};
            const entry = pendingRequests.get(id);
            if (!entry) {
                return;
            }
            pendingRequests.delete(id);
            if (ok && body instanceof Uint8Array && Number.isInteger(rawByteLength) && Number.isInteger(rawLineCount)) {
                entry.resolve({ body, gzip: Boolean(gzip), rawByteLength, rawLineCount });
            } else {
                entry.reject(new Error(error || 'Malformed worker reply'));
            }
        });
        worker.addEventListener('error', (event) => {
            console.warn('Chat save worker failed, falling back to inline serialization.', event.message);
            workerBroken = true;
            rejectAllPending('Chat save worker errored');
            worker?.terminate();
            worker = null;
        });
    } catch (error) {
        console.warn('Chat save worker could not be created, using inline serialization.', error);
        workerBroken = true;
        worker = null;
    }
    return worker;
}

/**
 * Serializes (and, per server config, compresses) chat file content off
 * the main thread.
 * @param {object} payload Save content
 * @param {string} payload.headerLine Pre-serialized header line (line 0)
 * @param {object[]} payload.messages Message objects to serialize as JSONL lines
 * @returns {Promise<SerializedChatSave|null>} The finished request body and
 * its uncompressed size/line count, or null when the caller must use the
 * inline fallback path.
 */
export async function serializeChatSaveOffThread({ headerLine, messages }) {
    const activeWorker = getWorker();
    if (!activeWorker) {
        return null;
    }

    const id = nextRequestId++;
    /** @type {Promise<SerializedChatSave>} */
    const reply = new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
    });

    try {
        activeWorker.postMessage({ id, headerLine, messages, compression: getRequestCompressionConfig() });
    } catch (error) {
        // Structured clone refused the payload — inline path handles it.
        pendingRequests.delete(id);
        console.warn('Chat save payload could not be cloned to the worker.', error);
        return null;
    }

    let timeoutId = null;
    try {
        return await Promise.race([
            reply,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('timeout')), SERIALIZE_TIMEOUT_MS);
            }),
        ]);
    } catch (error) {
        pendingRequests.delete(id);
        console.warn('Chat save worker did not deliver, using inline serialization.', error);
        return null;
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}
