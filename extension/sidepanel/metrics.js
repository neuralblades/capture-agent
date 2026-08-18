/**
 * Local funnel metrics engine, backed by `chrome.storage.local`. Tracks the
 * capture-to-application lifecycle counters from issue #33 --
 * `captures_total`, `forms_opened`, `emails_drafted` -- so the sidepanel can
 * render a conversion funnel without a backend round trip for those.
 * `applications_submitted` is derived at render time in sidepanel.js from
 * the backend `status === "applied"` field on loaded posts (see issue #66)
 * rather than tracked here, so it survives `chrome.storage.local` being
 * cleared and stays in sync across devices.
 *
 * `captures_total` only counts posts classified as job/application-type
 * opportunities (see `is_opportunity` on the backend PostRecord) -- general
 * captures like book recommendations or articles aren't part of the
 * application funnel and would otherwise deflate the conversion rate.
 *
 * Importable from any extension context (service worker or sidepanel page);
 * falls back to an in-memory store when `chrome.storage` isn't available
 * (e.g. previewing sidepanel.html directly outside the extension runtime).
 */

const METRICS_KEY = "captureAgent.metrics";

/** @enum {string} */
export const MetricName = Object.freeze({
  CAPTURES_TOTAL: "captures_total",
  FORMS_OPENED: "forms_opened",
  EMAILS_DRAFTED: "emails_drafted",
  // Not stored/incremented here -- see file header. Kept as a key name so
  // conversionRate() and callers share one constant for it.
  APPLICATIONS_SUBMITTED: "applications_submitted",
});

const DEFAULT_METRICS = Object.freeze({
  [MetricName.CAPTURES_TOTAL]: 0,
  [MetricName.FORMS_OPENED]: 0,
  [MetricName.EMAILS_DRAFTED]: 0,
  [MetricName.APPLICATIONS_SUBMITTED]: 0,
});

const hasStorage = typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.local;

// In-memory fallback so this module still behaves outside an extension
// runtime instead of throwing on every call.
let memoryMetrics = { ...DEFAULT_METRICS };

function readStorage(key, fallback) {
  if (!hasStorage) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result && key in result ? result[key] : fallback);
    });
  });
}

function writeStorage(key, value) {
  if (!hasStorage) return Promise.resolve();
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

// `chrome.storage.local.get`/`.set` are independent async round trips, so a
// naive read-modify-write (get the object, mutate in JS, set it back) isn't
// atomic: two overlapping increments -- even from different contexts, e.g.
// the background service worker bumping captures_total while the sidepanel
// bumps forms_opened/emails_drafted, or just two rapid clicks inside the
// sidepanel itself -- can interleave their get/set pairs and silently
// clobber one update. Every read-modify-write in this module runs inside
// `withMetricsLock` to serialize them.
//
// The Web Locks API coordinates across *all* contexts sharing this
// extension's origin (service worker + every open extension page), which a
// plain in-module mutex can't do since each context has its own JS heap.
// Fall back to an in-module promise chain (same-context only) on the off
// chance `navigator.locks` isn't available.
const LOCK_NAME = "captureAgent.metricsLock";
const hasLocks = typeof navigator !== "undefined" && !!navigator.locks && typeof navigator.locks.request === "function";

let writeChain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withMetricsLock(fn) {
  if (hasLocks) {
    return navigator.locks.request(LOCK_NAME, fn);
  }
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function readMetricsUnlocked() {
  if (!hasStorage) return { ...memoryMetrics };
  const stored = await readStorage(METRICS_KEY, DEFAULT_METRICS);
  return { ...DEFAULT_METRICS, ...stored };
}

async function writeMetricsUnlocked(metrics) {
  if (!hasStorage) {
    memoryMetrics = metrics;
  } else {
    await writeStorage(METRICS_KEY, metrics);
  }
}

/** @returns {Promise<Record<string, number>>} A point-in-time snapshot; not lock-guarded since a plain read can't corrupt state. */
export function getMetrics() {
  return readMetricsUnlocked();
}

/**
 * @param {string} name One of {@link MetricName}.
 * @param {number} [by]
 * @returns {Promise<Record<string, number>>} The updated metrics.
 */
export function incrementMetric(name, by = 1) {
  return withMetricsLock(async () => {
    const metrics = await readMetricsUnlocked();
    metrics[name] = (metrics[name] || 0) + by;
    await writeMetricsUnlocked(metrics);
    return metrics;
  });
}

/**
 * @param {Record<string, number>} metrics
 * @returns {number} Percentage (0-100), 0 when there are no captures yet.
 */
export function conversionRate(metrics) {
  const total = metrics?.[MetricName.CAPTURES_TOTAL] || 0;
  if (total <= 0) return 0;
  return ((metrics[MetricName.APPLICATIONS_SUBMITTED] || 0) / total) * 100;
}
