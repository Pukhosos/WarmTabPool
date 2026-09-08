"use strict";

const poolsElement = document.querySelector("#pools");
const refreshButton = document.querySelector("#refresh");
const refillButton = document.querySelector("#refill");
const optionsButton = document.querySelector("#options");

const AUTO_REFRESH_MS = 500;
let shortcuts = new Map();
let renderSignature = null;
let refreshInFlight = false;

function poolMeta(status) {
  const parts = [`${status.ready}/${status.size} ready`];
  if (status.loading > 0) {
    parts.push(`${status.loading} loading`);
  }
  if (status.discarded > 0) {
    parts.push(`${status.discarded} reloading`);
  }
  return parts.join(" · ");
}

function shortcutForSlot(slot) {
  return shortcuts.get(WTP.commandName(slot)) ?? "";
}

function signatureFor(enabled) {
  return enabled.map((status) => (
    `${status.slot}\u0000${status.name}\u0000${status.url}`
    + `\u0000${shortcutForSlot(status.slot)}`
  )).join("\u0001");
}

function updateMeta(enabled) {
  for (const status of enabled) {
    const row = poolsElement.querySelector(
      `.pool[data-slot="${status.slot}"]`,
    );
    if (row) {
      row.querySelector(".pool-meta").textContent = poolMeta(status);
    }
  }
}

function render(statuses) {
  const enabled = statuses.filter((status) => status.enabled);
  const signature = signatureFor(enabled);

  if (signature === renderSignature) {
    updateMeta(enabled);
    return;
  }

  renderSignature = signature;
  poolsElement.replaceChildren();

  if (enabled.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No pools are enabled yet. Open Settings to add one.";
    poolsElement.append(empty);
    return;
  }

  for (const status of enabled) {
    const row = document.createElement("section");
    row.className = "pool";
    row.dataset.slot = String(status.slot);

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "pool-name";
    name.textContent = status.name;
    name.title = status.url;

    const meta = document.createElement("div");
    meta.className = "pool-meta";
    meta.textContent = poolMeta(status);

    info.append(name, meta);

    const controls = document.createElement("div");
    controls.className = "take-controls";

    const shortcut = shortcutForSlot(status.slot);
    if (shortcut) {
      const shortcutLabel = document.createElement("kbd");
      shortcutLabel.className = "shortcut";
      shortcutLabel.textContent = shortcut;
      shortcutLabel.title = "Keyboard shortcut";
      controls.append(shortcutLabel);
    }

    const take = document.createElement("button");
    take.className = "take";
    take.type = "button";
    take.textContent = "Take";
    const warmCandidate = () => {
      void browser.runtime.sendMessage(
        { type: "warm", slot: status.slot }
      ).catch(() => {});
    };
    take.addEventListener("mouseenter", warmCandidate, { once: true });
    take.addEventListener("focus", warmCandidate, { once: true });

    take.addEventListener("click", async () => {
      take.disabled = true;
      try {
        await browser.runtime.sendMessage({ type: "take", slot: status.slot });
        window.close();
      } catch (error) {
        take.disabled = false;
        meta.textContent = `Error: ${error.message}`;
      }
    });

    controls.append(take);
    row.append(info, controls);
    poolsElement.append(row);
  }
}

async function loadShortcuts() {
  const commands = await browser.commands.getAll();
  shortcuts = new Map(commands.map(
    (command) => [command.name, command.shortcut ?? ""]
  ));
}

async function refresh({ reconcile = false, indicate = false } = {}) {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;
  if (indicate) {
    refreshButton.disabled = true;
  }

  try {
    const statuses = await browser.runtime.sendMessage(
      { type: "getStatus", reconcile }
    );
    render(statuses);
  } catch (error) {
    renderSignature = null;
    poolsElement.textContent = `Could not read pool status: ${error.message}`;
  } finally {
    if (indicate) {
      refreshButton.disabled = false;
    }
    refreshInFlight = false;
  }
}

refreshButton.addEventListener("click", () => {
  void refresh({ indicate: true });
});

refillButton.addEventListener("click", async () => {
  refillButton.disabled = true;
  try {
    const statuses = await browser.runtime.sendMessage({ type: "reconcile" });
    render(statuses);
  } catch (error) {
    renderSignature = null;
    poolsElement.textContent = `Could not refill pools: ${error.message}`;
  } finally {
    refillButton.disabled = false;
  }
});

optionsButton.addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
  window.close();
});

async function start() {
  try {
    await loadShortcuts();
  } catch {
    shortcuts = new Map();
  }

  await refresh({ reconcile: true, indicate: true });
  window.setInterval(() => void refresh(), AUTO_REFRESH_MS);
}

void start();
