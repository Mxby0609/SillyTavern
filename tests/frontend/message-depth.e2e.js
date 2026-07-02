/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Equivalence tests for the message depth computation in messageFormatting
 * (public/script.js). Depth = number of non-system messages after the given
 * message; system messages and invalid ids have no depth (undefined), which
 * makes depth-limited regex scripts apply unfiltered - a quirk of the
 * original implementation that must survive the rewrite.
 *
 * Depth itself is not observable, so the tests pin it through its only
 * consumer: a regex script with minDepth/maxDepth.
 */

test.describe('Message depth in messageFormatting', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        for (const url of ['**/api/chats/save', '**/api/chats/group/save', '**/api/settings/save']) {
            await page.route(url, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":"ok"}' }));
        }
    });

    test('depth-limited regex applies exactly to messages in range', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { chat, messageFormatting } = await import('/script.js');
            const { regex_placement } = await import('/scripts/extensions/regex/engine.js');
            const { extension_settings } = await import('/scripts/extensions.js');

            const script = {
                id: 'e2e-depth-probe',
                scriptName: 'e2e depth probe',
                findRegex: '/DEPTHPROBE/',
                replaceString: 'DEPTH_OK',
                trimStrings: [],
                placement: [regex_placement.AI_OUTPUT],
                disabled: false,
                markdownOnly: true,
                promptOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
                minDepth: 1,
                maxDepth: 2,
            };

            const startLength = chat.length;
            const mkMessage = (isUser, isSystem) => ({
                name: isUser ? 'User' : 'TestChar',
                is_user: isUser,
                is_system: isSystem,
                send_date: 0,
                mes: 'DEPTHPROBE',
                extra: {},
            });

            extension_settings.regex.push(script);
            try {
                // Appended layout (base = startLength):
                //   base+0 AI      -> depth 4
                //   base+1 AI      -> depth 3
                //   base+2 system  -> depth undefined
                //   base+3 AI      -> depth 2
                //   base+4 user    -> depth 1 (but USER_INPUT placement)
                //   base+5 AI      -> depth 0
                chat.push(
                    mkMessage(false, false),
                    mkMessage(false, false),
                    mkMessage(false, true),
                    mkMessage(false, false),
                    mkMessage(true, false),
                    mkMessage(false, false),
                );

                const format = (offset, { asSystemParam = false } = {}) => {
                    const message = chat[startLength + offset];
                    return messageFormatting(message.mes, message.name, asSystemParam, message.is_user, startLength + offset);
                };

                return {
                    depth4: format(0),
                    depth3: format(1),
                    // The comment-message path: chat entry is system, but the
                    // isSystem parameter arrives as false -> depth undefined
                    // -> depth filters are skipped and the script applies.
                    systemUndefined: format(2, { asSystemParam: false }),
                    depth2: format(3),
                    depth0: format(5),
                    // Streaming path formats with messageId -1: no depth,
                    // filters skipped, script applies.
                    negativeId: messageFormatting('DEPTHPROBE', '', false, false, -1),
                };
            } finally {
                chat.splice(startLength);
                const scriptIndex = extension_settings.regex.indexOf(script);
                if (scriptIndex !== -1) {
                    extension_settings.regex.splice(scriptIndex, 1);
                }
            }
        });

        expect(results.depth4, 'depth 4 is above maxDepth').toContain('DEPTHPROBE');
        expect(results.depth3, 'depth 3 is above maxDepth').toContain('DEPTHPROBE');
        expect(results.depth2, 'depth 2 is in range').toContain('DEPTH_OK');
        expect(results.depth0, 'depth 0 is below minDepth').toContain('DEPTHPROBE');
        expect(results.systemUndefined, 'system message has no depth, filter skipped').toContain('DEPTH_OK');
        expect(results.negativeId, 'negative id has no depth, filter skipped').toContain('DEPTH_OK');
    });

    test('interleaved system messages shift depth like the original', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { chat, messageFormatting } = await import('/script.js');
            const { regex_placement } = await import('/scripts/extensions/regex/engine.js');
            const { extension_settings } = await import('/scripts/extensions.js');

            const script = {
                id: 'e2e-depth-probe-2',
                scriptName: 'e2e depth probe 2',
                findRegex: '/DEPTHPROBE/',
                replaceString: 'DEPTH_OK',
                trimStrings: [],
                placement: [regex_placement.AI_OUTPUT],
                disabled: false,
                markdownOnly: true,
                promptOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
                minDepth: 1,
                maxDepth: 1,
            };

            const startLength = chat.length;
            const mkMessage = (isSystem) => ({
                name: 'TestChar',
                is_user: false,
                is_system: isSystem,
                send_date: 0,
                mes: 'DEPTHPROBE',
                extra: {},
            });

            extension_settings.regex.push(script);
            try {
                // base+0 AI, then two hidden system messages, then base+3 AI.
                // System messages do not count: base+0 has depth 1, not 3.
                chat.push(mkMessage(false), mkMessage(true), mkMessage(true), mkMessage(false));
                const format = (offset) => messageFormatting(chat[startLength + offset].mes, 'TestChar', false, false, startLength + offset);
                return { first: format(0), last: format(3) };
            } finally {
                chat.splice(startLength);
                const scriptIndex = extension_settings.regex.indexOf(script);
                if (scriptIndex !== -1) {
                    extension_settings.regex.splice(scriptIndex, 1);
                }
            }
        });

        expect(results.first, 'hidden system messages do not add depth').toContain('DEPTH_OK');
        expect(results.last, 'last message is at depth 0').toContain('DEPTHPROBE');
    });
});
