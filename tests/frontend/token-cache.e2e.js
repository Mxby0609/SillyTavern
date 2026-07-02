/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Regression tests for the sharded token cache storage
 * (public/scripts/tokenizers.js): legacy-blob migration, per-chat shard
 * writes, and the startup retention/eviction pass.
 */

const STORE_NAME = 'SillyTavern_ChatCompletions';
const LEGACY_KEY = 'tokenCache';
const SHARD_PREFIX = 'tokenCache#';
const META_KEY = 'tokenCacheMeta';
// Must match TOKEN_CACHE_MAX_CHATS in public/scripts/tokenizers.js.
const MAX_CACHED_CHATS = 100;

test.describe('Token cache sharding', () => {
    test.beforeEach(testSetup.awaitST);

    test('migrates the legacy monolithic cache into per-chat shards', async ({ page }) => {
        await page.evaluate(async ({ storeName, legacyKey }) => {
            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: storeName });
            await store.clear();
            await store.setItem(legacyKey, {
                'chat-a.jsonl': { '111': 42 },
                'chat-b.jsonl': { '222': 7 },
            });
        }, { storeName: STORE_NAME, legacyKey: LEGACY_KEY });

        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

        await expect.poll(() => storeKeys(page), { timeout: 15000 }).toEqual(expect.arrayContaining([
            SHARD_PREFIX + 'chat-a.jsonl',
            SHARD_PREFIX + 'chat-b.jsonl',
            META_KEY,
        ]));
        expect(await storeKeys(page)).not.toContain(LEGACY_KEY);

        // Shard contents must be byte-for-byte what the legacy blob held.
        expect(await storeGet(page, SHARD_PREFIX + 'chat-a.jsonl')).toEqual({ '111': 42 });
        expect(await storeGet(page, SHARD_PREFIX + 'chat-b.jsonl')).toEqual({ '222': 7 });

        // Not an exact-set check: the page-hide recency flush of the previous
        // page load may leave orphan meta entries, cleaned on the next start.
        const meta = await storeGet(page, META_KEY);
        expect(Object.keys(meta)).toEqual(expect.arrayContaining(['chat-a.jsonl', 'chat-b.jsonl']));
    });

    test('migrates only the retention window for oversized legacy caches', async ({ page }) => {
        const totalChats = MAX_CACHED_CHATS + 20;
        await page.evaluate(async ({ storeName, legacyKey, totalChats }) => {
            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: storeName });
            await store.clear();
            const legacy = {};
            for (let i = 0; i < totalChats; i++) {
                legacy[`legacy-${String(i).padStart(3, '0')}.jsonl`] = { '1': i };
            }
            await store.setItem(legacyKey, legacy);
        }, { storeName: STORE_NAME, legacyKey: LEGACY_KEY, totalChats });

        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

        await expect.poll(async () => (await storeKeys(page)).includes(LEGACY_KEY), { timeout: 15000 }).toBe(false);

        const keys = await storeKeys(page);
        const shardKeys = keys.filter(key => key.startsWith(SHARD_PREFIX));
        expect(shardKeys.length).toBe(MAX_CACHED_CHATS);
        // Insertion order stands in for recency: the oldest 20 are dropped.
        expect(keys).not.toContain(SHARD_PREFIX + 'legacy-000.jsonl');
        expect(keys).not.toContain(SHARD_PREFIX + 'legacy-019.jsonl');
        expect(keys).toContain(SHARD_PREFIX + 'legacy-020.jsonl');
        expect(keys).toContain(SHARD_PREFIX + `legacy-${totalChats - 1}.jsonl`);
    });

    test('persists the current chat shard after a chat save', async ({ page }) => {
        const chatShardKey = await page.evaluate(async (shardPrefix) => {
            await globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
            // getContext() returns a snapshot; take a fresh one after /go so
            // characterId reflects the now-selected character.
            const ctx = globalThis.SillyTavern.getContext();
            return shardPrefix + ctx.characters[ctx.characterId].chat;
        }, SHARD_PREFIX);

        await page.evaluate(async (storeName) => {
            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: storeName });
            await store.clear();
            await globalThis.SillyTavern.getContext().saveChat();
        }, STORE_NAME);

        // The write is idle-deferred; poll until the flush lands.
        await expect.poll(() => storeKeys(page), { timeout: 15000 }).toContain(chatShardKey);
        expect(await storeKeys(page)).toContain(META_KEY);

        // Only the current chat's shard is written — nothing else reappears.
        const shardKeys = (await storeKeys(page)).filter(key => key.startsWith(SHARD_PREFIX));
        expect(shardKeys).toEqual([chatShardKey]);
    });

    test('evicts the oldest shards over the retention limit on startup', async ({ page }) => {
        const totalShards = MAX_CACHED_CHATS + 20;
        await page.evaluate(async ({ storeName, shardPrefix, metaKey, totalShards }) => {
            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: storeName });
            await store.clear();
            const meta = {};
            for (let i = 0; i < totalShards; i++) {
                const chatId = `bench-${String(i).padStart(3, '0')}.jsonl`;
                await store.setItem(shardPrefix + chatId, { '1': i });
                // Strictly increasing timestamps: higher index = more recent.
                meta[chatId] = 1000000 + i;
            }
            await store.setItem(metaKey, meta);
        }, { storeName: STORE_NAME, shardPrefix: SHARD_PREFIX, metaKey: META_KEY, totalShards });

        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

        await expect.poll(async () => {
            const keys = await storeKeys(page);
            return keys.filter(key => key.startsWith(SHARD_PREFIX)).length;
        }, { timeout: 15000 }).toBe(MAX_CACHED_CHATS);

        const keys = await storeKeys(page);
        expect(keys).not.toContain(SHARD_PREFIX + 'bench-000.jsonl');
        expect(keys).not.toContain(SHARD_PREFIX + 'bench-019.jsonl');
        expect(keys).toContain(SHARD_PREFIX + 'bench-020.jsonl');
        expect(keys).toContain(SHARD_PREFIX + `bench-${totalShards - 1}.jsonl`);

        const meta = await storeGet(page, META_KEY);
        expect(Object.keys(meta).length).toBe(MAX_CACHED_CHATS);
    });
});

/**
 * Lists all keys in the token cache storage instance.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
async function storeKeys(page) {
    return await page.evaluate(async (storeName) => {
        const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: storeName });
        return await store.keys();
    }, STORE_NAME);
}

/**
 * Reads one value from the token cache storage instance.
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @returns {Promise<any>}
 */
async function storeGet(page, key) {
    return await page.evaluate(async ({ storeName, key }) => {
        const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: storeName });
        return await store.getItem(key);
    }, { storeName: STORE_NAME, key });
}
