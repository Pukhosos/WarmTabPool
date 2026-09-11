"use strict";

const allowMultipleGroupsInput = document.querySelector("#allowMultipleGroups");
const hideWarmTabsInput = document.querySelector("#hideWarmTabs");
const muteWarmTabsInput = document.querySelector("#muteWarmTabs");
const saveButton = document.querySelector("#save");
const shortcutSettingsButton = document.querySelector("#shortcutSettings");
const messageElement = document.querySelector("#message");
const editorHost = document.querySelector("#editorHost");
const activeGroupsHost = document.querySelector("#activeGroupsHost");
const activePoolsEmpty = document.querySelector("#activePoolsEmpty");
const groupListElement = document.querySelector("#groupList");
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
let editingGroupId = null;
let rowsElement = null;
let dirty = false;
let reloadShortcutsOnFocus = false;
let shortcutAssignmentTargets = [];
let draggedPoolRow = null;
let draggedPoolOrder = "";
let draggedGroupRow = null;
let draggedGroupOrder = "";
let draggedActiveGroupPanel = null;
let draggedActiveGroupOrder = "";
let draftCompatibilityIssue = null;
let compatibilityMessage = "";

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
      renderGroupGraph();
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
      renderGroupGraph();
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
  const unload = document.createElement("button");
  unload.type = "button";
  unload.className = "group-unload-button";
  unload.textContent = "Unload";
  unload.title = `Unload ${group.name}`;
  unload.setAttribute("aria-label", `Unload ${group.name}`);
  unload.addEventListener("click", () => void changeGroupActive(group.id, false));

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "group-edit-button";
  edit.textContent = "✎";
  edit.title = `Edit ${group.name}`;
  edit.setAttribute("aria-label", `Edit ${group.name}`);
  edit.addEventListener("click", () => selectEditor(group.id));
  actions.append(unload, edit);
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
    const mainActions = document.createElement("div");
    mainActions.className = "group-actions-main";

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
      mainActions.append(mergeWrap);
    } else {
      const mergePlaceholder = document.createElement("span");
      mergePlaceholder.className = "merge-action-placeholder";
      mergePlaceholder.setAttribute("aria-hidden", "true");
      mainActions.append(mergePlaceholder);
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
    edit.textContent = "✎";
    edit.disabled = group.id === editingGroupId;
    edit.title = group.id === editingGroupId ? "This group is being edited" : `Edit ${group.name}`;
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click", () => selectEditor(group.id));

    mainActions.append(rename, clone, remove, edit);

    const divider = document.createElement("span");
    divider.className = "group-actions-divider";
    divider.setAttribute("aria-hidden", "true");

    const stateAction = document.createElement("div");
    stateAction.className = "group-state-action";
    const active = isGroupActive(group.id);
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = active ? "Unload" : "Load";
    load.addEventListener("click", () => void changeGroupActive(group.id, !active));
    stateAction.append(load);

    actions.append(mainActions, divider, stateAction);
    row.append(dragWrap, nameWrap, summary, actions);
    groupListElement.append(row);
  }
  updateMergeButtonStates();
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
  return previewConfigWithEditor() ?? currentConfig;
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
  renderEditor();
  renderActiveGroups();
  renderGroups();
  renderGroupGraph();
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
    // Apply the editor fields first, then validate the resulting active set.
    // This lets an unload (or single-group replacement) resolve a draft
    // compatibility conflict instead of being blocked by the pre-change set.
    syncEditorIntoDraft();
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
    editingGroupId = null;
    allowMultipleGroupsInput.checked = currentConfig.allowMultipleGroups;
    hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
    muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
    renderAll();
    setDirty(shortcutsChanged);
    if (shortcutsChanged) {
      setMessage("Browser shortcut changes detected. Save to store them in the active groups.");
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
    reloadShortcutsOnFocus = true;
    await browser.runtime.sendMessage({ type: "openShortcutSettings" });
  } catch (error) {
    setMessage(error.message, { error: true });
  }
});

createGroupButton.addEventListener("click", () => void createGroup());

resetGroupGraphButton.addEventListener("click", () => {
  clearStoredGraphPositions();
  renderGroupGraph();
  setMessage("Restored the default group graph arrangement.");
});

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
      setMessage("Multiple-group mode is disabled in the draft; saving will unload all but the first active group.");
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
    renderGroupGraph();
  }
});
editorHost.addEventListener("change", (event) => {
  if (event.target.closest(".group-panel.editor")) {
    markDirty();
    updateCompatibilityValidation();
    updateMergeButtonStates();
    renderGroupGraph();
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
      setMessage("Browser shortcut changes detected. Save to store them in the active groups.");
    }
  } catch (error) {
    setMessage(`Could not reload browser shortcuts: ${error.message}`, { error: true });
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
