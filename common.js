"use strict";

(() => {
  const MAX_POOLS = 12;
  const MIN_POOL_SIZE = 0;
  const MAX_POOL_SIZE = 64;
  const DEFAULT_POOL_SIZE = 1;
  const DEFAULT_GROUP_ID = "default";
  const CONFIG_KEY = "config";
  const TAB_VALUE_KEY = "warm-tab-pool:membership";
  const TAB_VALUE_VERSION = 1;

  function defaultPool(slot) {
    return {
      slot,
      enabled: false,
      name: `Pool ${slot}`,
      url: "",
      size: DEFAULT_POOL_SIZE,
    };
  }

  function defaultPools() {
    return Array.from(
      { length: MAX_POOLS },
      (_, index) => defaultPool(index + 1),
    );
  }

  function defaultShortcuts() {
    return Array.from({ length: MAX_POOLS }, () => "");
  }

  function defaultPoolGroup() {
    return {
      id: DEFAULT_GROUP_ID,
      name: "Default",
      pools: defaultPools(),
      shortcuts: defaultShortcuts(),
    };
  }

  function defaultConfig() {
    return {
      version: 2,
      hideWarmTabs: true,
      muteWarmTabs: true,
      activeGroupId: DEFAULT_GROUP_ID,
      poolGroups: [defaultPoolGroup()],
    };
  }

  function normalizeHttpUrl(raw) {
    const value = String(raw ?? "").trim();
    if (!value) {
      throw new Error("URL is empty");
    }

    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("URL is not valid");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http:// and https:// URLs are supported");
    }

    return parsed.href;
  }

  function clampPoolSize(raw) {
    const value = Number(raw);
    if (
      !Number.isInteger(value)
      || value < MIN_POOL_SIZE
      || value > MAX_POOL_SIZE
    ) {
      return DEFAULT_POOL_SIZE;
    }
    return value;
  }

  function normalizePools(rawPools) {
    const sourcePools = Array.isArray(rawPools) ? rawPools : [];
    const fallbacks = defaultPools();

    return fallbacks.map((fallback, index) => {
      const candidate = sourcePools[index] ?? {};
      const enabled = Boolean(candidate.enabled);
      const name = (
        String(candidate.name ?? fallback.name).trim()
        || fallback.name
      );
      let url = String(candidate.url ?? "").trim();

      if (url) {
        try {
          url = normalizeHttpUrl(url);
        } catch {
          // Keep the user's text so the options page can show/fix it.
        }
      }

      return {
        slot: index + 1,
        enabled,
        name,
        url,
        size: clampPoolSize(candidate.size),
      };
    });
  }

  function normalizeShortcuts(rawShortcuts) {
    const source = Array.isArray(rawShortcuts) ? rawShortcuts : [];
    return defaultShortcuts().map((_, index) => (
      String(source[index] ?? "").trim()
    ));
  }

  function normalizeGroup(rawGroup, fallbackId, fallbackName) {
    const source = rawGroup && typeof rawGroup === "object" ? rawGroup : {};
    const id = String(source.id ?? fallbackId).trim() || fallbackId;
    const name = String(source.name ?? fallbackName).trim() || fallbackName;

    return {
      id,
      name,
      pools: normalizePools(source.pools),
      shortcuts: normalizeShortcuts(source.shortcuts),
    };
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const rawGroups = Array.isArray(source.poolGroups)
      ? source.poolGroups
      : [];

    const groups = [];
    const usedIds = new Set();

    for (const [index, rawGroup] of rawGroups.entries()) {
      const fallbackId = index === 0
        ? DEFAULT_GROUP_ID
        : `group-${index + 1}`;
      const fallbackName = index === 0 ? "Default" : `Group ${index + 1}`;
      const normalized = normalizeGroup(rawGroup, fallbackId, fallbackName);

      let id = normalized.id;
      if (usedIds.has(id)) {
        let suffix = 2;
        while (usedIds.has(`${id}-${suffix}`)) {
          suffix += 1;
        }
        id = `${id}-${suffix}`;
      }

      usedIds.add(id);
      groups.push({ ...normalized, id });
    }

    // Version-1 configurations had one top-level `pools` array and no groups.
    // Migrate that set into the required Default group.
    if (groups.length === 0) {
      const legacyPools = normalizePools(source.pools);
      if (Array.isArray(source.pools)) {
        for (const [index, pool] of legacyPools.entries()) {
          const rawPool = source.pools[index] ?? {};
          const defaultName = `Pool ${index + 1}`;
          const untouchedLegacyDefault = (
            rawPool.enabled !== true
            && !String(rawPool.url ?? "").trim()
            && String(rawPool.name ?? defaultName).trim() === defaultName
            && Number(rawPool.size) === 2
          );
          if (untouchedLegacyDefault) {
            pool.size = DEFAULT_POOL_SIZE;
          }
        }
      }

      groups.push({
        id: DEFAULT_GROUP_ID,
        name: "Default",
        pools: legacyPools,
        shortcuts: normalizeShortcuts(source.shortcuts),
      });
      usedIds.add(DEFAULT_GROUP_ID);
    }

    let defaultIndex = groups.findIndex(
      (group) => group.id === DEFAULT_GROUP_ID,
    );
    if (defaultIndex === -1) {
      groups.unshift({
        id: DEFAULT_GROUP_ID,
        name: "Default",
        pools: normalizePools(source.pools),
        shortcuts: normalizeShortcuts(source.shortcuts),
      });
    } else {
      const [defaultGroup] = groups.splice(defaultIndex, 1);
      groups.unshift({ ...defaultGroup, name: "Default" });
    }

    const requestedActiveId = String(
      source.activeGroupId ?? DEFAULT_GROUP_ID,
    );
    const activeGroupId = groups.some(
      (group) => group.id === requestedActiveId,
    )
      ? requestedActiveId
      : DEFAULT_GROUP_ID;

    return {
      version: 2,
      hideWarmTabs: source.hideWarmTabs !== false,
      muteWarmTabs: source.muteWarmTabs !== false,
      activeGroupId,
      poolGroups: groups,
    };
  }

  function activeGroup(config) {
    return config.poolGroups.find(
      (group) => group.id === config.activeGroupId,
    ) ?? config.poolGroups[0];
  }

  async function loadConfig() {
    const stored = await browser.storage.local.get(CONFIG_KEY);
    const normalized = normalizeConfig(stored[CONFIG_KEY]);

    if (
      !stored[CONFIG_KEY]
      || JSON.stringify(stored[CONFIG_KEY]) !== JSON.stringify(normalized)
    ) {
      await browser.storage.local.set({ [CONFIG_KEY]: normalized });
    }

    return normalized;
  }

  async function saveConfig(config) {
    const normalized = normalizeConfig(config);
    await browser.storage.local.set({ [CONFIG_KEY]: normalized });
    return normalized;
  }

  function commandName(slot) {
    return `take-pool-${slot}`;
  }

  function poolForSlot(config, slot) {
    return activeGroup(config).pools.find((pool) => pool.slot === slot) ?? null;
  }

  globalThis.WTP = Object.freeze({
    MAX_POOLS,
    MIN_POOL_SIZE,
    MAX_POOL_SIZE,
    DEFAULT_POOL_SIZE,
    DEFAULT_GROUP_ID,
    CONFIG_KEY,
    TAB_VALUE_KEY,
    TAB_VALUE_VERSION,
    defaultConfig,
    normalizeHttpUrl,
    normalizePools,
    normalizeShortcuts,
    normalizeConfig,
    activeGroup,
    loadConfig,
    saveConfig,
    commandName,
    poolForSlot,
  });
})();
