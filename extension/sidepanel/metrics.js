/**
 * Local funnel metrics engine, backed by `chrome.storage.local`. Tracks the
 * capture-to-application lifecycle counters from issue #33 --
 * `captures_total`, `forms_opened`, `emails_drafted`, `applications_submitted`
 * -- plus which items have been self-reported as "applied", so the sidepanel
 * can render a conversion funnel without a backend round trip.
 *
 * Importable from any extension context (service worker or sidepanel page);
 * falls back to an in-memory store when `chrome.storage` isn't available
 * (e.g. previewing sidepanel.html directly outside the extension runtime).
 */

const METRICS_KEY = "captureAgent.metrics";
const APPLIED_KEY = "captureAgent.appliedItemIds";

/** @enum {string} */
export const MetricName = Object.freeze({
  CAPTURES_TOTAL: "captures_total",
  FORMS_OPENED: "forms_opened",
  EMAILS_DRAFTED: "emails_drafted",
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
let memoryAppliedIds = [];

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

/** @returns {Promise<Record<string, number>>} */
export async function getMetrics() {
  if (!hasStorage) return { ...memoryMetrics };
  const stored = await readStorage(METRICS_KEY, DEFAULT_METRICS);
  return { ...DEFAULT_METRICS, ...stored };
}

/**
 * @param {string} name One of {@link MetricName}.
 * @param {number} [by]
 * @returns {Promise<Record<string, number>>} The updated metrics.
 */
export async function incrementMetric(name, by = 1) {
  const metrics = await getMetrics();
  metrics[name] = (metrics[name] || 0) + by;

  if (!hasStorage) {
    memoryMetrics = metrics;
  } else {
    await writeStorage(METRICS_KEY, metrics);
  }
  return metrics;
}

/** @returns {Promise<Set<string>>} */
export async function getAppliedItemIds() {
  if (!hasStorage) return new Set(memoryAppliedIds);
  const stored = await readStorage(APPLIED_KEY, []);
  return new Set(Array.isArray(stored) ? stored : []);
}

/**
 * Marks (or unmarks) an item as applied and keeps `applications_submitted`
 * in sync with the transition. Toggling an item that's already in the
 * requested state is a no-op for the counter -- re-rendering the same
 * checked checkbox must not inflate `applications_submitted`.
 * @param {string} itemId
 * @param {boolean} applied
 * @returns {Promise<{appliedIds: Set<string>, metrics: Record<string, number>}>}
 */
export async function setItemApplied(itemId, applied) {
  const appliedIds = await getAppliedItemIds();
  const wasApplied = appliedIds.has(itemId);

  if (applied === wasApplied) {
    return { appliedIds, metrics: await getMetrics() };
  }

  if (applied) appliedIds.add(itemId);
  else appliedIds.delete(itemId);

  const idsArray = Array.from(appliedIds);
  if (!hasStorage) {
    memoryAppliedIds = idsArray;
  } else {
    await writeStorage(APPLIED_KEY, idsArray);
  }

  const metrics = await incrementMetric(MetricName.APPLICATIONS_SUBMITTED, applied ? 1 : -1);
  return { appliedIds, metrics };
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
