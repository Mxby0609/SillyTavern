/* eslint-env browser, es2022 */
/* eslint-disable playwright/no-wait-for-timeout, playwright/no-conditional-in-test */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * Performance baseline runner for the perf-optimization branch.
 *
 * Prerequisites:
 *   1. Fixtures generated: node perf/generate-fixtures.js (from repo root)
 *   2. Server running at http://127.0.0.1:8000
 *
 * Drives the fixture chat through the measured scenarios and prints a JSON
 * report built from the perf-metrics instrumentation (see
 * public/scripts/perf-metrics.js). Not a pass/fail regression test — numbers
 * are collected for before/after comparison across optimization stages.
 *
 * Run just this file:
 *   cd tests && npx playwright test perf-baseline --workers 1
 */

const CHAT_FILE = 'PerfBench-200k';
const WORLD_NAME = 'PerfBench';
const CHARACTER_NAME = 'Seraphina';

// Dry-run debounce is 1000ms; give the run itself generous room on top.
// (Also the timeout price paid per scenario when lazy dry-run defers the
// work and the measure legitimately never appears.)
const DRYRUN_SETTLE_MS = 8000;

test.describe.configure({ mode: 'serial' });

test.describe('Performance baseline', () => {
    test('collects baseline metrics for the fixture chat', async ({ page }) => {
        test.setTimeout(300000);

        await awaitSTFlexible(page);

        // Clear the persisted token cache so the cold-cache scenario
        // (switch-source-to-claude) stays cold across repeated runs.
        await page.evaluate(async () => {
            const store = globalThis.SillyTavern.libs.localforage.createInstance({ name: 'SillyTavern_ChatCompletions' });
            await store.clear();
        });

        // Enable instrumentation and reload so all modules pick up the flag
        // (and the in-memory token cache reloads from the now-empty store).
        await page.evaluate(() => localStorage.setItem('perfTrace', '1'));
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

        /** @type {Record<string, object|null>} */
        const results = {};

        // --- Scenario: open the 200k fixture chat (measures chat-render) ---
        await runCommands(page, `/go ${CHARACTER_NAME}`);
        await page.waitForTimeout(2000);
        await resetMetrics(page);
        await page.evaluate(async (chatFile) => {
            await globalThis.SillyTavern.getContext().openCharacterChat(chatFile);
        }, CHAT_FILE);
        await page.waitForTimeout(3000);
        results['open-chat'] = await collectMetrics(page);

        const messageCount = await page.evaluate(() => globalThis.SillyTavern.getContext().chat.length);
        expect(messageCount).toBeGreaterThan(900);

        // --- Activate the fixture lorebook ---
        await runCommands(page, `/world silent=true state=on ${WORLD_NAME}`);
        await page.waitForTimeout(1000);
        const activeWorlds = await page.evaluate(async () => {
            const wi = await import('/scripts/world-info.js');
            return wi.selected_world_info;
        });
        expect(activeWorlds).toContain(WORLD_NAME);

        // --- Unlock and raise the context to 200k so prompt assembly ---
        // --- actually walks the whole fixture chat (default is ~4k, which ---
        // --- stops token counting after a couple dozen messages) ---
        await page.evaluate(() => {
            const $ = globalThis.jQuery;
            $('#oai_max_context_unlocked').prop('checked', true).trigger('input');
            $('#openai_max_context').val(200000).trigger('input');
        });
        // The unlock handler re-triggers the source dropdown; let it settle.
        await waitForMeasure(page, 'pm-dryrun', DRYRUN_SETTLE_MS);
        await page.waitForTimeout(2000);

        // --- Scenario: switch chat completion source (measures pm-dryrun) ---
        await resetMetrics(page);
        await switchCompletionSource(page, 'claude');
        await waitForMeasure(page, 'pm-dryrun', DRYRUN_SETTLE_MS);
        results['switch-source-to-claude'] = await collectMetrics(page);

        await resetMetrics(page);
        await switchCompletionSource(page, 'openai');
        await waitForMeasure(page, 'pm-dryrun', DRYRUN_SETTLE_MS);
        results['switch-source-to-openai'] = await collectMetrics(page);

        // --- Scenario: model change within the same source ---
        await resetMetrics(page);
        await page.evaluate(() => {
            const $ = globalThis.jQuery;
            $('#model_openai_select').trigger('change');
        });
        await waitForMeasure(page, 'pm-dryrun', DRYRUN_SETTLE_MS);
        results['model-change'] = await collectMetrics(page);

        // --- Scenario: open the AI-config drawer. With lazy dry-run, this ---
        // --- replays the render deferred by the config changes above ---
        // --- (exactly one); on the unoptimized code it is a no-op. ---
        await resetMetrics(page);
        await page.click('#ai-config-button .drawer-toggle');
        await waitForMeasure(page, 'pm-dryrun', DRYRUN_SETTLE_MS);
        results['drawer-open-after-config-change'] = await collectMetrics(page);

        // Whichever code path ran, the prompt manager list must be populated.
        const pmListCount = await page.evaluate(() => document.querySelectorAll('#completion_prompt_manager_list > *').length);
        expect(pmListCount).toBeGreaterThan(0);

        // Close the drawer again so later scenarios run in the hidden state.
        await page.click('#ai-config-button .drawer-toggle');
        await page.waitForTimeout(500);

        // --- Scenario: full prompt assembly (dry-run Generate — the same ---
        // --- work a real send performs before the network call; a real ---
        // --- send is not possible without an API backend) ---
        await resetMetrics(page);
        await page.evaluate(async () => {
            await globalThis.SillyTavern.getContext().generate('normal', {}, true);
        });
        results['assemble-prompt'] = await collectMetrics(page);

        // --- Scenario: save chat + token cache (the post-send tail). The ---
        // --- cache write is idle-deferred under the sharding optimization, ---
        // --- so wait for its measure instead of a fixed pause. ---
        await resetMetrics(page);
        await page.evaluate(async () => {
            await globalThis.SillyTavern.getContext().saveChat();
        });
        await waitForMeasure(page, 'tokencache-save', DRYRUN_SETTLE_MS);
        results['save-chat'] = await collectMetrics(page);

        // Deactivate the fixture lorebook so other suites are unaffected.
        await runCommands(page, `/world silent=true state=off ${WORLD_NAME}`);

        console.log('===== PERF BASELINE REPORT =====');
        console.log(JSON.stringify(results, null, 2));
        console.log('================================');

        await test.info().attach('perf-baseline.json', {
            body: JSON.stringify(results, null, 2),
            contentType: 'application/json',
        });

        // Persist under perf/results/<stage>-<date>.json for cross-stage diffs.
        const stage = process.env.PERF_STAGE ?? 'baseline';
        const outDir = path.resolve(new URL('.', import.meta.url).pathname, '../../perf/results');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, `${stage}-${new Date().toISOString().slice(0, 10)}.json`);
        fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
        console.log(`Saved: ${outFile}`);
    });
});

/**
 * Waits for SillyTavern to load. Unlike testSetup.awaitST, this also works
 * with enableUserAccounts=false, where no user selection screen exists.
 * @param {import('@playwright/test').Page} page
 */
async function awaitSTFlexible(page) {
    await page.goto('/');
    const userSelect = page.locator('#userList .userSelect').last();
    try {
        await userSelect.click({ timeout: 5000 });
    } catch {
        // Single-user mode: no selection screen, app loads directly.
    }
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    await page.waitForFunction('globalThis.SillyTavern?.getContext !== undefined', { timeout: 60000 });
}

/**
 * Executes slash commands through the app's own parser.
 * @param {import('@playwright/test').Page} page
 * @param {string} commands
 */
async function runCommands(page, commands) {
    await page.evaluate(async (cmd) => {
        await globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions(cmd);
    }, commands);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} source
 */
async function switchCompletionSource(page, source) {
    await page.evaluate((src) => {
        const $ = globalThis.jQuery;
        $('#chat_completion_source').val(src).trigger('change');
    }, source);
}

/** @param {import('@playwright/test').Page} page */
async function resetMetrics(page) {
    await page.evaluate(() => globalThis.__perfReset?.());
}

/** @param {import('@playwright/test').Page} page */
async function collectMetrics(page) {
    return await page.evaluate(() => globalThis.__perfReport?.() ?? null);
}

/**
 * Waits until a named measure shows up in the performance timeline.
 * Resolves quietly on timeout — the report will just show the gap.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {number} timeoutMs
 */
async function waitForMeasure(page, name, timeoutMs) {
    try {
        await page.waitForFunction(
            (measureName) => performance.getEntriesByName(measureName, 'measure').length > 0,
            name,
            { timeout: timeoutMs },
        );
        // Let trailing work (render, follow-up saves) settle.
        await page.waitForTimeout(1500);
    } catch {
        console.warn(`Measure "${name}" did not appear within ${timeoutMs}ms`);
    }
}
