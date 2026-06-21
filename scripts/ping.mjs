#!/usr/bin/env node
// Keep-alive ping engine. Runs in GitHub Actions on the cron schedule.
// Reads config/targets.json, pings every service that's due, and writes the
// results to data/status.json and data/history.json. The workflow commits
// any changes back to the repo so the dashboard can read them.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = join(ROOT, "config", "targets.json");
const STATUS = join(ROOT, "data", "status.json");
const HISTORY = join(ROOT, "data", "history.json");

const TIMEOUT_MS = 30_000; // Render cold starts can take ~50s; 30s is a fair "awake?" probe
const HISTORY_CAP = 60; // keep the last 60 pings per service
const DUE_SLACK_MS = 90_000; // cron jitter: treat "almost due" as due so a 10m target isn't skipped to 20m
const FORCE = process.argv.includes("--force") || process.env.FORCE === "true";

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function pingOnce(url, expectStatus) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "cron-scheduler-keepalive/1 (+github-actions)" },
    });
    const latencyMs = Math.round(performance.now() - started);
    // Drain the body so the connection completes and the server fully wakes.
    await res.arrayBuffer().catch(() => {});
    const ok = expectStatus ? res.status === expectStatus : res.ok;
    return { ok, statusCode: res.status, latencyMs, error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      error: aborted ? `Timed out after ${TIMEOUT_MS}ms` : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function isDue(prevPingAt, intervalMinutes) {
  if (FORCE || !prevPingAt) return true;
  const elapsed = Date.now() - new Date(prevPingAt).getTime();
  return elapsed >= intervalMinutes * 60_000 - DUE_SLACK_MS;
}

async function main() {
  const { services = [] } = await readJson(TARGETS, { services: [] });
  const status = await readJson(STATUS, { services: {} });
  const history = await readJson(HISTORY, {});
  status.services ||= {};

  const liveIds = new Set(services.map((s) => s.id));
  let checked = 0;

  for (const svc of services) {
    if (!svc.enabled) continue;
    const prev = status.services[svc.id];
    if (!isDue(prev?.lastPingAt, svc.intervalMinutes ?? 10)) continue;

    const result = await pingOnce(svc.url, svc.expectStatus || null);
    const now = new Date().toISOString();
    checked++;

    status.services[svc.id] = {
      lastPingAt: now,
      ok: result.ok,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      error: result.error,
      totalPings: (prev?.totalPings ?? 0) + 1,
      consecutiveFailures: result.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    };

    const entry = { t: now, ok: result.ok, code: result.statusCode, ms: result.latencyMs };
    history[svc.id] = [...(history[svc.id] ?? []), entry].slice(-HISTORY_CAP);

    const label = result.ok ? `OK ${result.latencyMs}ms` : result.error;
    console.log(`${result.ok ? "✓" : "✗"} ${svc.name} (${svc.url}) — ${label}`);
  }

  // Drop services that were removed from the config.
  for (const id of Object.keys(status.services)) if (!liveIds.has(id)) delete status.services[id];
  for (const id of Object.keys(history)) if (!liveIds.has(id)) delete history[id];

  status.generatedAt = new Date().toISOString();
  status.schedule = process.env.CRON_SCHEDULE || status.schedule || "*/10 * * * *";

  await mkdir(dirname(STATUS), { recursive: true });
  await writeFile(STATUS, JSON.stringify(status, null, 2) + "\n");
  await writeFile(HISTORY, JSON.stringify(history, null, 2) + "\n");

  console.log(`Done. Checked ${checked} of ${services.length} service(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
