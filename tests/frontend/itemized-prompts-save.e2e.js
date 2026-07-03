/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Dirty-flag tests for itemized-prompts persistence (R2.3): the whole
 * array is written to IndexedDB only when something actually changed
 * since the last successful write. Probe: ITEMIZED_PROMPTS_SAVED fires
 * exactly once per real write (no in-tree listeners depend on the old
 * fire-every-save behavior).
 */

test.describe('Itemized prompts dirty flag', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        for (const url of ['**/api/chats/save', '**/api/settings/save']) {
            await page.route(url, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":"ok"}' }));
        }
    });

    test('saves write only when the array changed since the last write', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { saveChatConditional } = await import('/script.js');
            const itemized = await import('/scripts/itemized-prompts.js');
            const { eventSource, event_types } = await import('/scripts/events.js');
            const context = globalThis.SillyTavern.getContext();

            if (context.characterId === undefined && context.characters.length) {
                await context.executeSlashCommandsWithOptions(`/go ${context.characters[0].name}`);
            }

            let writes = 0;
            const onSaved = () => { writes++; };
            eventSource.on(event_types.ITEMIZED_PROMPTS_SAVED, onSaved);

            // saveChatConditional fires saveItemizedPrompts without
            // awaiting it; give the (tiny) IndexedDB write time to land
            // before reading the counter.
            const saveAndSettle = async () => {
                await saveChatConditional();
                await new Promise(resolve => setTimeout(resolve, 200));
            };

            const counts = {};
            try {
                // Fresh baseline: whatever state the app is in, one save
                // settles it; a second save with no changes must not write.
                await saveAndSettle();
                const settled = writes;
                await saveAndSettle();
                counts.cleanSaveAdds = writes - settled;

                // Generation-site mutation (script.js pushes + marks dirty).
                itemized.itemizedPrompts.push({ mesId: 990001, rawPrompt: 'probe one' });
                itemized.markItemizedPromptsDirty();
                await saveAndSettle();
                counts.afterPush = writes - settled;

                // No change -> no write.
                await saveAndSettle();
                counts.afterPushRepeat = writes - settled;

                // Entry-content mutation via the module's own editor path.
                await itemized.replaceItemizedPromptText(990001, 'probe one edited');
                await saveAndSettle();
                counts.afterReplace = writes - settled;

                // Message-move mutation.
                itemized.swapItemizedPrompts(990001, 990002);
                await saveAndSettle();
                counts.afterSwap = writes - settled;

                // Deletion mutation.
                itemized.deleteItemizedPromptForMessage(990002);
                await saveAndSettle();
                counts.afterDelete = writes - settled;

                // And still: an untouched follow-up save stays silent.
                await saveAndSettle();
                counts.afterDeleteRepeat = writes - settled;
            } finally {
                eventSource.removeListener(event_types.ITEMIZED_PROMPTS_SAVED, onSaved);
                // Restore: drop any leftover probe entries and persist the
                // cleaned state so storage matches the pre-test content.
                for (let i = itemized.itemizedPrompts.length - 1; i >= 0; i--) {
                    const mesId = itemized.itemizedPrompts[i]?.mesId;
                    if (mesId === 990001 || mesId === 990002) {
                        itemized.itemizedPrompts.splice(i, 1);
                    }
                }
                itemized.markItemizedPromptsDirty();
                await saveChatConditional();
            }
            return counts;
        });

        expect(results.cleanSaveAdds, 'a save with no changes does not write').toBe(0);
        expect(results.afterPush, 'a pushed entry triggers exactly one write').toBe(1);
        expect(results.afterPushRepeat, 'an unchanged follow-up save stays silent').toBe(1);
        expect(results.afterReplace, 'editing an entry triggers a write').toBe(2);
        expect(results.afterSwap, 'swapping message ids triggers a write').toBe(3);
        expect(results.afterDelete, 'deleting an entry triggers a write').toBe(4);
        expect(results.afterDeleteRepeat, 'still no writes without changes').toBe(4);
    });

    test('replaceItemizedPromptText result is persisted on the next save', async ({ page }) => {
        const roundTrip = await page.evaluate(async () => {
            const { saveChatConditional } = await import('/script.js');
            const itemized = await import('/scripts/itemized-prompts.js');
            const context = globalThis.SillyTavern.getContext();

            if (context.characterId === undefined && context.characters.length) {
                await context.executeSlashCommandsWithOptions(`/go ${context.characters[0].name}`);
            }

            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: 'SillyTavern_Prompts' });
            const chatId = context.getCurrentChatId();

            itemized.itemizedPrompts.push({ mesId: 990003, rawPrompt: 'before-edit' });
            itemized.markItemizedPromptsDirty();
            try {
                itemized.replaceItemizedPromptText(990003, 'after-edit');
                await saveChatConditional();
                const stored = await store.getItem(chatId);
                const entry = (stored ?? []).find(x => x.mesId === 990003);
                return { storedText: entry?.rawPrompt ?? null };
            } finally {
                for (let i = itemized.itemizedPrompts.length - 1; i >= 0; i--) {
                    if (itemized.itemizedPrompts[i]?.mesId === 990003) {
                        itemized.itemizedPrompts.splice(i, 1);
                    }
                }
                itemized.markItemizedPromptsDirty();
                await saveChatConditional();
            }
        });

        expect(roundTrip.storedText, 'the edited entry content reaches storage').toBe('after-edit');
    });
});
