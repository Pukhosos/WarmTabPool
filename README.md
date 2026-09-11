# Warm Tab Pool

Warm Tab Pool is a Firefox WebExtension that keeps configurable web pages preloaded in background tabs and hands one to you when you press a shortcut or click **Take**.

A pool is a URL plus a desired number of preloaded copies. Pool groups store separate layouts and shortcuts, and several groups can be active at the same time.

## Core behavior

For every enabled pool in every active group, the extension tries to keep exactly `size` unused tabs available. A pooled tab is loaded in the background, tagged with Firefox session metadata, marked non-discardable, and optionally hidden and muted.

When you take a tab, the extension prefers a completely loaded copy, removes its pool membership before activation, moves it to the focused window when needed, shows and activates it, restores normal discard/audio behavior, and immediately starts replacing it in the background. If the pool is empty, the configured URL opens normally as a cold fallback and the pool is rebuilt.

Hovering or keyboard-focusing a **Take** button also calls Firefox's `tabs.warmup()` for the best candidate when available.

## Active groups and command slots

The manifest declares 32 command slots: `take-pool-1` through `take-pool-32`.

Active groups share those slots in explicit active-group order, then pool order. For example, if the first active group has three pools, its pools use command slots 1–3; the next active group's first pool uses command slot 4. The active-group order is stored in `activeGroupIds` and can be changed by dragging the active group panels in Settings.

The total number of pools across all active groups cannot exceed 32. Disabled pool rows still occupy a slot because their row position is part of the group's shortcut layout. Inactive groups do not consume command slots.

When **Allow multiple groups to be active simultaneously** is disabled, loading a group replaces the active set with that group. When it is enabled, groups can be loaded and unloaded independently.

A group activation is rejected if either:

- the active groups would contain more than 32 pools in total; or
- two active pools would claim the same non-empty shortcut.

The collision check is performed before the active set or Firefox command mapping is committed, so an invalid transition does not partially load.

## Pools

Groups contain a variable number of pools. A newly created group starts with one empty pool. Pools can be added with the **+** button at the bottom of the group editor, deleted, cleared, and reordered by drag handle.

Pool size is independent of pool count and can be 0–64. New and cleared pools default to size 1. Size 0 keeps the pool/shortcut definition but preloads no warm copies, so taking from it uses the cold fallback.

Pool rows have stable internal IDs. Reordering active groups or pools can therefore reassign keyboard command slots without unnecessarily destroying already-warm tabs; warm-tab membership is keyed by group and pool identity rather than by the current command-slot number.

The URL editor wraps and grows vertically so long links remain visible.

## Settings page

The top **Settings** section contains:

- **Allow multiple groups to be active simultaneously**;
- **Hide pooled tabs from the tab strip**; and
- **Mute pooled tabs until they are taken**.

The **Active pools** section shows the current live layout. With no group being edited it shows all active groups. Editing a group opens a visually distinct editor at the top of the section. If that group is active, its editor represents its active block and the group is not duplicated below it. Other active groups remain visible beneath it.

Each read-only active-group header has **Unload** immediately to the left of its pencil edit button, so a group can be removed from the active set without returning to Pool groups.

Click **Done** in the local editor to keep the edits in the page's current draft and exit editing mode. **Done** does not replace the page-level **Save** button: **Save** persists the draft, reapplies command slots, and reconciles warm tabs. When Save is available, it uses the same accent color as loaded nodes in the Group graph.

The shortcut instruction shows the accepted text format with examples such as `Ctrl+Shift+1` and `F13`; leaving a field blank means no shortcut.

The **Browser shortcut settings** button opens Firefox's Manage Extension Shortcuts page. When focus returns, changes made there are mapped back to the pool identities that owned those command slots when the Firefox page was opened. This prevents an unsaved group reorder from accidentally assigning a changed shortcut to the wrong pool.

## Pool groups

The Pool groups section supports any number of groups, including zero. A fresh installation still starts with a Default group, but Default is ordinary data and can be deleted. Deleting the last group leaves an empty configuration; the always-available **+** button can create another group, so there is no softlock.

Each group row provides:

- **Rename**, which asks for a new name without entering edit mode;
- **Clone**, which asks for the clone's name, creates an inactive copy, and opens the clone for editing;
- **Delete**;
- a pencil edit button, which opens the group in the Active pools editor without activating it; and
- a visually separated, fixed-width **Load**/**Unload** button at the far right.

The action columns use fixed widths so the Load/Unload separator stays aligned across group rows even when every group is unloaded.

While a group is being edited, every other group also gets an **↑** merge action. Merging appends the source group's pools to the edited group. The source group is **kept by default**. The merge dialog contains an unchecked **Remove “source” after merging (destructive)** checkbox; selecting it turns the operation into a destructive merge that removes the source group after its pools are appended. The resulting edited group keeps its name. Pool IDs are de-duplicated when necessary.

For a destructive merge, if the source group was active while the edited group was inactive, the edited target takes the source group's active position so an active group is not silently lost. A non-destructive merge leaves the source group's stored and active state unchanged.

Merge compatibility is preflighted continuously against the current editor draft for both modes. A mode is incompatible if the resulting edited group would exceed 32 pools, if a non-empty shortcut would be duplicated inside the merged group, or if the resulting active-group configuration would exceed the 32 command slots or conflict with another active shortcut. The **↑** action is disabled only when neither non-destructive nor destructive merging is possible. If only one mode is possible, the dialog remains available and disables **Merge** until the compatible checkbox state is selected. Hover text and the dialog's information line explain the concrete reason, including the conflicting shortcut.

Creating a group with the bottom **+** button asks for the group name, with a generated default value. The old global group-name field is gone.

Group rows are draggable to organize the stored-group list. This ordering is independent of the live active-group order; active group panels have their own drag handles in **Active pools**, and changing that order immediately remaps command slots while preserving each pool's own stored shortcut and warm-tab identity.

Deleting an active group unloads it; no neighboring group is loaded automatically. Zero active groups and zero stored groups are both valid states.

Group creation, rename, clone, delete, merge, and import confirmation use an in-page HTML dialog rather than JavaScript `prompt()` / `confirm()`. This means Firefox's **Prevent this page from creating additional dialogs** control cannot disable those extension operations and leave the settings UI softlocked. Confirmation-only dialogs do not render a text field; merge uses the same dialog component with its destructive-mode checkbox and compatibility information line.

Group rows and the popup display two compact counts beside each group name: total pool rows and total configured warm tabs. The warm-tab count is the sum of sizes of enabled pools.

## Group graph

The **Group graph** is a top-level settings-page section alongside **Settings**, **Active pools**, and **Pool groups**. It visualizes activation compatibility:

- loaded groups are highlighted, and an edge between two loaded groups is highlighted as well;
- a normal solid edge means the two endpoint groups can coexist while keeping the groups that are loaded now;
- a thinner dotted edge means the two endpoint groups can coexist with each other, but not together with the current loaded subset; and
- no edge means the pair itself is incompatible because of the 32-pool limit or a shortcut collision.

Clicking a loaded node unloads it. Clicking an unloaded node uses the same activation path as the normal Load button, so it either loads the group or reports the same compatibility error. Graph-initiated changes are committed through normal configuration synchronization, so the Active pools section and popup update automatically; popup/group-button changes likewise update the graph through storage changes.

Nodes are draggable. Their custom positions are kept as local options-page UI state. **To default arrangement** clears those positions and rebuilds an evenly spaced ellipse layout. For up to eight groups, the default circular ordering is exhaustively chosen to minimize crossings among structural compatibility edges; larger graphs use a deterministic adjacency-and-crossing-reduction heuristic before equal-spacing placement.

## Saving and live-state operations

The page-level **Save** button is disabled when there are no unsaved pool/global-setting changes. Pool edits, settings changes, or detected browser-shortcut changes enable it. Group-level structural actions (create, clone, rename, delete, merge, and stored-group reorder) are committed immediately so the popup and any other open extension view see the same group list without requiring an extra Save.

Loading/unloading groups and changing active-group order are also live transitions. Every committed transition is serialized by the background process, validates the full active configuration, updates Firefox command slots, persists the configuration, and reconciles warm tabs. If persistence fails after a shortcut remap, the previous shortcut mapping is restored.

The settings page and popup no longer expose manual refresh/reconciliation buttons. Background reconciliation remains automatic because it is part of the pool lifecycle; UI status updates do not request an extra repair pass.

While an active group is being edited, shortcut/pool-limit compatibility is checked against all other active groups as the draft changes. An incompatible draft is reported immediately, disables Save, and cannot be closed with **Done** or committed until the conflict is resolved.

Leaving or reloading the settings page with unsaved changes invokes Firefox's native `beforeunload` confirmation. Firefox controls the exact wording, but the semantics are preserve the draft by staying or discard it by leaving.

## Popup

The popup has a global On/Off switch. Turning the extension off removes unused warm tabs but preserves the set of active group IDs. Turning it back on resumes those same groups.

Below that, every stored group is listed with:

- its name;
- faded counts for pool rows and configured warm tabs;
- an **!** compatibility indicator when the group cannot be loaded together with the current active set; and
- its own On/Off slider.

The compatibility indicator's tooltip contains the concrete reason. The slider remains interactive: attempting the load still runs the normal activation path and displays the same full error message in the popup.

With multi-group mode enabled, those sliders independently load and unload groups. With multi-group mode disabled, turning one group on replaces the active group. Attempts that would exceed the 32 shortcut slots or introduce a shortcut collision are rejected and the popup displays the exact activation error.

The popup's pool list is grouped by active group. Enabled pools show ready/loading state, the effective Firefox shortcut for their assigned command slot, and **Take**.

The popup shows `N of 32 shortcut slots used`, where `N` counts every pool row in the active groups (disabled rows still consume command slots). **Settings** is available in the popup header. Pool status is polled cheaply every 500 ms, while configuration storage changes trigger an immediate state update; neither path requests a manual full reconciliation.

## Configuration schema and migration

Version 1.4.0 uses configuration schema version 4.

Important schema changes include:

- `activeGroupIds` replaces the old single `activeGroupId`;
- `allowMultipleGroups` controls single- versus multi-group activation;
- every pool has a stable internal `id`; and
- warm-tab session membership is version 2 and stores `groupId` plus `poolId`.

Versions 1–3 are normalized automatically. A legacy `activeGroupId` becomes a one-element `activeGroupIds` array. Existing pool rows receive deterministic IDs. Legacy version-1 warm tabs are still recognized during reconciliation and removed so they cannot become orphaned after the membership schema change.

Explicit configurations with an empty `poolGroups` array remain empty. A genuinely fresh installation receives the normal Default group with one empty pool.

## What “ready” means

The extension considers a tab ready when Firefox reports that the top-level document reached `status === "complete"` and the tab is not discarded. That is the strongest generic signal available without injecting site-specific code. A web application may still defer work until visibility/focus, lazily fetch data, pause background timers, require a user gesture, or reconnect live sessions after activation.

## Hidden tabs and memory

Hidden Firefox tabs keep running. Warm Tab Pool also marks pooled tabs non-discardable. This intentionally trades memory/background resource use for lower handoff latency. Start with size 1 or 2 for heavy applications.

After a pooled tab is handed to you, `autoDiscardable` is restored to `true`, so Firefox can manage it normally later.

If hidden tabs are disabled and you manually activate a pooled tab, the extension treats it as consumed and creates a replacement instead of later handing the same in-use tab out again.

## Installation for testing

1. Unzip the source directory somewhere convenient.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json`.

Temporary extensions are removed when Firefox exits.

Standard Firefox release builds require permanent extensions to be signed by Mozilla. For a personal extension, the normal route is to submit it to Mozilla Add-ons as **unlisted** and install the signed XPI Mozilla returns.

## Privacy / permissions

The extension contains no content scripts and requests no host permissions. It does not inject JavaScript into websites or read page contents.

It uses:

- `storage` to save configuration;
- `sessions` to tag pooled tabs so membership can survive session restore; and
- `tabHide` to hide unused warm tabs from the tab strip.

Normal tab-management APIs are used to create, show, activate, move, mute, reload, warm, and remove the extension's own pooled tabs.

## Development

There is no build step and no dependency bundle.

- `manifest.json` — WebExtension manifest and 32 statically declared command slots.
- `common.js` — configuration schema, migration, active-group allocation, and validation.
- `background.js` — pool lifecycle plus the serialized configuration transition state machine (validation, command assignment, persistence, reconciliation), and popup state.
- `popup/` — toolbar popup/status/group toggles.
- `options/` — settings UI, active-group editor, compatibility graph, drag/drop, import/export.
- `icons/` — extension icon.

Reload changes from `about:debugging` while developing.

## License

`Warm Tab Pool` is free, open-source software distributed under the [MIT License](LICENSE.txt).
