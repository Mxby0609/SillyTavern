/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Equivalence tests for the post-render passes (unit 2.2):
 * - refreshSwipeButtons reads each element's own mesid instead of inferring
 *   ids from DOM position, so a missing element no longer shifts every id
 *   after it (virtual-scrolling readiness).
 * - updateViewMessageIds renumbers displayed messages positionally (its
 *   contract) with a single DOM query.
 * - applyCharacterTagsToMessageDivs matches elements by their own mesid
 *   attribute instead of one giant compound selector, in a single pass.
 */

/** Unique per-run salt so repeated runs never collide on names. */
const SALT = Date.now().toString(36);

test.describe('Post-render passes', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        // Keep test state out of the user's persisted chats and settings.
        for (const url of ['**/api/chats/save', '**/api/chats/save-raw*', '**/api/chats/save-delta', '**/api/chats/group/save', '**/api/settings/save']) {
            await page.route(url, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":"ok"}' }));
        }
    });

    test('swipe chevrons follow element ids, even with a missing element', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { chat, redisplayChat, refreshSwipeButtons } = await import('/script.js');

            const base = chat.length;
            const mkMessage = (isUser, mes) => ({
                name: isUser ? 'User' : 'TestChar',
                is_user: isUser,
                is_system: false,
                send_date: 0,
                mes,
                extra: {},
            });

            try {
                const lastMessage = mkMessage(false, 'first swipe text');
                lastMessage.swipes = ['first swipe text', 'second swipe text'];
                lastMessage.swipe_id = 0;

                chat.push(
                    mkMessage(false, 'reply one'),
                    mkMessage(false, 'reply two'),
                    mkMessage(true, 'user turn'),
                    lastMessage,
                );
                await redisplayChat({ startIndex: base, fade: false });

                const hasSwipeClass = (id) => document.querySelector(`#chat .mes[mesid="${id}"]`)?.classList.contains('swipes_visible') ?? null;

                const contiguous = {
                    last: hasSwipeClass(base + 3),
                    nonLast: hasSwipeClass(base),
                };

                // Simulate a windowed DOM (virtual scrolling): one element in
                // the middle is not in the page. Position-based inference
                // would shift every id after the gap and misclassify the last
                // message; per-element ids must not.
                document.querySelector(`#chat .mes[mesid="${base + 1}"]`).remove();
                refreshSwipeButtons();

                const withGap = {
                    last: hasSwipeClass(base + 3),
                    nonLast: hasSwipeClass(base),
                };

                return { contiguous, withGap };
            } finally {
                chat.splice(base);
                await redisplayChat({ startIndex: 0, fade: false });
            }
        });

        expect(results.contiguous.last, 'last AI message with 2 swipes shows chevrons').toBe(true);
        expect(results.contiguous.nonLast, 'non-last message shows no chevrons').toBe(false);
        expect(results.withGap.last, 'last message keeps chevrons when an earlier element is missing').toBe(true);
        expect(results.withGap.nonLast, 'non-last message stays chevron-free with a gap').toBe(false);
    });

    test('updateViewMessageIds renumbers contiguously after a deletion', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { chat, redisplayChat, updateViewMessageIds, getFirstDisplayedMessageId } = await import('/script.js');

            const base = chat.length;
            const mkMessage = (mes) => ({
                name: 'TestChar',
                is_user: false,
                is_system: false,
                send_date: 0,
                mes,
                extra: {},
            });

            try {
                chat.push(mkMessage('alpha'), mkMessage('beta'), mkMessage('gamma'));
                await redisplayChat({ startIndex: base, fade: false });

                // Mimic deleteMessage of the middle message: splice the array,
                // remove the element, renumber from the minimum displayed id.
                chat.splice(base + 1, 1);
                document.querySelector(`#chat .mes[mesid="${base + 1}"]`).remove();
                updateViewMessageIds(null);

                const elements = Array.from(document.querySelectorAll('#chat .mes'));
                return {
                    ids: elements.map(el => el.getAttribute('mesid')),
                    idTexts: elements.map(el => el.querySelector('.mesIDDisplay')?.textContent),
                    lastMesFlags: elements.map(el => el.classList.contains('last_mes')),
                    renumberedText: document.querySelector(`#chat .mes[mesid="${base + 1}"] .mes_text`)?.textContent?.trim(),
                    chatLength: chat.length,
                    firstDisplayedId: getFirstDisplayedMessageId(),
                };
            } finally {
                chat.splice(base);
                await redisplayChat({ startIndex: 0, fade: false });
            }
        });

        const expectedIds = Array.from({ length: results.chatLength }, (_, i) => String(i));
        expect(results.ids, 'mesid attributes are contiguous after renumbering').toEqual(expectedIds);
        expect(results.idTexts, 'id displays match the new ids').toEqual(expectedIds.map(id => `#${id}`));
        expect(results.lastMesFlags.slice(0, -1), 'no non-last element keeps last_mes').not.toContain(true);
        expect(results.lastMesFlags.at(-1), 'the final element carries last_mes').toBe(true);
        expect(results.renumberedText, 'the message after the deleted one takes over its id').toBe('gamma');
        expect(results.firstDisplayedId, 'minimum displayed id is 0').toBe(0);
    });

    test('character tags apply to exactly the requested messages', async ({ page }) => {
        const results = await page.evaluate(async ({ SALT }) => {
            const { chat, redisplayChat } = await import('/script.js');
            const { tags, tag_map, applyCharacterTagsToMessageDivs } = await import('/scripts/tags.js');

            const base = chat.length;
            const avatarFile = `e2e-tag-${SALT}.png`;
            const tagId = `e2e-tag-id-${SALT}`;
            const mkMessage = (isUser, mes) => ({
                name: isUser ? 'User' : 'TestChar',
                is_user: isUser,
                is_system: false,
                send_date: 0,
                mes,
                extra: {},
                ...(isUser ? {} : { force_avatar: `/thumbnail?type=avatar&file=${encodeURIComponent(avatarFile)}` }),
            });

            const tag = { id: tagId, name: 'E2E Probe,Tag' };
            tags.push(tag);
            tag_map[avatarFile] = [tagId];

            try {
                chat.push(
                    mkMessage(false, 'tagged one'),
                    mkMessage(false, 'tagged two'),
                    mkMessage(true, 'user turn'),
                );
                // redisplayChat applies tags to the re-rendered range itself.
                await redisplayChat({ startIndex: base, fade: false });

                const el = (id) => document.querySelector(`#chat .mes[mesid="${id}"]`);
                const initial = {
                    first: el(base).getAttribute('data-char-tags'),
                    firstNormalized: el(base).hasAttribute('data-char-tag-e2e-probetag'),
                    second: el(base + 1).getAttribute('data-char-tags'),
                    user: el(base + 2).hasAttribute('data-char-tag-e2e-probetag'),
                };

                // Rename the tag and plant stale attributes, then re-apply to
                // only the first message: the second must keep its old state.
                tag.name = 'Renamed';
                el(base + 1).setAttribute('data-char-tag-stale', '');
                applyCharacterTagsToMessageDivs({ mesIds: [base] });
                const scoped = {
                    first: el(base).getAttribute('data-char-tags'),
                    firstOldAttrGone: !el(base).hasAttribute('data-char-tag-e2e-probetag'),
                    firstNewAttr: el(base).hasAttribute('data-char-tag-renamed'),
                    secondUntouched: el(base + 1).getAttribute('data-char-tags'),
                    secondStaleKept: el(base + 1).hasAttribute('data-char-tag-stale'),
                };

                // Single-number form: only the second message is refreshed now.
                applyCharacterTagsToMessageDivs({ mesIds: base + 1 });
                const singleForm = {
                    second: el(base + 1).getAttribute('data-char-tags'),
                    secondStaleCleared: !el(base + 1).hasAttribute('data-char-tag-stale'),
                };

                return { initial, scoped, singleForm };
            } finally {
                const tagIndex = tags.indexOf(tag);
                if (tagIndex !== -1) {
                    tags.splice(tagIndex, 1);
                }
                delete tag_map[avatarFile];
                chat.splice(base);
                await redisplayChat({ startIndex: 0, fade: false });
            }
        }, { SALT });

        expect(results.initial.first, 'first tagged message gets the joined tag names').toBe('E2E Probe Tag');
        expect(results.initial.firstNormalized, 'normalized per-tag attribute is set').toBe(true);
        expect(results.initial.second, 'second tagged message gets the joined tag names').toBe('E2E Probe Tag');
        expect(results.initial.user, 'user message gets no character tag').toBe(false);
        expect(results.scoped.first, 'scoped re-application updates the requested message').toBe('Renamed');
        expect(results.scoped.firstOldAttrGone, 'old normalized attribute is cleared').toBe(true);
        expect(results.scoped.firstNewAttr, 'new normalized attribute is set').toBe(true);
        expect(results.scoped.secondUntouched, 'unrequested message keeps its old tags').toBe('E2E Probe Tag');
        expect(results.scoped.secondStaleKept, 'unrequested message keeps planted attributes').toBe(true);
        expect(results.singleForm.second, 'single-number id form refreshes that message').toBe('Renamed');
        expect(results.singleForm.secondStaleCleared, 'stale attributes are cleared on refresh').toBe(true);
    });
});
