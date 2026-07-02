// PulseChain HEX daily-stat collector.
// Ports the PULSECHAIN branch of hexdailystats' DailyStatHandler
// (https://github.com/togosh/hexdailystats) to a Cloudflare Worker.
// Formulas are kept identical to upstream so records are drop-in compatible.

import {
  getCurrentDay,
  getLatestDailyData,
  getGlobalInfoByDay,
  getLatestGlobalInfo,
  getShareRateAt,
  getPulseXPrice,
  TOKENS,
} from "./subgraph.js";

const HEARTS = 100_000_000; // 1 HEX = 1e8 Hearts
const TSHARE_HEARTS = 1e12; // shares are stored in Hearts-shares

/// Collect one completed HEX day into a feed record.
/// `day` is the completed day (dailyDataUpdates.endDay), `prev` is the previous
/// day's record (for *Change fields) or undefined.
export async function collectPulsechainDay(day, dailyData, prev) {
  // Supply snapshot: first globalInfo event inside the subgraph's day window
  // for this record day (verified against upstream: record 2402 carries the
  // hexDay-2402 asc-first event). Fall back to latest if the day is missing.
  let globalInfo = await getGlobalInfoByDay(day);
  if (!globalInfo) globalInfo = await getLatestGlobalInfo();
  if (!globalInfo) throw new Error("no globalInfo available");

  const timestamp = parseInt(globalInfo.timestamp);
  const circulatingHEX = parseInt(globalInfo.totalHeartsinCirculation) / HEARTS;
  const stakedHEX = parseInt(globalInfo.lockedHeartsTotal) / HEARTS;

  // Daily payout + total T-shares from the subgraph's dailyDataUpdate.
  const dailyPayoutHEX = parseInt(dailyData.payout) / HEARTS;
  const totalTshares = parseInt(dailyData.shares) / TSHARE_HEARTS;

  // T-share rate as of the snapshot timestamp.
  const shareRate = await getShareRateAt(timestamp + 1);
  const tshareRateHEX = shareRate
    ? parseFloat(shareRate.tShareRateHex)
    : undefined;

  // PulseX prices (USD), as of the day snapshot's timestamp.
  const pricePulseX = await getPulseXPrice(TOKENS.HEX, timestamp);
  const priceEHEX = await getPulseXPrice(TOKENS.EHEX, timestamp);
  const pricePulseX_PLS = await getPulseXPrice(TOKENS.WPLS, timestamp);
  const pricePulseX_PLSX = await getPulseXPrice(TOKENS.PLSX, timestamp);
  const pricePulseX_INC = await getPulseXPrice(TOKENS.INC, timestamp);

  // ---- Derived fields (formulas identical to upstream DailyStatHandler) ----
  const penaltiesHEX =
    (dailyPayoutHEX - ((circulatingHEX + stakedHEX) * 10000) / 100448995) * 2;

  const payoutPerTshareHEX =
    totalTshares > 0 ? dailyPayoutHEX / totalTshares : 0;

  const actualAPYRate =
    stakedHEX > 0
      ? parseFloat(((dailyPayoutHEX / stakedHEX) * 365.25 * 100).toFixed(2))
      : undefined;

  const stakedHEXPercent = parseFloat(
    ((stakedHEX / (stakedHEX + circulatingHEX)) * 100).toFixed(2)
  );

  const tshareRateUSD =
    tshareRateHEX && pricePulseX
      ? parseFloat((tshareRateHEX * pricePulseX).toFixed(4))
      : undefined;

  const marketCap = pricePulseX ? pricePulseX * circulatingHEX : undefined;
  const totalValueLocked = pricePulseX ? pricePulseX * stakedHEX : undefined;

  // ---- Change-vs-previous-day fields (when we have the previous record) ----
  const pct = (now, before) =>
    before ? parseFloat((((now - before) / before) * 100).toFixed(4)) : 0;

  const record = {
    date: new Date(timestamp * 1000).toISOString(),
    currentDay: day,
    circulatingHEX,
    stakedHEX,
    tshareRateHEX,
    dailyPayoutHEX,
    totalTshares,
    penaltiesHEX,
    payoutPerTshareHEX,
    actualAPYRate,
    stakedHEXPercent,
    tshareRateUSD,
    marketCap,
    totalValueLocked,
    totalHEX: circulatingHEX + stakedHEX,

    // Field semantics match upstream's PulseChain feed exactly:
    //   pricePulseX = native pHEX price on PulseX
    //   priceUV2    = eHEX (HEX bridged from Ethereum) price on PulseX
    // (verified against upstream day 2402: pricePulseX 0.00085 vs priceUV2 0.00044)
    priceUV2: priceEHEX,
    pricePulseX,
    priceChangePulseX: prev ? pct(pricePulseX, prev.pricePulseX) : 0,
    pricePulseX_PLS,
    pricePulseX_PLSX,
    pricePulseX_INC,
    // Aliases some consumers read directly.
    pricePLS: pricePulseX_PLS,
    pricePLSX: pricePulseX_PLSX,
    priceINC: pricePulseX_INC,

    tshareRateIncrease: prev?.tshareRateHEX
      ? parseFloat((tshareRateHEX - prev.tshareRateHEX).toFixed(4))
      : 0,
    totalTsharesChange: prev?.totalTshares
      ? parseFloat((totalTshares - prev.totalTshares).toFixed(4))
      : 0,
    stakedSupplyChange: prev?.stakedHEX ? stakedHEX - prev.stakedHEX : 0,
    circulatingSupplyChange: prev?.circulatingHEX
      ? circulatingHEX - prev.circulatingHEX
      : 0,
    stakedHEXPercentChange: prev?.stakedHEXPercent
      ? parseFloat((stakedHEXPercent - prev.stakedHEXPercent).toFixed(4))
      : 0,

    // Provenance marker so mirrored-native records are distinguishable from
    // backfilled upstream records.
    _mirror: true,
  };

  // Drop undefined values so JSON stays clean.
  for (const k of Object.keys(record)) {
    if (record[k] === undefined) delete record[k];
  }
  return record;
}

/// Check for a newly completed day and return {day, record} if there is one.
/// `lastDay` is the newest day already stored in the feed.
export async function collectIfNewDay(lastDay, prevRecord) {
  const currentDay = await getCurrentDay();
  const dailyData = await getLatestDailyData(currentDay + 1);
  if (!dailyData) return null;

  const endDay = parseInt(dailyData.endDay);
  if (endDay <= lastDay) return null; // nothing new yet

  const record = await collectPulsechainDay(endDay, dailyData, prevRecord);
  return { day: endDay, record };
}
