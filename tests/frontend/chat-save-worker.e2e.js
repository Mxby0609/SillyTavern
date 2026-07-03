/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Equivalence tests for the off-main-thread chat-save serializer (R2.2b,
 * JSONL contract since R3.2):
 * - the worker-produced body decodes to exactly the JSONL an inline
 *   serialization produces (gzip and plain variants), and the reported
 *   rawByteLength/rawLineCount match those bytes;
 * - failure paths return null so saveChat uses the inline path (a broken
 *   worker must never lose a save);
 * - end-to-end: a real saveChat request rides /api/chats/save-raw and its
 *   body round-trips to the full chat file content with the header first.
 */

test.describe('Chat save serializer', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
    });

    test('worker body decodes to the exact inline JSONL (gzip on and off)', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { serializeChatSaveOffThread } = await import('/scripts/chat-save-serializer.js');
            const { setRequestCompressionConfig, getRequestCompressionConfig } = await import('/scripts/request-compression.js');

            const gunzip = async (bytes) => new Uint8Array(
                await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
            );

            const headerLine = JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: { note: 'unicode ✓', nested: { a: [1, 2, 3], b: null } } });
            const messages = [
                { name: 'User', is_user: true, mes: 'multi\nline "quoted" text with \\ backslash', extra: {} },
                { name: 'Tester 测试 🐉', is_user: false, mes: 'emoji 🎈 and 中文和日本語', swipes: ['one', 'two'], extra: { reasoning: 'x'.repeat(4096) } },
            ];
            const inlineJsonl = [headerLine, ...messages.map(m => JSON.stringify(m))].join('\n');
            const inlineBytes = new TextEncoder().encode(inlineJsonl);
            const previousConfig = getRequestCompressionConfig();

            try {
                // Compression on, no size gates: worker must gzip.
                setRequestCompressionConfig({ enabled: true, minPayloadSize: 0, maxPayloadSize: 0, timeout: 5000 });
                const compressed = await serializeChatSaveOffThread({ headerLine, messages });

                // Compression off: worker must return plain bytes.
                setRequestCompressionConfig({ enabled: false, minPayloadSize: 0, maxPayloadSize: 0, timeout: 5000 });
                const plain = await serializeChatSaveOffThread({ headerLine, messages });

                // Compression on but timeout 0: gzip cannot finish in time,
                // so — mirroring compressRequest's timeout semantics — the
                // save goes out PLAIN (not null, no inline fallback).
                setRequestCompressionConfig({ enabled: true, minPayloadSize: 0, maxPayloadSize: 0, timeout: 0 });
                const timedOut = await serializeChatSaveOffThread({ headerLine, messages });

                const decoder = new TextDecoder();
                return {
                    compressedGzipFlag: compressed?.gzip ?? null,
                    compressedSmaller: compressed ? compressed.body.byteLength < inlineBytes.byteLength : null,
                    compressedDecodes: compressed ? decoder.decode(await gunzip(compressed.body)) === inlineJsonl : null,
                    compressedRawSize: compressed?.rawByteLength ?? null,
                    compressedRawLines: compressed?.rawLineCount ?? null,
                    plainGzipFlag: plain?.gzip ?? null,
                    plainDecodes: plain ? decoder.decode(plain.body) === inlineJsonl : null,
                    plainRawSize: plain?.rawByteLength ?? null,
                    timedOutIsNull: timedOut === null,
                    timedOutGzipFlag: timedOut?.gzip ?? null,
                    timedOutDecodes: timedOut ? decoder.decode(timedOut.body) === inlineJsonl : null,
                    expectedRawSize: inlineBytes.byteLength,
                    expectedRawLines: 1 + messages.length,
                };
            } finally {
                setRequestCompressionConfig(previousConfig);
            }
        });

        expect(results.compressedGzipFlag, 'eligible payload is gzipped').toBe(true);
        expect(results.compressedSmaller, 'gzipped body is smaller than the JSONL').toBe(true);
        expect(results.compressedDecodes, 'gzipped body decompresses to the exact inline JSONL').toBe(true);
        expect(results.compressedRawSize, 'reported raw size matches the uncompressed bytes').toBe(results.expectedRawSize);
        expect(results.compressedRawLines, 'reported line count is header + messages').toBe(results.expectedRawLines);
        expect(results.plainGzipFlag, 'disabled compression returns plain bytes').toBe(false);
        expect(results.plainDecodes, 'plain body decodes to the exact inline JSONL').toBe(true);
        expect(results.plainRawSize, 'plain raw size matches the uncompressed bytes').toBe(results.expectedRawSize);
        expect(results.timedOutIsNull, 'compression timeout is not a worker failure').toBe(false);
        expect(results.timedOutGzipFlag, 'compression timeout sends plain, like compressRequest').toBe(false);
        expect(results.timedOutDecodes, 'timed-out body still decodes to the exact inline JSONL').toBe(true);
    });

    test('uncloneable payloads fall back to null instead of throwing', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { serializeChatSaveOffThread } = await import('/scripts/chat-save-serializer.js');
            // Functions cannot be structured-cloned: postMessage throws
            // synchronously and the serializer must return null (inline
            // fallback), not propagate.
            const messages = [{ mes: 'fine' }, { oops: () => {} }];
            try {
                return { value: await serializeChatSaveOffThread({ headerLine: '{}', messages }), threw: false };
            } catch {
                return { value: undefined, threw: true };
            }
        });

        expect(result.threw, 'clone failure must not propagate').toBe(false);
        expect(result.value, 'clone failure yields null (inline fallback)').toBeNull();
    });

    test('saveChat request body rides save-raw and round-trips the chat file content', async ({ page }) => {
        /** @type {{ buffer: number[], gzip: boolean, url: string } | null} */
        let captured = null;
        await page.route('**/api/chats/save-delta', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
        await page.route('**/api/chats/save-raw*', async (route) => {
            const buffer = route.request().postDataBuffer();
            captured = {
                buffer: Array.from(new Uint8Array(buffer ?? Buffer.alloc(0))),
                gzip: (await route.request().allHeaders())['content-encoding'] === 'gzip',
                url: route.request().url(),
            };
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        });

        const state = await page.evaluate(async () => {
            const { chat, saveChat } = await import('/script.js');
            const { setRequestCompressionConfig, getRequestCompressionConfig } = await import('/scripts/request-compression.js');
            const context = globalThis.SillyTavern.getContext();
            if (context.characterId === undefined && context.characters.length) {
                await context.executeSlashCommandsWithOptions(`/go ${context.characters[0].name}`);
            }
            // Force compression on (default config ships disabled) so this
            // test exercises the gzip body + Content-Encoding wiring.
            const previousConfig = getRequestCompressionConfig();
            setRequestCompressionConfig({ enabled: true, minPayloadSize: 0, maxPayloadSize: 0, timeout: 5000 });
            try {
                await saveChat();
            } finally {
                setRequestCompressionConfig(previousConfig);
            }
            return {
                chatLength: chat.length,
                lastMes: chat.length ? String(chat[chat.length - 1].mes) : null,
                fileName: context.getCurrentChatId(),
            };
        });

        await page.unroute('**/api/chats/save-raw*');
        await page.unroute('**/api/chats/save-delta');
        expect(captured, 'a save-raw request was captured').not.toBeNull();
        expect(decodeURIComponent(new URL(captured.url).searchParams.get('file_name')), 'file_name query routes the save').toBe(state.fileName);

        const decoded = await page.evaluate(async ({ buffer, gzip }) => {
            const bytes = new Uint8Array(buffer);
            const text = gzip
                ? new TextDecoder().decode(new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()))
                : new TextDecoder().decode(bytes);
            const lines = text.split('\n').map(line => JSON.parse(line));
            return {
                entries: lines.length,
                hasHeader: typeof lines[0] === 'object' && 'chat_metadata' in lines[0],
                lastMes: lines.length > 1 ? String(lines[lines.length - 1].mes) : null,
                noTrailingNewline: !text.endsWith('\n'),
            };
        }, captured);

        // JSONL = header line + one line per message, no trailing newline.
        expect(decoded.hasHeader, 'first line is the chat header').toBe(true);
        expect(decoded.noTrailingNewline, 'file content carries no trailing newline').toBe(true);
        expect(decoded.entries, 'body contains header + all messages').toBe(state.chatLength + 1);
        expect(decoded.lastMes, 'last message text round-trips exactly').toBe(state.lastMes);
    });
});
