// PulseChain burn history: how much PLSX and PLS has been destroyed, per day.
//
// Two burns that have nothing in common except the word.
//
// PLSX is burned by transfer to the zero address, which reduces supply. Those are
// Transfer logs, so the daily figures are exact. Worth stating plainly because the
// obvious approach is wrong: the dead address 0xdEaD holds ~7.3B PLSX in total
// while 0x0 takes tens of millions in an afternoon, so a balanceOf on the burn
// addresses understates it by orders of magnitude.
//
// PLS is burned as EIP-1559 base fee. That is not an event, it is an absence, and
// there is no aggregate anywhere: PulseChain's Blockscout serves gas prices and a
// cumulative total_gas_used, and its only charts are market and transactions.
// Every block carries burnt_fees, but there are ~27M of them. So historical days
// are SAMPLED and scaled, and every row says so via plsEstimated. Any consumer
// that draws this must label it; a burn chart is a money chart, and an estimate
// presented as a measurement is worse than no chart.
//
// The history itself is backfilled offline by scripts/backfill-burns.mjs and
// uploaded to KV. This module serves it and appends each completed day.

const KEY = "burns.json";
const PLSX = "0x95b303987a60c71504d99aa1b13b4da07b0790ab";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x" + "0".repeat(64);

const RPC = "https://rpc.pulsechain.com";
const SCAN = "https://api.scan.pulsechain.com";

// Kept low: eth_getLogs on this filter silently truncates its response above
// roughly 400 logs, returning half-written JSON instead of an error.
const MAX_CHUNK_BLOCKS = 4000;
const PLS_SAMPLES_PER_DAY = 8;

const DAY = 86400;
const utcDayStart = (unix) => Math.floor(unix / DAY) * DAY;
const isoDay = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);
const hex = (n) => "0x" + n.toString(16);

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Truncation signature — the caller splits the range and retries.
    return { truncated: true };
  }
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

async function blockAtTime(unix) {
  const res = await fetch(
    `${SCAN}/api?module=block&action=getblocknobytime&timestamp=${unix}&closest=after`,
    {
      headers: {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "User-Agent": "hex-stats/1.0",
        Accept: "application/json",
      },
    }
  );
  const body = await res.json();
  const n = Number(body?.result?.blockNumber);
  if (!Number.isFinite(n)) throw new Error("no block for timestamp");
  return n;
}

async function plsxBurnedInRange(from, to) {
  if (from > to) return 0n;
  const span = to - from + 1;
  if (span > MAX_CHUNK_BLOCKS) {
    const mid = from + Math.floor(span / 2) - 1;
    const [a, b] = await Promise.all([plsxBurnedInRange(from, mid), plsxBurnedInRange(mid + 1, to)]);
    return a + b;
  }
  const result = await rpc("eth_getLogs", [
    { fromBlock: hex(from), toBlock: hex(to), address: PLSX, topics: [TRANSFER_TOPIC, null, ZERO_TOPIC] },
  ]);
  if (result?.truncated) {
    if (span <= 1) throw new Error(`block ${from} truncates and cannot be split`);
    const mid = from + Math.floor(span / 2) - 1;
    const [a, b] = await Promise.all([plsxBurnedInRange(from, mid), plsxBurnedInRange(mid + 1, to)]);
    return a + b;
  }
  return (result ?? []).reduce((sum, log) => sum + BigInt(log.data), 0n);
}

async function plsBurnedEstimate(from, to) {
  const span = to - from + 1;
  if (span <= 0) return 0;
  const step = Math.max(1, Math.floor(span / PLS_SAMPLES_PER_DAY));
  const blocks = [];
  for (let b = from; b <= to && blocks.length < PLS_SAMPLES_PER_DAY; b += step) blocks.push(b);

  const sampled = await Promise.all(blocks.map((b) => rpc("eth_getBlockByNumber", [hex(b), false])));
  let total = 0;
  let counted = 0;
  for (const block of sampled) {
    if (!block?.baseFeePerGas || !block?.gasUsed) continue;
    total += Number(BigInt(block.baseFeePerGas) * BigInt(block.gasUsed)) / 1e18;
    counted++;
  }
  if (!counted) return 0;
  return (total / counted) * span;
}

/// Collect one completed UTC day. Returns null if that day is already stored.
export async function collectBurnDay(env, dayStartUnix) {
  const stored = (await env.FEED.get(KEY, { type: "json" })) ?? [];
  const date = isoDay(dayStartUnix);
  if (stored.some((r) => r.date === date)) return null;

  const [from, nextFrom] = await Promise.all([
    blockAtTime(dayStartUnix),
    blockAtTime(dayStartUnix + DAY),
  ]);
  const to = nextFrom - 1;
  if (to < from) throw new Error(`empty block range for ${date}`);

  const [plsxRaw, pls] = await Promise.all([plsxBurnedInRange(from, to), plsBurnedEstimate(from, to)]);
  const row = { date, plsx: Number(plsxRaw) / 1e18, pls, plsEstimated: true };

  // Newest-first, matching the other feeds this Worker serves.
  const merged = [row, ...stored.filter((r) => r.date !== date)].sort((a, b) =>
    a.date < b.date ? 1 : -1
  );
  await env.FEED.put(KEY, JSON.stringify(merged));
  return row;
}

/// Cron entry: fill in yesterday, if it is not already there.
export async function runBurnCollection(env) {
  const yesterday = utcDayStart(Math.floor(Date.now() / 1000)) - DAY;
  const row = await collectBurnDay(env, yesterday);
  return row ? { collected: row.date, ...row } : { skipped: "already collected" };
}

const SUPPLY_KEY = "burns-supply.json";
const SUPPLY_TTL_SECONDS = 6 * 3600;

/// Current circulating supply of each token, cached.
///
/// Served alongside the burns because "percent burned" is only meaningful against
/// a supply, and a client holding that as a constant would drift as more is
/// burned. PLSX is read from the token contract. PLS is a native coin with no
/// contract to ask, so it comes from CoinGecko; if that fails the field is null
/// and the consumer must omit the percentage rather than invent one.
async function supplies(env) {
  const cached = await env.FEED.get(SUPPLY_KEY, { type: "json" });
  if (cached) return cached;

  let plsx = null;
  try {
    // totalSupply()
    const res = await rpc("eth_call", [{ to: PLSX, data: "0x18160ddd" }, "latest"]);
    if (res && res !== "0x") plsx = Number(BigInt(res)) / 1e18;
  } catch {}

  let pls = null;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/pulsechain?localization=false&tickers=false&community_data=false&developer_data=false",
      { headers: { "User-Agent": "hex-stats/1.0" } }
    );
    if (res.ok) {
      const body = await res.json();
      const total = body?.market_data?.total_supply;
      if (typeof total === "number" && total > 0) pls = total;
    }
  } catch {}

  const out = { plsx, pls };
  // Only cache a complete answer, so a transient failure is not pinned for hours.
  if (plsx && pls) await env.FEED.put(SUPPLY_KEY, JSON.stringify(out), { expirationTtl: SUPPLY_TTL_SECONDS });
  return out;
}

/// GET /burns — the daily series, newest-first, plus the supply figures a
/// consumer needs to express any of it as a percentage.
export async function serveBurns(env, url) {
  const rows = (await env.FEED.get(KEY, { type: "json" })) ?? [];
  if (!rows.length) return { error: "no burn history collected yet", status: 503 };
  const supply = await supplies(env);

  const days = Math.min(
    rows.length,
    Math.max(1, parseInt(url.searchParams.get("days") || String(rows.length), 10) || rows.length)
  );
  const series = rows.slice(0, days);

  const plsxBurnedTotal = rows.reduce((s, r) => s + (r.plsx || 0), 0);
  const plsBurnedTotal = rows.reduce((s, r) => s + (r.pls || 0), 0);

  return {
    updatedAt: new Date().toISOString(),
    // Exact: summed Transfer(_, 0x0) events.
    plsx: {
      burnedTotal: plsxBurnedTotal,
      currentSupply: supply.plsx,
      // Burning reduces supply, so what existed before it is what is left plus
      // what went. Null when the supply read failed, and then the consumer must
      // show no percentage rather than guess at one.
      supplyBeforeBurns: supply.plsx ? supply.plsx + plsxBurnedTotal : null,
      estimated: false,
      note: "Exact. Summed from Transfer events to the zero address, which reduce supply.",
    },
    // Sampled: see the header of this file.
    pls: {
      burnedTotal: plsBurnedTotal,
      currentSupply: supply.pls,
      supplyBeforeBurns: supply.pls ? supply.pls + plsBurnedTotal : null,
      estimated: true,
      note: "Estimated. EIP-1559 base-fee burn is not an event; each day is sampled across its blocks and scaled.",
    },
    days: series.length,
    series,
  };
}
