"use strict";

const OWNER = "warm-tab-pool";
const BROWSER_SESSION_KEY = "warm-tab-pool:browser-session-id";
const STARTUP_RESTORE_GRACE_MS = 1000;
const STARTUP_RESTORE_WATCH_MS = 5000;
let operationQueue = Promise.resolve();
let reconcileTimer = null;
let configSyncTimer = null;
let lifecycleSyncScheduled = false;
let startupRestoreGraceActive = false;
let startupRestoreWatchUntil = 0;
let runtimeHandoffCooldownMs = WTP.DEFAULT_HANDOFF_COOLDOWN_MS;
let handoffCooldownUntil = -Infinity;
let positiveCooldownTakeInFlight = false;
let runtimeTakeSettingsReady = null;
let browserSessionIdPromise = null;
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

function scheduleConfigSync(delayMs = 50) {
  if (configSyncTimer !== null) {
    clearTimeout(configSyncTimer);
  }
  configSyncTimer = setTimeout(() => {
    configSyncTimer = null;
    void serialized(syncSavedConfiguration);
  }, delayMs);
}

function updateRuntimeTakeSettings(config) {
  runtimeHandoffCooldownMs = config.handoffCooldownEnabled
    ? WTP.clampHandoffCooldown(config.handoffCooldownMs)
    : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLoadPacer(delayMs) {
  const normalizedDelayMs = WTP.clampStartupLoadDelay(delayMs);
  let lastLoadStartedAt = -Infinity;

  return async () => {
    const now = performance.now();
    const waitMs = Math.ceil(lastLoadStartedAt + normalizedDelayMs - now);
    if (Number.isFinite(lastLoadStartedAt) && waitMs > 0) {
      await delay(waitMs);
    }
    lastLoadStartedAt = performance.now();
  };
}

function currentBrowserSessionId() {
  if (browserSessionIdPromise) {
    return browserSessionIdPromise;
  }

  browserSessionIdPromise = (async () => {
    const sessionStorage = browser.storage?.session;
    if (!sessionStorage) {
      return `background-${crypto.randomUUID()}`;
    }
    try {
      const stored = await sessionStorage.get(BROWSER_SESSION_KEY);
      const existing = stored?.[BROWSER_SESSION_KEY];
      if (typeof existing === "string" && existing) {
        return existing;
      }

      const created = crypto.randomUUID();
      await sessionStorage.set({ [BROWSER_SESSION_KEY]: created });
      return created;
    } catch (error) {
      console.warn("Could not use browser-session storage for warm-tab restoration:", error);
      return `background-${crypto.randomUUID()}`;
    }
  })();
  return browserSessionIdPromise;
}

async function requestTake(commandSlot) {
  const invokedAt = performance.now();
  await runtimeTakeSettingsReady;

  if (runtimeHandoffCooldownMs > 0) {
    const coolingDown = invokedAt < handoffCooldownUntil;
    if (positiveCooldownTakeInFlight || coolingDown) {
      const remainingMs = coolingDown
        ? Math.max(1, Math.ceil(handoffCooldownUntil - invokedAt))
        : runtimeHandoffCooldownMs;
      return {
        ignored: true,
        reason: "cooldown",
        cooldownMs: runtimeHandoffCooldownMs,
        remainingMs,
      };
    }
    // Do not let a rapid repeat wait in the serialized queue while the first
    // handoff is still being prepared. It is discarded at invocation time.
    positiveCooldownTakeInFlight = true;
  }

  try {
    return await serialized(() => takeFromPool(commandSlot));
  } finally {
    positiveCooldownTakeInFlight = false;
  }
}

function beginHandoffCooldown() {
  handoffCooldownUntil = runtimeHandoffCooldownMs > 0
    ? performance.now() + runtimeHandoffCooldownMs
    : -Infinity;
  // The handoff itself has happened, so the pre-handoff gate is no longer
  // needed. Later requests are governed only by the configured deadline;
  // requests after that deadline may wait behind normal background cleanup.
  positiveCooldownTakeInFlight = false;
}

runtimeTakeSettingsReady = WTP.loadConfig()
  .then((config) => updateRuntimeTakeSettings(config))
  .catch((error) => {
    console.warn("Could not preload tab handoff settings; using defaults:", error);
  });

async function getTargetActiveTab() {
  const activeTabs = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return activeTabs[0] ?? null;
}

async function getTargetWindowId() {
  return (await getTargetActiveTab())?.windowId;
}

async function handoffInsertionIndex(activeTab, candidateTab, direction) {
  if (!activeTab || !Number.isInteger(activeTab.windowId)) {
    return -1;
  }

  const tabs = (await browser.tabs.query({ windowId: activeTab.windowId }))
    .filter((tab) => tab.id !== candidateTab?.id)
    .sort((left, right) => left.index - right.index);
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTab.id);
  if (activeIndex < 0) {
    return -1;
  }

  const requestedIndex = direction === "left" ? activeIndex : activeIndex + 1;
  const firstUnpinnedIndex = tabs.findIndex((tab) => !tab.pinned);
  const legalStart = firstUnpinnedIndex < 0 ? tabs.length : firstUnpinnedIndex;

  // Pooled tabs are intentionally unpinned. Firefox cannot place an unpinned
  // tab inside the pinned region, so use the nearest legal position there.
  return Math.max(requestedIndex, legalStart);
}

async function moveWarmTabForHandoff(tabId, candidateTab, activeTab, direction) {
  if (!activeTab || !Number.isInteger(activeTab.windowId)) {
    return;
  }

  const index = await handoffInsertionIndex(activeTab, candidateTab, direction);
  const moveProperties = {
    windowId: activeTab.windowId,
    index,
  };
  try {
    const moved = await browser.tabs.move(tabId, moveProperties);
    if (Array.isArray(moved) && moved.length === 0) {
      throw new Error("Firefox did not move the tab to the requested position");
    }
  } catch (error) {
    console.warn(`Could not place warm tab ${tabId} next to the current tab:`, error);
    if (candidateTab.windowId !== activeTab.windowId) {
      try {
        await browser.tabs.move(tabId, { windowId: activeTab.windowId, index: -1 });
      } catch (fallbackError) {
        console.warn(`Could not move warm tab ${tabId} to the focused window:`, fallbackError);
      }
    }
  }
}

async function createColdHandoffTab(url, activeTab, direction) {
  const properties = { url, active: true };
  if (activeTab && Number.isInteger(activeTab.windowId)) {
    properties.windowId = activeTab.windowId;
    properties.index = await handoffInsertionIndex(activeTab, null, direction);
  }
  try {
    return await browser.tabs.create(properties);
  } catch (error) {
    if (!Number.isInteger(properties.windowId)) {
      throw error;
    }
    console.warn("Could not create the cold fallback next to the current tab:", error);
    return browser.tabs.create({ url, active: true });
  }
}

async function readMembership(tabId) {
  try {
    const value = await browser.sessions.getTabValue(tabId, WTP.TAB_VALUE_KEY);
    if (!value || value.owner !== OWNER) {
      return null;
    }

    if (
      [WTP.LEGACY_TAB_VALUE_VERSION, WTP.TAB_VALUE_VERSION].includes(value.version)
      && typeof value.groupId === "string"
      && typeof value.poolId === "string"
      && typeof value.url === "string"
    ) {
      return {
        ...value,
        sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
      };
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
    membership.groupId === assignment.group.id
    && membership.poolId === assignment.pool.id
    && membership.url === assignment.pool.url
  );
}

function membershipIsFromPreviousBrowserSession(membership, browserSessionId) {
  return membership.sessionId !== browserSessionId;
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
  const browserSessionId = await currentBrowserSessionId();
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
    sessionId: browserSessionId,
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

async function normalizeExistingWarmTab(
  entry,
  config,
  browserSessionId,
  beforeNetworkLoad = null,
) {
  const { tab, membership } = entry;
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

    if (
      membership.version !== WTP.TAB_VALUE_VERSION
      || membership.sessionId !== browserSessionId
    ) {
      await browser.sessions.setTabValue(tab.id, WTP.TAB_VALUE_KEY, {
        owner: OWNER,
        version: WTP.TAB_VALUE_VERSION,
        groupId: membership.groupId,
        poolId: membership.poolId,
        url: membership.url,
        createdAt: membership.createdAt ?? Date.now(),
        sessionId: browserSessionId,
      });
      membership.version = WTP.TAB_VALUE_VERSION;
      membership.sessionId = browserSessionId;
    }

    if (tab.discarded) {
      await beforeNetworkLoad?.();
      await browser.tabs.reload(tab.id);
    }
  } catch (error) {
    console.warn(`Could not normalize warm tab ${tab.id}:`, error);
    return "gone";
  }

  return "kept";
}

async function reconcilePools({ startupLoadDelayMs = 0 } = {}) {
  const config = await WTP.loadConfig();
  const beforeNetworkLoad = startupLoadDelayMs > 0
    ? createLoadPacer(startupLoadDelayMs)
    : null;
  const browserSessionId = await currentBrowserSessionId();
  let entries = await taggedTabs();
  const assignments = WTP.activePoolAssignments(config);
  const enabledAssignments = config.enabled
    ? assignments.filter(({ pool }) => pool.enabled && pool.url)
    : [];

  const invalid = entries.filter(({ membership }) => {
    const assignmentExists = enabledAssignments.some(
      (assignment) => membershipMatches(membership, assignment),
    );
    const disallowedRestoredTab = !config.reuseRestoredWarmTabs
      && membershipIsFromPreviousBrowserSession(membership, browserSessionId);
    return !assignmentExists || disallowedRestoredTab;
  });
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

    // Drop excess restored copies before normalization. In particular, do not
    // reload discarded tabs that are going to be removed anyway.
    if (candidates.length > pool.size) {
      const extras = candidates.slice(pool.size);
      await removeTabs(extras);
      candidates = candidates.slice(0, pool.size);
    }

    const normalized = [];
    for (const entry of candidates) {
      const result = await normalizeExistingWarmTab(
        entry,
        config,
        browserSessionId,
        beforeNetworkLoad,
      );
      if (result === "kept") {
        normalized.push(entry);
      }
    }
    candidates = normalized.sort(candidateOrder);

    while (candidates.length < pool.size) {
      await beforeNetworkLoad?.();
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
          sessionId: browserSessionId,
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

async function popupState() {
  const config = await WTP.loadConfig();
  updateRuntimeTakeSettings(config);
  const entries = await taggedTabs();
  const activeIds = new Set(config.activeGroupIds);
  const statuses = snapshotFrom(config, entries);

  return {
    enabled: config.enabled,
    allowMultipleGroups: config.allowMultipleGroups,
    maxActivePools: WTP.MAX_POOLS,
    activePoolCount: WTP.activePoolAssignments(config).length,
    warmTabCount: statuses.reduce((total, status) => total + status.total, 0),
    activeGroupIds: [...config.activeGroupIds],
    groups: config.poolGroups.map((group) => {
      const active = activeIds.has(group.id);
      const activationIssue = active ? null : WTP.groupActivationIssue(config, group.id);
      return {
        id: group.id,
        name: group.name,
        active,
        loadError: activationIssue?.message ?? "",
        poolCount: group.pools.length,
        warmTabCount: group.pools.reduce(
          (total, pool) => total + (pool.enabled ? pool.size : 0),
          0,
        ),
      };
    }),
    statuses,
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
  updateRuntimeTakeSettings(config);
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
  const targetTab = await getTargetActiveTab();

  if (!candidate) {
    await createColdHandoffTab(pool.url, targetTab, config.handoffDirection);
    beginHandoffCooldown();
    await replenishOnePool(assignment, config);
    return { warm: false, reason: "empty", ignored: false };
  }

  const tabId = candidate.tab.id;
  const warm = isReady(candidate.tab);
  knownPoolTabIds.delete(tabId);
  await browser.sessions.removeTabValue(tabId, WTP.TAB_VALUE_KEY);

  await moveWarmTabForHandoff(
    tabId,
    candidate.tab,
    targetTab,
    config.handoffDirection,
  );

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
  beginHandoffCooldown();
  await replenishOnePool(assignment, config);

  return {
    warm,
    ignored: false,
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

async function syncSavedConfiguration() {
  const config = await WTP.loadConfig();
  updateRuntimeTakeSettings(config);
  WTP.assertConfiguration(config);
  await applyShortcuts(config);
  await reconcilePools();
  return config;
}

async function commitConfiguration(
  rawConfig,
  previousConfig = null,
  { reconcile = true } = {},
) {
  const previous = previousConfig ?? await WTP.loadConfig();
  const next = WTP.normalizeConfig(rawConfig);
  WTP.assertConfiguration(next);
  updateRuntimeTakeSettings(next);

  // Treat shortcut assignment + persisted configuration as one transition.
  // If persistence fails after Firefox accepted the new command mapping, put
  // the previous mapping back so the runtime never intentionally straddles
  // two configurations.
  await applyShortcuts(next);
  let saved;
  try {
    saved = await WTP.saveConfig(next);
  } catch (error) {
    try {
      await applyShortcuts(previous);
    } catch (rollbackError) {
      console.error("Could not roll back shortcut mapping:", rollbackError);
    }
    throw error;
  }

  if (reconcile) {
    try {
      await reconcilePools();
    } catch (error) {
      // The configuration and command mapping are already committed. Treat pool
      // repair as a retryable side effect instead of reporting the transition as
      // rolled back when it was not.
      console.error("Configuration committed, but warm-tab reconciliation failed:", error);
      scheduleReconcile(500);
    }
  }
  return saved;
}

async function transitionConfiguration(mutator) {
  const config = await WTP.loadConfig();
  const draft = structuredClone(config);
  await mutator(draft);
  return commitConfiguration(draft, config);
}

function startupGroupIds(config) {
  const selected = [];
  for (const group of config.poolGroups) {
    if (!group.loadOnStartup) {
      continue;
    }

    const candidateIds = config.allowMultipleGroups
      ? [...selected, group.id]
      : [group.id];
    const issue = WTP.activeConfigurationIssue({
      ...config,
      activeGroupIds: candidateIds,
    });
    if (issue) {
      console.warn(`Could not load “${group.name}” on browser start: ${issue.message}`);
      continue;
    }

    if (!config.allowMultipleGroups) {
      return candidateIds;
    }
    selected.push(group.id);
  }
  return selected;
}

async function syncStartupGroups() {
  const previous = await WTP.loadConfig();
  const next = structuredClone(previous);
  next.activeGroupIds = startupGroupIds(next);
  await commitConfiguration(next, previous, { reconcile: false });
  if (next.reuseRestoredWarmTabs) {
    // Firefox can restore tabs progressively. Give session restore a brief
    // opportunity to recreate the previously pooled tabs before filling any
    // missing slots, then adopt matching restored tabs during reconciliation.
    await delay(STARTUP_RESTORE_GRACE_MS);
  }
  const startupLoadDelayMs = next.startupLoadDelayEnabled
    ? WTP.clampStartupLoadDelay(next.startupLoadDelayMs)
    : 0;
  await reconcilePools({ startupLoadDelayMs });
  return popupState();
}

async function syncActiveGroups() {
  await syncSavedConfiguration();
  return popupState();
}

async function saveConfigAndSync(rawConfig) {
  const saved = await commitConfiguration(rawConfig);
  return { config: saved, state: await popupState() };
}

async function setGroupActive(groupId, active) {
  await transitionConfiguration((config) => {
    const group = WTP.groupById(config, groupId);
    if (!group) {
      throw new Error("That pool group no longer exists");
    }

    if (active) {
      if (config.allowMultipleGroups) {
        const activeIds = new Set([...config.activeGroupIds, groupId]);
        config.activeGroupIds = config.poolGroups
          .filter((candidate) => activeIds.has(candidate.id))
          .map((candidate) => candidate.id);
      } else {
        config.activeGroupIds = [groupId];
      }
    } else {
      config.activeGroupIds = config.activeGroupIds.filter((id) => id !== groupId);
    }
  });
  return popupState();
}

async function setEnabled(enabled) {
  await transitionConfiguration((config) => {
    config.enabled = Boolean(enabled);
  });
  return popupState();
}

browser.commands.onCommand.addListener((command) => {
  const match = /^take-pool-(\d+)$/.exec(command);
  if (!match) {
    return;
  }
  void requestTake(Number(match[1]));
});

browser.runtime.onInstalled.addListener(() => {
  lifecycleSyncScheduled = true;
  void serialized(syncActiveGroups);
});

browser.runtime.onStartup.addListener(() => {
  lifecycleSyncScheduled = true;
  startupRestoreGraceActive = true;
  startupRestoreWatchUntil = Date.now() + STARTUP_RESTORE_WATCH_MS;
  if (configSyncTimer !== null) {
    clearTimeout(configSyncTimer);
    configSyncTimer = null;
  }
  void serialized(async () => {
    try {
      return await syncStartupGroups();
    } finally {
      startupRestoreGraceActive = false;
    }
  });
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[WTP.CONFIG_KEY]) {
    // A configuration write can originate from any extension page. Always run
    // the full state transition: validation,
    // Firefox command assignment, and warm-tab reconciliation.
    if (!startupRestoreGraceActive) {
      scheduleConfigSync();
    }
  }
});

browser.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab.id)) {
    return;
  }
  if (Date.now() < startupRestoreWatchUntil) {
    scheduleReconcile(250);
    return;
  }
  // Outside startup, avoid reconciling for every ordinary new tab. Session
  // metadata may be attached slightly after creation, so check after a short
  // delay and only reconcile when this is one of our tagged tabs.
  setTimeout(() => {
    void readMembership(tab.id).then((membership) => {
      if (membership) {
        scheduleReconcile(50);
      }
    });
  }, 150);
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
    if (!config.enabled) {
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

  if (message.type === "getPopupState") {
    return serialized(popupState);
  }
  if (message.type === "take") {
    return requestTake(Number(message.slot));
  }
  if (message.type === "warm") {
    return serialized(() => warmBestCandidate(Number(message.slot)));
  }
  if (message.type === "syncActiveGroups") {
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
  if (message.type === "setEnabled") {
    return serialized(() => setEnabled(Boolean(message.enabled)));
  }
  if (message.type === "openShortcutSettings") {
    return browser.commands.openShortcutSettings();
  }
  return undefined;
});

// Event pages can start for reasons other than startup/install. Give Firefox
// a short opportunity to dispatch the lifecycle event first; on browser start
// that event must replace the previous runtime active set with load-on-startup
// groups before warm-tab reconciliation runs.
setTimeout(() => {
  if (lifecycleSyncScheduled) {
    return;
  }
  void serialized(async () => {
    try {
      await syncActiveGroups();
    } catch (error) {
      console.error("Could not synchronize active pool shortcuts:", error);
      await reconcilePools();
    }
  });
}, 75);
