// Subgraph + RPC helpers for the PulseChain HEX daily collector.
// All endpoints are free and keyless.

export const HEX_SUBGRAPH_PULSECHAIN =
  "https://graph.pulsechain.com/subgraphs/name/Codeakk/Hex";
export const PULSEX_SUBGRAPH_PULSECHAIN =
  "https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex";
export const PULSECHAIN_RPCS = [
  "https://rpc.pulsechain.com",
  "https://pulsechain-rpc.publicnode.com",
  "https://rpc-pulsechain.g4mm4.io",
];

// HEX contract (same address on Ethereum and PulseChain)
export const HEX_CONTRACT = "0x2b591e99afe9f32eaa6214f7b7629768c40eeb39";
const SELECTOR_CURRENT_DAY = "0x5c9302c9"; // currentDay()

// Token contracts on PulseChain (for PulseX priceUSD lookups)
export const TOKENS = {
  HEX: "0x2b591e99afe9f32eaa6214f7b7629768c40eeb39", // native pHEX
  EHEX: "0x57fde0a71132198bbec939b98976993d8d89d225", // HEX bridged from Ethereum
  WPLS: "0xa1077a294dde1b09bb078844df40758a5d0f9a27",
  PLSX: "0x95b303987a60c71504d99aa1b13b4da07b0790ab",
  INC: "0x2fa878ab3f87cc1c9737fc071108f904c0b0c95d",
};

async function fetchJSONWithRetry(url, init, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const json = await res.json();
      if (json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
      return json;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function graphQuery(endpoint, query) {
  const json = await fetchJSONWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return json.data;
}

/// HEX currentDay() via PulseChain RPC (round-robins the public RPC list).
export async function getCurrentDay() {
  let lastErr;
  for (const rpc of PULSECHAIN_RPCS) {
    try {
      const json = await fetchJSONWithRetry(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: HEX_CONTRACT, data: SELECTOR_CURRENT_DAY }, "latest"],
        }),
      }, 1);
      if (json.result) return parseInt(json.result, 16);
      lastErr = new Error(`RPC error: ${JSON.stringify(json.error).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/// Latest completed daily payout record: { endDay, payout, shares, payoutPerTShare }
export async function getLatestDailyData(currentDay) {
  const data = await graphQuery(HEX_SUBGRAPH_PULSECHAIN, `query {
    dailyDataUpdates(first: 1, orderDirection: desc, orderBy: timestamp,
      where: { endDay_lte: ${currentDay} }) {
      id payout shares payoutPerTShare endDay timestamp
    }
  }`);
  return data.dailyDataUpdates?.[0];
}

/// Global supply snapshot for a HEX day: { totalHeartsinCirculation, lockedHeartsTotal, timestamp }
export async function getGlobalInfoByDay(day) {
  const data = await graphQuery(HEX_SUBGRAPH_PULSECHAIN, `query {
    globalInfos(first: 1, orderBy: timestamp, orderDirection: asc,
      where: { hexDay: ${day} }) {
      totalHeartsinCirculation lockedHeartsTotal blocknumber timestamp
    }
  }`);
  return data.globalInfos?.[0];
}

/// Latest globalInfo regardless of day (fallback when the exact day is missing).
export async function getLatestGlobalInfo() {
  const data = await graphQuery(HEX_SUBGRAPH_PULSECHAIN, `query {
    globalInfos(first: 1, orderBy: timestamp, orderDirection: desc) {
      totalHeartsinCirculation lockedHeartsTotal blocknumber timestamp hexDay
    }
  }`);
  return data.globalInfos?.[0];
}

/// T-share rate as of a unix timestamp: { shareRate, tShareRateHearts, tShareRateHex }
export async function getShareRateAt(timestamp) {
  const data = await graphQuery(HEX_SUBGRAPH_PULSECHAIN, `query {
    shareRateChanges(first: 1, orderDirection: desc, orderBy: timestamp,
      where: { timestamp_lt: ${timestamp} }) {
      shareRate tShareRateHearts tShareRateHex
    }
  }`);
  return data.shareRateChanges?.[0];
}

/// PulseX USD price for a token contract (tokenDayDatas.priceUSD).
/// With `asOfTimestamp`, returns the newest day-price at or before that unix
/// time (so historical collections price the right day); otherwise the latest.
export async function getPulseXPrice(tokenAddress, asOfTimestamp) {
  const dateFilter = asOfTimestamp ? `, date_lte: ${asOfTimestamp}` : "";
  const data = await graphQuery(PULSEX_SUBGRAPH_PULSECHAIN, `query {
    tokenDayDatas(first: 1, orderBy: date, orderDirection: desc,
      where: { token: "${tokenAddress.toLowerCase()}"${dateFilter} }) {
      priceUSD date
    }
  }`);
  const row = data.tokenDayDatas?.[0];
  return row ? parseFloat(parseFloat(row.priceUSD).toFixed(10)) : undefined;
}
