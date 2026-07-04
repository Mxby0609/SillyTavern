import { DiffMatchPatch, DOMPurify, localforage } from '../lib.js';
import { chat, event_types, eventSource, getCurrentChatId, reloadCurrentChat } from '../script.js';
import { t } from './i18n.js';
import { oai_settings } from './openai.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { power_user, registerDebugFunction } from './power-user.js';
import { isMobile } from './RossAscends-mods.js';
import { renderTemplateAsync } from './templates.js';
import { getFriendlyTokenizerName, getTokenCountAsync } from './tokenizers.js';
import { perfMark, perfMeasure } from './perf-metrics.js';
import { copyText, uuidv4 } from './utils.js';

let PromptArrayItemForRawPromptDisplay;
let priorPromptArrayItemForRawPromptDisplay;

const promptStorage = localforage.createInstance({ name: 'SillyTavern_Prompts' });

/**
 * Sharded storage layout (unit R3.4). Entries are MB-scale at long
 * contexts (each carries the full raw prompt), and the legacy layout —
 * ONE key holding the whole array — meant every generation rewrote every
 * entry ever made, and every chat open loaded all of them into memory.
 *
 * Now each entry lives under its own key, addressed by a STABLE internal
 * id, with a tiny per-chat index mapping display mesIds to ids:
 * - index key: `\${chatId}\u0000idx` -> [{ id, mesId, hasRawPrompt }]
 * - entry key: `${chatId}(NUL)ent(NUL)${id}` -> the entry object
 * (NUL separators cannot appear in chat file names, so new keys can never
 * collide with legacy array keys.)
 *
 * Message deletes/moves shift mesIds; because entry keys are id-based,
 * those operations rewrite only the index, never the entry bodies. The
 * index is the AUTHORITY for an entry's mesId: hydration stamps the
 * index's mesId onto the loaded body.
 *
 * In memory the exported `itemizedPrompts` array holds hydrated entries
 * or lightweight stubs ({ mesId, rawPrompt: boolean-ish flag }). The
 * itemization popup hydrates the requested entry plus its nearest prior
 * raw-prompt entry on demand. A one-time migration converts a legacy
 * array key into shards on first load.
 */

export let itemizedPrompts = [];

const INDEX_SUFFIX = '\u0000idx';
const ENTRY_INFIX = '\u0000ent\u0000';
const STUB_FLAG = '__itemizedPromptStub';

/** @type {{id: string, mesId: number, hasRawPrompt: boolean}[]} */
let promptIndex = [];
/** @type {Map<string, object>} id -> hydrated entry */
let hydratedEntries = new Map();
/** @type {Set<string>} entry ids changed since the last successful write */
let dirtyEntryIds = new Set();
/** @type {Set<string>} entry ids removed since the last successful write */
let deletedEntryIds = new Set();
/** Whether the index diverged from storage since the last write. */
let indexDirty = false;
/** @type {string|null} Chat id the in-memory state was loaded for. */
let loadedChatId = null;
/** Serializes own-chat save writes (callers fire saveItemizedPrompts without awaiting). */
let ownSaveChain = Promise.resolve();

const indexKey = (chatId) => `${chatId}${INDEX_SUFFIX}`;
const entryKey = (chatId, id) => `${chatId}${ENTRY_INFIX}${id}`;

/**
 * Rebuilds the exported array view from the index: hydrated entries where
 * available, stubs elsewhere. Stub rawPrompt mirrors hasRawPrompt so
 * existing truthiness checks (prior-prompt detection, context consumers)
 * keep working without loading the bodies.
 */
function rebuildArrayView() {
    itemizedPrompts.length = 0;
    for (const meta of promptIndex) {
        const hydrated = hydratedEntries.get(meta.id);
        if (hydrated) {
            hydrated.mesId = meta.mesId;
            itemizedPrompts.push(hydrated);
        } else {
            itemizedPrompts.push({ mesId: meta.mesId, rawPrompt: meta.hasRawPrompt ? true : undefined, [STUB_FLAG]: true });
        }
    }
}

/**
 * Loads one entry body into memory (no-op if already hydrated or unknown).
 * @param {string} chatId Chat the entry belongs to
 * @param {string} id Entry id
 * @returns {Promise<object|null>} The hydrated entry
 */
async function hydrateEntry(chatId, id) {
    const meta = promptIndex.find(x => x.id === id);
    if (!meta) {
        return null;
    }
    if (hydratedEntries.has(id)) {
        return hydratedEntries.get(id) ?? null;
    }
    const body = await promptStorage.getItem(entryKey(chatId, id));
    if (body === null || typeof body !== 'object') {
        return null;
    }
    // rebuildArrayView stamps the index's authoritative mesId onto every
    // hydrated body — no separate stamp needed here.
    hydratedEntries.set(id, body);
    rebuildArrayView();
    return body;
}

/**
 * Hydrates the entry for a message plus its nearest PRIOR raw-prompt
 * entry (the popup's diff needs both).
 * @param {number} mesId Message id being itemized
 * @returns {Promise<void>}
 */
async function hydrateForItemization(mesId) {
    if (!loadedChatId) {
        return;
    }
    let targetPosition = -1;
    for (let i = 0; i < promptIndex.length; i++) {
        if (promptIndex[i].mesId === mesId) {
            targetPosition = i;
            break;
        }
    }
    if (targetPosition === -1) {
        return;
    }
    await hydrateEntry(loadedChatId, promptIndex[targetPosition].id);
    for (let i = targetPosition - 1; i >= 0; i--) {
        if (promptIndex[i].hasRawPrompt) {
            await hydrateEntry(loadedChatId, promptIndex[i].id);
            break;
        }
    }
}

/**
 * Inserts or replaces the itemized prompt for a message — the single
 * entry point for generation-time recording. Only THIS entry is written
 * on the next save.
 * @param {object} entry Itemized prompt entry (keyed by entry.mesId)
 */
export function upsertItemizedPrompt(entry) {
    const meta = promptIndex.find(x => x.mesId === entry.mesId);
    if (meta) {
        hydratedEntries.set(meta.id, entry);
        dirtyEntryIds.add(meta.id);
        const hasRawPrompt = Boolean(entry.rawPrompt);
        if (meta.hasRawPrompt !== hasRawPrompt) {
            meta.hasRawPrompt = hasRawPrompt;
            indexDirty = true;
        }
    } else {
        const id = uuidv4();
        promptIndex.push({ id, mesId: entry.mesId, hasRawPrompt: Boolean(entry.rawPrompt) });
        hydratedEntries.set(id, entry);
        dirtyEntryIds.add(id);
        deletedEntryIds.delete(id);
        indexDirty = true;
    }
    rebuildArrayView();
}

/**
 * Gets the itemized prompts for a chat, migrating a legacy whole-array
 * key into shards on first encounter.
 * @param {string} chatId Chat ID to load
 */
export async function loadItemizedPrompts(chatId) {
    try {
        if (!chatId) {
            unloadItemizedPrompts();
            return;
        }

        promptIndex = [];
        hydratedEntries = new Map();
        dirtyEntryIds = new Set();
        deletedEntryIds = new Set();
        indexDirty = false;
        loadedChatId = chatId;

        const storedIndex = await promptStorage.getItem(indexKey(chatId));
        if (Array.isArray(storedIndex)) {
            promptIndex = storedIndex.filter(x => x && typeof x.id === 'string');
        } else {
            // Legacy layout: one key holding the whole array. Migrate.
            const legacyArray = await promptStorage.getItem(chatId);
            if (Array.isArray(legacyArray) && legacyArray.length) {
                for (const entry of legacyArray) {
                    const id = uuidv4();
                    promptIndex.push({ id, mesId: entry.mesId, hasRawPrompt: Boolean(entry.rawPrompt) });
                    hydratedEntries.set(id, entry);
                    await promptStorage.setItem(entryKey(chatId, id), entry);
                }
                await promptStorage.setItem(indexKey(chatId), promptIndex);
                await promptStorage.removeItem(chatId);
                console.info(`Migrated ${legacyArray.length} itemized prompts of "${chatId}" to sharded storage.`);
            }
        }

        rebuildArrayView();
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_LOADED, { chatId: chatId });
    } catch (error) {
        console.log('Error loading itemized prompts for chat', chatId, error);
        promptIndex = [];
        hydratedEntries = new Map();
        dirtyEntryIds = new Set();
        deletedEntryIds = new Set();
        indexDirty = false;
        loadedChatId = chatId;
        rebuildArrayView();
    }
}

/**
 * Drops the in-memory state without touching storage (chat closed).
 */
export function unloadItemizedPrompts() {
    promptIndex = [];
    hydratedEntries = new Map();
    dirtyEntryIds = new Set();
    deletedEntryIds = new Set();
    indexDirty = false;
    loadedChatId = null;
    rebuildArrayView();
}

/**
 * Saves the itemized prompts for a chat. For the loaded chat this writes
 * ONLY entries that changed since the last successful write (plus the
 * tiny index when it moved); a save under a DIFFERENT chat id is a
 * bookmark/branch COPY: it hydrates everything and writes a full shard
 * set under the new keys, never touching the own chat's dirt.
 * @param {string} chatId Chat ID to save itemized prompts for
 */
export async function saveItemizedPrompts(chatId) {
    if (!chatId) {
        return;
    }

    const isOwnChat = chatId === loadedChatId;

    try {
        if (isOwnChat) {
            if (!dirtyEntryIds.size && !deletedEntryIds.size && !indexDirty) {
                return;
            }
            // Serialize own-chat saves: callers fire this without awaiting,
            // so a second save must not interleave with (or be outrun by)
            // the writes of the first.
            const run = ownSaveChain.then(async () => {
                if (!dirtyEntryIds.size && !deletedEntryIds.size && !indexDirty) {
                    return false;
                }
                // Claim before the write: mutations landing while the writes
                // are in flight re-mark and the NEXT save picks them up. The
                // index is SNAPSHOTTED at claim time — writing the live
                // array could persist references to entries whose bodies
                // were added after this claim and are not written yet.
                const claimedDirty = dirtyEntryIds;
                const claimedDeleted = deletedEntryIds;
                const claimedIndex = indexDirty ? promptIndex.map(meta => ({ ...meta })) : null;
                // Bodies are snapshotted at claim time too: a mid-flight
                // DELETE drops an entry from the live map, and reading live
                // during the awaited writes could skip a body the claimed
                // index still references (an orphan until the next save).
                const claimedEntries = new Map();
                for (const id of claimedDirty) {
                    const entry = hydratedEntries.get(id);
                    if (entry) {
                        claimedEntries.set(id, entry);
                    }
                }
                dirtyEntryIds = new Set();
                deletedEntryIds = new Set();
                indexDirty = false;
                try {
                    perfMark('itemized-save:start');
                    for (const [id, entry] of claimedEntries) {
                        await promptStorage.setItem(entryKey(chatId, id), entry);
                    }
                    for (const id of claimedDeleted) {
                        await promptStorage.removeItem(entryKey(chatId, id));
                    }
                    if (claimedIndex !== null) {
                        await promptStorage.setItem(indexKey(chatId), claimedIndex);
                    }
                    perfMeasure('itemized-save', 'itemized-save:start');
                    return true;
                } catch (error) {
                    // Restore the claim so nothing is lost for the next save.
                    for (const id of claimedDirty) dirtyEntryIds.add(id);
                    for (const id of claimedDeleted) deletedEntryIds.add(id);
                    indexDirty = indexDirty || claimedIndex !== null;
                    throw error;
                }
            });
            ownSaveChain = run.catch(() => { });
            const wrote = await run;
            if (!wrote) {
                return;
            }
        } else {
            // Bookmark/branch copy: full shard set under the new chat id.
            perfMark('itemized-save:start');
            const copyIndex = [];
            for (const meta of promptIndex) {
                const entry = loadedChatId ? await hydrateEntry(loadedChatId, meta.id) : hydratedEntries.get(meta.id);
                if (!entry) {
                    continue;
                }
                copyIndex.push({ ...meta });
                await promptStorage.setItem(entryKey(chatId, meta.id), entry);
            }
            await promptStorage.setItem(indexKey(chatId), copyIndex);
            perfMeasure('itemized-save', 'itemized-save:start');
        }
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_SAVED, { chatId: chatId });
    } catch {
        console.log('Error saving itemized prompts for chat', chatId);
    }
}

/**
 * Replaces the itemized prompt text for a message.
 * @param {number} mesId Message ID to get itemized prompt for
 * @param {string} promptText New raw prompt text
 * @returns
 */
export async function replaceItemizedPromptText(mesId, promptText) {
    const meta = promptIndex.find(x => x.mesId === mesId);
    if (!meta || !loadedChatId) {
        return;
    }

    const entry = await hydrateEntry(loadedChatId, meta.id);
    if (!entry) {
        return;
    }

    entry.rawPrompt = promptText;
    dirtyEntryIds.add(meta.id);
    const hasRawPrompt = Boolean(promptText);
    if (meta.hasRawPrompt !== hasRawPrompt) {
        meta.hasRawPrompt = hasRawPrompt;
        indexDirty = true;
    }
}

/**
 * Deletes the itemized prompts for a chat (all shards + any legacy key).
 * @param {string} chatId Chat ID to delete itemized prompts for
 */
export async function deleteItemizedPrompts(chatId) {
    try {
        if (!chatId) {
            return;
        }

        const storedIndex = chatId === loadedChatId
            ? promptIndex
            : await promptStorage.getItem(indexKey(chatId));
        if (Array.isArray(storedIndex)) {
            for (const meta of storedIndex) {
                if (meta && typeof meta.id === 'string') {
                    await promptStorage.removeItem(entryKey(chatId, meta.id));
                }
            }
        }
        await promptStorage.removeItem(indexKey(chatId));
        await promptStorage.removeItem(chatId);

        if (chatId === loadedChatId) {
            unloadItemizedPrompts();
            loadedChatId = chatId;
        }
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_DELETED, { chatId: chatId, all: false });
    } catch {
        console.log('Error deleting itemized prompts for chat', chatId);
    }
}

/**
 * Empties the itemized prompts store and caches.
 */
export async function clearItemizedPrompts() {
    try {
        await promptStorage.clear();
        unloadItemizedPrompts();
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_DELETED, { all: true });
    } catch {
        console.log('Error clearing itemized prompts');
    }
}

export async function itemizedParams(itemizedPrompts, thisPromptSet, incomingMesId) {
    const params = {
        charDescriptionTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].charDescription),
        charPersonalityTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].charPersonality),
        scenarioTextTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].scenarioText),
        userPersonaStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].userPersona),
        worldInfoStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].worldInfoString),
        allAnchorsTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].allAnchors),
        summarizeStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].summarizeString),
        authorsNoteStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].authorsNoteString),
        smartContextStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].smartContextString),
        beforeScenarioAnchorTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].beforeScenarioAnchor),
        afterScenarioAnchorTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].afterScenarioAnchor),
        zeroDepthAnchorTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].zeroDepthAnchor), // TODO: unused
        thisPrompt_padding: itemizedPrompts[thisPromptSet].padding,
        this_main_api: itemizedPrompts[thisPromptSet].main_api,
        chatInjects: await getTokenCountAsync(itemizedPrompts[thisPromptSet].chatInjects),
        chatVectorsStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].chatVectorsString),
        dataBankVectorsStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].dataBankVectorsString),
        modelUsed: chat[incomingMesId]?.extra?.model,
        apiUsed: chat[incomingMesId]?.extra?.api,
        presetName: itemizedPrompts[thisPromptSet].presetName || t`(Unknown)`,
        messagesCount: String(itemizedPrompts[thisPromptSet].messagesCount ?? ''),
        examplesCount: String(itemizedPrompts[thisPromptSet].examplesCount ?? ''),
    };

    const getFriendlyName = (value) => $(`#rm_api_block select option[value="${value}"]`).first().text() || value;

    if (params.apiUsed) {
        params.apiUsed = getFriendlyName(params.apiUsed);
    }

    if (params.this_main_api) {
        params.mainApiFriendlyName = getFriendlyName(params.this_main_api);
    }

    if (params.chatInjects) {
        params.ActualChatHistoryTokens = params.ActualChatHistoryTokens - params.chatInjects;
    }

    if (params.this_main_api == 'openai') {
        //for OAI API
        //console.log('-- Counting OAI Tokens');

        //params.finalPromptTokens = itemizedPrompts[thisPromptSet].oaiTotalTokens;
        params.oaiMainTokens = itemizedPrompts[thisPromptSet].oaiMainTokens;
        params.oaiStartTokens = itemizedPrompts[thisPromptSet].oaiStartTokens;
        params.ActualChatHistoryTokens = itemizedPrompts[thisPromptSet].oaiConversationTokens;
        params.examplesStringTokens = itemizedPrompts[thisPromptSet].oaiExamplesTokens;
        params.oaiPromptTokens = itemizedPrompts[thisPromptSet].oaiPromptTokens - (params.afterScenarioAnchorTokens + params.beforeScenarioAnchorTokens) + params.examplesStringTokens;
        params.oaiBiasTokens = itemizedPrompts[thisPromptSet].oaiBiasTokens;
        params.oaiJailbreakTokens = itemizedPrompts[thisPromptSet].oaiJailbreakTokens;
        params.oaiNudgeTokens = itemizedPrompts[thisPromptSet].oaiNudgeTokens;
        params.oaiImpersonateTokens = itemizedPrompts[thisPromptSet].oaiImpersonateTokens;
        params.oaiNsfwTokens = itemizedPrompts[thisPromptSet].oaiNsfwTokens;
        params.finalPromptTokens =
            params.oaiStartTokens +
            params.oaiPromptTokens +
            params.oaiMainTokens +
            params.oaiNsfwTokens +
            params.oaiBiasTokens +
            params.oaiImpersonateTokens +
            params.oaiJailbreakTokens +
            params.oaiNudgeTokens +
            params.ActualChatHistoryTokens +
            //charDescriptionTokens +
            //charPersonalityTokens +
            //allAnchorsTokens +
            params.worldInfoStringTokens +
            params.beforeScenarioAnchorTokens +
            params.afterScenarioAnchorTokens;
        // Max context size - max completion tokens
        params.thisPrompt_max_context = (oai_settings.openai_max_context - oai_settings.openai_max_tokens);

        //console.log('-- applying % on OAI tokens');
        params.oaiStartTokensPercentage = ((params.oaiStartTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.storyStringTokensPercentage = (((params.afterScenarioAnchorTokens + params.beforeScenarioAnchorTokens + params.oaiPromptTokens) / (params.finalPromptTokens)) * 100).toFixed(2);
        params.ActualChatHistoryTokensPercentage = ((params.ActualChatHistoryTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.promptBiasTokensPercentage = ((params.oaiBiasTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.worldInfoStringTokensPercentage = ((params.worldInfoStringTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.allAnchorsTokensPercentage = ((params.allAnchorsTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.selectedTokenizer = getFriendlyTokenizerName(params.this_main_api).tokenizerName;
        params.oaiSystemTokens = params.oaiImpersonateTokens + params.oaiJailbreakTokens + params.oaiNudgeTokens + params.oaiStartTokens + params.oaiNsfwTokens + params.oaiMainTokens;
        params.oaiSystemTokensPercentage = ((params.oaiSystemTokens / (params.finalPromptTokens)) * 100).toFixed(2);
    } else {
        //for non-OAI APIs
        //console.log('-- Counting non-OAI Tokens');
        params.finalPromptTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].finalPrompt);
        params.storyStringTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].storyString) - params.worldInfoStringTokens;
        params.examplesStringTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].examplesString);
        params.mesSendStringTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].mesSendString);
        params.ActualChatHistoryTokens = params.mesSendStringTokens - (params.allAnchorsTokens - (params.beforeScenarioAnchorTokens + params.afterScenarioAnchorTokens)) + power_user.token_padding;
        params.instructionTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].instruction);
        params.promptBiasTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].promptBias);

        params.totalTokensInPrompt =
            params.storyStringTokens +     //chardefs total
            params.worldInfoStringTokens +
            params.examplesStringTokens + // example messages
            params.ActualChatHistoryTokens +  //chat history
            params.allAnchorsTokens +      // AN and/or legacy anchors
            //afterScenarioAnchorTokens +       //only counts if AN is set to 'after scenario'
            //zeroDepthAnchorTokens +           //same as above, even if AN not on 0 depth
            params.promptBiasTokens;       //{{}}
        //- thisPrompt_padding;  //not sure this way of calculating is correct, but the math results in same value as 'finalPrompt'
        params.thisPrompt_max_context = itemizedPrompts[thisPromptSet].this_max_context;
        params.thisPrompt_actual = params.thisPrompt_max_context - params.thisPrompt_padding;

        //console.log('-- applying % on non-OAI tokens');
        params.storyStringTokensPercentage = ((params.storyStringTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.ActualChatHistoryTokensPercentage = ((params.ActualChatHistoryTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.promptBiasTokensPercentage = ((params.promptBiasTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.worldInfoStringTokensPercentage = ((params.worldInfoStringTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.allAnchorsTokensPercentage = ((params.allAnchorsTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.selectedTokenizer = itemizedPrompts[thisPromptSet]?.tokenizer || getFriendlyTokenizerName(params.this_main_api).tokenizerName;
    }
    return params;
}

export function findItemizedPromptSet(itemizedPrompts, incomingMesId) {
    let thisPromptSet = undefined;
    priorPromptArrayItemForRawPromptDisplay = -1;

    for (let i = 0; i < itemizedPrompts.length; i++) {
        console.log(`looking for ${incomingMesId} vs ${itemizedPrompts[i].mesId}`);
        if (itemizedPrompts[i].mesId === incomingMesId) {
            console.log(`found matching mesID ${i}`);
            thisPromptSet = i;
            PromptArrayItemForRawPromptDisplay = i;
            console.log(`wanting to raw display of ArrayItem: ${PromptArrayItemForRawPromptDisplay} which is mesID ${incomingMesId}`);
            console.log(itemizedPrompts[thisPromptSet]);
            break;
        } else if (itemizedPrompts[i].rawPrompt) {
            priorPromptArrayItemForRawPromptDisplay = i;
        }
    }
    return thisPromptSet;
}

export async function promptItemize(itemizedPrompts, requestedMesId) {
    console.log('PROMPT ITEMIZE ENTERED');
    var incomingMesId = Number(requestedMesId);
    console.debug(`looking for MesId ${incomingMesId}`);

    // Shards: pull the requested entry (and its diff-prior) into memory
    // before anything reads entry fields.
    await hydrateForItemization(incomingMesId);

    var thisPromptSet = findItemizedPromptSet(itemizedPrompts, incomingMesId);

    if (thisPromptSet === undefined) {
        console.log(`couldnt find the right mesId. looked for ${incomingMesId}`);
        console.log(itemizedPrompts);
        return null;
    }

    const params = await itemizedParams(itemizedPrompts, thisPromptSet, incomingMesId);
    const flatten = (rawPrompt) => Array.isArray(rawPrompt) ? rawPrompt.map(x => x.content).join('\n') : rawPrompt;

    const template = params.this_main_api == 'openai'
        ? await renderTemplateAsync('itemizationChat', params)
        : await renderTemplateAsync('itemizationText', params);

    const popup = new Popup(template, POPUP_TYPE.TEXT);

    /** @type {HTMLElement} */
    const diffPrevPrompt = popup.dlg.querySelector('#diffPrevPrompt');
    if (priorPromptArrayItemForRawPromptDisplay >= 0) {
        diffPrevPrompt.style.display = '';
        diffPrevPrompt.addEventListener('click', function () {
            const dmp = new DiffMatchPatch();
            const text1 = flatten(itemizedPrompts[priorPromptArrayItemForRawPromptDisplay].rawPrompt);
            const text2 = flatten(itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt);

            dmp.Diff_Timeout = 2.0;

            const d = dmp.diff_main(text1, text2);
            let ds = dmp.diff_prettyHtml(d);
            // make it readable
            ds = ds.replaceAll('background:#e6ffe6;', 'background:#b9f3b9; color:black;');
            ds = ds.replaceAll('background:#ffe6e6;', 'background:#f5b4b4; color:black;');
            ds = ds.replaceAll('&para;', '');
            const container = document.createElement('div');
            container.innerHTML = DOMPurify.sanitize(ds);
            const rawPromptWrapper = document.getElementById('rawPromptWrapper');
            rawPromptWrapper.replaceChildren(container);
            $('#rawPromptPopup').slideToggle();
        });
    } else {
        diffPrevPrompt.style.display = 'none';
    }
    popup.dlg.querySelector('#copyPromptToClipboard').addEventListener('pointerup', async function () {
        let rawPrompt = itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt;
        let rawPromptValues = rawPrompt;

        if (Array.isArray(rawPrompt)) {
            rawPromptValues = rawPrompt.map(x => x.content).join('\n');
        }

        await copyText(rawPromptValues);
        toastr.info(t`Copied!`);
    });

    popup.dlg.querySelector('#showRawPrompt').addEventListener('click', async function () {
        //console.log(itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt);
        console.log(PromptArrayItemForRawPromptDisplay);
        console.log(itemizedPrompts);
        console.log(itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt);

        const rawPrompt = flatten(itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt);

        // Mobile needs special handholding. The side-view on the popup wouldn't work,
        // so we just show an additional popup for this.
        if (isMobile()) {
            const content = document.createElement('div');
            content.classList.add('tokenItemizingMaintext');
            content.innerText = rawPrompt;
            const popup = new Popup(content, POPUP_TYPE.TEXT, null, { allowVerticalScrolling: true, leftAlign: true });
            await popup.show();
            return;
        }

        //let DisplayStringifiedPrompt = JSON.stringify(itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt).replace(/\n+/g, '<br>');
        const rawPromptWrapper = document.getElementById('rawPromptWrapper');
        rawPromptWrapper.innerText = rawPrompt;
        $('#rawPromptPopup').slideToggle();
    });

    await popup.show();
}

export function initItemizedPrompts() {
    registerDebugFunction('clearPrompts', 'Delete itemized prompts', 'Deletes all itemized prompts from the local storage.', async () => {
        await clearItemizedPrompts();
        toastr.info('Itemized prompts deleted.');
        if (getCurrentChatId()) {
            await reloadCurrentChat();
        }
    });

    $(document).on('pointerup', '.mes_prompt', async function () {
        let mesIdForItemization = $(this).closest('.mes').attr('mesId');
        console.log(`looking for mesID: ${mesIdForItemization}`);
        if (itemizedPrompts.length !== undefined && itemizedPrompts.length !== 0) {
            await promptItemize(itemizedPrompts, mesIdForItemization);
        }
    });

    eventSource.on(event_types.CHAT_DELETED, async (name) => {
        await deleteItemizedPrompts(name);
    });
    eventSource.on(event_types.GROUP_CHAT_DELETED, async (name) => {
        await deleteItemizedPrompts(name);
    });
}

/**
 * Swaps the itemized prompts between two messages. Useful when moving
 * messages around in the chat. Entry keys are id-based, so this only
 * touches the index.
 * @param {number} sourceMessageId Source message ID
 * @param {number} targetMessageId Target message ID
 */
export function swapItemizedPrompts(sourceMessageId, targetMessageId) {
    let moved = false;
    for (const meta of promptIndex) {
        if (meta.mesId === sourceMessageId) {
            meta.mesId = targetMessageId;
            moved = true;
        } else if (meta.mesId === targetMessageId) {
            meta.mesId = sourceMessageId;
            moved = true;
        }
    }

    if (moved) {
        promptIndex.sort((a, b) => a.mesId - b.mesId);
        indexDirty = true;
        rebuildArrayView();
    }
}

/**
 * Deletes the itemized prompt for a specific message.
 * Shifts down other itemized prompts as necessary — an index-only
 * operation; entry bodies are removed by id on the next save.
 * @param {number} messageId Message ID to delete itemized prompt for
 */
export function deleteItemizedPromptForMessage(messageId) {
    const sizeBefore = promptIndex.length;
    const removed = promptIndex.filter(x => x.mesId === messageId);
    promptIndex = promptIndex.filter(x => x.mesId !== messageId);

    for (const meta of removed) {
        deletedEntryIds.add(meta.id);
        dirtyEntryIds.delete(meta.id);
        hydratedEntries.delete(meta.id);
    }

    let shifted = false;
    for (const meta of promptIndex.filter(x => x.mesId > messageId)) {
        meta.mesId -= 1;
        shifted = true;
    }

    if (shifted || promptIndex.length !== sizeBefore) {
        indexDirty = true;
        rebuildArrayView();
    }
}
