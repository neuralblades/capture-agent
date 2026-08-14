import { ACTIONS_BY_TYPE, ActionType, MessageType, ItemType, ItemStatus } from "./contracts.js";
import { getMetrics, getAppliedItemIds, incrementMetric, setItemApplied, conversionRate, MetricName } from "./metrics.js";

const BACKEND_POSTS_URL = "http://localhost:8000/posts";
const BACKEND_CATEGORIES_URL = "http://localhost:8000/categories";
const BACKEND_GENERATE_EMAIL_URL = "http://localhost:8000/generate-email";
const BACKEND_CALCULATE_MATCH_URL = "http://localhost:8000/calculate-match";
// Written by extension/options/options.js and read by extension/content/form_autofill.js.
const PROFILE_STORAGE_KEY = "profile";

const ALL_CATEGORY = "All";

/** Sample data used only when no extension runtime is present (e.g. previewing the HTML directly). */
const SAMPLE_ITEMS = [
  {
    id: "sample-1",
    type: "deadline",
    title: "Scholarship application closes",
    detail: "Due Aug 20 · via x.com/edu_grants",
    sourceUrl: "https://x.com/edu_grants/status/1",
    createdAt: new Date().toISOString(),
    dueDate: new Date(Date.now() + 8 * 86400000).toISOString(),
    status: ItemStatus.NEW,
    contactEmail: "grants@edu-example.org",
    applyUrl: "https://docs.google.com/forms/d/e/sample-scholarship-form/viewform",
    links: [{ url: "https://docs.google.com/forms/d/e/sample-scholarship-form/viewform", label: "Google Form" }],
    matchScore: 85,
    matchingSkills: ["Python", "FastAPI"],
    missingSkills: ["Docker"],
    category: "Deadlines",
    isOpportunity: true,
  },
  {
    id: "sample-2",
    type: "book",
    title: "Deep Learning — Goodfellow, Bengio, Courville",
    detail: "Recommended by @ml_daily",
    sourceUrl: "https://x.com/ml_daily/status/2",
    createdAt: new Date().toISOString(),
    dueDate: null,
    status: ItemStatus.NEW,
    category: "Books",
  },
  {
    id: "sample-3",
    type: "study_plan",
    title: "4-week systems design refresher",
    detail: "Thread by @sys_notes, 12 posts",
    sourceUrl: "https://x.com/sys_notes/status/3",
    createdAt: new Date().toISOString(),
    dueDate: null,
    status: ItemStatus.NEW,
    matchScore: 42,
    category: "Study Plans",
    isOpportunity: true,
  },
];

const hasExtensionRuntime =
  typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;

const state = {
  activeTab: ALL_CATEGORY,
  query: "",
  items: [],
  sortByMatch: false,
  categories: [{ name: ALL_CATEGORY, count: 0 }],
  metrics: {},
  appliedIds: new Set(),
};

const els = {
  tabs: document.getElementById("tabs"),
  list: document.getElementById("list"),
  emptyState: document.getElementById("empty-state"),
  search: document.getElementById("search-input"),
  toast: document.getElementById("toast"),
  sortMatchBtn: document.getElementById("sort-match-btn"),
  statCaptures: document.getElementById("stat-captures"),
  statRate: document.getElementById("stat-rate"),
};

/** @returns {Promise<Record<string, unknown>>} Profile written by extension/options. */
function getProfile() {
  return new Promise((resolve) => {
    if (!hasExtensionRuntime || !chrome.storage?.local) {
      resolve({});
      return;
    }
    chrome.storage.local.get(PROFILE_STORAGE_KEY, (result) => {
      resolve(result[PROFILE_STORAGE_KEY] || {});
    });
  });
}

function sendMessage(message) {
  if (!hasExtensionRuntime) {
    return Promise.resolve({ ok: false, error: "No extension runtime available." });
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: "Empty response" });
    });
  });
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;
const GOOGLE_FORM_PATTERN = /forms\.gle|docs\.google\.com\/forms/i;

/**
 * Pulls candidate external URLs off a backend post: explicit fields the
 * backend may set (extracted_url, links, metadata.*) plus anything found by
 * scanning the raw content text. The post's own sourceUrl is excluded since
 * that's already reachable via the "Open" action.
 * @param {Record<string, unknown>} post
 * @returns {string[]}
 */
function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return /^https?:$/i.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

function extractExternalUrls(post) {
  const urls = new Set();

  if (isHttpUrl(post.extracted_url)) urls.add(post.extracted_url);

  if (Array.isArray(post.links)) {
    for (const link of post.links) {
      if (isHttpUrl(link)) urls.add(link);
      else if (link && isHttpUrl(link.url)) urls.add(link.url);
    }
  }

  if (post.metadata && typeof post.metadata === "object") {
    const metaUrl = post.metadata.apply_url || post.metadata.form_url || post.metadata.link || post.metadata.url;
    if (isHttpUrl(metaUrl)) urls.add(metaUrl);
  }

  if (typeof post.content === "string") {
    for (const match of post.content.match(URL_PATTERN) || []) {
      urls.add(match.replace(/[.,;:]+$/, ""));
    }
  }

  urls.delete(post.url);
  return Array.from(urls);
}

/**
 * Builds the pill list + primary "Apply / Open Form" target for a post's
 * extracted external links. Google Form links are preferred as the primary
 * apply target since they're the most common external application form, so
 * any match is floated to the front before truncating for display - otherwise
 * a form link outside the first few candidates would be silently dropped.
 * @param {string[]} urls
 */
function buildLinkInfo(urls) {
  if (urls.length === 0) return { applyUrl: null, links: [] };

  const ordered = [...urls].sort((a, b) => GOOGLE_FORM_PATTERN.test(b) - GOOGLE_FORM_PATTERN.test(a));

  const links = ordered.slice(0, 3).map((url) => {
    if (GOOGLE_FORM_PATTERN.test(url)) return { url, label: "Google Form" };
    try {
      return { url, label: new URL(url).hostname.replace(/^www\./, "") };
    } catch {
      return { url, label: "Link" };
    }
  });

  return { applyUrl: links[0].url, links };
}

/** Maps a backend `platform` value to how it should read in the UI. */
const PLATFORM_LABELS = {
  twitter: "X",
  linkedin: "LinkedIn",
  web_selection: "Web",
};

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || platform;
}

/**
 * Maps a backend PostRecord (see backend/models.py) to the CapturedItem shape
 * this UI renders. The backend doesn't classify posts as book/study_plan, so
 * anything without a resolved deadline falls back to the generic "post" type
 * and only shows under the "All" tab.
 * @param {Record<string, unknown>} post
 */
function mapPostToItem(post) {
  const deadline = Array.isArray(post.deadlines) && post.deadlines.length > 0 ? post.deadlines[0] : null;
  const { applyUrl, links } = buildLinkInfo(extractExternalUrls(post));
  return {
    id: `post-${post.id}`,
    postId: post.id,
    type: deadline ? ItemType.DEADLINE : ItemType.POST,
    title: post.summary || post.content,
    detail: deadline
      ? deadline.text
      : [post.author, platformLabel(post.platform)].filter(Boolean).join(" · "),
    sourceUrl: post.url || "",
    createdAt: post.created_at,
    dueDate: deadline ? deadline.iso_date : null,
    status: ItemStatus.NEW,
    contactEmail: post.contact_email || null,
    applyUrl,
    links,
    matchScore: typeof post.match_score === "number" ? post.match_score : null,
    matchingSkills: [],
    missingSkills: [],
    category: post.category || "General",
    isOpportunity: post.is_opportunity === true,
    applied: false,
  };
}

/** Merges persisted "Mark as Applied" state onto freshly loaded/pushed items, in place. */
function applyAppliedState(items) {
  for (const item of items) {
    item.applied = state.appliedIds.has(item.id);
  }
}

async function refreshMetrics() {
  const [metrics, appliedIds] = await Promise.all([getMetrics(), getAppliedItemIds()]);
  state.metrics = metrics;
  state.appliedIds = appliedIds;
}

async function loadPosts() {
  try {
    const response = await fetch(BACKEND_POSTS_URL);
    if (!response.ok) {
      throw new Error(`Failed to load posts (${response.status})`);
    }
    const posts = await response.json();
    const items = Array.isArray(posts) ? posts.map(mapPostToItem) : [];
    applyAppliedState(items);
    state.items = items;
    render();
    // Fire-and-forget: scores trickle in and each re-render as it resolves,
    // rather than blocking the initial list paint on N LLM calls.
    calculateMatchScores();
  } catch (error) {
    console.error("[CaptureAgent] Failed to load posts", error);
    showToast("Couldn't load captures", true);
  }
}

/** Scores every item that doesn't yet have a match score against the stored resume, if any. */
async function calculateMatchScores() {
  const profile = await getProfile();
  const resumeText = (profile.resumeText || "").trim();
  if (!resumeText) return;

  const pending = state.items.filter(
    (item) => item.postId != null && item.isOpportunity && item.matchScore == null
  );
  await Promise.all(pending.map((item) => calculateMatchForItem(item, resumeText)));
}

async function calculateMatchForItem(item, resumeText) {
  try {
    const response = await fetch(BACKEND_CALCULATE_MATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: item.postId, resume_text: resumeText }),
    });
    if (!response.ok) return;
    const result = await response.json();
    item.matchScore = result.match_score;
    item.matchingSkills = result.matching_skills || [];
    item.missingSkills = result.missing_skills || [];
    renderList();
  } catch (error) {
    console.error("[CaptureAgent] Match calculation failed", error);
  }
}

/** Fetches category filter pills (name + post count) from the backend. Falls
 * back to leaving the existing pills in place if the request fails, since a
 * stale "All" pill is less disruptive than the tab bar disappearing. */
async function loadCategories() {
  try {
    const response = await fetch(BACKEND_CATEGORIES_URL);
    if (!response.ok) {
      throw new Error(`Failed to load categories (${response.status})`);
    }
    const categories = await response.json();
    if (Array.isArray(categories) && categories.length > 0) {
      state.categories = categories;
      if (!categories.some((c) => c.name === state.activeTab)) {
        state.activeTab = ALL_CATEGORY;
      }
    }
    renderTabs();
  } catch (error) {
    console.error("[CaptureAgent] Failed to load categories", error);
  }
}

function filteredItems() {
  const q = state.query.trim().toLowerCase();
  const items = state.items.filter((item) => {
    if (state.activeTab !== ALL_CATEGORY && item.category !== state.activeTab) return false;
    if (item.status === ItemStatus.ARCHIVED) return false;
    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) || item.detail.toLowerCase().includes(q)
    );
  });

  if (state.sortByMatch) {
    // Unscored items (null) sort after every scored item, regardless of tie-breaking order.
    items.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
  }

  return items;
}

function renderTabs() {
  els.tabs.innerHTML = "";
  for (const category of state.categories) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab";
    btn.role = "tab";
    btn.dataset.tabId = category.name;
    btn.setAttribute("aria-selected", String(category.name === state.activeTab));
    btn.append(
      document.createTextNode(category.name),
      Object.assign(document.createElement("span"), { className: "tab-count", textContent: category.count })
    );
    btn.addEventListener("click", () => {
      state.activeTab = category.name;
      render();
    });
    els.tabs.appendChild(btn);
  }
}

function formatDetail(item) {
  if (item.type === "deadline" && item.dueDate) {
    const due = new Date(item.dueDate);
    const days = Math.ceil((due.getTime() - Date.now()) / 86400000);
    const when = days <= 0 ? "Overdue" : days === 1 ? "Due tomorrow" : `Due in ${days}d`;
    return `${when} · ${item.detail}`;
  }
  return item.detail;
}

/**
 * Actions to render for a card: the static per-type list, plus an "Apply /
 * Open Form" action when an external application link was extracted, plus a
 * "Draft Email" action whenever a contact email was detected on the post and
 * the type-based list doesn't already include one.
 * @param {ReturnType<typeof mapPostToItem>} item
 */
function actionsForItem(item) {
  const actions = [...(ACTIONS_BY_TYPE[item.type] || [])];

  if (item.applyUrl) {
    const openIdx = actions.findIndex((a) => a.action === ActionType.OPEN_SOURCE);
    const insertAt = openIdx === -1 ? actions.length : openIdx;
    actions.splice(insertAt, 0, { action: ActionType.APPLY_FORM, label: "Apply / Open Form" });
  }

  const hasDraftEmail = actions.some(({ action }) => action === ActionType.DRAFT_EMAIL);
  if (item.contactEmail && !hasDraftEmail) {
    actions.unshift({ action: ActionType.DRAFT_EMAIL, label: "Draft Email" });
  }

  return actions;
}

/** Threshold-based color tier for a resume match score, matching the pill legend (🟢/🟡/🔴). */
function matchTier(score) {
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function matchEmoji(score) {
  if (score >= 75) return "🟢";
  if (score >= 50) return "🟡";
  return "🔴";
}

function buildMatchPill(item) {
  const pill = document.createElement("span");
  pill.className = `match-pill ${matchTier(item.matchScore)}`;
  pill.textContent = `${matchEmoji(item.matchScore)} ${item.matchScore}% Match`;
  if (item.missingSkills && item.missingSkills.length > 0) {
    pill.title = `Missing: ${item.missingSkills.join(", ")}`;
  }
  return pill;
}

function renderList() {
  const items = filteredItems();
  els.list.innerHTML = "";
  els.emptyState.hidden = items.length > 0;

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "item-card";

    const head = document.createElement("div");
    head.className = "item-head";

    const badge = document.createElement("span");
    badge.className = `item-badge ${item.type}`;
    head.appendChild(badge);

    const body = document.createElement("div");
    body.className = "item-body";
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = item.title;
    const detail = document.createElement("div");
    detail.className = "item-detail";
    detail.textContent = formatDetail(item);
    body.appendChild(title);
    body.appendChild(detail);

    if (item.links && item.links.length > 0) {
      const pills = document.createElement("div");
      pills.className = "item-links";
      for (const link of item.links) {
        const pill = document.createElement("a");
        pill.className = "link-pill";
        pill.href = link.url;
        pill.textContent = link.label;
        pill.target = "_blank";
        pill.rel = "noopener noreferrer";
        pill.addEventListener("click", (e) => {
          if (hasExtensionRuntime && chrome.tabs?.create) {
            e.preventDefault();
            chrome.tabs.create({ url: link.url });
          }
        });
        pills.appendChild(pill);
      }
      body.appendChild(pills);
    }

    head.appendChild(body);

    if (item.isOpportunity && typeof item.matchScore === "number") {
      head.appendChild(buildMatchPill(item));
    }

    card.appendChild(head);

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const actionGroup = document.createElement("div");
    actionGroup.className = "action-group";
    for (const { action, label } of actionsForItem(item)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action-btn" + (action === "dismiss" ? " destructive" : "") + (action === ActionType.APPLY_FORM ? " primary" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => runAction(item, action, btn));
      actionGroup.appendChild(btn);
    }
    actions.appendChild(actionGroup);

    const applyToggle = document.createElement("label");
    applyToggle.className = "apply-toggle";
    const applyCheckbox = document.createElement("input");
    applyCheckbox.type = "checkbox";
    applyCheckbox.checked = !!item.applied;
    applyCheckbox.addEventListener("change", () => toggleApplied(item, applyCheckbox));
    const applyText = document.createElement("span");
    applyText.textContent = "Mark as Applied";
    applyToggle.appendChild(applyCheckbox);
    applyToggle.appendChild(applyText);
    actions.appendChild(applyToggle);

    card.appendChild(actions);

    els.list.appendChild(card);
  }
}

/** Builds a Gmail compose deep link pre-filled with recipient, subject, and body. */
function gmailComposeUrl({ to, subject, body }) {
  const params = [
    ["view", "cm"],
    ["fs", "1"],
    ["to", to],
    ["su", subject],
    ["body", body],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `https://mail.google.com/mail/?${params}`;
}

/** Toggles an item's self-reported "applied" state and syncs the applications_submitted metric. */
async function toggleApplied(item, checkboxEl) {
  checkboxEl.disabled = true;
  try {
    const { metrics } = await setItemApplied(item.id, checkboxEl.checked);
    item.applied = checkboxEl.checked;
    state.metrics = metrics;
    renderStats();
    showToast(checkboxEl.checked ? "Marked as applied" : "Unmarked as applied");
  } catch (error) {
    console.error("[CaptureAgent] Failed to update applied status", error);
    checkboxEl.checked = !checkboxEl.checked;
    showToast("Couldn't update status", true);
  } finally {
    checkboxEl.disabled = false;
  }
}

async function draftEmail(item, triggerEl) {
  if (!item.contactEmail) {
    showToast("No contact email detected", true);
    return;
  }

  triggerEl.disabled = true;
  try {
    const response = await fetch(BACKEND_GENERATE_EMAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        post_id: item.postId,
        recipient_email: item.contactEmail,
      }),
    });
    if (!response.ok) {
      throw new Error(`Draft request failed (${response.status})`);
    }
    const { subject, body } = await response.json();
    const url = gmailComposeUrl({ to: item.contactEmail, subject, body });
    if (hasExtensionRuntime && chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank", "noopener");
    }
    showToast("Draft ready in Gmail");
    state.metrics = await incrementMetric(MetricName.EMAILS_DRAFTED);
    renderStats();
  } catch (error) {
    console.error("[CaptureAgent] Draft email failed", error);
    showToast("Couldn't draft email", true);
  } finally {
    triggerEl.disabled = false;
  }
}

async function runAction(item, action, triggerEl) {
  if (action === "open_source" || action === ActionType.APPLY_FORM) {
    const url = action === ActionType.APPLY_FORM ? item.applyUrl : item.sourceUrl;
    if (!url) {
      showToast(action === ActionType.APPLY_FORM ? "No application link available" : "No source link available", true);
      return;
    }
    if (hasExtensionRuntime && chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank", "noopener");
    }
    if (action === ActionType.APPLY_FORM) {
      state.metrics = await incrementMetric(MetricName.FORMS_OPENED);
      renderStats();
    }
    return;
  }

  if (action === ActionType.DRAFT_EMAIL) {
    await draftEmail(item, triggerEl);
    return;
  }

  triggerEl.disabled = true;
  const response = await sendMessage({
    type: MessageType.RUN_ACTION,
    action,
    itemId: item.id,
    postId: item.postId,
  });
  triggerEl.disabled = false;

  if (!response.ok) {
    showToast(response.error || "Action failed", true);
    return;
  }

  if (action === "dismiss") {
    state.items = state.items.filter((i) => i.id !== item.id);
    render();
    loadCategories();
  }
  showToast(response.ok ? "Done" : "Action failed", !response.ok);
}

let toastTimer = null;
function showToast(message, isError) {
  els.toast.textContent = message;
  els.toast.className = "toast" + (isError ? " error" : "");
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2200);
}

function renderStats() {
  els.statCaptures.textContent = String(state.metrics[MetricName.CAPTURES_TOTAL] || 0);
  els.statRate.textContent = `${Math.round(conversionRate(state.metrics))}%`;
}

function render() {
  renderStats();
  renderTabs();
  renderList();
}

els.sortMatchBtn.addEventListener("click", () => {
  state.sortByMatch = !state.sortByMatch;
  els.sortMatchBtn.setAttribute("aria-pressed", String(state.sortByMatch));
  renderList();
});

let searchDebounce = null;
els.search.addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  const value = e.target.value;
  searchDebounce = setTimeout(() => {
    state.query = value;
    renderList();
  }, 120);
});

if (hasExtensionRuntime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MessageType.REFRESH_POSTS) {
      refreshMetrics().then(loadPosts);
      loadCategories();
    }
    if (message?.type === MessageType.ITEMS_UPDATED && Array.isArray(message.items)) {
      applyAppliedState(message.items);
      state.items = message.items;
      render();
    }
  });
}

/** Builds category filter pills locally from sample data, for previewing the HTML directly without a backend. */
function categoriesFromItems(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) || 0) + 1);
  }
  return [{ name: ALL_CATEGORY, count: items.length }, ...[...counts].map(([name, count]) => ({ name, count }))];
}

async function boot() {
  await refreshMetrics();
  if (!hasExtensionRuntime) {
    const items = SAMPLE_ITEMS;
    applyAppliedState(items);
    state.items = items;
    state.categories = categoriesFromItems(SAMPLE_ITEMS);
    render();
    return;
  }
  await loadPosts();
  loadCategories();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
