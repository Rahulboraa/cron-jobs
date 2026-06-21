// Keepwarm dashboard.
// Reads config/targets.json + data/status.json (committed by the GitHub Action)
// to render status, and writes targets back through the GitHub Contents API
// when a token is configured. No build step, no framework.

const TARGETS_PATH = "config/targets.json";
const SLOW_MS = 2500; // responded, but slow enough to flag
const REFRESH_MS = 60_000; // re-read status while the page is open
const GH = "https://api.github.com";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  targets: [], // [{id,name,url,intervalMinutes,enabled,expectStatus}]
  status: { services: {}, generatedAt: null, schedule: "*/10 * * * *" },
  history: {},
  settings: loadSettings(),
  openIds: new Set(),
  editingId: null,
};

/* ---------------------------------------------------------------- settings */
function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("keepwarm.settings") || "{}");
  } catch {}
  const host = location.hostname;
  const isPages = host.endsWith(".github.io");
  const seg = location.pathname.split("/").filter(Boolean);
  const owner = saved.owner || (isPages ? host.split(".")[0] : "");
  const repo = saved.repo || (isPages ? (seg.length ? seg[0] : `${owner}.github.io`) : "");
  return {
    token: saved.token || "",
    owner,
    repo,
    branch: saved.branch || "main",
  };
}
function saveSettings(s) {
  state.settings = { ...state.settings, ...s };
  localStorage.setItem("keepwarm.settings", JSON.stringify(state.settings));
}
const canWrite = () => Boolean(state.settings.token && state.settings.owner && state.settings.repo);

/* ---------------------------------------------------------------- data load */
async function loadData() {
  const bust = `?t=${Date.now()}`;
  const [targets, status, history] = await Promise.all([
    fetchJson(TARGETS_PATH + bust, { services: [] }),
    fetchJson("data/status.json" + bust, { services: {}, schedule: "*/10 * * * *" }),
    fetchJson("data/history.json" + bust, {}),
  ]);
  state.targets = targets.services || [];
  state.status = status;
  state.history = history;
  render();
}
async function fetchJson(url, fallback) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch {
    return fallback;
  }
}

/* ---------------------------------------------------------------- status model */
function classify(svc) {
  const st = state.status.services?.[svc.id];
  if (!svc.enabled) return { key: "idle", label: "Paused" };
  if (!st || !st.lastPingAt) return { key: "idle", label: "Pending" };
  if (st.ok && st.latencyMs != null && st.latencyMs > SLOW_MS) return { key: "warn", label: "Slow" };
  if (st.ok) return { key: "up", label: "Awake" };
  return { key: "down", label: "Down" };
}

const GLYPHS = {
  up: '<span class="dot"></span>',
  down: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 12 12"><path d="M6 1.5 11 10.5H1z" fill="currentColor"/></svg>',
  idle: '<svg viewBox="0 0 12 12"><rect x="3" y="2.5" width="2" height="7" rx="1" fill="currentColor"/><rect x="7" y="2.5" width="2" height="7" rx="1" fill="currentColor"/></svg>',
};

/* ---------------------------------------------------------------- formatting */
function fmtLatency(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}
function fmtRelative(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function fmtInterval(min) {
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}
function nextRunSeconds() {
  // Schedule is */10 — next run is the next 10-minute boundary.
  const m = parseSchedule(state.status.schedule);
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  const add = m - (now.getMinutes() % m);
  next.setMinutes(now.getMinutes() + add);
  return Math.max(0, Math.round((next - now) / 1000));
}
function parseSchedule(cron) {
  const match = /^\*\/(\d+)/.exec(cron || "");
  return match ? Number(match[1]) : 10;
}
function fmtClock(totalSec) {
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/* ---------------------------------------------------------------- render */
function render() {
  const list = $("#services");
  const empty = $("#empty");
  const writable = canWrite();

  $("#readonly-note").hidden = writable || state.targets.length === 0;
  document.body.dataset.writable = String(writable);

  if (state.targets.length === 0) {
    list.hidden = true;
    empty.hidden = false;
    $("#empty-body").textContent = writable
      ? "Add the URL of a service you want to keep awake. A scheduled job will ping it every few minutes so it never spins down."
      : "Add a GitHub token in Settings to manage services here, or edit config/targets.json in your repo. A scheduled job pings each URL so it never spins down.";
    $$("[data-add-service]").forEach((b) => (b.hidden = !writable));
  } else {
    empty.hidden = true;
    list.hidden = false;
    list.innerHTML = "";
    for (const svc of state.targets) list.appendChild(renderRow(svc, writable));
  }

  renderSummary();
  renderFootnote();
  tick();
}

function renderRow(svc, writable) {
  const st = state.status.services?.[svc.id] || {};
  const cls = classify(svc);
  const li = document.createElement("li");
  li.className = "service";
  li.dataset.id = svc.id;
  li.dataset.paused = String(!svc.enabled);
  li.dataset.open = String(state.openIds.has(svc.id));

  const latencyClass =
    cls.key === "down" ? " metric__value--bad" : cls.key === "warn" ? " metric__value--warn" : "";
  const latencyText = cls.key === "down" ? "down" : fmtLatency(st.latencyMs);

  li.innerHTML = `
    <div class="service__row">
      <span class="pill pill--${cls.key}"><span class="pill__glyph">${GLYPHS[cls.key]}</span>${cls.label}</span>
      <div class="service__id">
        <span class="service__name">${escapeHtml(svc.name)}</span>
        <a class="service__url" href="${escapeAttr(svc.url)}" target="_blank" rel="noopener" title="${escapeAttr(svc.url)}">${escapeHtml(svc.url)}</a>
      </div>
      <div class="service__meta">
        <div class="metric"><span class="metric__value${latencyClass}">${latencyText}</span><span class="metric__label">latency</span></div>
        <div class="metric"><span class="metric__value" data-ts="${st.lastPingAt || ""}">${fmtRelative(st.lastPingAt)}</span><span class="metric__label">last ping</span></div>
        <div class="metric"><span class="metric__value">${fmtInterval(svc.intervalMinutes)}</span><span class="metric__label">every</span></div>
      </div>
      <div class="service__actions">
        ${
          writable
            ? `<label class="toggle" title="${svc.enabled ? "Pause" : "Resume"}">
                 <input type="checkbox" data-act="toggle" ${svc.enabled ? "checked" : ""} aria-label="Keep ${escapeAttr(svc.name)} awake" />
                 <span class="toggle__track"></span>
               </label>`
            : ""
        }
        <button class="iconbtn" data-act="wake" title="Wake now" aria-label="Wake ${escapeAttr(svc.name)} now">
          <svg class="icon" viewBox="0 0 24 24"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"/></svg>
        </button>
        ${
          writable
            ? `<button class="iconbtn" data-act="edit" title="Edit" aria-label="Edit ${escapeAttr(svc.name)}">
                 <svg class="icon" viewBox="0 0 24 24"><path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.2zM14 7l3 3"/></svg>
               </button>
               <button class="iconbtn iconbtn--danger" data-act="delete" title="Remove" aria-label="Remove ${escapeAttr(svc.name)}">
                 <svg class="icon" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7"/></svg>
               </button>`
            : ""
        }
        <button class="iconbtn" data-act="expand" title="History" aria-label="Toggle history for ${escapeAttr(svc.name)}" aria-expanded="${state.openIds.has(svc.id)}">
          <svg class="icon" viewBox="0 0 24 24" style="transition:transform .2s var(--ease);transform:rotate(${state.openIds.has(svc.id) ? 180 : 0}deg)"><path d="m6 9 6 6 6-6"/></svg>
        </button>
      </div>
    </div>
    <div class="service__detail"><div class="service__detail-inner">${renderHistory(svc.id)}</div></div>
  `;
  return li;
}

function renderHistory(id) {
  const entries = state.history?.[id] || [];
  if (!entries.length) {
    return `<div class="history"><span class="history__legend">No pings recorded yet. The first scheduled check will populate this.</span></div>`;
  }
  const latencies = entries.map((e) => e.ms).filter((m) => m != null);
  const max = Math.max(1, ...latencies);
  const oks = entries.filter((e) => e.ok).length;
  const uptime = Math.round((oks / entries.length) * 100);
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  const bars = entries
    .map((e) => {
      if (!e.ok) return `<span class="spark__bar spark__bar--bad" title="${e.t}: failed"></span>`;
      const h = Math.max(8, Math.round((e.ms / max) * 100));
      const slow = e.ms > SLOW_MS ? " spark__bar--warn" : "";
      return `<span class="spark__bar${slow}" style="height:${h}%" title="${e.t}: ${fmtLatency(e.ms)}"></span>`;
    })
    .join("");

  return `<div class="history">
    <div class="spark">${bars}</div>
    <div class="history__legend">
      <span>Last ${entries.length} checks</span>
      <span><strong>${uptime}%</strong> reached${avg != null ? ` · avg <strong>${fmtLatency(avg)}</strong>` : ""}</span>
    </div>
  </div>`;
}

function renderSummary() {
  const el = $("#summary");
  const enabled = state.targets.filter((s) => s.enabled);
  if (enabled.length === 0) {
    el.innerHTML = `<span class="summary__dot"></span>${
      state.targets.length ? "All services paused" : "No services yet"
    }`;
    return;
  }
  let up = 0,
    down = 0,
    pending = 0;
  for (const s of enabled) {
    const k = classify(s).key;
    if (k === "up" || k === "warn") up++;
    else if (k === "down") down++;
    else pending++;
  }
  const dotColor = down ? "var(--down)" : pending ? "var(--idle)" : "var(--up)";
  const phrase =
    up === enabled.length
      ? `<strong>All ${enabled.length}</strong> awake`
      : `<strong>${up}</strong> of <strong>${enabled.length}</strong> awake`;
  el.innerHTML = `<span class="summary__dot" style="background:${dotColor}"></span>${phrase}
    <span class="summary__dot" style="background:var(--border-strong)"></span>
    next check in <span class="mono" id="countdown">${fmtClock(nextRunSeconds())}</span>`;
}

function renderFootnote() {
  $("#foot-updated").textContent = state.status.generatedAt
    ? `last check ${fmtRelative(state.status.generatedAt)}`
    : "no checks yet";
}

/* ---------------------------------------------------------------- live tick */
function tick() {
  const cd = $("#countdown");
  if (cd) cd.textContent = fmtClock(nextRunSeconds());
  $$("[data-ts]").forEach((el) => {
    if (el.dataset.ts) el.textContent = fmtRelative(el.dataset.ts);
  });
  renderFootnote();
}
setInterval(tick, 1000);

/* ---------------------------------------------------------------- GitHub writes */
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function ghHeaders() {
  return {
    Authorization: `Bearer ${state.settings.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
async function commitTargets(message) {
  const { owner, repo, branch } = state.settings;
  const url = `${GH}/repos/${owner}/${repo}/contents/${TARGETS_PATH}`;
  // Get the current file SHA (required to update).
  let sha;
  const cur = await fetch(`${url}?ref=${branch}`, { headers: ghHeaders(), cache: "no-store" });
  if (cur.ok) sha = (await cur.json()).sha;
  else if (cur.status !== 404) throw new Error(await ghError(cur));

  const body = {
    message,
    branch,
    content: toBase64(JSON.stringify({ services: state.targets }, null, 2) + "\n"),
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(url, { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await ghError(res));
}
async function ghError(res) {
  try {
    const j = await res.json();
    return `GitHub ${res.status}: ${j.message || "request failed"}`;
  } catch {
    return `GitHub ${res.status}`;
  }
}

async function persist(message, onError = "Couldn't save to GitHub") {
  try {
    await commitTargets(message);
    return true;
  } catch (err) {
    toast(`${onError}: ${err.message}`, "error");
    await loadData(); // resync to truth
    return false;
  }
}

/* ---------------------------------------------------------------- mutations */
function slugify(name) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "service";
  let id = base;
  let n = 2;
  const ids = new Set(state.targets.map((s) => s.id));
  while (ids.has(id)) id = `${base}-${n++}`;
  return id;
}

async function upsertService(data) {
  if (state.editingId) {
    const svc = state.targets.find((s) => s.id === state.editingId);
    Object.assign(svc, data);
  } else {
    state.targets.push({ id: slugify(data.name), enabled: true, ...data });
  }
  render();
  await persist(state.editingId ? `chore: update ${data.name}` : `chore: add ${data.name}`);
  await loadData();
}

async function toggleService(id, enabled) {
  const svc = state.targets.find((s) => s.id === id);
  svc.enabled = enabled;
  render();
  const ok = await persist(`chore: ${enabled ? "resume" : "pause"} ${svc.name}`);
  if (ok) toast(`${enabled ? "Resumed" : "Paused"} ${svc.name}`);
}

async function deleteService(id) {
  const svc = state.targets.find((s) => s.id === id);
  if (!confirm(`Remove "${svc.name}"? It will no longer be kept awake.`)) return;
  state.targets = state.targets.filter((s) => s.id !== id);
  state.openIds.delete(id);
  render();
  const ok = await persist(`chore: remove ${svc.name}`);
  if (ok) toast(`Removed ${svc.name}`);
}

function wake(svc) {
  // A no-cors request still reaches the server and wakes it, even though we
  // can't read the opaque response.
  fetch(svc.url, { mode: "no-cors", cache: "no-store" }).catch(() => {});
  toast(`Pinged ${svc.name}`);
}

/* ---------------------------------------------------------------- events */
$("#services").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const li = e.target.closest(".service");
  const id = li.dataset.id;
  const svc = state.targets.find((s) => s.id === id);
  const act = btn.dataset.act;
  if (act === "expand") {
    state.openIds.has(id) ? state.openIds.delete(id) : state.openIds.add(id);
    li.dataset.open = String(state.openIds.has(id));
    btn.setAttribute("aria-expanded", String(state.openIds.has(id)));
    btn.querySelector("svg").style.transform = `rotate(${state.openIds.has(id) ? 180 : 0}deg)`;
  } else if (act === "wake") {
    wake(svc);
  } else if (act === "edit") {
    openServiceDialog(svc);
  } else if (act === "delete") {
    deleteService(id);
  }
});
$("#services").addEventListener("change", (e) => {
  const cb = e.target.closest('[data-act="toggle"]');
  if (cb) toggleService(e.target.closest(".service").dataset.id, cb.checked);
});

$("#wake-all").addEventListener("click", () => {
  const enabled = state.targets.filter((s) => s.enabled);
  if (!enabled.length) return toast("No active services to wake", "error");
  enabled.forEach((s) => fetch(s.url, { mode: "no-cors", cache: "no-store" }).catch(() => {}));
  toast(`Pinged ${enabled.length} service${enabled.length > 1 ? "s" : ""}`);
});

/* -------- service dialog -------- */
const serviceDialog = $("#service-dialog");
const serviceForm = $("#service-form");
function openServiceDialog(svc = null) {
  state.editingId = svc?.id || null;
  $("#service-dialog-title").textContent = svc ? "Edit service" : "Add service";
  $("#service-save").textContent = svc ? "Save changes" : "Add service";
  serviceForm.name.value = svc?.name || "";
  serviceForm.url.value = svc?.url || "";
  serviceForm.intervalMinutes.value = svc?.intervalMinutes || 10;
  serviceForm.expectStatus.value = svc?.expectStatus ?? "";
  $("#service-error").hidden = true;
  serviceDialog.showModal();
}
$$("#add-service, [data-add-service]").forEach((b) =>
  b.addEventListener("click", () => openServiceDialog())
);
serviceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#service-error");
  let url;
  try {
    url = new URL(serviceForm.url.value.trim());
    if (!/^https?:$/.test(url.protocol)) throw 0;
  } catch {
    err.textContent = "Enter a valid http(s) URL.";
    err.hidden = false;
    return;
  }
  const save = $("#service-save");
  save.dataset.loading = "true";
  await upsertService({
    name: serviceForm.name.value.trim(),
    url: url.href,
    intervalMinutes: Math.max(5, Number(serviceForm.intervalMinutes.value) || 10),
    expectStatus: serviceForm.expectStatus.value ? Number(serviceForm.expectStatus.value) : null,
  });
  delete save.dataset.loading;
  serviceDialog.close();
  toast(state.editingId ? "Service updated" : "Service added");
});

/* -------- settings dialog -------- */
const settingsDialog = $("#settings-dialog");
const settingsForm = $("#settings-form");
function openSettings() {
  const s = state.settings;
  settingsForm.token.value = s.token || "";
  settingsForm.owner.value = s.owner || "";
  settingsForm.repo.value = s.repo || "";
  settingsForm.branch.value = s.branch || "main";
  $("#settings-repo").textContent = s.owner && s.repo ? `${s.owner}/${s.repo}` : "your repo";
  if (!s.owner || !s.repo) settingsForm.querySelector(".advanced").open = true;
  settingsDialog.showModal();
}
$("#open-settings").addEventListener("click", openSettings);
$$("[data-open-settings]").forEach((b) => b.addEventListener("click", openSettings));
settingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  saveSettings({
    token: settingsForm.token.value.trim(),
    owner: settingsForm.owner.value.trim(),
    repo: settingsForm.repo.value.trim(),
    branch: settingsForm.branch.value.trim() || "main",
  });
  settingsDialog.close();
  toast(canWrite() ? "Settings saved — editing enabled" : "Settings saved");
  render();
});
$("#clear-token").addEventListener("click", () => {
  saveSettings({ token: "" });
  settingsForm.token.value = "";
  toast("Token removed from this browser");
  render();
});

// Generic dialog close buttons + backdrop click.
$$("[data-close]").forEach((b) => b.addEventListener("click", (e) => e.target.closest("dialog").close()));
$$("dialog").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  })
);

/* ---------------------------------------------------------------- toast */
let toastTimer;
function toast(msg, kind = "ok") {
  const host = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast${kind === "error" ? " toast--error" : ""}`;
  el.innerHTML = `<span class="toast__dot"></span>${escapeHtml(msg)}`;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast--exit");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 3200);
}

/* ---------------------------------------------------------------- util */
function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml;

/* ---------------------------------------------------------------- boot */
loadData();
setInterval(loadData, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadData();
});
