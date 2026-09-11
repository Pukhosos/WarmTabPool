"use strict";

(() => {
  const MAX_POOLS = 32;
  const MIN_POOL_SIZE = 0;
  const MAX_POOL_SIZE = 64;
  const DEFAULT_POOL_SIZE = 1;
  const DEFAULT_GROUP_ID = "default";
  const CONFIG_KEY = "config";
  const CONFIG_VERSION = 1;
  const TAB_VALUE_KEY = "warm-tab-pool:membership";
  const TAB_VALUE_VERSION = 1;

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
      version: CONFIG_VERSION,
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
    if (
      source.version !== CONFIG_VERSION
      || !Array.isArray(source.poolGroups)
      || !Array.isArray(source.activeGroupIds)
    ) {
      return defaultConfig();
    }

    const groups = [];
    const usedIds = new Set();

    for (const [index, rawGroup] of source.poolGroups.entries()) {
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

    const validIds = new Set(groups.map((group) => group.id));
    const activeGroupIds = [];
    for (const rawId of source.activeGroupIds) {
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
      version: CONFIG_VERSION,
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
    const byId = new Map(config.poolGroups.map((group) => [group.id, group]));
    return config.activeGroupIds
      .map((groupId) => byId.get(groupId))
      .filter(Boolean);
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

  function groupShortcutIssue(group) {
    const seen = new Map();
    for (const pool of group.pools) {
      const shortcut = String(group.shortcuts[pool.slot - 1] ?? "").trim();
      if (!shortcut) {
        continue;
      }

      const key = shortcut.toLocaleLowerCase("en-US");
      const previous = seen.get(key);
      if (previous) {
        return {
          code: "group-shortcut-collision",
          group,
          shortcut,
          first: previous,
          second: pool,
          message: `Cannot save group “${group.name}”: shortcut “${shortcut}” is assigned to both “${previous.name}” and “${pool.name}”.`,
        };
      }
      seen.set(key, pool);
    }
    return null;
  }

  function configurationIssue(config) {
    for (const group of config.poolGroups) {
      const issue = groupShortcutIssue(group);
      if (issue) {
        return issue;
      }
    }
    return activeConfigurationIssue(config);
  }

  function activeConfigurationIssue(config) {
    const assignments = activePoolAssignments(config);
    if (assignments.length > MAX_POOLS) {
      return {
        code: "pool-limit",
        poolCount: assignments.length,
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
          shortcut,
          first: previous,
          second: assignment,
          message: `Cannot activate these groups: shortcut “${shortcut}” is assigned to both “${previous.group.name} / ${previous.pool.name}” and “${assignment.group.name} / ${assignment.pool.name}”.`,
        };
      }
      seen.set(key, assignment);
    }

    return null;
  }

  function groupActivationIssue(config, groupId) {
    const group = groupById(config, groupId);
    if (!group) {
      return {
        code: "missing-group",
        message: "That pool group no longer exists.",
      };
    }

    const activeGroupIds = config.allowMultipleGroups
      ? [...new Set([...config.activeGroupIds, group.id])]
      : [group.id];
    return activeConfigurationIssue({ ...config, activeGroupIds });
  }

  function uniqueMergedPoolId(usedIds, sourceGroupId, preferredId) {
    const preferred = String(preferredId ?? "").trim() || "pool";
    if (!usedIds.has(preferred)) {
      usedIds.add(preferred);
      return preferred;
    }

    const sourcePrefix = String(sourceGroupId ?? "source").trim() || "source";
    const base = `${sourcePrefix}-${preferred}`;
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return id;
  }

  function buildMergedConfig(config, sourceGroupId, targetGroupId, { destructive = false } = {}) {
    const draft = structuredClone(normalizeConfig(config));
    const source = groupById(draft, sourceGroupId);
    const target = groupById(draft, targetGroupId);
    if (!source || !target) {
      throw new Error("One of the pool groups no longer exists.");
    }
    if (source.id === target.id) {
      throw new Error("A pool group cannot be merged into itself.");
    }

    const usedPoolIds = new Set(target.pools.map((pool) => pool.id));
    const targetPoolCount = target.pools.length;
    const mergedShortcuts = defaultShortcuts();

    for (const pool of target.pools) {
      mergedShortcuts[pool.slot - 1] = target.shortcuts[pool.slot - 1] ?? "";
    }

    const appendedPools = source.pools.map((pool, index) => {
      const slot = targetPoolCount + index + 1;
      mergedShortcuts[slot - 1] = source.shortcuts[pool.slot - 1] ?? "";
      return {
        ...pool,
        id: uniqueMergedPoolId(usedPoolIds, source.id, pool.id),
        slot,
      };
    });

    target.pools = [
      ...target.pools.map((pool, index) => ({ ...pool, slot: index + 1 })),
      ...appendedPools,
    ];
    target.shortcuts = mergedShortcuts;

    if (destructive) {
      draft.poolGroups = draft.poolGroups.filter((group) => group.id !== source.id);

      const sourceWasActive = draft.activeGroupIds.includes(source.id);
      const targetWasActive = draft.activeGroupIds.includes(target.id);
      const nextActiveIds = [];
      for (const groupId of draft.activeGroupIds) {
        if (groupId === source.id) {
          if (sourceWasActive && !targetWasActive && !nextActiveIds.includes(target.id)) {
            nextActiveIds.push(target.id);
          }
          continue;
        }
        if (!nextActiveIds.includes(groupId)) {
          nextActiveIds.push(groupId);
        }
      }
      draft.activeGroupIds = nextActiveIds;
    }

    return normalizeConfig(draft);
  }

  function mergedGroupShortcutIssue(target, source) {
    const seen = new Map();
    for (const group of [target, source]) {
      for (const pool of group.pools) {
        const shortcut = String(group.shortcuts[pool.slot - 1] ?? "").trim();
        if (!shortcut) {
          continue;
        }
        const key = shortcut.toLocaleLowerCase("en-US");
        const previous = seen.get(key);
        if (previous) {
          return {
            code: "merge-shortcut-collision",
            shortcut,
            message: `Cannot merge: shortcut “${shortcut}” would be assigned to both “${previous.pool.name}” and “${pool.name}” in the merged group.`,
          };
        }
        seen.set(key, { group, pool });
      }
    }
    return null;
  }

  function groupMergeIssue(config, sourceGroupId, targetGroupId, { destructive = false } = {}) {
    const normalized = normalizeConfig(config);
    const source = groupById(normalized, sourceGroupId);
    const target = groupById(normalized, targetGroupId);
    if (!source || !target) {
      return {
        code: "merge-missing-group",
        message: "Cannot merge because one of the pool groups no longer exists.",
      };
    }
    if (source.id === target.id) {
      return {
        code: "merge-self",
        message: "A pool group cannot be merged into itself.",
      };
    }

    const sourceIsActive = normalized.activeGroupIds.includes(source.id);
    const targetIsActive = normalized.activeGroupIds.includes(target.id);
    if (sourceIsActive && targetIsActive) {
      return {
        code: "merge-both-active",
        message: "Cannot merge while both groups are active. Unload at least one of them first.",
      };
    }

    const mergedPoolCount = target.pools.length + source.pools.length;
    if (mergedPoolCount > MAX_POOLS) {
      return {
        code: "merge-pool-limit",
        poolCount: mergedPoolCount,
        message: `Cannot merge: the edited group would contain ${mergedPoolCount} pools, exceeding the ${MAX_POOLS}-pool limit.`,
      };
    }

    const localShortcutIssue = mergedGroupShortcutIssue(target, source);
    if (localShortcutIssue) {
      return localShortcutIssue;
    }

    const merged = buildMergedConfig(normalized, source.id, target.id, { destructive });
    const activeIssue = activeConfigurationIssue(merged);
    if (!activeIssue) {
      return null;
    }
    if (activeIssue.code === "pool-limit") {
      return {
        code: "merge-active-pool-limit",
        poolCount: activeIssue.poolCount,
        message: `Cannot merge: the resulting active groups would use ${activeIssue.poolCount} pools, but only ${MAX_POOLS} shortcut slots are available.`,
      };
    }
    if (activeIssue.code === "shortcut-collision") {
      return {
        code: "merge-active-shortcut-collision",
        shortcut: activeIssue.shortcut,
        message: `Cannot merge: shortcut “${activeIssue.shortcut}” would conflict between “${activeIssue.first.group.name} / ${activeIssue.first.pool.name}” and “${activeIssue.second.group.name} / ${activeIssue.second.pool.name}”.`,
      };
    }
    return {
      code: "merge-active-configuration",
      message: `Cannot merge: ${activeIssue.message}`,
    };
  }

  function mergeGroups(config, sourceGroupId, targetGroupId, { destructive = false } = {}) {
    const issue = groupMergeIssue(config, sourceGroupId, targetGroupId, { destructive });
    if (issue) {
      throw new Error(issue.message);
    }
    return buildMergedConfig(config, sourceGroupId, targetGroupId, { destructive });
  }

  function assertActiveConfiguration(config) {
    const issue = activeConfigurationIssue(config);
    if (issue) {
      throw new Error(issue.message);
    }
  }

  function assertConfiguration(config) {
    const issue = configurationIssue(config);
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
    CONFIG_VERSION,
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
    groupShortcutIssue,
    configurationIssue,
    activeConfigurationIssue,
    groupActivationIssue,
    groupMergeIssue,
    mergeGroups,
    assertActiveConfiguration,
    assertConfiguration,
    loadConfig,
    saveConfig,
    commandName,
    assignmentForCommandSlot,
    assignmentForPool,
  });
})();
