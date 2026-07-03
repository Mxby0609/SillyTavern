/* eslint-env browser, es2022 */
/* eslint-disable playwright/no-wait-for-timeout, playwright/no-conditional-in-test, playwright/no-skipped-test */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * Phone-emulation performance runner.
 *
 * Reproduces the production environment (Android phone + Termux) on the dev
 * machine: CPU throttled via CDP, a 300k-token fixture chat with heavy
 * swipes (large FILE, not just large visible conversation), context window
 * raised to 300k. Measures the four user-reported freeze actions end to end:
 *
 *   - opening the chat            (chat-render at phone speed)
 *   - send preflight cold + hot   (prompt assembly before the network call)
 *   - swiping between existing replies (render + debounced save)
 *   - appending a user message    (the send-side DOM work)
 *   - bare chat save              (the tail every action shares)
 *   - save with 10/40 itemized prompts (each real generation keeps its
 *     FULL raw prompt; every save rewrites them all into IndexedDB —
 *     invisible in the other scenarios because nothing here really
 *     generates against a backend)
 *   - streaming + STOP            (real StreamingProcessor with a fake
 *     generator; measures stop-tap -> UI interactive, i.e. the final
 *     render + full-chat save path at script.js:5443)
 *
 * Freeze quantification: a PerformanceObserver('longtask') collects main-
 * thread blocks >50ms per scenario (blockedMs/blocks/longestMs) — this is
 * the "page frozen, can't scroll" number, separate from wall time.
 *
 * /api/chats/save is fulfilled locally: the JSON.stringify + gzip cost (the
 * part that blocks the UI) is still paid; only the server write is skipped.
 * This also keeps the fixture files byte-identical across runs.
 *
 * Prerequisites: node perf/generate-fixtures.js --messages 1200
 *   --chat-name PerfBench-300k --swipes 2   (plus the server on :8000)
 *
 * Run (never in the plain regression suite — requires PERF_PHONE):
 *   cd tests && PERF_PHONE=1 PERF_STAGE=phone6x-optimized \
 *     npx playwright test perf-phone --workers 1
 */

const CHAT_FILE = process.env.PERF_CHAT_FILE ?? 'PerfBench-300k';
const MIN_MESSAGES = Number(process.env.PERF_MIN_MESSAGES ?? 1100);
const WORLD_NAME = 'PerfBench';
const CHARACTER_NAME = 'Seraphina';
const CPU_THROTTLE = Number(process.env.PERF_CPU_RATE ?? 6);
const CONTEXT_TOKENS = 300000;
// All settle waits are paid at throttled speed; scale generously.
const SETTLE_MS = 3000;
const MEASURE_TIMEOUT_MS = 30000;

test.describe.configure({ mode: 'serial' });

test.describe('Phone-emulation performance', () => {
    test.skip(!process.env.PERF_PHONE, 'set PERF_PHONE=1 for dedicated phone-emulation measurement runs');

    test('collects phone-scale metrics for the 300k fixture chat', async ({ page }) => {
        test.setTimeout(600000);

        await awaitSTFlexible(page);

        // Keep fixture files byte-identical: serialization+gzip still run,
        // only the server-side write is skipped (it never blocks the UI).
        await page.route('**/api/chats/save', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":"ok"}' }));
        await page.route('**/api/chats/save-raw*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
        // The delta ack must carry plausible integers or the ledger poisons
        // itself and every measured save degrades to a full save.
        await page.route('**/api/chats/save-delta', async (route) => {
            const body = route.request().postDataJSON();
            const appended = (body?.ops ?? []).filter(op => op.op === 'append').flatMap(op => op.lines).length;
            const bytes = (body?.ops ?? []).reduce((sum, op) => sum + (op.lines ?? [op.line ?? '']).join('').length, 0);
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, lineCount: (body?.base?.lineCount ?? 1) + appended, fileSize: (body?.base?.fileSize ?? 0) + bytes }),
            });
        });

        await page.evaluate(() => localStorage.setItem('perfTrace', '1'));
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

        // --- Unthrottled setup: character, source, 300k context, lorebook ---
        await runCommands(page, `/go ${CHARACTER_NAME}`);
        await page.waitForTimeout(2000);
        await page.evaluate(() => {
            const $ = globalThis.jQuery;
            $('#chat_completion_source').val('openai').trigger('change');
        });
        await page.waitForTimeout(2000);
        await page.evaluate((tokens) => {
            const $ = globalThis.jQuery;
            $('#oai_max_context_unlocked').prop('checked', true).trigger('input');
            $('#openai_max_context').val(tokens).trigger('input');
        }, CONTEXT_TOKENS);
        await page.waitForTimeout(2000);
        await runCommands(page, `/world silent=true state=on ${WORLD_NAME}`);
        await page.waitForTimeout(1000);

        // Main-thread freeze meter: long tasks (>50ms) per scenario.
        await page.evaluate(() => {
            const state = { total: 0, count: 0, max: 0 };
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    state.total += entry.duration;
                    state.count += 1;
                    if (entry.duration > state.max) state.max = entry.duration;
                }
            }).observe({ type: 'longtask', buffered: false });
            globalThis.__ltReset = () => { state.total = 0; state.count = 0; state.max = 0; };
            globalThis.__ltReport = () => ({ blockedMs: Math.round(state.total), blocks: state.count, longestMs: Math.round(state.max) });
        });

        // --- Engage phone emulation for everything measured below ---
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

        /** @type {Record<string, object>} */
        const results = {
            _meta: { cpuThrottle: CPU_THROTTLE, chatFile: CHAT_FILE, contextTokens: CONTEXT_TOKENS },
        };

        // --- Scenario: open the 300k chat ---
        await resetMeters(page);
        let wallMs = await timeEvaluate(page, async (chatFile) => {
            await globalThis.SillyTavern.getContext().openCharacterChat(chatFile);
        }, CHAT_FILE);
        await page.waitForTimeout(SETTLE_MS);
        results['open-chat'] = await collectMeters(page, wallMs);

        const messageCount = await page.evaluate(() => globalThis.SillyTavern.getContext().chat.length);
        expect(messageCount).toBeGreaterThan(MIN_MESSAGES);

        // --- Scenario: send preflight, cold token cache for this chat ---
        await resetMeters(page);
        wallMs = await timeEvaluate(page, async () => {
            await globalThis.SillyTavern.getContext().generate('normal', {}, true);
        });
        results['assemble-prompt-cold'] = await collectMeters(page, wallMs);

        // --- Scenario: send preflight, hot cache (the steady-state cost) ---
        await resetMeters(page);
        wallMs = await timeEvaluate(page, async () => {
            await globalThis.SillyTavern.getContext().generate('normal', {}, true);
        });
        results['assemble-prompt-hot'] = await collectMeters(page, wallMs);

        // Arm the delta ledger with one un-metered full save, so every hot
        // scenario below measures its real (delta) save path instead of one
        // of them absorbing the arming full save. (Direct import — the
        // context.saveChat wrapper poisons by design.)
        await page.evaluate(async () => {
            const { saveChat } = await import('/script.js');
            const { poisonChatSaveLedger } = await import('/scripts/chat-save-ledger.js');
            poisonChatSaveLedger('perf-arming');
            await saveChat();
        });
        await page.waitForTimeout(SETTLE_MS);

        // --- Scenario: swipe between EXISTING replies (render + save) ---
        // Every fixture assistant message has 3 swipes; the last message is
        // an assistant one, so the arrows are present.
        await resetMeters(page);
        wallMs = await timeClick(page, '#chat .last_mes .swipe_right');
        await waitForMeasure(page, 'chat-save', MEASURE_TIMEOUT_MS);
        results['swipe-existing'] = await collectMeters(page, wallMs);
        const swipeId = await page.evaluate(() => {
            const { chat } = globalThis.SillyTavern.getContext();
            return chat[chat.length - 1].swipe_id;
        });
        expect(swipeId).toBe(1);

        // --- Scenario: append a user message (the send-side DOM work) ---
        await resetMeters(page);
        wallMs = await timeEvaluate(page, async () => {
            const { sendMessageAsUser } = await import('/script.js');
            await sendMessageAsUser('A quick question about the moonstone and the ravencrest: what does the old keeper remember of silverpine and the coming storm tonight?');
        });
        await page.waitForTimeout(SETTLE_MS);
        results['send-user-message'] = await collectMeters(page, wallMs);

        // --- Scenario: FULL chat save (the R3.2 fallback/reconciliation
        // path — poison first so the ledger cannot serve a delta). This is
        // the number comparable with earlier rounds' save-chat. ---
        await resetMeters(page);
        wallMs = await timeEvaluate(page, async () => {
            const { saveChat } = await import('/script.js');
            const { poisonChatSaveLedger } = await import('/scripts/chat-save-ledger.js');
            poisonChatSaveLedger('perf-full-save-scenario');
            await saveChat();
        });
        await waitForMeasure(page, 'tokencache-save', MEASURE_TIMEOUT_MS);
        results['save-chat'] = await collectMeters(page, wallMs);

        // --- Scenario: DELTA save of one touched message (the new hot
        // path for swipe/stop/edit saves). The full save above re-armed
        // the ledger. ---
        await resetMeters(page);
        wallMs = await timeEvaluate(page, async () => {
            const { chat, saveChat } = await import('/script.js');
            const { recordChatTouch } = await import('/scripts/chat-save-ledger.js');
            recordChatTouch(chat.length - 1);
            await saveChat();
        });
        await waitForMeasure(page, 'tokencache-save', MEASURE_TIMEOUT_MS);
        results['save-chat-delta'] = await collectMeters(page, wallMs);

        // --- Scenario: itemized-prompts persistence (real generations only,
        // so absent from the synthetic scenarios above). Every generated
        // message keeps its FULL raw prompt; every saveChatConditional
        // rewrites the whole array into IndexedDB. Model a session at 300k
        // context after 10 and after 40 generated replies. ---
        for (const entryCount of [10, 40]) {
            await page.evaluate(async (count) => {
                const { itemizedPrompts, upsertItemizedPrompt } = await import('/scripts/itemized-prompts.js');
                itemizedPrompts.splice(0);
                for (let i = 0; i < count; i++) {
                    // ~1.2M chars of prompt content per entry — what one
                    // 300k-token chat-completion prompt carries. Recorded
                    // through the same upsert entry point generations use
                    // (it marks the store dirty).
                    const filler = (`entry${i} the ancient walls whispered secrets of forgotten ages `).repeat(20000);
                    upsertItemizedPrompt({
                        mesId: 100000 + i,
                        rawPrompt: [
                            { role: 'system', content: filler.slice(0, 200000) },
                            { role: 'user', content: filler.slice(200000) },
                        ],
                        worldInfoString: filler.slice(0, 60000),
                        storyString: filler.slice(0, 20000),
                        mesSendString: '',
                        finalPrompt: '',
                        main_api: 'openai',
                    });
                }
            }, entryCount);
            await resetMeters(page);
            wallMs = await timeEvaluate(page, async () => {
                const { saveChatConditional } = await import('/script.js');
                await saveChatConditional();
            });
            await waitForMeasure(page, 'itemized-save', MEASURE_TIMEOUT_MS);
            results[`save-chat-itemized-${entryCount}`] = await collectMeters(page, wallMs);

            // Same store, nothing changed since the write above: the dirty
            // flag must skip the whole-array rewrite on this save.
            await resetMeters(page);
            wallMs = await timeEvaluate(page, async () => {
                const { saveChatConditional } = await import('/script.js');
                await saveChatConditional();
            });
            await page.waitForTimeout(SETTLE_MS);
            results[`save-chat-itemized-${entryCount}-clean`] = await collectMeters(page, wallMs);
        }

        // Drop the synthetic itemized entries from memory and storage.
        await page.evaluate(async () => {
            const { itemizedPrompts } = await import('/scripts/itemized-prompts.js');
            itemizedPrompts.splice(0);
            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: 'SillyTavern_Prompts' });
            const chatId = globalThis.SillyTavern.getContext().getCurrentChatId();
            if (chatId) {
                await store.removeItem(chatId);
            }
        });

        // --- Scenario: stream a long reply, then STOP mid-stream ---
        // Real StreamingProcessor driven by a fake generator; the stop tail
        // mirrors script.js:5443 (onFinishStreaming: final render + save).
        // Run twice: with auto-scroll (production default) and without.
        // Measured verdict: the delta is negligible — scroll-to-bottom is
        // REFUTED as the primary streaming cost; saturation comes from the
        // per-tick DOM replacement itself (parse/style/layout/GC).
        const withScroll = await runStreamingScenario(page);
        results['streaming-run-4s'] = withScroll.run;
        results['streaming-stop'] = withScroll.stop;

        const noScroll = await runStreamingScenario(page, { autoScroll: false });
        results['streaming-run-4s-noscroll'] = noScroll.run;
        results['streaming-stop-noscroll'] = noScroll.stop;

        // Cleanup: drop the user message appended by send-user-message.
        await page.evaluate(async () => {
            const { chat } = await import('/script.js');
            if (chat.length && chat[chat.length - 1].is_user) {
                const userIndex = chat.length - 1;
                chat.splice(userIndex);
                document.querySelector(`#chat .mes[mesid="${userIndex}"]`)?.remove();
            }
        });
        await runCommands(page, `/world silent=true state=off ${WORLD_NAME}`);

        console.log('===== PHONE EMULATION REPORT =====');
        console.log(JSON.stringify(results, null, 2));
        console.log('==================================');

        await test.info().attach('perf-phone.json', {
            body: JSON.stringify(results, null, 2),
            contentType: 'application/json',
        });

        const stage = process.env.PERF_STAGE;
        if (stage) {
            const outDir = path.resolve(new URL('.', import.meta.url).pathname, '../../perf/results');
            fs.mkdirSync(outDir, { recursive: true });
            const outFile = path.join(outDir, `${stage}-${new Date().toISOString().slice(0, 10)}.json`);
            fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
            console.log(`Saved: ${outFile}`);
        }
    });
});

/**
 * Streams a fake long reply through the real StreamingProcessor for 4s,
 * snapshots the streaming-window meters, then measures the STOP tail
 * (stop -> generate resolved -> onFinishStreaming done) in isolation.
 * Three phases so harness setup/cleanup never pollutes the numbers.
 * @param {import('@playwright/test').Page} page
 * @param {{ autoScroll?: boolean }} [options]
 * @returns {Promise<{run: object, stop: object}>}
 */
async function runStreamingScenario(page, { autoScroll = true } = {}) {
    const previousAutoScroll = await page.evaluate(async (scrollOn) => {
        const { power_user } = await import('/scripts/power-user.js');
        const previous = power_user.auto_scroll_chat_to_bottom;
        power_user.auto_scroll_chat_to_bottom = scrollOn ? previous : false;
        return previous;
    }, autoScroll);

    try {
        await resetMeters(page);
        await page.evaluate(async () => {
            const { chat, redisplayChat, StreamingProcessor } = await import('/script.js');
            const { PromptReasoning } = await import('/scripts/reasoning.js');

            const base = chat.length;
            chat.push({ name: 'Seraphina', is_user: false, is_system: false, send_date: Date.now(), mes: '...', extra: {} });
            await redisplayChat({ startIndex: base, fade: false });

            const processor = new StreamingProcessor('normal', false, new Date(), '', new PromptReasoning());
            processor.stoppingStrings = [];
            processor.messageId = base;
            if (!processor.abortController) {
                processor.abortController = new AbortController();
            }

            const words = ['the', 'ancient', 'walls', 'whispered', 'secrets', 'of', 'forgotten', 'ages', 'while', 'travelers', 'crossed', 'the', 'misty', 'valley', 'seeking', 'shelter'];
            processor.generator = async function* () {
                let text = '';
                for (let i = 0; !processor.abortController.signal.aborted; i++) {
                    // One clause per tick (~70 chars) -> a few thousand chars
                    // of streamed reply, like a real long answer.
                    const clause = [];
                    for (let w = 0; w < 10; w++) {
                        clause.push(words[(i * 7 + w) % words.length]);
                    }
                    text += (i % 8 === 7 ? '.\n\n' : '. ') + clause.join(' ') + (i % 5 === 4 ? ' *' + words[i % words.length] + '*' : '');
                    yield { text, swipes: [], logprobs: null, toolCalls: [], state: {} };
                    await new Promise(resolve => setTimeout(resolve, 45));
                }
            };

            // Attribute per-frame blocking: script vs style/layout (LoAF).
            const loaf = { frames: 0, totalMs: 0, styleLayoutMs: 0, scriptMs: 0, worstMs: 0 };
            globalThis.__loafState = loaf;
            try {
                globalThis.__loafObserver = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        loaf.frames += 1;
                        loaf.totalMs += entry.duration;
                        loaf.styleLayoutMs += entry.styleAndLayoutDuration ?? 0;
                        loaf.scriptMs += (entry.scripts ?? []).reduce((sum, script) => sum + script.duration, 0);
                        if (entry.duration > loaf.worstMs) loaf.worstMs = entry.duration;
                    }
                });
                globalThis.__loafObserver.observe({ type: 'long-animation-frame', buffered: false });
            } catch { /* long-animation-frame unsupported: loaf stays zeroed */ }

            globalThis.__stopHarness = { base, processor, generatePromise: processor.generate() };
        });

        // Let the reply stream and grow at throttled speed; snapshot the
        // streaming window's meters (includes the harness' one-message
        // setup render, ~100ms, noted here once).
        await page.waitForTimeout(4000);
        const run = await collectMeters(page, 4000);
        run.loaf = await page.evaluate(() => {
            globalThis.__loafObserver?.disconnect();
            const loaf = globalThis.__loafState ?? null;
            delete globalThis.__loafObserver;
            delete globalThis.__loafState;
            if (!loaf) {
                return null;
            }
            return Object.fromEntries(Object.entries(loaf).map(([key, value]) => [key, Math.round(value)]));
        });

        await resetMeters(page);
        const streamReport = await page.evaluate(async () => {
            const harness = globalThis.__stopHarness;
            const streamedLength = String(harness.processor.result || '').length;
            const stopAt = performance.now();
            harness.processor.onStopStreaming();
            await harness.generatePromise;
            await harness.processor.onFinishStreaming(harness.base, harness.processor.result);
            const { chat } = await import('/script.js');
            const persistedLength = String(chat[harness.base].mes || '').length;
            return { stopToInteractiveMs: Math.round(performance.now() - stopAt), streamedLength, persistedLength };
        });
        await page.waitForTimeout(SETTLE_MS);
        const stop = { ...await collectMeters(page, streamReport.stopToInteractiveMs), stream: streamReport };
        expect(streamReport.persistedLength).toBeGreaterThan(500);

        // Cleanup after collection: drop the streamed message from memory
        // and remove its DOM node directly (a full redisplay would cost
        // seconds and measure nothing).
        await page.evaluate(async () => {
            const { chat } = await import('/script.js');
            const harness = globalThis.__stopHarness;
            chat.splice(harness.base);
            document.querySelector(`#chat .mes[mesid="${harness.base}"]`)?.remove();
            delete globalThis.__stopHarness;
        });

        return { run, stop };
    } finally {
        await page.evaluate(async (previous) => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.auto_scroll_chat_to_bottom = previous;
        }, previousAutoScroll);
    }
}

/**
 * Waits for SillyTavern to load; works with and without user accounts.
 * @param {import('@playwright/test').Page} page
 */
async function awaitSTFlexible(page) {
    await page.goto('/');
    const userSelect = page.locator('#userList .userSelect').last();
    try {
        await userSelect.click({ timeout: 5000 });
    } catch {
        // Single-user mode: no selection screen, app loads directly.
    }
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    await page.waitForFunction('globalThis.SillyTavern?.getContext !== undefined', { timeout: 60000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} commands
 */
async function runCommands(page, commands) {
    await page.evaluate(async (cmd) => {
        await globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions(cmd);
    }, commands);
}

/** @param {import('@playwright/test').Page} page */
async function resetMeters(page) {
    await page.evaluate(() => {
        globalThis.__perfReset?.();
        globalThis.__ltReset?.();
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} wallMs
 */
async function collectMeters(page, wallMs) {
    return await page.evaluate((wall) => ({
        wallMs: Math.round(wall),
        freeze: globalThis.__ltReport?.() ?? null,
        spans: globalThis.__perfReport?.() ?? null,
    }), wallMs);
}

/**
 * Runs a page function and returns its in-page wall time in ms.
 * @param {import('@playwright/test').Page} page
 * @param {(arg: any) => Promise<any>} fn
 * @param {any} [arg]
 */
async function timeEvaluate(page, fn, arg) {
    return await page.evaluate(async ({ fnSource, fnArg }) => {
        const started = performance.now();
        // eslint-disable-next-line no-eval
        await (0, eval)(`(${fnSource})`)(fnArg);
        return performance.now() - started;
    }, { fnSource: fn.toString(), fnArg: arg ?? null });
}

/**
 * Clicks an element and returns time until the next paint opportunity —
 * the user-felt response time of the tap.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 */
async function timeClick(page, selector) {
    const handle = page.locator(selector).first();
    await handle.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => performance.now());
    // Swipe arrows are hover-revealed; force skips the visibility gate only.
    // eslint-disable-next-line playwright/no-force-option
    await handle.click({ force: true });
    return await page.evaluate(async (start) => {
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        return performance.now() - start;
    }, before);
}

/**
 * Waits until a named measure shows up in the performance timeline.
 * Resolves quietly on timeout — the report will just show the gap.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {number} timeoutMs
 */
async function waitForMeasure(page, name, timeoutMs) {
    try {
        await page.waitForFunction(
            (measureName) => performance.getEntriesByName(measureName, 'measure').length > 0,
            name,
            { timeout: timeoutMs },
        );
        await page.waitForTimeout(1500);
    } catch {
        console.warn(`Measure "${name}" did not appear within ${timeoutMs}ms`);
    }
}
