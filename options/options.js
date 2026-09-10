"use strict";

const allowMultipleGroupsInput = document.querySelector("#allowMultipleGroups");
const hideWarmTabsInput = document.querySelector("#hideWarmTabs");
const muteWarmTabsInput = document.querySelector("#muteWarmTabs");
const saveButton = document.querySelector("#save");
const refreshButton = document.querySelector("#refresh");
const shortcutSettingsButton = document.querySelector("#shortcutSettings");
const messageElement = document.querySelector("#message");
const activePoolLimitElement = document.querySelector("#activePoolLimit");
const editorHost = document.querySelector("#editorHost");
const activeGroupsHost = document.querySelector("#activeGroupsHost");
const activePoolsEmpty = document.querySelector("#activePoolsEmpty");
const groupListElement = document.querySelector("#groupList");
const createGroupButton = document.querySelector("#createGroup");
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
let editingGroupId = null;
let rowsElement = null;
let dirty = false;
let refreshShortcutsOnFocus = false;
let shortcutAssignmentTargets = [];
let draggedPoolRow = null;
let draggedPoolOrder = "";
let draggedGroupRow = null;
let draggedGroupOrder = "";
let draggedActiveGroupPanel = null;
let draggedActiveGroupOrder = "";
let draftCompatibilityIssue = null;
let compatibilityMessage = "";

activePoolLimitElement.textContent = String(WTP.MAX_POOLS);

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

function setMessage(text, { error = false } = {}) {
  messageElement.textContent = text;
  messageElement.classList.toggle("error", error);
}

function updateSaveButton() {
  saveButton.disabled = !dirty || Boolean(draftCompatibilityIssue);
}

function setDirty(value) {
  dirty = value;
  updateSaveButton();
}

function markDirty() {
  if (!dirty) {
    setMessage("");
  }
  setDirty(true);
}

function clearInvalid() {
  editorHost.querySelectorAll(".invalid").forEach(
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

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function makeDragHandle(label) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "drag-handle";
  handle.textContent = "⋮⋮";
  handle.draggable = true;
  handle.setAttribute("aria-label", label);
  handle.title = label;
  return handle;
}

function editingGroup() {
  if (!currentConfig || !editingGroupId) {
    return null;
  }
  return WTP.groupById(currentConfig, editingGroupId);
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

function groupSummary(group) {
  return `${group.pools.length} pools · ${groupWarmTabCount(group)} warm tabs`;
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
  }
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");

  const headers = editable
    ? ["", "On", "Slot", "Name", "URL", "Size", "Shortcut", "Actions"]
    : ["Active slot", "On", "Name", "URL", "Size", "Shortcut"];
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
  table.append(head, body);
  wrap.append(table);
  return { wrap, body };
}

function reindexPoolRows() {
  if (!rowsElement) {
    return;
  }
  Array.from(rowsElement.querySelectorAll("tr")).forEach((row, index) => {
    const slot = index + 1;
    row.dataset.slot = String(slot);
    row.querySelector(".slot").textContent = String(slot);
  });
}

function poolRowOrder() {
  if (!rowsElement) {
    return "";
  }
  return Array.from(rowsElement.querySelectorAll("tr"), (row) => row.dataset.dragKey)
    .join(",");
}

function collectShortcutArray() {
  const result = WTP.defaultShortcuts();
  if (!rowsElement) {
    return result;
  }
  Array.from(rowsElement.querySelectorAll("tr")).forEach((row, index) => {
    result[index] = row.querySelector(".pool-shortcut").value.trim();
  });
  return result;
}

function collectPools() {
  if (!rowsElement) {
    return [];
  }
  clearInvalid();
  const pools = [];
  let firstError = null;

  Array.from(rowsElement.querySelectorAll("tr")).forEach((row, index) => {
    const slot = index + 1;
    const enabled = row.querySelector(".pool-enabled").checked;
    const nameInput = row.querySelector(".pool-name");
    const urlInput = row.querySelector(".pool-url");
    const sizeInput = row.querySelector(".pool-size");
    const name = nameInput.value.trim() || `Pool ${slot}`;
    let url = urlInput.value.trim();
    const size = Number(sizeInput.value);

    if (
      !Number.isInteger(size)
      || size < WTP.MIN_POOL_SIZE
      || size > WTP.MAX_POOL_SIZE
    ) {
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

function syncEditorIntoDraft() {
  if (!currentConfig) {
    throw new Error("Configuration is still loading.");
  }
  syncGlobalSettingsIntoDraft();
  const group = editingGroup();
  if (group && rowsElement) {
    group.pools = collectPools();
    group.shortcuts = WTP.normalizeShortcuts(collectShortcutArray());
  }
  currentConfig = WTP.normalizeConfig(currentConfig);
  return currentConfig;
}

function previewConfigWithEditor() {
  if (!currentConfig) {
    return null;
  }

  const draft = structuredClone(currentConfig);
  if (editingGroupId && rowsElement) {
    const group = WTP.groupById(draft, editingGroupId);
    if (group) {
      const rows = Array.from(rowsElement.querySelectorAll("tr"));
      const poolsById = new Map(group.pools.map((pool) => [pool.id, pool]));
      const shortcuts = WTP.defaultShortcuts();
      group.pools = rows.map((row, index) => {
        const previous = poolsById.get(row.dataset.poolId)
          ?? WTP.defaultPool(index + 1, row.dataset.poolId);
        shortcuts[index] = row.querySelector(".pool-shortcut").value.trim();
        return {
          ...previous,
          slot: index + 1,
          name: row.querySelector(".pool-name").value.trim() || `Pool ${index + 1}`,
        };
      });
      group.shortcuts = WTP.normalizeShortcuts(shortcuts);
    }
  }
  return WTP.normalizeConfig(draft);
}

function previewActiveConfigurationIssue() {
  const draft = previewConfigWithEditor();
  return draft ? WTP.activeConfigurationIssue(draft) : null;
}

function updateMergeButtonStates() {
  if (!currentConfig || !editingGroupId) {
    return;
  }
  const draft = previewConfigWithEditor();
  const target = draft ? WTP.groupById(draft, editingGroupId) : null;
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

function updateCompatibilityValidation({ announce = true } = {}) {
  const issue = previewActiveConfigurationIssue();
  draftCompatibilityIssue = issue;
  updateSaveButton();

  if (issue && announce) {
    compatibilityMessage = issue.message;
    setMessage(issue.message, { error: true });
  } else if (!issue && compatibilityMessage) {
    if (messageElement.textContent === compatibilityMessage) {
      setMessage("");
    }
    compatibilityMessage = "";
  }
  return issue;
}

function assertDraftCompatibility(config = currentConfig) {
  const issue = WTP.activeConfigurationIssue(config);
  if (issue) {
    draftCompatibilityIssue = issue;
    compatibilityMessage = issue.message;
    updateSaveButton();
    throw new Error(issue.message);
  }
  draftCompatibilityIssue = null;
  compatibilityMessage = "";
  updateSaveButton();
}

function syncValidDraft() {
  const draft = syncEditorIntoDraft();
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

function renderEditableRows(group, body) {
  for (const pool of group.pools) {
    const row = document.createElement("tr");
    row.dataset.slot = String(pool.slot);
    row.dataset.poolId = pool.id;
    row.dataset.dragKey = crypto.randomUUID();

    const dragCell = document.createElement("td");
    dragCell.className = "drag-cell";
    dragCell.append(makeDragHandle("Drag to reorder this pool"));

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

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.textContent = "Clear";
    clearButton.title = "Reset this pool to default values";
    clearButton.addEventListener("click", () => {
      const slot = Number(row.dataset.slot);
      enabled.checked = false;
      name.value = `Pool ${slot}`;
      url.value = "";
      size.value = String(WTP.DEFAULT_POOL_SIZE);
      shortcut.value = "";
      autoGrow(url);
      markDirty();
      updateCompatibilityValidation();
      updateMergeButtonStates();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.title = "Remove this pool from the group";
    deleteButton.addEventListener("click", () => {
      row.remove();
      reindexPoolRows();
      markDirty();
      updateEditorFooter();
      updateCompatibilityValidation();
      updateMergeButtonStates();
    });

    actions.append(clearButton, deleteButton);
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

function setupPoolDragEvents(body) {
  body.addEventListener("dragstart", (event) => {
    const handle = event.target.closest(".drag-handle");
    if (!handle) {
      return;
    }
    draggedPoolRow = handle.closest("tr");
    draggedPoolOrder = poolRowOrder();
    draggedPoolRow.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedPoolRow.dataset.slot);
  });

  body.addEventListener("dragover", (event) => {
    if (!draggedPoolRow) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = event.target.closest("tr");
    if (!target || target === draggedPoolRow) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    body.insertBefore(draggedPoolRow, after ? target.nextSibling : target);
  });

  body.addEventListener("drop", (event) => {
    if (draggedPoolRow) {
      event.preventDefault();
    }
  });

  body.addEventListener("dragend", () => {
    if (!draggedPoolRow) {
      return;
    }
    draggedPoolRow.classList.remove("dragging");
    reindexPoolRows();
    const changed = poolRowOrder() !== draggedPoolOrder;
    draggedPoolRow = null;
    draggedPoolOrder = "";
    if (changed) {
      markDirty();
      updateCompatibilityValidation();
      updateMergeButtonStates();
    }
  });
}

function updateEditorFooter() {
  const group = editingGroup();
  const addButton = editorHost.querySelector("#addPool");
  const note = editorHost.querySelector("#editorLimitNote");
  if (!group || !addButton || !note || !rowsElement) {
    return;
  }

  const currentCount = rowsElement.querySelectorAll("tr").length;
  const otherActiveCount = activePoolCountExcluding(group.id);
  const activeCapacityReached = isGroupActive(group.id)
    && otherActiveCount + currentCount >= WTP.MAX_POOLS;
  addButton.disabled = currentCount >= WTP.MAX_POOLS || activeCapacityReached;

  if (currentCount >= WTP.MAX_POOLS) {
    note.textContent = `This group already contains the maximum ${WTP.MAX_POOLS} pools.`;
  } else if (activeCapacityReached) {
    note.textContent = `The active groups already occupy all ${WTP.MAX_POOLS} shortcut slots.`;
  } else {
    note.textContent = "";
  }
}

function renderEditor() {
  editorHost.replaceChildren();
  rowsElement = null;
  const group = editingGroup();
  if (!group) {
    return;
  }

  const panel = document.createElement("section");
  panel.className = "group-panel editor";
  const header = document.createElement("div");
  header.className = "group-panel-header";
  const title = document.createElement("div");
  title.className = "group-panel-title";
  const strong = document.createElement("strong");
  strong.textContent = group.name;
  title.append(strong, makeBadge("Editing"));
  if (isGroupActive(group.id)) {
    title.append(makeBadge("Active"));
  }

  const headerActions = document.createElement("div");
  headerActions.className = "group-panel-actions";
  const done = document.createElement("button");
  done.type = "button";
  done.textContent = "Done";
  done.title = "Keep these edits in the current draft and exit editing mode";
  done.addEventListener("click", () => {
    try {
      syncValidDraft();
      editingGroupId = null;
      renderAll();
    } catch (error) {
      setMessage(error.message, { error: true });
    }
  });
  headerActions.append(done);
  header.append(title, headerActions);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "group-panel-body";
  const { wrap, body } = createPoolTable({ editable: true });
  rowsElement = body;
  renderEditableRows(group, body);
  setupPoolDragEvents(body);

  const footer = document.createElement("div");
  footer.className = "editor-footer";
  const add = document.createElement("button");
  add.id = "addPool";
  add.className = "plus-button";
  add.type = "button";
  add.textContent = "+";
  add.setAttribute("aria-label", "Add pool");
  add.title = "Add pool";
  add.addEventListener("click", () => {
    try {
      syncEditorIntoDraft();
      const edited = editingGroup();
      if (!edited || !editorCanAddPool(edited)) {
        updateEditorFooter();
        return;
      }
      const slot = edited.pools.length + 1;
      edited.pools.push(WTP.defaultPool(slot, uniquePoolId(edited)));
      renderAll();
      markDirty();
    } catch (error) {
      setMessage(error.message, { error: true });
    }
  });
  const note = document.createElement("p");
  note.id = "editorLimitNote";
  note.className = "editor-limit-note";
  footer.append(add, note);

  bodyWrap.append(wrap, footer);
  panel.append(header, bodyWrap);
  editorHost.append(panel);
  updateEditorFooter();
}

function renderReadonlyActiveGroup(group, assignmentByPoolId) {
  const panel = document.createElement("section");
  panel.className = "group-panel active-group-panel";
  panel.dataset.groupId = group.id;
  const header = document.createElement("div");
  header.className = "group-panel-header";
  const title = document.createElement("div");
  title.className = "group-panel-title";
  const dragHandle = makeDragHandle(`Drag to reorder active group ${group.name}`);
  dragHandle.classList.add("active-group-drag-handle");
  const strong = document.createElement("strong");
  strong.textContent = group.name;
  const summary = document.createElement("span");
  summary.className = "active-summary";
  summary.textContent = groupSummary(group);
  title.append(dragHandle, strong, makeBadge("Active"), summary);

  const actions = document.createElement("div");
  actions.className = "group-panel-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => selectEditor(group.id));
  actions.append(edit);
  header.append(title, actions);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "group-panel-body";
  const { wrap, body } = createPoolTable();

  for (const pool of group.pools) {
    const assignment = assignmentByPoolId.get(`${group.id}\u0000${pool.id}`);
    const row = document.createElement("tr");
    const slotCell = document.createElement("td");
    slotCell.className = "slot";
    slotCell.textContent = assignment ? String(assignment.commandSlot) : "—";

    const enabledCell = document.createElement("td");
    enabledCell.className = "enabled";
    enabledCell.textContent = pool.enabled ? "✓" : "—";

    const nameCell = document.createElement("td");
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
  bodyWrap.append(wrap);
  panel.append(header, bodyWrap);
  return panel;
}

function renderActiveGroups() {
  activeGroupsHost.replaceChildren();
  if (!currentConfig) {
    activePoolsEmpty.hidden = true;
    return;
  }

  const assignments = WTP.activePoolAssignments(currentConfig);
  const assignmentByPoolId = new Map(assignments.map((assignment) => [
    `${assignment.group.id}\u0000${assignment.pool.id}`,
    assignment,
  ]));
  const activeGroups = WTP.activeGroups(currentConfig);

  for (const group of activeGroups) {
    if (group.id === editingGroupId) {
      continue;
    }
    activeGroupsHost.append(renderReadonlyActiveGroup(group, assignmentByPoolId));
  }
  activePoolsEmpty.hidden = activeGroups.length > 0;
}

function selectEditor(groupId) {
  if (!currentConfig || groupId === editingGroupId) {
    return;
  }
  try {
    syncValidDraft();
    if (!WTP.groupById(currentConfig, groupId)) {
      throw new Error("That pool group no longer exists.");
    }
    editingGroupId = groupId;
    renderAll();
  } catch (error) {
    setMessage(error.message, { error: true });
  }
}

function renderGroups() {
  groupListElement.replaceChildren();
  if (!currentConfig) {
    return;
  }

  for (const group of currentConfig.poolGroups) {
    const row = document.createElement("div");
    row.className = "group-row";
    row.dataset.groupId = group.id;

    const dragWrap = document.createElement("div");
    dragWrap.append(makeDragHandle("Drag to reorder this group"));

    const nameWrap = document.createElement("div");
    nameWrap.className = "group-name";
    const name = document.createElement("strong");
    name.textContent = group.name;
    nameWrap.append(name);
    if (isGroupActive(group.id)) {
      nameWrap.append(makeBadge("Active"));
    }
    if (group.id === editingGroupId) {
      nameWrap.append(makeBadge("Editing"));
    }

    const summary = document.createElement("div");
    summary.className = "group-summary";
    summary.textContent = groupSummary(group);

    const actions = document.createElement("div");
    actions.className = "group-actions";

    if (editingGroupId && group.id !== editingGroupId) {
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
      actions.append(mergeWrap);
    }

    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "Rename";
    rename.addEventListener("click", () => void renameGroup(group.id));

    const clone = document.createElement("button");
    clone.type = "button";
    clone.textContent = "Clone";
    clone.addEventListener("click", () => void cloneGroup(group.id));

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = group.id === editingGroupId ? "Editing" : "Edit";
    edit.disabled = group.id === editingGroupId;
    edit.addEventListener("click", () => selectEditor(group.id));

    const active = isGroupActive(group.id);
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = active ? "Unload" : "Load";
    load.addEventListener("click", () => void changeGroupActive(group.id, !active));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => void deleteGroup(group.id));

    actions.append(rename, clone, edit, load, remove);
    row.append(dragWrap, nameWrap, summary, actions);
    groupListElement.append(row);
  }
  updateMergeButtonStates();
}

function renderAll() {
  renderEditor();
  renderActiveGroups();
  renderGroups();
  updateCompatibilityValidation();
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

async function commitDraftAndSync() {
  const draft = syncValidDraft();
  const result = await browser.runtime.sendMessage({
    type: "saveConfigAndSync",
    config: draft,
  });
  currentConfig = WTP.normalizeConfig(result.config);
  if (editingGroupId && !WTP.groupById(currentConfig, editingGroupId)) {
    editingGroupId = null;
  }
  allowMultipleGroupsInput.checked = currentConfig.allowMultipleGroups;
  hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
  muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
  setDirty(false);
  renderAll();
  return result;
}

async function changeGroupActive(groupId, active) {
  if (!currentConfig) {
    return;
  }
  setMessage(active ? "Loading pool group…" : "Unloading pool group…");
  let before = null;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    if (active) {
      if (currentConfig.allowMultipleGroups) {
        if (!currentConfig.activeGroupIds.includes(groupId)) {
          currentConfig.activeGroupIds.push(groupId);
        }
      } else {
        currentConfig.activeGroupIds = [groupId];
      }
    } else {
      currentConfig.activeGroupIds = currentConfig.activeGroupIds.filter(
        (id) => id !== groupId,
      );
    }
    currentConfig = WTP.normalizeConfig(currentConfig);
    const group = WTP.groupById(currentConfig, groupId);
    await commitDraftAndSync();
    setMessage(`${active ? "Loaded" : "Unloaded"} group “${group?.name ?? groupId}”.`);
  } catch (error) {
    if (before) {
      currentConfig = before;
      renderAll();
    }
    setMessage(error.message, { error: true });
  }
}

async function mergeGroupIntoEdited(sourceGroupId) {
  if (!currentConfig || !editingGroupId || sourceGroupId === editingGroupId) {
    return;
  }

  let before = null;
  const targetGroupId = editingGroupId;
  try {
    syncEditorIntoDraft();
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

    const initialInfo = nonDestructiveIssue
      ? nonDestructiveIssue.message
      : `“${source.name}” will remain unchanged after its pools are appended.`;
    const result = await showAppDialog({
      title: `Merge “${source.name}” into “${target.name}”`,
      message: `Append ${source.pools.length} ${poolWord} from “${source.name}” to “${target.name}”.`,
      checkboxLabel: `Remove “${source.name}” after merging (destructive)`,
      checkboxValue: false,
      info: initialInfo,
      infoError: Boolean(nonDestructiveIssue),
      confirmLabel: "Merge",
      confirmDisabled: Boolean(nonDestructiveIssue),
      onCheckboxChange: updateMergeDialogState,
    });
    if (!result.accepted) {
      return;
    }
    const destructive = Boolean(result.checked);

    // The popup may have changed active-group state while the modal was open.
    // Re-read the live fields merged into our draft and re-run the preflight
    // for the selected merge mode before committing.
    syncEditorIntoDraft();
    const latestSource = WTP.groupById(currentConfig, sourceGroupId);
    const latestTarget = WTP.groupById(currentConfig, targetGroupId);
    if (!latestSource || !latestTarget) {
      throw new Error("One of the pool groups no longer exists.");
    }
    const latestIssue = WTP.groupMergeIssue(
      currentConfig, latestSource.id, latestTarget.id, { destructive },
    );
    if (latestIssue) {
      throw new Error(latestIssue.message);
    }

    before = structuredClone(currentConfig);
    currentConfig = WTP.mergeGroups(
      currentConfig, latestSource.id, latestTarget.id, { destructive },
    );
    editingGroupId = latestTarget.id;
    rowsElement = null;
    await commitDraftAndSync();
    setMessage(
      destructive
        ? `Merged “${latestSource.name}” into “${latestTarget.name}” and removed “${latestSource.name}”.`
        : `Merged “${latestSource.name}” into “${latestTarget.name}”; “${latestSource.name}” was kept.`,
    );
  } catch (error) {
    if (before) {
      currentConfig = before;
      editingGroupId = targetGroupId;
      renderAll();
    }
    setMessage(error.message, { error: true });
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
  const beforeEditingId = editingGroupId;
  try {
    syncValidDraft();
    const latestGroup = WTP.groupById(currentConfig, groupId);
    if (!latestGroup) {
      throw new Error("That pool group no longer exists.");
    }
    before = structuredClone(currentConfig);
    currentConfig.poolGroups = currentConfig.poolGroups.filter(
      (candidate) => candidate.id !== groupId,
    );
    currentConfig.activeGroupIds = currentConfig.activeGroupIds.filter(
      (id) => id !== groupId,
    );
    if (editingGroupId === groupId) {
      editingGroupId = null;
      rowsElement = null;
    }
    await commitDraftAndSync();
    setMessage(`Deleted group “${group.name}”.`);
  } catch (error) {
    if (before) {
      currentConfig = before;
      editingGroupId = beforeEditingId;
      renderAll();
    }
    setMessage(error.message, { error: true });
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
  const beforeEditingId = editingGroupId;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    const group = WTP.groupById(currentConfig, groupId);
    if (!group) {
      throw new Error("That pool group no longer exists.");
    }
    const oldName = group.name;
    const requested = entered.trim() || group.name;
    group.name = uniqueGroupName(requested, group.id);
    const newName = group.name;
    await commitDraftAndSync();
    setMessage(`Renamed “${oldName}” to “${newName}”.`);
  } catch (error) {
    if (before) {
      currentConfig = before;
      editingGroupId = beforeEditingId;
      renderAll();
    }
    setMessage(error.message, { error: true });
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
  const initialDefaultName = uniqueGroupName(`${initialSource.name} copy`);
  const entered = await requestText({
    title: `Clone “${initialSource.name}”`,
    label: "Name for the cloned group",
    value: initialDefaultName,
    confirmLabel: "Clone",
  });
  if (entered === null) {
    return;
  }

  let before = null;
  const beforeEditingId = editingGroupId;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    const source = WTP.groupById(currentConfig, groupId);
    if (!source) {
      throw new Error("That pool group no longer exists.");
    }
    const sourceName = source.name;
    const fallbackName = uniqueGroupName(`${source.name} copy`);
    const name = uniqueGroupName(entered.trim() || fallbackName);
    const clone = {
      id: uniqueGroupId(name),
      name,
      pools: source.pools.map((pool) => ({ ...pool })),
      shortcuts: [...source.shortcuts],
    };
    currentConfig.poolGroups.push(clone);
    editingGroupId = clone.id;
    await commitDraftAndSync();
    setMessage(`Cloned “${sourceName}” as “${name}”.`);
  } catch (error) {
    if (before) {
      currentConfig = before;
      editingGroupId = beforeEditingId;
      renderAll();
    }
    setMessage(error.message, { error: true });
  }
}

async function createGroup() {
  if (!currentConfig) {
    return;
  }

  const initialDefaultName = uniqueGroupName("New group");
  const entered = await requestText({
    title: "Create pool group",
    label: "Name for the new group",
    value: initialDefaultName,
    confirmLabel: "Create",
  });
  if (entered === null) {
    return;
  }

  let before = null;
  const beforeEditingId = editingGroupId;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    const fallbackName = uniqueGroupName("New group");
    const name = uniqueGroupName(entered.trim() || fallbackName);
    const group = {
      id: uniqueGroupId(name),
      name,
      pools: [WTP.defaultPool(1)],
      shortcuts: WTP.defaultShortcuts(),
    };
    currentConfig.poolGroups.push(group);
    editingGroupId = group.id;
    await commitDraftAndSync();
    setMessage(`Created “${name}”.`);
  } catch (error) {
    if (before) {
      currentConfig = before;
      editingGroupId = beforeEditingId;
      renderAll();
    }
    setMessage(error.message, { error: true });
  }
}

function applyRemoteConfiguration(rawConfig, { preserveDraft = dirty } = {}) {
  const remote = WTP.normalizeConfig(rawConfig);
  if (!currentConfig || !preserveDraft) {
    currentConfig = remote;
    if (editingGroupId && !WTP.groupById(currentConfig, editingGroupId)) {
      editingGroupId = null;
    }
    allowMultipleGroupsInput.checked = currentConfig.allowMultipleGroups;
    hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
    muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
    renderAll();
    return;
  }

  // Popup actions only change live/runtime fields. Merge those into an
  // unsaved settings draft without rebuilding the editor DOM, which preserves
  // partially typed URLs and other in-progress field values.
  const localGroupIds = new Set(currentConfig.poolGroups.map((group) => group.id));
  currentConfig.enabled = remote.enabled;
  currentConfig.activeGroupIds = remote.activeGroupIds.filter(
    (groupId) => localGroupIds.has(groupId),
  );
  renderActiveGroups();
  renderGroups();
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
    editingGroupId = null;
    allowMultipleGroupsInput.checked = currentConfig.allowMultipleGroups;
    hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
    muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
    renderAll();
    setDirty(shortcutsChanged);
    if (shortcutsChanged) {
      setMessage("Firefox shortcut changes detected. Save to store them in the active groups.");
    }
  } catch (error) {
    setMessage(error.message, { error: true });
  }
}

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  setMessage("Saving…");
  try {
    await commitDraftAndSync();
    setMessage("Saved.");
  } catch (error) {
    setMessage(error.message, { error: true });
    setDirty(true);
  }
});

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  setMessage("Reconciling saved active pools…");
  try {
    await browser.runtime.sendMessage({ type: "reconcile" });
    const saved = await WTP.loadConfig();
    applyRemoteConfiguration(saved);
    setMessage(dirty
      ? "Warm-tab state reconciled; live group state refreshed and unsaved edits preserved."
      : "Warm-tab state reconciled and settings refreshed.");
  } catch (error) {
    setMessage(error.message, { error: true });
  } finally {
    refreshButton.disabled = false;
  }
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[WTP.CONFIG_KEY] || !currentConfig) {
    return;
  }
  applyRemoteConfiguration(changes[WTP.CONFIG_KEY].newValue);
});

shortcutSettingsButton.addEventListener("click", async () => {
  try {
    syncValidDraft();
    const savedConfig = await WTP.loadConfig();
    shortcutAssignmentTargets = WTP.activePoolAssignments(savedConfig).map(
      (assignment) => ({
        commandSlot: assignment.commandSlot,
        groupId: assignment.group.id,
        poolId: assignment.pool.id,
      }),
    );
    refreshShortcutsOnFocus = true;
    await browser.runtime.sendMessage({ type: "openShortcutSettings" });
  } catch (error) {
    setMessage(error.message, { error: true });
  }
});

createGroupButton.addEventListener("click", () => void createGroup());

exportConfigButton.addEventListener("click", () => {
  try {
    const config = syncEditorIntoDraft();
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
    setMessage("Exported the current configuration draft as JSON.");
  } catch (error) {
    setMessage(error.message, { error: true });
  }
});

importConfigButton.addEventListener("click", async () => {
  if (dirty) {
    const confirmed = await requestConfirmation({
      title: "Replace unsaved changes?",
      message: "Importing a configuration will replace the current unsaved settings draft.",
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
  setMessage("Importing configuration…");
  try {
    const raw = JSON.parse(await file.text());
    if (
      !raw
      || typeof raw !== "object"
      || (!Array.isArray(raw.poolGroups) && !Array.isArray(raw.pools))
    ) {
      throw new Error("This JSON file is not a Warm Tab Pool configuration.");
    }

    const imported = WTP.normalizeConfig(raw);
    const hasShortcutData = Array.isArray(raw.poolGroups)
      ? raw.poolGroups.some((group) => Array.isArray(group?.shortcuts))
      : Array.isArray(raw.shortcuts);
    if (!hasShortcutData) {
      const shortcuts = await shortcutMap();
      for (const assignment of WTP.activePoolAssignments(imported)) {
        assignment.group.shortcuts[assignment.pool.slot - 1] = (
          shortcuts.get(WTP.commandName(assignment.commandSlot)) ?? ""
        );
      }
    }

    const result = await browser.runtime.sendMessage({
      type: "saveConfigAndSync",
      config: imported,
    });
    currentConfig = WTP.normalizeConfig(result.config);
    editingGroupId = null;
    allowMultipleGroupsInput.checked = currentConfig.allowMultipleGroups;
    hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
    muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
    renderAll();
    setDirty(false);
    setMessage("Imported configuration.");
  } catch (error) {
    setMessage(`Import failed: ${error.message}`, { error: true });
  } finally {
    importFileInput.value = "";
    importConfigButton.disabled = false;
  }
});

for (const input of [hideWarmTabsInput, muteWarmTabsInput]) {
  input.addEventListener("change", markDirty);
}

allowMultipleGroupsInput.addEventListener("change", () => {
  if (!currentConfig) {
    return;
  }
  try {
    syncEditorIntoDraft();
    if (!allowMultipleGroupsInput.checked && currentConfig.activeGroupIds.length > 1) {
      currentConfig.activeGroupIds = [currentConfig.activeGroupIds[0]];
      setMessage("Multiple-group mode disabled in the draft; saving will keep only the first active group loaded.");
    }
    markDirty();
    renderAll();
  } catch (error) {
    setMessage(error.message, { error: true });
  }
});

editorHost.addEventListener("input", (event) => {
  if (event.target.closest(".group-panel.editor")) {
    markDirty();
    updateCompatibilityValidation();
    updateMergeButtonStates();
  }
});
editorHost.addEventListener("change", (event) => {
  if (event.target.closest(".group-panel.editor")) {
    markDirty();
    updateCompatibilityValidation();
    updateMergeButtonStates();
  }
});

function activeGroupDomOrder() {
  return Array.from(
    activeGroupsHost.querySelectorAll(".active-group-panel"),
    (panel) => panel.dataset.groupId,
  );
}

function mergeVisibleActiveOrder(visibleOrder) {
  const visibleIds = new Set(visibleOrder);
  let visibleIndex = 0;
  return currentConfig.activeGroupIds.map((groupId) => {
    if (!visibleIds.has(groupId)) {
      return groupId;
    }
    const replacement = visibleOrder[visibleIndex];
    visibleIndex += 1;
    return replacement;
  });
}

activeGroupsHost.addEventListener("dragstart", (event) => {
  const handle = event.target.closest(".active-group-drag-handle");
  if (!handle) {
    return;
  }
  draggedActiveGroupPanel = handle.closest(".active-group-panel");
  draggedActiveGroupOrder = activeGroupDomOrder().join(",");
  draggedActiveGroupPanel.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedActiveGroupPanel.dataset.groupId);
});

activeGroupsHost.addEventListener("dragover", (event) => {
  if (!draggedActiveGroupPanel) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const target = event.target.closest(".active-group-panel");
  if (!target || target === draggedActiveGroupPanel) {
    return;
  }
  const rect = target.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  activeGroupsHost.insertBefore(
    draggedActiveGroupPanel,
    after ? target.nextSibling : target,
  );
});

activeGroupsHost.addEventListener("drop", (event) => {
  if (draggedActiveGroupPanel) {
    event.preventDefault();
  }
});

activeGroupsHost.addEventListener("dragend", async () => {
  if (!draggedActiveGroupPanel || !currentConfig) {
    return;
  }
  draggedActiveGroupPanel.classList.remove("dragging");
  const visibleOrder = activeGroupDomOrder();
  const changed = visibleOrder.join(",") !== draggedActiveGroupOrder;
  draggedActiveGroupPanel = null;
  draggedActiveGroupOrder = "";
  if (!changed) {
    return;
  }

  const issue = updateCompatibilityValidation();
  if (issue) {
    renderActiveGroups();
    return;
  }

  const beforeOrder = [...currentConfig.activeGroupIds];
  const nextOrder = mergeVisibleActiveOrder(visibleOrder);
  currentConfig.activeGroupIds = nextOrder;
  renderActiveGroups();
  renderGroups();
  try {
    await browser.runtime.sendMessage({
      type: "reorderActiveGroups",
      groupIds: nextOrder,
    });
    const saved = await WTP.loadConfig();
    currentConfig.activeGroupIds = saved.activeGroupIds.filter(
      (groupId) => Boolean(WTP.groupById(currentConfig, groupId)),
    );
    renderActiveGroups();
    renderGroups();
    setMessage("Reordered active groups.");
  } catch (error) {
    currentConfig.activeGroupIds = beforeOrder;
    renderActiveGroups();
    renderGroups();
    setMessage(error.message, { error: true });
  }
});

function groupDomOrder() {
  return Array.from(groupListElement.querySelectorAll(".group-row"),
    (row) => row.dataset.groupId).join(",");
}

groupListElement.addEventListener("dragstart", (event) => {
  const handle = event.target.closest(".drag-handle");
  if (!handle) {
    return;
  }
  draggedGroupRow = handle.closest(".group-row");
  draggedGroupOrder = groupDomOrder();
  draggedGroupRow.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedGroupRow.dataset.groupId);
});

groupListElement.addEventListener("dragover", (event) => {
  if (!draggedGroupRow) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const target = event.target.closest(".group-row");
  if (!target || target === draggedGroupRow) {
    return;
  }
  const rect = target.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  groupListElement.insertBefore(draggedGroupRow, after ? target.nextSibling : target);
});

groupListElement.addEventListener("drop", (event) => {
  if (draggedGroupRow) {
    event.preventDefault();
  }
});

groupListElement.addEventListener("dragend", async () => {
  if (!draggedGroupRow || !currentConfig) {
    return;
  }
  draggedGroupRow.classList.remove("dragging");
  const order = Array.from(groupListElement.querySelectorAll(".group-row"),
    (row) => row.dataset.groupId);
  const changed = order.join(",") !== draggedGroupOrder;
  draggedGroupRow = null;
  draggedGroupOrder = "";
  if (!changed) {
    return;
  }

  let before = null;
  const beforeEditingId = editingGroupId;
  try {
    syncValidDraft();
    before = structuredClone(currentConfig);
    const byId = new Map(currentConfig.poolGroups.map((group) => [group.id, group]));
    currentConfig.poolGroups = order.map((id) => byId.get(id)).filter(Boolean);
    await commitDraftAndSync();
    setMessage("Reordered pool groups.");
  } catch (error) {
    if (before) {
      currentConfig = before;
      editingGroupId = beforeEditingId;
    }
    setMessage(error.message, { error: true });
    renderAll();
  }
});

window.addEventListener("focus", async () => {
  if (!currentConfig || !refreshShortcutsOnFocus) {
    return;
  }
  refreshShortcutsOnFocus = false;
  try {
    const shortcuts = await shortcutMap();
    const changed = applyShortcutMapToTargets(shortcuts, shortcutAssignmentTargets);
    shortcutAssignmentTargets = [];
    if (changed) {
      markDirty();
      renderAll();
      setMessage("Firefox shortcut changes detected. Save to store them in the active groups.");
    }
  } catch (error) {
    setMessage(`Could not refresh shortcuts: ${error.message}`, { error: true });
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
