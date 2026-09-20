# Warm Tab Pool

Warm Tab Pool is a Firefox WebExtension that keeps configurable web pages preloaded in background tabs and hands one to you when you press a shortcut or click **Take**.

A pool is a URL plus a desired number of preloaded copies. Pool groups store separate pool layouts and shortcuts, and several groups can be active at the same time.

## Core behavior

For every enabled pool in every active group, the extension tries to keep exactly `size` unused tabs available. A pooled tab is loaded in the background, tagged with Firefox session metadata, marked non-discardable, and optionally hidden and muted.

When you take a tab, the extension prefers a completely loaded copy, removes its pool membership before activation, moves it to the focused window when needed, places it next to the current tab on the configured side, shows and activates it, restores normal discard/audio behavior, and immediately starts replacing it in the background. The default side is the right. If the pool is empty, the configured URL opens normally as a cold fallback at the same requested position and the pool is rebuilt.

Hovering or keyboard-focusing a **Take** button also calls Firefox's `tabs.warmup()` for the best candidate when available.

## Pool groups and command slots

The manifest declares 32 command slots: `take-pool-1` through `take-pool-32`.

Pool groups are shown in one ordered list in Settings. When multiple groups are active, their command slots follow that same group order and then the pool order inside each group. Dragging a group therefore changes both its position in Settings and, when applicable, the command-slot order of active groups.

The total number of pools across all active groups cannot exceed 32. Disabled pool rows still occupy a command slot because their position is part of the group's shortcut layout. Inactive groups do not consume command slots.

When **Allow multiple groups to be active simultaneously** is disabled, loading a group replaces the active set with that group. When it is enabled, groups can be loaded and unloaded independently.

A group activation is rejected if the resulting active configuration would contain more than 32 pools or if two active pools would claim the same non-empty shortcut. Validation happens before the new configuration and Firefox command mapping are committed.

## Pools

A newly created group starts with one empty pool. Pool size can be 0–64 and defaults to 1. Size 0 keeps the pool and shortcut definition but preloads no warm copies, so taking from it uses the cold fallback.

In edit mode, pools can be added, cloned, deleted, and dragged. **Clone** creates an exact copy of the selected pool directly underneath it, including its enabled state, name, URL, size, and shortcut; only the internal pool identity is new. Existing pools below it move down one slot. If the source has a non-empty shortcut, the exact copy temporarily creates the normal duplicate-shortcut validation error; the clone remains in the editor so its shortcut can be changed (or the clone deleted) before automatic saving can complete.

When two or more groups are being edited and expanded, a pool can be dragged from one edited group into another. Its configuration and shortcut move with it. The operation is rejected if the target would exceed the 32-pool limit or the resulting active/shortcut configuration would be invalid.

Pool rows have stable internal IDs. Reordering pools or groups can therefore reassign keyboard command slots without unnecessarily destroying already-warm tabs; warm-tab membership is keyed by group and pool identity rather than by the current command-slot number.

The URL editor wraps and grows vertically so long links remain visible.

## Settings page

The top **Settings** section contains:

- **Allow multiple groups to be active simultaneously**;
- **Hide pooled tabs from the tab strip**;
- **Mute pooled tabs until they are taken**;
- **Reuse restored pooled tabs after browser restart**;
- an independently enabled tab-handoff cooldown control (150 ms by default);
- a left/right handoff-direction toggle (right by default); and
- a global Warm Tab Pool On/Off toggle that mirrors the popup switch.

The handoff-direction control is deliberately the last behavioral setting before the global extension switch. It uses a rotating, CSS-drawn arrow whose center does not shift vertically when it changes direction. For ordinary unpinned tabs, a handed tab is inserted immediately to the selected side of the current tab. Firefox does not allow an unpinned tab to be inserted inside the pinned-tab region, so those cases are clamped to the nearest legal unpinned position.

The cooldown has its own checkbox. When unchecked, the slider and numeric field are visually subdued but remain editable, so the configured value is retained for later. The slider covers 0–500 ms. The adjacent numeric field accepts 0–5000 ms and stays synchronized with the slider; values above 500 ms keep the slider at its rightmost position. While the cooldown is enabled, a take request received during a positive cooldown is discarded immediately rather than queued for later execution.

When restored-tab reuse is enabled, pooled tabs carry a browser-session identifier in their Firefox session metadata. At browser startup, Warm Tab Pool briefly waits for Firefox session restoration, adopts matching pooled tabs from the previous browser session, reloads them only if Firefox restored them in a discarded state, and fills only the still-missing pool slots. The optimization is based on whether Firefox actually restored the tab, not on an arbitrary 5- or 10-minute timeout. When the setting is disabled, pooled tabs restored from a previous browser session are rejected and normal fresh pool creation is used instead.

All pool-group functionality is in one **Pool groups** section. The former separate **Active pools** section no longer exists.

Click anywhere in a group header except its action buttons to expand it without entering edit mode. Expansion and collapse are animated. The collapsing content padding and editing divider are animated to zero together with the grid track to avoid the occasional final-frame snap that could appear at the end of the old collapse animation. The expanded read-only view shows its pools.

Each group row provides **Rename**, **Clone**, **Delete**, **Edit/Edited**, and a visually separated **Load/Unload** action. Active and editing states are shown as badges; the **Active** badge uses the same blue accent as active nodes in the group graph, and a small orange **Startup** badge is shown whenever the group is scheduled to load at browser start. The startup state can only be changed while the group is being edited or through the Startup graph. The entire group remains in its normal list position while expanded or edited.

Clicking **Edit** puts that group into edit mode, highlights the row, and expands it. Any number of groups may be in edit mode simultaneously. Each edited group has its own **Load on browser start** checkbox and **Done** button on the same toolbar line. The checkbox is off by default. An unchecked startup checkbox is disabled when adding that group to the current startup selection would exceed the 32-slot limit or collide with a selected startup shortcut. Startup compatibility is also revalidated whenever group pools or shortcuts change, during merges and drag/drop operations, and again before every save. Clicking **Done** validates and saves that group's current editor state and leaves the group expanded in read-only mode.

Edited groups remain draggable, so group reordering works without leaving edit mode. Pool drag handles can also move pools between simultaneously edited groups.

Creating a group with the bottom **+** button asks for its name and opens the new group in edit mode. Cloning a group asks for the clone's name, creates an inactive copy, and opens the clone in edit mode. A cloned group always starts with **Load on browser start** unchecked, even if the source group had it enabled. Deleting an active group unloads it; no neighboring group is activated automatically. Zero active groups and zero stored groups are valid states.

### Reactive saving

There is no page-level **Save** button and no persistent “last action” status/footer. Valid changes are saved automatically.

Checkboxes and structural operations commit immediately. Text and number fields are kept locally while being typed and commit when the edit is finalized, normally on change/blur, so half-typed values are not persisted. If a value cannot be saved, an error banner appears near the Pool groups section and the pending edit remains available for correction.

Leaving or reloading the settings page while an unsaved invalid/in-progress edit remains invokes Firefox's native `beforeunload` confirmation.

### Shortcuts

The settings hint is:

> Type shortcuts as text, for example `Ctrl+Shift+1` or `F13`. Leave blank for no shortcut.

Shortcut text is still normalized automatically when the shortcut field loses focus. For example, `ctrl shift  1` becomes `Ctrl+Shift+1`. Clicking **Done** also formats that group's shortcut fields before validation and refuses to leave edit mode if a shortcut cannot be parsed.

The **Browser shortcut settings** button opens Firefox's Manage Extension Shortcuts page. Before opening it, pending valid editor data is committed. When focus returns, changes made there are mapped back to the pool identities that owned those command slots when the Firefox page was opened and are then stored automatically.

### Group merge

The existing group-merge operation is retained. Because several groups can now be edited simultaneously, the merge arrow is shown only when exactly one group is in edit mode, which leaves a single unambiguous merge target. With two or more edited groups, pool drag-and-drop can be used to move individual pools between them.

A merge appends the source group's pools to the edited target and keeps the source by default. The dialog can make the merge destructive by selecting **Remove “source” after merging (destructive)**. Existing merge compatibility checks remain in place, including pool limits, shortcut collisions, active-group conflicts, and the rule that two active groups cannot be merged while both remain active.

All create/rename/clone/delete/merge confirmations use in-page HTML dialogs rather than JavaScript `prompt()` or `confirm()`.

## Group graph

The **Group graph** remains a top-level section alongside **Settings** and **Pool groups** and now contains two graphs that reuse the same compatibility machinery.

**Active grous** shows the runtime active set: loaded groups are highlighted with the normal active accent; a solid edge means the endpoint groups can coexist while keeping the groups loaded now; a thinner dotted edge means the pair can coexist with each other but not with the complete current loaded subset; and no edge means the pair itself is incompatible because of the 32-pool limit or a shortcut collision. Clicking a loaded node unloads it. Clicking an unloaded node uses the same activation path as **Load**.

**Startup graph** applies the same rules to the groups scheduled for browser startup. Scheduled nodes and their selected-to-selected edges are highlighted in orange. Clicking a scheduled node removes it from startup; clicking another compatible node schedules it. With multiple-group mode disabled, selecting a node replaces the previous startup selection just as loading a group replaces the active set.

Temporarily disabling **Allow multiple groups to be active simultaneously** keeps a private snapshot of the multi-group startup selection while the visible startup state is reduced to one group. Re-enabling the setting restores the remembered startup groups that still exist. Deleting a remembered group while single-group mode is active simply removes that ID from the remembered selection during normalization.

Nodes in both graphs are draggable and share the same saved local layout positions. Group names are shown up to 20 characters and can wrap across two centered lines; node size and label font scale with graph density to preserve spacing. **Default arrangement** clears those positions and rebuilds both computed layouts.

## Popup

The popup has a global On/Off switch labeled **Extension enabled** / **Extension disabled**. Turning the extension off removes unused warm tabs but preserves the active group set. Turning it back on resumes those groups. The switch and the matching Settings toggle are backed by the same configuration value and stay synchronized through extension storage updates.

Every stored group is listed with its name, pool/warm-tab counts, an incompatibility indicator when appropriate, and its own On/Off slider. With multi-group mode enabled, those sliders independently load and unload groups. With multi-group mode disabled, turning one group on replaces the active group.

The popup's pool list is grouped by active group. Enabled pools show ready/loading state, the effective Firefox shortcut for their assigned command slot, and **Take**. If **Take** is clicked during the configured cooldown, the request is ignored and the popup reports the remaining cooldown instead of closing or scheduling the take for later.

The popup shows `N of 32 shortcut slots used · M tabs kept warm`, with the singular form `1 tab kept warm` when appropriate. Pool status is updated automatically; there is no manual refresh/reconciliation control.

## Saving and background synchronization

Every committed transition is serialized by the background process. It validates the configuration, updates Firefox command slots, persists the data, and reconciles warm tabs. If persistence fails after a shortcut remap, the previous shortcut mapping is restored. Take requests use a separate immediate cooldown gate before entering that serialized queue, so blocked rapid repeats are not retained as delayed work.

The obsolete background message used solely to reorder the former separate Active pools list has been removed. Active command order now derives from the single Pool groups ordering.

## Configuration format

Extension version **1.3.0** uses configuration format version **2**. Configuration files in version 1 remain importable and stored version-1 data is migrated automatically. Version-1 startup selections that contain mutually incompatible groups are migrated deterministically by retaining compatible marked groups in normal group order. Newly created version-2 configurations are never allowed to persist an incompatible startup selection.

The stored configuration uses `activeGroupIds`, `allowMultipleGroups`, `reuseRestoredWarmTabs`, `handoffDirection`, `handoffCooldownEnabled`, `handoffCooldownMs`, `multiGroupStartupIds`, stable group/pool IDs, a per-group `loadOnStartup` flag, and a per-group shortcut array. `activeGroupIds` remains the runtime representation of the active set, but normalization derives its order from the unified `poolGroups` order. `multiGroupStartupIds` is the remembered startup selection used only to restore multi-group startup choices after a temporary switch to single-group mode.

Importing a configuration now asks which imported groups should become active. Groups recorded as active by the imported file are checked by default; all others begin unchecked. The selection is validated against the imported multi-group setting, the 32-slot limit, and shortcut collisions before the configuration is committed. Exports always write configuration version 2.

At browser startup, the active set is rebuilt from groups whose `loadOnStartup` flag is enabled. Version-2 saving enforces that the startup set is valid under the same pool-count and shortcut-collision rules as the active set. With multi-group mode disabled, only one group can be scheduled and selecting another replaces it. Groups without the flag are not retained merely because they happened to be active before the previous browser shutdown.

Warm-tab session membership is version 2 and stores the owning `groupId`, `poolId`, URL, creation time, and browser-session identifier. Version-1 membership is still recognized so existing pooled tabs can be adopted after upgrading from 1.2.x.

Every group must use unique non-empty shortcuts across its pool rows. The same validation is enforced by the settings editor, imports, background commits, and startup synchronization.

Explicit configurations with an empty `poolGroups` array remain empty. A genuinely fresh installation receives the normal Default group with one empty pool.

## What “ready” means

The extension considers a tab ready when Firefox reports that the top-level document reached `status === "complete"` and the tab is not discarded. A web application may still defer work until visibility/focus, lazily fetch data, pause background timers, require a user gesture, or reconnect live sessions after activation.

## Hidden tabs and memory

Hidden Firefox tabs keep running. Warm Tab Pool also marks pooled tabs non-discardable. This intentionally trades memory/background resource use for lower handoff latency. Start with size 1 or 2 for heavy applications.

After a pooled tab is handed to you, `autoDiscardable` is restored to `true`, so Firefox can manage it normally later.

If hidden tabs are disabled and you manually activate a pooled tab, the extension treats it as consumed and creates a replacement instead of later handing the same in-use tab out again.

## Installation for testing

1. Unzip the source directory somewhere convenient.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json`.

Temporary extensions are removed when Firefox exits. Standard Firefox release builds require permanently installed extensions to be signed by Mozilla.

## Privacy / permissions

The extension contains no content scripts and requests no host permissions. It does not inject JavaScript into websites or read page contents.

It uses:

- `storage` to save configuration;
- `sessions` to tag pooled tabs so membership can survive session restore; and
- `tabHide` to hide unused warm tabs from the tab strip.

Normal tab-management APIs are used to create, show, activate, move, mute, reload, warm, and remove the extension's own pooled tabs.

Firefox does not provide a reliable self-uninstall cleanup callback in which an extension can asynchronously close its pooled tabs after the user removes the add-on. The extension therefore does not claim uninstall-time tab cleanup; normal pool reconciliation still removes pooled tabs when groups are unloaded, disabled, deleted, or otherwise stop owning them while the extension is running.

## Development

There is no build step and no dependency bundle.

- `manifest.json` — WebExtension manifest and 32 statically declared command slots.
- `common.js` — configuration format, active-group allocation, shortcut formatting, and validation.
- `background.js` — pool lifecycle plus serialized configuration/shortcut synchronization and popup state.
- `popup/` — toolbar popup/status/group toggles.
- `options/` — unified expandable Pool groups editor, multi-group edit state, cross-group pool drag/drop, compatibility graph, and import/export.
- `icons/` — extension icon.

Reload changes from `about:debugging` while developing.

## License

`Warm Tab Pool` is free, open-source software distributed under the [MIT License](LICENSE.txt).
