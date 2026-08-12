import { TABS, ACTIONS_BY_TYPE, MessageType, ItemType, ItemStatus } from "./contracts.js";

const BACKEND_POSTS_URL = "http://localhost:8000/posts";

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
  },
];

const hasExtensionRuntime =
  typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;

const state = {
  activeTab: "all",
  query: "",
  items: [],
};

const els = {
  tabs: document.getElementById("tabs"),
  list: document.getElementById("list"),
  emptyState: document.getElementById("empty-state"),
  search: document.getElementById("search-input"),
  toast: document.getElementById("toast"),
};

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

/**
 * Maps a backend PostRecord (see backend/models.py) to the CapturedItem shape
 * this UI renders. The backend doesn't classify posts as book/study_plan, so
 * anything without a resolved deadline falls back to the generic "post" type
 * and only shows under the "All" tab.
 * @param {Record<string, unknown>} post
 */
function mapPostToItem(post) {
  const deadline = Array.isArray(post.deadlines) && post.deadlines.length > 0 ? post.deadlines[0] : null;
  return {
    id: `post-${post.id}`,
    type: deadline ? ItemType.DEADLINE : ItemType.POST,
    title: post.summary || post.content,
    detail: deadline
      ? deadline.text
      : [post.author, post.platform].filter(Boolean).join(" · "),
    sourceUrl: post.url || "",
    createdAt: post.created_at,
    dueDate: deadline ? deadline.iso_date : null,
    status: ItemStatus.NEW,
  };
}

async function loadPosts() {
  try {
    const response = await fetch(BACKEND_POSTS_URL);
    if (!response.ok) {
      throw new Error(`Failed to load posts (${response.status})`);
    }
    const posts = await response.json();
    state.items = Array.isArray(posts) ? posts.map(mapPostToItem) : [];
    render();
  } catch (error) {
    console.error("[CaptureAgent] Failed to load posts", error);
    showToast("Couldn't load captures", true);
  }
}

function filteredItems() {
  const q = state.query.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.activeTab !== "all" && item.type !== state.activeTab) return false;
    if (item.status === ItemStatus.ARCHIVED) return false;
    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) || item.detail.toLowerCase().includes(q)
    );
  });
}

function countsByTab() {
  const counts = { all: 0 };
  for (const item of state.items) {
    if (item.status === ItemStatus.ARCHIVED) continue;
    counts.all += 1;
    counts[item.type] = (counts[item.type] || 0) + 1;
  }
  return counts;
}

function renderTabs() {
  const counts = countsByTab();
  els.tabs.innerHTML = "";
  for (const tab of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab";
    btn.role = "tab";
    btn.dataset.tabId = tab.id;
    btn.setAttribute("aria-selected", String(tab.id === state.activeTab));
    btn.innerHTML = `${tab.label}<span class="tab-count">${counts[tab.id] || 0}</span>`;
    btn.addEventListener("click", () => {
      state.activeTab = tab.id;
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
    head.appendChild(body);
    card.appendChild(head);

    const actions = document.createElement("div");
    actions.className = "item-actions";
    for (const { action, label } of ACTIONS_BY_TYPE[item.type] || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action-btn" + (action === "dismiss" ? " destructive" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => runAction(item, action, btn));
      actions.appendChild(btn);
    }
    card.appendChild(actions);

    els.list.appendChild(card);
  }
}

async function runAction(item, action, triggerEl) {
  if (action === "open_source") {
    if (!item.sourceUrl) {
      showToast("No source link available", true);
      return;
    }
    if (hasExtensionRuntime && chrome.tabs?.create) {
      chrome.tabs.create({ url: item.sourceUrl });
    } else {
      window.open(item.sourceUrl, "_blank", "noopener");
    }
    return;
  }

  triggerEl.disabled = true;
  const response = await sendMessage({
    type: MessageType.RUN_ACTION,
    action,
    itemId: item.id,
  });
  triggerEl.disabled = false;

  if (!response.ok) {
    showToast(response.error || "Action failed", true);
    return;
  }

  if (action === "dismiss") {
    state.items = state.items.filter((i) => i.id !== item.id);
    render();
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

function render() {
  renderTabs();
  renderList();
}

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
      loadPosts();
    }
    if (message?.type === MessageType.ITEMS_UPDATED && Array.isArray(message.items)) {
      state.items = message.items;
      render();
    }
  });
}

function boot() {
  if (!hasExtensionRuntime) {
    state.items = SAMPLE_ITEMS;
    render();
    return;
  }
  loadPosts();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
