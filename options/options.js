"use strict";

const rowsElement = document.querySelector("#poolRows");
const hideWarmTabsInput = document.querySelector("#hideWarmTabs");
const muteWarmTabsInput = document.querySelector("#muteWarmTabs");
const saveButton = document.querySelector("#save");
const refillButton = document.querySelector("#refill");
const shortcutSettingsButton = document.querySelector("#shortcutSettings");
const messageElement = document.querySelector("#message");
const groupListElement = document.querySelector("#groupList");
const newGroupNameInput = document.querySelector("#newGroupName");
const createGroupButton = document.querySelector("#createGroup");
const importConfigButton = document.querySelector("#importConfig");
const exportConfigButton = document.querySelector("#exportConfig");
const importFileInput = document.querySelector("#importFile");

let currentConfig = null;
let dirty = false;
let refreshShortcutsOnFocus = false;

function setMessage(text, { error = false } = {}) {
  messageElement.textContent = text;
  messageElement.classList.toggle("error", error);
}

function clearInvalid() {
  document.querySelectorAll(".invalid").forEach(
    (element) => element.classList.remove("invalid")
  );
}

function createInput(type, className, value = "") {
  const input = document.createElement("input");
  input.type = type;
  input.className = className;
  input.value = value;
  return input;
}

function renderRows(group, shortcuts = group.shortcuts) {
  rowsElement.replaceChildren();

  for (const pool of group.pools) {
    const row = document.createElement("tr");
    row.dataset.slot = String(pool.slot);

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
    const url = createInput("url", "pool-url", pool.url);
    url.placeholder = "https://example.com/";
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
      shortcuts[pool.slot - 1] ?? "",
    );
    shortcut.placeholder = "Ctrl+Shift+1";
    shortcut.spellcheck = false;
    shortcutCell.append(shortcut);

    row.append(
      enabledCell,
      slotCell,
      nameCell,
      urlCell,
      sizeCell,
      shortcutCell,
    );
    rowsElement.append(row);
  }
}

function groupSummary(group) {
  const enabled = group.pools.filter((pool) => pool.enabled).length;
  const warmTabs = group.pools.reduce(
    (total, pool) => total + (pool.enabled ? pool.size : 0),
    0,
  );
  return `${enabled}/12 pools enabled · ${warmTabs} configured warm tabs`;
}

function renderGroups() {
  groupListElement.replaceChildren();
  if (!currentConfig) {
    return;
  }

  for (const group of currentConfig.poolGroups) {
    const row = document.createElement("div");
    row.className = "group-row";

    const nameWrap = document.createElement("div");
    nameWrap.className = "group-name";
    const name = document.createElement("strong");
    name.textContent = group.name;
    nameWrap.append(name);

    if (group.id === WTP.DEFAULT_GROUP_ID) {
      const badge = document.createElement("span");
      badge.className = "group-badge";
      badge.textContent = "Default";
      nameWrap.append(badge);
    }

    if (group.id === currentConfig.activeGroupId) {
      const badge = document.createElement("span");
      badge.className = "group-badge";
      badge.textContent = "Loaded";
      nameWrap.append(badge);
    }

    const summary = document.createElement("div");
    summary.className = "group-summary";
    summary.textContent = groupSummary(group);

    const actions = document.createElement("div");
    actions.className = "group-actions";

    const load = document.createElement("button");
    load.type = "button";
    load.textContent = group.id === currentConfig.activeGroupId
      ? "Loaded"
      : "Load";
    load.disabled = group.id === currentConfig.activeGroupId;
    load.addEventListener("click", () => void loadGroup(group.id));
    actions.append(load);

    if (group.id !== WTP.DEFAULT_GROUP_ID) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.disabled = group.id === currentConfig.activeGroupId;
      if (remove.disabled) {
        remove.title = "Load another group before deleting this group.";
      }
      remove.addEventListener("click", () => void deleteGroup(group.id));
      actions.append(remove);
    }

    row.append(nameWrap, summary, actions);
    groupListElement.append(row);
  }
}

async function shortcutMap() {
  const commands = await browser.commands.getAll();
  return new Map(commands.map(
    (command) => [command.name, command.shortcut ?? ""]
  ));
}

function shortcutArrayFromMap(shortcuts) {
  return Array.from(
    { length: WTP.MAX_POOLS },
    (_, index) => shortcuts.get(WTP.commandName(index + 1)) ?? "",
  );
}

function collectShortcutArray() {
  return Array.from(rowsElement.querySelectorAll("tr"), (row) => (
    row.querySelector(".pool-shortcut").value.trim()
  ));
}

function collectPools() {
  clearInvalid();
  const pools = [];
  let firstError = null;

  for (const row of rowsElement.querySelectorAll("tr")) {
    const slot = Number(row.dataset.slot);
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
      firstError ??= (
        `Pool ${slot}: size must be an integer from `
        + `${WTP.MIN_POOL_SIZE} to ${WTP.MAX_POOL_SIZE}.`
      );
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
        // Disabled rows may keep incomplete text until the user enables them.
      }
    }

    pools.push({
      slot,
      enabled,
      name,
      url,
      size: Number.isInteger(size) ? size : WTP.DEFAULT_POOL_SIZE,
    });
  }

  if (firstError) {
    throw new Error(firstError);
  }

  return pools;
}

function collectDraftConfig() {
  if (!currentConfig) {
    throw new Error("Configuration is still loading.");
  }

  const config = WTP.normalizeConfig(currentConfig);
  config.hideWarmTabs = hideWarmTabsInput.checked;
  config.muteWarmTabs = muteWarmTabsInput.checked;

  const group = WTP.activeGroup(config);
  group.pools = collectPools();
  group.shortcuts = WTP.normalizeShortcuts(collectShortcutArray());
  return config;
}

async function applyShortcuts(group) {
  const before = await shortcutMap();

  try {
    for (const pool of group.pools) {
      await browser.commands.update({
        name: WTP.commandName(pool.slot),
        shortcut: group.shortcuts[pool.slot - 1] ?? "",
        description: `Warm Tab Pool: ${pool.name}`,
      });
    }
  } catch (error) {
    // Keep command changes transactional as far as Firefox allows: restore the
    // shortcuts that were active before this operation if any update fails.
    await Promise.allSettled(
      Array.from({ length: WTP.MAX_POOLS }, (_, index) => {
        const slot = index + 1;
        return browser.commands.update({
          name: WTP.commandName(slot),
          shortcut: before.get(WTP.commandName(slot)) ?? "",
        });
      }),
    );
    throw error;
  }
}

async function saveCurrentConfig() {
  const draft = collectDraftConfig();
  const group = WTP.activeGroup(draft);

  await applyShortcuts(group);
  currentConfig = await WTP.saveConfig(draft);
  await browser.runtime.sendMessage({ type: "reconcile" });
  dirty = false;
  renderGroups();
}

async function loadPage() {
  const [config, shortcuts] = await Promise.all(
    [WTP.loadConfig(), shortcutMap()]
  );

  currentConfig = config;
  const active = WTP.activeGroup(currentConfig);
  // Firefox is the source of truth for the currently active command bindings.
  // Capture manual changes made in about:addons before displaying the fields.
  active.shortcuts = shortcutArrayFromMap(shortcuts);

  hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
  muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
  renderRows(active, active.shortcuts);
  renderGroups();
  dirty = false;
}

function uniqueGroupId(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
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

async function loadGroup(groupId) {
  if (!currentConfig || groupId === currentConfig.activeGroupId) {
    return;
  }

  if (
    dirty
    && !window.confirm(
      "Loading another group will discard unsaved changes in the current form. Continue?"
    )
  ) {
    return;
  }

  setMessage("Loading pool group…");

  try {
    let config;
    if (dirty) {
      config = await WTP.loadConfig();
    } else {
      config = WTP.normalizeConfig(currentConfig);
      WTP.activeGroup(config).shortcuts = WTP.normalizeShortcuts(
        collectShortcutArray(),
      );
    }

    const next = config.poolGroups.find((group) => group.id === groupId);
    if (!next) {
      throw new Error("That pool group no longer exists.");
    }

    config.activeGroupId = groupId;
    await applyShortcuts(next);
    currentConfig = await WTP.saveConfig(config);
    await browser.runtime.sendMessage({ type: "reconcile" });

    hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
    muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
    renderRows(WTP.activeGroup(currentConfig));
    renderGroups();
    dirty = false;
    setMessage(`Loaded group “${next.name}”.`);
  } catch (error) {
    setMessage(error.message, { error: true });
  }
}

async function deleteGroup(groupId) {
  if (!currentConfig || groupId === WTP.DEFAULT_GROUP_ID) {
    return;
  }

  const group = currentConfig.poolGroups.find((item) => item.id === groupId);
  if (!group || group.id === currentConfig.activeGroupId) {
    return;
  }

  if (!window.confirm(`Delete pool group “${group.name}”?`)) {
    return;
  }

  try {
    const config = WTP.normalizeConfig(currentConfig);
    config.poolGroups = config.poolGroups.filter((item) => item.id !== groupId);
    currentConfig = await WTP.saveConfig(config);
    renderGroups();
    setMessage(`Deleted group “${group.name}”.`);
  } catch (error) {
    setMessage(error.message, { error: true });
  }
}

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  setMessage("Saving…");

  try {
    await saveCurrentConfig();
    setMessage("Saved. The active pool group is being kept warm now.");
  } catch (error) {
    setMessage(error.message, { error: true });
  } finally {
    saveButton.disabled = false;
  }
});

refillButton.addEventListener("click", async () => {
  refillButton.disabled = true;
  setMessage("Reconciling active pools…");
  try {
    await browser.runtime.sendMessage({ type: "reconcile" });
    setMessage("Pool sizes and warm-tab state reconciled.");
  } catch (error) {
    setMessage(error.message, { error: true });
  } finally {
    refillButton.disabled = false;
  }
});

shortcutSettingsButton.addEventListener("click", async () => {
  try {
    refreshShortcutsOnFocus = true;
    await browser.runtime.sendMessage({ type: "openShortcutSettings" });
  } catch (error) {
    setMessage(error.message, { error: true });
  }
});

createGroupButton.addEventListener("click", async () => {
  const name = newGroupNameInput.value.trim();
  if (!name) {
    setMessage("Enter a name for the new pool group.", { error: true });
    newGroupNameInput.focus();
    return;
  }

  if (
    currentConfig.poolGroups.some(
      (group) => group.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    setMessage("A pool group with that name already exists.", { error: true });
    return;
  }

  createGroupButton.disabled = true;
  setMessage("Creating pool group…");

  try {
    const pools = collectPools();
    const shortcuts = WTP.normalizeShortcuts(collectShortcutArray());
    const config = WTP.normalizeConfig(currentConfig);
    config.hideWarmTabs = hideWarmTabsInput.checked;
    config.muteWarmTabs = muteWarmTabsInput.checked;

    const group = {
      id: uniqueGroupId(name),
      name,
      pools,
      shortcuts,
    };
    config.poolGroups.push(group);
    config.activeGroupId = group.id;

    await applyShortcuts(group);
    currentConfig = await WTP.saveConfig(config);
    await browser.runtime.sendMessage({ type: "reconcile" });

    renderRows(WTP.activeGroup(currentConfig));
    renderGroups();
    newGroupNameInput.value = "";
    dirty = false;
    setMessage(`Created and loaded group “${name}”.`);
  } catch (error) {
    setMessage(error.message, { error: true });
  } finally {
    createGroupButton.disabled = false;
  }
});

exportConfigButton.addEventListener("click", () => {
  try {
    const config = collectDraftConfig();
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
    setMessage("Exported the complete configuration as JSON.");
  } catch (error) {
    setMessage(error.message, { error: true });
  }
});

importConfigButton.addEventListener("click", () => {
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
    const importedActive = WTP.activeGroup(imported);

    // Legacy version-1 exports had no shortcut data. Preserve the current
    // Firefox shortcuts instead of silently clearing them in that case.
    const hasShortcutData = Array.isArray(raw.poolGroups)
      ? raw.poolGroups.some((group) => Array.isArray(group?.shortcuts))
      : Array.isArray(raw.shortcuts);
    if (!hasShortcutData) {
      importedActive.shortcuts = shortcutArrayFromMap(await shortcutMap());
    }

    await applyShortcuts(importedActive);
    currentConfig = await WTP.saveConfig(imported);
    await browser.runtime.sendMessage({ type: "reconcile" });

    hideWarmTabsInput.checked = currentConfig.hideWarmTabs;
    muteWarmTabsInput.checked = currentConfig.muteWarmTabs;
    renderRows(WTP.activeGroup(currentConfig));
    renderGroups();
    dirty = false;
    setMessage("Imported configuration and loaded its active pool group.");
  } catch (error) {
    setMessage(`Import failed: ${error.message}`, { error: true });
  } finally {
    importFileInput.value = "";
    importConfigButton.disabled = false;
  }
});

for (const eventName of ["input", "change"]) {
  document.addEventListener(eventName, (event) => {
    if (
      event.target.closest("#poolRows")
      || event.target === hideWarmTabsInput
      || event.target === muteWarmTabsInput
    ) {
      dirty = true;
    }
  });
}

window.addEventListener("focus", async () => {
  if (!currentConfig || !refreshShortcutsOnFocus) {
    return;
  }
  refreshShortcutsOnFocus = false;

  try {
    const shortcuts = shortcutArrayFromMap(await shortcutMap());
    const active = WTP.activeGroup(currentConfig);
    active.shortcuts = shortcuts;

    for (const row of rowsElement.querySelectorAll("tr")) {
      const slot = Number(row.dataset.slot);
      row.querySelector(".pool-shortcut").value = shortcuts[slot - 1] ?? "";
    }
  } catch (error) {
    setMessage(`Could not refresh shortcuts: ${error.message}`, { error: true });
  }
});

void loadPage();
