/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Sharded itemized-prompts persistence (R3.4): each entry lives under its
 * own id-keyed storage entry with a tiny per-chat index; saves write only
 * what changed (probe: ITEMIZED_PROMPTS_SAVED fires exactly once per real
 * write); message deletes/moves rewrite only the index; a legacy
 * whole-array key migrates to shards on first load; bookmark/branch
 * copies write full shard sets under the new chat id.
 */

const INDEX_SUFFIX = '\u0000idx';
const ENTRY_INFIX = '\u0000ent\u0000';

test.describe('Itemized prompts sharded storage', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        for (const url of ['**/api/chats/save', '**/api/chats/save-raw*', '**/api/chats/save-delta', '**/api/settings/save']) {
            await page.route(url, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":"ok"}' }));
        }
    });

    test('saves write only when something changed since the last write', async ({ page }) => {
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

            const saveAndSettle = async () => {
                await saveChatConditional();
                await new Promise(resolve => setTimeout(resolve, 200));
            };

            const counts = {};
            try {
                await saveAndSettle();
                const settled = writes;
                await saveAndSettle();
                counts.cleanSaveAdds = writes - settled;

                itemized.upsertItemizedPrompt({ mesId: 990001, rawPrompt: 'probe one' });
                await saveAndSettle();
                counts.afterPush = writes - settled;

                await saveAndSettle();
                counts.afterPushRepeat = writes - settled;

                // Re-upsert of the SAME mesId (regeneration overwrite).
                itemized.upsertItemizedPrompt({ mesId: 990001, rawPrompt: 'probe one regenerated' });
                await saveAndSettle();
                counts.afterReupsert = writes - settled;

                await itemized.replaceItemizedPromptText(990001, 'probe one edited');
                await saveAndSettle();
                counts.afterReplace = writes - settled;

                itemized.swapItemizedPrompts(990001, 990002);
                await saveAndSettle();
                counts.afterSwap = writes - settled;

                itemized.deleteItemizedPromptForMessage(990002);
                await saveAndSettle();
                counts.afterDelete = writes - settled;

                await saveAndSettle();
                counts.afterDeleteRepeat = writes - settled;

                // Two same-tick saves over ONE pending change: the first
                // claims it, the queued second must re-check and stay
                // silent (no write event for a no-op pass).
                itemized.upsertItemizedPrompt({ mesId: 990001, rawPrompt: 'concurrent probe' });
                const chatId = context.getCurrentChatId();
                await Promise.all([
                    itemized.saveItemizedPrompts(chatId),
                    itemized.saveItemizedPrompts(chatId),
                ]);
                await new Promise(resolve => setTimeout(resolve, 200));
                counts.afterConcurrentPair = writes - settled;
            } finally {
                eventSource.removeListener(event_types.ITEMIZED_PROMPTS_SAVED, onSaved);
                itemized.deleteItemizedPromptForMessage(990002);
                itemized.deleteItemizedPromptForMessage(990001);
                await saveChatConditional();
            }
            return counts;
        });

        expect(results.cleanSaveAdds, 'a save with no changes does not write').toBe(0);
        expect(results.afterPush, 'a pushed entry triggers exactly one write').toBe(1);
        expect(results.afterPushRepeat, 'an unchanged follow-up save stays silent').toBe(1);
        expect(results.afterReupsert, 'overwriting an existing entry triggers a write').toBe(2);
        expect(results.afterReplace, 'editing an entry triggers a write').toBe(3);
        expect(results.afterSwap, 'swapping message ids triggers a write').toBe(4);
        expect(results.afterDelete, 'deleting an entry triggers a write').toBe(5);
        expect(results.afterDeleteRepeat, 'still no writes without changes').toBe(5);
        expect(results.afterConcurrentPair, 'a same-tick save pair writes exactly once').toBe(6);
    });

    test('shard layout: entries land under id keys, deletes remove them, swaps survive a reload', async ({ page }) => {
        const results = await page.evaluate(async ({ INDEX_SUFFIX, ENTRY_INFIX }) => {
            const { saveChatConditional } = await import('/script.js');
            const itemized = await import('/scripts/itemized-prompts.js');
            const context = globalThis.SillyTavern.getContext();

            if (context.characterId === undefined && context.characters.length) {
                await context.executeSlashCommandsWithOptions(`/go ${context.characters[0].name}`);
            }

            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: 'SillyTavern_Prompts' });
            const chatId = context.getCurrentChatId();
            const out = {};

            try {
                itemized.upsertItemizedPrompt({ mesId: 990101, rawPrompt: 'first entry 首个' });
                itemized.upsertItemizedPrompt({ mesId: 990102, rawPrompt: 'second entry' });
                await saveChatConditional();
                await new Promise(resolve => setTimeout(resolve, 200));

                const index = await store.getItem(chatId + INDEX_SUFFIX);
                out.indexIsArray = Array.isArray(index);
                const meta1 = index.find(x => x.mesId === 990101);
                const meta2 = index.find(x => x.mesId === 990102);
                out.bothIndexed = Boolean(meta1 && meta2);
                const stored1 = await store.getItem(chatId + ENTRY_INFIX + meta1.id);
                out.entryReadable = stored1?.rawPrompt === 'first entry 首个';

                itemized.swapItemizedPrompts(990101, 990102);
                await saveChatConditional();
                await new Promise(resolve => setTimeout(resolve, 200));
                await itemized.loadItemizedPrompts(chatId);
                await itemized.replaceItemizedPromptText(990102, 'first entry edited after swap');
                await saveChatConditional();
                await new Promise(resolve => setTimeout(resolve, 200));
                const swappedStored = await store.getItem(chatId + ENTRY_INFIX + meta1.id);
                out.swappedEntryEdited = swappedStored?.rawPrompt === 'first entry edited after swap';
                out.swappedEntryMesId = swappedStored?.mesId;

                itemized.deleteItemizedPromptForMessage(990102);
                await saveChatConditional();
                await new Promise(resolve => setTimeout(resolve, 200));
                out.deletedEntryGone = (await store.getItem(chatId + ENTRY_INFIX + meta1.id)) === null;
                const indexAfterDelete = await store.getItem(chatId + INDEX_SUFFIX);
                out.indexDropped = !indexAfterDelete.some(x => x.id === meta1.id);
            } finally {
                itemized.deleteItemizedPromptForMessage(990101);
                itemized.deleteItemizedPromptForMessage(990102);
                await saveChatConditional();
            }
            return out;
        }, { INDEX_SUFFIX, ENTRY_INFIX });

        expect(results.indexIsArray, 'the per-chat index exists').toBe(true);
        expect(results.bothIndexed, 'both entries are indexed').toBe(true);
        expect(results.entryReadable, 'entry bodies live under id keys').toBe(true);
        expect(results.swappedEntryEdited, 'the swapped entry is editable by its new mesId after a reload').toBe(true);
        expect(results.swappedEntryMesId, 'hydration stamps the index mesId onto the body').toBe(990102);
        expect(results.deletedEntryGone, 'a deleted entry key is removed from storage').toBe(true);
        expect(results.indexDropped, 'the index no longer references the deleted entry').toBe(true);
    });

    test('a legacy whole-array key migrates to shards on load', async ({ page }) => {
        const results = await page.evaluate(async ({ INDEX_SUFFIX, ENTRY_INFIX, SALT }) => {
            const itemized = await import('/scripts/itemized-prompts.js');
            const context = globalThis.SillyTavern.getContext();
            if (context.characterId === undefined && context.characters.length) {
                await context.executeSlashCommandsWithOptions(`/go ${context.characters[0].name}`);
            }

            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: 'SillyTavern_Prompts' });
            const legacyChatId = `e2e-legacy-migration-${SALT}`;
            const ownChatId = context.getCurrentChatId();
            const legacyArray = [
                { mesId: 3, rawPrompt: 'legacy three', main_api: 'openai' },
                { mesId: 7, rawPrompt: 'legacy seven', main_api: 'openai' },
            ];

            try {
                await store.setItem(legacyChatId, legacyArray);
                await itemized.loadItemizedPrompts(legacyChatId);

                const index = await store.getItem(legacyChatId + INDEX_SUFFIX);
                const legacyGone = (await store.getItem(legacyChatId)) === null;
                const viewMesIds = itemized.itemizedPrompts.map(x => x.mesId);
                const entryOk = index && index.length === 2
                    ? (await store.getItem(legacyChatId + ENTRY_INFIX + index.find(x => x.mesId === 7).id))?.rawPrompt === 'legacy seven'
                    : false;
                const found = itemized.findItemizedPromptSet(itemized.itemizedPrompts, 7) !== undefined;

                return { indexCount: index?.length ?? 0, legacyGone, viewMesIds, entryOk, found };
            } finally {
                const index = await store.getItem(legacyChatId + INDEX_SUFFIX);
                for (const meta of index ?? []) {
                    await store.removeItem(legacyChatId + ENTRY_INFIX + meta.id);
                }
                await store.removeItem(legacyChatId + INDEX_SUFFIX);
                await store.removeItem(legacyChatId);
                await itemized.loadItemizedPrompts(ownChatId);
            }
        }, { INDEX_SUFFIX, ENTRY_INFIX, SALT: Date.now().toString(36) });

        expect(results.indexCount, 'both legacy entries are indexed').toBe(2);
        expect(results.legacyGone, 'the legacy array key is removed after migration').toBe(true);
        expect(results.viewMesIds, 'the view array mirrors the migrated entries').toEqual([3, 7]);
        expect(results.entryOk, 'migrated entry bodies are readable by id').toBe(true);
        expect(results.found, 'the popup lookup finds a migrated entry').toBe(true);
    });

    test('a reloaded chat serves stubs and hydrates on demand', async ({ page }) => {
        const results = await page.evaluate(async ({ ENTRY_INFIX, INDEX_SUFFIX }) => {
            const { saveChatConditional } = await import('/script.js');
            const itemized = await import('/scripts/itemized-prompts.js');
            const context = globalThis.SillyTavern.getContext();
            if (context.characterId === undefined && context.characters.length) {
                await context.executeSlashCommandsWithOptions(`/go ${context.characters[0].name}`);
            }

            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: 'SillyTavern_Prompts' });
            const chatId = context.getCurrentChatId();
            const heavy = 'X'.repeat(50000);
            const out = {};

            try {
                itemized.upsertItemizedPrompt({ mesId: 990201, rawPrompt: heavy, charDescription: heavy });
                await saveChatConditional();
                await new Promise(resolve => setTimeout(resolve, 200));

                await itemized.loadItemizedPrompts(chatId);
                const stub = itemized.itemizedPrompts.find(x => x.mesId === 990201);
                out.stubPresent = Boolean(stub);
                out.stubIsLight = stub ? stub.charDescription === undefined : false;
                out.stubSignalsRawPrompt = Boolean(stub?.rawPrompt);

                await itemized.replaceItemizedPromptText(990201, heavy + ' edited');
                await saveChatConditional();
                await new Promise(resolve => setTimeout(resolve, 200));
                const index = await store.getItem(chatId + INDEX_SUFFIX);
                const meta = index.find(x => x.mesId === 990201);
                const stored = await store.getItem(chatId + ENTRY_INFIX + meta.id);
                out.hydratedEditPersisted = stored?.rawPrompt === heavy + ' edited';
                out.hydratedKeepsFields = stored?.charDescription === heavy;
            } finally {
                itemized.deleteItemizedPromptForMessage(990201);
                await saveChatConditional();
            }
            return out;
        }, { INDEX_SUFFIX, ENTRY_INFIX });

        expect(results.stubPresent, 'the reloaded view lists the entry').toBe(true);
        expect(results.stubIsLight, 'the stub does not carry heavy entry fields').toBe(true);
        expect(results.stubSignalsRawPrompt, 'the stub still signals raw-prompt presence').toBe(true);
        expect(results.hydratedEditPersisted, 'an edit after hydration persists under the same id').toBe(true);
        expect(results.hydratedKeepsFields, 'hydration preserves the other entry fields').toBe(true);
    });

    test('an in-flight own save never persists an index entry without its body', async ({ page }) => {
        const results = await page.evaluate(async ({ INDEX_SUFFIX, ENTRY_INFIX }) => {
            const itemized = await import('/scripts/itemized-prompts.js');
            const context = globalThis.SillyTavern.getContext();
            if (context.characterId === undefined && context.characters.length) {
                await context.executeSlashCommandsWithOptions(`/go ${context.characters[0].name}`);
            }
            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: 'SillyTavern_Prompts' });
            const chatId = context.getCurrentChatId();
            const out = {};
            try {
                itemized.upsertItemizedPrompt({ mesId: 990401, rawPrompt: 'first ' + 'X'.repeat(200000) });
                const saveA = itemized.saveItemizedPrompts(chatId);
                // Let saveA claim (its runner starts on a microtask), then
                // land a NEW entry while its writes are in flight.
                await new Promise(resolve => setTimeout(resolve, 0));
                itemized.upsertItemizedPrompt({ mesId: 990402, rawPrompt: 'second (mid-flight)' });
                await saveA;

                // Variant: TWO claimed entries, and the LATER one is
                // deleted while the save is between its body writes — the
                // claimed index still references it, so its body snapshot
                // must have been taken at claim time.
                itemized.upsertItemizedPrompt({ mesId: 990403, rawPrompt: 'third ' + 'X'.repeat(200000) });
                itemized.upsertItemizedPrompt({ mesId: 990404, rawPrompt: 'fourth (deleted mid-flight)' });
                const saveB = itemized.saveItemizedPrompts(chatId);
                await new Promise(resolve => setTimeout(resolve, 0));
                itemized.deleteItemizedPromptForMessage(990404);
                await saveB;

                // Reload from storage WITHOUT a repair save: whatever the
                // index lists must have a body.
                await itemized.loadItemizedPrompts(chatId);
                const index = await store.getItem(chatId + INDEX_SUFFIX) ?? [];
                out.orphanIds = [];
                for (const meta of index) {
                    const body = await store.getItem(chatId + ENTRY_INFIX + meta.id);
                    if (!body) out.orphanIds.push(meta.mesId);
                }
                out.hasFirst = index.some(x => x.mesId === 990401);
            } finally {
                // Clean both probes (and any stray body) then persist.
                const index = await store.getItem(chatId + INDEX_SUFFIX) ?? [];
                for (const meta of index.filter(x => x.mesId === 990401 || x.mesId === 990402)) {
                    await store.removeItem(chatId + ENTRY_INFIX + meta.id);
                }
                for (const mesId of [990401, 990402, 990403, 990404]) {
                    itemized.deleteItemizedPromptForMessage(mesId);
                }
                await itemized.saveItemizedPrompts(chatId);
            }
            return out;
        }, { INDEX_SUFFIX, ENTRY_INFIX });

        expect(results.orphanIds, 'no index entry points at a missing body').toEqual([]);
        expect(results.hasFirst, 'the claimed entry landed').toBe(true);
    });

    test('bookmark/branch copies write a full shard set and never touch the own-chat dirt', async ({ page }) => {
        const results = await page.evaluate(async ({ INDEX_SUFFIX, ENTRY_INFIX, SALT }) => {
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
                itemized.upsertItemizedPrompt({ mesId: 990301, rawPrompt: 'own entry' });
                await saveChatConditional();
                await settle();

                await itemized.saveItemizedPrompts(branchChatId);
                const branchIndex = await store.getItem(branchChatId + INDEX_SUFFIX);
                const cleanCopyWritten = Array.isArray(branchIndex) && branchIndex.length >= 1;
                const branchEntry = cleanCopyWritten
                    ? await store.getItem(branchChatId + ENTRY_INFIX + branchIndex.find(x => x.mesId === 990301).id)
                    : null;

                itemized.upsertItemizedPrompt({ mesId: 990302, rawPrompt: 'branch probe' });
                await itemized.saveItemizedPrompts(branchChatId);
                const branchIndex2 = await store.getItem(branchChatId + INDEX_SUFFIX);
                const branchCopyHasProbe = (branchIndex2 ?? []).some(x => x.mesId === 990302);

                let ownWrites = 0;
                const onSaved = (payload) => {
                    if (payload?.chatId === ownChatId) ownWrites++;
                };
                eventSource.on(event_types.ITEMIZED_PROMPTS_SAVED, onSaved);
                await saveChatConditional();
                await settle();
                eventSource.removeListener(event_types.ITEMIZED_PROMPTS_SAVED, onSaved);

                // The copy must not have eaten the own ENTRY write either
                // (an index-only write would still fire the event).
                const ownIndex = await store.getItem(ownChatId + INDEX_SUFFIX);
                const ownMeta = (ownIndex ?? []).find(x => x.mesId === 990302);
                const ownEntry = ownMeta ? await store.getItem(ownChatId + ENTRY_INFIX + ownMeta.id) : null;

                return { cleanCopyWritten, branchEntryOk: branchEntry?.rawPrompt === 'own entry', branchCopyHasProbe, ownWrites, ownEntryOk: ownEntry?.rawPrompt === 'branch probe' };
            } finally {
                const branchIndex = await store.getItem(branchChatId + INDEX_SUFFIX);
                for (const meta of branchIndex ?? []) {
                    await store.removeItem(branchChatId + ENTRY_INFIX + meta.id);
                }
                await store.removeItem(branchChatId + INDEX_SUFFIX);
                itemized.deleteItemizedPromptForMessage(990302);
                itemized.deleteItemizedPromptForMessage(990301);
                await saveChatConditional();
            }
        }, { INDEX_SUFFIX, ENTRY_INFIX, SALT: Date.now().toString(36) });

        expect(results.cleanCopyWritten, 'a clean own store still copies to the branch keys').toBe(true);
        expect(results.branchEntryOk, 'the branch copy carries the entry body').toBe(true);
        expect(results.branchCopyHasProbe, 'the dirty-state copy carries the new entry').toBe(true);
        expect(results.ownWrites, 'the copy does not eat the own chat pending write').toBe(1);
        expect(results.ownEntryOk, 'the own entry body reached its own key').toBe(true);
    });
});
