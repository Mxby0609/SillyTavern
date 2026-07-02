#!/usr/bin/env node
/**
 * Performance benchmark fixture generator.
 *
 * Creates a deterministic long chat (~200k tokens) and a large World Info book
 * under the user's data directory, so the perf baseline scenarios can run
 * against realistic data volumes.
 *
 * Usage:
 *   node perf/generate-fixtures.js [--messages 1000] [--entries 300]
 *     [--data-root ./data] [--user default-user] [--avatar default_Seraphina.png]
 *
 * Output:
 *   data/<user>/chats/<avatar-without-png>/PerfBench-200k.jsonl
 *   data/<user>/worlds/PerfBench.json
 *
 * Deterministic: same arguments always produce identical files (seeded PRNG),
 * so before/after measurements compare the exact same workload.
 */

import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const MESSAGE_COUNT = Number(args.messages ?? 1000);
const ENTRY_COUNT = Number(args.entries ?? 300);
const DATA_ROOT = String(args['data-root'] ?? './data');
const USER_HANDLE = String(args.user ?? 'default-user');
const AVATAR = String(args.avatar ?? 'default_Seraphina.png');

const CHAT_FILE_NAME = 'PerfBench-200k';
const WORLD_NAME = 'PerfBench';
const USER_NAME = 'User';
const CHAR_NAME = 'Seraphina';

// Keywords sprinkled into chat text; "hot" WI entries key on these.
const KEYWORD_POOL = [
    'moonstone', 'ravencrest', 'ironhold', 'silverpine', 'duskwater',
    'emberfall', 'thornfield', 'greymarsh', 'starhollow', 'windmere',
    'oakhaven', 'frostgate', 'ashenvale', 'brightspire', 'shadowfen',
    'goldbrook', 'stormwatch', 'mistvale', 'redhollow', 'nightbloom',
];

// Keywords only present in WI entry contents; used to exercise recursion.
const RECURSION_POOL = [
    'eldertree', 'runestone', 'wyrmroot', 'palecrown', 'deepforge',
    'hollowking', 'saltspire', 'gloomharbor', 'sunveil', 'mirrorlake',
];

const WORDS = (
    'the ancient walls whispered secrets of forgotten ages while travelers ' +
    'crossed the misty valley seeking shelter from the coming storm and the ' +
    'old keeper watched from his tower remembering days when magic flowed ' +
    'freely through these lands before the great silence fell upon the realm ' +
    'now only echoes remain in dusty halls where heroes once gathered to ' +
    'plan their journeys across mountains rivers and endless plains toward ' +
    'destinies written in starlight and sealed with promises of glory'
).split(' ');

main();

function main() {
    const userDir = path.resolve(DATA_ROOT, USER_HANDLE);
    if (!fs.existsSync(userDir)) {
        console.error(`User directory not found: ${userDir}`);
        process.exit(1);
    }

    const chatDir = path.join(userDir, 'chats', AVATAR.replace('.png', ''));
    const worldsDir = path.join(userDir, 'worlds');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.mkdirSync(worldsDir, { recursive: true });

    const chatPath = path.join(chatDir, `${CHAT_FILE_NAME}.jsonl`);
    const worldPath = path.join(worldsDir, `${WORLD_NAME}.json`);

    const chatJsonl = generateChat(MESSAGE_COUNT);
    fs.writeFileSync(chatPath, chatJsonl, 'utf8');

    const world = generateWorld(ENTRY_COUNT);
    fs.writeFileSync(worldPath, JSON.stringify(world, null, 4), 'utf8');

    const chatBytes = Buffer.byteLength(chatJsonl);
    console.log(`Chat:  ${chatPath}`);
    console.log(`       ${MESSAGE_COUNT} messages, ${(chatBytes / 1024 / 1024).toFixed(2)} MB, ~${Math.round(chatBytes / 3.35 / 1000)}k tokens (guesstimate)`);
    console.log(`World: ${worldPath}`);
    console.log(`       ${ENTRY_COUNT} entries`);
}

function generateChat(count) {
    const rng = mulberry32(0xC0FFEE);
    const lines = [];

    const header = {
        user_name: USER_NAME,
        character_name: CHAR_NAME,
        create_date: '2026-1-1@00h00m00s',
        chat_metadata: { integrity: 'perfbench-fixture-0000' },
    };
    lines.push(JSON.stringify(header));

    // Start 2026-01-01, advance 1-5 minutes per message.
    let ts = Date.UTC(2026, 0, 1, 8, 0, 0);

    for (let i = 0; i < count; i++) {
        const isUser = i % 2 === 0;
        ts += (60 + Math.floor(rng() * 240)) * 1000;

        const message = {
            name: isUser ? USER_NAME : CHAR_NAME,
            is_user: isUser,
            is_system: false,
            send_date: formatSendDate(ts),
            mes: generateMessageText(rng, i, isUser),
            extra: {},
        };

        // Give some assistant messages a second swipe to mirror real chats.
        if (!isUser && rng() < 0.1) {
            message.swipe_id = 0;
            message.swipes = [message.mes, generateMessageText(rng, i, false)];
            message.swipe_info = [{}, {}];
        }

        lines.push(JSON.stringify(message));
    }

    return lines.join('\n');
}

function generateMessageText(rng, index, isUser) {
    // User messages shorter (~300 chars), assistant longer (~1200 chars).
    const paragraphs = isUser ? 1 : 2 + Math.floor(rng() * 2);
    const parts = [];

    for (let p = 0; p < paragraphs; p++) {
        const sentences = 2 + Math.floor(rng() * 4);
        const sentenceParts = [];
        for (let s = 0; s < sentences; s++) {
            sentenceParts.push(generateSentence(rng, index));
        }
        parts.push(sentenceParts.join(' '));
    }

    // Every ~25th assistant message carries a fenced code block (markdown cost).
    if (!isUser && index % 25 === 24) {
        parts.push('```js\nconst status = check("' + pick(rng, KEYWORD_POOL) + '");\nreturn status ? "open" : "sealed";\n```');
    }

    return parts.join('\n\n');
}

function generateSentence(rng, index) {
    const len = 8 + Math.floor(rng() * 14);
    const words = [];
    for (let i = 0; i < len; i++) {
        words.push(pick(rng, WORDS));
    }

    // Sprinkle a WI trigger keyword into roughly every 3rd message.
    if (index % 3 === 0 && rng() < 0.5) {
        words.splice(Math.floor(rng() * words.length), 0, pick(rng, KEYWORD_POOL));
    }

    let sentence = words.join(' ');
    sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';

    // Quoted speech exercises the quote-wrapping regex in messageFormatting.
    if (rng() < 0.3) {
        sentence += ' "' + pick(rng, WORDS) + ' ' + pick(rng, WORDS) + ' ' + pick(rng, WORDS) + '."';
    }
    // Asterisk emphasis blocks.
    if (rng() < 0.2) {
        sentence += ' *' + pick(rng, WORDS) + ' ' + pick(rng, WORDS) + '*';
    }

    return sentence;
}

function generateWorld(count) {
    const rng = mulberry32(0xBEEF);
    const entries = {};

    // Distribution: 60% dead keys, 30% hot keys, ~7% recursive, ~3% constant.
    const deadCount = Math.floor(count * 0.6);
    const hotCount = Math.floor(count * 0.3);
    const recursiveCount = Math.floor(count * 0.07);

    for (let uid = 0; uid < count; uid++) {
        let key, content, constant = false, delayUntilRecursion = 0;

        if (uid < deadCount) {
            // Never matches chat text: unique synthetic tokens.
            key = [`zx${uid}q${Math.floor(rng() * 9999)}`, `vk${uid}w`];
            content = `Dormant lore fragment #${uid}: ${loremChunk(rng, 30)}`;
        } else if (uid < deadCount + hotCount) {
            // Matches chat keywords; several entries share keys on purpose.
            key = [pick(rng, KEYWORD_POOL)];
            if (rng() < 0.3) key.push(pick(rng, KEYWORD_POOL));
            content = `The place called ${key[0]} holds meaning: ${loremChunk(rng, 40)}`;
            // ~1/3 of hot entries mention a recursion keyword, chaining activations.
            if (rng() < 0.35) {
                content += ` Its history ties to the ${pick(rng, RECURSION_POOL)}.`;
            }
        } else if (uid < deadCount + hotCount + recursiveCount) {
            // Activates only via recursion from hot-entry contents.
            key = [pick(rng, RECURSION_POOL)];
            content = `Deep lore of the ${key[0]}: ${loremChunk(rng, 40)}`;
            delayUntilRecursion = rng() < 0.5 ? 1 : 0;
        } else {
            // Constant entries: always inserted.
            key = [];
            constant = true;
            content = `Standing decree #${uid}: ${loremChunk(rng, 25)}`;
        }

        entries[uid] = {
            uid,
            key,
            keysecondary: [],
            comment: `perfbench entry ${uid}`,
            content,
            constant,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: false,
            order: Math.floor(rng() * 200),
            position: 0,
            disable: false,
            ignoreBudget: false,
            excludeRecursion: false,
            preventRecursion: false,
            matchPersonaDescription: false,
            matchCharacterDescription: false,
            matchCharacterPersonality: false,
            matchCharacterDepthPrompt: false,
            matchScenario: false,
            matchCreatorNotes: false,
            delayUntilRecursion,
            probability: 100,
            useProbability: true,
            depth: 4,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
        };
    }

    return { entries };
}

function loremChunk(rng, wordCount) {
    const words = [];
    for (let i = 0; i < wordCount; i++) {
        words.push(pick(rng, WORDS));
    }
    return words.join(' ');
}

function formatSendDate(epochMs) {
    // Matches the app's humanized format, e.g. "June 19, 2023 4:13pm".
    const d = new Date(epochMs);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    let hours = d.getUTCHours();
    const suffix = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12 || 12;
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${hours}:${minutes}${suffix}`;
}

function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                out[key] = next;
                i++;
            } else {
                out[key] = true;
            }
        }
    }
    return out;
}
