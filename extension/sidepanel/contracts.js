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

/** Tabs shown in the sidepanel UI, in display order. */
export const TABS = Object.freeze([
  { id: "all", label: "All" },
  { id: ItemType.DEADLINE, label: "Deadlines" },
  { id: ItemType.BOOK, label: "Books" },
  { id: ItemType.STUDY_PLAN, label: "Study Plans" },
]);

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
