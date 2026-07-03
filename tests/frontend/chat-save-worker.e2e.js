/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Equivalence tests for the off-main-thread chat-save serializer (R2.2b):
 * - the worker-produced body decodes to exactly the JSON the inline path
 *   produces (gzip and plain variants);
 * - failure paths return null so saveChat uses the inline path (a broken
 *   worker must never lose a save);
 * - end-to-end: a real saveChat request body round-trips to the full chat
 *   content with the header first.
 */

test.describe('Chat save serializer', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
    });

    test('worker body decodes to the exact inline JSON (gzip on and off)', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { serializeChatSaveOffThread } = await import('/scripts/chat-save-serializer.js');
            const { setRequestCompressionConfig, getRequestCompressionConfig } = await import('/scripts/request-compression.js');

            const gunzip = async (bytes) => new Uint8Array(
                await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
            );

            const payload = {
                ch_name: 'Tester 测试 🐉',
                file_name: 'equiv-check',
                chat: [
                    { user_name: 'User', character_name: 'Tester 测试 🐉', chat_metadata: { note: 'unicode ✓', nested: { a: [1, 2, 3], b: null } } },
                    { name: 'User', is_user: true, mes: 'multi\nline "quoted" text with \\ backslash', extra: {} },
                    { name: 'Tester 测试 🐉', is_user: false, mes: 'emoji 🎈 and 中文和日本語', swipes: ['one', 'two'], extra: { reasoning: 'x'.repeat(4096) } },
                ],
                avatar_url: 'tester.png',
                force: false,
            };
            const inlineJson = JSON.stringify(payload);
            const previousConfig = getRequestCompressionConfig();

            try {
                // Compression on, no size gates: worker must gzip.
                setRequestCompressionConfig({ enabled: true, minPayloadSize: 0, maxPayloadSize: 0, timeout: 5000 });
                const compressed = await serializeChatSaveOffThread(payload);

                // Compression off: worker must return plain bytes.
                setRequestCompressionConfig({ enabled: false, minPayloadSize: 0, maxPayloadSize: 0, timeout: 5000 });
                const plain = await serializeChatSaveOffThread(payload);

                // Compression on but timeout 0: gzip cannot finish in time,
                // so — mirroring compressRequest's timeout semantics — the
                // save goes out PLAIN (not null, no inline fallback).
                setRequestCompressionConfig({ enabled: true, minPayloadSize: 0, maxPayloadSize: 0, timeout: 0 });
                const timedOut = await serializeChatSaveOffThread(payload);

                const decoder = new TextDecoder();
                return {
                    compressedGzipFlag: compressed?.gzip ?? null,
                    compressedSmaller: compressed ? compressed.body.byteLength < new TextEncoder().encode(inlineJson).byteLength : null,
                    compressedDecodes: compressed ? decoder.decode(await gunzip(compressed.body)) === inlineJson : null,
                    plainGzipFlag: plain?.gzip ?? null,
                    plainDecodes: plain ? decoder.decode(plain.body) === inlineJson : null,
                    timedOutIsNull: timedOut === null,
                    timedOutGzipFlag: timedOut?.gzip ?? null,
                    timedOutDecodes: timedOut ? decoder.decode(timedOut.body) === inlineJson : null,
                };
            } finally {
                setRequestCompressionConfig(previousConfig);
            }
        });

        expect(results.compressedGzipFlag, 'eligible payload is gzipped').toBe(true);
        expect(results.compressedSmaller, 'gzipped body is smaller than the JSON').toBe(true);
        expect(results.compressedDecodes, 'gzipped body decompresses to the exact inline JSON').toBe(true);
        expect(results.plainGzipFlag, 'disabled compression returns plain bytes').toBe(false);
        expect(results.plainDecodes, 'plain body decodes to the exact inline JSON').toBe(true);
        expect(results.timedOutIsNull, 'compression timeout is not a worker failure').toBe(false);
        expect(results.timedOutGzipFlag, 'compression timeout sends plain, like compressRequest').toBe(false);
        expect(results.timedOutDecodes, 'timed-out body still decodes to the exact inline JSON').toBe(true);
    });

    test('uncloneable payloads fall back to null instead of throwing', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { serializeChatSaveOffThread } = await import('/scripts/chat-save-serializer.js');
            // Functions cannot be structured-cloned: postMessage throws
            // synchronously and the serializer must return null (inline
            // fallback), not propagate.
            const poisoned = { chat: [], oops: () => {} };
            try {
                return { value: await serializeChatSaveOffThread(poisoned), threw: false };
            } catch {
                return { value: undefined, threw: true };
            }
        });

        expect(result.threw, 'clone failure must not propagate').toBe(false);
        expect(result.value, 'clone failure yields null (inline fallback)').toBeNull();
    });

    test('saveChat request body round-trips the chat content', async ({ page }) => {
        /** @type {{ buffer: number[], gzip: boolean } | null} */
        let captured = null;
        await page.route('**/api/chats/save', async (route) => {
            const buffer = route.request().postDataBuffer();
            captured = {
                buffer: Array.from(new Uint8Array(buffer ?? Buffer.alloc(0))),
                gzip: (await route.request().allHeaders())['content-encoding'] === 'gzip',
            };
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":"ok"}' });
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
            };
        });

        await page.unroute('**/api/chats/save');
        expect(captured, 'a save request was captured').not.toBeNull();

        const decoded = await page.evaluate(async ({ buffer, gzip }) => {
            const bytes = new Uint8Array(buffer);
            const text = gzip
                ? new TextDecoder().decode(new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()))
                : new TextDecoder().decode(bytes);
            const parsed = JSON.parse(text);
            return {
                entries: parsed.chat.length,
                hasHeader: typeof parsed.chat[0] === 'object' && 'chat_metadata' in parsed.chat[0],
                lastMes: parsed.chat.length > 1 ? String(parsed.chat[parsed.chat.length - 1].mes) : null,
            };
        }, captured);

        // parsed.chat = [header, ...messages]
        expect(decoded.hasHeader, 'first entry is the chat header').toBe(true);
        expect(decoded.entries, 'body contains header + all messages').toBe(state.chatLength + 1);
        expect(decoded.lastMes, 'last message text round-trips exactly').toBe(state.lastMes);
    });
});
