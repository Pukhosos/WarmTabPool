# Warm Tab Pool

Warm Tab Pool is a Firefox WebExtension that keeps configurable sets of web pages preloaded in background tabs and hands one to you when you press a shortcut or click **Take**.

It is generic: a pool is simply a URL + desired number of preloaded copies. For example, a pool can point at a web app, a dashboard, a search page, a new-document route, or `https://chatgpt.com/?temporary-chat=true`.

## Core behavior

For every enabled pool, the extension tries to keep exactly `size` unused tabs available.

When a pooled tab is created, it is:

- loaded immediately in the background;
- tagged using Firefox session tab metadata, so it can be recognized after Firefox restores a session;
- marked `autoDiscardable: false`, so Firefox does not automatically unload it;
- optionally hidden from the tab strip (default: on);
- optionally muted (default: on).

When you take a tab, the extension:

1. selects a completely loaded pool tab if one exists;
2. otherwise selects the oldest tab that is still loading (or a discarded one as a last resort);
3. removes the internal pool tag before giving the tab to you;
4. moves it to the currently focused Firefox window when necessary;
5. shows and activates it;
6. restores normal auto-discard behavior and unmutes it;
7. immediately creates a replacement background tab for the pool.

The replacement is *not* waited on. You start using the old warm tab while Firefox loads the replacement in the background.

When you hover or keyboard-focus a **Take** button in the popup, the extension also calls Firefox's `tabs.warmup()` API for the best candidate. That API asks Firefox to recreate rendering/GPU resources that may have been dropped from an inactive tab, reducing tab-switch latency further.

If a pool is completely empty, the extension opens the configured URL normally as a cold fallback and starts rebuilding the pool immediately.

## Why there are 12 pool slots

Firefox keyboard commands must be declared in the extension manifest ahead of time. The API can change a declared command's key combination, but it cannot dynamically invent an unlimited number of new commands.

This extension therefore declares 12 generic command slots. You can enable any subset of them, rename them, assign any supported shortcut to each, and give each its own pool size.

Pool *size* is independent of the number of slots and can be 0–64. New pools default to size 1. Size 0 keeps the slot/shortcut available but preloads no warm copies, so taking from it uses the normal cold fallback.

## Install for testing (ordinary Firefox)

1. Unzip the source directory somewhere permanent enough for testing.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json` from this extension directory.
5. The extension appears in Firefox until Firefox exits.

Temporary extensions are removed when Firefox closes. Your normal Firefox profile data is not modified beyond this extension's own settings/session metadata while it is loaded.

## Permanent installation

Standard Firefox release builds require extensions to be signed by Mozilla. For a personal extension, the normal route is to submit it to Mozilla Add-ons as **unlisted** and install the signed XPI that Mozilla returns; it does not need to be publicly listed.

Developer Edition, Nightly, and supported ESR configurations can also be used for unsigned development builds when signature enforcement is disabled, but that is a browser-level development choice rather than something this extension can bypass.

## Configure a pool

1. Click the Warm Tab Pool toolbar icon.
2. Click **Settings**.
3. Pick a slot.
4. Enable it.
5. Enter a name.
6. Enter a full `http://` or `https://` URL.
7. Choose the number of warm copies to keep.
8. Optionally enter a Firefox extension shortcut by typing its textual form (for example, `Ctrl+Shift+1`) into the field; do not press the shortcut combination itself while the field is focused.
9. Click **Save**.

Example:

- Name: `Temporary ChatGPT`
- URL: `https://chatgpt.com/?temporary-chat=true`
- Size: `2`
- Shortcut: `Ctrl+Shift+1`

Firefox may display a one-time notice the first time the extension hides a tab. That is normal for extensions using Firefox's tab-hiding API.

## Shortcuts

Examples accepted by Firefox include:

- `Ctrl+Shift+1`
- `Ctrl+Alt+C`
- `Alt+F2`
- `F13` (on recent Firefox versions)

A shortcut that conflicts with a browser or another extension may not fire. You can also click **Firefox shortcut settings** in the options page and let Firefox manage the bindings directly.

Important: WebExtension commands are Firefox shortcuts, not KDE system-global shortcuts. They are intended to work while Firefox has keyboard focus. Receiving the shortcut while another application is focused would require an OS integration layer such as a Native Messaging helper, which is deliberately outside this extension.

## Popup

The toolbar popup shows each enabled pool with:

- number of fully ready tabs;
- target pool size;
- number still loading;
- number being restored/reloaded;
- the configured keyboard shortcut, when one is assigned;
- a **Take** button.

While the popup is open, status is refreshed automatically every 500 ms, so loading/ready counts update without repeatedly pressing the refresh button.

**Refill now** runs a full reconciliation of the active group. It removes stale warm tabs (for disabled pools or changed URLs), reapplies hide/mute/non-discardable state, reloads discarded warm tabs, removes surplus tabs, and creates missing tabs until each enabled pool matches its configured size. It does not reclaim tabs that have already been handed to the user.

## Pool groups

The options page can store multiple complete 12-pool sets. The built-in **Default** group is always present and cannot be deleted.

- **Load** makes a group's 12 pools active, applies that group's shortcuts, and reconciles the hidden warm tabs to the newly selected set.
- **New group (copy current Pools)** creates a new group from the values currently visible in the Pools table and immediately loads it.
- Non-default groups can be deleted after another group is loaded.
- Global background settings (hide/mute) are shared across groups; pool rows and shortcuts are group-specific.

The options page can also **Export JSON** and **Import JSON**. The JSON contains the complete configuration: global settings, all pool groups, the active group, all 12 pool definitions per group, and the group's shortcut strings. Version-1 single-pool-set configurations are migrated into the Default group when loaded/imported.

## What “ready” means

The extension considers a tab ready when Firefox reports that its top-level document reached `status === "complete"` and the tab is not discarded.

That is the strongest generic signal available without injecting site-specific code. A particular web application may still:

- defer work until the page becomes visible;
- lazily fetch data after focus;
- pause timers in background tabs;
- require a user gesture;
- maintain server-side session limits;
- reconnect WebSockets after activation.

So preloading can remove most navigation/startup latency, but it cannot guarantee that every arbitrary site is fully application-ready.

## Hidden tabs and memory

Hidden Firefox tabs keep running. Warm Tab Pool additionally prevents automatic discarding while a tab belongs to a pool. This is intentional and is the mechanism that makes the pool useful.

The trade-off is memory and background CPU/network usage. Start with size 1 or 2 for heavy applications. A pool size of 10 for a large SPA can be expensive.

After a tab is handed to you, `autoDiscardable` is restored to `true`, so Firefox can manage that tab normally later.

## Manual interaction with a pooled tab

If you turn off **Hide pooled tabs from the tab strip**, pooled tabs remain visible. If you manually activate one of them, the extension treats that as consuming it: the pool tag is removed and a replacement is created.

This avoids the dangerous situation where a tab you started using could later be handed out again as if it were unused.

## URL changes and disabled pools

Changing a pool's URL or disabling a pool causes its unused extension-managed warm tabs to be closed during reconciliation. Tabs that have already been handed to you are ordinary tabs and are never reclaimed or closed by the pool manager.

## Privacy / permissions

The extension contains no content scripts and requests no host permissions. It does not inject JavaScript into websites or read page contents.

It uses only:

- `storage` — save configuration;
- `sessions` — attach an internal pool marker to Firefox tabs so membership survives session restore;
- `tabHide` — hide unused warm tabs from the tab strip.

It uses normal tab-management APIs to create, show, activate, move, mute, reload, and remove its own pooled tabs.

## Development

The source has no build step and no dependencies.

Files:

- `manifest.json` — WebExtension manifest and the 12 statically declared commands;
- `common.js` — configuration schema and shared helpers;
- `background.js` — pool lifecycle, tab handoff, recovery, replenishment, command handling;
- `popup/` — toolbar popup/status;
- `options/` — configuration UI;
- `icons/` — extension icon.

To reload after editing, use the extension's **Reload** button on `about:debugging`.

## License

`Warm Tab Pool` is a free, open-source software distributed under the [MIT License](LICENSE.txt).
