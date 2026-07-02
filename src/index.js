// hex-stats — Cloudflare Worker
//
// Serves a mirror of the hexstats.today HEX daily-stats feed and keeps the
// PulseChain feed fresh by collecting each newly completed HEX day straight
// from public subgraphs (see src/collector.js).
//
// Storage layout (Workers KV namespace `FEED` — KV is enabled on every
// account by default, so forks deploy with zero account setup):
//   fulldatapulsechain.json   PulseChain daily records, newest-first JSON array
//   fulldata.json             Ethereum daily records (backfill only for now)
//   meta-pulsechain.json      { lastDay, updatedAt, prev } small state object
//
// The big feed blobs are never JSON.parsed inside the Worker. Serving streams
// the object; the daily append prepends one record with string surgery. This
// keeps every invocation comfortably inside the free-tier CPU budget.

import { collectIfNewDay } from "./collector.js";

const PULSECHAIN_FEED = "fulldatapulsechain.json";
const ETHEREUM_FEED = "fulldata.json";
const PULSECHAIN_META = "meta-pulsechain.json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

async function readMeta(env) {
  const meta = await env.FEED.get(PULSECHAIN_META, { type: "json" });
  return meta ?? { lastDay: 0, updatedAt: null, prev: null };
}

/// Append one newly completed day to the PulseChain feed (if there is one).
async function runCollection(env) {
  const meta = await readMeta(env);
  const result = await collectIfNewDay(meta.lastDay, meta.prev);
  if (!result) {
    return { appended: false, lastDay: meta.lastDay, updatedAt: meta.updatedAt };
  }

  const recordJson = JSON.stringify(result.record);

  // Prepend to the newest-first array without parsing the whole blob.
  const text = await env.FEED.get(PULSECHAIN_FEED, { type: "text" });
  let body;
  if (text) {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("[")) throw new Error("stored feed is not a JSON array");
    const inner = trimmed.slice(1).trimStart();
    body = inner.startsWith("]")
      ? `[${recordJson}]`
      : `[${recordJson},${inner}`;
  } else {
    body = `[${recordJson}]`;
  }

  await env.FEED.put(PULSECHAIN_FEED, body);

  const newMeta = {
    lastDay: result.day,
    updatedAt: new Date().toISOString(),
    prev: result.record,
  };
  await env.FEED.put(PULSECHAIN_META, JSON.stringify(newMeta));

  return { appended: true, lastDay: result.day, record: result.record };
}

/// Serve a stored feed blob as a streamed response (no parsing).
async function serveFeed(env, key) {
  const stream = await env.FEED.get(key, { type: "stream" });
  if (!stream) {
    return json(
      { error: `${key} not populated yet — run the backfill (see README)` },
      404
    );
  }
  return new Response(stream, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      ...CORS,
    },
  });
}

/// Backfill: copy an upstream feed's bytes into KV and derive meta from the
/// head of the array (feeds are newest-first). No full parse.
async function backfill(env, chain, sourceUrl) {
  const res = await fetch(sourceUrl, {
    headers: { "User-Agent": "hex-stats/1.0" },
  });
  if (!res.ok) return json({ error: `upstream HTTP ${res.status}` }, 502);
  const buf = await res.arrayBuffer();
  const head = new TextDecoder().decode(buf.slice(0, 8192)).trimStart();
  if (!head.startsWith("[")) return json({ error: "upstream is not a JSON array" }, 502);

  // First record = newest (both upstream feeds are newest-first). Extract it
  // from the head chunk to seed meta without parsing the full 4-5 MB blob.
  const firstEnd = head.indexOf("},");
  let first = null;
  try {
    first = JSON.parse(head.slice(1, firstEnd + 1));
  } catch {
    return json({ error: "could not parse first record from feed head" }, 502);
  }

  // Sanity: tail should contain a lower currentDay than the head (newest-first).
  const tail = new TextDecoder().decode(buf.slice(-8192));
  const tailDays = [...tail.matchAll(/"currentDay"\s*:\s*(\d+)/g)].map((m) => +m[1]);
  const tailDay = tailDays.length ? tailDays[tailDays.length - 1] : null;
  if (tailDay !== null && tailDay > first.currentDay) {
    return json(
      { error: `feed appears oldest-first (head day ${first.currentDay}, tail day ${tailDay}) — normalize with scripts/backfill.mjs instead` },
      422
    );
  }

  const feedKey = chain === "ethereum" ? ETHEREUM_FEED : PULSECHAIN_FEED;
  await env.FEED.put(feedKey, buf);

  if (chain !== "ethereum") {
    await env.FEED.put(
      PULSECHAIN_META,
      JSON.stringify({
        lastDay: first.currentDay,
        updatedAt: new Date().toISOString(),
        prev: first,
      })
    );
  }

  return json({
    backfilled: chain,
    bytes: buf.byteLength,
    newestDay: first.currentDay,
    newestDate: first.date,
  });
}

function authorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return env.ADMIN_TOKEN && auth === `Bearer ${env.ADMIN_TOKEN}`;
}

export default {
  async scheduled(_event, env, _ctx) {
    try {
      const result = await runCollection(env);
      console.log("cron collection:", JSON.stringify(result).slice(0, 500));
    } catch (e) {
      console.error("cron collection failed:", e.message);
    }
  },

  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Public feed endpoints (drop-in compatible with hexstats.today paths)
    if (request.method === "GET") {
      if (path === "/fulldatapulsechain") return serveFeed(env, PULSECHAIN_FEED);
      if (path === "/fulldata") return serveFeed(env, ETHEREUM_FEED);
      if (path === "/livedata") {
        return json(
          { error: "livedata is not mirrored yet — use /fulldatapulsechain's newest record" },
          501
        );
      }
      if (path === "/" || path === "/health") {
        const meta = await readMeta(env);
        return json({
          service: "hex-stats",
          chain: "pulsechain",
          lastDay: meta.lastDay,
          updatedAt: meta.updatedAt,
          endpoints: ["/fulldatapulsechain", "/fulldata"],
        });
      }
    }

    // Admin endpoints (Bearer ADMIN_TOKEN)
    if (request.method === "POST" && path.startsWith("/admin/")) {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

      if (path === "/admin/collect") {
        try {
          return json(await runCollection(env));
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }
      if (path === "/admin/backfill") {
        const chain = url.searchParams.get("chain") || "pulsechain";
        const source =
          url.searchParams.get("source") ||
          (chain === "ethereum"
            ? "https://hexstats.today/fulldata"
            : "https://hexstats.today/fulldatapulsechain");
        try {
          return await backfill(env, chain, source);
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }
    }

    return json({ error: "not found" }, 404);
  },
};
