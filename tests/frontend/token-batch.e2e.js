/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Equivalence tests for batched token counting (public/scripts/tokenizers.js,
 * src/endpoints/tokenizers.js). Batching only pre-fills the token cache with
 * one request per chunk; the per-item code paths still run and read the cache.
 * These tests pin down the invariant that every batched number is identical
 * to what the original per-item requests return for the same input.
 */

// Models resolved by the server-side getTokenizerModel() mapping, covering the
// Tiktoken branch (incl. the gpt-3.5-turbo-0301 padding quirks), the
// WebTokenizer branch, and the Sentencepiece branch.
const CHAT_MODELS = ['gpt-4', 'gpt-3.5-turbo', 'gpt-3.5-turbo-0301', 'claude', 'llama3', 'mistral', 'gemma'];

const CHAT_MESSAGES = [
    { role: 'user', content: 'Hello there, how are you today?' },
    { role: 'assistant', content: 'I am *fine*, thank you!\n\n```js\nconsole.log(42);\n```' },
    { role: 'system', content: '你好，世界！こんにちは、世界！🌸🌸🌸' },
    { role: 'user', content: 'A named message with attribution.', name: 'Seraphina' },
    { role: 'system', content: '' },
    { role: 'assistant', tool_calls: '[{"id":"call_1","type":"function","function":{"arguments":"{\\"city\\":\\"Paris\\"}","name":"get_weather"}}]' },
    { role: 'user', content: 'word '.repeat(500).trim() },
];

// Tokenizers with bundled model files (no network download on first use).
const TEXT_TOKENIZERS = ['llama', 'mistral', 'gemma', 'yi', 'jamba', 'gpt2', 'claude', 'llama3'];

const BASE_TEXTS = [
    'Hello world!',
    '你好，世界！',
    'A longer paragraph with several sentences. It contains "quotes", *emphasis*, and\nnewlines to exercise the tokenizer.',
    '🌸 emoji and `inline code` mixed together',
    'word '.repeat(200).trim(),
];

test.describe('Token count batching', () => {
    test.beforeEach(testSetup.awaitST);

    test('batch chat completion counts equal per-message request counts', async ({ page }) => {
        test.setTimeout(120000);
        for (const model of CHAT_MODELS) {
            const { singles, batch } = await page.evaluate(async ({ model, messages }) => {
                const { getRequestHeaders } = await import('/script.js');
                const headers = getRequestHeaders();
                const singles = [];
                for (const message of messages) {
                    const res = await fetch(`/api/tokenizers/openai/count?model=${model}`, {
                        method: 'POST', headers, body: JSON.stringify([message]),
                    });
                    singles.push((await res.json()).token_count);
                }
                const batchRes = await fetch(`/api/tokenizers/openai/count_batch?model=${model}`, {
                    method: 'POST', headers, body: JSON.stringify(messages),
                });
                const batch = (await batchRes.json()).token_counts;
                return { singles, batch };
            }, { model, messages: CHAT_MESSAGES });

            // Guard against degenerate all-zero equality (tokenizer failed to load).
            expect(singles.some(count => count > 0), `model ${model} returned sane counts`).toBe(true);
            expect(batch, `model ${model}`).toEqual(singles);
        }
    });

    test('batch text counts equal per-text encode request counts', async ({ page }) => {
        test.setTimeout(120000);
        const texts = ['', ...BASE_TEXTS];
        for (const name of TEXT_TOKENIZERS) {
            const { singles, batch } = await page.evaluate(async ({ name, texts }) => {
                const { getRequestHeaders } = await import('/script.js');
                const headers = getRequestHeaders();
                const singles = [];
                for (const text of texts) {
                    const res = await fetch(`/api/tokenizers/${name}/encode`, {
                        method: 'POST', headers, body: JSON.stringify({ text }),
                    });
                    singles.push((await res.json()).count);
                }
                const batchRes = await fetch(`/api/tokenizers/${name}/count_batch`, {
                    method: 'POST', headers, body: JSON.stringify({ texts }),
                });
                const batch = (await batchRes.json()).counts;
                return { singles, batch };
            }, { name, texts });

            expect(singles.some(count => count > 0), `tokenizer ${name} returned sane counts`).toBe(true);
            expect(batch, `tokenizer ${name}`).toEqual(singles);
        }
    });

    test('primed cache resolves getTokenCountAsync on the chat completion path', async ({ page }) => {
        // Salted texts guarantee a cold cache on repeated runs.
        const salt = Date.now().toString(36);
        const texts = BASE_TEXTS.map(text => `${text} #${salt}`);

        const traffic = { phase: 'idle', batches: 0, singles: 0 };
        page.on('request', (request) => {
            const url = request.url();
            if (url.includes('/api/tokenizers/openai/count_batch')) traffic.batches++;
            else if (url.includes('/api/tokenizers/openai/count') && traffic.phase === 'read-back') traffic.singles++;
        });

        // Expected values straight from the per-item endpoint, bypassing the
        // frontend cache: getTokenCountAsync on the openai branch returns the
        // raw single-request count minus one (running total starts at -1).
        const expected = await page.evaluate(async (texts) => {
            const { getRequestHeaders } = await import('/script.js');
            const { getTokenizerModel } = await import('/scripts/tokenizers.js');
            const headers = getRequestHeaders();
            const out = [];
            for (const text of texts) {
                const res = await fetch(`/api/tokenizers/openai/count?model=${getTokenizerModel()}`, {
                    method: 'POST', headers, body: JSON.stringify([{ role: 'system', content: text }]),
                });
                out.push((await res.json()).token_count - 1);
            }
            return out;
        }, texts);

        traffic.phase = 'prime';
        await page.evaluate(async (texts) => {
            const { primeTokenCountsAsync } = await import('/scripts/tokenizers.js');
            await primeTokenCountsAsync(texts);
        }, texts);

        traffic.phase = 'read-back';
        const actual = await page.evaluate(async (texts) => {
            const { getTokenCountAsync } = await import('/scripts/tokenizers.js');
            const out = [];
            for (const text of texts) {
                out.push(await getTokenCountAsync(text));
            }
            return out;
        }, texts);

        expect(actual).toEqual(expected);
        expect(traffic.batches, 'priming issued one batched request').toBe(1);
        expect(traffic.singles, 'read-back was fully served from cache').toBe(0);
    });

    test('primed cache resolves getTokenCountAsync on the text completion path', async ({ page }) => {
        // This test flips main_api in the UI; swallow settings saves so the
        // temporary state never persists for other tests.
        await page.route('**/api/settings/save', route => route.fulfill({ status: 200, body: '{}' }));

        const salt = Date.now().toString(36);
        const texts = BASE_TEXTS.map(text => `${text} #${salt}`);

        const traffic = { phase: 'idle', batches: 0, singles: 0 };
        page.on('request', (request) => {
            const url = request.url();
            if (url.includes('/api/tokenizers/llama3/count_batch')) traffic.batches++;
            else if (url.includes('/api/tokenizers/llama3/encode') && traffic.phase === 'read-back') traffic.singles++;
        });

        // Text path caches the endpoint count plus padding (0 by default).
        const expected = await page.evaluate(async (texts) => {
            const { getRequestHeaders } = await import('/script.js');
            const headers = getRequestHeaders();
            const out = [];
            for (const text of texts) {
                const res = await fetch('/api/tokenizers/llama3/encode', {
                    method: 'POST', headers, body: JSON.stringify({ text }),
                });
                out.push((await res.json()).count);
            }
            return out;
        }, texts);

        try {
            traffic.phase = 'prime';
            await page.evaluate(async (texts) => {
                const { power_user } = await import('/scripts/power-user.js');
                const { primeTokenCountsAsync, tokenizers } = await import('/scripts/tokenizers.js');
                globalThis.__previousTokenizer = power_user.tokenizer;
                globalThis.jQuery('#main_api').val('textgenerationwebui').trigger('change');
                power_user.tokenizer = tokenizers.LLAMA3;
                await primeTokenCountsAsync(texts);
            }, texts);

            traffic.phase = 'read-back';
            const actual = await page.evaluate(async (texts) => {
                const { getTokenCountAsync } = await import('/scripts/tokenizers.js');
                const out = [];
                for (const text of texts) {
                    out.push(await getTokenCountAsync(text));
                }
                return out;
            }, texts);

            expect(actual).toEqual(expected);
            expect(traffic.batches, 'priming issued one batched request').toBe(1);
            expect(traffic.singles, 'read-back was fully served from cache').toBe(0);
        } finally {
            traffic.phase = 'idle';
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                power_user.tokenizer = globalThis.__previousTokenizer;
                globalThis.jQuery('#main_api').val('openai').trigger('change');
            });
        }
    });

    test('chat history dry run counts in batches and every batched number matches a single request', async ({ page }) => {
        test.setTimeout(240000);

        /** @type {{url: string, payload: object[], counts: number[]}[]} */
        const batches = [];
        page.on('response', (response) => {
            if (!response.url().includes('/api/tokenizers/openai/count_batch')) return;
            batches.push(response.json().then(data => ({
                url: response.url(),
                payload: response.request().postDataJSON(),
                counts: data.token_counts,
            })));
        });

        const mainApi = await page.evaluate(() => globalThis.SillyTavern.getContext().mainApi);
        expect(mainApi, 'test environment must use the chat completion API').toBe('openai');

        await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();
            await ctx.executeSlashCommandsWithOptions('/go Seraphina');
            await ctx.openCharacterChat('PerfBench-200k');
        });

        const dryRunError = await page.evaluate(async () => {
            const { oai_settings } = await import('/scripts/openai.js');
            // COMPLETION names behavior exercises the { role, content, name }
            // variant counted by Message.setName. In-memory only; the settings
            // endpoint is not called by a dry run.
            oai_settings.names_behavior = 1;
            try {
                await globalThis.SillyTavern.getContext().generate('normal', {}, true);
                return null;
            } catch (error) {
                return String(error);
            }
        });
        expect(dryRunError).toBeNull();

        // Priming is awaited inside the dry run, but the network events may
        // trail the evaluate return by a moment.
        await expect.poll(() => batches.length, { timeout: 5000 }).toBeGreaterThan(0);
        const resolvedBatches = await Promise.all(batches);

        // Replay a capped sample of real batch traffic item by item against
        // the single-message endpoint; every number must match exactly.
        for (const batch of resolvedBatches.slice(0, 3)) {
            const sample = batch.payload.slice(0, 64);
            const singles = await page.evaluate(async ({ url, payload }) => {
                const { getRequestHeaders } = await import('/script.js');
                const headers = getRequestHeaders();
                const singleUrl = url.replace('/count_batch', '/count');
                const out = [];
                for (const message of payload) {
                    const res = await fetch(singleUrl, {
                        method: 'POST', headers, body: JSON.stringify([message]),
                    });
                    out.push((await res.json()).token_count);
                }
                return out;
            }, { url: batch.url, payload: sample });

            expect(singles.some(count => count > 0), 'replay returned sane counts').toBe(true);
            expect(batch.counts.slice(0, sample.length)).toEqual(singles);
        }
    });

    test('out-of-budget messages with state-changing macros are never substituted', async ({ page }) => {
        test.setTimeout(120000);

        const readProbe = () => page.evaluate(async () => {
            const result = await globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions('/getvar batchprobe');
            return result?.pipe ?? '';
        });

        // Build an in-memory chat where the macro message sits INSIDE the
        // first priming chunk (pool position 3 of 8) but BEYOND the budget
        // break of a small context window: without the macro gate, chunked
        // preparation would substitute it; the original per-message path
        // never reaches it. The macro must not be chat[0] — Generate()
        // substitutes the very first message unconditionally by design
        // ("First message in fresh 1-on-1 chat reacts to settings changes").
        // Nothing here is saved to disk.
        await page.evaluate(async () => {
            await globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
            // Chat load rebuilds the chat array; take a fresh snapshot after it.
            const ctx = globalThis.SillyTavern.getContext();
            await ctx.executeSlashCommandsWithOptions('/flushvar batchprobe');
            const { oai_settings } = await import('/scripts/openai.js');
            globalThis.__savedMaxContext = oai_settings.openai_max_context;
            globalThis.__savedMaxTokens = oai_settings.openai_max_tokens;
            ctx.chat.splice(0, ctx.chat.length);
            ctx.chat.push({ name: 'Seraphina', is_user: false, send_date: Date.now(), mes: 'A plain greeting without any macros.' });
            ctx.chat.push({ name: 'User', is_user: true, send_date: Date.now(), mes: 'probe start {{setvar::batchprobe::polluted}} probe end' });
            // ~1500 tokens per filler: with a 3000-token window and a tiny
            // response reservation, exactly one filler fits regardless of the
            // character card's size (anywhere between 0 and ~1300 tokens).
            for (let i = 0; i < 3; i++) {
                ctx.chat.push({
                    name: i % 2 === 1 ? 'User' : 'Seraphina',
                    is_user: i % 2 === 1,
                    send_date: Date.now(),
                    mes: `Filler sentence number ${i} keeps the budget busy. `.repeat(150),
                });
            }
        });

        // Small window: the budget must break among the fillers — after the
        // history population actually ran — so the macro message is inside
        // the first priming chunk but never reached by the loop.
        const negative = await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();
            const { oai_settings } = await import('/scripts/openai.js');
            let promptChat = null;
            const handler = (data) => { promptChat = data.chat; };
            ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
            oai_settings.openai_max_context = 3000;
            oai_settings.openai_max_tokens = 50;
            let error = null;
            try {
                await ctx.generate('normal', {}, true);
            } catch (e) {
                error = String(e);
            }
            ctx.eventSource.removeListener(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
            return {
                error,
                fillersIncluded: Array.isArray(promptChat) ? promptChat.filter(x => String(x.content ?? '').includes('Filler sentence')).length : -1,
                probeIncluded: Array.isArray(promptChat) ? promptChat.some(x => String(x.content ?? '').includes('probe start')) : null,
            };
        });
        expect(negative.error).toBeNull();
        expect(negative.fillersIncluded, 'history population ran and included some fillers').toBeGreaterThan(0);
        expect(negative.probeIncluded, 'budget broke before the macro message').toBe(false);
        expect(await readProbe()).not.toBe('polluted');

        // Control: with a large window the macro message is inside the budget
        // and substitution runs, proving the probe actually works.
        await page.evaluate(async () => {
            const { oai_settings } = await import('/scripts/openai.js');
            oai_settings.openai_max_context = 100000;
            await globalThis.SillyTavern.getContext().generate('normal', {}, true);
            oai_settings.openai_max_context = globalThis.__savedMaxContext;
            oai_settings.openai_max_tokens = globalThis.__savedMaxTokens;
        });
        expect(await readProbe()).toBe('polluted');
    });
});
