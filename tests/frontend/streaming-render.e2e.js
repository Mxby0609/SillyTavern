/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Equivalence tests for the streaming render optimizations (unit 2.3):
 * - countOccurrences keeps its overlapping-match semantics without the
 *   per-position substring allocation (runs on every streaming tick).
 * - The reasoning display skips re-formatting + re-writing identical markup
 *   once the reasoning text is frozen (per-instance render memo).
 * - Swipe cleanup during streaming reuses the previous result when a swipe's
 *   text did not change since it was last cleaned.
 */

/** Unique per-run salt so repeated runs never collide on names. */
const SALT = Date.now().toString(36);

test.describe('Streaming render', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        // Keep test state out of the user's persisted chats and settings.
        for (const url of ['**/api/chats/save', '**/api/chats/group/save', '**/api/settings/save']) {
            await page.route(url, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":"ok"}' }));
        }
    });

    test('countOccurrences counts overlapping matches without allocations', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { countOccurrences } = await import('/scripts/utils.js');
            return {
                simple: countOccurrences('Hello, world!', 'l'),
                none: countOccurrences('Hello, world!', 'x'),
                // Overlapping matches must count once per start position,
                // like the old substring scan: 'aaaa' contains 'aa' at 0,1,2.
                overlapping: countOccurrences('aaaa', 'aa'),
                // Four backticks contain the ``` fence at positions 0 and 1.
                fenceRun: countOccurrences('````', '```'),
                emptyNeedle: countOccurrences('ab', ''),
                emptyHaystack: countOccurrences('', 'a'),
                bothEmpty: countOccurrences('', ''),
                multiChar: countOccurrences('one ``` two ``` three', '```'),
            };
        });

        expect(results.simple).toBe(3);
        expect(results.none).toBe(0);
        expect(results.overlapping).toBe(3);
        expect(results.fenceRun).toBe(2);
        expect(results.emptyNeedle).toBe(2);
        expect(results.emptyHaystack).toBe(0);
        expect(results.bothEmpty).toBe(0);
        expect(results.multiChar).toBe(2);
    });

    test('frozen reasoning is not re-rendered, changed reasoning is', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { chat, redisplayChat, messageFormatting } = await import('/script.js');
            const { ReasoningHandler, ReasoningState } = await import('/scripts/reasoning.js');

            const base = chat.length;
            chat.push({
                name: 'TestChar',
                is_user: false,
                is_system: false,
                send_date: 0,
                mes: 'reply body',
                extra: {},
            });

            try {
                await redisplayChat({ startIndex: base, fade: false });

                const handler = new ReasoningHandler();
                handler.reasoning = 'thinking about *stars* and planets';
                handler.updateDom(base);

                const contentDom = document.querySelector(`#chat .mes[mesid="${base}"] .mes_reasoning`);
                const firstRender = contentDom.innerHTML;
                // Mark the rendered node: if the next update rewrites identical
                // markup, the node is replaced and the mark disappears.
                contentDom.firstElementChild.setAttribute('data-probe', '1');

                handler.updateDom(base);
                const markSurvivesRepeat = !!contentDom.querySelector('[data-probe]');

                handler.reasoning += ' and moons';
                handler.updateDom(base);
                const markGoneAfterChange = !contentDom.querySelector('[data-probe]');
                const secondRender = contentDom.innerHTML;
                const expectedSecond = messageFormatting('thinking about *stars* and planets and moons', '', false, false, base, {}, true);

                // The finish boundary always renders fresh, even when the
                // reasoning text did not change since the last tick.
                contentDom.firstElementChild.setAttribute('data-probe', '2');
                handler.state = ReasoningState.Done;
                await handler.finish(base);
                const markGoneAfterFinish = !contentDom.querySelector('[data-probe]');

                return { firstRender, markSurvivesRepeat, markGoneAfterChange, secondRender, expectedSecond, markGoneAfterFinish };
            } finally {
                chat.splice(base);
                await redisplayChat({ startIndex: 0, fade: false });
            }
        });

        expect(results.firstRender, 'reasoning is rendered as markdown').toContain('<em>stars</em>');
        expect(results.markSurvivesRepeat, 'unchanged reasoning keeps its DOM nodes').toBe(true);
        expect(results.markGoneAfterChange, 'changed reasoning re-renders').toBe(true);
        expect(results.secondRender, 'the re-render equals a fresh format of the new text').toBe(results.expectedSecond);
        expect(results.markGoneAfterFinish, 'finish always renders fresh').toBe(true);
    });

    test('swipe cleanup reuses results only while the swipe text is unchanged', async ({ page }) => {
        const results = await page.evaluate(async ({ SALT }) => {
            const { chat, redisplayChat, StreamingProcessor } = await import('/script.js');
            const { PromptReasoning } = await import('/scripts/reasoning.js');
            const { regex_placement } = await import('/scripts/extensions/regex/engine.js');
            const { extension_settings } = await import('/scripts/extensions.js');
            const context = window.SillyTavern.getContext();

            const varKey = `srprobe${SALT}`;
            // The replace string reads a variable at cleanup time, making each
            // cleanup call observable: the output tells us WHEN it ran.
            const script = {
                id: `e2e-stream-probe-${SALT}`,
                scriptName: 'e2e stream probe',
                findRegex: '/SRPROBE_\\w+/',
                replaceString: `SRPROBE_{{getvar::${varKey}}}`,
                trimStrings: [],
                placement: [regex_placement.AI_OUTPUT],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
            };

            const base = chat.length;
            chat.push({
                name: 'TestChar',
                is_user: false,
                is_system: false,
                send_date: 0,
                mes: 'stream body',
                extra: {},
            });
            extension_settings.regex.push(script);

            try {
                await redisplayChat({ startIndex: base, fade: false });

                const processor = new StreamingProcessor('normal', false, new Date(), '', new PromptReasoning());
                processor.stoppingStrings = [];

                const ticks = [];
                const tick = async (body) => {
                    await processor.onProgressStreaming(base, body);
                    ticks.push(processor.swipes[0]);
                };

                await context.executeSlashCommandsWithOptions(`/setvar key=${varKey} alpha`);
                processor.swipes = ['SRPROBE_raw'];
                await tick('stream body one');

                // The cleaned value was written back; it still matches the
                // find regex, so the next cleanup re-bakes the new variable -
                // exactly like the original per-tick re-cleaning did.
                await context.executeSlashCommandsWithOptions(`/setvar key=${varKey} beta`);
                await tick('stream body two');
                await tick('stream body three');

                // Accepted staleness window (documented in the review notes):
                // the swipe text has stabilized, so the memo serves the stored
                // result and a mid-stream variable change is not re-baked.
                await context.executeSlashCommandsWithOptions(`/setvar key=${varKey} gamma`);
                await tick('stream body four');

                // The FINAL tick persists its result into the message, so it
                // must bypass the memo and re-bake the current variable even
                // though the swipe text is unchanged.
                await processor.onProgressStreaming(base, 'stream body final', true);
                const finalSwipe = processor.swipes[0];

                // A fresh swipe value from the stream must always be cleaned.
                processor.swipes = ['SRPROBE_fresh'];
                await tick('stream body five');

                return { ticks, finalSwipe };
            } finally {
                const scriptIndex = extension_settings.regex.indexOf(script);
                if (scriptIndex !== -1) {
                    extension_settings.regex.splice(scriptIndex, 1);
                }
                await context.executeSlashCommandsWithOptions(`/flushvar ${varKey}`);
                chat.splice(base);
                await redisplayChat({ startIndex: 0, fade: false });
            }
        }, { SALT });

        expect(results.ticks[0], 'first cleanup bakes the current variable').toBe('SRPROBE_alpha');
        expect(results.ticks[1], 'changed swipe text is re-cleaned with the new variable').toBe('SRPROBE_beta');
        expect(results.ticks[2], 'stable text keeps its value').toBe('SRPROBE_beta');
        expect(results.ticks[3], 'unchanged text is served from the memo').toBe('SRPROBE_beta');
        expect(results.finalSwipe, 'the final tick bypasses the memo before persisting').toBe('SRPROBE_gamma');
        expect(results.ticks[4], 'fresh stream data is always cleaned').toBe('SRPROBE_gamma');
    });

    test('adaptive stopwatch stretches under load, recovers when idle, respects bounds', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { AdaptiveStopwatch } = await import('/scripts/utils.js');

            const BASE = 33;
            const sw = new AdaptiveStopwatch(BASE);
            const initialInterval = sw.interval;

            // The controller is deterministic: feed it observed render
            // costs directly (the probe wiring is covered by the streamed
            // pin test below and by the phone-emulation A/B).
            const track = [];
            // A slow device: each render costs ~90ms.
            for (let i = 0; i < 8; i++) {
                sw.observeRenderCost(90);
                track.push(sw.interval);
            }
            const stretched = sw.interval;

            // Pathological load never exceeds the ~4fps floor.
            for (let i = 0; i < 10; i++) {
                sw.observeRenderCost(2000);
            }
            const clamped = sw.interval;

            // A healthy thread (~10ms per render) decays back to base.
            for (let i = 0; i < 30; i++) {
                sw.observeRenderCost(10);
                track.push(sw.interval);
            }
            const recovered = sw.interval;
            const minSeen = Math.min(...track);

            return {
                initialInterval,
                stretched,
                clamped,
                recovered,
                minSeen,
                base: sw.baseInterval,
                max: AdaptiveStopwatch.MAX_INTERVAL_MS,
            };
        });

        expect(results.initialInterval, 'starts at the user-configured base').toBe(33);
        expect(results.stretched, 'a 90ms-per-render load stretches the interval well past base').toBeGreaterThan(results.base * 2);
        expect(results.stretched, 'stretching stays within the floor cap').toBeLessThanOrEqual(results.max);
        expect(results.clamped, 'pathological load clamps at the ~4fps floor').toBe(results.max);
        expect(results.recovered, 'a healthy thread decays the interval back to base').toBe(results.base);
        expect(results.minSeen, 'the interval never dips below the user-configured base').toBeGreaterThanOrEqual(results.base);
    });

    test('a throttled stream still persists the full final text with a fresh final render', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { chat, redisplayChat, StreamingProcessor, messageFormatting } = await import('/script.js');
            const { PromptReasoning } = await import('/scripts/reasoning.js');

            const base = chat.length;
            chat.push({ name: 'TestChar', is_user: false, is_system: false, send_date: 0, mes: '...', extra: {} });

            try {
                await redisplayChat({ startIndex: base, fade: false });

                const processor = new StreamingProcessor('normal', false, new Date(), '', new PromptReasoning());
                processor.stoppingStrings = [];
                processor.messageId = base;
                if (!processor.abortController) {
                    processor.abortController = new AbortController();
                }

                // Stream fast with a per-tick main-thread hog: the adaptive
                // throttle must skip intermediate renders (fewer executed
                // ticks than yields) yet the finalize path must persist the
                // complete last text and render it fresh.
                let finalText = '';
                processor.generator = async function* () {
                    for (let i = 1; i <= 30; i++) {
                        finalText = Array.from({ length: i }, (_, n) => `word${n}`).join(' ');
                        const end = performance.now() + 25;
                        while (performance.now() < end) { /* hog */ }
                        yield { text: finalText, swipes: [], logprobs: null, toolCalls: [], state: {} };
                        await new Promise(resolve => setTimeout(resolve, 5));
                    }
                    // Tail burst with no timer gaps: the throttle cannot
                    // render any of these, so the complete final text may
                    // only survive through the unconditional per-yield
                    // accumulation — the exact guarantee this test pins.
                    for (let i = 31; i <= 36; i++) {
                        finalText = Array.from({ length: i }, (_, n) => `word${n}`).join(' ');
                        yield { text: finalText, swipes: [], logprobs: null, toolCalls: [], state: {} };
                    }
                };

                await processor.generate();
                await processor.onFinishStreaming(base, processor.result);

                const persisted = chat[base].mes;
                const renderedHtml = document.querySelector(`#chat .mes[mesid="${base}"] .mes_text`)?.innerHTML;
                const expectedHtml = messageFormatting(finalText, chat[base].name, false, false, base, {}, false);

                return { persisted, finalText, renderedHtml, expectedHtml };
            } finally {
                chat.splice(base);
                document.querySelector(`#chat .mes[mesid="${base}"]`)?.remove();
            }
        });

        expect(results.persisted, 'the complete final text is persisted despite skipped frames').toBe(results.finalText);
        expect(results.renderedHtml, 'the final DOM equals a fresh full format of the final text').toBe(results.expectedHtml);
    });
});
