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

                // Generation-site mutation: the same upsert entry point
                // script.js records each generation through.
                itemized.upsertItemizedPrompt({ mesId: 990001, rawPrompt: 'probe one' });
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
                // Restore: drop any leftover probe entries (the module's
                // own delete marks dirty) and persist the cleaned state.
                itemized.deleteItemizedPromptForMessage(990002);
                itemized.deleteItemizedPromptForMessage(990001);
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

    test('bookmark/branch copies always write and never touch the own-chat flag', async ({ page }) => {
        const results = await page.evaluate(async ({ SALT }) => {
            const { saveChatConditional } = await import('/script.js');
            const itemized = await import('/scripts/itemized-prompts.js');
            const { eventSource, event_types } = await import('/scripts/events.js');
            const context = globalThis.SillyTavern.getContext();

            if (context.characterId === undefined && context.characters.length) {
                await context.executeSlashCommandsWithOptions(`/go ${context.characters[0].name}`);
            }

            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: 'SillyTavern_Prompts' });
            const ownChatId = context.getCurrentChatId();
            const branchChatId = `e2e-branch-copy-${SALT}`;
            const settle = () => new Promise(resolve => setTimeout(resolve, 200));

            try {
                // Settle the own store to a clean state.
                await saveChatConditional();
                await settle();

                // Bookmarks/branches copy the CURRENT array under a NEW
                // chat id. With a clean own store this must still write.
                await itemized.saveItemizedPrompts(branchChatId);
                const cleanCopy = await store.getItem(branchChatId);
                const cleanCopyWritten = Array.isArray(cleanCopy);

                // A copy made while the own store is dirty must not eat
                // the own store's pending write.
                itemized.upsertItemizedPrompt({ mesId: 990010, rawPrompt: 'branch probe' });
                await itemized.saveItemizedPrompts(branchChatId);
                const branchCopy = await store.getItem(branchChatId);
                const branchCopyHasProbe = (branchCopy ?? []).some(x => x.mesId === 990010);

                let ownWrites = 0;
                const onSaved = (payload) => {
                    if (payload?.chatId === ownChatId) {
                        ownWrites++;
                    }
                };
                eventSource.on(event_types.ITEMIZED_PROMPTS_SAVED, onSaved);
                await saveChatConditional();
                await settle();
                eventSource.removeListener(event_types.ITEMIZED_PROMPTS_SAVED, onSaved);

                return { cleanCopyWritten, branchCopyHasProbe, ownWrites };
            } finally {
                await store.removeItem(branchChatId);
                itemized.deleteItemizedPromptForMessage(990010);
                await saveChatConditional();
            }
        }, { SALT: Date.now().toString(36) });

        expect(results.cleanCopyWritten, 'a clean own store still copies to the branch key').toBe(true);
        expect(results.branchCopyHasProbe, 'the dirty-state copy carries the new entry').toBe(true);
        expect(results.ownWrites, 'the copy does not clear the own-chat dirty flag').toBe(1);
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

            itemized.upsertItemizedPrompt({ mesId: 990003, rawPrompt: 'before-edit' });
            try {
                await itemized.replaceItemizedPromptText(990003, 'after-edit');
                await saveChatConditional();
                // The write is fired without await; poll until it lands.
                for (let i = 0; i < 20; i++) {
                    const stored = await store.getItem(chatId);
                    const entry = (stored ?? []).find(x => x.mesId === 990003);
                    if (entry) {
                        return { storedText: entry.rawPrompt ?? null };
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return { storedText: null };
            } finally {
                itemized.deleteItemizedPromptForMessage(990003);
                await saveChatConditional();
            }
        });

        expect(roundTrip.storedText, 'the edited entry content reaches storage').toBe('after-edit');
    });
});
