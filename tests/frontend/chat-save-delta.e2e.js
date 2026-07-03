/* eslint-env browser, es2022 */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * End-to-end tests for incremental chat saves (R3.2) against the REAL
 * server: hot appends/touches ride /api/chats/save-delta, anything the
 * ledger cannot prove falls back to a full save, base mismatches recover
 * transparently, and reconciliation forces periodic full saves.
 *
 * Each test works in a THROWAWAY chat (/newchat) that is deleted from the
 * server afterwards — fixture chats are never written.
 */

/** Starts a fresh throwaway chat and returns save-traffic recorders. */
async function openThrowawayChat(page) {
    const traffic = [];
    page.on('request', (request) => {
        const url = request.url();
        if (url.includes('/api/chats/save-delta')) {
            traffic.push({ kind: 'delta', body: request.postDataJSON() });
        } else if (url.includes('/api/chats/save-raw')) {
            traffic.push({ kind: 'raw' });
        } else if (url.endsWith('/api/chats/save')) {
            traffic.push({ kind: 'legacy' });
        }
    });

    const info = await page.evaluate(async () => {
        const context = globalThis.SillyTavern.getContext();
        if (context.characterId === undefined && context.characters.length) {
            await context.executeSlashCommandsWithOptions(`/go ${context.characters[0].name}`);
        }
        await context.executeSlashCommandsWithOptions('/newchat');
        // getContext() values are a snapshot; re-acquire after /go.
        const fresh = globalThis.SillyTavern.getContext();
        return {
            chatId: fresh.getCurrentChatId(),
            avatar: fresh.characters[fresh.characterId].avatar,
        };
    });
    return { traffic, ...info };
}

/** Deletes the throwaway chat file from the server. */
async function deleteThrowawayChat(page, info) {
    await page.evaluate(async ({ chatId, avatar }) => {
        const { getRequestHeaders } = await import('/script.js');
        await fetch('/api/chats/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chatfile: `${chatId}.jsonl`, avatar_url: avatar }),
        });
    }, info);
}

/** Reads the chat file back from the server as [header, ...messages]. */
async function fetchServerChat(page, info) {
    return await page.evaluate(async ({ chatId, avatar }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ file_name: chatId, avatar_url: avatar, ch_name: 'unused' }),
        });
        return await response.json();
    }, info);
}

async function sendUserMessage(page, text) {
    await page.evaluate(async (message) => {
        const { sendMessageAsUser } = await import('/script.js');
        await sendMessageAsUser(message);
    }, text);
}

// All tests operate on the same character's chat directory on the REAL
// server; parallel workers would contend on /go + /newchat + delete.
test.describe.configure({ mode: 'serial' });

test.describe('Incremental chat saves', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
    });

    test('hot appends and header changes ride save-delta; unchanged saves skip the network', async ({ page }) => {
        const info = await openThrowawayChat(page);
        const { traffic } = info;
        try {
            // First send: whatever the arming state, it must end with the
            // ledger armed (a worker full save through save-raw).
            await sendUserMessage(page, 'первое сообщение 第一条');
            expect(traffic.some(t => t.kind === 'raw'), 'an arming full save went through save-raw').toBe(true);

            // Second send: a pure append delta - exactly one append op with
            // exactly one line carrying the message.
            traffic.length = 0;
            await sendUserMessage(page, 'append probe 🎯');
            const deltas = traffic.filter(t => t.kind === 'delta');
            expect(deltas.length, 'the hot append went through save-delta').toBe(1);
            expect(traffic.filter(t => t.kind === 'raw').length, 'no full save for a hot append').toBe(0);
            const appendOps = deltas[0].body.ops.filter(op => op.op === 'append');
            expect(appendOps.length, 'exactly one append op').toBe(1);
            expect(appendOps[0].lines.length, 'exactly one appended line').toBe(1);
            expect(JSON.parse(appendOps[0].lines[0]).mes, 'the appended line carries the message').toBe('append probe 🎯');

            // saveReply append branch: a fresh assistant message.
            traffic.length = 0;
            await page.evaluate(async () => {
                const { saveReply, saveChatConditional } = await import('/script.js');
                await saveReply({ type: 'normal', getMessage: 'ai reply 甲' });
                await saveChatConditional();
            });
            let replyDeltas = traffic.filter(t => t.kind === 'delta');
            expect(replyDeltas.length, 'the assistant reply went through save-delta').toBe(1);
            const replyAppend = replyDeltas[0].body.ops.find(op => op.op === 'append');
            expect(JSON.parse(replyAppend.lines[0]).mes, 'the appended assistant line').toBe('ai reply 甲');

            // saveReply touch branch: appendFinal mutates the SAME message.
            traffic.length = 0;
            await page.evaluate(async () => {
                const { saveReply, saveChatConditional } = await import('/script.js');
                await saveReply({ type: 'appendFinal', getMessage: 'ai reply 甲乙' });
                await saveChatConditional();
            });
            replyDeltas = traffic.filter(t => t.kind === 'delta');
            expect(replyDeltas.length, 'the in-place finalization went through save-delta').toBe(1);
            const replaceOp = replyDeltas[0].body.ops.find(op => op.op === 'replace');
            expect(replaceOp, 'the finalization is a replace of the existing line').toBeTruthy();
            expect(JSON.parse(replaceOp.line).mes, 'the replaced line carries the final text').toBe('ai reply 甲乙');

            // Metadata-only change: a delta with a header op and nothing else.
            traffic.length = 0;
            await page.evaluate(async () => {
                const { saveChat } = await import('/script.js');
                const context = globalThis.SillyTavern.getContext();
                context.updateChatMetadata({ deltaProbe: 'metadata-change' }, false);
                await saveChat();
            });
            const headerDeltas = traffic.filter(t => t.kind === 'delta');
            expect(headerDeltas.length, 'the metadata change went through save-delta').toBe(1);
            expect(headerDeltas[0].body.ops.map(op => op.op), 'a single header op').toEqual(['header']);

            // No changes at all: the save must not produce ANY request.
            traffic.length = 0;
            await page.evaluate(async () => {
                const { saveChat } = await import('/script.js');
                await saveChat();
            });
            expect(traffic.length, 'an unchanged save skips the network entirely').toBe(0);

            // The server file mirrors client memory exactly.
            const serverChat = await fetchServerChat(page, info);
            const clientState = await page.evaluate(async () => {
                const { chat } = await import('/script.js');
                return { length: chat.length, lastMes: chat[chat.length - 1].mes };
            });
            expect(serverChat.length - 1, 'server message count matches memory').toBe(clientState.length);
            expect(serverChat[serverChat.length - 1].mes, 'server last message matches memory').toBe(clientState.lastMes);
            expect(serverChat[0].chat_metadata.deltaProbe, 'server header carries the metadata change').toBe('metadata-change');

            // /addswipe mutates the last message in place; without its touch
            // record the change would be a silent noop and the swipe would
            // never reach the disk.
            traffic.length = 0;
            await page.evaluate(async () => {
                const context = globalThis.SillyTavern.getContext();
                await context.executeSlashCommandsWithOptions('/addswipe 备选滑动');
            });
            const swipeDeltas = traffic.filter(t => t.kind === 'delta');
            expect(swipeDeltas.length >= 1, 'the added swipe was persisted through save-delta').toBe(true);
            const swipeReplace = swipeDeltas[0].body.ops.find(op => op.op === 'replace');
            expect(JSON.parse(swipeReplace.line).swipes, 'the replaced line carries the new swipe').toContain('备选滑动');
        } finally {
            await deleteThrowawayChat(page, info);
        }
    });

    test('unsupported mutations and unknown writers force full saves', async ({ page }) => {
        const info = await openThrowawayChat(page);
        const { traffic } = info;
        try {
            await sendUserMessage(page, 'one');
            await sendUserMessage(page, 'two');

            // In-tree unsupported op: inserting a user message mid-chat
            // poisons the ledger AT the mutation - the very next save (the
            // one inside sendMessageAsUser) must be a full save, and the
            // poison must hold until a full save re-arms.
            traffic.length = 0;
            await page.evaluate(async () => {
                const { sendMessageAsUser } = await import('/script.js');
                await sendMessageAsUser('inserted in the middle', '', 1);
            });
            expect(traffic.filter(t => t.kind === 'delta').length, 'no delta for a middle insert').toBe(0);
            expect(traffic.filter(t => t.kind === 'raw').length >= 1, 'the middle insert full-saved').toBe(true);

            // The insert path reloads the chat, which poisons again — the
            // next save is still FULL (and re-arms), then deltas resume.
            traffic.length = 0;
            await sendUserMessage(page, 'append after reload');
            expect(traffic.filter(t => t.kind === 'delta').length, 'reload keeps the ledger poisoned').toBe(0);
            expect(traffic.filter(t => t.kind === 'raw').length >= 1, 'the re-arming save is full').toBe(true);
            traffic.length = 0;
            await sendUserMessage(page, 'append after re-arm');
            expect(traffic.filter(t => t.kind === 'delta').length, 'delta resumed after re-arm').toBe(1);

            // Unknown writer (extension-style direct splice, no poison call)
            // followed by a recorded append — the shrink is invisible to the
            // length count, so the arm-epoch guard must catch it.
            traffic.length = 0;
            await page.evaluate(async () => {
                const { chat, sendMessageAsUser } = await import('/script.js');
                chat.splice(1, 1);
                await sendMessageAsUser('append after silent splice');
            });
            expect(traffic.filter(t => t.kind === 'delta').length, 'no delta after an unrecorded splice').toBe(0);
            expect(traffic.filter(t => t.kind === 'raw').length >= 1, 'the silent splice was caught by the length invariant').toBe(true);

            // A pure unrecorded shrink (no append masking it): the shrink
            // guard alone must force the full save.
            traffic.length = 0;
            await page.evaluate(async () => {
                const { chat, saveChat } = await import('/script.js');
                chat.splice(1, 1);
                await saveChat();
            });
            expect(traffic.filter(t => t.kind === 'delta').length, 'no delta for a pure shrink').toBe(0);
            expect(traffic.filter(t => t.kind === 'raw').length, 'the shrink full-saved').toBe(1);

            // Silent GROWTH: an unrecorded push inside the appended window.
            // Whether the save rides a delta (positions are serialized
            // fresh) or falls back to a full save, the OUTCOME must be a
            // disk file that mirrors memory including the silent push.
            traffic.length = 0;
            await page.evaluate(async () => {
                const { chat, sendMessageAsUser } = await import('/script.js');
                chat.push({ name: 'Ghost', is_user: false, mes: 'silently pushed', extra: {} });
                await sendMessageAsUser('append after silent push');
            });
            const growthChat = await fetchServerChat(page, info);
            expect(growthChat.some(line => line.mes === 'silently pushed'), 'the unrecorded push reached the disk').toBe(true);
            expect(growthChat[growthChat.length - 1].mes, 'the recorded send is the last line').toBe('append after silent push');

            const serverChat = await fetchServerChat(page, info);
            const clientLength = await page.evaluate(async () => (await import('/script.js')).chat.length);
            expect(serverChat.length - 1, 'server matches memory after all fallbacks').toBe(clientLength);
        } finally {
            await deleteThrowawayChat(page, info);
        }
    });

    test('same-length in-place mutations persist: wired touches ride deltas, extension saves fail closed', async ({ page }) => {
        const info = await openThrowawayChat(page);
        const { traffic } = info;
        try {
            await sendUserMessage(page, 'base one');
            await sendUserMessage(page, 'base two');

            // Wired core path: /hide flips is_system in place (same length,
            // same header) — exactly the shape the noop path would swallow
            // without its recordChatTouch.
            traffic.length = 0;
            await page.evaluate(async () => {
                const context = globalThis.SillyTavern.getContext();
                await context.executeSlashCommandsWithOptions('/hide 0');
            });
            expect(traffic.length > 0, 'the hide save was not treated as a noop').toBe(true);
            let serverChat = await fetchServerChat(page, info);
            expect(serverChat[1].is_system, 'the hidden flag reached the disk').toBe(true);

            // Extension-style: direct in-place mutation + context.saveChat.
            // The context wrapper poisons, forcing a FULL save that carries
            // the unrecorded change.
            traffic.length = 0;
            await page.evaluate(async () => {
                const { chat } = await import('/script.js');
                chat[0].extra = { ...(chat[0].extra ?? {}), probe: 'extension-write' };
                await globalThis.SillyTavern.getContext().saveChat();
            });
            expect(traffic.filter(t => t.kind === 'delta').length, 'no delta for an extension-origin save').toBe(0);
            expect(traffic.filter(t => t.kind === 'raw').length, 'the extension save full-saved').toBe(1);
            serverChat = await fetchServerChat(page, info);
            expect(serverChat[1].extra?.probe, 'the extension write reached the disk').toBe('extension-write');

            // Caption recaption: an in-tree extension with a DIRECT
            // saveChatConditional import (bypasses the context wrapper).
            // The real click path must persist the new caption.
            await page.route('**/api/extra/caption', route => route.fulfill({
                status: 200, contentType: 'application/json', body: JSON.stringify({ caption: 'mocked caption 图注' }),
            }));
            traffic.length = 0;
            const captionState = await page.evaluate(async () => {
                const { chat, appendMediaToMessage } = await import('/script.js');
                const { extension_settings } = await import('/scripts/extensions.js');
                extension_settings.caption ??= {};
                extension_settings.caption.source = 'local';
                const $ = globalThis.jQuery;
                const messageId = chat.length - 1;
                chat[messageId].extra = { ...(chat[messageId].extra ?? {}), media: [{ url: '/img/ai4.png', type: 'image', title: '' }], media_index: 0 };
                const messageBlock = $(`.mes[mesid="${messageId}"]`);
                appendMediaToMessage(chat[messageId], messageBlock);
                // Media DOM lands asynchronously (after the image loads);
                // wait for the caption button before clicking it.
                let buttons = $();
                for (let i = 0; i < 50; i++) {
                    buttons = messageBlock.find('.mes_img_caption');
                    if (buttons.length) break;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                buttons.first().trigger('click');
                // The click handler is async; wait for the caption to land.
                for (let i = 0; i < 50; i++) {
                    if (chat[messageId].extra.media[0].captioned) break;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return { captioned: Boolean(chat[messageId].extra.media[0].captioned) };
            });
            await page.unroute('**/api/extra/caption');
            expect(captionState.captioned, 'the recaption flow ran to completion').toBe(true);
            // The handler's save fires after the caption lands; poll for it.
            await expect.poll(() => traffic.length, { timeout: 10000 }).toBeGreaterThan(0);
            expect(traffic.length > 0, 'the recaption save was not treated as a noop').toBe(true);
            serverChat = await fetchServerChat(page, info);
            const captionedMedia = serverChat[serverChat.length - 1].extra?.media?.[0];
            expect(captionedMedia?.title ?? '', 'the caption reached the disk').toContain('mocked caption 图注');

            // AUTO-caption: MESSAGE_SENT fires AFTER the message was saved,
            // so the caption mutation sits below the acknowledged base. The
            // NEXT hot save must carry it — not a reconciliation later.
            await page.route('**/api/extra/caption', route => route.fulfill({
                status: 200, contentType: 'application/json', body: JSON.stringify({ caption: 'auto caption 自动' }),
            }));
            await sendUserMessage(page, 'message with an uploaded image');
            traffic.length = 0;
            await page.evaluate(async () => {
                const { chat, saveChat } = await import('/script.js');
                const { eventSource, event_types } = await import('/scripts/events.js');
                const { extension_settings } = await import('/scripts/extensions.js');
                extension_settings.caption.auto_mode = true;
                try {
                    const messageId = chat.length - 1;
                    chat[messageId].extra = { ...(chat[messageId].extra ?? {}), media: [{ url: '/img/ai4.png', type: 'image', source: 'upload', title: '' }], media_index: 0 };
                    await eventSource.emit(event_types.MESSAGE_SENT, messageId);
                    for (let i = 0; i < 50; i++) {
                        if (chat[messageId].extra.media[0].captioned) break;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    await saveChat();
                } finally {
                    extension_settings.caption.auto_mode = false;
                }
            });
            await page.unroute('**/api/extra/caption');
            expect(traffic.length > 0, 'the post-auto-caption save was not treated as a noop').toBe(true);
            serverChat = await fetchServerChat(page, info);
            const autoCaptioned = serverChat[serverChat.length - 1].extra?.media?.[0];
            expect(autoCaptioned?.title ?? '', 'the auto caption reached the disk on the next save').toContain('auto caption 自动');
        } finally {
            await deleteThrowawayChat(page, info);
        }
    });

    test('a foreign write 409s the delta and the client recovers transparently', async ({ page }) => {
        const info = await openThrowawayChat(page);
        const { traffic } = info;
        try {
            await sendUserMessage(page, 'base one');
            await sendUserMessage(page, 'base two');

            // Foreign write: replace the file out-of-band (force skips the
            // integrity check), so the ledger's base no longer matches.
            await page.evaluate(async ({ chatId, avatar }) => {
                const { getRequestHeaders } = await import('/script.js');
                const headers = new Headers(getRequestHeaders());
                headers.set('Content-Type', 'application/x-ndjson');
                const query = new URLSearchParams({ file_name: chatId, avatar_url: avatar, force: '1' });
                const body = JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: {} })
                    + '\n' + JSON.stringify({ name: 'Foreign', is_user: false, mes: 'foreign write', extra: {} });
                await fetch(`/api/chats/save-raw?${query.toString()}`, { method: 'POST', headers, body });
            }, info);

            // Next hot append: the delta must be attempted, rejected with a
            // base mismatch, and transparently replaced by a full save that
            // restores client memory as the authoritative state.
            traffic.length = 0;
            await sendUserMessage(page, 'after foreign write');
            expect(traffic.filter(t => t.kind === 'delta').length, 'a delta was attempted').toBe(1);
            expect(traffic.filter(t => t.kind === 'raw').length, 'the 409 fell back to a full save').toBe(1);

            const serverChat = await fetchServerChat(page, info);
            const clientState = await page.evaluate(async () => {
                const { chat } = await import('/script.js');
                return { length: chat.length, lastMes: chat[chat.length - 1].mes };
            });
            expect(serverChat.length - 1, 'client memory won').toBe(clientState.length);
            expect(serverChat[serverChat.length - 1].mes).toBe('after foreign write');
            expect(serverChat.some(line => line.mes === 'foreign write'), 'the foreign line was overwritten').toBe(false);
        } finally {
            await deleteThrowawayChat(page, info);
        }
    });

    test('reconciliation forces a periodic full save', async ({ page }) => {
        const info = await openThrowawayChat(page);
        const { traffic } = info;
        try {
            // Establish a KNOWN armed state with zero used-up deltas:
            // poison explicitly, then one full save re-arms.
            await page.evaluate(async () => {
                const { saveChat } = await import('/script.js');
                const { poisonChatSaveLedger } = await import('/scripts/chat-save-ledger.js');
                poisonChatSaveLedger('test-reset');
                await saveChat();
            });
            traffic.length = 0;

            // Sends 1..10 after arming are deltas; the 11th must reconcile
            // as a full save, then deltas resume.
            for (let i = 1; i <= 12; i++) {
                await sendUserMessage(page, `message ${i}`);
            }
            const kinds = traffic.map(t => t.kind);
            expect(kinds.slice(0, 10), 'ten deltas after arming').toEqual(Array(10).fill('delta'));
            expect(kinds[10], 'the 11th save reconciles as a full save').toBe('raw');
            expect(kinds[11], 'deltas resume after reconciliation').toBe('delta');

            const serverChat = await fetchServerChat(page, info);
            expect(serverChat[serverChat.length - 1].mes, 'nothing was lost across the boundary').toBe('message 12');
        } finally {
            await deleteThrowawayChat(page, info);
        }
    });
});
