/**
 * Typed JSON contracts for messages exchanged between the sidepanel (this module)
 * and the background service worker / other extension modules (content, actions, backend).
 *
 * These are plain-JS + JSDoc "typed JSON" contracts (no build step / no TypeScript compiler
 * in this extension), so other modules can `import` the string constants below to stay in
 * sync instead of hand-typing message type strings.
 */

/** @enum {string} */
export const ItemType = Object.freeze({
  DEADLINE: "deadline",
  BOOK: "book",
  STUDY_PLAN: "study_plan",
  // Fallback for a captured post that doesn't have a resolved deadline and
  // isn't otherwise classified. Only shows under the "All" tab.
  POST: "post",
});

/** @enum {string} */
export const ItemStatus = Object.freeze({
  NEW: "new",
  DONE: "done",
  ARCHIVED: "archived",
});

/** @enum {string} */
export const ActionType = Object.freeze({
  FILL_FORM: "fill_form",
  DRAFT_EMAIL: "draft_email",
  OPEN_SOURCE: "open_source",
  // Opens an external application/form link (e.g. Google Forms) extracted
  // from the post, distinct from OPEN_SOURCE which opens the post itself.
  APPLY_FORM: "apply_form",
  DISMISS: "dismiss",
});

/** @enum {string} */
export const MessageType = Object.freeze({
  GET_ITEMS: "GET_ITEMS",
  RUN_ACTION: "RUN_ACTION",
  ITEMS_UPDATED: "ITEMS_UPDATED",
  // Broadcast by the background service worker after a post is successfully
  // captured, so any open sidepanel can refresh from the backend.
  REFRESH_POSTS: "REFRESH_POSTS",
});

/**
 * @typedef {Object} CapturedItem
 * @property {string} id
 * @property {"deadline"|"book"|"study_plan"} type
 * @property {string} title
 * @property {string} detail          Short secondary line (due date text, author, plan summary).
 * @property {string} sourceUrl       Origin URL the item was captured from.
 * @property {string} createdAt       ISO 8601 timestamp.
 * @property {string|null} dueDate    ISO 8601 timestamp, deadlines only.
 * @property {"new"|"done"|"archived"} status
 * @property {number} [postId]        Backend post id, present for backend-sourced items.
 * @property {string|null} [contactEmail]  Contact email detected in the post, if any. When
 *   present, the sidepanel renders a "Draft Email" action regardless of item type.
 * @property {string|null} [applyUrl] External application/form URL extracted from the post, if any.
 * @property {{url: string, label: string}[]} [links] External links extracted from the post, for display as pills.
 * @property {number|null} [matchScore] Resume-to-post match score (0-100) from POST /calculate-match, if computed.
 * @property {string[]} [matchingSkills] Skills from the post the resume already covers, from the last match calculation.
 * @property {string[]} [missingSkills] Skills from the post the resume doesn't show, from the last match calculation.
 * @property {string} category         Open-ended category assigned by the backend (e.g. "AI Tools"), or "General".
 * @property {boolean} [applied] Self-reported "Mark as Applied" state, persisted in `chrome.storage.local`
 *   via `metrics.js` and merged onto the item client-side (not part of the backend PostRecord).
 */

/**
 * @typedef {Object} CalculateMatchRequest
 * @property {number} postId
 * @property {string} resumeText
 */

/**
 * @typedef {Object} MatchResult
 * @property {number} matchScore
 * @property {string[]} matchingSkills
 * @property {string[]} missingSkills
 */

/**
 * @typedef {Object} CategoryCount
 * @property {string} name   Category name, or "All" for the total across every post.
 * @property {number} count  Number of stored posts in this category.
 */

/**
 * @typedef {Object} GenerateEmailRequest
 * @property {number} [postId]
 * @property {string} [content]
 * @property {string} recipientEmail
 */

/**
 * @typedef {Object} GeneratedEmail
 * @property {string} subject
 * @property {string} body
 */

/**
 * @typedef {Object} GetItemsRequest
 * @property {"GET_ITEMS"} type
 */

/**
 * @typedef {Object} GetItemsResponse
 * @property {boolean} ok
 * @property {CapturedItem[]} [items]
 * @property {string} [error]
 */

/**
 * @typedef {Object} RunActionRequest
 * @property {"RUN_ACTION"} type
 * @property {"fill_form"|"draft_email"|"open_source"|"dismiss"} action
 * @property {string} itemId
 * @property {number} [postId]  Backend post id, present for backend-sourced items (e.g. dismiss).
 */

/**
 * @typedef {Object} RunActionResponse
 * @property {boolean} ok
 * @property {string} [error]
 */

/**
 * @typedef {Object} ItemsUpdatedMessage
 * @property {"ITEMS_UPDATED"} type
 * @property {CapturedItem[]} items
 */

/** Action buttons available per item type, in display order. */
export const ACTIONS_BY_TYPE = Object.freeze({
  [ItemType.DEADLINE]: [
    { action: ActionType.FILL_FORM, label: "Fill Form" },
    { action: ActionType.OPEN_SOURCE, label: "Open" },
    { action: ActionType.DISMISS, label: "Dismiss" },
  ],
  [ItemType.BOOK]: [
    { action: ActionType.OPEN_SOURCE, label: "Open" },
    { action: ActionType.DISMISS, label: "Dismiss" },
  ],
  [ItemType.STUDY_PLAN]: [
    { action: ActionType.DRAFT_EMAIL, label: "Draft Email" },
    { action: ActionType.OPEN_SOURCE, label: "Open" },
    { action: ActionType.DISMISS, label: "Dismiss" },
  ],
  [ItemType.POST]: [
    { action: ActionType.OPEN_SOURCE, label: "Open" },
    { action: ActionType.DISMISS, label: "Dismiss" },
  ],
});
