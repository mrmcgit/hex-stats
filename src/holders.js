// Daily holder counts per token.
//
// PulseScan publishes a token's holder count as a single current number and no
// history at all, so unlike the HEX daily stats this cannot be backfilled from
// anywhere: the series can only be accumulated forward, one row per day.
//
// Collecting it HERE rather than in the app is the whole point. If each install
// accumulated its own history, every user would start from empty on the day they
// installed, a phone that stayed closed for a week would have a week-long hole,
// and everyone would be hitting PulseScan for the same four numbers. Collected
// once by the cron, a brand-new install sees the entire series immediately.
//
// Native PLS is deliberately absent and cannot be added. Holder counts live on a
// token record and a native coin has none — /api/v2/tokens/native returns 422.
// WPLS is tracked as a real number in its own right, NOT as a stand-in for PLS:
// wrapped holders are a different, far smaller population than PLS holders, which
// would run to millions since every address that has ever paid gas holds some.

const KEY = "holders.json";
const SCAN = "https://api.scan.pulsechain.com";

/// Kept in step with holderTrackedTokens in the app.
const TRACKED = [
  { symbol: "HEX", address: "0x2b591e99afe9f32eaa6214f7b7629768c40eeb39" },
  { symbol: "PLSX", address: "0x95b303987a60c71504d99aa1b13b4da07b0790ab" },
  { symbol: "WPLS", address: "0xa1077a294dde1b09bb078844df40758a5d0f9a27" },
  { symbol: "INC", address: "0x2fa878ab3f87cc1c9737fc071108f904c0b0c95d" },
];

const DAY = 86400;
const isoDay = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

// PulseScan's edge answers a plain request with a 502; it wants these.
const SCAN_HEADERS = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  "User-Agent": "hex-stats/1.0",
  Accept: "application/json",
};

/// Current holder count for one token, or null.
async function holderCount(address) {
  try {
    const res = await fetch(`${SCAN}/api/v2/tokens/${address}`, { headers: SCAN_HEADERS });
    if (!res.ok) return null;
    const body = await res.json();
    // Arrives as a JSON string, not a number.
    const count = Number(body?.holders);
    return Number.isFinite(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

/// Record today's counts. Re-running on the same day overwrites that row rather
/// than appending a second one.
export async function collectHolders(env) {
  const today = isoDay(Math.floor(Date.now() / 1000));
  const stored = (await env.FEED.get(KEY, { type: "json" })) ?? [];

  const counts = {};
  await Promise.all(
    TRACKED.map(async (token) => {
      const count = await holderCount(token.address);
      if (count) counts[token.address] = count;
    })
  );
  // A day where every lookup failed is not worth storing: a row of nothing would
  // draw as a hole in the chart rather than as the outage it was.
  if (!Object.keys(counts).length) return { skipped: "no counts available" };

  const row = { date: today, holders: counts };
  const merged = [row, ...stored.filter((r) => r.date !== today)].sort((a, b) =>
    a.date < b.date ? 1 : -1
  );
  await env.FEED.put(KEY, JSON.stringify(merged));
  return { collected: today, tokens: Object.keys(counts).length };
}

/// GET /holders — the series, newest-first, plus the token list so a consumer
/// does not have to hardcode which addresses are in it.
export async function serveHolders(env, url) {
  const rows = (await env.FEED.get(KEY, { type: "json" })) ?? [];
  if (!rows.length) return { error: "no holder history collected yet", status: 503 };

  const days = Math.min(
    rows.length,
    Math.max(1, parseInt(url.searchParams.get("days") || String(rows.length), 10) || rows.length)
  );

  return {
    updatedAt: new Date().toISOString(),
    note:
      "Accumulated daily from PulseScan, which publishes no history. Native PLS is absent: holder counts exist only on token records and a native coin has none.",
    tokens: TRACKED,
    days,
    series: rows.slice(0, days),
  };
}
