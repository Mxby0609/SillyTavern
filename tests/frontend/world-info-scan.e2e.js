/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Equivalence tests for the world info scan optimizations
 * (public/scripts/world-info.js): scan regex caching, call-local entry
 * handout, and sorted-entries memoization. The invariant under test is that
 * scans behave exactly as if everything were rebuilt from scratch on every
 * call - including after book edits, book selection changes, and macro
 * value changes.
 */

/** Unique per-run salt so repeated runs never collide on book names or keywords. */
const SALT = Date.now().toString(36);

/**
 * Creates a world info book with the given entries on the server and assigns
 * it as the chat book (in memory only; chat saves are intercepted).
 * Runs in the page context.
 */
const PAGE_HELPERS = `
    window.__wiTest = {
        async makeBook(name, entries) {
            const wi = await import('/scripts/world-info.js');
            const data = { entries: {} };
            for (let i = 0; i < entries.length; i++) {
                data.entries[i] = {
                    ...wi.newWorldInfoEntryTemplate,
                    uid: i,
                    key: [],
                    keysecondary: [],
                    content: '',
                    scanDepth: 5,
                    caseSensitive: false,
                    matchWholeWords: false,
                    ...entries[i],
                };
            }
            await wi.saveWorldInfo(name, data, true);
            return data;
        },
        async setChatBook(name) {
            const wi = await import('/scripts/world-info.js');
            const { chat_metadata } = await import('/script.js');
            if (name === null) {
                delete chat_metadata[wi.METADATA_KEY];
            } else {
                chat_metadata[wi.METADATA_KEY] = name;
            }
        },
        async scan(message) {
            const wi = await import('/scripts/world-info.js');
            const result = await wi.checkWorldInfo([message], 100000, true);
            return result.worldInfoBefore;
        },
    };
`;

test.describe('World info scan equivalence', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        // Keep test state out of the user's persisted chats and settings.
        for (const url of ['**/api/chats/save', '**/api/chats/save-raw*', '**/api/chats/save-delta', '**/api/chats/group/save', '**/api/settings/save']) {
            await page.route(url, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":"ok"}' }));
        }
        await page.evaluate(PAGE_HELPERS);
    });

    test.afterEach(async ({ page }) => {
        await page.evaluate(async () => {
            await window.__wiTest.setChatBook(null);
        });
    });

    test('repeated scans activate identically, including global-flag regex keys', async ({ page }) => {
        test.setTimeout(60000);
        const book = `e2e-wi-${SALT}-rescan`;
        // Padding pushes the scanned text past the lowercase-cache threshold (1024 chars).
        const filler = 'lorem ipsum dolor sit amet '.repeat(50);
        const message = `${filler} wiprobe42 zebrafruit${SALT} then a walnut${SALT} appears, and finally GIANTHAYSTACK${SALT} closes it.`;

        const runs = await page.evaluate(async ({ book, message, SALT }) => {
            await window.__wiTest.makeBook(book, [
                { key: ['/wiprobe\\d+/g'], content: 'REGEX_G_HIT' },
                { key: [`zebrafruit${SALT}`], content: 'PLAIN_HIT' },
                { key: [`walnut${SALT}`], content: 'WHOLEWORD_HIT', matchWholeWords: true },
                { key: [`gianthaystack${SALT}`], content: 'LOWER_HIT' },
            ]);
            await window.__wiTest.setChatBook(book);
            const runs = [];
            for (let i = 0; i < 3; i++) {
                runs.push(await window.__wiTest.scan(message));
            }
            return runs;
        }, { book, message, SALT });

        for (const [index, run] of runs.entries()) {
            for (const sentinel of ['REGEX_G_HIT', 'PLAIN_HIT', 'WHOLEWORD_HIT', 'LOWER_HIT']) {
                expect(run, `scan #${index + 1} contains ${sentinel}`).toContain(sentinel);
            }
        }

        // Direct matchKeys determinism: cached regexes must behave like freshly
        // parsed ones on every call. A global-flag regex keeps its lastIndex
        // between test() calls, so without a reset, repeated matches on the
        // same text flip between hit and miss.
        const direct = await page.evaluate(({ message, SALT }) => {
            return import('/scripts/world-info.js').then((wi) => {
                const buffer = new wi.WorldInfoBuffer([message], {});
                const entry = { caseSensitive: false, matchWholeWords: false };
                const results = [];
                for (let i = 0; i < 4; i++) {
                    results.push([
                        buffer.matchKeys(message, '/wiprobe\\d+/g', entry),
                        buffer.matchKeys(message, `walnut${SALT}`, { ...entry, matchWholeWords: true }),
                        buffer.matchKeys(message, `GIANTHAYSTACK${SALT}`, entry),
                    ]);
                }
                return results;
            });
        }, { message, SALT });
        for (const [index, row] of direct.entries()) {
            expect(row, `direct matchKeys round ${index + 1}`).toEqual([true, true, true]);
        }
    });

    test('editing a book invalidates memoized entries', async ({ page }) => {
        const book = `e2e-wi-${SALT}-edit`;
        const { first, second } = await page.evaluate(async ({ book, SALT }) => {
            const wi = await import('/scripts/world-info.js');
            const data = await window.__wiTest.makeBook(book, [
                { key: [`editprobe${SALT}`], content: 'VERSION_ONE' },
            ]);
            await window.__wiTest.setChatBook(book);
            const first = await window.__wiTest.scan(`the editprobe${SALT} keyword`);
            data.entries[0].content = 'VERSION_TWO';
            await wi.saveWorldInfo(book, data, true);
            const second = await window.__wiTest.scan(`the editprobe${SALT} keyword`);
            return { first, second };
        }, { book, SALT });

        expect(first).toContain('VERSION_ONE');
        expect(second).toContain('VERSION_TWO');
        expect(second).not.toContain('VERSION_ONE');
    });

    test('switching the chat book invalidates memoized entries', async ({ page }) => {
        const bookA = `e2e-wi-${SALT}-swa`;
        const bookB = `e2e-wi-${SALT}-swb`;
        const { first, second } = await page.evaluate(async ({ bookA, bookB, SALT }) => {
            await window.__wiTest.makeBook(bookA, [{ key: [`switchprobe${SALT}`], content: 'BOOK_A_HIT' }]);
            await window.__wiTest.makeBook(bookB, [{ key: [`switchprobe${SALT}`], content: 'BOOK_B_HIT' }]);
            await window.__wiTest.setChatBook(bookA);
            const first = await window.__wiTest.scan(`a switchprobe${SALT} here`);
            await window.__wiTest.setChatBook(bookB);
            const second = await window.__wiTest.scan(`a switchprobe${SALT} here`);
            return { first, second };
        }, { bookA, bookB, SALT });

        expect(first).toContain('BOOK_A_HIT');
        expect(first).not.toContain('BOOK_B_HIT');
        expect(second).toContain('BOOK_B_HIT');
        expect(second).not.toContain('BOOK_A_HIT');
    });

    test('macros substitute per scan and never pollute the shared entries', async ({ page }) => {
        const book = `e2e-wi-${SALT}-macro`;
        const { first, second, masterContent } = await page.evaluate(async ({ book, SALT }) => {
            const wi = await import('/scripts/world-info.js');
            const context = window.SillyTavern.getContext();
            await window.__wiTest.makeBook(book, [
                { key: [`macroprobe${SALT}`], content: 'VAL_{{getvar::wiprobe}}_END' },
            ]);
            await window.__wiTest.setChatBook(book);
            await context.executeSlashCommandsWithOptions('/setvar key=wiprobe alpha');
            const first = await window.__wiTest.scan(`a macroprobe${SALT} here`);
            await context.executeSlashCommandsWithOptions('/setvar key=wiprobe beta');
            const second = await window.__wiTest.scan(`a macroprobe${SALT} here`);
            const entries = await wi.getSortedEntries();
            const masterContent = entries.find(x => x.world === book)?.content;
            return { first, second, masterContent };
        }, { book, SALT });

        expect(first).toContain('VAL_alpha_END');
        expect(second).toContain('VAL_beta_END');
        expect(second).not.toContain('VAL_alpha_END');
        // The stored entry must still hold the raw macro, not a substituted value.
        expect(masterContent).toContain('{{getvar::wiprobe}}');
    });

    test('mutating a returned entry does not affect later calls', async ({ page }) => {
        const book = `e2e-wi-${SALT}-isolate`;
        const { mutated, fresh } = await page.evaluate(async ({ book, SALT }) => {
            const wi = await import('/scripts/world-info.js');
            await window.__wiTest.makeBook(book, [
                { key: [`isoprobe${SALT}`], content: 'PRISTINE_CONTENT' },
            ]);
            await window.__wiTest.setChatBook(book);
            const first = await wi.getSortedEntries();
            const target = first.find(x => x.world === book);
            target.content = 'MUTATED_CONTENT';
            const second = await wi.getSortedEntries();
            return { mutated: target.content, fresh: second.find(x => x.world === book)?.content };
        }, { book, SALT });

        expect(mutated).toBe('MUTATED_CONTENT');
        expect(fresh).toBe('PRISTINE_CONTENT');
    });

    test('chat change evicts unrelated cached books, keeps relevant ones', async ({ page }) => {
        const bookKeep = `e2e-wi-${SALT}-evkeep`;
        const bookDrop = `e2e-wi-${SALT}-evdrop`;
        const bookEditor = `e2e-wi-${SALT}-eveditor`;
        const results = await page.evaluate(async ({ bookKeep, bookDrop, bookEditor, SALT }) => {
            const wi = await import('/scripts/world-info.js');
            const $ = globalThis.jQuery;
            try {
                await window.__wiTest.makeBook(bookKeep, [{ key: [`evictprobe${SALT}`], content: 'KEEP_HIT' }]);
                await window.__wiTest.makeBook(bookDrop, [{ key: [`evictprobe${SALT}`], content: 'DROP_HIT' }]);
                await window.__wiTest.makeBook(bookEditor, [{ key: [`evictprobe${SALT}`], content: 'EDITOR_HIT' }]);
                await window.__wiTest.setChatBook(bookKeep);
                await wi.loadWorldInfo(bookDrop);
                await wi.loadWorldInfo(bookEditor);
                const before = {
                    keep: wi.worldInfoCache.has(bookKeep),
                    drop: wi.worldInfoCache.has(bookDrop),
                    editor: wi.worldInfoCache.has(bookEditor),
                };

                // Mark the third book as open in the editor.
                $('#world_editor_select').append(new Option(bookEditor, 'e2e-evict-probe', true, true));

                wi.evictUnusedWorldInfoCacheBooks();
                const after = {
                    keep: wi.worldInfoCache.has(bookKeep),
                    drop: wi.worldInfoCache.has(bookDrop),
                    editor: wi.worldInfoCache.has(bookEditor),
                };

                // Eviction is only a cache drop: the book reloads intact.
                const reloaded = await wi.loadWorldInfo(bookDrop);
                return { before, after, reloadedContent: reloaded?.entries?.[0]?.content };
            } finally {
                $('#world_editor_select option[value="e2e-evict-probe"]').remove();
            }
        }, { bookKeep, bookDrop, bookEditor, SALT });

        expect(results.before, 'all three books start cached').toEqual({ keep: true, drop: true, editor: true });
        expect(results.after, 'chat and editor books kept, unrelated book dropped').toEqual({ keep: true, drop: false, editor: true });
        expect(results.reloadedContent, 'evicted book reloads from the server').toBe('DROP_HIT');
    });

    test('memoization serves warm scans and yields to entries-loaded listeners', async ({ page }) => {
        test.setTimeout(60000);
        const book = `e2e-wi-${SALT}-memo`;
        const message = `a memoprobe${SALT} here`;

        // Warm up: build once with the book in cache, so the memo can engage.
        const warm = await page.evaluate(async ({ book, message, SALT }) => {
            await window.__wiTest.makeBook(book, [
                { key: [`memoprobe${SALT}`], content: 'MEMO_HIT' },
            ]);
            await window.__wiTest.setChatBook(book);
            return await window.__wiTest.scan(message);
        }, { book, message, SALT });
        expect(warm, 'warm-up scan sees the entry').toContain('MEMO_HIT');

        // Sabotage the rebuild path: evict the book from the in-memory cache
        // without telling anyone, and block the server endpoint that a rebuild
        // would need. Only the memo can produce a hit now.
        await page.route('**/api/worldinfo/get', route => route.fulfill({ status: 500, body: 'blocked by test' }));
        const memoServed = await page.evaluate(async ({ book, message }) => {
            const wi = await import('/scripts/world-info.js');
            wi.worldInfoCache.delete(book);
            return await window.__wiTest.scan(message);
        }, { book, message });
        expect(memoServed, 'scan is served from the memo').toContain('MEMO_HIT');

        // Compat guard: any WORLDINFO_ENTRIES_LOADED listener must force the
        // legacy rebuild path. With the cache evicted and the endpoint blocked,
        // that path cannot see the book.
        const withListener = await page.evaluate(async ({ message }) => {
            const { eventSource, event_types } = await import('/script.js');
            window.__wiTestListener = () => {};
            eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, window.__wiTestListener);
            return await window.__wiTest.scan(message);
        }, { message });
        expect(withListener, 'listener forces the legacy path').not.toContain('MEMO_HIT');

        // Recovery: remove the listener, unblock the endpoint - the rebuild
        // refetches the book and scans see it again.
        await page.unroute('**/api/worldinfo/get');
        const recovered = await page.evaluate(async ({ message }) => {
            const { eventSource, event_types } = await import('/script.js');
            eventSource.removeListener(event_types.WORLDINFO_ENTRIES_LOADED, window.__wiTestListener);
            return await window.__wiTest.scan(message);
        }, { message });
        expect(recovered, 'scan recovers after the block is lifted').toContain('MEMO_HIT');
    });
});
