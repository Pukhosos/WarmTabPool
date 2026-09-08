"use strict";

const poolsElement = document.querySelector("#pools");
const refreshButton = document.querySelector("#refresh");
const refillButton = document.querySelector("#refill");
const optionsButton = document.querySelector("#options");

function poolMeta(status) {
  const parts = [`${status.ready}/${status.size} ready`];
  if (status.loading > 0) {
    parts.push(`${status.loading} loading`);
  }
  if (status.discarded > 0) {
    parts.push(`${status.discarded} reloading`);
  }
  return parts.join(" · ");
}

function render(statuses) {
  const enabled = statuses.filter((status) => status.enabled);
  poolsElement.replaceChildren();

  if (enabled.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No pools are enabled yet. Open Settings to add one.";
    poolsElement.append(empty);
    return;
  }

  for (const status of enabled) {
    const row = document.createElement("section");
    row.className = "pool";

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "pool-name";
    name.textContent = status.name;
    name.title = status.url;

    const meta = document.createElement("div");
    meta.className = "pool-meta";
    meta.textContent = poolMeta(status);

    info.append(name, meta);

    const take = document.createElement("button");
    take.className = "take";
    take.type = "button";
    take.textContent = "Take";
    const warmCandidate = () => {
      void browser.runtime.sendMessage(
        { type: "warm", slot: status.slot }
      ).catch(() => {});
    };
    take.addEventListener("mouseenter", warmCandidate, { once: true });
    take.addEventListener("focus", warmCandidate, { once: true });

    take.addEventListener("click", async () => {
      take.disabled = true;
      try {
        await browser.runtime.sendMessage({ type: "take", slot: status.slot });
        window.close();
      } catch (error) {
        take.disabled = false;
        meta.textContent = `Error: ${error.message}`;
      }
    });

    row.append(info, take);
    poolsElement.append(row);
  }
}

async function refresh({ reconcile = false } = {}) {
  refreshButton.disabled = true;
  try {
    const statuses = await browser.runtime.sendMessage(
      { type: "getStatus", reconcile }
    );
    render(statuses);
  } catch (error) {
    poolsElement.textContent = `Could not read pool status: ${error.message}`;
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => void refresh());
refillButton.addEventListener("click", async () => {
  refillButton.disabled = true;
  try {
    const statuses = await browser.runtime.sendMessage({ type: "reconcile" });
    render(statuses);
  } finally {
    refillButton.disabled = false;
  }
});
optionsButton.addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
  window.close();
});

void refresh({ reconcile: true });
