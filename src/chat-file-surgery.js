import fs from 'node:fs';
import crypto from 'node:crypto';
import process from 'node:process';

/**
 * Byte-level surgery on chat JSONL files, so hot-path saves (append a
 * message, replace the last message, rewrite the metadata header) never
 * re-serialize or re-parse the whole multi-MB chat on either side of the
 * wire. Deliberately dependency-free (node builtins only) so the engine is
 * unit-testable without the server bootstrap.
 *
 * Correctness stance (v1): no persistent line-index cache — every request
 * re-scans the target file (a sequential byte scan, no JSON parsing), so
 * there is no cache-invalidation surface. Appends are protected by a tiny
 * fsync'd sidecar journal; recovery only ever touches the file tail when
 * the tail is PROVABLY a prefix of the journaled payload, so a stale
 * journal can never damage a newer foreign write.
 */

export const APPEND_JOURNAL_SUFFIX = '.append-journal';

const NEWLINE = 0x0A;

let tempCounter = 0;

/** Thrown when the file on disk does not match the client's declared base state. Maps to HTTP 409. */
export class BaseMismatchError extends Error {
    /** @param {string} message Reason for the mismatch */
    constructor(message) {
        super(message);
        this.name = 'BaseMismatchError';
    }
}

/** Thrown when the delta request itself is malformed. Maps to HTTP 400. */
export class InvalidDeltaError extends Error {
    /** @param {string} message Reason the delta is invalid */
    constructor(message) {
        super(message);
        this.name = 'InvalidDeltaError';
    }
}

/**
 * @typedef {object} DeltaOp
 * @property {string} op One of: append, header, replaceLast, replace, truncate
 * @property {string[]} [lines] Serialized JSON lines (append)
 * @property {string} [line] Serialized JSON line (header/replaceLast/replace)
 * @property {number} [index] Message index (replace)
 * @property {number} [fromIndex] First message index to drop (truncate)
 */

/**
 * @typedef {object} DeltaBase
 * @property {number} lineCount Expected number of lines in the file (header + messages)
 * @property {number} fileSize Expected file size in bytes
 * @property {string} [integrity] Expected integrity slug from the header line
 */

/**
 * @typedef {object} DeltaResult
 * @property {number} lineCount Line count after the delta was applied
 * @property {number} fileSize File size in bytes after the delta was applied
 */

const fileQueues = new Map();

/**
 * Serializes work per file path so concurrent saves cannot interleave.
 * @param {string} filePath File the work operates on
 * @param {() => Promise<any>} work Operation to run once the queue drains
 * @returns {Promise<any>} Result of the work
 */
export function enqueueFileOperation(filePath, work) {
    const tail = fileQueues.get(filePath) ?? Promise.resolve();
    const run = tail.then(() => work());
    const guarded = run.catch(() => { });
    fileQueues.set(filePath, guarded);
    guarded.then(() => {
        if (fileQueues.get(filePath) === guarded) {
            fileQueues.delete(filePath);
        }
    });
    return run;
}

/**
 * @param {Buffer} buffer Bytes to hash
 * @returns {string} Hex SHA-1 of the buffer
 */
function sha1Hex(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
}

/**
 * @param {string} text Possible JSON
 * @returns {any} Parsed value or null
 */
function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Scans a JSONL file for line-start byte offsets without parsing content.
 * @param {string} filePath File to scan
 * @returns {Promise<{size: number, offsets: number[]}>} Total size and byte offset of each line start
 */
export async function scanJsonlOffsets(filePath) {
    return new Promise((resolve, reject) => {
        const offsets = [];
        let position = 0;
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (position === 0 && buffer.length > 0 && offsets.length === 0) {
                offsets.push(0);
            }
            let searchFrom = 0;
            for (;;) {
                const nl = buffer.indexOf(NEWLINE, searchFrom);
                if (nl === -1) break;
                offsets.push(position + nl + 1);
                searchFrom = nl + 1;
            }
            position += buffer.length;
        });
        stream.on('end', () => resolve({ size: position, offsets }));
        stream.on('error', reject);
    });
}

/**
 * Reads an exact byte range from a file.
 * @param {string} filePath File to read
 * @param {number} start Byte offset to start at
 * @param {number} length Number of bytes
 * @returns {Promise<Buffer>} The bytes
 */
async function readByteRange(filePath, start, length) {
    if (length <= 0) return Buffer.alloc(0);
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/**
 * Writes a buffer to a file atomically (temp file + fsync + rename).
 * @param {string} filePath Destination path
 * @param {Buffer} buffer Content
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, buffer) {
    const tempPath = `${filePath}.tmp-${process.pid}-${++tempCounter}`;
    const handle = await fs.promises.open(tempPath, 'w');
    try {
        await handle.writeFile(buffer);
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await fs.promises.rename(tempPath, filePath);
    } catch (error) {
        await fs.promises.unlink(tempPath).catch(() => { });
        throw error;
    }
}

/**
 * Removes a pending append journal without touching the chat file. Full-save
 * paths call this after successfully rewriting the file, so a journal from a
 * pre-crash delta can never be replayed onto newer content.
 * @param {string} filePath Chat file path
 * @returns {Promise<void>}
 */
export async function discardAppendJournal(filePath) {
    await fs.promises.unlink(filePath + APPEND_JOURNAL_SUFFIX).catch(() => { });
}

/**
 * Recovers a chat file from a pending append journal, if one exists.
 *
 * Invariants: bytes below the journaled baseSize are never altered; the tail
 * above baseSize is only altered when it is provably a prefix of the
 * journaled payload (i.e. our own possibly-partial append). Anything else is
 * treated as a foreign write and left alone; the journal is always removed.
 * @param {string} filePath Chat file path
 * @returns {Promise<void>}
 */
export async function recoverAppendJournal(filePath) {
    const journalPath = filePath + APPEND_JOURNAL_SUFFIX;
    let journalBuffer;
    try {
        journalBuffer = await fs.promises.readFile(journalPath);
    } catch {
        return;
    }
    const removeJournal = () => fs.promises.unlink(journalPath).catch(() => { });

    const headerEnd = journalBuffer.indexOf(NEWLINE);
    const header = headerEnd > 0 ? tryParseJson(journalBuffer.subarray(0, headerEnd).toString('utf8')) : null;
    const headerValid = header !== null
        && Number.isInteger(header.baseSize) && header.baseSize >= 0
        && Number.isInteger(header.byteLength) && header.byteLength > 0
        && typeof header.sha1 === 'string';
    if (!headerValid) {
        // The journal write itself was cut short, which means the append
        // never started. The chat file is untouched.
        await removeJournal();
        return;
    }

    const payload = journalBuffer.subarray(headerEnd + 1);
    const payloadComplete = payload.length === header.byteLength && sha1Hex(payload) === header.sha1;

    let stats;
    try {
        stats = await fs.promises.stat(filePath);
    } catch {
        await removeJournal();
        return;
    }

    const tailLength = stats.size - header.baseSize;
    if (tailLength < 0) {
        // File shrank below the journaled base: a foreign write happened.
        // (Foreign GROWTH needs no guard here — a tail longer than the
        // payload can never equal a payload prefix, so the proof below
        // rejects it.)
        await removeJournal();
        return;
    }

    const tail = await readByteRange(filePath, header.baseSize, tailLength);
    const comparable = payload.subarray(0, Math.min(tailLength, payload.length));
    const tailIsOurs = tailLength === 0 || (tail.length === comparable.length && tail.equals(comparable));
    if (!tailIsOurs) {
        await removeJournal();
        return;
    }

    const handle = await fs.promises.open(filePath, 'r+');
    try {
        await handle.truncate(header.baseSize);
        if (payloadComplete) {
            await handle.write(payload, 0, payload.length, header.baseSize);
        }
        await handle.sync();
    } finally {
        await handle.close();
    }
    await removeJournal();
}

/**
 * Validates a single serialized JSONL line.
 * @param {any} line Candidate line
 * @param {string} label Error label
 * @returns {string} The validated line
 */
function validateLine(line, label) {
    if (typeof line !== 'string' || line.length === 0) {
        throw new InvalidDeltaError(`${label} must be a non-empty string`);
    }
    if (line.includes('\n') || line.includes('\r')) {
        throw new InvalidDeltaError(`${label} must not contain line breaks`);
    }
    const parsed = tryParseJson(line);
    if (parsed === null || typeof parsed !== 'object') {
        throw new InvalidDeltaError(`${label} must be a serialized JSON object`);
    }
    return line;
}

/**
 * Normalizes and validates the op list against the file's line count.
 * @param {DeltaOp[]} ops Raw ops from the request
 * @param {number} lineCount Current number of lines (header + messages)
 * @returns {{headerLine: string|null, replacements: Map<number, string>, truncateFrom: number|null, appends: string[]}} Normalized plan
 */
function normalizeOps(ops, lineCount) {
    if (!Array.isArray(ops) || ops.length === 0) {
        throw new InvalidDeltaError('ops must be a non-empty array');
    }
    const messageCount = lineCount - 1;
    /** @type {string|null} */
    let headerLine = null;
    const replacements = new Map();
    /** @type {number|null} */
    let truncateFrom = null;
    /** @type {string[]} */
    const appends = [];
    let sawReplaceLast = false;

    for (const op of ops) {
        if (op === null || typeof op !== 'object') {
            throw new InvalidDeltaError('each op must be an object');
        }
        switch (op.op) {
            case 'append': {
                if (!Array.isArray(op.lines) || op.lines.length === 0) {
                    throw new InvalidDeltaError('append.lines must be a non-empty array');
                }
                for (const line of op.lines) {
                    appends.push(validateLine(line, 'append line'));
                }
                break;
            }
            case 'header': {
                if (headerLine !== null) {
                    throw new InvalidDeltaError('at most one header op per request');
                }
                headerLine = validateLine(op.line, 'header line');
                break;
            }
            case 'replaceLast': {
                if (messageCount < 1) {
                    throw new InvalidDeltaError('replaceLast requires at least one message');
                }
                sawReplaceLast = true;
                const index = messageCount - 1;
                if (replacements.has(index)) {
                    throw new InvalidDeltaError('duplicate replacement for the last message');
                }
                replacements.set(index, validateLine(op.line, 'replaceLast line'));
                break;
            }
            case 'replace': {
                if (!Number.isInteger(op.index) || op.index < 0 || op.index > messageCount - 1) {
                    throw new InvalidDeltaError('replace.index out of range');
                }
                if (replacements.has(op.index)) {
                    throw new InvalidDeltaError('duplicate replacement for one message');
                }
                replacements.set(op.index, validateLine(op.line, 'replace line'));
                break;
            }
            case 'truncate': {
                if (truncateFrom !== null) {
                    throw new InvalidDeltaError('at most one truncate op per request');
                }
                if (!Number.isInteger(op.fromIndex) || op.fromIndex < 0 || op.fromIndex > messageCount - 1) {
                    throw new InvalidDeltaError('truncate.fromIndex out of range');
                }
                truncateFrom = op.fromIndex;
                break;
            }
            default:
                throw new InvalidDeltaError(`unknown op: ${String(op.op)}`);
        }
    }

    if (truncateFrom !== null && sawReplaceLast) {
        throw new InvalidDeltaError('truncate cannot be combined with replaceLast');
    }
    if (truncateFrom !== null) {
        for (const index of replacements.keys()) {
            if (index >= truncateFrom) {
                throw new InvalidDeltaError('replace targets a truncated message');
            }
        }
    }

    return { headerLine, replacements, truncateFrom, appends };
}

/**
 * Reads the integrity slug from the file's header line.
 * @param {string} filePath Chat file path
 * @param {{size: number, offsets: number[]}} scan Result of scanJsonlOffsets
 * @returns {Promise<string|null>} The slug or null
 */
async function readIntegritySlug(filePath, scan) {
    const headerEnd = scan.offsets.length > 1 ? scan.offsets[1] - 1 : scan.size;
    const headerBytes = await readByteRange(filePath, 0, headerEnd);
    const header = tryParseJson(headerBytes.toString('utf8'));
    const slug = header?.chat_metadata?.integrity;
    return typeof slug === 'string' ? slug : null;
}

/**
 * Applies a validated delta to a chat file. Callers must serialize calls per
 * file via enqueueFileOperation.
 * @param {string} filePath Chat file path
 * @param {DeltaBase} base Client's declared base state
 * @param {DeltaOp[]} ops Requested operations
 * @param {{enforceIntegrity?: boolean}} [options] Integrity enforcement toggle
 * @returns {Promise<DeltaResult>} Post-delta line count and file size
 */
export async function applyChatDelta(filePath, base, ops, options = {}) {
    if (base === null || typeof base !== 'object'
        || !Number.isInteger(base.lineCount) || base.lineCount < 1
        || !Number.isInteger(base.fileSize) || base.fileSize < 0) {
        throw new InvalidDeltaError('base must declare integer lineCount and fileSize');
    }

    await recoverAppendJournal(filePath);

    let scan;
    try {
        scan = await scanJsonlOffsets(filePath);
    } catch {
        // Missing/unreadable file: the client falls back to a full save,
        // which either creates the file or surfaces the real IO error.
        throw new BaseMismatchError('chat file cannot be read');
    }
    if (scan.size !== base.fileSize || scan.offsets.length !== base.lineCount) {
        throw new BaseMismatchError(`file state ${scan.offsets.length} lines / ${scan.size} bytes != expected ${base.lineCount} / ${base.fileSize}`);
    }

    if (options.enforceIntegrity && typeof base.integrity === 'string' && base.integrity.length > 0) {
        const fileSlug = await readIntegritySlug(filePath, scan);
        if (fileSlug !== null && fileSlug !== base.integrity) {
            throw new BaseMismatchError('integrity slug mismatch');
        }
    }

    const plan = normalizeOps(ops, scan.offsets.length);

    // Fast path: pure appends never rewrite existing bytes.
    if (plan.headerLine === null && plan.replacements.size === 0 && plan.truncateFrom === null) {
        const payload = Buffer.from('\n' + plan.appends.join('\n'), 'utf8');
        const journalPath = filePath + APPEND_JOURNAL_SUFFIX;
        const journalHeader = JSON.stringify({ baseSize: scan.size, byteLength: payload.length, sha1: sha1Hex(payload) });
        const journalHandle = await fs.promises.open(journalPath, 'w');
        try {
            await journalHandle.writeFile(Buffer.concat([Buffer.from(journalHeader + '\n', 'utf8'), payload]));
            await journalHandle.sync();
        } finally {
            await journalHandle.close();
        }
        await fs.promises.appendFile(filePath, payload);
        await fs.promises.unlink(journalPath).catch(() => { });
        return { lineCount: scan.offsets.length + plan.appends.length, fileSize: scan.size + payload.length };
    }

    // Surgery path: rebuild the file from byte slices + replacement lines,
    // then swap it in atomically. No JSON parse of existing content.
    const fileBuffer = await fs.promises.readFile(filePath);
    const lineEnd = (index) => (index + 1 < scan.offsets.length ? scan.offsets[index + 1] - 1 : scan.size);
    const keepLineCount = plan.truncateFrom !== null ? plan.truncateFrom + 1 : scan.offsets.length;

    /** @type {Buffer[]} */
    const parts = [];
    for (let index = 0; index < keepLineCount; index++) {
        if (index > 0) {
            parts.push(Buffer.from('\n', 'utf8'));
        }
        if (index === 0 && plan.headerLine !== null) {
            parts.push(Buffer.from(plan.headerLine, 'utf8'));
        } else if (index > 0 && plan.replacements.has(index - 1)) {
            parts.push(Buffer.from(/** @type {string} */(plan.replacements.get(index - 1)), 'utf8'));
        } else {
            parts.push(fileBuffer.subarray(scan.offsets[index], lineEnd(index)));
        }
    }
    for (const line of plan.appends) {
        parts.push(Buffer.from('\n', 'utf8'));
        parts.push(Buffer.from(line, 'utf8'));
    }

    const nextBuffer = Buffer.concat(parts);
    await atomicWriteFile(filePath, nextBuffer);
    return { lineCount: keepLineCount + plan.appends.length, fileSize: nextBuffer.length };
}
