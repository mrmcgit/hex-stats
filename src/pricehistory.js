// Daily token price history, proxied from DefiLlama.
//
// Why this exists: the web viewer draws a portfolio history chart. On
// PulseChain it can read daily closes straight from the PulseX subgraph in the
// browser, but Ethereum has no equivalent that is both free and CORS-readable,
// so the chart was PulseChain-only while the headline total counted every
// chain. The two numbers disagreed, sometimes by a lot. Running the lookup
// here removes the CORS constraint and lets one cached response serve every
// visitor asking about the same token.
//
// Dates are snapped to UTC midnight so a series from here lines up exactly
// with the subgraph's tokenDayData dates and the two chains can be summed
// day by day.

const LLAMA = "https://coins.llama.fi/chart";

// DefiLlama's chain slugs for the chains the app supports.
const SLUGS = {
  ethereum: "ethereum",
  pulsechain: "pulsechain",
};

const MAX_ADDRESSES = 50;
const MAX_DAYS = 365;
// Kept well under any practical URL length limit for the upstream call.
const BATCH = 20;
// A completed day never changes, and the current day only moves slowly, so a
// few hours of reuse costs nothing in accuracy and saves most upstream calls.
const KV_TTL_SECONDS = 6 * 3600;

const startOfUTCDay = (unixSeconds) => Math.floor(unixSeconds / 86400) * 86400;

const isAddress = (s) => /^0x[0-9a-f]{40}$/.test(s);

/// Fetch one batch of coins and fold it into `out` as { address: [{date, price}] }.
async function fetchBatch(slug, addresses, days, out) {
  const coins = addresses.map((a) => `${slug}:${a}`).join(",");
  const res = await fetch(`${LLAMA}/${coins}?span=${days}&period=1d`, {
    headers: { "User-Agent": "hex-stats/1.0" },
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const body = await res.json();

  for (const [key, value] of Object.entries(body?.coins ?? {})) {
    const address = key.slice(key.indexOf(":") + 1).toLowerCase();
    // One point per UTC day. Later points win, so a day ends up represented by
    // its most recent sample rather than its first.
    const byDate = new Map();
    for (const p of value?.prices ?? []) {
      if (typeof p?.price !== "number" || !isFinite(p.price) || p.price <= 0) continue;
      byDate.set(startOfUTCDay(p.timestamp), p.price);
    }
    // Newest-first, matching the shape the PulseX subgraph path already returns.
    out[address] = [...byDate.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([date, price]) => ({ date, price }));
  }
}

/// Serve { chain, days, byToken } for the requested addresses.
export async function servePriceHistory(env, url) {
  const chain = (url.searchParams.get("chain") || "ethereum").toLowerCase();
  const slug = SLUGS[chain];
  if (!slug) {
    return { error: `unsupported chain "${chain}"`, status: 400 };
  }

  const days = Math.min(
    MAX_DAYS,
    Math.max(1, parseInt(url.searchParams.get("days") || "30", 10) || 30)
  );

  const raw = (url.searchParams.get("addresses") || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const addresses = [...new Set(raw)].filter(isAddress);

  if (!addresses.length) {
    return { error: "no valid addresses (expected comma-separated 0x-prefixed 40-hex)", status: 400 };
  }
  if (addresses.length > MAX_ADDRESSES) {
    return { error: `too many addresses (max ${MAX_ADDRESSES})`, status: 400 };
  }

  const byToken = {};
  const misses = [];

  // Serve whatever KV already holds, and only ask upstream for the rest.
  await Promise.all(
    addresses.map(async (address) => {
      const hit = await env.FEED.get(`ph:${chain}:${address}:${days}`, { type: "json" });
      if (hit) byToken[address] = hit;
      else misses.push(address);
    })
  );

  for (let i = 0; i < misses.length; i += BATCH) {
    const batch = misses.slice(i, i + BATCH);
    try {
      await fetchBatch(slug, batch, days, byToken);
    } catch (e) {
      // A failed batch leaves those tokens absent rather than failing the whole
      // request: a chart missing one token still beats no chart at all.
      console.error(`pricehistory batch failed (${batch.length} tokens): ${e.message}`);
    }
  }

  // Cache only what upstream actually answered for.
  await Promise.all(
    misses
      .filter((a) => byToken[a]?.length)
      .map((a) =>
        env.FEED.put(`ph:${chain}:${a}:${days}`, JSON.stringify(byToken[a]), {
          expirationTtl: KV_TTL_SECONDS,
        })
      )
  );

  return {
    chain,
    days,
    requested: addresses.length,
    covered: Object.keys(byToken).filter((a) => byToken[a]?.length).length,
    byToken,
  };
}
