"use strict";

const allowMultipleGroupsInput = document.querySelector("#allowMultipleGroups");
const hideWarmTabsInput = document.querySelector("#hideWarmTabs");
const muteWarmTabsInput = document.querySelector("#muteWarmTabs");
const shortcutSettingsButton = document.querySelector("#shortcutSettings");
const errorBanner = document.querySelector("#errorBanner");
const groupListElement = document.querySelector("#groupList");
const groupsEmpty = document.querySelector("#groupsEmpty");
const createGroupButton = document.querySelector("#createGroup");
const groupGraphElement = document.querySelector("#groupGraph");
const groupGraphEmpty = document.querySelector("#groupGraphEmpty");
const resetGroupGraphButton = document.querySelector("#resetGroupGraph");
const importConfigButton = document.querySelector("#importConfig");
const exportConfigButton = document.querySelector("#exportConfig");
const importFileInput = document.querySelector("#importFile");
const appDialog = document.querySelector("#appDialog");
const appDialogForm = document.querySelector("#appDialogForm");
const appDialogTitle = document.querySelector("#appDialogTitle");
const appDialogMessage = document.querySelector("#appDialogMessage");
const appDialogInputWrap = document.querySelector("#appDialogInputWrap");
const appDialogInputLabel = document.querySelector("#appDialogInputLabel");
const appDialogInput = document.querySelector("#appDialogInput");
const appDialogCheckboxWrap = document.querySelector("#appDialogCheckboxWrap");
const appDialogCheckbox = document.querySelector("#appDialogCheckbox");
const appDialogCheckboxLabel = document.querySelector("#appDialogCheckboxLabel");
const appDialogInfo = document.querySelector("#appDialogInfo");
const appDialogCancel = document.querySelector("#appDialogCancel");
const appDialogConfirm = document.querySelector("#appDialogConfirm");

let currentConfig = null;
const editingGroupIds = new Set();
const expandedGroupIds = new Set();
let rowsByGroupId = new Map();
let dirty = false;
let dirtyRevision = 0;
let autosaveQueue = Promise.resolve();
let reloadShortcutsOnFocus = false;
let shortcutAssignmentTargets = [];
let draggedPool = null;
let draggedGroupRow = null;
let draggedGroupOrder = "";
let draftCompatibilityIssue = null;
let compatibilityErrorText = "";

const GRAPH_LAYOUT_KEY = "warm-tab-pool:group-graph-layout:v1";
const GRAPH_WIDTH = 960;
const GRAPH_HEIGHT = 420;
const GRAPH_PADDING = 46;
const SVG_NS = "http://www.w3.org/2000/svg";
let graphDefaultOrderSignature = "";
let graphDefaultOrder = [];

function showAppDialog({
  title,
  message = "",
  inputLabel = "",
  inputValue = null,
  checkboxLabel = "",
  checkboxValue = null,
  info = "",
  infoError = false,
  confirmLabel = "OK",
  confirmDisabled = false,
  onCheckboxChange = null,
}) {
  if (appDialog.open) {
    appDialog.close("cancel");
  }

  appDialogTitle.textContent = title;
  appDialogMessage.textContent = message;
  appDialogMessage.hidden = !message;
  appDialogInputWrap.hidden = inputValue === null;
  appDialogInputLabel.textContent = inputLabel;
  appDialogInput.value = inputValue ?? "";
  appDialogCheckboxWrap.hidden = checkboxValue === null;
  appDialogCheckboxLabel.textContent = checkboxLabel;
  appDialogCheckbox.checked = checkboxValue ?? false;
  appDialogInfo.textContent = info;
  appDialogInfo.hidden = !info;
  appDialogInfo.classList.toggle("error", infoError);
  appDialogConfirm.textContent = confirmLabel;
  appDialogConfirm.disabled = confirmDisabled;
  appDialog.returnValue = "cancel";

  let removeCheckboxListener = null;
  if (checkboxValue !== null && onCheckboxChange) {
    const listener = () => onCheckboxChange(appDialogCheckbox.checked);
    appDialogCheckbox.addEventListener("change", listener);
    removeCheckboxListener = () => appDialogCheckbox.removeEventListener("change", listener);
  }

  return new Promise((resolve) => {
    const onClose = () => {
      removeCheckboxListener?.();
      const accepted = appDialog.returnValue === "confirm";
      resolve({
        accepted,
        value: accepted && inputValue !== null ? appDialogInput.value : null,
        checked: checkboxValue !== null ? appDialogCheckbox.checked : null,
      });
    };
    appDialog.addEventListener("close", onClose, { once: true });
    appDialog.showModal();
    queueMicrotask(() => {
      if (inputValue !== null) {
        appDialogInput.focus();
        appDialogInput.select();
      } else {
        appDialogConfirm.focus();
      }
    });
  });
}

async function requestText({ title, label, value, confirmLabel = "OK" }) {
  const result = await showAppDialog({
    title,
    inputLabel: label,
    inputValue: value,
    confirmLabel,
  });
  return result.accepted ? result.value : null;
}

async function requestConfirmation({ title, message, confirmLabel }) {
  const result = await showAppDialog({ title, message, confirmLabel });
  return result.accepted;
}

appDialogCancel.addEventListener("click", () => appDialog.close("cancel"));
appDialogForm.addEventListener("submit", () => {
  appDialog.returnValue = "confirm";
});

function showError(text) {
  errorBanner.textContent = String(text ?? "");
  errorBanner.hidden = !errorBanner.textContent;
}

function clearError(expectedText = null) {
  if (expectedText !== null && errorBanner.textContent !== expectedText) {
    return;
  }
  errorBanner.textContent = "";
  errorBanner.hidden = true;
}

function setDirty(value) {
  dirty = value;
}

function markDirty() {
  dirty = true;
  dirtyRevision += 1;
}

function clearInvalid(body) {
  body?.querySelectorAll(".invalid").forEach(
    (element) => element.classList.remove("invalid"),
  );
}

function createInput(type, className, value = "") {
  const input = document.createElement("input");
  input.type = type;
  input.className = className;
  input.value = value;
  return input;
}

function formatShortcutInput(input) {
  const before = input.value;
  try {
    const formatted = WTP.formatShortcut(before);
    input.value = formatted;
    input.classList.remove("invalid");
    return formatted !== before;
  } catch (error) {
    input.classList.add("invalid");
    const row = input.closest("tr");
    const slot = row?.dataset.slot ?? "?";
    throw new Error(`Pool ${slot}: invalid shortcut “${before.trim()}” (${error.message}).`);
  }
}

function formatShortcutInputs(groupId) {
  const body = rowsByGroupId.get(groupId);
  if (!body) {
    return false;
  }
  let changed = false;
  for (const input of body.querySelectorAll(".pool-shortcut")) {
    changed = formatShortcutInput(input) || changed;
  }
  return changed;
}

function formatAllShortcutInputs() {
  let changed = false;
  for (const groupId of rowsByGroupId.keys()) {
    changed = formatShortcutInputs(groupId) || changed;
  }
  return changed;
}

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function makeDragHandle(label, kind) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = `drag-handle ${kind}-drag-handle`;
  handle.textContent = "⋮⋮";
  handle.draggable = true;
  handle.setAttribute("aria-label", label);
  handle.title = label;
  return handle;
}

function isEditing(groupId) {
  return editingGroupIds.has(groupId);
}

function singleEditingGroupId() {
  const ids = [...editingGroupIds].filter(
    (groupId) => Boolean(currentConfig && WTP.groupById(currentConfig, groupId)),
  );
  return ids.length === 1 ? ids[0] : null;
}

function isGroupActive(groupId) {
  return Boolean(currentConfig?.activeGroupIds.includes(groupId));
}

function groupWarmTabCount(group) {
  return group.pools.reduce(
    (total, pool) => total + (pool.enabled ? pool.size : 0),
    0,
  );
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function groupSummary(group) {
  return `${countLabel(group.pools.length, "pool")} · ${countLabel(groupWarmTabCount(group), "warm tab")}`;
}

function activePoolCountExcluding(groupId) {
  if (!currentConfig) {
    return 0;
  }
  return WTP.activeGroups(currentConfig)
    .filter((group) => group.id !== groupId)
    .reduce((total, group) => total + group.pools.length, 0);
}

function uniqueGroupName(preferred, excludeId = null) {
  const base = String(preferred ?? "").trim() || "New group";
  const used = new Set(
    currentConfig.poolGroups
      .filter((group) => group.id !== excludeId)
      .map((group) => group.name.toLocaleLowerCase("en-US")),
  );
  if (!used.has(base.toLocaleLowerCase("en-US"))) {
    return base;
  }
  let suffix = 2;
  while (used.has(`${base} ${suffix}`.toLocaleLowerCase("en-US"))) {
    suffix += 1;
  }
  return `${base} ${suffix}`;
}

function uniqueGroupId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "group";
  let id = `group-${base}`;
  let suffix = 2;
  const used = new Set(currentConfig.poolGroups.map((group) => group.id));
  while (used.has(id)) {
    id = `group-${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function uniquePoolId(group) {
  const used = new Set(group.pools.map((pool) => pool.id));
  let id;
  do {
    id = `pool-${crypto.randomUUID()}`;
  } while (used.has(id));
  return id;
}

function makeBadge(text) {
  const badge = document.createElement("span");
  badge.className = "group-badge";
  badge.textContent = text;
  return badge;
}

function createPoolTable({ editable = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  if (!editable) {
    table.className = "readonly-table";
    const colgroup = document.createElement("colgroup");
    for (const className of [
      "readonly-slot-col",
      "readonly-on-col",
      "readonly-name-col",
      "readonly-url-col",
      "readonly-size-col",
      "readonly-shortcut-col",
    ]) {
      const col = document.createElement("col");
      col.className = className;
      colgroup.append(col);
    }
    table.append(colgroup);
  }
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const headers = editable
    ? ["", "On", "Slot", "Name", "URL", "Size", "Shortcut", "Actions"]
    : ["Slot", "On", "Name", "URL", "Size", "Shortcut"];
  for (const [index, text] of headers.entries()) {
    const th = document.createElement("th");
    th.textContent = text;
    if (editable && index === 0) {
      th.className = "drag-column";
      th.setAttribute("aria-label", "Reorder");
    }
    if (editable && text === "Actions") {
      th.className = "row-actions-column";
    }
    headerRow.append(th);
  }
  head.append(headerRow);
  const body = document.createElement("tbody");
  if (editable) {
    body.className = "editable-pool-body";
  }
  table.append(head, body);
  wrap.append(table);
  return { wrap, body };
}

function reindexPoolRows(body) {
  if (!body) {
    return;
  }
  Array.from(body.querySelectorAll("tr")).forEach((row, index) => {
    const slot = index + 1;
    row.dataset.slot = String(slot);
    row.querySelector(".slot").textContent = String(slot);
  });
}

function collectShortcutArray(body) {
  const result = WTP.defaultShortcuts();
  Array.from(body.querySelectorAll("tr")).forEach((row, index) => {
    result[index] = row.querySelector(".pool-shortcut").value.trim();
  });
  return result;
}

function collectPools(body) {
  clearInvalid(body);
  const pools = [];
  let firstError = null;

  Array.from(body.querySelectorAll("tr")).forEach((row, index) => {
    const slot = index + 1;
    const enabled = row.querySelector(".pool-enabled").checked;
    const nameInput = row.querySelector(".pool-name");
    const urlInput = row.querySelector(".pool-url");
    const sizeInput = row.querySelector(".pool-size");
    const name = nameInput.value.trim() || `Pool ${slot}`;
    let url = urlInput.value.trim();
    const size = Number(sizeInput.value);

    if (!Number.isInteger(size) || size < WTP.MIN_POOL_SIZE || size > WTP.MAX_POOL_SIZE) {
      sizeInput.classList.add("invalid");
      firstError ??= `Pool ${slot}: size must be an integer from ${WTP.MIN_POOL_SIZE} to ${WTP.MAX_POOL_SIZE}.`;
    }

    if (enabled) {
      try {
        url = WTP.normalizeHttpUrl(url);
      } catch (error) {
        urlInput.classList.add("invalid");
        firstError ??= `Pool ${slot}: ${error.message}.`;
      }
    } else if (url) {
      try {
        url = WTP.normalizeHttpUrl(url);
      } catch {
        // Disabled rows may keep incomplete text until enabled.
      }
    }

    pools.push({
      id: row.dataset.poolId,
      slot,
      enabled,
      name,
      url,
      size: Number.isInteger(size) ? size : WTP.DEFAULT_POOL_SIZE,
    });
  });

  if (firstError) {
    throw new Error(firstError);
  }
  return pools;
}

function syncGlobalSettingsIntoDraft() {
  if (!currentConfig) {
    throw new Error("Configuration is still loading.");
  }
  currentConfig.allowMultipleGroups = allowMultipleGroupsInput.checked;
  currentConfig.hideWarmTabs = hideWarmTabsInput.checked;
  currentConfig.muteWarmTabs = muteWarmTabsInput.checked;
  if (!currentConfig.allowMultipleGroups && currentConfig.activeGroupIds.length > 1) {
    currentConfig.activeGroupIds = currentConfig.activeGroupIds.length > 0
      ? [currentConfig.activeGroupIds[0]]
      : [];
  }
}

function syncEditorsIntoDraft() {
  if (!currentConfig) {
    throw new Error("Configuration is still loading.");
  }
  syncGlobalSettingsIntoDraft();
  for (const [groupId, body] of rowsByGroupId.entries()) {
    if (!isEditing(groupId)) {
      continue;
    }
    const group = WTP.groupById(currentConfig, groupId);
    if (!group) {
      continue;
    }
    group.pools = collectPools(body);
    group.shortcuts = WTP.normalizeShortcuts(collectShortcutArray(body));
  }
  currentConfig = WTP.normalizeConfig(currentConfig);
  return currentConfig;
}

function previewConfigWithEditors() {
  if (!currentConfig) {
    return null;
  }
  const draft = structuredClone(currentConfig);
  for (const [groupId, body] of rowsByGroupId.entries()) {
    if (!isEditing(groupId)) {
      continue;
    }
    const group = WTP.groupById(draft, groupId);
    if (!group) {
      continue;
    }
    const previousById = new Map(group.pools.map((pool) => [pool.id, pool]));
    const shortcuts = WTP.defaultShortcuts();
    group.pools = Array.from(body.querySelectorAll("tr")).map((row, index) => {
      const previous = previousById.get(row.dataset.poolId)
        ?? WTP.defaultPool(index + 1, row.dataset.poolId);
      shortcuts[index] = row.querySelector(".pool-shortcut").value.trim();
      return {
        ...previous,
        slot: index + 1,
        enabled: row.querySelector(".pool-enabled").checked,
        name: row.querySelector(".pool-name").value.trim() || `Pool ${index + 1}`,
      };
    });
    group.shortcuts = WTP.normalizeShortcuts(shortcuts);
  }
  return WTP.normalizeConfig(draft);
}

function previewDraftIssue() {
  const draft = previewConfigWithEditors();
  return draft ? WTP.configurationIssue(draft) : null;
}

function updateCompatibilityValidation({ announce = true } = {}) {
  const issue = previewDraftIssue();
  draftCompatibilityIssue = issue;
  if (issue && announce) {
    if (compatibilityErrorText && compatibilityErrorText !== issue.message) {
      clearError(compatibilityErrorText);
    }
    compatibilityErrorText = issue.message;
    showError(issue.message);
  } else if (!issue && compatibilityErrorText) {
    clearError(compatibilityErrorText);
    compatibilityErrorText = "";
  }
  return issue;
}

function assertDraftCompatibility(config = currentConfig) {
  const issue = WTP.configurationIssue(config);
  if (issue) {
    draftCompatibilityIssue = issue;
    compatibilityErrorText = issue.message;
    throw new Error(issue.message);
  }
  draftCompatibilityIssue = null;
  if (compatibilityErrorText) {
    clearError(compatibilityErrorText);
    compatibilityErrorText = "";
  }
}

function syncValidDraft() {
  const draft = syncEditorsIntoDraft();
  assertDraftCompatibility(draft);
  return draft;
}

function editorCanAddPool(group) {
  if (group.pools.length >= WTP.MAX_POOLS) {
    return false;
  }
  if (!isGroupActive(group.id)) {
    return true;
  }
  return activePoolCountExcluding(group.id) + group.pools.length < WTP.MAX_POOLS;
}

function normalizeGroupPoolSlots(group) {
  group.pools.forEach((pool, index) => {
    pool.slot = index + 1;
  });
}

function renderEditableRows(group, body) {
  for (const pool of group.pools) {
    const row = document.createElement("tr");
    row.dataset.slot = String(pool.slot);
    row.dataset.poolId = pool.id;
    row.dataset.groupId = group.id;

    const dragCell = document.createElement("td");
    dragCell.className = "drag-cell";
    dragCell.append(makeDragHandle("Drag to reorder or move this pool", "pool"));

    const enabledCell = document.createElement("td");
    enabledCell.className = "enabled";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "pool-enabled";
    enabled.checked = pool.enabled;
    enabledCell.append(enabled);

    const slotCell = document.createElement("td");
    slotCell.className = "slot";
    slotCell.textContent = String(pool.slot);

    const nameCell = document.createElement("td");
    nameCell.className = "name-cell";
    const name = createInput("text", "pool-name", pool.name);
    nameCell.append(name);

    const urlCell = document.createElement("td");
    urlCell.className = "url-cell";
    const url = document.createElement("textarea");
    url.className = "pool-url";
    url.rows = 1;
    url.value = pool.url;
    url.placeholder = "https://example.com/";
    url.spellcheck = false;
    url.addEventListener("input", () => autoGrow(url));
    urlCell.append(url);

    const sizeCell = document.createElement("td");
    const size = createInput("number", "pool-size", String(pool.size));
    size.min = String(WTP.MIN_POOL_SIZE);
    size.max = String(WTP.MAX_POOL_SIZE);
    size.step = "1";
    sizeCell.append(size);

    const shortcutCell = document.createElement("td");
    shortcutCell.className = "shortcut-cell";
    const shortcut = createInput(
      "text",
      "pool-shortcut",
      group.shortcuts[pool.slot - 1] ?? "",
    );
    shortcut.placeholder = "Ctrl+Shift+1";
    shortcut.spellcheck = false;
    shortcutCell.append(shortcut);

    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const cloneButton = document.createElement("button");
    cloneButton.type = "button";
    cloneButton.className = "pool-clone-button";
    cloneButton.textContent = "Clone";
    cloneButton.title = "Clone this pool directly below it";
    cloneButton.addEventListener("click", () => void clonePool(group.id, row.dataset.poolId));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.title = "Remove this pool from the group";
    deleteButton.addEventListener("click", () => void deletePool(group.id, row.dataset.poolId));

    actions.append(cloneButton, deleteButton);
    actionsCell.append(actions);
    row.append(
      dragCell,
      enabledCell,
      slotCell,
      nameCell,
      urlCell,
      sizeCell,
      shortcutCell,
      actionsCell,
    );
    body.append(row);
    queueMicrotask(() => autoGrow(url));
  }
}

function renderReadonlyRows(group, body) {
  for (const pool of group.pools) {
    const row = document.createElement("tr");
    const slotCell = document.createElement("td");
    slotCell.className = "slot";
    slotCell.textContent = String(pool.slot);

    const enabledCell = document.createElement("td");
    enabledCell.className = "enabled";
    enabledCell.textContent = pool.enabled ? "✓" : "—";

    const nameCell = document.createElement("td");
    nameCell.className = "readonly-name";
    nameCell.textContent = pool.name;

    const urlCell = document.createElement("td");
    urlCell.className = "readonly-url";
    urlCell.textContent = pool.url || "—";

    const sizeCell = document.createElement("td");
    sizeCell.textContent = String(pool.size);

    const shortcutCell = document.createElement("td");
    shortcutCell.className = "readonly-shortcut";
    shortcutCell.textContent = group.shortcuts[pool.slot - 1] || "—";

    row.append(slotCell, enabledCell, nameCell, urlCell, sizeCell, shortcutCell);
    body.append(row);
  }
}

function updateEditorFooter(groupId = null) {
  const ids = groupId ? [groupId] : [...editingGroupIds];
  for (const id of ids) {
    const group = currentConfig ? WTP.groupById(currentConfig, id) : null;
    const body = rowsByGroupId.get(id);
    const rowElement = groupListElement.querySelector(`.group-row[data-group-id="${CSS.escape(id)}"]`);
    const addButton = rowElement?.querySelector(".add-pool-button");
    const note = rowElement?.querySelector(".editor-limit-note");
    if (!group || !body || !addButton || !note) {
      continue;
    }
    const currentCount = body.querySelectorAll("tr").length;
    const otherActiveCount = activePoolCountExcluding(group.id);
    const activeCapacityReached = isGroupActive(group.id)
      && otherActiveCount + currentCount >= WTP.MAX_POOLS;
    const capacityReached = currentCount >= WTP.MAX_POOLS || activeCapacityReached;
    addButton.disabled = capacityReached;
    rowElement.querySelectorAll(".pool-clone-button").forEach((button) => {
      button.disabled = capacityReached;
    });
    if (currentCount >= WTP.MAX_POOLS) {
      note.textContent = `This group already contains the maximum ${WTP.MAX_POOLS} pools.`;
    } else if (activeCapacityReached) {
      note.textContent = `The active groups already occupy all ${WTP.MAX_POOLS} shortcut slots.`;
    } else {
      note.textContent = "";
    }
  }
}

function renderExpandedBody(group) {
  const bodyWrap = document.createElement("div");
  bodyWrap.className = "group-expanded-body";
  if (isEditing(group.id)) {
    const toolbar = document.createElement("div");
    toolbar.className = "group-editor-toolbar";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "done-button";
    done.textContent = "Done";
    done.title = "Validate and save this group, then leave edit mode";
    done.addEventListener("click", () => void finishEditingGroup(group.id));
    toolbar.append(done);

    const { wrap, body } = createPoolTable({ editable: true });
    body.dataset.groupId = group.id;
    rowsByGroupId.set(group.id, body);
    renderEditableRows(group, body);

    const footer = document.createElement("div");
    footer.className = "editor-footer";
    const add = document.createElement("button");
    add.className = "plus-button add-pool-button";
    add.type = "button";
    add.textContent = "+";
    add.setAttribute("aria-label", `Add pool to ${group.name}`);
    add.title = "Add pool";
    add.addEventListener("click", () => void addPool(group.id));
    const note = document.createElement("p");
    note.className = "editor-limit-note";
    footer.append(add, note);
    bodyWrap.append(toolbar, wrap, footer);
  } else {
    const { wrap, body } = createPoolTable();
    renderReadonlyRows(group, body);
    bodyWrap.append(wrap);
  }
  return bodyWrap;
}

function updateMergeButtonStates() {
  const targetGroupId = singleEditingGroupId();
  if (!currentConfig || !targetGroupId) {
    return;
  }
  const draft = previewConfigWithEditors();
  const target = draft ? WTP.groupById(draft, targetGroupId) : null;
  if (!draft || !target) {
    return;
  }
  for (const wrap of groupListElement.querySelectorAll(".merge-action-wrap")) {
    const sourceGroupId = wrap.dataset.sourceGroupId;
    const source = WTP.groupById(draft, sourceGroupId);
    const button = wrap.querySelector(".merge-button");
    if (!source || !button) {
      continue;
    }
    const nonDestructiveIssue = WTP.groupMergeIssue(
      draft, source.id, target.id, { destructive: false },
    );
    const destructiveIssue = WTP.groupMergeIssue(
      draft, source.id, target.id, { destructive: true },
    );
    const disabled = Boolean(nonDestructiveIssue && destructiveIssue);
    let title = `Merge “${source.name}” into the edited group “${target.name}”: append its pools and keep “${source.name}” by default.`;
    if (disabled) {
      title = nonDestructiveIssue.message === destructiveIssue.message
        ? nonDestructiveIssue.message
        : `${nonDestructiveIssue.message} Destructive merge is also unavailable: ${destructiveIssue.message}`;
    } else if (nonDestructiveIssue) {
      title = `${nonDestructiveIssue.message} A destructive merge is available by selecting “Remove source group after merging” in the merge dialog.`;
    }
    button.disabled = disabled;
    button.title = title;
    wrap.title = title;
    wrap.setAttribute("aria-label", title);
  }
}

function renderGroups() {
  groupListElement.replaceChildren();
  rowsByGroupId = new Map();
  if (!currentConfig) {
    groupsEmpty.hidden = true;
    return;
  }

  const mergeTargetId = singleEditingGroupId();

  for (const group of currentConfig.poolGroups) {
    const row = document.createElement("section");
    row.className = "group-row";
    row.dataset.groupId = group.id;
    row.classList.toggle("editing", isEditing(group.id));

    const header = document.createElement("div");
    header.className = "group-row-header";
    const dragWrap = document.createElement("div");
    dragWrap.append(makeDragHandle(`Drag to reorder group ${group.name}`, "group"));

    const nameWrap = document.createElement("div");
    nameWrap.className = "group-name";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "group-name-button";
    name.textContent = group.name;
    name.title = expandedGroupIds.has(group.id) ? `Collapse ${group.name}` : `Expand ${group.name}`;
    name.setAttribute("aria-expanded", String(expandedGroupIds.has(group.id)));
    name.addEventListener("click", () => void toggleGroupExpanded(group.id));
    nameWrap.append(name);

    const activeBadge = makeBadge("Active");
    activeBadge.dataset.role = "active-badge";
    activeBadge.hidden = !isGroupActive(group.id);
    nameWrap.append(activeBadge);
    if (isEditing(group.id)) {
      nameWrap.append(makeBadge("Editing"));
    }

    const summary = document.createElement("div");
    summary.className = "group-summary";
    summary.textContent = groupSummary(group);

    const actions = document.createElement("div");
    actions.className = "group-actions";
    const mainActions = document.createElement("div");
    mainActions.className = "group-actions-main";

    if (mergeTargetId) {
      mainActions.classList.add("with-merge");
      if (group.id !== mergeTargetId) {
        const mergeWrap = document.createElement("span");
        mergeWrap.className = "merge-action-wrap";
        mergeWrap.dataset.sourceGroupId = group.id;
        const merge = document.createElement("button");
        merge.type = "button";
        merge.className = "merge-button";
        merge.textContent = "↑";
        merge.setAttribute("aria-label", `Merge ${group.name} into the group being edited`);
        merge.addEventListener("click", () => void mergeGroupIntoEdited(group.id));
        mergeWrap.append(merge);
        mainActions.append(mergeWrap);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "merge-action-placeholder";
        placeholder.setAttribute("aria-hidden", "true");
        mainActions.append(placeholder);
      }
    }

    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "Rename";
    rename.addEventListener("click", () => void renameGroup(group.id));

    const clone = document.createElement("button");
    clone.type = "button";
    clone.textContent = "Clone";
    clone.addEventListener("click", () => void cloneGroup(group.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => void deleteGroup(group.id));

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "group-edit-button";
    edit.textContent = isEditing(group.id) ? "Edited" : "Edit";
    edit.disabled = isEditing(group.id);
    edit.title = isEditing(group.id) ? "This group is being edited" : `Edit ${group.name}`;
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click", () => void enterEditMode(group.id));
    mainActions.append(rename, clone, remove, edit);

    const divider = document.createElement("span");
    divider.className = "group-actions-divider";
    divider.setAttribute("aria-hidden", "true");

    const stateAction = document.createElement("div");
    stateAction.className = "group-state-action";
    const load = document.createElement("button");
    load.type = "button";
    load.dataset.role = "group-state-button";
    load.textContent = isGroupActive(group.id) ? "Unload" : "Load";
    load.addEventListener("click", () => void changeGroupActive(group.id, !isGroupActive(group.id)));
    stateAction.append(load);

    actions.append(mainActions, divider, stateAction);
    header.append(dragWrap, nameWrap, summary, actions);
    row.append(header);
    if (expandedGroupIds.has(group.id)) {
      row.append(renderExpandedBody(group));
    }
    groupListElement.append(row);
  }
  groupsEmpty.hidden = currentConfig.poolGroups.length > 0;
  updateEditorFooter();
  updateMergeButtonStates();
}

async function enterEditMode(groupId) {
  if (!currentConfig || isEditing(groupId)) {
    return;
  }
  try {
    if (rowsByGroupId.size > 0) {
      syncEditorsIntoDraft();
    }
    editingGroupIds.add(groupId);
    expandedGroupIds.add(groupId);
    renderAll();
    if (dirty) {
      void autosaveChanges();
    }
    clearError();
  } catch (error) {
    showError(error.message);
  }
}

async function toggleGroupExpanded(groupId) {
  if (!currentConfig || !WTP.groupById(currentConfig, groupId)) {
    return;
  }
  try {
    if (rowsByGroupId.size > 0) {
      if (isEditing(groupId) && formatShortcutInputs(groupId)) {
        markDirty();
      }
      syncEditorsIntoDraft();
    }
    if (expandedGroupIds.has(groupId)) {
      expandedGroupIds.delete(groupId);
    } else {
      expandedGroupIds.add(groupId);
    }
    renderGroups();
    updateCompatibilityValidation({ announce: false });
    if (dirty) {
      void autosaveChanges();
    }
    clearError();
  } catch (error) {
    showError(error.message);
  }
}

function createSvgElement(name) {
  return document.createElementNS(SVG_NS, name);
}

function graphStoredPositions() {
  try {
    const raw = localStorage.getItem(GRAPH_LAYOUT_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed.positions && typeof parsed.positions === "object"
      ? parsed.positions
      : {};
  } catch {
    return {};
  }
}

function saveGraphPosition(groupId, position) {
  try {
    const positions = graphStoredPositions();
    positions[groupId] = [position.x, position.y];
    localStorage.setItem(GRAPH_LAYOUT_KEY, JSON.stringify({ version: 1, positions }));
  } catch {
    // A custom layout is a convenience only; graph interaction still works.
  }
}

function clearStoredGraphPositions() {
  try {
    localStorage.removeItem(GRAPH_LAYOUT_KEY);
  } catch {
    // Ignore storage failures; the graph can still use its computed layout.
  }
}

function configForGraph() {
  return previewConfigWithEditors() ?? currentConfig;
}

function graphPotentialPairIssue(config, firstGroupId, secondGroupId) {
  const draft = structuredClone(config);
  draft.allowMultipleGroups = true;
  draft.activeGroupIds = [firstGroupId, secondGroupId];
  return WTP.activeConfigurationIssue(WTP.normalizeConfig(draft));
}

function graphCurrentPairIssue(config, firstGroupId, secondGroupId) {
  if (!config.allowMultipleGroups) {
    return {
      code: "multiple-groups-disabled",
      message: "Multiple-group mode is disabled.",
    };
  }
  const draft = structuredClone(config);
  draft.activeGroupIds = [...new Set([
    ...config.activeGroupIds,
    firstGroupId,
    secondGroupId,
  ])];
  return WTP.activeConfigurationIssue(WTP.normalizeConfig(draft));
}

function graphRelations(config) {
  const activeIds = new Set(config.activeGroupIds);
  const edges = [];
  for (let firstIndex = 0; firstIndex < config.poolGroups.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < config.poolGroups.length; secondIndex += 1) {
      const first = config.poolGroups[firstIndex];
      const second = config.poolGroups[secondIndex];
      const active = activeIds.has(first.id) && activeIds.has(second.id);
      const potentialIssue = graphPotentialPairIssue(config, first.id, second.id);
      const potential = !potentialIssue;
      const currentIssue = potential
        ? graphCurrentPairIssue(config, first.id, second.id)
        : potentialIssue;
      const current = potential && !currentIssue;
      if (!potential && !active) {
        continue;
      }
      edges.push({
        firstId: first.id,
        secondId: second.id,
        active,
        current,
        potential,
      });
    }
  }
  return edges;
}

function circularEdgeCrosses(first, second, positionsById) {
  const a = positionsById.get(first.firstId);
  const b = positionsById.get(first.secondId);
  const c = positionsById.get(second.firstId);
  const d = positionsById.get(second.secondId);
  if ([a, b, c, d].some((value) => value === undefined)) {
    return false;
  }
  if (a === c || a === d || b === c || b === d) {
    return false;
  }
  const between = (value, start, end) => {
    if (start < end) {
      return value > start && value < end;
    }
    return value > start || value < end;
  };
  return between(c, a, b) !== between(d, a, b);
}

function circularCrossingCount(order, edges) {
  const positionsById = new Map(order.map((id, index) => [id, index]));
  let crossings = 0;
  for (let firstIndex = 0; firstIndex < edges.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < edges.length; secondIndex += 1) {
      if (circularEdgeCrosses(edges[firstIndex], edges[secondIndex], positionsById)) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

function exactCircularOrder(groupIds, edges) {
  if (groupIds.length <= 3 || edges.length <= 1) {
    return [...groupIds];
  }
  const first = groupIds[0];
  const remaining = groupIds.slice(1);
  let best = [...groupIds];
  let bestCrossings = circularCrossingCount(best, edges);
  const working = [];
  const used = new Array(remaining.length).fill(false);

  const visit = () => {
    if (working.length === remaining.length) {
      const candidate = [first, ...working];
      const crossings = circularCrossingCount(candidate, edges);
      if (crossings < bestCrossings) {
        best = [...candidate];
        bestCrossings = crossings;
      }
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      if (used[index]) {
        continue;
      }
      used[index] = true;
      working.push(remaining[index]);
      visit();
      working.pop();
      used[index] = false;
    }
  };
  visit();
  return best;
}

function heuristicCircularOrder(groupIds, edges) {
  const neighbors = new Map(groupIds.map((id) => [id, new Set()]));
  for (const edge of edges) {
    neighbors.get(edge.firstId)?.add(edge.secondId);
    neighbors.get(edge.secondId)?.add(edge.firstId);
  }
  const unplaced = new Set(groupIds);
  const start = [...groupIds].sort((first, second) => (
    (neighbors.get(second)?.size ?? 0) - (neighbors.get(first)?.size ?? 0)
  ))[0];
  const order = [];
  if (start) {
    order.push(start);
    unplaced.delete(start);
  }
  while (unplaced.size > 0) {
    let bestId = null;
    let bestScore = -1;
    for (const id of unplaced) {
      const score = order.reduce(
        (total, placedId) => total + (neighbors.get(id)?.has(placedId) ? 1 : 0),
        0,
      );
      if (score > bestScore) {
        bestId = id;
        bestScore = score;
      }
    }
    order.push(bestId);
    unplaced.delete(bestId);
  }
  return order;
}

function improveCircularOrder(initialOrder, edges) {
  const order = [...initialOrder];
  if (order.length <= 3 || edges.length <= 1) {
    return order;
  }
  let bestCrossings = circularCrossingCount(order, edges);
  const movable = order.length - 1;
  const attempts = Math.min(96, movable * movable * 2);
  for (let step = 0; step < attempts && bestCrossings > 0; step += 1) {
    let firstIndex = 1 + ((step * 7 + 1) % movable);
    let secondIndex = 1 + ((step * 13 + 3) % movable);
    if (firstIndex === secondIndex) {
      secondIndex = 1 + (secondIndex % movable);
    }
    if (firstIndex === secondIndex) {
      continue;
    }
    [order[firstIndex], order[secondIndex]] = [order[secondIndex], order[firstIndex]];
    const crossings = circularCrossingCount(order, edges);
    if (crossings <= bestCrossings) {
      bestCrossings = crossings;
    } else {
      [order[firstIndex], order[secondIndex]] = [order[secondIndex], order[firstIndex]];
    }
  }
  return order;
}

function defaultGraphOrder(groupIds, edges) {
  const edgeSignature = edges
    .map((edge) => JSON.stringify([edge.firstId, edge.secondId]))
    .sort();
  const signature = JSON.stringify([groupIds, edgeSignature]);
  if (signature === graphDefaultOrderSignature) {
    return [...graphDefaultOrder];
  }
  const order = groupIds.length <= 8
    ? exactCircularOrder(groupIds, edges)
    : improveCircularOrder(heuristicCircularOrder(groupIds, edges), edges);
  graphDefaultOrderSignature = signature;
  graphDefaultOrder = [...order];
  return order;
}

function defaultGraphPositions(groups, edges) {
  const ids = groups.map((group) => group.id);
  if (ids.length === 0) {
    return new Map();
  }
  if (ids.length === 1) {
    return new Map([[ids[0], { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }]]);
  }

  const structuralEdges = edges.filter((edge) => edge.potential);
  const order = defaultGraphOrder(ids, structuralEdges);
  const centerX = GRAPH_WIDTH / 2;
  const centerY = GRAPH_HEIGHT / 2;
  const radiusX = GRAPH_WIDTH / 2 - GRAPH_PADDING;
  const radiusY = GRAPH_HEIGHT / 2 - GRAPH_PADDING;
  const result = new Map();

  if (order.length === 2) {
    result.set(order[0], { x: centerX - radiusX * 0.72, y: centerY });
    result.set(order[1], { x: centerX + radiusX * 0.72, y: centerY });
    return result;
  }

  // Sample the ellipse perimeter and place nodes at equal arc-length intervals.
  // This keeps the graph spread across the available width without clustering
  // nodes near the ends of the ellipse.
  const samples = 720;
  const perimeter = [{ angle: 0, distance: 0 }];
  let totalDistance = 0;
  let previous = { x: centerX + radiusX, y: centerY };
  for (let index = 1; index <= samples; index += 1) {
    const angle = (2 * Math.PI * index) / samples;
    const next = {
      x: centerX + radiusX * Math.cos(angle),
      y: centerY + radiusY * Math.sin(angle),
    };
    totalDistance += Math.hypot(next.x - previous.x, next.y - previous.y);
    perimeter.push({ angle, distance: totalDistance });
    previous = next;
  }

  for (const [index, id] of order.entries()) {
    const targetDistance = totalDistance * index / order.length;
    let upperIndex = 1;
    while (
      upperIndex < perimeter.length
      && perimeter[upperIndex].distance < targetDistance
    ) {
      upperIndex += 1;
    }
    const lower = perimeter[Math.max(0, upperIndex - 1)];
    const upper = perimeter[Math.min(perimeter.length - 1, upperIndex)];
    const span = upper.distance - lower.distance;
    const ratio = span > 0 ? (targetDistance - lower.distance) / span : 0;
    const angle = lower.angle + (upper.angle - lower.angle) * ratio;
    result.set(id, {
      x: centerX + radiusX * Math.cos(angle),
      y: centerY + radiusY * Math.sin(angle),
    });
  }
  return result;
}

function graphNodeRadius(groupCount) {
  if (groupCount <= 8) {
    return 32;
  }
  if (groupCount <= 14) {
    return 24;
  }
  return 17;
}

function graphNodeLabel(name, radius) {
  const maxCharacters = Math.max(2, Math.floor(radius / 3));
  const value = String(name ?? "");
  if (value.length <= maxCharacters) {
    return value;
  }
  return `${value.slice(0, Math.max(1, maxCharacters - 1))}…`;
}

function graphPointerPosition(svg, event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) {
    return { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
  }
  const transformed = point.matrixTransform(matrix.inverse());
  return { x: transformed.x, y: transformed.y };
}

function renderGroupGraph() {
  groupGraphElement.replaceChildren();
  const config = configForGraph();
  if (!config || config.poolGroups.length === 0) {
    groupGraphElement.hidden = true;
    groupGraphEmpty.hidden = false;
    resetGroupGraphButton.disabled = true;
    return;
  }

  groupGraphElement.hidden = false;
  groupGraphEmpty.hidden = true;
  resetGroupGraphButton.disabled = false;

  const edges = graphRelations(config);
  const defaults = defaultGraphPositions(config.poolGroups, edges);
  const stored = graphStoredPositions();
  const radius = graphNodeRadius(config.poolGroups.length);
  const positions = new Map();
  for (const group of config.poolGroups) {
    const candidate = stored[group.id];
    const fallback = defaults.get(group.id);
    const x = Array.isArray(candidate) && Number.isFinite(Number(candidate[0]))
      ? Number(candidate[0])
      : fallback.x;
    const y = Array.isArray(candidate) && Number.isFinite(Number(candidate[1]))
      ? Number(candidate[1])
      : fallback.y;
    positions.set(group.id, {
      x: Math.min(GRAPH_WIDTH - radius - 8, Math.max(radius + 8, x)),
      y: Math.min(GRAPH_HEIGHT - radius - 8, Math.max(radius + 8, y)),
    });
  }

  const svg = createSvgElement("svg");
  svg.setAttribute("viewBox", `0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`);
  svg.setAttribute("aria-label", "Pool group compatibility graph");
  const edgeLayer = createSvgElement("g");
  const nodeLayer = createSvgElement("g");
  const renderedEdges = [];

  for (const edge of edges) {
    const firstPosition = positions.get(edge.firstId);
    const secondPosition = positions.get(edge.secondId);
    if (!firstPosition || !secondPosition) {
      continue;
    }
    const line = createSvgElement("line");
    line.classList.add("graph-edge");
    if (edge.active) {
      line.classList.add("active");
    } else if (edge.current) {
      line.classList.add("current");
    } else {
      line.classList.add("potential");
    }
    line.setAttribute("x1", String(firstPosition.x));
    line.setAttribute("y1", String(firstPosition.y));
    line.setAttribute("x2", String(secondPosition.x));
    line.setAttribute("y2", String(secondPosition.y));
    edgeLayer.append(line);
    renderedEdges.push({ edge, line });
  }

  const activeIds = new Set(config.activeGroupIds);
  for (const group of config.poolGroups) {
    const node = createSvgElement("g");
    node.classList.add("graph-node");
    if (activeIds.has(group.id)) {
      node.classList.add("active");
    }
    node.dataset.groupId = group.id;
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");

    const activationIssue = activeIds.has(group.id)
      ? null
      : WTP.groupActivationIssue(config, group.id);
    const actionText = activeIds.has(group.id)
      ? `Unload “${group.name}”`
      : activationIssue
        ? `Load “${group.name}”. ${activationIssue.message}`
        : `Load “${group.name}”`;
    node.setAttribute("aria-label", actionText);

    const title = createSvgElement("title");
    title.textContent = activeIds.has(group.id)
      ? `${group.name} — loaded. Click to unload; drag to reposition.`
      : activationIssue
        ? `${group.name} — ${activationIssue.message} Click to attempt loading; drag to reposition.`
        : `${group.name} — click to load; drag to reposition.`;

    const circle = createSvgElement("circle");
    circle.setAttribute("r", String(radius));
    const label = createSvgElement("text");
    label.textContent = graphNodeLabel(group.name, radius);
    label.style.fontSize = `${Math.max(9, Math.min(13, radius * 0.42))}px`;
    node.append(title, circle, label);

    const initialPosition = positions.get(group.id);
    node.setAttribute("transform", `translate(${initialPosition.x} ${initialPosition.y})`);

    let pointerId = null;
    let startPointer = null;
    let startPosition = null;
    let moved = false;

    const updatePosition = (position) => {
      const next = {
        x: Math.min(GRAPH_WIDTH - radius - 8, Math.max(radius + 8, position.x)),
        y: Math.min(GRAPH_HEIGHT - radius - 8, Math.max(radius + 8, position.y)),
      };
      positions.set(group.id, next);
      node.setAttribute("transform", `translate(${next.x} ${next.y})`);
      for (const rendered of renderedEdges) {
        if (rendered.edge.firstId === group.id) {
          rendered.line.setAttribute("x1", String(next.x));
          rendered.line.setAttribute("y1", String(next.y));
        }
        if (rendered.edge.secondId === group.id) {
          rendered.line.setAttribute("x2", String(next.x));
          rendered.line.setAttribute("y2", String(next.y));
        }
      }
    };

    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      pointerId = event.pointerId;
      startPointer = graphPointerPosition(svg, event);
      startPosition = { ...positions.get(group.id) };
      moved = false;
      node.classList.add("dragging");
      node.setPointerCapture(pointerId);
      event.preventDefault();
    });

    node.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId || !startPointer || !startPosition) {
        return;
      }
      const pointer = graphPointerPosition(svg, event);
      const dx = pointer.x - startPointer.x;
      const dy = pointer.y - startPointer.y;
      if (Math.hypot(dx, dy) > 4) {
        moved = true;
      }
      if (moved) {
        updatePosition({ x: startPosition.x + dx, y: startPosition.y + dy });
      }
    });

    const finishPointer = (event) => {
      if (pointerId !== event.pointerId) {
        return;
      }
      const wasMoved = moved;
      const finalPosition = positions.get(group.id);
      try {
        node.releasePointerCapture(pointerId);
      } catch {
        // Capture may already have been released by the browser.
      }
      pointerId = null;
      startPointer = null;
      startPosition = null;
      moved = false;
      node.classList.remove("dragging");
      if (wasMoved) {
        saveGraphPosition(group.id, finalPosition);
      } else {
        void changeGroupActive(group.id, !activeIds.has(group.id));
      }
    };
    node.addEventListener("pointerup", finishPointer);
    node.addEventListener("pointercancel", (event) => {
      if (pointerId !== event.pointerId) {
        return;
      }
      if (moved && startPosition) {
        updatePosition(startPosition);
      }
      pointerId = null;
      startPointer = null;
      startPosition = null;
      moved = false;
      node.classList.remove("dragging");
    });
    node.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      void changeGroupActive(group.id, !activeIds.has(group.id));
    });

    nodeLayer.append(node);
  }

  svg.append(edgeLayer, nodeLayer);
  groupGraphElement.append(svg);
}


function renderAll() {
  renderGroups();
  renderGroupGraph();
  updateCompatibilityValidation({ announce: false });
}

async function shortcutMap() {
  const commands = await browser.commands.getAll();
  return new Map(commands.map(
    (command) => [command.name, command.shortcut ?? ""],
  ));
}

function applyShortcutMapToActiveGroups(shortcuts) {
  let changed = false;
  for (const assignment of WTP.activePoolAssignments(currentConfig)) {
    const next = shortcuts.get(WTP.commandName(assignment.commandSlot)) ?? "";
    const index = assignment.pool.slot - 1;
    if ((assignment.group.shortcuts[index] ?? "") !== next) {
      assignment.group.shortcuts[index] = next;
      changed = true;
    }
  }
  return changed;
}

function applyShortcutMapToTargets(shortcuts, targets) {
  let changed = false;
  for (const target of targets) {
    const group = WTP.groupById(currentConfig, target.groupId);
    const pool = group?.pools.find((candidate) => candidate.id === target.poolId);
    if (!group || !pool) {
      continue;
    }
    const next = shortcuts.get(WTP.commandName(target.commandSlot)) ?? "";
    const index = pool.slot - 1;
    if ((group.shortcuts[index] ?? "") !== next) {
      group.shortcuts[index] = next;
      changed = true;
    }
  }
  return changed;
}

function pruneUiState() {
  if (!currentConfig) {
    editingGroupIds.clear();
    expandedGroupIds.clear();
    return;
  }
  const validIds = new Set(currentConfig.poolGroups.map((group) => group.id));
  for (const groupId of [...editingGroupIds]) {
    if (!validIds.has(groupId)) {
      editingGroupIds.delete(groupId);
    }
  }
  for (const groupId of [...expandedGroupIds]) {
    if (!validIds.has(groupId)) {
      expandedGroupIds.delete(groupId);
    }
  }
}

async function commitDraftAndSync({ render = true } = {}) {
  const revision = dirtyRevision;
  const draft = structuredClone(syncValidDraft());
  const result = await browser.runtime.sendMessage({
    type: "saveConfigAndSync",
    config: draft,
  });
  currentConfig = WTP.normalizeConfig(result.config);
  pruneUiState();
  allowMultipleGroupsInput.checked = currentConfig.allowMultipleGroups;
  hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
  muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
  if (dirtyRevision === revision) {
    setDirty(false);
  }
  if (render) {
    renderAll();
  } else {
    renderGroupGraph();
    updateCompatibilityValidation({ announce: false });
  }
  return result;
}

function autosaveChanges({ render = false } = {}) {
  const run = async () => {
    if (!dirty) {
      return;
    }
    try {
      await commitDraftAndSync({ render });
      if (!dirty && !draftCompatibilityIssue) {
        clearError();
      }
    } catch (error) {
      setDirty(true);
      showError(error.message);
    }
  };
  const next = autosaveQueue.then(run, run);
  autosaveQueue = next.catch(() => {});
  return next;
}

async function finishEditingGroup(groupId) {
  if (!currentConfig || !isEditing(groupId)) {
    return;
  }
  try {
    if (formatShortcutInputs(groupId)) {
      markDirty();
    }
    await commitDraftAndSync({ render: false });
    editingGroupIds.delete(groupId);
    expandedGroupIds.add(groupId);
    renderAll();
    clearError();
  } catch (error) {
    setDirty(true);
    showError(error.message);
  }
}

async function addPool(groupId) {
  if (!currentConfig || !isEditing(groupId)) {
    return;
  }
  let before = null;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    const group = WTP.groupById(currentConfig, groupId);
    if (!group || !editorCanAddPool(group)) {
      updateEditorFooter(groupId);
      return;
    }
    const slot = group.pools.length + 1;
    group.pools.push(WTP.defaultPool(slot, uniquePoolId(group)));
    currentConfig = WTP.normalizeConfig(currentConfig);
    assertDraftCompatibility(currentConfig);
    markDirty();
    expandedGroupIds.add(groupId);
    renderAll();
    await autosaveChanges();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

async function clonePool(groupId, poolId) {
  if (!currentConfig || !isEditing(groupId)) {
    return;
  }
  let before = null;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    const group = WTP.groupById(currentConfig, groupId);
    if (!group || !editorCanAddPool(group)) {
      updateEditorFooter(groupId);
      return;
    }
    const sourceIndex = group.pools.findIndex((pool) => pool.id === poolId);
    if (sourceIndex < 0) {
      throw new Error("That pool no longer exists.");
    }
    const source = group.pools[sourceIndex];
    const clone = {
      ...structuredClone(source),
      id: uniquePoolId(group),
    };
    const logicalShortcuts = group.shortcuts.slice(0, group.pools.length);
    const shortcut = logicalShortcuts[sourceIndex] ?? "";
    group.pools.splice(sourceIndex + 1, 0, clone);
    logicalShortcuts.splice(sourceIndex + 1, 0, shortcut);
    normalizeGroupPoolSlots(group);
    group.shortcuts = WTP.normalizeShortcuts(logicalShortcuts);
    currentConfig = WTP.normalizeConfig(currentConfig);
    markDirty();
    expandedGroupIds.add(groupId);
    renderAll();
    updateCompatibilityValidation();
    await autosaveChanges();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

async function deletePool(groupId, poolId) {
  if (!currentConfig || !isEditing(groupId)) {
    return;
  }
  let before = null;
  try {
    syncEditorsIntoDraft();
    before = structuredClone(currentConfig);
    const group = WTP.groupById(currentConfig, groupId);
    if (!group) {
      throw new Error("That pool group no longer exists.");
    }
    const index = group.pools.findIndex((pool) => pool.id === poolId);
    if (index < 0) {
      throw new Error("That pool no longer exists.");
    }
    const logicalShortcuts = group.shortcuts.slice(0, group.pools.length);
    group.pools.splice(index, 1);
    logicalShortcuts.splice(index, 1);
    normalizeGroupPoolSlots(group);
    group.shortcuts = WTP.normalizeShortcuts(logicalShortcuts);
    currentConfig = WTP.normalizeConfig(currentConfig);
    assertDraftCompatibility(currentConfig);
    markDirty();
    renderAll();
    await autosaveChanges();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

async function changeGroupActive(groupId, active) {
  if (!currentConfig) {
    return;
  }
  let before = null;
  try {
    syncEditorsIntoDraft();
    before = structuredClone(currentConfig);
    if (active) {
      if (currentConfig.allowMultipleGroups) {
        const activeIds = new Set([...currentConfig.activeGroupIds, groupId]);
        currentConfig.activeGroupIds = currentConfig.poolGroups
          .filter((group) => activeIds.has(group.id))
          .map((group) => group.id);
      } else {
        currentConfig.activeGroupIds = [groupId];
      }
    } else {
      currentConfig.activeGroupIds = currentConfig.activeGroupIds.filter(
        (id) => id !== groupId,
      );
    }
    currentConfig = WTP.normalizeConfig(currentConfig);
    assertDraftCompatibility(currentConfig);
    markDirty();
    await commitDraftAndSync();
    clearError();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

async function mergeGroupIntoEdited(sourceGroupId) {
  const targetGroupId = singleEditingGroupId();
  if (!currentConfig || !targetGroupId || sourceGroupId === targetGroupId) {
    return;
  }

  let before = null;
  try {
    syncEditorsIntoDraft();
    const source = WTP.groupById(currentConfig, sourceGroupId);
    const target = WTP.groupById(currentConfig, targetGroupId);
    if (!source || !target) {
      throw new Error("One of the pool groups no longer exists.");
    }

    const nonDestructiveIssue = WTP.groupMergeIssue(
      currentConfig, source.id, target.id, { destructive: false },
    );
    const destructiveIssue = WTP.groupMergeIssue(
      currentConfig, source.id, target.id, { destructive: true },
    );
    if (nonDestructiveIssue && destructiveIssue) {
      throw new Error(nonDestructiveIssue.message);
    }

    const poolWord = source.pools.length === 1 ? "pool" : "pools";
    const updateMergeDialogState = (destructive) => {
      const issue = WTP.groupMergeIssue(
        currentConfig, sourceGroupId, targetGroupId, { destructive },
      );
      if (issue) {
        appDialogInfo.textContent = issue.message;
        appDialogInfo.hidden = false;
        appDialogInfo.classList.add("error");
        appDialogConfirm.disabled = true;
        return;
      }
      appDialogInfo.textContent = destructive
        ? `“${source.name}” will be removed after its pools are appended.`
        : `“${source.name}” will remain unchanged after its pools are appended.`;
      appDialogInfo.hidden = false;
      appDialogInfo.classList.remove("error");
      appDialogConfirm.disabled = false;
    };

    const result = await showAppDialog({
      title: `Merge “${source.name}” into “${target.name}”`,
      message: `Append ${source.pools.length} ${poolWord} from “${source.name}” to “${target.name}”.`,
      checkboxLabel: `Remove “${source.name}” after merging (destructive)`,
      checkboxValue: false,
      info: nonDestructiveIssue
        ? nonDestructiveIssue.message
        : `“${source.name}” will remain unchanged after its pools are appended.`,
      infoError: Boolean(nonDestructiveIssue),
      confirmLabel: "Merge",
      confirmDisabled: Boolean(nonDestructiveIssue),
      onCheckboxChange: updateMergeDialogState,
    });
    if (!result.accepted) {
      return;
    }

    syncEditorsIntoDraft();
    const destructive = Boolean(result.checked);
    const latestIssue = WTP.groupMergeIssue(
      currentConfig, sourceGroupId, targetGroupId, { destructive },
    );
    if (latestIssue) {
      throw new Error(latestIssue.message);
    }

    before = structuredClone(currentConfig);
    currentConfig = WTP.mergeGroups(
      currentConfig, sourceGroupId, targetGroupId, { destructive },
    );
    editingGroupIds.add(targetGroupId);
    expandedGroupIds.add(targetGroupId);
    if (destructive) {
      editingGroupIds.delete(sourceGroupId);
      expandedGroupIds.delete(sourceGroupId);
    }
    markDirty();
    await commitDraftAndSync();
    clearError();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

async function deleteGroup(groupId) {
  if (!currentConfig) {
    return;
  }
  const group = WTP.groupById(currentConfig, groupId);
  if (!group) {
    return;
  }
  const confirmed = await requestConfirmation({
    title: `Delete “${group.name}”?`,
    message: isGroupActive(group.id)
      ? "This group is active. Deleting it will unload it and remove its pooled tabs."
      : "This permanently removes the group from the saved configuration.",
    confirmLabel: "Delete",
  });
  if (!confirmed) {
    return;
  }

  let before = null;
  try {
    syncEditorsIntoDraft();
    before = structuredClone(currentConfig);
    currentConfig.poolGroups = currentConfig.poolGroups.filter(
      (candidate) => candidate.id !== groupId,
    );
    currentConfig.activeGroupIds = currentConfig.activeGroupIds.filter(
      (id) => id !== groupId,
    );
    editingGroupIds.delete(groupId);
    expandedGroupIds.delete(groupId);
    markDirty();
    await commitDraftAndSync();
    clearError();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

async function renameGroup(groupId) {
  if (!currentConfig) {
    return;
  }
  const initialGroup = WTP.groupById(currentConfig, groupId);
  if (!initialGroup) {
    return;
  }
  const entered = await requestText({
    title: `Rename “${initialGroup.name}”`,
    label: "Group name",
    value: initialGroup.name,
    confirmLabel: "Rename",
  });
  if (entered === null) {
    return;
  }

  let before = null;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    const group = WTP.groupById(currentConfig, groupId);
    if (!group) {
      throw new Error("That pool group no longer exists.");
    }
    group.name = uniqueGroupName(entered.trim() || group.name, group.id);
    markDirty();
    await commitDraftAndSync();
    clearError();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

async function cloneGroup(groupId) {
  if (!currentConfig) {
    return;
  }
  const initialSource = WTP.groupById(currentConfig, groupId);
  if (!initialSource) {
    return;
  }
  const entered = await requestText({
    title: `Clone “${initialSource.name}”`,
    label: "Name for the cloned group",
    value: uniqueGroupName(`${initialSource.name} copy`),
    confirmLabel: "Clone",
  });
  if (entered === null) {
    return;
  }

  let before = null;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    const source = WTP.groupById(currentConfig, groupId);
    if (!source) {
      throw new Error("That pool group no longer exists.");
    }
    const name = uniqueGroupName(entered.trim() || `${source.name} copy`);
    const clone = {
      id: uniqueGroupId(name),
      name,
      pools: source.pools.map((pool) => ({ ...pool })),
      shortcuts: [...source.shortcuts],
    };
    currentConfig.poolGroups.push(clone);
    editingGroupIds.add(clone.id);
    expandedGroupIds.add(clone.id);
    markDirty();
    await commitDraftAndSync();
    clearError();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

async function createGroup() {
  if (!currentConfig) {
    return;
  }
  const entered = await requestText({
    title: "Create pool group",
    label: "Name for the new group",
    value: uniqueGroupName("New group"),
    confirmLabel: "Create",
  });
  if (entered === null) {
    return;
  }

  let before = null;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    const name = uniqueGroupName(entered.trim() || "New group");
    const group = {
      id: uniqueGroupId(name),
      name,
      pools: [WTP.defaultPool(1)],
      shortcuts: WTP.defaultShortcuts(),
    };
    currentConfig.poolGroups.push(group);
    editingGroupIds.add(group.id);
    expandedGroupIds.add(group.id);
    markDirty();
    await commitDraftAndSync();
    clearError();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

function refreshRuntimeGroupStateUi() {
  if (!currentConfig) {
    return;
  }
  for (const row of groupListElement.querySelectorAll(".group-row")) {
    const groupId = row.dataset.groupId;
    const active = isGroupActive(groupId);
    const badge = row.querySelector('[data-role="active-badge"]');
    const stateButton = row.querySelector('[data-role="group-state-button"]');
    if (badge) {
      badge.hidden = !active;
    }
    if (stateButton) {
      stateButton.textContent = active ? "Unload" : "Load";
    }
  }
}

function applyRemoteConfiguration(rawConfig, { preserveDraft = dirty } = {}) {
  const remote = WTP.normalizeConfig(rawConfig);
  if (!currentConfig || !preserveDraft) {
    currentConfig = remote;
    pruneUiState();
    allowMultipleGroupsInput.checked = currentConfig.allowMultipleGroups;
    hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
    muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
    renderAll();
    return;
  }

  const localGroupIds = new Set(currentConfig.poolGroups.map((group) => group.id));
  currentConfig.enabled = remote.enabled;
  currentConfig.activeGroupIds = remote.activeGroupIds.filter(
    (groupId) => localGroupIds.has(groupId),
  );
  refreshRuntimeGroupStateUi();
  renderGroupGraph();
  updateEditorFooter();
  updateCompatibilityValidation();
}

async function loadPage() {
  try {
    const [config, shortcuts] = await Promise.all([
      WTP.loadConfig(),
      shortcutMap(),
    ]);
    currentConfig = config;
    const shortcutsChanged = applyShortcutMapToActiveGroups(shortcuts);
    editingGroupIds.clear();
    expandedGroupIds.clear();
    allowMultipleGroupsInput.checked = currentConfig.allowMultipleGroups;
    hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
    muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
    renderAll();
    if (shortcutsChanged) {
      markDirty();
      await autosaveChanges();
    } else {
      setDirty(false);
    }
  } catch (error) {
    showError(error.message);
  }
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[WTP.CONFIG_KEY] || !currentConfig) {
    return;
  }
  applyRemoteConfiguration(changes[WTP.CONFIG_KEY].newValue);
});

shortcutSettingsButton.addEventListener("click", async () => {
  try {
    if (formatAllShortcutInputs()) {
      markDirty();
    }
    await commitDraftAndSync({ render: false });
    const savedConfig = await WTP.loadConfig();
    shortcutAssignmentTargets = WTP.activePoolAssignments(savedConfig).map(
      (assignment) => ({
        commandSlot: assignment.commandSlot,
        groupId: assignment.group.id,
        poolId: assignment.pool.id,
      }),
    );
    reloadShortcutsOnFocus = true;
    await browser.runtime.sendMessage({ type: "openShortcutSettings" });
    clearError();
  } catch (error) {
    showError(error.message);
  }
});

createGroupButton.addEventListener("click", () => void createGroup());

resetGroupGraphButton.addEventListener("click", () => {
  clearStoredGraphPositions();
  renderGroupGraph();
});

exportConfigButton.addEventListener("click", () => {
  try {
    const config = syncEditorsIntoDraft();
    const blob = new Blob(
      [JSON.stringify(config, null, 2) + "\n"],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "warm-tab-pool-config.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    clearError();
  } catch (error) {
    showError(error.message);
  }
});

importConfigButton.addEventListener("click", async () => {
  if (dirty) {
    const confirmed = await requestConfirmation({
      title: "Replace pending changes?",
      message: "Importing a configuration will replace changes that could not yet be saved automatically.",
      confirmLabel: "Import",
    });
    if (!confirmed) {
      return;
    }
  }
  importFileInput.click();
});

importFileInput.addEventListener("change", async () => {
  const [file] = importFileInput.files;
  if (!file) {
    return;
  }
  importConfigButton.disabled = true;
  try {
    const raw = JSON.parse(await file.text());
    if (
      !raw
      || typeof raw !== "object"
      || raw.version !== WTP.CONFIG_VERSION
      || !Array.isArray(raw.poolGroups)
      || !Array.isArray(raw.activeGroupIds)
    ) {
      throw new Error(`This JSON file is not a Warm Tab Pool configuration version ${WTP.CONFIG_VERSION}.`);
    }
    const imported = WTP.normalizeConfig(raw);
    const result = await browser.runtime.sendMessage({
      type: "saveConfigAndSync",
      config: imported,
    });
    currentConfig = WTP.normalizeConfig(result.config);
    editingGroupIds.clear();
    expandedGroupIds.clear();
    allowMultipleGroupsInput.checked = currentConfig.allowMultipleGroups;
    hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
    muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
    renderAll();
    setDirty(false);
    clearError();
  } catch (error) {
    showError(`Import failed: ${error.message}`);
  } finally {
    importFileInput.value = "";
    importConfigButton.disabled = false;
  }
});

for (const input of [hideWarmTabsInput, muteWarmTabsInput]) {
  input.addEventListener("change", () => {
    markDirty();
    void autosaveChanges();
  });
}

allowMultipleGroupsInput.addEventListener("change", () => {
  if (!currentConfig) {
    return;
  }
  try {
    syncEditorsIntoDraft();
    if (!allowMultipleGroupsInput.checked && currentConfig.activeGroupIds.length > 1) {
      currentConfig.activeGroupIds = [currentConfig.activeGroupIds[0]];
    }
    markDirty();
    renderAll();
    void autosaveChanges();
  } catch (error) {
    showError(error.message);
  }
});

groupListElement.addEventListener("input", (event) => {
  if (!event.target.closest(".group-row.editing")) {
    return;
  }
  markDirty();
  updateCompatibilityValidation();
  updateMergeButtonStates();
  renderGroupGraph();
});

groupListElement.addEventListener("change", (event) => {
  if (!event.target.closest(".group-row.editing")) {
    return;
  }
  if (event.target.matches(".pool-shortcut")) {
    return;
  }
  markDirty();
  updateCompatibilityValidation();
  updateMergeButtonStates();
  renderGroupGraph();
  void autosaveChanges();
});

groupListElement.addEventListener("focusout", (event) => {
  if (!event.target.matches(".pool-shortcut")) {
    return;
  }
  try {
    if (formatShortcutInput(event.target)) {
      markDirty();
    }
    updateCompatibilityValidation();
    updateMergeButtonStates();
    renderGroupGraph();
    void autosaveChanges();
  } catch (error) {
    markDirty();
    updateCompatibilityValidation();
    showError(error.message);
  }
});

function groupDomOrder() {
  return Array.from(
    groupListElement.querySelectorAll(":scope > .group-row"),
    (row) => row.dataset.groupId,
  );
}

function clearPoolDropTargets() {
  groupListElement.querySelectorAll(".editable-pool-body.pool-drop-target").forEach(
    (body) => body.classList.remove("pool-drop-target"),
  );
}

async function handlePoolDrop(event, targetBody, dragInfo) {
  let before = null;
  try {
    syncEditorsIntoDraft();
    before = structuredClone(currentConfig);
    const source = WTP.groupById(currentConfig, dragInfo.sourceGroupId);
    const targetGroupId = targetBody.dataset.groupId;
    const target = WTP.groupById(currentConfig, targetGroupId);
    if (!source || !target || !isEditing(source.id) || !isEditing(target.id)) {
      throw new Error("Pools can only be moved between groups that are currently being edited.");
    }
    if (source.id !== target.id && target.pools.length >= WTP.MAX_POOLS) {
      throw new Error(`The target group already contains the maximum ${WTP.MAX_POOLS} pools.`);
    }

    const sourceIndex = source.pools.findIndex((pool) => pool.id === dragInfo.poolId);
    if (sourceIndex < 0) {
      throw new Error("That pool no longer exists.");
    }
    const targetRow = event.target.closest("tr");
    const targetPoolId = targetRow?.dataset.poolId ?? null;
    if (source.id === target.id && targetPoolId === dragInfo.poolId) {
      return;
    }
    const after = targetRow
      ? event.clientY > targetRow.getBoundingClientRect().top + targetRow.getBoundingClientRect().height / 2
      : true;

    const sourceShortcuts = source.shortcuts.slice(0, source.pools.length);
    const [pool] = source.pools.splice(sourceIndex, 1);
    const [shortcut = ""] = sourceShortcuts.splice(sourceIndex, 1);

    let targetShortcuts;
    let insertIndex;
    if (source.id === target.id) {
      targetShortcuts = sourceShortcuts;
      if (!targetPoolId) {
        insertIndex = source.pools.length;
      } else {
        const targetIndex = source.pools.findIndex((candidate) => candidate.id === targetPoolId);
        insertIndex = targetIndex < 0 ? source.pools.length : targetIndex + (after ? 1 : 0);
      }
      source.pools.splice(insertIndex, 0, pool);
      targetShortcuts.splice(insertIndex, 0, shortcut);
      normalizeGroupPoolSlots(source);
      source.shortcuts = WTP.normalizeShortcuts(targetShortcuts);
    } else {
      targetShortcuts = target.shortcuts.slice(0, target.pools.length);
      if (!targetPoolId) {
        insertIndex = target.pools.length;
      } else {
        const targetIndex = target.pools.findIndex((candidate) => candidate.id === targetPoolId);
        insertIndex = targetIndex < 0 ? target.pools.length : targetIndex + (after ? 1 : 0);
      }
      target.pools.splice(insertIndex, 0, pool);
      targetShortcuts.splice(insertIndex, 0, shortcut);
      normalizeGroupPoolSlots(source);
      normalizeGroupPoolSlots(target);
      source.shortcuts = WTP.normalizeShortcuts(sourceShortcuts);
      target.shortcuts = WTP.normalizeShortcuts(targetShortcuts);
    }

    currentConfig = WTP.normalizeConfig(currentConfig);
    assertDraftCompatibility(currentConfig);
    expandedGroupIds.add(source.id);
    expandedGroupIds.add(target.id);
    markDirty();
    renderAll();
    await autosaveChanges();
    clearError();
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    showError(error.message);
  }
}

groupListElement.addEventListener("dragstart", (event) => {
  const poolHandle = event.target.closest(".pool-drag-handle");
  if (poolHandle) {
    try {
      if (formatAllShortcutInputs()) {
        markDirty();
      }
      syncEditorsIntoDraft();
    } catch (error) {
      event.preventDefault();
      showError(error.message);
      return;
    }
    const row = poolHandle.closest("tr");
    draggedPool = {
      sourceGroupId: row.dataset.groupId,
      poolId: row.dataset.poolId,
      row,
    };
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${row.dataset.groupId}:${row.dataset.poolId}`);
    return;
  }

  const groupHandle = event.target.closest(".group-drag-handle");
  if (!groupHandle) {
    return;
  }
  try {
    if (formatAllShortcutInputs()) {
      markDirty();
    }
    syncValidDraft();
  } catch (error) {
    event.preventDefault();
    showError(error.message);
    return;
  }
  draggedGroupRow = groupHandle.closest(".group-row");
  draggedGroupOrder = groupDomOrder().join(",");
  draggedGroupRow.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedGroupRow.dataset.groupId);
});

groupListElement.addEventListener("dragover", (event) => {
  if (draggedPool) {
    clearPoolDropTargets();
    const expandedBody = event.target.closest(".group-expanded-body");
    const targetBody = event.target.closest(".editable-pool-body")
      ?? expandedBody?.querySelector(".editable-pool-body");
    if (!targetBody || !isEditing(targetBody.dataset.groupId)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    targetBody.classList.add("pool-drop-target");
    return;
  }
  if (!draggedGroupRow) {
    return;
  }
  const target = event.target.closest(".group-row");
  if (!target || target === draggedGroupRow) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const rect = target.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  groupListElement.insertBefore(draggedGroupRow, after ? target.nextSibling : target);
});

groupListElement.addEventListener("drop", (event) => {
  if (draggedPool) {
    const expandedBody = event.target.closest(".group-expanded-body");
    const targetBody = event.target.closest(".editable-pool-body")
      ?? expandedBody?.querySelector(".editable-pool-body");
    const dragInfo = draggedPool;
    dragInfo.row.classList.remove("dragging");
    draggedPool = null;
    clearPoolDropTargets();
    if (targetBody) {
      event.preventDefault();
      void handlePoolDrop(event, targetBody, dragInfo);
    }
    return;
  }
  if (draggedGroupRow) {
    event.preventDefault();
  }
});

groupListElement.addEventListener("dragend", () => {
  if (draggedPool) {
    draggedPool.row.classList.remove("dragging");
    draggedPool = null;
    clearPoolDropTargets();
    return;
  }
  if (!draggedGroupRow || !currentConfig) {
    return;
  }
  draggedGroupRow.classList.remove("dragging");
  const order = groupDomOrder();
  const changed = order.join(",") !== draggedGroupOrder;
  draggedGroupRow = null;
  draggedGroupOrder = "";
  if (!changed) {
    return;
  }

  void (async () => {
    let before = null;
    try {
      syncValidDraft();
      before = structuredClone(currentConfig);
      const byId = new Map(currentConfig.poolGroups.map((group) => [group.id, group]));
      currentConfig.poolGroups = order.map((id) => byId.get(id)).filter(Boolean);
      const activeIds = new Set(currentConfig.activeGroupIds);
      currentConfig.activeGroupIds = currentConfig.poolGroups
        .filter((group) => activeIds.has(group.id))
        .map((group) => group.id);
      currentConfig = WTP.normalizeConfig(currentConfig);
      assertDraftCompatibility(currentConfig);
      markDirty();
      renderAll();
      await autosaveChanges();
      clearError();
    } catch (error) {
      if (before) {
        currentConfig = before;
      }
      renderAll();
      showError(error.message);
    }
  })();
});

window.addEventListener("focus", async () => {
  if (!currentConfig || !reloadShortcutsOnFocus) {
    return;
  }
  reloadShortcutsOnFocus = false;
  try {
    const shortcuts = await shortcutMap();
    const changed = applyShortcutMapToTargets(shortcuts, shortcutAssignmentTargets);
    shortcutAssignmentTargets = [];
    if (changed) {
      markDirty();
      renderAll();
      await autosaveChanges();
    }
    clearError();
  } catch (error) {
    showError(`Could not reload browser shortcuts: ${error.message}`);
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!dirty) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
});

void loadPage();
