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
    if (
      value &&
      value.owner === OWNER &&
      value.version === WTP.TAB_VALUE_VERSION &&
      Number.isInteger(value.slot)
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

async function createWarmTab(pool, config, preferredWindowId = undefined) {
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
    throw new Error(`Firefox did not return an ID for pool ${pool.slot}`);
  }

  await browser.sessions.setTabValue(tab.id, WTP.TAB_VALUE_KEY, {
    owner: OWNER,
    version: WTP.TAB_VALUE_VERSION,
    slot: pool.slot,
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
    // One tab may have been closed concurrently.
    // Fall back to individual removal.
    await Promise.all(
      ids.map(async (id) => {
        try {
          await browser.tabs.remove(id);
        } catch {
          // Already gone.
        }
      }),
    );
    console.debug("Bulk pool cleanup needed a per-tab fallback:", error);
  }
}

async function normalizeExistingWarmTab(entry, config) {
  const { tab } = entry;
  if (!Number.isInteger(tab.id)) {
    return "gone";
  }

  // If a pooled tab is active, treat it as already consumed rather than hiding
  // something the user is currently looking at.
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
  const pools = WTP.activeGroup(config).pools;
  const enabledBySlot = new Map(
    pools.filter(
      (pool) => pool.enabled && pool.url
    ).map((pool) => [pool.slot, pool]),
  );

  const invalid = entries.filter(({ membership }) => {
    const pool = enabledBySlot.get(membership.slot);
    return !pool || membership.url !== pool.url;
  });
  await removeTabs(invalid);

  entries = entries.filter((entry) => !invalid.includes(entry));
  const preferredWindowId = await getTargetWindowId();

  for (const pool of pools) {
    if (!pool.enabled || !pool.url) {
      continue;
    }

    let candidates = entries
      .filter((
        ({ membership }) => membership.slot === pool.slot
        && membership.url === pool.url
      ))
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
      const tab = await createWarmTab(pool, config, preferredWindowId);
      candidates.push({
        tab,
        membership: {
          owner: OWNER,
          version: WTP.TAB_VALUE_VERSION,
          slot: pool.slot,
          url: pool.url,
          createdAt: Date.now(),
        },
      });
    }
  }
}

async function statusSnapshot({ reconcile = false } = {}) {
  if (reconcile) {
    await reconcilePools();
  }

  const config = await WTP.loadConfig();
  const entries = await taggedTabs();

  return WTP.activeGroup(config).pools.map((pool) => {
    const candidates = entries.filter(
      (
        ({ membership }) => membership.slot === pool.slot
        && membership.url === pool.url
      ),
    );

    return {
      slot: pool.slot,
      enabled: pool.enabled,
      name: pool.name,
      url: pool.url,
      size: pool.size,
      ready: candidates.filter(({ tab }) => isReady(tab)).length,
      loading: candidates.filter(
        ({ tab }) => tab.status !== "complete" && !tab.discarded
      ).length,
      discarded: candidates.filter(({ tab }) => tab.discarded).length,
      total: candidates.length,
    };
  });
}

async function replenishOnePool(pool, config) {
  const entries = await taggedTabs();
  const existing = entries.filter(
    (
      ({ membership }) => membership.slot === pool.slot
      && membership.url === pool.url
    ),
  );
  const preferredWindowId = await getTargetWindowId();

  for (let count = existing.length; count < pool.size; count += 1) {
    await createWarmTab(pool, config, preferredWindowId);
  }
}

async function warmBestCandidate(slot) {
  const config = await WTP.loadConfig();
  const pool = WTP.poolForSlot(config, slot);
  if (!pool?.enabled) {
    return false;
  }

  const candidate = (await taggedTabs())
    .filter(({ membership, tab }) =>
      membership.slot === slot && membership.url === pool.url && !tab.discarded
    )
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

async function takeFromPool(slot) {
  const config = await WTP.loadConfig();
  const pool = WTP.poolForSlot(config, slot);

  if (!pool || !pool.enabled) {
    throw new Error(`Pool slot ${slot} is disabled`);
  }

  const url = WTP.normalizeHttpUrl(pool.url);
  if (url !== pool.url) {
    pool.url = url;
  }

  const entries = (await taggedTabs())
    .filter(
      (
        ({ membership }) => membership.slot === slot
        && membership.url === pool.url
      )
    )
    .sort(candidateOrder);

  let candidate = entries[0] ?? null;
  const targetWindowId = await getTargetWindowId();

  if (!candidate) {
    // Cold fallback: do not make the user wait
    // for us to construct the pool first.
    const properties = { url: pool.url, active: true };
    if (Number.isInteger(targetWindowId)) {
      properties.windowId = targetWindowId;
    }
    await browser.tabs.create(properties);
    await replenishOnePool(pool, config);
    return { warm: false, reason: "empty" };
  }

  const tabId = candidate.tab.id;
  const warm = isReady(candidate.tab);

  // Remove the membership before activation.
  // This also prevents our onActivated
  // listener from consuming the same tab twice.
  knownPoolTabIds.delete(tabId);
  await browser.sessions.removeTabValue(tabId, WTP.TAB_VALUE_KEY);

  if (
    Number.isInteger(targetWindowId)
    && candidate.tab.windowId !== targetWindowId
  ) {
    try {
      await browser.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
    } catch (error) {
      console.warn(
        `Could not move warm tab ${tabId} to the focused window:`,
        error,
      );
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

  // tabs.create() resolves as soon as Firefox creates the replacement.
  // We do not wait for the replacement page to finish loading
  // before returning control.
  await replenishOnePool(pool, config);

  return {
    warm,
    reason: warm ? "ready" : candidate.tab.discarded ? "discarded" : "loading",
  };
}

browser.commands.onCommand.addListener((command) => {
  const match = /^take-pool-(\d+)$/.exec(command);
  if (!match) {
    return;
  }

  const slot = Number(match[1]);
  void serialized(() => takeFromPool(slot));
});

browser.runtime.onInstalled.addListener(() => {
  void serialized(reconcilePools);
});

browser.runtime.onStartup.addListener(() => {
  void serialized(reconcilePools);
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
    // A pooled tab should stay resident. Reconcile reloads discarded members.
    scheduleReconcile(100);
  }
});

browser.tabs.onReplaced.addListener(() => {
  // Prerendering can replace one tab ID with another. Session metadata is our
  // source of truth, so rebuild the in-memory ID set after a replacement.
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

    const pool = WTP.poolForSlot(config, membership.slot);
    if (pool?.enabled && pool.url === membership.url) {
      await replenishOnePool(pool, config);
    }
  });
});

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "getStatus") {
    return serialized(() => statusSnapshot(
      { reconcile: Boolean(message.reconcile) }
    ));
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
      return statusSnapshot();
    });
  }

  if (message.type === "openShortcutSettings") {
    return browser.commands.openShortcutSettings();
  }

  return undefined;
});

// Event pages may start for reasons other than onStartup/onInstalled.
// A reconciliation here makes the extension self-healing after a background
// page restart as well.
void serialized(reconcilePools);
