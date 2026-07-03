import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';

import {
    APPEND_JOURNAL_SUFFIX,
    BaseMismatchError,
    InvalidDeltaError,
    applyChatDelta,
    atomicWriteFile,
    discardAppendJournal,
    enqueueFileOperation,
    recoverAppendJournal,
    scanJsonlOffsets,
} from '../src/chat-file-surgery.js';

/**
 * The delta engine's contract: applying ops to the file must produce the
 * EXACT bytes a legacy full save of the same end state would produce
 * (lines joined with single newlines, no trailing newline).
 */

const HEADER = { user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: 'slug-1', note: '记事' } };

function makeMessage(index, text) {
    return { name: index % 2 ? '冷刃' : 'User', is_user: index % 2 === 0, mes: text, extra: { emoji: '🗡️' } };
}

function serializeChat(header, messages) {
    return [header, ...messages].map(x => JSON.stringify(x)).join('\n');
}

describe('chat-file-surgery', () => {
    /** @type {string} */
    let dir;
    /** @type {string} */
    let file;
    /** @type {object} */
    let header;
    /** @type {object[]} */
    let messages;

    const writeInitial = () => {
        const data = serializeChat(header, messages);
        fs.writeFileSync(file, data, 'utf8');
        return { lineCount: messages.length + 1, fileSize: Buffer.byteLength(data, 'utf8'), integrity: header.chat_metadata.integrity };
    };

    const readFile = () => fs.readFileSync(file, 'utf8');

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-surgery-'));
        file = path.join(dir, 'chat.jsonl');
        header = structuredClone(HEADER);
        messages = [makeMessage(0, 'hello 你好'), makeMessage(1, 'greetings — 长文本'.repeat(50)), makeMessage(2, 'third')];
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('golden byte equivalence with a legacy full save', () => {
        it('pure append of one and of several messages', async () => {
            let base = writeInitial();
            const one = makeMessage(3, 'appended 中文消息 🎈');
            let result = await applyChatDelta(file, base, [{ op: 'append', lines: [JSON.stringify(one)] }]);
            messages.push(one);
            expect(readFile()).toBe(serializeChat(header, messages));
            expect(result.fileSize).toBe(fs.statSync(file).size);
            expect(result.lineCount).toBe(messages.length + 1);

            const more = [makeMessage(4, 'a'), makeMessage(5, 'b')];
            result = await applyChatDelta(file, { ...base, lineCount: result.lineCount, fileSize: result.fileSize }, [
                { op: 'append', lines: more.map(m => JSON.stringify(m)) },
            ]);
            messages.push(...more);
            expect(readFile()).toBe(serializeChat(header, messages));
            expect(result.lineCount).toBe(messages.length + 1);
            expect(fs.existsSync(file + APPEND_JOURNAL_SUFFIX)).toBe(false);
        });

        it('replaceLast (the swipe/regenerate shape)', async () => {
            const base = writeInitial();
            const swapped = { ...messages.at(-1), mes: 'swiped ✨', swipe_id: 1, swipes: ['third', 'swiped ✨'] };
            await applyChatDelta(file, base, [{ op: 'replaceLast', line: JSON.stringify(swapped) }]);
            messages[messages.length - 1] = swapped;
            expect(readFile()).toBe(serializeChat(header, messages));
        });

        it('replace of a middle message', async () => {
            const base = writeInitial();
            const edited = { ...messages[1], mes: 'edited mid 中间编辑' };
            await applyChatDelta(file, base, [{ op: 'replace', index: 1, line: JSON.stringify(edited) }]);
            messages[1] = edited;
            expect(readFile()).toBe(serializeChat(header, messages));
        });

        it('truncate from a tail index', async () => {
            const base = writeInitial();
            await applyChatDelta(file, base, [{ op: 'truncate', fromIndex: 1 }]);
            messages = messages.slice(0, 1);
            expect(readFile()).toBe(serializeChat(header, messages));
        });

        it('header-only rewrite', async () => {
            const base = writeInitial();
            header.chat_metadata.lastInContextMessageId = 42;
            await applyChatDelta(file, base, [{ op: 'header', line: JSON.stringify(header) }]);
            expect(readFile()).toBe(serializeChat(header, messages));
        });

        it('header + append (the generation-final shape)', async () => {
            const base = writeInitial();
            header.chat_metadata.lastInContextMessageId = 2;
            const reply = makeMessage(3, 'assistant reply after generation');
            const result = await applyChatDelta(file, base, [
                { op: 'header', line: JSON.stringify(header) },
                { op: 'append', lines: [JSON.stringify(reply)] },
            ]);
            messages.push(reply);
            expect(readFile()).toBe(serializeChat(header, messages));
            expect(result).toEqual({ lineCount: messages.length + 1, fileSize: fs.statSync(file).size });
        });

        it('header + replaceLast + append mixed', async () => {
            const base = writeInitial();
            header.chat_metadata.tainted = true;
            const swapped = { ...messages.at(-1), mes: 'replaced' };
            const added = makeMessage(3, 'added');
            await applyChatDelta(file, base, [
                { op: 'replaceLast', line: JSON.stringify(swapped) },
                { op: 'header', line: JSON.stringify(header) },
                { op: 'append', lines: [JSON.stringify(added)] },
            ]);
            messages[messages.length - 1] = swapped;
            messages.push(added);
            expect(readFile()).toBe(serializeChat(header, messages));
        });

        it('multi-byte content keeps offsets honest', async () => {
            messages = [makeMessage(0, '🥟'.repeat(333)), makeMessage(1, 'テスト'.repeat(200))];
            const base = writeInitial();
            const edited = { ...messages[0], mes: '🍜'.repeat(100) };
            await applyChatDelta(file, base, [{ op: 'replace', index: 0, line: JSON.stringify(edited) }]);
            messages[0] = edited;
            expect(readFile()).toBe(serializeChat(header, messages));
            const scan = await scanJsonlOffsets(file);
            expect(scan.offsets.length).toBe(messages.length + 1);
        });
    });

    describe('base verification', () => {
        it('rejects a wrong file size without touching the file', async () => {
            const base = writeInitial();
            const before = readFile();
            await expect(applyChatDelta(file, { ...base, fileSize: base.fileSize + 1 }, [{ op: 'append', lines: ['{}'] }]))
                .rejects.toThrow(BaseMismatchError);
            expect(readFile()).toBe(before);
        });

        it('rejects a wrong line count', async () => {
            const base = writeInitial();
            await expect(applyChatDelta(file, { ...base, lineCount: base.lineCount + 1 }, [{ op: 'append', lines: ['{}'] }]))
                .rejects.toThrow(BaseMismatchError);
        });

        it('rejects a missing file', async () => {
            await expect(applyChatDelta(file, { lineCount: 1, fileSize: 10 }, [{ op: 'append', lines: ['{}'] }]))
                .rejects.toThrow(BaseMismatchError);
        });

        it('rejects an integrity slug mismatch when enforced, tolerates it when the file has no slug', async () => {
            const base = writeInitial();
            await expect(applyChatDelta(file, { ...base, integrity: 'other-slug' }, [{ op: 'append', lines: ['{}'] }], { enforceIntegrity: true }))
                .rejects.toThrow(BaseMismatchError);

            header = { chat_metadata: {} };
            const slugless = writeInitial();
            await expect(applyChatDelta(file, { ...slugless, integrity: 'other-slug' }, [{ op: 'append', lines: [JSON.stringify(makeMessage(9, 'x'))] }], { enforceIntegrity: true }))
                .resolves.toBeTruthy();
        });
    });

    describe('op validation', () => {
        it.each([
            ['unknown op', [{ op: 'squash' }]],
            ['empty ops', []],
            ['duplicate header', [{ op: 'header', line: '{}' }, { op: 'header', line: '{}' }]],
            ['replace index out of range', [{ op: 'replace', index: 99, line: '{}' }]],
            ['negative replace index', [{ op: 'replace', index: -1, line: '{}' }]],
            ['line with a newline', [{ op: 'append', lines: ['{"a":\n1}'] }]],
            ['line that is not JSON', [{ op: 'append', lines: ['not json'] }]],
            ['line that is a JSON scalar', [{ op: 'append', lines: ['42'] }]],
            ['truncate combined with replaceLast', [{ op: 'truncate', fromIndex: 1 }, { op: 'replaceLast', line: '{}' }]],
            ['replace of a truncated message', [{ op: 'truncate', fromIndex: 1 }, { op: 'replace', index: 2, line: '{}' }]],
            ['truncate out of range', [{ op: 'truncate', fromIndex: 3 }]],
        ])('rejects %s', async (_label, ops) => {
            const base = writeInitial();
            const before = readFile();
            await expect(applyChatDelta(file, base, ops)).rejects.toThrow(InvalidDeltaError);
            expect(readFile()).toBe(before);
        });
    });

    describe('append journal recovery', () => {
        const journalFor = (baseSize, payload) => {
            const headerLine = JSON.stringify({ baseSize, byteLength: payload.length, sha1: crypto.createHash('sha1').update(payload).digest('hex') });
            return Buffer.concat([Buffer.from(headerLine + '\n', 'utf8'), payload]);
        };
        const payloadFor = (msgs) => Buffer.from('\n' + msgs.map(m => JSON.stringify(m)).join('\n'), 'utf8');

        it('replays a complete journal when the append never landed', async () => {
            const base = writeInitial();
            const baseContent = readFile();
            const appended = [makeMessage(3, 'lost append')];
            const payload = payloadFor(appended);
            fs.writeFileSync(file + APPEND_JOURNAL_SUFFIX, journalFor(base.fileSize, payload));

            await recoverAppendJournal(file);
            expect(readFile()).toBe(baseContent + payload.toString('utf8'));
            expect(fs.existsSync(file + APPEND_JOURNAL_SUFFIX)).toBe(false);
        });

        it('completes a partially landed append (file tail is a payload prefix)', async () => {
            const base = writeInitial();
            const baseContent = readFile();
            const payload = payloadFor([makeMessage(3, 'partially written message content')]);
            fs.writeFileSync(file + APPEND_JOURNAL_SUFFIX, journalFor(base.fileSize, payload));
            fs.appendFileSync(file, payload.subarray(0, 10));

            await recoverAppendJournal(file);
            expect(readFile()).toBe(baseContent + payload.toString('utf8'));
        });

        it('is idempotent when the append fully landed but the journal was not cleared', async () => {
            const base = writeInitial();
            const baseContent = readFile();
            const payload = payloadFor([makeMessage(3, 'landed')]);
            fs.appendFileSync(file, payload);
            fs.writeFileSync(file + APPEND_JOURNAL_SUFFIX, journalFor(base.fileSize, payload));

            await recoverAppendJournal(file);
            expect(readFile()).toBe(baseContent + payload.toString('utf8'));
            expect(fs.existsSync(file + APPEND_JOURNAL_SUFFIX)).toBe(false);
        });

        it('truncates to base when the journal payload itself is incomplete', async () => {
            const base = writeInitial();
            const baseContent = readFile();
            const payload = payloadFor([makeMessage(3, 'cut short')]);
            const journal = journalFor(base.fileSize, payload);
            fs.writeFileSync(file + APPEND_JOURNAL_SUFFIX, journal.subarray(0, journal.length - 5));
            fs.appendFileSync(file, payload.subarray(0, 8));

            await recoverAppendJournal(file);
            expect(readFile()).toBe(baseContent);
            expect(fs.existsSync(file + APPEND_JOURNAL_SUFFIX)).toBe(false);
        });

        it('leaves the file alone when the journal header was cut short', async () => {
            const base = writeInitial();
            const before = readFile();
            void base;
            fs.writeFileSync(file + APPEND_JOURNAL_SUFFIX, '{"baseSize": 12');

            await recoverAppendJournal(file);
            expect(readFile()).toBe(before);
            expect(fs.existsSync(file + APPEND_JOURNAL_SUFFIX)).toBe(false);
        });

        it('never damages a foreign write: same-length tail mismatch', async () => {
            const base = writeInitial();
            const payload = payloadFor([makeMessage(3, 'ours-ours-ours')]);
            fs.writeFileSync(file + APPEND_JOURNAL_SUFFIX, journalFor(base.fileSize, payload));
            const foreign = Buffer.from(payload);
            foreign[5] = 0x58; // corrupt one byte -> not our prefix
            fs.appendFileSync(file, foreign);
            const before = readFile();

            await recoverAppendJournal(file);
            expect(readFile()).toBe(before);
            expect(fs.existsSync(file + APPEND_JOURNAL_SUFFIX)).toBe(false);
        });

        it('never damages a foreign write: file grew beyond the intended append', async () => {
            const base = writeInitial();
            const payload = payloadFor([makeMessage(3, 'x')]);
            fs.writeFileSync(file + APPEND_JOURNAL_SUFFIX, journalFor(base.fileSize, payload));
            fs.appendFileSync(file, payload);
            fs.appendFileSync(file, '\n{"foreign":true}');
            const before = readFile();

            await recoverAppendJournal(file);
            expect(readFile()).toBe(before);
        });

        it('never damages a foreign write: file shrank below the journaled base', async () => {
            const base = writeInitial();
            const payload = payloadFor([makeMessage(3, 'x')]);
            fs.writeFileSync(file + APPEND_JOURNAL_SUFFIX, journalFor(base.fileSize + 1000, payload));
            const before = readFile();
            void base;

            await recoverAppendJournal(file);
            expect(readFile()).toBe(before);
            expect(fs.existsSync(file + APPEND_JOURNAL_SUFFIX)).toBe(false);
        });

        it('discardAppendJournal drops a pending journal without touching the file', async () => {
            const base = writeInitial();
            const before = readFile();
            fs.writeFileSync(file + APPEND_JOURNAL_SUFFIX, journalFor(base.fileSize, payloadFor([makeMessage(3, 'x')])));

            await discardAppendJournal(file);
            expect(readFile()).toBe(before);
            expect(fs.existsSync(file + APPEND_JOURNAL_SUFFIX)).toBe(false);
        });

        it('journal is durably written BEFORE the append touches the file (crash injection)', async () => {
            const base = writeInitial();
            const baseContent = readFile();
            const message = makeMessage(3, 'crashed mid-append');
            const originalAppendFile = fs.promises.appendFile;
            fs.promises.appendFile = async () => { throw new Error('injected crash'); };
            try {
                await expect(applyChatDelta(file, base, [{ op: 'append', lines: [JSON.stringify(message)] }]))
                    .rejects.toThrow('injected crash');
            } finally {
                fs.promises.appendFile = originalAppendFile;
            }
            // The append never landed, but the journal must already hold the
            // payload — recovery completes the save with zero loss.
            await recoverAppendJournal(file);
            messages.push(message);
            expect(readFile()).toBe(serializeChat(header, messages));
            expect(readFile().startsWith(baseContent)).toBe(true);
        });
    });

    describe('infrastructure', () => {
        it('enqueueFileOperation serializes concurrent work on one file', async () => {
            // Both operations are enqueued in the SAME tick; the second only
            // observes firstFinished=true if the queue really serializes.
            let firstFinished = false;
            let observedByFirstWaiter = null;
            const slow = enqueueFileOperation(file, async () => {
                await new Promise(resolve => setTimeout(resolve, 50));
                firstFinished = true;
            });
            const fast = enqueueFileOperation(file, async () => {
                observedByFirstWaiter = firstFinished;
            });
            await Promise.all([slow, fast]);
            expect(observedByFirstWaiter).toBe(true);
        });

        it('queued deltas compose against the previous result', async () => {
            let base = writeInitial();
            const first = enqueueFileOperation(file, () => applyChatDelta(file, base, [{ op: 'append', lines: [JSON.stringify(makeMessage(3, 'first'))] }]));
            const second = first.then(result =>
                enqueueFileOperation(file, () => applyChatDelta(file, { lineCount: result.lineCount, fileSize: result.fileSize }, [{ op: 'append', lines: [JSON.stringify(makeMessage(4, 'second'))] }])));
            const [r1, r2] = await Promise.all([first, second]);
            expect(r2.lineCount).toBe(r1.lineCount + 1);
            messages.push(makeMessage(3, 'first'), makeMessage(4, 'second'));
            expect(readFile()).toBe(serializeChat(header, messages));
        });

        it('a failed queued operation does not poison the queue', async () => {
            const base = writeInitial();
            await expect(enqueueFileOperation(file, () => applyChatDelta(file, { ...base, fileSize: 1 }, [{ op: 'append', lines: ['{}'] }])))
                .rejects.toThrow(BaseMismatchError);
            await expect(enqueueFileOperation(file, () => applyChatDelta(file, base, [{ op: 'append', lines: [JSON.stringify(makeMessage(3, 'after failure'))] }])))
                .resolves.toBeTruthy();
        });

        it('atomicWriteFile replaces content and leaves no temp files', async () => {
            writeInitial();
            await atomicWriteFile(file, Buffer.from('{"fresh":true}', 'utf8'));
            expect(readFile()).toBe('{"fresh":true}');
            expect(fs.readdirSync(dir)).toEqual(['chat.jsonl']);
        });
    });
});
