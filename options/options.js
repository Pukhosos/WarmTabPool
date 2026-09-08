"use strict";

const rowsElement = document.querySelector("#poolRows");
const hideWarmTabsInput = document.querySelector("#hideWarmTabs");
const muteWarmTabsInput = document.querySelector("#muteWarmTabs");
const saveButton = document.querySelector("#save");
const refillButton = document.querySelector("#refill");
const shortcutSettingsButton = document.querySelector("#shortcutSettings");
const messageElement = document.querySelector("#message");

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

function renderRows(config, shortcuts) {
  rowsElement.replaceChildren();

  for (const pool of config.pools) {
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
    size.min = "1";
    size.max = String(WTP.MAX_POOL_SIZE);
    size.step = "1";
    sizeCell.append(size);

    const shortcutCell = document.createElement("td");
    shortcutCell.className = "shortcut-cell";
    const shortcut = createInput(
      "text",
      "pool-shortcut",
      shortcuts.get(WTP.commandName(pool.slot)) ?? "",
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

async function shortcutMap() {
  const commands = await browser.commands.getAll();
  return new Map(commands.map(
    (command) => [command.name, command.shortcut ?? ""])
  );
}

async function loadPage() {
  const [config, shortcuts] = await Promise.all(
    [WTP.loadConfig(), shortcutMap()]
  );
  hideWarmTabsInput.checked = config.hideWarmTabs;
  muteWarmTabsInput.checked = config.muteWarmTabs;
  renderRows(config, shortcuts);
}

function collectConfig() {
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

    if (!Number.isInteger(size) || size < 1 || size > WTP.MAX_POOL_SIZE) {
      sizeInput.classList.add("invalid");
      firstError ??= (
        `Pool ${slot}: size must be an integer from 1 to ${WTP.MAX_POOL_SIZE}.`
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
      size: Number.isInteger(size) ? size : 2,
    });
  }

  if (firstError) {
    throw new Error(firstError);
  }

  return {
    version: 1,
    hideWarmTabs: hideWarmTabsInput.checked,
    muteWarmTabs: muteWarmTabsInput.checked,
    pools,
  };
}

async function updateShortcuts(config) {
  const errors = [];

  for (const row of rowsElement.querySelectorAll("tr")) {
    const slot = Number(row.dataset.slot);
    const input = row.querySelector(".pool-shortcut");
    const shortcut = input.value.trim();
    const pool = config.pools[slot - 1];

    try {
      await browser.commands.update({
        name: WTP.commandName(slot),
        shortcut,
        description: `Warm Tab Pool: ${pool.name}`,
      });
    } catch (error) {
      input.classList.add("invalid");
      errors.push(`Pool ${slot}: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
}

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  setMessage("Saving…");

  try {
    const config = collectConfig();
    await updateShortcuts(config);
    await WTP.saveConfig(config);
    await browser.runtime.sendMessage({ type: "reconcile" });
    setMessage("Saved. Pools are being kept warm now.");
  } catch (error) {
    setMessage(error.message, { error: true });
  } finally {
    saveButton.disabled = false;
  }
});

refillButton.addEventListener("click", async () => {
  refillButton.disabled = true;
  setMessage("Checking pools…");
  try {
    await browser.runtime.sendMessage({ type: "reconcile" });
    setMessage("Pool sizes reconciled.");
  } catch (error) {
    setMessage(error.message, { error: true });
  } finally {
    refillButton.disabled = false;
  }
});

shortcutSettingsButton.addEventListener("click", async () => {
  try {
    await browser.runtime.sendMessage({ type: "openShortcutSettings" });
  } catch (error) {
    setMessage(error.message, { error: true });
  }
});

window.addEventListener("focus", async () => {
  const shortcuts = await shortcutMap();
  for (const row of rowsElement.querySelectorAll("tr")) {
    const slot = Number(row.dataset.slot);
    row.querySelector(".pool-shortcut").value = shortcuts.get(
      WTP.commandName(slot)
    ) ?? "";
  }
});

void loadPage();
