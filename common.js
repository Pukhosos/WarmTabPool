"use strict";

(() => {
  const MAX_POOLS = 32;
  const MIN_POOL_SIZE = 0;
  const MAX_POOL_SIZE = 64;
  const DEFAULT_POOL_SIZE = 1;
  const DEFAULT_GROUP_ID = "default";
  const CONFIG_KEY = "config";
  const TAB_VALUE_KEY = "warm-tab-pool:membership";
  const TAB_VALUE_VERSION = 2;

  function defaultPool(slot, id = `pool-${slot}`) {
    return {
      id,
      slot,
      enabled: false,
      name: `Pool ${slot}`,
      url: "",
      size: DEFAULT_POOL_SIZE,
    };
  }

  function defaultPools() {
    return [defaultPool(1)];
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
      version: 4,
      enabled: true,
      hideWarmTabs: true,
      muteWarmTabs: true,
      allowMultipleGroups: true,
      activeGroupIds: [DEFAULT_GROUP_ID],
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
    const hasExplicitArray = Array.isArray(rawPools);
    const sourcePools = hasExplicitArray
      ? rawPools.slice(0, MAX_POOLS)
      : defaultPools();
    const usedIds = new Set();

    return sourcePools.map((candidate, index) => {
      const source = candidate && typeof candidate === "object"
        ? candidate
        : {};
      const slot = index + 1;
      const fallback = defaultPool(slot);
      const enabled = Boolean(source.enabled);
      const name = String(source.name ?? fallback.name).trim() || fallback.name;
      let url = String(source.url ?? "").trim();

      let id = String(source.id ?? fallback.id).trim() || fallback.id;
      if (usedIds.has(id)) {
        const base = id;
        let suffix = 2;
        while (usedIds.has(`${base}-${suffix}`)) {
          suffix += 1;
        }
        id = `${base}-${suffix}`;
      }
      usedIds.add(id);

      if (url) {
        try {
          url = normalizeHttpUrl(url);
        } catch {
          // Keep the user's text so the options page can show/fix it.
        }
      }

      return {
        id,
        slot,
        enabled,
        name,
        url,
        size: clampPoolSize(source.size),
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
    if (!raw || typeof raw !== "object") {
      return defaultConfig();
    }
    const source = raw;
    const rawGroups = Array.isArray(source.poolGroups)
      ? source.poolGroups
      : null;

    const groups = [];
    const usedIds = new Set();

    if (rawGroups) {
      for (const [index, rawGroup] of rawGroups.entries()) {
        const fallbackId = index === 0
          ? DEFAULT_GROUP_ID
          : `group-${index + 1}`;
        const fallbackName = index === 0 ? "Default" : `Group ${index + 1}`;
        const normalized = normalizeGroup(rawGroup, fallbackId, fallbackName);

        let id = normalized.id;
        if (usedIds.has(id)) {
          const base = id;
          let suffix = 2;
          while (usedIds.has(`${base}-${suffix}`)) {
            suffix += 1;
          }
          id = `${base}-${suffix}`;
        }

        usedIds.add(id);
        groups.push({ ...normalized, id });
      }
    }

    // Version-1 configurations had one top-level `pools` array and no groups.
    if (!rawGroups && Array.isArray(source.pools)) {
      const legacyPools = normalizePools(source.pools);
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

      groups.push({
        id: DEFAULT_GROUP_ID,
        name: "Default",
        pools: legacyPools,
        shortcuts: normalizeShortcuts(source.shortcuts),
      });
      usedIds.add(DEFAULT_GROUP_ID);
    }

    const validIds = new Set(groups.map((group) => group.id));
    let requestedIds;
    if (Array.isArray(source.activeGroupIds)) {
      requestedIds = source.activeGroupIds;
    } else if (source.activeGroupId !== undefined && source.activeGroupId !== null) {
      // Versions 2 and 3 had one activeGroupId.
      requestedIds = [source.activeGroupId];
    } else {
      requestedIds = groups.length > 0 ? [groups[0].id] : [];
    }

    const activeGroupIds = [];
    for (const rawId of requestedIds) {
      const id = String(rawId ?? "").trim();
      if (id && validIds.has(id) && !activeGroupIds.includes(id)) {
        activeGroupIds.push(id);
      }
    }

    const allowMultipleGroups = source.allowMultipleGroups !== false;
    if (!allowMultipleGroups && activeGroupIds.length > 1) {
      activeGroupIds.splice(1);
    }

    return {
      version: 4,
      enabled: source.enabled !== false,
      hideWarmTabs: source.hideWarmTabs !== false,
      muteWarmTabs: source.muteWarmTabs !== false,
      allowMultipleGroups,
      activeGroupIds,
      poolGroups: groups,
    };
  }

  function groupById(config, groupId) {
    return config.poolGroups.find((group) => group.id === groupId) ?? null;
  }

  function activeGroups(config) {
    const activeIds = new Set(config.activeGroupIds);
    return config.poolGroups.filter((group) => activeIds.has(group.id));
  }

  function activePoolAssignments(config) {
    const assignments = [];
    let commandSlot = 1;

    for (const group of activeGroups(config)) {
      for (const pool of group.pools) {
        assignments.push({
          commandSlot,
          group,
          pool,
          shortcut: group.shortcuts[pool.slot - 1] ?? "",
        });
        commandSlot += 1;
      }
    }

    return assignments;
  }

  function activeConfigurationIssue(config) {
    const assignments = activePoolAssignments(config);
    if (assignments.length > MAX_POOLS) {
      return {
        code: "pool-limit",
        message: `Cannot activate these groups: they contain ${assignments.length} pools in total, but only ${MAX_POOLS} shortcut slots are available.`,
      };
    }

    const seen = new Map();
    for (const assignment of assignments) {
      const shortcut = String(assignment.shortcut ?? "").trim();
      if (!shortcut) {
        continue;
      }
      const key = shortcut.toLocaleLowerCase("en-US");
      const previous = seen.get(key);
      if (previous) {
        return {
          code: "shortcut-collision",
          message: `Cannot activate these groups: shortcut “${shortcut}” is assigned to both “${previous.group.name} / ${previous.pool.name}” and “${assignment.group.name} / ${assignment.pool.name}”.`,
        };
      }
      seen.set(key, assignment);
    }

    return null;
  }

  function assertActiveConfiguration(config) {
    const issue = activeConfigurationIssue(config);
    if (issue) {
      throw new Error(issue.message);
    }
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

  function assignmentForCommandSlot(config, commandSlot) {
    return activePoolAssignments(config).find(
      (assignment) => assignment.commandSlot === commandSlot,
    ) ?? null;
  }

  function assignmentForPool(config, groupId, poolId) {
    return activePoolAssignments(config).find(({ group, pool }) => (
      group.id === groupId && pool.id === poolId
    )) ?? null;
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
    defaultPool,
    defaultPools,
    defaultShortcuts,
    defaultPoolGroup,
    defaultConfig,
    normalizeHttpUrl,
    normalizePools,
    normalizeShortcuts,
    normalizeConfig,
    groupById,
    activeGroups,
    activePoolAssignments,
    activeConfigurationIssue,
    assertActiveConfiguration,
    loadConfig,
    saveConfig,
    commandName,
    assignmentForCommandSlot,
    assignmentForPool,
  });
})();
