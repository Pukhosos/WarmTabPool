"use strict";

(() => {
  const MAX_POOLS = 12;
  const MAX_POOL_SIZE = 20;
  const CONFIG_KEY = "config";
  const TAB_VALUE_KEY = "warm-tab-pool:membership";
  const TAB_VALUE_VERSION = 1;

  function defaultPool(slot) {
    return {
      slot,
      enabled: false,
      name: `Pool ${slot}`,
      url: "",
      size: 2,
    };
  }

  function defaultConfig() {
    return {
      version: 1,
      hideWarmTabs: true,
      muteWarmTabs: true,
      pools: Array.from(
        { length: MAX_POOLS },
        (_, index) => defaultPool(index + 1),
      ),
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
    if (!Number.isInteger(value) || value < 1 || value > MAX_POOL_SIZE) {
      return 2;
    }
    return value;
  }

  function normalizeConfig(raw) {
    const defaults = defaultConfig();
    const source = raw && typeof raw === "object" ? raw : {};
    const sourcePools = Array.isArray(source.pools) ? source.pools : [];

    const pools = defaults.pools.map((fallback, index) => {
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

    return {
      version: 1,
      hideWarmTabs: source.hideWarmTabs !== false,
      muteWarmTabs: source.muteWarmTabs !== false,
      pools,
    };
  }

  async function loadConfig() {
    const stored = await browser.storage.local.get(CONFIG_KEY);
    const normalized = normalizeConfig(stored[CONFIG_KEY]);

    if (!stored[CONFIG_KEY]) {
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
    return config.pools.find((pool) => pool.slot === slot) ?? null;
  }

  globalThis.WTP = Object.freeze({
    MAX_POOLS,
    MAX_POOL_SIZE,
    CONFIG_KEY,
    TAB_VALUE_KEY,
    TAB_VALUE_VERSION,
    defaultConfig,
    normalizeHttpUrl,
    normalizeConfig,
    loadConfig,
    saveConfig,
    commandName,
    poolForSlot,
  });
})();
