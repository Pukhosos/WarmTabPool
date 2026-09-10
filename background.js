"use strict";

const OWNER = "warm-tab-pool";
let operationQueue = Promise.resolve();
let reconcileTimer = null;
const knownPoolTabIds = new Set();

function serialized(task) {
  const next = operationQueue.then(task, task);
  operationQueue = next.catch((error) => {
    console.error("Warm Tab Pool operation failed:", error);
  });
  return next;
}

function scheduleReconcile(delayMs = 150) {
  if (reconcileTimer !== null) {
    clearTimeout(reconcileTimer);
  }
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void serialized(reconcilePools);
  }, delayMs);
}

async function getTargetWindowId() {
  const activeTabs = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return activeTabs[0]?.windowId;
}

async function readMembership(tabId) {
  try {
    const value = await browser.sessions.getTabValue(tabId, WTP.TAB_VALUE_KEY);
    if (!value || value.owner !== OWNER) {
      return null;
    }

    // Accept v1 solely so old warm tabs can be discovered and removed during
    // migration. New tabs always receive v2 membership with group/pool IDs.
    if (
      value.version === 1
      && Number.isInteger(value.slot)
      && typeof value.url === "string"
    ) {
      return value;
    }

    if (
      value.version === WTP.TAB_VALUE_VERSION
      && typeof value.groupId === "string"
      && typeof value.poolId === "string"
      && typeof value.url === "string"
    ) {
      return value;
    }
  } catch {
    // The tab may have disappeared between query and lookup.
  }
  return null;
}

async function taggedTabs() {
  const tabs = await browser.tabs.query({});
  const liveIds = new Set(
    tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id)),
  );
  for (const tabId of [...knownPoolTabIds]) {
    if (!liveIds.has(tabId)) {
      knownPoolTabIds.delete(tabId);
    }
  }

  const tagged = await Promise.all(
    tabs.map(async (tab) => {
      if (!Number.isInteger(tab.id)) {
        return null;
      }
      const membership = await readMembership(tab.id);
      if (membership) {
        knownPoolTabIds.add(tab.id);
        return { tab, membership };
      }
      return null;
    }),
  );

  return tagged.filter(Boolean);
}

function isReady(tab) {
  return tab.status === "complete" && tab.discarded !== true;
}

function candidateOrder(left, right) {
  const leftReady = isReady(left.tab) ? 0 : left.tab.discarded ? 2 : 1;
  const rightReady = isReady(right.tab) ? 0 : right.tab.discarded ? 2 : 1;
  if (leftReady !== rightReady) {
    return leftReady - rightReady;
  }
  return (left.membership.createdAt ?? 0) - (right.membership.createdAt ?? 0);
}

function membershipMatches(membership, assignment) {
  return (
    membership.version === WTP.TAB_VALUE_VERSION
    && membership.groupId === assignment.group.id
    && membership.poolId === assignment.pool.id
    && membership.url === assignment.pool.url
  );
}

async function markAsNormalTab(tabId) {
  knownPoolTabIds.delete(tabId);
  try {
    await browser.sessions.removeTabValue(tabId, WTP.TAB_VALUE_KEY);
  } catch {
    // Tab may already be gone.
  }
  try {
    await browser.tabs.update(tabId, {
      autoDiscardable: true,
      muted: false,
    });
  } catch {
    // Tab may already be gone.
  }
}

async function createWarmTab(assignment, config, preferredWindowId = undefined) {
  const { group, pool } = assignment;
  const createProperties = {
    url: pool.url,
    active: false,
    pinned: false,
    muted: config.muteWarmTabs,
  };
  if (Number.isInteger(preferredWindowId)) {
    createProperties.windowId = preferredWindowId;
  }

  const tab = await browser.tabs.create(createProperties);
  if (!Number.isInteger(tab.id)) {
    throw new Error(`Firefox did not return an ID for ${group.name} / ${pool.name}`);
  }

  await browser.sessions.setTabValue(tab.id, WTP.TAB_VALUE_KEY, {
    owner: OWNER,
    version: WTP.TAB_VALUE_VERSION,
    groupId: group.id,
    poolId: pool.id,
    url: pool.url,
    createdAt: Date.now(),
  });
  knownPoolTabIds.add(tab.id);

  await browser.tabs.update(tab.id, { autoDiscardable: false });
  if (config.hideWarmTabs) {
    try {
      await browser.tabs.hide(tab.id);
    } catch (error) {
      console.warn(`Could not hide warm tab ${tab.id}:`, error);
    }
  }
  return tab;
}

async function removeTabs(entries) {
  const ids = entries
    .map((entry) => entry.tab.id)
    .filter((id) => Number.isInteger(id));
  if (ids.length === 0) {
    return;
  }

  for (const id of ids) {
    knownPoolTabIds.delete(id);
  }

  try {
    await browser.tabs.remove(ids);
  } catch (error) {
    await Promise.all(ids.map(async (id) => {
      try {
        await browser.tabs.remove(id);
      } catch {
        // Already gone.
      }
    }));
    console.debug("Bulk pool cleanup needed a per-tab fallback:", error);
  }
}

async function normalizeExistingWarmTab(entry, config) {
  const { tab } = entry;
  if (!Number.isInteger(tab.id)) {
    return "gone";
  }

  if (tab.active) {
    await markAsNormalTab(tab.id);
    return "consumed";
  }

  try {
    await browser.tabs.update(tab.id, {
      autoDiscardable: false,
      muted: config.muteWarmTabs,
    });

    if (config.hideWarmTabs && !tab.hidden) {
      await browser.tabs.hide(tab.id);
    } else if (!config.hideWarmTabs && tab.hidden) {
      await browser.tabs.show(tab.id);
    }

    if (tab.discarded) {
      await browser.tabs.reload(tab.id);
    }
  } catch (error) {
    console.warn(`Could not normalize warm tab ${tab.id}:`, error);
    return "gone";
  }

  return "kept";
}

async function reconcilePools() {
  const config = await WTP.loadConfig();
  let entries = await taggedTabs();
  const assignments = WTP.activePoolAssignments(config);
  const enabledAssignments = config.enabled
    ? assignments.filter(({ pool }) => pool.enabled && pool.url)
    : [];

  const invalid = entries.filter(({ membership }) => (
    !enabledAssignments.some((assignment) => membershipMatches(membership, assignment))
  ));
  await removeTabs(invalid);

  if (!config.enabled) {
    return;
  }

  entries = entries.filter((entry) => !invalid.includes(entry));
  const preferredWindowId = await getTargetWindowId();

  for (const assignment of enabledAssignments) {
    const { pool } = assignment;
    let candidates = entries
      .filter(({ membership }) => membershipMatches(membership, assignment))
      .sort(candidateOrder);

    const normalized = [];
    for (const entry of candidates) {
      const result = await normalizeExistingWarmTab(entry, config);
      if (result === "kept") {
        normalized.push(entry);
      }
    }
    candidates = normalized.sort(candidateOrder);

    if (candidates.length > pool.size) {
      const extras = candidates.slice(pool.size);
      await removeTabs(extras);
      candidates = candidates.slice(0, pool.size);
    }

    while (candidates.length < pool.size) {
      const tab = await createWarmTab(assignment, config, preferredWindowId);
      candidates.push({
        tab,
        membership: {
          owner: OWNER,
          version: WTP.TAB_VALUE_VERSION,
          groupId: assignment.group.id,
          poolId: pool.id,
          url: pool.url,
          createdAt: Date.now(),
        },
      });
    }
  }
}

function statusForAssignment(config, entries, assignment) {
  const { commandSlot, group, pool } = assignment;
  const candidates = config.enabled
    ? entries.filter(({ membership }) => membershipMatches(membership, assignment))
    : [];

  return {
    commandSlot,
    groupId: group.id,
    groupName: group.name,
    poolId: pool.id,
    slot: pool.slot,
    enabled: pool.enabled,
    name: pool.name,
    url: pool.url,
    size: pool.size,
    ready: candidates.filter(({ tab }) => isReady(tab)).length,
    loading: candidates.filter(
      ({ tab }) => tab.status !== "complete" && !tab.discarded,
    ).length,
    discarded: candidates.filter(({ tab }) => tab.discarded).length,
    total: candidates.length,
  };
}

function snapshotFrom(config, entries) {
  return WTP.activePoolAssignments(config).map(
    (assignment) => statusForAssignment(config, entries, assignment),
  );
}

async function statusSnapshot({ reconcile = false } = {}) {
  if (reconcile) {
    await reconcilePools();
  }
  const config = await WTP.loadConfig();
  const entries = await taggedTabs();
  return snapshotFrom(config, entries);
}

async function popupState({ reconcile = false } = {}) {
  if (reconcile) {
    await reconcilePools();
  }
  const config = await WTP.loadConfig();
  const entries = await taggedTabs();
  const activeIds = new Set(config.activeGroupIds);

  return {
    enabled: config.enabled,
    allowMultipleGroups: config.allowMultipleGroups,
    maxActivePools: WTP.MAX_POOLS,
    activeGroupIds: [...config.activeGroupIds],
    groups: config.poolGroups.map((group) => ({
      id: group.id,
      name: group.name,
      active: activeIds.has(group.id),
      poolCount: group.pools.length,
      warmTabCount: group.pools.reduce(
        (total, pool) => total + (pool.enabled ? pool.size : 0),
        0,
      ),
    })),
    statuses: snapshotFrom(config, entries),
  };
}

async function replenishOnePool(assignment, config) {
  if (!config.enabled || !assignment.pool.enabled || !assignment.pool.url) {
    return;
  }
  const entries = await taggedTabs();
  const existing = entries.filter(({ membership }) => (
    membershipMatches(membership, assignment)
  ));
  const preferredWindowId = await getTargetWindowId();
  for (let count = existing.length; count < assignment.pool.size; count += 1) {
    await createWarmTab(assignment, config, preferredWindowId);
  }
}

async function warmBestCandidate(commandSlot) {
  const config = await WTP.loadConfig();
  if (!config.enabled) {
    return false;
  }
  const assignment = WTP.assignmentForCommandSlot(config, commandSlot);
  if (!assignment?.pool.enabled) {
    return false;
  }

  const candidate = (await taggedTabs())
    .filter(({ membership, tab }) => (
      membershipMatches(membership, assignment) && !tab.discarded
    ))
    .sort(candidateOrder)[0];

  if (!candidate || !Number.isInteger(candidate.tab.id)) {
    return false;
  }
  try {
    await browser.tabs.warmup(candidate.tab.id);
    return true;
  } catch {
    return false;
  }
}

async function takeFromPool(commandSlot) {
  const config = await WTP.loadConfig();
  if (!config.enabled) {
    throw new Error("Warm Tab Pool is turned off");
  }

  const assignment = WTP.assignmentForCommandSlot(config, commandSlot);
  if (!assignment || !assignment.pool.enabled) {
    throw new Error(`Active pool slot ${commandSlot} is disabled or unused`);
  }

  const { pool } = assignment;
  const url = WTP.normalizeHttpUrl(pool.url);
  if (url !== pool.url) {
    pool.url = url;
  }

  const entries = (await taggedTabs())
    .filter(({ membership }) => membershipMatches(membership, assignment))
    .sort(candidateOrder);

  const candidate = entries[0] ?? null;
  const targetWindowId = await getTargetWindowId();

  if (!candidate) {
    const properties = { url: pool.url, active: true };
    if (Number.isInteger(targetWindowId)) {
      properties.windowId = targetWindowId;
    }
    await browser.tabs.create(properties);
    await replenishOnePool(assignment, config);
    return { warm: false, reason: "empty" };
  }

  const tabId = candidate.tab.id;
  const warm = isReady(candidate.tab);
  knownPoolTabIds.delete(tabId);
  await browser.sessions.removeTabValue(tabId, WTP.TAB_VALUE_KEY);

  if (Number.isInteger(targetWindowId) && candidate.tab.windowId !== targetWindowId) {
    try {
      await browser.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
    } catch (error) {
      console.warn(`Could not move warm tab ${tabId} to the focused window:`, error);
    }
  }

  try {
    await browser.tabs.show(tabId);
  } catch {
    // It may already be visible.
  }

  await browser.tabs.update(tabId, {
    active: true,
    autoDiscardable: true,
    muted: false,
  });
  await replenishOnePool(assignment, config);

  return {
    warm,
    reason: warm ? "ready" : candidate.tab.discarded ? "discarded" : "loading",
  };
}

async function shortcutMap() {
  const commands = await browser.commands.getAll();
  return new Map(commands.map(
    (command) => [command.name, command.shortcut ?? ""],
  ));
}

async function applyShortcuts(config) {
  WTP.assertActiveConfiguration(config);
  const assignments = WTP.activePoolAssignments(config);
  const before = await shortcutMap();

  try {
    for (let commandSlot = 1; commandSlot <= WTP.MAX_POOLS; commandSlot += 1) {
      const assignment = assignments[commandSlot - 1] ?? null;
      await browser.commands.update({
        name: WTP.commandName(commandSlot),
        shortcut: assignment ? assignment.shortcut : "",
        description: assignment
          ? `Warm Tab Pool: ${assignment.group.name} / ${assignment.pool.name}`
          : `Warm Tab Pool: unused slot ${commandSlot}`,
      });
    }
  } catch (error) {
    await Promise.allSettled(
      Array.from({ length: WTP.MAX_POOLS }, (_, index) => {
        const commandSlot = index + 1;
        return browser.commands.update({
          name: WTP.commandName(commandSlot),
          shortcut: before.get(WTP.commandName(commandSlot)) ?? "",
        });
      }),
    );
    throw error;
  }
}

async function syncActiveGroups() {
  const config = await WTP.loadConfig();
  WTP.assertActiveConfiguration(config);
  await applyShortcuts(config);
  await reconcilePools();
  return popupState();
}

async function saveConfigAndSync(rawConfig) {
  const config = WTP.normalizeConfig(rawConfig);
  WTP.assertActiveConfiguration(config);
  await applyShortcuts(config);
  const saved = await WTP.saveConfig(config);
  await reconcilePools();
  return { config: saved, state: await popupState() };
}

async function setGroupActive(groupId, active) {
  const config = await WTP.loadConfig();
  const group = WTP.groupById(config, groupId);
  if (!group) {
    throw new Error("That pool group no longer exists");
  }

  const activeIds = new Set(config.activeGroupIds);
  if (active) {
    if (config.allowMultipleGroups) {
      activeIds.add(groupId);
    } else {
      activeIds.clear();
      activeIds.add(groupId);
    }
  } else {
    activeIds.delete(groupId);
  }
  config.activeGroupIds = config.poolGroups
    .map((candidate) => candidate.id)
    .filter((id) => activeIds.has(id));

  WTP.assertActiveConfiguration(config);
  await applyShortcuts(config);
  await WTP.saveConfig(config);
  await reconcilePools();
  return popupState();
}

async function setEnabled(enabled) {
  const config = await WTP.loadConfig();
  config.enabled = Boolean(enabled);
  await WTP.saveConfig(config);
  await reconcilePools();
  return popupState();
}

browser.commands.onCommand.addListener((command) => {
  const match = /^take-pool-(\d+)$/.exec(command);
  if (!match) {
    return;
  }
  void serialized(() => takeFromPool(Number(match[1])));
});

browser.runtime.onInstalled.addListener(() => {
  void serialized(syncActiveGroups);
});

browser.runtime.onStartup.addListener(() => {
  void serialized(syncActiveGroups);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[WTP.CONFIG_KEY]) {
    scheduleReconcile();
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (knownPoolTabIds.delete(tabId)) {
    scheduleReconcile();
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.discarded === true && knownPoolTabIds.has(tabId)) {
    scheduleReconcile(100);
  }
});

browser.tabs.onReplaced.addListener(() => {
  scheduleReconcile();
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  void serialized(async () => {
    const membership = await readMembership(tabId);
    if (!membership) {
      return;
    }

    const config = await WTP.loadConfig();
    await markAsNormalTab(tabId);
    if (membership.version !== WTP.TAB_VALUE_VERSION || !config.enabled) {
      return;
    }

    const assignment = WTP.assignmentForPool(
      config,
      membership.groupId,
      membership.poolId,
    );
    if (assignment?.pool.enabled && assignment.pool.url === membership.url) {
      await replenishOnePool(assignment, config);
    }
  });
});

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "getStatus") {
    return serialized(() => statusSnapshot({ reconcile: Boolean(message.reconcile) }));
  }
  if (message.type === "getPopupState") {
    return serialized(() => popupState({ reconcile: Boolean(message.reconcile) }));
  }
  if (message.type === "take") {
    return serialized(() => takeFromPool(Number(message.slot)));
  }
  if (message.type === "warm") {
    return serialized(() => warmBestCandidate(Number(message.slot)));
  }
  if (message.type === "reconcile") {
    return serialized(async () => {
      await reconcilePools();
      return popupState();
    });
  }
  if (message.type === "syncActiveGroups" || message.type === "syncActiveGroup") {
    return serialized(syncActiveGroups);
  }
  if (message.type === "saveConfigAndSync") {
    return serialized(() => saveConfigAndSync(message.config));
  }
  if (message.type === "setGroupActive") {
    return serialized(() => setGroupActive(
      String(message.groupId ?? ""),
      Boolean(message.active),
    ));
  }
  // Backward-compatible message name from v1.2 popup: activating replaces the
  // active set only when multi-group mode is disabled; otherwise it adds.
  if (message.type === "activateGroup") {
    return serialized(() => setGroupActive(String(message.groupId ?? ""), true));
  }
  if (message.type === "setEnabled") {
    return serialized(() => setEnabled(Boolean(message.enabled)));
  }
  if (message.type === "openShortcutSettings") {
    return browser.commands.openShortcutSettings();
  }
  return undefined;
});

// Event pages can start for reasons other than startup/install. Reconcile even
// if shortcut synchronization fails, so stale v1 warm tabs are still cleaned.
void serialized(async () => {
  try {
    await syncActiveGroups();
  } catch (error) {
    console.error("Could not synchronize active pool shortcuts:", error);
    await reconcilePools();
  }
});
