/**
 * Lightweight performance instrumentation for the perf-optimization branch.
 *
 * Disabled by default and designed to be zero-cost when off. Enable with:
 *   localStorage.setItem('perfTrace', '1'); location.reload();
 * Disable with:
 *   localStorage.removeItem('perfTrace'); location.reload();
 *
 * Read results in the browser console:
 *   __perfReport()        — aggregated table of all spans and accumulators
 *   __perfReset()         — clear collected data between scenarios
 *
 * This module must stay dependency-free: it is imported by hot-path modules
 * (script.js, tokenizers.js, world-info.js, PromptManager.js) and must never
 * create an import cycle.
 */

const ENABLED = (() => {
    try {
        return globalThis.localStorage?.getItem('perfTrace') === '1';
    } catch {
        return false;
    }
})();

/** @type {Map<string, {count: number, totalMs: number, maxMs: number}>} */
const accumulators = new Map();

/**
 * @returns {boolean} Whether performance tracing is enabled.
 */
export function perfEnabled() {
    return ENABLED;
}

/**
 * Places a named start mark. Pair with perfMeasure using the same base name.
 * @param {string} name Mark name, conventionally ending with ':start'
 */
export function perfMark(name) {
    if (!ENABLED) return;
    performance.mark(name);
}

/**
 * Records a measure from the most recent mark with the given start name.
 * Safe no-op if the start mark was never placed.
 * @param {string} name Measure name
 * @param {string} startMark Name of the start mark
 */
export function perfMeasure(name, startMark) {
    if (!ENABLED) return;
    try {
        performance.measure(name, startMark);
    } catch {
        // Start mark missing (e.g. early return path) — ignore.
    }
}

/**
 * Current time for accumulator spans; returns 0 when tracing is off so the
 * subtraction in callers stays branch-free.
 * @returns {number}
 */
export function perfNow() {
    return ENABLED ? performance.now() : 0;
}

/**
 * Accumulates a duration under a name. Use for high-frequency paths (e.g.
 * per streaming tick) where individual measure entries would flood the
 * performance timeline.
 * @param {string} name Accumulator name
 * @param {number} durationMs Duration to add
 */
export function perfAccum(name, durationMs) {
    if (!ENABLED) return;
    let entry = accumulators.get(name);
    if (!entry) {
        entry = { count: 0, totalMs: 0, maxMs: 0 };
        accumulators.set(name, entry);
    }
    entry.count++;
    entry.totalMs += durationMs;
    if (durationMs > entry.maxMs) entry.maxMs = durationMs;
}

/**
 * Aggregates all measures and accumulators into a report object and logs a
 * table. Shape: { [name]: { count, totalMs, avgMs, maxMs } }
 * @returns {Record<string, {count: number, totalMs: number, avgMs: number, maxMs: number}>}
 */
export function perfReport() {
    /** @type {Record<string, {count: number, totalMs: number, avgMs: number, maxMs: number}>} */
    const report = {};

    const measures = performance.getEntriesByType('measure');
    for (const measure of measures) {
        const row = report[measure.name] ?? { count: 0, totalMs: 0, avgMs: 0, maxMs: 0 };
        row.count++;
        row.totalMs += measure.duration;
        if (measure.duration > row.maxMs) row.maxMs = measure.duration;
        report[measure.name] = row;
    }

    for (const [name, entry] of accumulators.entries()) {
        report[name] = { count: entry.count, totalMs: entry.totalMs, avgMs: 0, maxMs: entry.maxMs };
    }

    for (const row of Object.values(report)) {
        row.avgMs = row.count > 0 ? row.totalMs / row.count : 0;
        row.totalMs = Math.round(row.totalMs * 100) / 100;
        row.avgMs = Math.round(row.avgMs * 100) / 100;
        row.maxMs = Math.round(row.maxMs * 100) / 100;
    }

    console.table(report);
    return report;
}

/**
 * Clears collected measures, marks and accumulators (between scenarios).
 */
export function perfReset() {
    accumulators.clear();
    performance.clearMeasures();
    performance.clearMarks();
}

if (ENABLED) {
    globalThis.__perfReport = perfReport;
    globalThis.__perfReset = perfReset;
    console.info('[perf-metrics] Performance tracing is ON. Use __perfReport() / __perfReset().');
}
