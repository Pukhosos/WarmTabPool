"use strict";

(() => {
  const MAX_POOLS = 32;
  const MIN_POOL_SIZE = 0;
  const MAX_POOL_SIZE = 64;
  const DEFAULT_POOL_SIZE = 1;
  const DEFAULT_HANDOFF_DIRECTION = "right";
  const DEFAULT_HANDOFF_COOLDOWN_MS = 150;
  const MAX_HANDOFF_COOLDOWN_MS = 5000;
  const HANDOFF_COOLDOWN_SLIDER_MAX_MS = 500;
  const DEFAULT_GROUP_ID = "default";
  const CONFIG_KEY = "config";
  const CONFIG_VERSION = 2;
  const LEGACY_CONFIG_VERSION = 1;
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
      loadOnStartup: false,
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
      handoffDirection: DEFAULT_HANDOFF_DIRECTION,
      handoffCooldownMs: DEFAULT_HANDOFF_COOLDOWN_MS,
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

  function clampHandoffCooldown(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return DEFAULT_HANDOFF_COOLDOWN_MS;
    }
    return Math.min(
      MAX_HANDOFF_COOLDOWN_MS,
      Math.max(0, Math.round(value)),
    );
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

  const SHORTCUT_MODIFIER_ALIASES = Object.freeze({
    ctrl: "Ctrl",
    control: "Ctrl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    command: "Command",
    cmd: "Command",
    meta: "Command",
    macctrl: "MacCtrl",
  });
  const SHORTCUT_MODIFIER_ORDER = Object.freeze([
    "Ctrl", "Alt", "Command", "MacCtrl", "Shift",
  ]);
  const SHORTCUT_KEY_ALIASES = Object.freeze({
    comma: "Comma",
    period: "Period",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    space: "Space",
    insert: "Insert",
    delete: "Delete",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    medianexttrack: "MediaNextTrack",
    mediaplaypause: "MediaPlayPause",
    mediaprevtrack: "MediaPrevTrack",
    mediastop: "MediaStop",
  });

  function formatShortcut(raw) {
    const value = String(raw ?? "").trim();
    if (!value) {
      return "";
    }

    const prepared = value
      .replace(/\bpage\s+up\b/gi, "PageUp")
      .replace(/\bpage\s+down\b/gi, "PageDown")
      .replace(/\bmedia\s+next\s+track\b/gi, "MediaNextTrack")
      .replace(/\bmedia\s+play\s+pause\b/gi, "MediaPlayPause")
      .replace(/\bmedia\s+previous\s+track\b/gi, "MediaPrevTrack")
      .replace(/\bmedia\s+prev\s+track\b/gi, "MediaPrevTrack")
      .replace(/\bmedia\s+stop\b/gi, "MediaStop")
      .replace(/\s*\+\s*/g, " ")
      .trim();
    const tokens = prepared ? prepared.split(/\s+/) : [];
    const modifiers = new Set();
    const keyTokens = [];

    for (const token of tokens) {
      const modifier = SHORTCUT_MODIFIER_ALIASES[token.toLocaleLowerCase("en-US")];
      if (modifier) {
        modifiers.add(modifier);
      } else {
        keyTokens.push(token);
      }
    }

    if (keyTokens.length !== 1) {
      throw new Error("shortcut must contain exactly one non-modifier key");
    }

    const rawKey = keyTokens[0];
    const lowerKey = rawKey.toLocaleLowerCase("en-US");
    let key = SHORTCUT_KEY_ALIASES[lowerKey] ?? null;
    if (!key && /^[a-z]$/i.test(rawKey)) {
      key = rawKey.toLocaleUpperCase("en-US");
    } else if (!key && /^\d$/.test(rawKey)) {
      key = rawKey;
    } else if (!key && /^f(?:[1-9]|1[0-9])$/i.test(rawKey)) {
      key = rawKey.toLocaleUpperCase("en-US");
    }
    if (!key) {
      throw new Error(`unsupported shortcut key “${rawKey}”`);
    }

    const isMediaKey = key.startsWith("Media");
    const isFunctionKey = /^F(?:[1-9]|1[0-9])$/.test(key);
    if (isMediaKey) {
      if (modifiers.size !== 0) {
        throw new Error("media shortcuts cannot include modifiers");
      }
      return key;
    }
    if (modifiers.size > 2) {
      throw new Error("shortcut can contain at most two modifiers");
    }

    const primaryModifiers = ["Ctrl", "Alt", "Command", "MacCtrl"].filter(
      (modifier) => modifiers.has(modifier),
    );
    if (modifiers.size > 0 && primaryModifiers.length === 0) {
      throw new Error("Shift cannot be the only modifier");
    }
    if (!isFunctionKey && primaryModifiers.length === 0) {
      throw new Error("shortcut requires Ctrl, Alt, Command, or MacCtrl");
    }

    const orderedModifiers = SHORTCUT_MODIFIER_ORDER.filter(
      (modifier) => modifiers.has(modifier),
    );
    return [...orderedModifiers, key].join("+");
  }

  function normalizeShortcuts(rawShortcuts) {
    const source = Array.isArray(rawShortcuts) ? rawShortcuts : [];
    return defaultShortcuts().map((_, index) => {
      const value = String(source[index] ?? "").trim();
      try {
        return formatShortcut(value);
      } catch {
        return value;
      }
    });
  }

  function normalizeGroup(rawGroup, fallbackId, fallbackName) {
    const source = rawGroup && typeof rawGroup === "object" ? rawGroup : {};
    const id = String(source.id ?? fallbackId).trim() || fallbackId;
    const name = String(source.name ?? fallbackName).trim() || fallbackName;

    return {
      id,
      name,
      loadOnStartup: source.loadOnStartup === true,
      pools: normalizePools(source.pools),
      shortcuts: normalizeShortcuts(source.shortcuts),
    };
  }

  function normalizeConfig(raw) {
    if (!raw || typeof raw !== "object") {
      return defaultConfig();
    }

    const source = raw;
    const sourceVersion = Number(source.version);
    if (
      ![LEGACY_CONFIG_VERSION, CONFIG_VERSION].includes(sourceVersion)
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
    const requestedActiveIds = new Set();
    for (const rawId of source.activeGroupIds) {
      const id = String(rawId ?? "").trim();
      if (id && validIds.has(id)) {
        requestedActiveIds.add(id);
      }
    }
    // The unified Pool groups list is the canonical group order. Active groups
    // use that same order so command-slot allocation never has a second,
    // hidden ordering independent of the settings UI.
    const activeGroupIds = groups
      .filter((group) => requestedActiveIds.has(group.id))
      .map((group) => group.id);

    const allowMultipleGroups = source.allowMultipleGroups !== false;
    if (!allowMultipleGroups && activeGroupIds.length > 1) {
      activeGroupIds.splice(1);
    }

    const normalized = {
      version: CONFIG_VERSION,
      enabled: source.enabled !== false,
      hideWarmTabs: source.hideWarmTabs !== false,
      muteWarmTabs: source.muteWarmTabs !== false,
      allowMultipleGroups,
      handoffDirection: source.handoffDirection === "left" ? "left" : DEFAULT_HANDOFF_DIRECTION,
      handoffCooldownMs: clampHandoffCooldown(source.handoffCooldownMs),
      activeGroupIds,
      poolGroups: groups,
    };

    // Version 1 allowed mutually incompatible startup groups to be stored.
    // Migrate such configurations deterministically by keeping compatible
    // startup groups in group order. Version 2 configurations are never
    // silently repaired: attempts to create an invalid startup set are rejected.
    if (sourceVersion === LEGACY_CONFIG_VERSION) {
      const selected = [];
      for (const group of normalized.poolGroups) {
        if (!group.loadOnStartup) {
          continue;
        }
        if (!normalized.allowMultipleGroups && selected.length > 0) {
          group.loadOnStartup = false;
          continue;
        }
        const candidateIds = [...selected, group.id];
        const issue = activeConfigurationIssue({
          ...normalized,
          activeGroupIds: candidateIds,
        });
        if (issue) {
          group.loadOnStartup = false;
        } else {
          selected.push(group.id);
        }
      }
    }

    return normalized;
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

      let formattedShortcut;
      try {
        formattedShortcut = formatShortcut(shortcut);
      } catch (error) {
        return {
          code: "group-shortcut-format",
          group,
          pool,
          shortcut,
          message: `Cannot update group “${group.name}”: shortcut “${shortcut}” for “${pool.name}” is invalid (${error.message}).`,
        };
      }

      const key = formattedShortcut.toLocaleLowerCase("en-US");
      const previous = seen.get(key);
      if (previous) {
        return {
          code: "group-shortcut-collision",
          group,
          shortcut: formattedShortcut,
          first: previous,
          second: pool,
          message: `Cannot update group “${group.name}”: shortcut “${formattedShortcut}” is assigned to both “${previous.name}” and “${pool.name}”.`,
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
    return activeConfigurationIssue(config) ?? startupConfigurationIssue(config);
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

  function startupGroupIds(config) {
    return config.poolGroups
      .filter((group) => group.loadOnStartup)
      .map((group) => group.id);
  }

  function startupConfigurationIssue(config) {
    const selectedIds = startupGroupIds(config);
    if (!config.allowMultipleGroups && selectedIds.length > 1) {
      return {
        code: "startup-multiple-groups-disabled",
        groupIds: selectedIds,
        message: "Cannot load these groups on browser start while multiple-group mode is disabled.",
      };
    }

    const issue = activeConfigurationIssue({
      ...config,
      activeGroupIds: selectedIds,
    });
    if (!issue) {
      return null;
    }
    if (issue.code === "pool-limit") {
      return {
        ...issue,
        code: "startup-pool-limit",
        message: `Cannot load these groups on browser start: they contain ${issue.poolCount} pools in total, but only ${MAX_POOLS} shortcut slots are available.`,
      };
    }
    if (issue.code === "shortcut-collision") {
      return {
        ...issue,
        code: "startup-shortcut-collision",
        message: `Cannot load these groups on browser start: shortcut “${issue.shortcut}” is assigned to both “${issue.first.group.name} / ${issue.first.pool.name}” and “${issue.second.group.name} / ${issue.second.pool.name}”.`,
      };
    }
    return {
      ...issue,
      code: `startup-${issue.code ?? "configuration"}`,
      message: `Cannot load these groups on browser start: ${issue.message}`,
    };
  }

  function groupStartupIssue(config, groupId) {
    const group = groupById(config, groupId);
    if (!group) {
      return {
        code: "missing-group",
        message: "That pool group no longer exists.",
      };
    }
    const localIssue = groupShortcutIssue(group);
    if (localIssue) {
      return localIssue;
    }

    const selectedIds = config.allowMultipleGroups
      ? [...new Set([...startupGroupIds(config), group.id])]
      : [group.id];
    const draft = structuredClone(config);
    const selected = new Set(selectedIds);
    for (const candidate of draft.poolGroups) {
      candidate.loadOnStartup = selected.has(candidate.id);
    }
    return startupConfigurationIssue(draft);
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
      const sourceWasStartup = source.loadOnStartup;
      if (sourceWasStartup) {
        target.loadOnStartup = true;
      }
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
      const startupIssue = startupConfigurationIssue(merged);
      if (!startupIssue) {
        return null;
      }
      return {
        code: "merge-startup-configuration",
        message: `Cannot merge because the resulting startup selection would be invalid. ${startupIssue.message}`,
      };
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
    DEFAULT_HANDOFF_DIRECTION,
    DEFAULT_HANDOFF_COOLDOWN_MS,
    MAX_HANDOFF_COOLDOWN_MS,
    HANDOFF_COOLDOWN_SLIDER_MAX_MS,
    DEFAULT_GROUP_ID,
    CONFIG_KEY,
    CONFIG_VERSION,
    LEGACY_CONFIG_VERSION,
    TAB_VALUE_KEY,
    TAB_VALUE_VERSION,
    defaultPool,
    defaultPools,
    defaultShortcuts,
    defaultPoolGroup,
    defaultConfig,
    normalizeHttpUrl,
    clampHandoffCooldown,
    formatShortcut,
    normalizePools,
    normalizeShortcuts,
    normalizeConfig,
    groupById,
    activeGroups,
    activePoolAssignments,
    groupShortcutIssue,
    configurationIssue,
    activeConfigurationIssue,
    startupGroupIds,
    startupConfigurationIssue,
    groupStartupIssue,
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
