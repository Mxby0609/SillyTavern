/**
 * Chat-save serialization worker: JSON.stringify + UTF-8 encode + optional
 * gzip, off the main thread. Deliberately dependency-free — the lib.js
 * bundle may touch window/document at import time, so compression uses the
 * native CompressionStream (available in all Chromium/WebKit/Gecko versions
 * SillyTavern supports); when unavailable the plain bytes are returned and
 * the request goes out uncompressed, exactly like a disabled-compression
 * config today.
 *
 * Message in:  { id, payload, compression: { enabled, minPayloadSize,
 *                maxPayloadSize, timeout } }
 * Message out: { id, ok: true, body: Uint8Array, gzip: boolean }
 *              (body transferred, zero-copy) or { id, ok: false, error }
 */

/**
 * @param {Uint8Array} bytes Bytes to compress
 * @returns {Promise<Uint8Array>} Gzip-compressed bytes
 */
async function gzipBytes(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

/**
 * Compresses with the SAME timeout semantics as compressRequest on the
 * main thread: when compression does not finish within the configured
 * timeout (or fails), the save goes out as plain bytes — the timeout
 * bounds how long a save may wait on compression, it is not an error.
 * @param {Uint8Array} bytes Bytes to compress
 * @param {number} timeoutMs Configured compression timeout in milliseconds
 * @returns {Promise<Uint8Array|null>} Compressed bytes, or null meaning "send plain"
 */
async function gzipBytesWithTimeout(bytes, timeoutMs) {
    let timeoutId = null;
    try {
        return await Promise.race([
            gzipBytes(bytes),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('compress_timeout')), Number(timeoutMs) || 0);
            }),
        ]);
    } catch {
        return null;
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}

self.addEventListener('message', async (event) => {
    const { id, payload, compression } = event.data;
    try {
        const json = JSON.stringify(payload);
        const bytes = new TextEncoder().encode(json);

        let body = bytes;
        let gzip = false;

        // Mirrors request-compression.js gating: enabled, size within
        // [minPayloadSize, maxPayloadSize], and the result must actually
        // be smaller than the input.
        const minBytes = Number(compression?.minPayloadSize) || 0;
        const maxBytes = Number(compression?.maxPayloadSize) || 0;
        const eligible = Boolean(compression?.enabled)
            && typeof CompressionStream === 'function'
            && bytes.byteLength >= minBytes
            && !(maxBytes > 0 && bytes.byteLength > maxBytes);

        if (eligible) {
            const compressed = await gzipBytesWithTimeout(bytes, compression?.timeout);
            if (compressed && compressed.byteLength < bytes.byteLength) {
                body = compressed;
                gzip = true;
            }
        }

        self.postMessage({ id, ok: true, body, gzip }, [body.buffer]);
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error instanceof Error ? error.message : error) });
    }
});
