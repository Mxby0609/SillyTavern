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
            const { ReasoningHandler } = await import('/scripts/reasoning.js');

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

                return { firstRender, markSurvivesRepeat, markGoneAfterChange, secondRender, expectedSecond };
            } finally {
                chat.splice(base);
                await redisplayChat({ startIndex: 0, fade: false });
            }
        });

        expect(results.firstRender, 'reasoning is rendered as markdown').toContain('<em>stars</em>');
        expect(results.markSurvivesRepeat, 'unchanged reasoning keeps its DOM nodes').toBe(true);
        expect(results.markGoneAfterChange, 'changed reasoning re-renders').toBe(true);
        expect(results.secondRender, 'the re-render equals a fresh format of the new text').toBe(results.expectedSecond);
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

                // A fresh swipe value from the stream must always be cleaned.
                processor.swipes = ['SRPROBE_fresh'];
                await tick('stream body five');

                return { ticks };
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
        expect(results.ticks[4], 'fresh stream data is always cleaned').toBe('SRPROBE_gamma');
    });
});
