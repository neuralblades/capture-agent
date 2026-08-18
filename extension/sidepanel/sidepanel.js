import { ACTIONS_BY_TYPE, ActionType, MessageType, ItemType, ItemStatus } from "./contracts.js";
import { getMetrics, incrementMetric, conversionRate, MetricName } from "./metrics.js";

const BACKEND_POSTS_URL = "http://localhost:8000/posts";
const BACKEND_CATEGORIES_URL = "http://localhost:8000/categories";
const BACKEND_GENERATE_EMAIL_URL = "http://localhost:8000/generate-email";
const BACKEND_CALCULATE_MATCH_URL = "http://localhost:8000/calculate-match";
const BACKEND_STATS_OVERVIEW_URL = "http://localhost:8000/stats/overview";
const BACKEND_APPLIED_COUNT_URL = "http://localhost:8000/stats/applied-count";
const BACKEND_DIGEST_URL = "http://localhost:8000/digest";
// Written by extension/options/options.js and read by extension/content/form_autofill.js.
const PROFILE_STORAGE_KEY = "profile";

const ALL_CATEGORY = "All";
const ALL_PLATFORM = "All";

const VIEW_LIST = "list";
const VIEW_OVERVIEW = "overview";

/** Page size for `GET /posts?limit=&offset=`, both for the initial load and each "Load More". */
const POSTS_PAGE_SIZE = 50;

/** Full-tab dashboard mode (issue #68) is opted into via ?mode=dashboard,
 * not viewport-width sniffing -- the side panel is user-resizable, so width
 * alone isn't a reliable signal for which layout to render. */
const DASHBOARD_MODE_PARAM = "mode";
const DASHBOARD_MODE_VALUE = "dashboard";

/** Sidebar sections for dashboard mode. Each maps onto filters that already
 * exist for docked mode (platform tabs, the is_opportunity flag, Overview) --
 * see switchDashboardSection(). Categories stay a filter *within* a section
 * rather than becoming a section of their own (LLM-open-ended, numerous). */
const DASHBOARD_SECTIONS = [
  { id: "inbox", label: "Inbox" },
  { id: "rss", label: "RSS" },
  { id: "github", label: "GitHub" },
  { id: "jobs", label: "Jobs" },
  { id: "overview", label: "Overview" },
];

/** Section id -> platform filter, for the sections that are really just a
 * platform tab relocated into the sidebar. Sections not listed here (inbox,
 * jobs, overview) don't filter by platform. */
const DASHBOARD_SECTION_PLATFORM = { rss: "rss", github: "github" };

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
    lifecycleStatus: ItemStatus.NEW,
    contactEmail: "grants@edu-example.org",
    applyUrl: "https://docs.google.com/forms/d/e/sample-scholarship-form/viewform",
    links: [{ url: "https://docs.google.com/forms/d/e/sample-scholarship-form/viewform", label: "Google Form" }],
    matchScore: 85,
    matchingSkills: ["Python", "FastAPI"],
    missingSkills: ["Docker"],
    category: "Deadlines",
    isOpportunity: true,
    postedAt: new Date(Date.now() - 3 * 3600000).toISOString(),
    platform: "twitter",
    status: null,
    notes: null,
    resurfaceAt: null,
  },
  {
    id: "sample-2",
    type: "book",
    title: "Deep Learning — Goodfellow, Bengio, Courville",
    detail: "Recommended by @ml_daily",
    sourceUrl: "https://x.com/ml_daily/status/2",
    createdAt: new Date().toISOString(),
    dueDate: null,
    lifecycleStatus: ItemStatus.NEW,
    category: "Books",
    platform: "twitter",
    status: null,
    notes: null,
    // Set in the past to preview the "Resurfaced" pill/sort-to-top behavior.
    resurfaceAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: "sample-3",
    type: "study_plan",
    title: "4-week systems design refresher",
    detail: "Thread by @sys_notes, 12 posts",
    sourceUrl: "https://x.com/sys_notes/status/3",
    createdAt: new Date().toISOString(),
    dueDate: null,
    lifecycleStatus: ItemStatus.NEW,
    matchScore: 42,
    category: "Study Plans",
    isOpportunity: true,
    postedAt: new Date(Date.now() - 20 * 86400000).toISOString(),
    platform: "twitter",
    status: null,
    notes: null,
    resurfaceAt: null,
  },
];

const hasExtensionRuntime =
  typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;

const state = {
  view: VIEW_LIST,
  activeTab: ALL_CATEGORY,
  activePlatform: ALL_PLATFORM,
  query: "",
  items: [],
  sortByMatch: false,
  categories: [{ name: ALL_CATEGORY, count: 0 }],
  metrics: {},
  // All-time count of applied opportunities from GET /stats/applied-count,
  // *not* derived from state.items -- that only ever holds one page of
  // GET /posts (limit=50 default), which would silently undercount once a
  // workspace has more than 50 captures. Kept in sync with an optimistic
  // +/-1 in toggleApplied() plus a refetch on every load/refresh.
  appliedCount: 0,
  stats: null,
  // Ids of items with their notes/snooze editors expanded, per-render UI
  // state kept here (not on the item) since renderList() rebuilds the DOM
  // from scratch on every call and would otherwise forget it was open.
  expandedNotes: new Set(),
  expandedSnooze: new Set(),
  // Pagination over `GET /posts` (backend/main.py's `list_posts`, ordered newest-first).
  // `offset` is the backend cursor for the next "Load More" fetch; `hasMore` is inferred
  // from the last page's length rather than a separate /posts/count round trip.
  offset: 0,
  hasMore: false,
  loadingMore: false,
  dashboardMode: new URLSearchParams(location.search).get(DASHBOARD_MODE_PARAM) === DASHBOARD_MODE_VALUE,
  dashboardSection: "inbox",
  // Jobs section filter -- reuses the is_opportunity flag rather than a platform,
  // so it's tracked separately from activePlatform (see filteredItems()).
  jobsOnly: false,
};

const els = {
  tabs: document.getElementById("tabs"),
  platformTabs: document.getElementById("platform-tabs"),
  dashboardSidebar: document.getElementById("dashboard-sidebar"),
  list: document.getElementById("list"),
  loadMoreBtn: document.getElementById("load-more-btn"),
  emptyState: document.getElementById("empty-state"),
  search: document.getElementById("search-input"),
  toast: document.getElementById("toast"),
  sortMatchBtn: document.getElementById("sort-match-btn"),
  digestBtn: document.getElementById("digest-btn"),
  statCaptures: document.getElementById("stat-captures"),
  statRate: document.getElementById("stat-rate"),
  viewTabList: document.getElementById("view-tab-list"),
  viewTabOverview: document.getElementById("view-tab-overview"),
  overviewView: document.getElementById("overview-view"),
  overviewEmpty: document.getElementById("overview-empty"),
  overviewContent: document.getElementById("overview-content"),
  overviewStats: document.getElementById("overview-stats"),
  overviewPlatformBars: document.getElementById("overview-platform-bars"),
  overviewCategoryBars: document.getElementById("overview-category-bars"),
  overviewTrend: document.getElementById("overview-trend"),
  overviewTrendRange: document.getElementById("overview-trend-range"),
  openDashboardBtn: document.getElementById("open-dashboard-btn"),
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
 * backend may set (external_url, links, metadata.*) -- trusted, since the
 * backend only populates these when it's confident they're the real
 * application/action link -- plus anything found by scanning the raw
 * content text, which gets no such vetting. The post's own sourceUrl is
 * excluded since that's already reachable via the "Open" action.
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

/**
 * Known platform-internal link-shortener domains: X's t.co, LinkedIn's
 * lnkd.in. Both platforms route *every* external link a user posts through
 * these -- including genuine application links -- so a shortener domain on
 * its own isn't a sign of noise; it's only excluded from the raw
 * regex-scanned content below, where there's no other signal to go on.
 */
const LINK_SHORTENER_HOSTS = new Set(["t.co", "lnkd.in"]);

function isPlatformShortLink(url) {
  try {
    return LINK_SHORTENER_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function extractExternalUrls(post) {
  const trustedUrls = new Set();

  if (isHttpUrl(post.external_url)) trustedUrls.add(post.external_url);

  if (Array.isArray(post.links)) {
    for (const link of post.links) {
      if (isHttpUrl(link)) trustedUrls.add(link);
      else if (link && isHttpUrl(link.url)) trustedUrls.add(link.url);
    }
  }

  if (post.metadata && typeof post.metadata === "object") {
    const metaUrl = post.metadata.apply_url || post.metadata.form_url || post.metadata.link || post.metadata.url;
    if (isHttpUrl(metaUrl)) trustedUrls.add(metaUrl);
  }

  // A blind sweep for anything URL-shaped in the raw post text, with no
  // semantic vetting behind it -- unlike the trusted fields above, a
  // platform link-shortener found only here is filtered out as noise
  // (e.g. a decorative/self-referential link with no real destination
  // info to offer beyond what's already shown).
  const scannedUrls = new Set();
  if (typeof post.content === "string") {
    for (const match of post.content.match(URL_PATTERN) || []) {
      const url = match.replace(/[.,;:]+$/, "");
      if (!isPlatformShortLink(url)) scannedUrls.add(url);
    }
  }

  const urls = new Set([...trustedUrls, ...scannedUrls]);
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
  rss: "RSS",
  github: "GitHub",
};

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || platform;
}

/**
 * Maps a backend PostRecord (see backend/models.py) to the CapturedItem shape
 * this UI renders. The backend doesn't classify posts as book/study_plan, so
 * anything without a resolved deadline falls back to the generic "post" type
 * and only shows under the "All" tab.
 *
 * The backend's LLM classifier (deadlines/is_opportunity/action_type) has no
 * platform awareness -- it runs the same way over every captured post. For
 * GitHub repo captures that's a mismatch: a README's prose can easily
 * contain a deadline-shaped date (changelog entries, "Support ends...",
 * etc.) with nothing for the user to actually apply to, which would
 * otherwise surface a misleading "Fill Form" / "Apply" action for what's
 * just reference material. Rather than teach every LLM provider prompt
 * about every platform's semantics, github posts are forced to the plain
 * "post" type here and never treated as an opportunity -- the repo's
 * "Website" link (captured into the post's own content by github.js) still
 * surfaces normally as an "Open Link" pill via the existing link-extraction
 * path below.
 * @param {Record<string, unknown>} post
 */
function mapPostToItem(post) {
  const isGithub = post.platform === "github";
  const deadline = !isGithub && Array.isArray(post.deadlines) && post.deadlines.length > 0 ? post.deadlines[0] : null;
  const { applyUrl, links } = buildLinkInfo(extractExternalUrls(post));
  return {
    id: `post-${post.id}`,
    postId: post.id,
    type: deadline ? ItemType.DEADLINE : ItemType.POST,
    title: post.summary || post.content,
    detail: deadline
      ? deadline.text
      : [post.author, platformLabel(post.platform)].filter(Boolean).join(" · "),
    platform: post.platform,
    sourceUrl: post.url || "",
    createdAt: post.created_at,
    dueDate: deadline ? deadline.iso_date : null,
    lifecycleStatus: ItemStatus.NEW,
    contactEmail: post.contact_email || null,
    applyUrl,
    links,
    matchScore: typeof post.match_score === "number" ? post.match_score : null,
    matchingSkills: [],
    missingSkills: [],
    category: post.category || "General",
    isOpportunity: !isGithub && post.is_opportunity === true,
    postedAt: typeof post.posted_at === "string" ? post.posted_at : null,
    status: typeof post.status === "string" ? post.status : null,
    notes: typeof post.notes === "string" ? post.notes : null,
    resurfaceAt: typeof post.resurface_at === "string" ? post.resurface_at : null,
  };
}

async function refreshMetrics() {
  state.metrics = await getMetrics();
}

/** Fetches one page of `GET /posts`, newest-first. Returns `[]` on a non-array body. */
async function fetchPostsPage(offset, limit) {
  const url = `${BACKEND_POSTS_URL}?limit=${limit}&offset=${offset}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load posts (${response.status})`);
  }
  const posts = await response.json();
  return Array.isArray(posts) ? posts : [];
}

async function loadPosts() {
  try {
    const posts = await fetchPostsPage(0, POSTS_PAGE_SIZE);
    state.items = posts.map(mapPostToItem);
    state.offset = posts.length;
    state.hasMore = posts.length === POSTS_PAGE_SIZE;
    render();
    // Fire-and-forget: scores trickle in and each re-render as it resolves,
    // rather than blocking the initial list paint on N LLM calls.
    calculateMatchScores();
  } catch (error) {
    console.error("[CaptureAgent] Failed to load posts", error);
    showToast("Couldn't load captures", true);
  }
}

/** "Load More": fetches the next page at `state.offset` and appends it. Items already
 * present (by id) are dropped rather than duplicated -- a live capture arriving between
 * pages shifts every backend offset down by one, which would otherwise re-fetch the
 * previous page's last item. */
async function loadMorePosts() {
  if (state.loadingMore || !state.hasMore) return;
  state.loadingMore = true;
  renderLoadMoreButton();
  try {
    const posts = await fetchPostsPage(state.offset, POSTS_PAGE_SIZE);
    const newItems = posts.map(mapPostToItem);
    const existingIds = new Set(state.items.map((item) => item.id));
    const appended = newItems.filter((item) => !existingIds.has(item.id));
    state.items = [...state.items, ...appended];
    state.offset += posts.length;
    state.hasMore = posts.length === POSTS_PAGE_SIZE;
    render();
    calculateMatchScores();
  } catch (error) {
    console.error("[CaptureAgent] Failed to load more posts", error);
    showToast("Couldn't load more captures", true);
  } finally {
    state.loadingMore = false;
    renderLoadMoreButton();
  }
}

/** Live-update path for `REFRESH_POSTS` (fired after every new capture). Re-fetches just
 * the newest page and prepends only the items not already in `state.items`, instead of
 * replacing the list outright -- otherwise this would discard whatever "Load More" depth
 * the user has already fetched, and reset their scroll position back to the top. */
async function refreshTopPosts() {
  try {
    const posts = await fetchPostsPage(0, POSTS_PAGE_SIZE);
    const freshItems = posts.map(mapPostToItem);

    const existingIds = new Set(state.items.map((item) => item.id));
    const newOnes = freshItems.filter((item) => !existingIds.has(item.id));
    if (newOnes.length === 0) return;

    state.items = [...newOnes, ...state.items];
    // The new rows push every later backend offset down by this many places.
    state.offset += newOnes.length;
    render();
    calculateMatchScores();
  } catch (error) {
    console.error("[CaptureAgent] Failed to refresh posts", error);
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

/** Fetches the all-time applied-opportunity count for the conversion-rate stat -- a dedicated
 * backend aggregate rather than something derived from state.items, since that only ever holds
 * one page of GET /posts (see the state.appliedCount comment). */
async function loadAppliedCount() {
  try {
    const response = await fetch(BACKEND_APPLIED_COUNT_URL);
    if (!response.ok) {
      throw new Error(`Failed to load applied count (${response.status})`);
    }
    const { count } = await response.json();
    state.appliedCount = count;
  } catch (error) {
    console.error("[CaptureAgent] Failed to load applied count", error);
  }
  renderStats();
}

/** Fetches the read-only stats aggregation (platform/category/trend) for the
 * Overview tab. This is a separate data source from state.items/categories --
 * it always reflects everything currently in the backend's posts table,
 * independent of the card list's search/tab filters. */
async function loadStats() {
  try {
    const response = await fetch(BACKEND_STATS_OVERVIEW_URL);
    if (!response.ok) {
      throw new Error(`Failed to load stats (${response.status})`);
    }
    state.stats = await response.json();
  } catch (error) {
    console.error("[CaptureAgent] Failed to load stats overview", error);
    state.stats = null;
    showToast("Couldn't load overview", true);
  }
  renderOverview();
}

/** Renders one row per {name, count} entry (skipping the "All" total row,
 * which is surfaced separately in the stat tiles) as a bar scaled relative
 * to the largest count in the list.
 * @param {HTMLElement} container
 * @param {{name: string, count: number}[]} rows
 * @param {(name: string) => string} [labelFn]
 */
function renderBarList(container, rows, labelFn = (name) => name) {
  container.innerHTML = "";
  const entries = rows.filter((row) => row.name !== "All");
  const max = Math.max(1, ...entries.map((row) => row.count));

  for (const { name, count } of entries) {
    const row = document.createElement("div");
    row.className = "bar-row";

    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = labelFn(name);
    label.title = labelFn(name);

    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${(count / max) * 100}%`;
    track.appendChild(fill);

    const countEl = document.createElement("span");
    countEl.className = "bar-count";
    countEl.textContent = String(count);

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(countEl);
    container.appendChild(row);
  }
}

/** Renders the day/week-bucketed trend as a row of height-scaled bars, one
 * per bucket returned by the backend (already zero-filled/gap-free). */
function renderTrendChart(container, trend) {
  container.innerHTML = "";
  const max = Math.max(1, ...trend.map((b) => b.count));

  for (const { bucket, count } of trend) {
    const bar = document.createElement("div");
    bar.className = "trend-bar" + (count > 0 ? " has-captures" : "");
    bar.style.height = `${Math.max(2, (count / max) * 100)}%`;
    bar.title = `${bucket}: ${count} capture${count === 1 ? "" : "s"}`;
    container.appendChild(bar);
  }
}

/** Renders the "by the numbers" stat tiles at the top of Overview -- counts
 * already available from the stats-overview response, just reshaped into
 * tiles instead of the platform/category bar lists below them.
 * @param {HTMLElement} container
 * @param {{label: string, value: number}[]} tiles
 */
function renderStatTiles(container, tiles) {
  container.innerHTML = "";
  for (const { label, value } of tiles) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const valueEl = document.createElement("span");
    valueEl.className = "stat-tile-value";
    valueEl.textContent = String(value);
    const labelEl = document.createElement("span");
    labelEl.className = "stat-tile-label";
    labelEl.textContent = label;
    tile.appendChild(valueEl);
    tile.appendChild(labelEl);
    container.appendChild(tile);
  }
}

function renderOverview() {
  const stats = state.stats;
  const hasStats = !!stats;
  const total = hasStats ? stats.platform_counts.find((p) => p.name === "All")?.count || 0 : 0;

  els.overviewEmpty.hidden = !hasStats || total > 0;
  els.overviewContent.hidden = !hasStats || total === 0;
  if (!hasStats || total === 0) return;

  renderStatTiles(els.overviewStats, [
    { label: "Total Captures", value: total },
    { label: "Applied", value: state.appliedCount },
    { label: "Categories", value: stats.category_counts.filter((c) => c.name !== "All").length },
    { label: "Platforms", value: stats.platform_counts.filter((p) => p.name !== "All").length },
  ]);
  renderBarList(els.overviewPlatformBars, stats.platform_counts, platformLabel);
  renderBarList(els.overviewCategoryBars, stats.category_counts);
  renderTrendChart(els.overviewTrend, stats.trend);

  if (stats.trend.length > 0) {
    els.overviewTrendRange.textContent = `${stats.trend[0].bucket} – ${stats.trend[stats.trend.length - 1].bucket}`;
  }
}

/** Switches between the card-list view and the read-only Overview tab.
 * Overview stats are fetched lazily (on first switch, and on every
 * subsequent switch back) rather than kept live in the background. */
function switchView(view) {
  state.view = view;
  const showList = view === VIEW_LIST;

  els.viewTabList.setAttribute("aria-selected", String(showList));
  els.viewTabOverview.setAttribute("aria-selected", String(!showList));

  els.platformTabs.hidden = !showList;
  els.tabs.hidden = !showList;
  els.list.hidden = !showList;
  els.overviewView.hidden = showList;
  if (showList) {
    els.emptyState.hidden = filteredItems().length > 0;
  } else {
    els.emptyState.hidden = true;
    loadStats();
  }
  renderLoadMoreButton();
}

/** Whether an item's resurface_at is set and due (<= now), per issue #66 --
 * such items sort to the top and get flagged with a "Resurfaced" pill. */
function isResurfaced(item) {
  if (!item.resurfaceAt) return false;
  const at = new Date(item.resurfaceAt);
  return !Number.isNaN(at.getTime()) && at.getTime() <= Date.now();
}

/** Live counts for the dashboard sidebar's badges. Inbox/RSS/GitHub reuse the
 * same per-platform counts the (hidden, in dashboard mode) platform tabs
 * already compute; Jobs has no existing count to reuse, so it's a plain
 * length of state.items filtered by is_opportunity. */
function dashboardSectionCounts() {
  const byPlatform = Object.fromEntries(platformsFromItems(state.items).map((p) => [p.key, p.count]));
  return {
    inbox: byPlatform[ALL_PLATFORM] || 0,
    rss: byPlatform.rss || 0,
    github: byPlatform.github || 0,
    jobs: state.items.filter((item) => item.isOpportunity).length,
  };
}

function renderDashboardSidebar() {
  if (!state.dashboardMode) return;
  const counts = dashboardSectionCounts();

  els.dashboardSidebar.innerHTML = "";
  for (const section of DASHBOARD_SECTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dashboard-nav-item";
    btn.role = "tab";
    btn.dataset.sectionId = section.id;
    btn.setAttribute("aria-selected", String(section.id === state.dashboardSection));
    btn.appendChild(document.createTextNode(section.label));
    if (section.id in counts) {
      btn.appendChild(
        Object.assign(document.createElement("span"), {
          className: "dashboard-nav-count",
          textContent: String(counts[section.id]),
        })
      );
    }
    btn.addEventListener("click", () => switchDashboardSection(section.id));
    els.dashboardSidebar.appendChild(btn);
  }
}

/** Switches the active dashboard sidebar section. Reuses the same filter
 * state docked mode's platform tabs / Overview toggle already drive -- the
 * fetch/filter/render logic underneath is identical, only which section is
 * "active" changes. Resets category filter/search-independent state per
 * section on switch (reasonable since sections are meant to be small, fixed
 * buckets, not scroll positions to preserve). */
function switchDashboardSection(sectionId) {
  state.dashboardSection = sectionId;
  state.activeTab = ALL_CATEGORY;
  state.jobsOnly = sectionId === "jobs";
  state.activePlatform = DASHBOARD_SECTION_PLATFORM[sectionId] || ALL_PLATFORM;

  render();
  switchView(sectionId === "overview" ? VIEW_OVERVIEW : VIEW_LIST);
}

function filteredItems() {
  const q = state.query.trim().toLowerCase();
  const items = state.items.filter((item) => {
    if (state.activeTab !== ALL_CATEGORY && item.category !== state.activeTab) return false;
    if (state.activePlatform !== ALL_PLATFORM && item.platform !== state.activePlatform) return false;
    if (state.jobsOnly && !item.isOpportunity) return false;
    if (item.lifecycleStatus === ItemStatus.ARCHIVED) return false;
    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) || item.detail.toLowerCase().includes(q)
    );
  });

  // Resurfaced items always float to the top, ahead of both the natural
  // (newest-first) order and the optional match-score sort -- both are
  // applied only as a tiebreaker within the resurfaced/not-resurfaced
  // groups. A stable sort (guaranteed since ES2019) preserves each group's
  // existing relative order when neither tiebreaker applies.
  items.sort((a, b) => {
    const resurfacedDiff = Number(isResurfaced(b)) - Number(isResurfaced(a));
    if (resurfacedDiff !== 0) return resurfacedDiff;
    if (state.sortByMatch) {
      // Unscored items (null) sort after every scored item, regardless of tie-breaking order.
      return (b.matchScore ?? -1) - (a.matchScore ?? -1);
    }
    return 0;
  });

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

/** Builds platform filter pills (raw platform key + display label + count) from
 * currently loaded items, "All" first. Derived client-side from state.items --
 * unlike the category pills, this needs no backend round trip, since platform
 * is already present on every loaded item -- so only platforms actually
 * captured from show up as tabs. */
function platformsFromItems(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.platform, (counts.get(item.platform) || 0) + 1);
  }
  const entries = [...counts.entries()]
    .map(([key, count]) => ({ key, label: platformLabel(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return [{ key: ALL_PLATFORM, label: ALL_PLATFORM, count: items.length }, ...entries];
}

/** Independent from the category tabs -- platform and category are separate,
 * simultaneously-active filters (see filteredItems()), not mutually exclusive. */
function renderPlatformTabs() {
  const platforms = platformsFromItems(state.items);
  // In dashboard mode a section (e.g. RSS) should stay selected even when it
  // currently has zero matching items, rather than silently falling back to
  // "All" the way a stale docked-mode platform tab would.
  if (!state.dashboardMode && !platforms.some((p) => p.key === state.activePlatform)) {
    state.activePlatform = ALL_PLATFORM;
  }

  els.platformTabs.innerHTML = "";
  for (const platform of platforms) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab";
    btn.role = "tab";
    btn.dataset.platformKey = platform.key;
    btn.setAttribute("aria-selected", String(platform.key === state.activePlatform));
    btn.append(
      document.createTextNode(platform.label),
      Object.assign(document.createElement("span"), { className: "tab-count", textContent: platform.count })
    );
    btn.addEventListener("click", () => {
      state.activePlatform = platform.key;
      render();
    });
    els.platformTabs.appendChild(btn);
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
 * Open Form" (or, for non-opportunity posts, plain "Open Link") action when
 * an external link was extracted, plus a "Draft Email" action whenever a
 * contact email was detected on the post and the type-based list doesn't
 * already include one.
 * @param {ReturnType<typeof mapPostToItem>} item
 */
function actionsForItem(item) {
  const actions = [...(ACTIONS_BY_TYPE[item.type] || [])];

  if (item.applyUrl) {
    const openIdx = actions.findIndex((a) => a.action === ActionType.OPEN_SOURCE);
    const insertAt = openIdx === -1 ? actions.length : openIdx;
    // Only opportunity posts (job/hackathon/scholarship/freelance) have their
    // link framed as an application form -- for everything else the
    // extracted link could be anything (a product page, an article, ...),
    // so labeling it "Apply / Open Form" would be misleading.
    const label = item.isOpportunity ? "Apply / Open Form" : "Open Link";
    actions.splice(insertAt, 0, { action: ActionType.APPLY_FORM, label });
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

// A listing this recently posted is worth flagging as newly available.
const FRESH_MAX_HOURS = 48;
// A listing this old has likely had time to fill/close, worth a nudge to apply soon.
const STALE_MIN_HOURS = 14 * 24;

/**
 * Freshness read on a job/opportunity post's postedAt -- either an exact
 * platform timestamp (X's own tweet time) or an approximation resolved
 * client-side from a relative-age string (LinkedIn's "2d"/"1 hour ago").
 * There's no way to know when a listing actually closes unless the post
 * says so explicitly, so this is a proxy signal only: how long it's been up,
 * not whether it's still open. Returns null for both unknown postedAt and
 * the broad middle ground where neither read is confident enough to flag.
 * @param {string|null} postedAt ISO 8601
 * @returns {{label: string, className: string}|null}
 */
function freshnessInfo(postedAt) {
  if (!postedAt) return null;
  const posted = new Date(postedAt);
  if (Number.isNaN(posted.getTime())) return null;

  const ageHours = (Date.now() - posted.getTime()) / (60 * 60 * 1000);
  if (ageHours <= FRESH_MAX_HOURS) return { label: "🌱 Freshly listed", className: "fresh" };
  if (ageHours >= STALE_MIN_HOURS) return { label: "⏳ May close anytime -- apply soon", className: "stale" };
  return null;
}

function buildFreshnessPill(item) {
  const info = freshnessInfo(item.postedAt);
  if (!info) return null;
  const pill = document.createElement("span");
  pill.className = `freshness-pill ${info.className}`;
  pill.textContent = info.label;
  return pill;
}

/** Flags an item whose resurface_at snooze has come due (see isResurfaced()). Applies to any
 * item type, unlike the freshness/match pills which are opportunity-only. */
function buildResurfacedPill(item) {
  if (!isResurfaced(item)) return null;
  const pill = document.createElement("span");
  pill.className = "resurfaced-pill";
  pill.textContent = "🔔 Resurfaced";
  return pill;
}

/** Color variant for a card's category badge (issue #76): amber for anything
 * deadline-flagged takes priority over the indigo "Jobs" treatment, since a
 * looming deadline is the more urgent signal regardless of opportunity type. */
function badgeVariant(item) {
  if (item.type === ItemType.DEADLINE || item.dueDate) return "deadline";
  if (item.isOpportunity) return "jobs";
  return "neutral";
}

function buildCategoryBadge(item) {
  const badge = document.createElement("span");
  badge.className = `category-badge ${badgeVariant(item)}`;
  badge.textContent = item.category;
  badge.title = item.category;
  return badge;
}

const STATUS_CHECK_SVG =
  '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm4.3 6.3-5 5a1 1 0 0 1-1.4 0l-2.2-2.2a1 1 0 1 1 1.4-1.4l1.5 1.5 4.3-4.3a1 1 0 0 1 1.4 1.4Z" fill="currentColor"/></svg>';

/** Row-level status-check icon (issue #76): reuses the same "applied"/free-text
 * `status` field the checkbox/status-field below the card already edit, just
 * surfaced as a glance-able indicator up in the card head. */
function buildStatusCheck(item) {
  const done = item.isOpportunity ? item.status === "applied" : !!(item.status && item.status.trim());
  const check = document.createElement("span");
  check.className = "status-check" + (done ? " done" : "");
  check.title = done ? "Marked" : "Not marked";
  check.innerHTML = STATUS_CHECK_SVG;
  return check;
}

/** Shows/hides and labels the "Load More" control. Visible whenever the list view is
 * active and the backend has more pages, independent of the current filtered item
 * count -- appending more posts can surface matches even when the current filter
 * shows nothing. */
function renderLoadMoreButton() {
  els.loadMoreBtn.hidden = state.view !== VIEW_LIST || !state.hasMore;
  els.loadMoreBtn.disabled = state.loadingMore;
  els.loadMoreBtn.textContent = state.loadingMore ? "Loading…" : "Load More";
}

function renderList() {
  const items = filteredItems();
  els.list.innerHTML = "";
  // Guarded by state.view so a background refresh while the Overview tab is
  // active can't pop the list's empty-state back up alongside it.
  els.emptyState.hidden = state.view !== VIEW_LIST || items.length > 0;

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "item-card";

    const head = document.createElement("div");
    head.className = "item-head";

    head.appendChild(buildCategoryBadge(item));

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

    head.appendChild(buildStatusCheck(item));

    const resurfacedPill = buildResurfacedPill(item);
    if (resurfacedPill) head.appendChild(resurfacedPill);

    if (item.isOpportunity) {
      const freshnessPill = buildFreshnessPill(item);
      if (freshnessPill) head.appendChild(freshnessPill);
    }

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
    const notesBtn = document.createElement("button");
    notesBtn.type = "button";
    notesBtn.className = "action-btn";
    notesBtn.textContent = item.notes ? "Edit Note" : "Add Note";
    notesBtn.addEventListener("click", () => {
      toggleExpandedSet(state.expandedNotes, item.id);
      renderList();
    });
    actionGroup.appendChild(notesBtn);

    const snoozeBtn = document.createElement("button");
    snoozeBtn.type = "button";
    snoozeBtn.className = "action-btn";
    snoozeBtn.textContent = item.resurfaceAt ? "Snoozed" : "Snooze";
    snoozeBtn.addEventListener("click", () => {
      toggleExpandedSet(state.expandedSnooze, item.id);
      renderList();
    });
    actionGroup.appendChild(snoozeBtn);

    actions.appendChild(actionGroup);

    if (item.isOpportunity) {
      const applyToggle = document.createElement("label");
      applyToggle.className = "apply-toggle";
      const applyCheckbox = document.createElement("input");
      applyCheckbox.type = "checkbox";
      applyCheckbox.checked = item.status === "applied";
      applyCheckbox.addEventListener("change", () => toggleApplied(item, applyCheckbox));
      const applyText = document.createElement("span");
      applyText.textContent = "Mark as Applied";
      applyToggle.appendChild(applyCheckbox);
      applyToggle.appendChild(applyText);
      actions.appendChild(applyToggle);
    }

    card.appendChild(actions);

    // Non-opportunity items don't have the binary applied/not-applied
    // semantics the checkbox above assumes, so they get a plain editable
    // status field instead -- open-ended like the backend `status` column
    // itself (not an enum), matching how `category` already works.
    if (!item.isOpportunity) {
      const statusField = document.createElement("label");
      statusField.className = "status-field";
      const statusLabel = document.createElement("span");
      statusLabel.className = "status-field-label";
      statusLabel.textContent = "Status";
      const statusInput = document.createElement("input");
      statusInput.type = "text";
      statusInput.className = "status-input";
      statusInput.placeholder = "e.g. read, registered";
      statusInput.value = item.status || "";
      statusInput.addEventListener("change", () => {
        updatePost(item, { status: statusInput.value.trim() || null });
      });
      statusField.appendChild(statusLabel);
      statusField.appendChild(statusInput);
      card.appendChild(statusField);
    }

    if (state.expandedNotes.has(item.id)) {
      const notesField = document.createElement("div");
      notesField.className = "notes-field";
      const textarea = document.createElement("textarea");
      textarea.className = "notes-textarea";
      textarea.placeholder = "Add a note…";
      textarea.value = item.notes || "";
      textarea.addEventListener("blur", () => {
        const value = textarea.value.trim() || null;
        if (value === item.notes) return;
        updatePost(item, { notes: value }, "Note saved");
      });
      notesField.appendChild(textarea);
      card.appendChild(notesField);
    }

    if (state.expandedSnooze.has(item.id)) {
      const snoozeField = document.createElement("div");
      snoozeField.className = "snooze-field";
      const dateInput = document.createElement("input");
      dateInput.type = "date";
      dateInput.className = "snooze-input";
      if (item.resurfaceAt) {
        const resurfaceDate = new Date(item.resurfaceAt);
        if (!Number.isNaN(resurfaceDate.getTime())) {
          dateInput.value = resurfaceDate.toISOString().slice(0, 10);
        }
      }
      dateInput.addEventListener("change", () => {
        if (!dateInput.value) return;
        // Parsed/formatted as UTC midnight on both the save side here and the
        // display side above (toISOString() is always UTC) so the round trip
        // is timezone-independent -- anchoring to local midnight instead
        // would shift the displayed date by a day when re-opened in a
        // timezone east of UTC.
        updatePost(
          item,
          { resurface_at: new Date(`${dateInput.value}T00:00:00Z`).toISOString() },
          "Snoozed"
        );
      });
      snoozeField.appendChild(dateInput);

      if (item.resurfaceAt) {
        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "action-btn";
        clearBtn.textContent = "Clear";
        clearBtn.addEventListener("click", () => updatePost(item, { resurface_at: null }, "Snooze cleared"));
        snoozeField.appendChild(clearBtn);
      }

      card.appendChild(snoozeField);
    }

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

function toggleExpandedSet(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
}

/** PATCH /posts/{id} with any subset of status/notes/resurface_at.
 * @param {number} postId
 * @param {{status?: string|null, notes?: string|null, resurface_at?: string|null}} fields
 */
async function patchPost(postId, fields) {
  const response = await fetch(`${BACKEND_POSTS_URL}/${postId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!response.ok) {
    throw new Error(`Failed to update post (${response.status})`);
  }
  return response.json();
}

/** Persists a status/notes/resurface_at change for an item and syncs the returned record back
 * onto it, then re-renders the list (sort order and pills depend on all three fields). */
async function updatePost(item, fields, successMessage) {
  try {
    const updated = await patchPost(item.postId, fields);
    item.status = updated.status;
    item.notes = updated.notes;
    item.resurfaceAt = updated.resurface_at;
    renderList();
    if (successMessage) showToast(successMessage);
  } catch (error) {
    console.error("[CaptureAgent] Failed to update post", error);
    showToast("Couldn't save changes", true);
  }
}

/** Toggles an opportunity item's "applied" status, now backend-persisted via PATCH
 * /posts/{id} (see issue #66) rather than client-side-only chrome.storage.local tracking. */
async function toggleApplied(item, checkboxEl) {
  checkboxEl.disabled = true;
  const wasApplied = item.status === "applied";
  try {
    const updated = await patchPost(item.postId, { status: checkboxEl.checked ? "applied" : null });
    item.status = updated.status;
    const isApplied = item.status === "applied";
    // A no-op toggle (e.g. re-rendering the same checked checkbox) must not
    // move the count -- mirrors the old setItemApplied()'s no-op guard.
    if (isApplied !== wasApplied) {
      state.appliedCount += isApplied ? 1 : -1;
    }
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
      const applyMissingMsg = item.isOpportunity ? "No application link available" : "No link available";
      showToast(action === ActionType.APPLY_FORM ? applyMissingMsg : "No source link available", true);
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
    loadAppliedCount();
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
  const metrics = { ...state.metrics, [MetricName.APPLICATIONS_SUBMITTED]: state.appliedCount };
  els.statCaptures.textContent = String(metrics[MetricName.CAPTURES_TOTAL] || 0);
  els.statRate.textContent = `${Math.round(conversionRate(metrics))}%`;
}

function render() {
  renderStats();
  renderPlatformTabs();
  renderTabs();
  renderList();
  renderLoadMoreButton();
  renderDashboardSidebar();
}

els.viewTabList.addEventListener("click", () => switchView(VIEW_LIST));
els.viewTabOverview.addEventListener("click", () => switchView(VIEW_OVERVIEW));

/** Docked-panel-only entry point (hidden in dashboard mode via CSS) into the
 * full-tab dashboard (?mode=dashboard) -- the sidebar-rendering logic already
 * existed (issue #68) but had no trigger to open it (issue #76). */
els.openDashboardBtn.addEventListener("click", () => {
  const url = hasExtensionRuntime
    ? chrome.runtime.getURL("extension/sidepanel/sidepanel.html") + `?${DASHBOARD_MODE_PARAM}=${DASHBOARD_MODE_VALUE}`
    : `${location.pathname}?${DASHBOARD_MODE_PARAM}=${DASHBOARD_MODE_VALUE}`;
  if (hasExtensionRuntime && chrome.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank", "noopener");
  }
});

els.loadMoreBtn.addEventListener("click", loadMorePosts);

els.sortMatchBtn.addEventListener("click", () => {
  state.sortByMatch = !state.sortByMatch;
  els.sortMatchBtn.setAttribute("aria-pressed", String(state.sortByMatch));
  renderList();
});

/** Opens the ranked HTML digest (backend/digest.py) in a new tab -- the extension
 * itself does no rendering, it's just the trigger per issue #73's v1 scope
 * (manual generation only, no schedule). */
els.digestBtn.addEventListener("click", () => {
  if (hasExtensionRuntime && chrome.tabs?.create) {
    chrome.tabs.create({ url: BACKEND_DIGEST_URL });
  } else {
    window.open(BACKEND_DIGEST_URL, "_blank", "noopener");
  }
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
      refreshMetrics().then(refreshTopPosts);
      loadCategories();
      loadAppliedCount();
      if (state.view === VIEW_OVERVIEW) loadStats();
    }
    // Sent by context_menu.js's three "Capture this page" triggers (right-click
    // page/icon, keyboard shortcut) -- shows the same message here as a toast
    // when the panel happens to be open, on top of the toolbar badge/tooltip
    // those triggers always show regardless.
    if (message?.type === "CAPTURE_FEEDBACK") {
      showToast(message.message, !message.ok);
    }
    if (message?.type === MessageType.ITEMS_UPDATED && Array.isArray(message.items)) {
      state.items = message.items;
      // This is a full replace of unknown backend depth, so pagination state can't be
      // trusted -- fall back to "no more pages known" rather than risk a stale offset
      // skipping or duplicating rows on the next "Load More".
      state.offset = message.items.length;
      state.hasMore = false;
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
    state.items = SAMPLE_ITEMS;
    state.categories = categoriesFromItems(SAMPLE_ITEMS);
    state.offset = SAMPLE_ITEMS.length;
    state.hasMore = false;
    render();
    if (state.dashboardMode) switchDashboardSection(state.dashboardSection);
    return;
  }
  await loadPosts();
  loadCategories();
  loadAppliedCount();
  if (state.dashboardMode) switchDashboardSection(state.dashboardSection);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
