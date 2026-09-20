"use strict";

const poolsElement = document.querySelector("#pools");
const groupsElement = document.querySelector("#groups");
const groupMessage = document.querySelector("#groupMessage");
const multiModeElement = document.querySelector("#multiMode");
const enabledInput = document.querySelector("#enabled");
const enabledLabel = document.querySelector("#enabledLabel");
const optionsButton = document.querySelector("#options");

const STATUS_POLL_MS = 500;
let shortcuts = new Map();
let poolRenderSignature = null;
let groupRenderSignature = null;
let stateUpdateInFlight = false;
let interactionInFlight = false;

function setGroupMessage(text, { error = false } = {}) {
  groupMessage.textContent = text;
  groupMessage.classList.toggle("error", error);
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

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

function groupSignatureFor(state) {
  return [
    state.allowMultipleGroups,
    state.warmTabCount,
    interactionInFlight,
    ...state.groups.map((group) => (
      `${group.id}\u0000${group.name}\u0000${group.active}`
      + `\u0000${group.loadError}\u0000${group.poolCount}\u0000${group.warmTabCount}`
    )),
  ].join("\u0001");
}

function poolSignatureFor(state) {
  return [
    state.enabled,
    ...state.activeGroupIds,
    ...state.statuses.map((status) => (
      `${status.commandSlot}\u0000${status.groupId}\u0000${status.poolId}`
      + `\u0000${status.name}\u0000${status.url}\u0000${status.enabled}`
      + `\u0000${shortcutForSlot(status.commandSlot)}`
    )),
  ].join("\u0001");
}

function renderGroups(state) {
  const warmTabText = `${state.warmTabCount} ${state.warmTabCount === 1 ? "tab" : "tabs"} kept warm`;
  multiModeElement.textContent = `${state.activePoolCount} of ${state.maxActivePools} shortcut slots used · ${warmTabText}`;

  const signature = groupSignatureFor(state);
  if (signature === groupRenderSignature) {
    return;
  }
  groupRenderSignature = signature;
  groupsElement.replaceChildren();

  if (state.groups.length === 0) {
    if (!groupMessage.classList.contains("error")) {
      setGroupMessage("No groups. Create one in Settings.");
    }
    return;
  }

  if (!groupMessage.classList.contains("error")) {
    setGroupMessage("");
  }

  for (const group of state.groups) {
    const row = document.createElement("div");
    row.className = "group-row";

    const info = document.createElement("div");
    info.className = "group-info";
    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = group.name;
    name.title = group.name;
    const meta = document.createElement("span");
    meta.className = "group-meta";
    meta.textContent = `${countLabel(group.poolCount, "pool")} · ${countLabel(group.warmTabCount, "warm tab")}`;
    info.append(name, meta);

    const stateControls = document.createElement("div");
    stateControls.className = "group-state-controls";
    if (!group.active && group.loadError) {
      const warning = document.createElement("span");
      warning.className = "group-load-warning";
      warning.textContent = "!";
      warning.title = group.loadError;
      warning.setAttribute("role", "img");
      warning.setAttribute("aria-label", `Cannot load ${group.name}: ${group.loadError}`);
      stateControls.append(warning);
    }

    const label = document.createElement("label");
    label.className = "group-switch";
    label.title = group.active ? `Unload ${group.name}` : `Load ${group.name}`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = group.active;
    input.disabled = interactionInFlight;
    input.setAttribute("aria-label", `${group.active ? "Unload" : "Load"} ${group.name}`);
    const switchVisual = document.createElement("span");
    switchVisual.className = "switch";
    switchVisual.setAttribute("aria-hidden", "true");
    label.append(input, switchVisual);
    stateControls.append(label);

    input.addEventListener("change", async () => {
      const wanted = input.checked;
      interactionInFlight = true;
      input.disabled = true;
      enabledInput.disabled = true;
      setGroupMessage("");
      try {
        const nextState = await browser.runtime.sendMessage({
          type: "setGroupActive",
          groupId: group.id,
          active: wanted,
        });
        await loadShortcuts().catch(() => {});
        poolRenderSignature = null;
        groupRenderSignature = null;
        render(nextState);
      } catch (error) {
        input.checked = !wanted;
        setGroupMessage(error.message, { error: true });
        await updateState();
      } finally {
        interactionInFlight = false;
        enabledInput.disabled = false;
        groupsElement.querySelectorAll("input").forEach((candidate) => {
          candidate.disabled = false;
        });
        groupRenderSignature = null;
      }
    });

    row.append(info, stateControls);
    groupsElement.append(row);
  }
}

function updatePoolMeta(state) {
  for (const status of state.statuses) {
    const row = poolsElement.querySelector(
      `.pool[data-command-slot="${status.commandSlot}"]`,
    );
    if (row) {
      row.querySelector(".pool-meta").textContent = poolMeta(status);
    }
  }
}

function renderPools(state) {
  if (!state.enabled) {
    if (poolRenderSignature !== "off") {
      poolRenderSignature = "off";
      poolsElement.replaceChildren();
      const off = document.createElement("div");
      off.className = "off";
      off.textContent = "Warm Tab Pool is off. Turn it on to resume the active groups.";
      poolsElement.append(off);
    }
    return;
  }

  const signature = poolSignatureFor(state);
  if (signature === poolRenderSignature) {
    updatePoolMeta(state);
    return;
  }
  poolRenderSignature = signature;
  poolsElement.replaceChildren();

  if (state.activeGroupIds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No groups are active.";
    poolsElement.append(empty);
    return;
  }

  const statusesByGroup = new Map();
  for (const status of state.statuses) {
    if (!statusesByGroup.has(status.groupId)) {
      statusesByGroup.set(status.groupId, []);
    }
    statusesByGroup.get(status.groupId).push(status);
  }

  const groupById = new Map(state.groups.map((group) => [group.id, group]));
  for (const groupId of state.activeGroupIds) {
    const group = groupById.get(groupId);
    if (!group) {
      continue;
    }
    const section = document.createElement("section");
    section.className = "active-group";
    const heading = document.createElement("div");
    heading.className = "active-group-heading";
    heading.textContent = group.name;
    section.append(heading);

    const enabledStatuses = (statusesByGroup.get(groupId) ?? [])
      .filter((status) => status.enabled);
    if (enabledStatuses.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No enabled pools.";
      section.append(empty);
    }

    for (const status of enabledStatuses) {
      const row = document.createElement("div");
      row.className = "pool";
      row.dataset.commandSlot = String(status.commandSlot);

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
      const shortcut = shortcutForSlot(status.commandSlot);
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
        void browser.runtime.sendMessage({
          type: "warm",
          slot: status.commandSlot,
        }).catch(() => {});
      };
      take.addEventListener("mouseenter", warmCandidate, { once: true });
      take.addEventListener("focus", warmCandidate, { once: true });
      take.addEventListener("click", async () => {
        take.disabled = true;
        try {
          const result = await browser.runtime.sendMessage({
            type: "take",
            slot: status.commandSlot,
          });
          if (result?.ignored && result.reason === "cooldown") {
            take.disabled = false;
            meta.textContent = `Ignored · cooldown (${result.remainingMs} ms remaining)`;
            return;
          }
          window.close();
        } catch (error) {
          take.disabled = false;
          meta.textContent = `Error: ${error.message}`;
        }
      });

      controls.append(take);
      row.append(info, controls);
      section.append(row);
    }
    poolsElement.append(section);
  }
}

function render(state) {
  enabledInput.checked = state.enabled;
  enabledInput.disabled = interactionInFlight;
  enabledLabel.textContent = state.enabled ? "On" : "Off";
  renderGroups(state);
  renderPools(state);
}

async function loadShortcuts() {
  const commands = await browser.commands.getAll();
  shortcuts = new Map(commands.map(
    (command) => [command.name, command.shortcut ?? ""],
  ));
}

async function updateState({ reloadShortcuts = false } = {}) {
  if (stateUpdateInFlight || interactionInFlight) {
    return;
  }
  stateUpdateInFlight = true;

  try {
    if (reloadShortcuts) {
      await loadShortcuts().catch(() => {});
    }
    const state = await browser.runtime.sendMessage({
      type: "getPopupState",
    });
    render(state);
  } catch (error) {
    poolRenderSignature = null;
    poolsElement.textContent = `Could not read pool status: ${error.message}`;
  } finally {
    stateUpdateInFlight = false;
  }
}

enabledInput.addEventListener("change", async () => {
  interactionInFlight = true;
  enabledInput.disabled = true;
  try {
    const state = await browser.runtime.sendMessage({
      type: "setEnabled",
      enabled: enabledInput.checked,
    });
    poolRenderSignature = null;
    groupRenderSignature = null;
    render(state);
  } catch (error) {
    enabledInput.checked = !enabledInput.checked;
    poolsElement.textContent = `Could not change state: ${error.message}`;
  } finally {
    interactionInFlight = false;
    enabledInput.disabled = false;
    groupsElement.querySelectorAll("input").forEach((candidate) => {
      candidate.disabled = false;
    });
    groupRenderSignature = null;
  }
});

optionsButton.addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
  window.close();
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[WTP.CONFIG_KEY]) {
    poolRenderSignature = null;
    groupRenderSignature = null;
    void updateState({ reloadShortcuts: true });
  }
});

async function start() {
  try {
    await loadShortcuts();
  } catch {
    shortcuts = new Map();
  }
  await updateState();
  window.setInterval(() => void updateState(), STATUS_POLL_MS);
}

void start();
