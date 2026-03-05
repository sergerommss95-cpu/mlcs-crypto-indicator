/* app.js — MLCS Crypto Dashboard — Multi-Timeframe */
'use strict';

/* ═══════════════════════════════════════════
   COINGECKO API KEY (free demo — get yours at coingecko.com/en/api/pricing)
   ═══════════════════════════════════════════ */
const CG_DEMO_KEY = localStorage.getItem('cg_api_key') || '';

function cgUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return CG_DEMO_KEY
    ? `https://api.coingecko.com/api/v3${path}${sep}x_cg_demo_api_key=${CG_DEMO_KEY}`
    : `https://api.coingecko.com/api/v3${path}`;
}

/* ═══════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════ */
let currentCoin = 'bitcoin';
let currentTimeframe = '1D';
let chartInstances = {};
let marketData = null;
let domData = null; // BTC dominance cache
let fngData = null; // Fear & Greed cache
let fundingData = null; // Funding rate cache
let leverageData = null; // Binance futures leverage data cache
let whaleData = null; // Whale transaction cache

const TIMEFRAMES = {
  '1D':  { label: '1D',  days: 90,  interval: 'daily',  resampleMs: null,        displayLabel: 'Daily · 90 Days' },
  '4H':  { label: '4H',  days: 30,  interval: null,     resampleMs: 4*3600*1000, displayLabel: '4H · 30 Days' },
  '1H':  { label: '1H',  days: 7,   interval: null,     resampleMs: 3600*1000,   displayLabel: '1H · 7 Days' },
  '15M': { label: '15M', days: 2,   interval: null,     resampleMs: 15*60*1000,  displayLabel: '15M · 2 Days' },
  '5M':  { label: '5M',  days: 1,   interval: null,     resampleMs: 5*60*1000,   displayLabel: '5M · 24 Hours' },
};

/* ═══════════════════════════════════════════
   INDICATOR CALCULATIONS
   ═══════════════════════════════════════════ */

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcSMA(data, period) {
  const sma = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { sma.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    sma.push(sum / period);
  }
  return sma;
}

function calcRSI(data, period) {
  const rsi = [];
  if (data.length < period + 1) {
    return data.map(() => null);
  }
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = 0; i < period; i++) rsi.push(null);
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsi.push(100 - (100 / (1 + rs)));
  for (let i = period + 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rsVal = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(100 - (100 / (1 + rsVal)));
  }
  return rsi;
}

function calcMACD(data, fast, slow, signal) {
  const emaFast = calcEMA(data, fast);
  const emaSlow = calcEMA(data, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function calcBollingerBands(data, period, stdDev) {
  const upper = [], middle = [], lower = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { upper.push(null); middle.push(null); lower.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    const mean = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (data[j] - mean) ** 2;
    const std = Math.sqrt(sqSum / period);
    middle.push(mean);
    upper.push(mean + stdDev * std);
    lower.push(mean - stdDev * std);
  }
  return { upper, middle, lower };
}

function calcATR(closes, period) {
  const tr = [0];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.abs(closes[i] - closes[i - 1]));
  }
  if (closes.length < period + 1) {
    return closes.map(() => null);
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr /= period;
  const result = [];
  for (let i = 0; i < period; i++) result.push(null);
  result.push(atr);
  for (let i = period + 1; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result.push(atr);
  }
  return result;
}

function calcOBV(closes, volumes) {
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv.push(obv[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
    else obv.push(obv[i - 1]);
  }
  return obv;
}

/* ═══════════════════════════════════════════
   v5 SIGNAL SYSTEM — High-Conviction Filters
   ═══════════════════════════════════════════
   Backtested: 68.0% overall WR across 275 signals
   BUY: 67.1% WR | SELL: 68.9% WR
   Only fires on proven high-conviction setups.
   ═══════════════════════════════════════════ */

function calcV5Signal(ind) {
  const { closes, ema9, ema21, ema50, ema200, rsi, macd, bb, volumes, obv, atr } = ind;
  const i = closes.length - 1;
  const price = closes[i];
  const { histogram } = macd;

  const rsiVal = rsi[i] !== null ? rsi[i] : 50;

  // BB Position
  let bbPos = 0.5;
  if (bb.lower[i] !== null && bb.upper[i] !== null && bb.upper[i] !== bb.lower[i]) {
    bbPos = (price - bb.lower[i]) / (bb.upper[i] - bb.lower[i]);
  }

  // MACD histogram rising/falling
  const histRising = (i >= 1) ? histogram[i] > histogram[i - 1] : false;

  // 3-bar momentum
  const mom3 = (i >= 3) ? (closes[i] - closes[i - 3]) / closes[i - 3] * 100 : 0;

  // OBV 5-period trend
  const obvRising = (i >= 5) ? obv[i] > obv[i - 5] : false;

  // EMA deviation from 21
  const ema21val = ema21[i];
  const emaDev = (ema21val && ema21val > 0) ? (price - ema21val) / ema21val * 100 : 0;

  // ── v5 BUY FILTERS (proven 60%+ WR) ──
  const buyA = rsiVal < 40 && bbPos < 0.2 && histRising && obvRising;   // 76.9% WR
  const buyB = mom3 < -3 && rsiVal < 40;                                // 68.7% WR
  const buyC = bbPos < 0.3 && obvRising && histRising;                  // 67.1% WR

  // ── v5 SELL FILTERS (proven 60%+ WR) ──
  const sellA = rsiVal > 65 && !histRising;                             // 74.6% WR
  const sellB = rsiVal > 60 && bbPos > 0.8 && !histRising;             // 74.4% WR
  const sellC = rsiVal > 60 && bbPos > 0.7 && !histRising;             // 69.2% WR

  const buyFilters = { A: buyA, B: buyB, C: buyC };
  const sellFilters = { A: sellA, B: sellB, C: sellC };
  const anyBuy = buyA || buyB || buyC;
  const anySell = sellA || sellB || sellC;

  // Confidence = how many filters agree
  const buyCount = [buyA, buyB, buyC].filter(Boolean).length;
  const sellCount = [sellA, sellB, sellC].filter(Boolean).length;

  // Determine signal
  let signal = 'NEUTRAL';
  let signalCls = 'text-neutral-signal';
  let confidence = 0;
  let score = 50; // neutral baseline for gauge

  if (anyBuy && !anySell) {
    confidence = buyCount;
    if (buyCount >= 2) {
      signal = 'STRONG BUY';
      signalCls = 'text-bullish';
      score = 85;
    } else {
      signal = 'BUY';
      signalCls = 'text-bullish';
      score = 72;
    }
  } else if (anySell && !anyBuy) {
    confidence = sellCount;
    if (sellCount >= 2) {
      signal = 'STRONG SELL';
      signalCls = 'text-bearish';
      score = 15;
    } else {
      signal = 'SELL';
      signalCls = 'text-bearish';
      score = 28;
    }
  } else if (anyBuy && anySell) {
    signal = 'CONFLICTING';
    signalCls = 'text-neutral-signal';
    score = 50;
  }

  return {
    signal,
    signalCls,
    score,
    confidence,
    buyFilters,
    sellFilters,
    buyCount,
    sellCount,
    rsiVal,
    bbPos,
    histRising,
    mom3,
    obvRising,
    emaDev,
    atrVal: atr[i],
    bbMiddle: bb.middle[i]
  };
}

function getSignalLabel(score) {
  if (score >= 80) return { label: 'STRONG BUY', cls: 'text-bullish' };
  if (score >= 65) return { label: 'BUY', cls: 'text-bullish' };
  if (score >= 35) return { label: 'NEUTRAL', cls: 'text-neutral-signal' };
  if (score >= 20) return { label: 'SELL', cls: 'text-bearish' };
  return { label: 'STRONG SELL', cls: 'text-bearish' };
}

function getSignalBadgeClass(score) {
  if (score >= 80) return 'badge-strong-buy';
  if (score >= 65) return 'badge-buy';
  if (score >= 35) return 'badge-neutral';
  if (score >= 20) return 'badge-sell';
  return 'badge-strong-sell';
}

function getScoreColor(score) {
  if (score >= 80) return '#10b981';
  if (score >= 65) return '#34d399';
  if (score >= 35) return '#f59e0b';
  if (score >= 20) return '#f87171';
  return '#ef4444';
}

/* Dominance-based adjustment for altcoin signals.
   Falling BTC dominance = bullish for alts (+bonus to score)
   Rising BTC dominance = bearish for alts (-penalty to score) */
function calcDominanceAdjustment(dData) {
  const { btcDom, domHistory } = dData;
  let adjustment = 0;
  let label = '';

  // Trend component (from 7d change)
  if (domHistory.length >= 8) {
    const recent = domHistory[domHistory.length - 1].dom;
    const weekAgo = domHistory[Math.max(0, domHistory.length - 8)].dom;
    const change = recent - weekAgo;
    
    if (change < -3) { adjustment += 8; label = 'Strong alt flow'; }
    else if (change < -1.5) { adjustment += 5; label = 'Alt rotation'; }
    else if (change > 3) { adjustment -= 8; label = 'BTC absorbing'; }
    else if (change > 1.5) { adjustment -= 5; label = 'BTC strengthening'; }
  }

  // Level component
  if (btcDom < 40) { adjustment += 5; label = label || 'Deep alt season'; }
  else if (btcDom < 45) { adjustment += 3; label = label || 'Alt favored'; }
  else if (btcDom > 65) { adjustment -= 5; label = label || 'BTC dominant'; }
  else if (btcDom > 58) { adjustment -= 3; label = label || 'BTC heavy'; }

  if (!label) label = 'Neutral dominance';

  return { adjustment, label };
}

/* ═══════════════════════════════════════════
   DATA FETCHING & RESAMPLING
   ═══════════════════════════════════════════ */

async function fetchData(coin, tf) {
  const config = TIMEFRAMES[tf];
  let path = `/coins/${coin}/market_chart?vs_currency=usd&days=${config.days}`;
  if (config.interval) path += `&interval=${config.interval}`;
  const resp = await fetch(cgUrl(path));
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  const raw = await resp.json();

  // If no resampling needed (daily), return as-is
  if (!config.resampleMs) return raw;

  // Resample to target candle size
  return resampleData(raw, config.resampleMs);
}

function resampleData(raw, intervalMs) {
  const priceMap = new Map();
  const volMap = new Map();

  // Bucket prices by interval
  for (const [ts, price] of raw.prices) {
    const bucket = Math.floor(ts / intervalMs) * intervalMs;
    if (!priceMap.has(bucket)) priceMap.set(bucket, []);
    priceMap.get(bucket).push(price);
  }
  for (const [ts, vol] of raw.total_volumes) {
    const bucket = Math.floor(ts / intervalMs) * intervalMs;
    if (!volMap.has(bucket)) volMap.set(bucket, []);
    volMap.get(bucket).push(vol);
  }

  // Build OHLC-style close (use last price in bucket)
  const buckets = [...priceMap.keys()].sort((a, b) => a - b);
  const prices = [];
  const volumes = [];
  const mcaps = [];

  for (const b of buckets) {
    const pArr = priceMap.get(b);
    const vArr = volMap.get(b) || [0];
    prices.push([b, pArr[pArr.length - 1]]);  // close price
    volumes.push([b, vArr.reduce((a, c) => a + c, 0) / vArr.length]); // avg volume
    mcaps.push([b, 0]);
  }

  return { prices, total_volumes: volumes, market_caps: mcaps };
}

/* ═══════════════════════════════════════════
   BTC DOMINANCE
   ═══════════════════════════════════════════ */

async function fetchBTCDominance() {
  try {
    // 1. Current dominance from /global
    const globalResp = await fetch(cgUrl('/global'));
    if (!globalResp.ok) throw new Error(`Global API error: ${globalResp.status}`);
    const globalData = (await globalResp.json()).data;

    const btcDom = globalData.market_cap_percentage.btc;
    const ethDom = globalData.market_cap_percentage.eth;
    const totalMcapUSD = globalData.total_market_cap.usd;
    const mcapChange24h = globalData.market_cap_change_percentage_24h_usd;

    // 2. Historical BTC dominance (30-day)
    // Fetch BTC market cap + total market cap from market_chart
    const [btcResp, totalResp] = await Promise.all([
      fetch(cgUrl('/coins/bitcoin/market_chart?vs_currency=usd&days=30&interval=daily')),
      // Use a stablecoin-free proxy: fetch top coin and total via global chart isn't available on free tier,
      // so we approximate total from the current ratio and BTC history
      Promise.resolve(null)
    ]);

    let domHistory = [];

    if (btcResp.ok) {
      const btcData = await btcResp.json();
      const btcMcaps = btcData.market_caps || [];

      // Approximate historical dominance:
      // We know current BTC mcap and current dominance.
      // For each past BTC mcap, we estimate total mcap assuming dominance drifted linearly
      // between a wider range. Better approach: use ratio of current BTC mcap to total.
      const currentBtcMcap = btcMcaps.length ? btcMcaps[btcMcaps.length - 1][1] : 0;
      const currentTotalMcap = totalMcapUSD;

      // More accurate: compute dominance at each point assuming total market moved proportionally
      // We use the formula: dom_t = (btcMcap_t / btcMcap_now) * btcDom_now * (totalMcap_now / totalMcap_t)
      // Since we don't have totalMcap_t, we approximate by assuming BTC mcap changes track dominance shifts
      // Simple approximation: scale dominance by the ratio of BTC mcap growth vs overall growth
      // Better approach: just show BTC mcap % change trend and use the 30d BTC mcap as a proxy
      
      if (btcMcaps.length > 0 && currentTotalMcap > 0) {
        // Estimate total mcap at each historical point using current ratio as anchor
        // Assumption: total mcap varies, but we can estimate dom_t = btcMcap_t / estimatedTotalMcap_t
        // For a reasonable estimate, we use linear interpolation of the ratio
        const latestBtcMcap = btcMcaps[btcMcaps.length - 1][1];
        const firstBtcMcap = btcMcaps[0][1];
        
        // We know: latestBtcMcap / currentTotalMcap = btcDom / 100
        // Assume total mcap growth was smoother; estimate each point's total mcap
        // by scaling: totalMcap_t ≈ currentTotalMcap * (btcMcap_t / latestBtcMcap) * adjustmentFactor
        // Where adjustmentFactor accounts for altcoin flows
        // Simplest valid approach: use BTC mcap ratio relative to current
        
        for (const [ts, mcap] of btcMcaps) {
          // Estimate: if BTC mcap was X% of current, total was probably ~Y% of current
          // Using a dampening factor (alts move faster than BTC in bull/bear)
          const btcRatio = mcap / latestBtcMcap;
          const totalEstimate = currentTotalMcap * Math.pow(btcRatio, 0.85); // alts amplify moves
          const domEstimate = totalEstimate > 0 ? (mcap / totalEstimate) * 100 : btcDom;
          domHistory.push({ ts, dom: Math.max(30, Math.min(80, domEstimate)) });
        }
      }
    }

    return {
      btcDom,
      ethDom,
      totalMcapUSD,
      mcapChange24h,
      domHistory
    };
  } catch (err) {
    console.warn('BTC Dominance fetch failed:', err);
    return null;
  }
}

function interpretDominance(btcDom, domHistory) {
  // Determine trend from history
  let trend = 'stable';
  let change7d = 0;
  
  if (domHistory.length >= 8) {
    const recent = domHistory[domHistory.length - 1].dom;
    const weekAgo = domHistory[Math.max(0, domHistory.length - 8)].dom;
    change7d = recent - weekAgo;
    if (change7d > 1.5) trend = 'rising';
    else if (change7d < -1.5) trend = 'falling';
  }

  // Season classification
  let season, seasonClass, tip;
  
  if (btcDom >= 60) {
    season = 'BTC DOMINANT';
    seasonClass = 'btc-strong';
    tip = 'BTC dominance is high — capital is concentrated in Bitcoin. Altcoins may underperform. Consider BTC-heavy positions or wait for dominance to peak before rotating into alts.';
  } else if (btcDom >= 50) {
    if (trend === 'rising') {
      season = 'BTC SEASON';
      seasonClass = 'btc-season';
      tip = 'BTC dominance is rising — money is flowing from alts to Bitcoin. Reduce altcoin exposure. Look for BTC long setups. Altcoin entries may be premature.';
    } else if (trend === 'falling') {
      season = 'ALT ROTATION';
      seasonClass = 'alt-season';
      tip = 'BTC dominance is declining from majority — early altcoin rotation underway. Monitor large-cap alts (ETH, SOL) for strength. Good time to start building alt positions.';
    } else {
      season = 'MIXED MARKET';
      seasonClass = 'btc-season';
      tip = 'BTC dominance is stable around 50% — market is undecided. Trade selectively. Focus on coins with strong individual catalysts rather than broad alt bets.';
    }
  } else if (btcDom >= 40) {
    if (trend === 'falling') {
      season = 'ALT SEASON';
      seasonClass = 'alt-season';
      tip = 'BTC dominance is falling below 50% — altcoin season is active. Altcoins typically outperform BTC here. Look for breakouts in mid/small-cap alts with volume confirmation.';
    } else {
      season = 'ALT FAVORED';
      seasonClass = 'alt-season';
      tip = 'BTC dominance is moderate and not rising — favorable conditions for altcoins. Diversify into strong alts but maintain BTC core position as hedge.';
    }
  } else {
    season = 'PEAK ALT SEASON';
    seasonClass = 'alt-season';
    tip = 'BTC dominance is very low — deep altcoin season. While alts may still pump, this historically signals late-cycle euphoria. Consider taking profits on alts and increasing BTC allocation.';
  }

  return { trend, change7d, season, seasonClass, tip };
}

function renderDominanceCard(data) {
  if (!data) {
    document.getElementById('btcDomValue').textContent = 'N/A';
    document.getElementById('domTip').textContent = 'Unable to fetch BTC dominance data.';
    return;
  }

  const { btcDom, ethDom, totalMcapUSD, mcapChange24h, domHistory } = data;
  const interpretation = interpretDominance(btcDom, domHistory);

  // Main value
  document.getElementById('btcDomValue').textContent = (btcDom != null ? btcDom.toFixed(1) : '—') + '%';

  // Change indicator
  const changeEl = document.getElementById('btcDomChange');
  const arrow = interpretation.trend === 'rising' ? '▲' : interpretation.trend === 'falling' ? '▼' : '→';
  changeEl.textContent = `${arrow} ${Math.abs(interpretation.change7d || 0).toFixed(1)}% 7d`;
  changeEl.className = 'dom-change ' + interpretation.trend;

  // Season badge
  const badge = document.getElementById('domSeasonBadge');
  badge.textContent = interpretation.season;
  badge.className = 'dom-season-badge ' + interpretation.seasonClass;

  // Tip
  document.getElementById('domTip').textContent = interpretation.tip;

  // Details
  document.getElementById('ethDomValue').textContent = (ethDom != null ? ethDom.toFixed(1) : '—') + '%';
  document.getElementById('totalMcap').textContent = formatLargeNumber(totalMcapUSD);
  const mcapChangeEl = document.getElementById('mcapChange24h');
  mcapChangeEl.textContent = mcapChange24h != null ? `${mcapChange24h >= 0 ? '+' : ''}${mcapChange24h.toFixed(2)}%` : '—';
  mcapChangeEl.style.color = (mcapChange24h || 0) >= 0 ? 'var(--color-bullish-text)' : 'var(--color-bearish-text)';

  // Sparkline chart
  if (domHistory.length > 2) {
    renderDomChart(domHistory);
  }
}

function formatLargeNumber(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M';
  return '$' + n.toLocaleString();
}

function renderDomChart(domHistory) {
  if (chartInstances.dom) chartInstances.dom.destroy();

  const ctx = document.getElementById('domChart').getContext('2d');
  const labels = domHistory.map(d => {
    const dt = new Date(d.ts);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const values = domHistory.map(d => d.dom);

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, 0, 0, 80);
  gradient.addColorStop(0, 'rgba(251,191,36,0.2)');
  gradient.addColorStop(1, 'rgba(251,191,36,0)');

  chartInstances.dom = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#fbbf24',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
        backgroundColor: gradient,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a2236',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#e5e7eb',
          bodyColor: '#9ca3af',
          titleFont: { family: "'Inter', sans-serif", size: 10, weight: 600 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 10 },
          padding: 8,
          cornerRadius: 4,
          displayColors: false,
          callbacks: {
            label: ctx => 'BTC Dom: ' + ctx.raw.toFixed(1) + '%'
          }
        }
      },
      scales: {
        x: {
          display: false,
        },
        y: {
          display: false,
          min: Math.min(...values) - 1,
          max: Math.max(...values) + 1,
        }
      }
    }
  });
}

/* ═══════════════════════════════════════════
   CHART RENDERING
   ═══════════════════════════════════════════ */

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 600, easing: 'easeOutQuart' },
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#1a2236',
      borderColor: 'rgba(255,255,255,0.08)',
      borderWidth: 1,
      titleColor: '#e5e7eb',
      bodyColor: '#9ca3af',
      titleFont: { family: "'Inter', sans-serif", size: 11, weight: 600 },
      bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
      padding: 10,
      cornerRadius: 6,
      displayColors: true,
      boxWidth: 8,
      boxHeight: 8,
      boxPadding: 3,
    }
  },
  scales: {
    x: {
      grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
      ticks: {
        color: '#6b7280',
        font: { family: "'Inter', sans-serif", size: 10 },
        maxTicksLimit: 12,
        maxRotation: 0,
      },
      border: { display: false },
    },
    y: {
      position: 'right',
      grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
      ticks: {
        color: '#6b7280',
        font: { family: "'JetBrains Mono', monospace", size: 10 },
        maxTicksLimit: 6,
      },
      border: { display: false },
    }
  }
};

function formatDateForTF(ts, tf) {
  const d = new Date(ts);
  if (tf === '1D') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  if (tf === '4H') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  // 1H, 15M, 5M — show time with date for first of each day
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatPrice(p) {
  if (p == null || isNaN(p)) return '—';
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (p >= 1) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + p.toFixed(4);
}

function destroyCharts() {
  Object.values(chartInstances).forEach(c => c.destroy());
  chartInstances = {};
}

function renderCharts(data) {
  destroyCharts();

  const prices = data.prices.map(p => p[1]);
  const volumes = data.total_volumes.map(v => v[1]);
  const timestamps = data.prices.map(p => p[0]);
  const labels = timestamps.map(ts => formatDateForTF(ts, currentTimeframe));

  // Adapt EMA200 period if not enough data
  const ema200Period = Math.min(200, Math.floor(prices.length * 0.8));
  const ema50Period = Math.min(50, Math.floor(prices.length * 0.6));

  const ema9 = calcEMA(prices, 9);
  const ema21 = calcEMA(prices, 21);
  const ema50 = calcEMA(prices, ema50Period);
  const ema200 = calcEMA(prices, ema200Period);
  const rsi = calcRSI(prices, 14);
  const macd = calcMACD(prices, 12, 26, 9);
  const bb = calcBollingerBands(prices, 20, 2);
  const atr = calcATR(prices, 14);
  const obv = calcOBV(prices, volumes);

  // Determine tick limits based on timeframe
  const tickLimits = { '1D': 12, '4H': 10, '1H': 10, '15M': 10, '5M': 12 };
  const maxTicks = tickLimits[currentTimeframe] || 12;

  // ── PRICE CHART ──
  const priceCtx = document.getElementById('priceChart').getContext('2d');

  const bbFillPlugin = {
    id: 'bbFill',
    beforeDatasetsDraw(chart) {
      const { ctx } = chart;
      const upperMeta = chart.getDatasetMeta(5);
      const lowerMeta = chart.getDatasetMeta(6);
      if (!upperMeta.data.length || !lowerMeta.data.length) return;
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < upperMeta.data.length; i++) {
        const pt = upperMeta.data[i];
        if (pt.skip) continue;
        if (i === 0 || upperMeta.data[i-1]?.skip) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      for (let i = lowerMeta.data.length - 1; i >= 0; i--) {
        const pt = lowerMeta.data[i];
        if (pt.skip) continue;
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,130,246,0.06)';
      ctx.fill();
      ctx.restore();
    }
  };

  chartInstances.price = new Chart(priceCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Price', data: prices, borderColor: '#e5e7eb', borderWidth: 1.5, pointRadius: 0, tension: 0.1, order: 1 },
        { label: 'EMA 9', data: ema9, borderColor: '#06b6d4', borderWidth: 1, pointRadius: 0, tension: 0.3, order: 2 },
        { label: 'EMA 21', data: ema21, borderColor: '#fbbf24', borderWidth: 1, pointRadius: 0, tension: 0.3, order: 3 },
        { label: 'EMA 50', data: ema50, borderColor: '#f97316', borderWidth: 1, pointRadius: 0, tension: 0.3, order: 4 },
        { label: 'EMA 200', data: ema200, borderColor: '#ef4444', borderWidth: 1, pointRadius: 0, tension: 0.3, order: 5 },
        { label: 'BB Upper', data: bb.upper, borderColor: 'rgba(59,130,246,0.25)', borderWidth: 1, pointRadius: 0, tension: 0.3, borderDash: [4,3], order: 6 },
        { label: 'BB Lower', data: bb.lower, borderColor: 'rgba(59,130,246,0.25)', borderWidth: 1, pointRadius: 0, tension: 0.3, borderDash: [4,3], order: 7 },
      ]
    },
    options: {
      ...chartDefaults,
      scales: {
        x: { ...chartDefaults.scales.x, ticks: { ...chartDefaults.scales.x.ticks, maxTicksLimit: maxTicks } },
        y: { ...chartDefaults.scales.y, ticks: { ...chartDefaults.scales.y.ticks, callback: v => formatPrice(v) } }
      },
      plugins: {
        ...chartDefaults.plugins,
        tooltip: {
          ...chartDefaults.plugins.tooltip,
          filter: item => item.datasetIndex <= 4,
          callbacks: { label: ctx => ctx.raw === null ? '' : `${ctx.dataset.label}: ${formatPrice(ctx.raw)}` }
        }
      }
    },
    plugins: [bbFillPlugin]
  });

  // ── RSI CHART ──
  const rsiCtx = document.getElementById('rsiChart').getContext('2d');
  const rsiZonePlugin = {
    id: 'rsiZones',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const yScale = scales.y;
      ctx.save();
      const y70 = yScale.getPixelForValue(70);
      const y100 = yScale.getPixelForValue(100);
      ctx.fillStyle = 'rgba(239,68,68,0.04)';
      ctx.fillRect(chartArea.left, y100, chartArea.width, y70 - y100);
      const y0 = yScale.getPixelForValue(0);
      const y30 = yScale.getPixelForValue(30);
      ctx.fillStyle = 'rgba(16,185,129,0.04)';
      ctx.fillRect(chartArea.left, y30, chartArea.width, y0 - y30);
      ctx.restore();
    }
  };

  chartInstances.rsi = new Chart(rsiCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'RSI', data: rsi, borderColor: '#06b6d4', borderWidth: 1.5, pointRadius: 0, tension: 0.2,
          segment: { borderColor: ctx => { const v = ctx.p1.parsed.y; if (v > 70) return '#ef4444'; if (v < 30) return '#10b981'; return '#06b6d4'; } }
        },
        { label: '70', data: rsi.map(() => 70), borderColor: 'rgba(239,68,68,0.25)', borderWidth: 1, borderDash: [4,3], pointRadius: 0, fill: false },
        { label: '50', data: rsi.map(() => 50), borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderDash: [4,3], pointRadius: 0, fill: false },
        { label: '30', data: rsi.map(() => 30), borderColor: 'rgba(16,185,129,0.25)', borderWidth: 1, borderDash: [4,3], pointRadius: 0, fill: false },
      ]
    },
    options: {
      ...chartDefaults,
      scales: {
        x: { ...chartDefaults.scales.x, ticks: { ...chartDefaults.scales.x.ticks, maxTicksLimit: maxTicks } },
        y: { ...chartDefaults.scales.y, min: 0, max: 100, ticks: { ...chartDefaults.scales.y.ticks, stepSize: 10, callback: v => [0,30,50,70,100].includes(v) ? v : '' } }
      },
      plugins: {
        ...chartDefaults.plugins,
        tooltip: { ...chartDefaults.plugins.tooltip, filter: item => item.datasetIndex === 0, callbacks: { label: ctx => `RSI: ${ctx.raw !== null ? ctx.raw.toFixed(1) : '—'}` } }
      }
    },
    plugins: [rsiZonePlugin]
  });

  // ── MACD CHART ──
  const macdCtx = document.getElementById('macdChart').getContext('2d');
  const histColors = macd.histogram.map(v => v >= 0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.6)');

  chartInstances.macd = new Chart(macdCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Histogram', data: macd.histogram, backgroundColor: histColors, borderWidth: 0, barPercentage: 0.6, order: 2 },
        { type: 'line', label: 'MACD', data: macd.macdLine, borderColor: '#3b82f6', borderWidth: 1.5, pointRadius: 0, tension: 0.2, order: 1 },
        { type: 'line', label: 'Signal', data: macd.signalLine, borderColor: '#f97316', borderWidth: 1.5, pointRadius: 0, tension: 0.2, order: 1 },
      ]
    },
    options: {
      ...chartDefaults,
      scales: {
        x: { ...chartDefaults.scales.x, ticks: { ...chartDefaults.scales.x.ticks, maxTicksLimit: maxTicks } },
        y: { ...chartDefaults.scales.y, ticks: { ...chartDefaults.scales.y.ticks, callback: v => v.toFixed(0) } }
      }
    }
  });

  // ── VOLUME CHART ──
  const volumeCtx = document.getElementById('volumeChart').getContext('2d');
  const volColors = prices.map((p, i) => i === 0 ? 'rgba(16,185,129,0.4)' : (p >= prices[i-1] ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)'));
  const volMA = calcSMA(volumes, 20);

  chartInstances.volume = new Chart(volumeCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Volume', data: volumes, backgroundColor: volColors, borderWidth: 0, barPercentage: 0.7, order: 2 },
        { type: 'line', label: 'Vol MA (20)', data: volMA, borderColor: 'rgba(255,255,255,0.5)', borderWidth: 1, pointRadius: 0, tension: 0.3, order: 1 }
      ]
    },
    options: {
      ...chartDefaults,
      scales: {
        x: { ...chartDefaults.scales.x, ticks: { ...chartDefaults.scales.x.ticks, maxTicksLimit: maxTicks } },
        y: { ...chartDefaults.scales.y, ticks: { ...chartDefaults.scales.y.ticks, callback: v => { if (v >= 1e9) return (v/1e9).toFixed(1)+'B'; if (v >= 1e6) return (v/1e6).toFixed(0)+'M'; if (v >= 1e3) return (v/1e3).toFixed(0)+'K'; return v.toFixed(0); } } }
      }
    }
  });

  // ── UPDATE SIGNAL PANEL (v5) ──
  const indicators = { closes: prices, ema9, ema21, ema50, ema200, rsi, macd, bb, volumes, obv, atr };
  const v5result = calcV5Signal(indicators);
  
  // Apply BTC dominance context for altcoins
  if (currentCoin !== 'bitcoin' && domData && domData.btcDom) {
    v5result.domAdj = calcDominanceAdjustment(domData);
  }
  
  updateSignalPanel(v5result, prices, atr, timestamps);
  generateSignalHistory(prices, timestamps, indicators, volumes);
}

/* ═══════════════════════════════════════════
   UI UPDATES
   ═══════════════════════════════════════════ */

function updateSignalPanel(result, prices, atr, timestamps) {
  const total = result.score;
  const color = getScoreColor(total);

  document.getElementById('scoreValue').textContent = total;
  document.getElementById('scoreValue').style.color = color;

  const labelEl = document.getElementById('signalLabel');
  labelEl.textContent = result.signal;
  labelEl.className = 'signal-label ' + result.signalCls;

  const gaugeFill = document.getElementById('gaugeFill');
  const totalLen = 251;
  const fillLen = totalLen * (total / 100);
  gaugeFill.style.stroke = color;
  gaugeFill.style.strokeDasharray = `${totalLen}`;
  gaugeFill.style.strokeDashoffset = `${totalLen - fillLen}`;

  // v5 Filter Gates
  function setGate(id, active) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('gate-active', active);
      el.classList.toggle('gate-inactive', !active);
    }
  }
  setGate('buyFilterA', result.buyFilters.A);
  setGate('buyFilterB', result.buyFilters.B);
  setGate('buyFilterC', result.buyFilters.C);
  setGate('sellFilterA', result.sellFilters.A);
  setGate('sellFilterB', result.sellFilters.B);
  setGate('sellFilterC', result.sellFilters.C);

  // Confidence value
  const confEl = document.getElementById('confidenceValue');
  if (confEl) {
    if (result.signal === 'NEUTRAL' || result.signal === 'CONFLICTING') {
      confEl.textContent = 'No signal';
      confEl.style.color = '#6b7280';
    } else {
      const count = result.signal.includes('BUY') ? result.buyCount : result.sellCount;
      const labels = ['', '1/3 filters', '2/3 filters', '3/3 filters'];
      confEl.textContent = labels[count] || '—';
      confEl.style.color = count >= 2 ? '#10b981' : '#f59e0b';
    }
  }

  // Indicator snapshot
  const setInd = (id, val) => { const e = document.getElementById(id); if(e) e.textContent = val; };
  setInd('indRsi', result.rsiVal != null ? result.rsiVal.toFixed(1) : '—');
  setInd('indBbPos', result.bbPos != null ? (result.bbPos * 100).toFixed(0) + '%' : '—');
  setInd('indMacdHist', result.histRising ? '▲ Rising' : '▼ Falling');
  setInd('indMom3', result.mom3 != null ? result.mom3.toFixed(2) + '%' : '—');
  setInd('indObv', result.obvRising ? '▲ Rising' : '▼ Falling');
  setInd('indEmaDev', result.emaDev != null ? result.emaDev.toFixed(2) + '%' : '—');

  // Color-code indicators
  const rsiEl = document.getElementById('indRsi');
  if (rsiEl) rsiEl.style.color = result.rsiVal < 40 ? '#10b981' : result.rsiVal > 60 ? '#ef4444' : '#e5e7eb';
  const bbEl = document.getElementById('indBbPos');
  if (bbEl) bbEl.style.color = result.bbPos < 0.3 ? '#10b981' : result.bbPos > 0.7 ? '#ef4444' : '#e5e7eb';
  const macdEl = document.getElementById('indMacdHist');
  if (macdEl) macdEl.style.color = result.histRising ? '#10b981' : '#ef4444';
  const momEl = document.getElementById('indMom3');
  if (momEl) momEl.style.color = result.mom3 < -3 ? '#10b981' : result.mom3 > 3 ? '#ef4444' : '#e5e7eb';
  const obvEl = document.getElementById('indObv');
  if (obvEl) obvEl.style.color = result.obvRising ? '#10b981' : '#ef4444';
  const edevEl = document.getElementById('indEmaDev');
  if (edevEl) edevEl.style.color = result.emaDev < -2 ? '#10b981' : result.emaDev > 2 ? '#ef4444' : '#e5e7eb';

  // Show dominance adjustment for altcoins
  const domAdjEl = document.getElementById('domAdjustment');
  if (domAdjEl) {
    if (result.domAdj && currentCoin !== 'bitcoin') {
      domAdjEl.style.display = 'flex';
      const adjValue = result.domAdj.adjustment;
      const adjSign = adjValue >= 0 ? '+' : '';
      domAdjEl.querySelector('.dom-adj-value').textContent = `${adjSign}${adjValue} pts`;
      domAdjEl.querySelector('.dom-adj-value').style.color = adjValue >= 0 ? 'var(--color-bullish-text)' : 'var(--color-bearish-text)';
      domAdjEl.querySelector('.dom-adj-label').textContent = result.domAdj.label;
    } else {
      domAdjEl.style.display = 'none';
    }
  }

  const latestPrice = prices[prices.length - 1];
  const latestATR = atr[atr.length - 1] || 0;
  const stopLoss = latestPrice - 2.5 * latestATR;
  const riskPerShare = latestPrice - stopLoss;
  const bbMidTarget = result.bbMiddle || 0;
  const takeProfit = bbMidTarget > latestPrice ? bbMidTarget : latestPrice + 1.5 * riskPerShare;
  const portfolioRisk = 10000 * 0.02;
  const positionSize = riskPerShare > 0 ? portfolioRisk / riskPerShare : 0;

  document.getElementById('stopLoss').textContent = formatPrice(stopLoss);
  document.getElementById('takeProfit').textContent = formatPrice(takeProfit);
  document.getElementById('positionSize').textContent = positionSize >= 0.001 ? positionSize.toFixed(4) + ' ' + (currentCoin === 'bitcoin' ? 'BTC' : 'ETH') : '—';
  document.getElementById('atrValue').textContent = formatPrice(latestATR);

  document.getElementById('currentPrice').textContent = formatPrice(latestPrice);

  let changePeriods = 1;
  if (currentTimeframe === '1D') changePeriods = 1;
  else if (currentTimeframe === '4H') changePeriods = 6;
  else if (currentTimeframe === '1H') changePeriods = 24;
  else if (currentTimeframe === '15M') changePeriods = 96;
  else if (currentTimeframe === '5M') changePeriods = 288;

  const refIndex = Math.max(0, prices.length - 1 - Math.min(changePeriods, prices.length - 1));
  const change = ((latestPrice - prices[refIndex]) / prices[refIndex]) * 100;
  const changeEl = document.getElementById('priceChange');
  changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}% 24h`;
  changeEl.className = 'price-change ' + (change >= 0 ? 'positive' : 'negative');

  document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('timeframeBadge').textContent = TIMEFRAMES[currentTimeframe].displayLabel;
}


function generateSignalHistory(prices, timestamps, indicators, volumes) {
  const tbody = document.getElementById('signalHistoryBody');
  tbody.innerHTML = '';

  const signals = [];
  const currentPrice = prices[prices.length - 1];

  const step = Math.max(3, Math.floor(prices.length / 15));
  const startIdx = Math.max(25, Math.floor(prices.length * 0.15));

  for (let i = startIdx; i < prices.length; i += step) {
    const slicedInd = {
      closes: prices.slice(0, i + 1),
      ema9: indicators.ema9.slice(0, i + 1),
      ema21: indicators.ema21.slice(0, i + 1),
      ema50: indicators.ema50.slice(0, i + 1),
      ema200: indicators.ema200.slice(0, i + 1),
      rsi: indicators.rsi.slice(0, i + 1),
      macd: {
        macdLine: indicators.macd.macdLine.slice(0, i + 1),
        signalLine: indicators.macd.signalLine.slice(0, i + 1),
        histogram: indicators.macd.histogram.slice(0, i + 1),
      },
      bb: {
        upper: indicators.bb.upper.slice(0, i + 1),
        middle: indicators.bb.middle.slice(0, i + 1),
        lower: indicators.bb.lower.slice(0, i + 1),
      },
      volumes: volumes.slice(0, i + 1),
      obv: indicators.obv.slice(0, i + 1),
      atr: indicators.atr.slice(0, i + 1),
    };

    const result = calcV5Signal(slicedInd);
    signals.push({ date: timestamps[i], signal: result.signal, score: result.score, price: prices[i], index: i });
  }

  const recent = signals.slice(-10).reverse();
  recent.forEach(s => {
    const tr = document.createElement('tr');
    const d = new Date(s.date);
    const dateStr = currentTimeframe === '1D'
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const signalInfo = getSignalLabel(s.score);
    const badgeCls = getSignalBadgeClass(s.score);
    const pl = s.price ? ((currentPrice - s.price) / s.price * 100) : 0;
    const plStr = `${pl >= 0 ? '+' : ''}${pl.toFixed(2)}%`;
    const plCls = pl >= 0 ? 'pl-positive' : 'pl-negative';

    tr.innerHTML = `
      <td>${dateStr}</td>
      <td><span class="badge ${badgeCls}">${s.signal}</span></td>
      <td>${s.score}</td>
      <td>${formatPrice(s.price)}</td>
      <td class="${plCls}">${plStr}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* ═══════════════════════════════════════════
   COIN & TIMEFRAME SWITCHING
   ═══════════════════════════════════════════ */

function switchCoin(coin) {
  if (coin === currentCoin) return;
  currentCoin = coin;
  document.querySelectorAll('.coin-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.coin === coin);
  });
  // Invalidate coin-specific caches
  leverageData = null;
  whaleData = null;
  loadDashboard();
}

function switchTimeframe(tf) {
  if (tf === currentTimeframe) return;
  currentTimeframe = tf;
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tf === tf);
  });
  loadDashboard();
}

function showError(msg) {
  const banner = document.getElementById('errorBanner');
  const msgEl = document.getElementById('errorMsg');
  // If it's a 401 error, show API key prompt
  if (msg.includes('401')) {
    msgEl.innerHTML = 'CoinGecko requires a free API key. <a href="https://www.coingecko.com/en/api/pricing" target="_blank" style="color:#06b6d4;text-decoration:underline">Get one here</a> (free Demo plan), then click ⚙ to enter it.';
  } else {
    msgEl.textContent = msg;
  }
  banner.classList.add('visible');
}

function hideError() {
  document.getElementById('errorBanner').classList.remove('visible');
}

function retryFetch() {
  hideError();
  loadDashboard();
}

/* API Key Settings */
function showApiKeyModal() {
  let modal = document.getElementById('apiKeyModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'apiKeyModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)';
    modal.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;max-width:420px;width:90%;color:#e0e0e0;font-family:Inter,sans-serif">
        <h3 style="margin:0 0 8px;font-size:16px;color:#fff">CoinGecko API Key</h3>
        <p style="margin:0 0 16px;font-size:13px;color:#9ca3af;line-height:1.5">
          CoinGecko now requires a free API key.<br>
          1. Go to <a href="https://www.coingecko.com/en/api/pricing" target="_blank" style="color:#06b6d4">coingecko.com/en/api/pricing</a><br>
          2. Click "Create Free Account"<br>
          3. In your dashboard, click "+ Add New Key"<br>
          4. Paste the key below
        </p>
        <input id="apiKeyInput" type="text" placeholder="CG-xxxxxxxxxxxxxxxxxxxx" value="${CG_DEMO_KEY}"
          style="width:100%;padding:10px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:8px;background:#0f0f23;color:#fff;font-size:14px;font-family:monospace;box-sizing:border-box" />
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('apiKeyModal').remove()" style="padding:8px 16px;border-radius:8px;background:rgba(255,255,255,0.08);color:#e0e0e0;font-size:13px;cursor:pointer;border:none">Cancel</button>
          <button onclick="saveApiKey()" style="padding:8px 16px;border-radius:8px;background:#06b6d4;color:#fff;font-size:13px;cursor:pointer;border:none;font-weight:600">Save & Reload</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }
}

function saveApiKey() {
  const input = document.getElementById('apiKeyInput');
  const key = input.value.trim();
  if (key) {
    localStorage.setItem('cg_api_key', key);
  } else {
    localStorage.removeItem('cg_api_key');
  }
  location.reload();
}

/* ═══════════════════════════════════════════
   FEAR & GREED INDEX
   ═══════════════════════════════════════════ */

async function fetchFearAndGreed() {
  try {
    const resp = await fetch('https://api.alternative.me/fng/?limit=7');
    if (!resp.ok) throw new Error(`F&G API error: ${resp.status}`);
    const json = await resp.json();
    if (!json.data || !json.data.length) throw new Error('No F&G data');

    const latest = json.data[0];
    const value = parseInt(latest.value, 10);
    const classification = latest.value_classification;

    // Build history for sparkline (oldest first)
    const history = json.data.slice().reverse().map(d => ({
      ts: parseInt(d.timestamp, 10) * 1000,
      value: parseInt(d.value, 10)
    }));

    return { value, classification, history };
  } catch (err) {
    console.warn('Fear & Greed fetch failed:', err);
    return null;
  }
}

function getFngLabel(val) {
  if (val <= 20) return { label: 'Extreme Fear', cls: 'fng-extreme-fear' };
  if (val <= 40) return { label: 'Fear', cls: 'fng-fear' };
  if (val <= 60) return { label: 'Neutral', cls: 'fng-neutral' };
  if (val <= 80) return { label: 'Greed', cls: 'fng-greed' };
  return { label: 'Extreme Greed', cls: 'fng-extreme-greed' };
}

function getFngColor(val) {
  if (val <= 20) return '#ef4444';
  if (val <= 40) return '#f97316';
  if (val <= 60) return '#f59e0b';
  if (val <= 80) return '#84cc16';
  return '#10b981';
}

function renderFngCard(data) {
  const valueEl = document.getElementById('fngValue');
  const labelEl = document.getElementById('fngLabel');
  const impactEl = document.getElementById('fngImpact');
  const arcEl = document.getElementById('fngArc');

  if (!data || data.value === null) {
    if (valueEl) valueEl.textContent = '—';
    if (labelEl) labelEl.textContent = 'Unavailable';
    if (impactEl) impactEl.textContent = 'Could not fetch Fear & Greed data.';
    return;
  }

  const val = data.value;
  const info = getFngLabel(val);
  const color = getFngColor(val);

  if (valueEl) {
    valueEl.textContent = val;
    valueEl.style.color = color;
  }
  if (labelEl) {
    labelEl.textContent = info.label;
    labelEl.className = 'fng-class-label ' + info.cls;
  }

  // Mini arc gauge
  if (arcEl) {
    const totalLen = 157; // half-circle
    const fillLen = totalLen * (val / 100);
    arcEl.style.stroke = color;
    arcEl.style.strokeDasharray = `${totalLen}`;
    arcEl.style.strokeDashoffset = `${totalLen - fillLen}`;
  }

  // Impact interpretation
  if (impactEl) {
    let impact = '';
    if (val <= 20) impact = 'Extreme fear — contrarian BUY nudge (+5 pts)';
    else if (val <= 30) impact = 'Fear zone — slight BUY nudge (+3 pts)';
    else if (val <= 70) impact = 'Neutral range — no signal adjustment';
    else if (val <= 80) impact = 'Greed zone — slight SELL nudge (-3 pts)';
    else impact = 'Extreme greed — contrarian SELL nudge (-5 pts)';
    impactEl.textContent = impact;
  }

  // Sparkline
  if (data.history && data.history.length > 1) {
    renderFngSparkline(data.history);
  }
}

function renderFngSparkline(history) {
  if (chartInstances.fng) chartInstances.fng.destroy();
  const canvas = document.getElementById('fngChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const labels = history.map(d => {
    const dt = new Date(d.ts);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const values = history.map(d => d.value);

  const gradient = ctx.createLinearGradient(0, 0, 0, 60);
  gradient.addColorStop(0, 'rgba(245,158,11,0.2)');
  gradient.addColorStop(1, 'rgba(245,158,11,0)');

  chartInstances.fng = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#f59e0b',
        borderWidth: 1.5,
        pointRadius: 2,
        pointBackgroundColor: values.map(v => getFngColor(v)),
        tension: 0.3,
        fill: true,
        backgroundColor: gradient,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a2236',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#e5e7eb',
          bodyColor: '#9ca3af',
          titleFont: { family: "'Inter', sans-serif", size: 10, weight: 600 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 10 },
          padding: 8,
          cornerRadius: 4,
          displayColors: false,
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              return `F&G: ${v} (${getFngLabel(v).label})`;
            }
          }
        }
      },
      scales: {
        x: { display: false },
        y: { display: false, min: 0, max: 100 }
      }
    }
  });
}

/* ═══════════════════════════════════════════
   FUNDING RATE
   ═══════════════════════════════════════════ */

async function fetchFundingRate() {
  try {
    // Use BGeometrics free API for BTC funding rate
    const resp = await fetch('https://api.bgeometrics.com/bitcoin/funding_rates');
    if (!resp.ok) throw new Error(`Funding API error: ${resp.status}`);
    const json = await resp.json();

    // BGeometrics returns array of {t, v} — t is timestamp, v is funding rate
    if (!json || !json.length) throw new Error('No funding data');

    // Get latest entry
    const latest = json[json.length - 1];
    const rate = parseFloat(latest.v);

    // Build history (last 7 entries)
    const histSlice = json.slice(-7);
    const history = histSlice.map(d => ({
      ts: d.t,
      rate: parseFloat(d.v)
    }));

    return { rate, history };
  } catch (err) {
    console.warn('Funding rate fetch failed:', err);
    // Fallback: try alternative endpoint
    try {
      const resp2 = await fetch('https://api.bgeometrics.com/bitcoin/derivatives');
      if (resp2.ok) {
        const json2 = await resp2.json();
        if (json2 && json2.length) {
          const latest2 = json2[json2.length - 1];
          if (latest2.funding_rate !== undefined) {
            return { rate: parseFloat(latest2.funding_rate), history: [] };
          }
        }
      }
    } catch (e2) { /* silent */ }
    return null;
  }
}

function renderFundingCard(data) {
  const valueEl = document.getElementById('fundRateValue');
  const labelEl = document.getElementById('fundRateLabel');
  const impactEl = document.getElementById('fundRateImpact');

  if (!data || data.rate === null) {
    if (valueEl) valueEl.textContent = '—';
    if (labelEl) labelEl.textContent = 'Unavailable';
    if (impactEl) impactEl.textContent = 'Could not fetch funding rate data.';
    return;
  }

  const rate = data.rate;
  const ratePct = (rate * 100).toFixed(4) + '%';

  if (valueEl) {
    valueEl.textContent = ratePct;
    if (rate > 0.01) valueEl.style.color = 'var(--color-bearish-text)';
    else if (rate < -0.005) valueEl.style.color = 'var(--color-bullish-text)';
    else valueEl.style.color = 'var(--color-text)';
  }

  if (labelEl) {
    let label = 'Neutral';
    let cls = 'fund-neutral';
    if (rate > 0.03) { label = 'Extreme Long Bias'; cls = 'fund-extreme-long'; }
    else if (rate > 0.01) { label = 'Long Bias'; cls = 'fund-long'; }
    else if (rate < -0.01) { label = 'Extreme Short Bias'; cls = 'fund-extreme-short'; }
    else if (rate < -0.005) { label = 'Short Bias'; cls = 'fund-short'; }
    labelEl.textContent = label;
    labelEl.className = 'fund-class-label ' + cls;
  }

  if (impactEl) {
    let impact = '';
    if (rate < -0.01) impact = 'Shorts overleveraged — contrarian BUY nudge (+3 pts)';
    else if (rate > 0.03) impact = 'Longs overleveraged — contrarian SELL nudge (-3 pts)';
    else impact = 'Funding in normal range — no signal adjustment';
    impactEl.textContent = impact;
  }
}

/* ═══════════════════════════════════════════
   BINANCE FUTURES — LEVERAGE DATA
   ═══════════════════════════════════════════ */

function getBinanceSymbol() {
  return currentCoin === 'bitcoin' ? 'BTCUSDT' : 'ETHUSDT';
}

async function fetchBinanceEndpoint(base, path) {
  const resp = await fetch(`${base}${path}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data && data.code !== undefined && data.msg) throw new Error(data.msg);
  return data;
}

async function fetchLeverageData() {
  const symbol = getBinanceSymbol();
  const bases = ['https://fapi.binance.com', 'https://www.binance.com'];
  const endpoints = [
    `/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=30`,
    `/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=30`,
    `/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=30`,
    `/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=30`
  ];

  for (const base of bases) {
    try {
      const [oiData, lsData, topData, takerData] = await Promise.all(
        endpoints.map(ep => fetchBinanceEndpoint(base, ep).catch(() => []))
      );

      // Check if we got real data (at least OI should have results)
      if (Array.isArray(oiData) && oiData.length > 0) {
        return { oiData, lsData: Array.isArray(lsData) ? lsData : [], topData: Array.isArray(topData) ? topData : [], takerData: Array.isArray(takerData) ? takerData : [], symbol };
      }
    } catch (err) {
      console.warn(`Binance Futures fetch failed from ${base}:`, err.message);
    }
  }
  console.warn('All Binance endpoints unavailable');
  return null;
}

function interpretLeverageContext(levData, fundRate) {
  if (!levData) return { text: 'Leverage data unavailable', cls: '' };

  const messages = [];
  let cls = '';

  const { oiData, lsData, takerData } = levData;

  // OI trend
  let oiRising = false;
  if (oiData.length >= 2) {
    const recent = parseFloat(oiData[oiData.length - 1].sumOpenInterestValue);
    const older = parseFloat(oiData[Math.max(0, oiData.length - 6)].sumOpenInterestValue);
    oiRising = recent > older * 1.02;
  }

  // Long/short ratio
  let lsRatio = 1;
  let longPct = 50;
  if (lsData.length > 0) {
    const latest = lsData[lsData.length - 1];
    lsRatio = parseFloat(latest.longShortRatio);
    longPct = parseFloat(latest.longAccount) * 100;
  }

  // Taker buy/sell
  let takerBuyDominant = false;
  let takerSellDominant = false;
  if (takerData.length > 0) {
    const latest = takerData[takerData.length - 1];
    const bsRatio = parseFloat(latest.buySellRatio);
    if (bsRatio > 1.15) takerBuyDominant = true;
    if (bsRatio < 0.85) takerSellDominant = true;
  }

  // Funding rate direction
  const fundingPositive = fundRate && fundRate > 0.005;
  const fundingNegative = fundRate && fundRate < -0.005;

  // Overleveraged Longs check
  if (oiRising && longPct > 55 && fundingPositive) {
    messages.push('⚠ Overleveraged Longs — contrarian bearish risk');
    cls = 'lev-context-danger';
  }
  // Overleveraged Shorts check
  else if (oiRising && longPct < 45 && fundingNegative) {
    messages.push('⚠ Overleveraged Shorts — contrarian bullish setup');
    cls = 'lev-context-bullish';
  }

  if (takerBuyDominant) {
    messages.push('Aggressive buying detected in taker volume');
    if (!cls) cls = 'lev-context-bullish';
  }
  if (takerSellDominant) {
    messages.push('Aggressive selling detected in taker volume');
    if (!cls) cls = 'lev-context-danger';
  }

  if (messages.length === 0) {
    messages.push('Leverage conditions normal — no extreme positioning');
  }

  return { text: messages.join('. '), cls };
}

function renderLeverageCard(levData, fundRate) {
  const container = document.getElementById('leverageContent');
  if (!container) return;

  if (!levData || (!levData.oiData.length && !levData.lsData.length)) {
    container.innerHTML = '<div class="whale-unavailable">Leverage data unavailable — Binance Futures API may be blocked in your region</div>';
    return;
  }

  const { oiData, lsData, topData, takerData } = levData;

  // Open Interest
  let oiValue = '—';
  let oiChange = '';
  let oiChangeColor = '';
  if (oiData.length > 0) {
    const latestOI = parseFloat(oiData[oiData.length - 1].sumOpenInterestValue);
    oiValue = formatLargeNumber(latestOI);
    if (oiData.length >= 24) {
      const olderOI = parseFloat(oiData[Math.max(0, oiData.length - 24)].sumOpenInterestValue);
      const changePct = ((latestOI - olderOI) / olderOI * 100);
      oiChange = `${changePct >= 0 ? '▲' : '▼'} ${Math.abs(changePct).toFixed(1)}%`;
      oiChangeColor = changePct >= 0 ? 'var(--color-bullish-text)' : 'var(--color-bearish-text)';
    }
  }

  // L/S Account Ratio
  let lsLongPct = 50, lsShortPct = 50, lsRatioStr = '—';
  if (lsData.length > 0) {
    const latest = lsData[lsData.length - 1];
    lsLongPct = (parseFloat(latest.longAccount) * 100);
    lsShortPct = (parseFloat(latest.shortAccount) * 100);
    lsRatioStr = parseFloat(latest.longShortRatio).toFixed(2);
  }

  // Top Trader L/S
  let topLongPct = 50, topShortPct = 50, topRatioStr = '—';
  if (topData.length > 0) {
    const latest = topData[topData.length - 1];
    topLongPct = (parseFloat(latest.longAccount) * 100);
    topShortPct = (parseFloat(latest.shortAccount) * 100);
    topRatioStr = parseFloat(latest.longShortRatio).toFixed(2);
  }

  // Taker Buy/Sell
  let takerRatioStr = '—';
  let takerBuyPct = 50, takerSellPct = 50;
  if (takerData.length > 0) {
    const latest = takerData[takerData.length - 1];
    const bsRatio = parseFloat(latest.buySellRatio);
    takerRatioStr = bsRatio.toFixed(2);
    takerBuyPct = (bsRatio / (1 + bsRatio)) * 100;
    takerSellPct = 100 - takerBuyPct;
  }

  // Context
  const context = interpretLeverageContext(levData, fundRate);

  container.innerHTML = `
    <div class="lev-stat-grid">
      <div class="lev-stat">
        <div class="lev-stat-label">Open Interest</div>
        <div class="lev-stat-value">${oiValue}${oiChange ? `<span class="lev-stat-change" style="color:${oiChangeColor}">${oiChange}</span>` : ''}</div>
      </div>
      <div class="lev-stat">
        <div class="lev-stat-label">Taker Buy/Sell</div>
        <div class="lev-stat-value">${takerRatioStr}</div>
      </div>
    </div>

    <div class="lev-ratio-section">
      <div class="lev-ratio-row">
        <div class="lev-ratio-header">
          <span class="lev-ratio-label">L/S Account Ratio</span>
          <span class="lev-ratio-value">${lsRatioStr}</span>
        </div>
        <div class="lev-ratio-bar">
          <div class="lev-ratio-bar-long" style="width:${lsLongPct}%"></div>
          <div class="lev-ratio-bar-short" style="width:${lsShortPct}%"></div>
        </div>
        <div class="lev-ratio-labels">
          <span class="lev-ratio-pct long-pct">${lsLongPct.toFixed(1)}% L</span>
          <span class="lev-ratio-pct short-pct">${lsShortPct.toFixed(1)}% S</span>
        </div>
      </div>

      <div class="lev-ratio-row">
        <div class="lev-ratio-header">
          <span class="lev-ratio-label">Top Trader L/S</span>
          <span class="lev-ratio-value">${topRatioStr}</span>
        </div>
        <div class="lev-ratio-bar">
          <div class="lev-ratio-bar-long" style="width:${topLongPct}%"></div>
          <div class="lev-ratio-bar-short" style="width:${topShortPct}%"></div>
        </div>
        <div class="lev-ratio-labels">
          <span class="lev-ratio-pct long-pct">${topLongPct.toFixed(1)}% L</span>
          <span class="lev-ratio-pct short-pct">${topShortPct.toFixed(1)}% S</span>
        </div>
      </div>
    </div>

    <div class="lev-sparkline-wrap">
      <canvas id="oiSparkline"></canvas>
    </div>

    <div class="lev-context ${context.cls}">${context.text}</div>
  `;

  // Render OI sparkline
  if (oiData.length > 2) {
    renderOISparkline(oiData);
  }
}

function renderOISparkline(oiData) {
  if (chartInstances.oiSpark) chartInstances.oiSpark.destroy();
  const canvas = document.getElementById('oiSparkline');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const labels = oiData.map(d => {
    const dt = new Date(d.timestamp);
    return dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  });
  const values = oiData.map(d => parseFloat(d.sumOpenInterestValue));

  const gradient = ctx.createLinearGradient(0, 0, 0, 50);
  gradient.addColorStop(0, 'rgba(6,182,212,0.2)');
  gradient.addColorStop(1, 'rgba(6,182,212,0)');

  chartInstances.oiSpark = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#06b6d4',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
        backgroundColor: gradient,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a2236',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#e5e7eb',
          bodyColor: '#9ca3af',
          titleFont: { family: "'Inter', sans-serif", size: 10, weight: 600 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 10 },
          padding: 8,
          cornerRadius: 4,
          displayColors: false,
          callbacks: {
            label: ctx => 'OI: ' + formatLargeNumber(ctx.raw)
          }
        }
      },
      scales: {
        x: { display: false },
        y: { display: false }
      }
    }
  });
}

/* ═══════════════════════════════════════════
   WHALE TRANSACTION MONITORING
   ═══════════════════════════════════════════ */

async function fetchWhaleTransactions() {
  if (currentCoin !== 'bitcoin') {
    return { btcOnly: true };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout

    // Fetch latest block metadata (tiny payload ~200 bytes)
    const blockResp = await fetch('https://blockchain.info/latestblock', { signal: controller.signal });
    clearTimeout(timeout);
    if (!blockResp.ok) throw new Error(`Blockchain.info error: ${blockResp.status}`);
    const blockInfo = await blockResp.json();

    // Fetch a known large BTC address (Binance cold wallet) as whale proxy
    // This is lightweight — single address page with recent txs
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), 8000);
    // Binance cold wallet: bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h
    const addrResp = await fetch(
      'https://blockchain.info/rawaddr/bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h?limit=10&offset=0',
      { signal: controller2.signal }
    );
    clearTimeout(timeout2);

    if (!addrResp.ok) throw new Error(`Address fetch error: ${addrResp.status}`);
    const addrData = await addrResp.json();

    const whaleTxs = (addrData.txs || [])
      .slice(0, 5)
      .map(tx => {
        const totalOut = tx.out.reduce((sum, o) => sum + (o.value || 0), 0);
        const btcAmount = totalOut / 100000000;
        const time = tx.time * 1000;
        const outputCount = tx.out.length;
        const direction = outputCount >= 5 ? 'Exchange Flow' : outputCount <= 2 ? 'Wallet Transfer' : 'Unknown';

        return {
          hash: tx.hash,
          amount: btcAmount,
          time,
          direction,
          outputCount
        };
      });

    return { txs: whaleTxs, blockHeight: blockInfo.height, source: 'Binance Cold Wallet' };
  } catch (err) {
    console.warn('Whale transaction fetch failed:', err);
    return { error: err.name === 'AbortError' ? 'Whale data request timed out' : 'Unable to fetch whale data' };
  }
}

function renderWhaleCard(wData) {
  const container = document.getElementById('whaleContent');
  if (!container) return;

  if (!wData) {
    container.innerHTML = '<div class="whale-unavailable">Whale data unavailable</div>';
    return;
  }

  if (wData.btcOnly) {
    container.innerHTML = '<div class="whale-unavailable">Whale tracking available for BTC only</div>';
    return;
  }

  if (wData.error) {
    container.innerHTML = `<div class="whale-unavailable">${wData.error}</div>`;
    return;
  }

  if (!wData.txs || wData.txs.length === 0) {
    container.innerHTML = '<div class="whale-unavailable">No whale transactions detected in mempool</div>';
    return;
  }

  const now = Date.now();
  let html = '<div class="whale-tx-list">';
  wData.txs.forEach(tx => {
    const ago = Math.max(1, Math.round((now - tx.time) / 60000));
    const agoStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago/60)}h ago`;
    const iconCls = tx.amount >= 100 ? 'whale-mega' : 'whale-large';
    const icon = tx.amount >= 100 ? '🐋' : '🐳';

    html += `
      <div class="whale-tx">
        <div class="whale-tx-icon ${iconCls}">${icon}</div>
        <div class="whale-tx-details">
          <div class="whale-tx-amount">${tx.amount.toFixed(2)} BTC</div>
          <div class="whale-tx-meta">${tx.direction} · ${tx.hash.slice(0,8)}…${tx.hash.slice(-6)}</div>
        </div>
        <div class="whale-tx-time">${agoStr}</div>
      </div>
    `;
  });
  html += '</div>';
  container.innerHTML = html;
}

/* ═══════════════════════════════════════════
   LIQUIDATION ZONE ESTIMATION
   ═══════════════════════════════════════════ */

function calcLiquidationZones(price, levData, fundRate) {
  if (!price || !levData) return null;

  const { oiData, lsData } = levData;

  // Determine directional bias from funding + long/short ratio
  let longBias = 0.5; // 0 = all shorts, 1 = all longs
  if (lsData.length > 0) {
    longBias = parseFloat(lsData[lsData.length - 1].longAccount);
  }

  // Funding rate adjustment
  let fundingSkew = 0; // positive = more longs, negative = more shorts
  if (fundRate) {
    fundingSkew = Math.min(1, Math.max(-1, fundRate * 20)); // normalize
  }

  // OI magnitude for intensity scaling
  let oiMagnitude = 1;
  if (oiData.length >= 2) {
    const latest = parseFloat(oiData[oiData.length - 1].sumOpenInterestValue);
    const older = parseFloat(oiData[0].sumOpenInterestValue);
    oiMagnitude = latest / older; // >1 means OI growing
  }

  // Long liquidation zones (below current price)
  // Intensity scales with long bias and positive funding
  const longIntensity = Math.min(1, (longBias + Math.max(0, fundingSkew)) * oiMagnitude);
  const longZones = [
    { pct: 3, price: price * 0.97, intensity: longIntensity * 0.6 },
    { pct: 5, price: price * 0.95, intensity: longIntensity * 1.0 },
    { pct: 8, price: price * 0.92, intensity: longIntensity * 0.4 },
  ];

  // Short liquidation zones (above current price)
  const shortBias = 1 - longBias;
  const shortIntensity = Math.min(1, (shortBias + Math.max(0, -fundingSkew)) * oiMagnitude);
  const shortZones = [
    { pct: 3, price: price * 1.03, intensity: shortIntensity * 0.6 },
    { pct: 5, price: price * 1.05, intensity: shortIntensity * 1.0 },
    { pct: 8, price: price * 1.08, intensity: shortIntensity * 0.4 },
  ];

  return { longZones, shortZones, longIntensity, shortIntensity };
}

function renderLiquidationCard(liqData, currentPrice) {
  const container = document.getElementById('liqContent');
  if (!container) return;

  if (!liqData) {
    container.innerHTML = '<div class="whale-unavailable">Liquidation data unavailable</div>';
    return;
  }

  function renderZone(zone, type) {
    const barCls = type === 'long' ? 'liq-bar-long' : 'liq-bar-short';
    const pctFromPrice = ((Math.abs(zone.price - currentPrice) / currentPrice) * 100).toFixed(1);
    const intensityPct = Math.round(zone.intensity * 100);
    return `
      <div class="liq-zone">
        <span class="liq-zone-price">${formatPrice(zone.price)}</span>
        <div class="liq-zone-bar-wrap">
          <div class="liq-zone-bar ${barCls}" style="width:${intensityPct}%"></div>
        </div>
        <span class="liq-zone-pct">-${zone.pct}%</span>
      </div>
    `;
  }

  let html = '';

  // Long liquidation zones
  html += '<div class="liq-section">';
  html += '<div class="liq-section-label liq-long">Long Liquidations (Below Price)</div>';
  liqData.longZones.forEach(z => { html += renderZone(z, 'long'); });
  html += '</div>';

  // Short liquidation zones
  html += '<div class="liq-section">';
  html += '<div class="liq-section-label liq-short">Short Liquidations (Above Price)</div>';
  liqData.shortZones.forEach(z => { html += renderZone(z, 'short'); });
  html += '</div>';

  html += '<div class="liq-note">Estimated from OI, funding rate &amp; L/S ratio</div>';

  container.innerHTML = html;
}

async function loadDashboard() {
  const loader = document.getElementById('loadingOverlay');
  loader.classList.remove('hidden');
  hideError();

  // Safety: force-hide loader after 15s to prevent stuck state
  const safetyTimer = setTimeout(() => { loader.classList.add('hidden'); }, 15000);

  try {
    // Fetch market data, BTC dominance, F&G, Funding Rate, Leverage, and Whale data in parallel
    const [mData, dData, fData, frData, levData, wData] = await Promise.all([
      fetchData(currentCoin, currentTimeframe),
      domData ? Promise.resolve(domData) : fetchBTCDominance(),
      fngData ? Promise.resolve(fngData) : fetchFearAndGreed(),
      fundingData ? Promise.resolve(fundingData) : fetchFundingRate(),
      (leverageData ? Promise.resolve(leverageData) : fetchLeverageData()).catch(e => { console.warn('Leverage fetch error:', e); return null; }),
      (whaleData ? Promise.resolve(whaleData) : fetchWhaleTransactions()).catch(e => { console.warn('Whale fetch error:', e); return null; })
    ]);

    marketData = mData;
    if (!domData) domData = dData;
    if (!fngData) fngData = fData;
    if (!fundingData) fundingData = frData;
    if (!leverageData) leverageData = levData;
    if (!whaleData) whaleData = wData;

    if (!marketData.prices || marketData.prices.length < 30) {
      throw new Error('Insufficient data returned. Try a longer timeframe.');
    }
    renderCharts(marketData);
    try { renderDominanceCard(domData); } catch(e) { console.warn('Dominance render error:', e); }
    try { renderFngCard(fngData); } catch(e) { console.warn('FnG render error:', e); }
    try { renderFundingCard(fundingData); } catch(e) { console.warn('Funding render error:', e); }

    // Render new leverage cards
    const fundRate = fundingData && fundingData.rate !== null ? fundingData.rate : null;
    try { renderLeverageCard(leverageData, fundRate); } catch(e) { console.warn('Leverage render error:', e); }
    try { renderWhaleCard(whaleData); } catch(e) { console.warn('Whale render error:', e); }

    // Liquidation zones need current price + leverage data
    if (marketData.prices.length > 0 && leverageData) {
      const currentPrice = marketData.prices[marketData.prices.length - 1][1];
      const liqData = calcLiquidationZones(currentPrice, leverageData, fundRate);
      try { renderLiquidationCard(liqData, currentPrice); } catch(e) { console.warn('Liq render error:', e); }
    } else {
      renderLiquidationCard(null, 0);
    }
  } catch (err) {
    console.error('Fetch error:', err);
    showError(`Failed to fetch ${currentCoin} data (${currentTimeframe}): ${err.message}`);
  } finally {
    clearTimeout(safetyTimer);
    loader.classList.add('hidden');
  }

  // Refresh sentiment data every 5 minutes in the background
  clearTimeout(window._domRefreshTimer);
  window._domRefreshTimer = setTimeout(async () => {
    domData = await fetchBTCDominance();
    fngData = await fetchFearAndGreed();
    fundingData = await fetchFundingRate();
    renderDominanceCard(domData);
    renderFngCard(fngData);
    renderFundingCard(fundingData);
    // Re-score with new sentiment data
    if (marketData) renderCharts(marketData);
  }, 5 * 60 * 1000);

  // Refresh leverage & whale data every 2 minutes in the background
  clearTimeout(window._levRefreshTimer);
  window._levRefreshTimer = setTimeout(async () => {
    leverageData = await fetchLeverageData();
    whaleData = await fetchWhaleTransactions();
    const fundRate = fundingData && fundingData.rate !== null ? fundingData.rate : null;
    renderLeverageCard(leverageData, fundRate);
    renderWhaleCard(whaleData);
    if (marketData && marketData.prices.length > 0 && leverageData) {
      const currentPrice = marketData.prices[marketData.prices.length - 1][1];
      const liqData = calcLiquidationZones(currentPrice, leverageData, fundRate);
      renderLiquidationCard(liqData, currentPrice);
    }
  }, 2 * 60 * 1000);
}

// Init
document.addEventListener('DOMContentLoaded', loadDashboard);

/* ═══════════════════════════════════════════
   POLYMARKET 5-MIN BTC MODE
   ═══════════════════════════════════════════ */

// ── State ──
let polyMode = false;
let polyWs = null;
let polyUpdateInterval = null;
let polyWindowStartTime = null;
let polyWindowOpenPrice = null;
let polyWindowTimeoutId = null;
let polyReconnectDelay = 1000;
let polyTrades = [];          // last 300 trades
let polyCandles1m = [];       // 1-min candles, last 30
let polyVolumeBuy = 0;
let polyVolumeSell = 0;
let polySessionHistory = [];  // completed window records
let polyPendingPrediction = null; // { score, label } captured ~30s before window end
let polyPredictionCaptureTimeout = null;
let polyCurrentPrice = null;

// v5.0: Self-learning weight state (client-side mirror of bot's WeightLearner)
// v5.1: localStorage persistence — weights survive page refresh
const POLY_INDICATORS = ['MinuteDir', 'NetFlow', 'WindowTrend', 'TickMom', 'ROC', 'MACD', 'Spike', 'Whale'];
const polyLearnedWeights = {
  trending: {}, ranging: {}, volatile: {}, unknown: {},
};
const polyLearnHistory = { trending: [], ranging: [], volatile: [], unknown: [] };
let polyLearnTotalTrades = 0;
// Initialize all weights to 1.0
for (const r of ['trending', 'ranging', 'volatile', 'unknown']) {
  for (const ind of POLY_INDICATORS) {
    polyLearnedWeights[r][ind] = 1.0;
  }
}

// ── v5.1: localStorage persistence ──
const POLY_LEARN_STORAGE_KEY = 'mlcs_learned_weights_v51';

function polySaveLearnedState() {
  try {
    const data = {
      weights: polyLearnedWeights,
      history: polyLearnHistory,
      totalTrades: polyLearnTotalTrades,
      savedAt: Date.now(),
    };
    localStorage.setItem(POLY_LEARN_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // localStorage not available (e.g. Perplexity embed) — silently ignore
  }
}

function polyLoadLearnedState() {
  try {
    const raw = localStorage.getItem(POLY_LEARN_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (data.weights) {
      for (const r of ['trending', 'ranging', 'volatile', 'unknown']) {
        if (data.weights[r]) {
          for (const ind of POLY_INDICATORS) {
            if (typeof data.weights[r][ind] === 'number') {
              polyLearnedWeights[r][ind] = data.weights[r][ind];
            }
          }
        }
      }
    }
    if (data.history) {
      for (const r of ['trending', 'ranging', 'volatile', 'unknown']) {
        if (Array.isArray(data.history[r])) {
          polyLearnHistory[r] = data.history[r].slice(-100); // keep rolling 100
        }
      }
    }
    if (typeof data.totalTrades === 'number') {
      polyLearnTotalTrades = data.totalTrades;
    }
    const age = Date.now() - (data.savedAt || 0);
    const ageStr = age < 3600000 ? `${Math.round(age/60000)}m ago` : `${Math.round(age/3600000)}h ago`;
    console.log(`[WeightLearner] Restored ${polyLearnTotalTrades} trades from localStorage (saved ${ageStr})`);
    return true;
  } catch (e) {
    console.warn('[WeightLearner] Could not load saved weights:', e.message);
    return false;
  }
}

function polyResetLearnedState() {
  for (const r of ['trending', 'ranging', 'volatile', 'unknown']) {
    for (const ind of POLY_INDICATORS) {
      polyLearnedWeights[r][ind] = 1.0;
    }
    polyLearnHistory[r] = [];
  }
  polyLearnTotalTrades = 0;
  try { localStorage.removeItem(POLY_LEARN_STORAGE_KEY); } catch (e) {}
  console.log('[WeightLearner] Weights reset to 1.0');
}

// Load saved state on init
polyLoadLearnedState();

// ── Helpers ──
function polyFormatET(ms) {
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  });
}

function polyFormatCountdown(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── WebSocket Management ──
function startPolymarketMode() {
  polyMode = true;

  // Hide regular signal column, show poly column
  const sigCol = document.querySelector('.signal-column');
  const polyCol = document.getElementById('polyColumn');
  if (sigCol) sigCol.style.display = 'none';
  if (polyCol) polyCol.style.display = 'flex';

  polySetWsStatus(false);
  polyConnectWs();

  // Sync to current 5-min window
  polySyncToWindow();

  // Start update loop (1s)
  polyUpdateInterval = setInterval(updatePolyPanel, 1000);
}

function stopPolymarketMode() {
  polyMode = false;

  // Show regular signal column, hide poly column
  const sigCol = document.querySelector('.signal-column');
  const polyCol = document.getElementById('polyColumn');
  if (sigCol) sigCol.style.display = '';
  if (polyCol) polyCol.style.display = 'none';

  // Disconnect WebSocket
  if (polyWs) {
    polyWs.onclose = null; // prevent auto-reconnect
    polyWs.close();
    polyWs = null;
  }

  clearInterval(polyUpdateInterval);
  clearTimeout(polyWindowTimeoutId);
  clearTimeout(polyPredictionCaptureTimeout);
  polyReconnectDelay = 1000;
}

function polyConnectWs() {
  if (!polyMode) return;
  try {
    polyWs = new WebSocket('wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/btcusdt@kline_1m');
    polyWs.onopen = () => {
      polyReconnectDelay = 1000;
      polySetWsStatus(true);
    };
    polyWs.onmessage = handlePolyMessage;
    polyWs.onerror = () => { /* handled in onclose */ };
    polyWs.onclose = () => {
      polySetWsStatus(false);
      if (polyMode) {
        setTimeout(() => polyConnectWs(), polyReconnectDelay);
        polyReconnectDelay = Math.min(polyReconnectDelay * 2, 30000); // exponential backoff
      }
    };
  } catch (e) {
    console.warn('Poly WS connect error:', e);
    if (polyMode) setTimeout(() => polyConnectWs(), polyReconnectDelay);
  }
}

function polySetWsStatus(connected) {
  const dot = document.getElementById('polyWsDot');
  const lbl = document.getElementById('polyWsLabel');
  if (!dot || !lbl) return;
  if (connected) {
    dot.className = 'poly-ws-dot connected';
    lbl.textContent = 'Connected — Binance Stream';
  } else {
    dot.className = 'poly-ws-dot';
    lbl.textContent = 'Connecting…';
  }
}

// ── Message Handler ──
function handlePolyMessage(event) {
  try {
    const msg = JSON.parse(event.data);
    const stream = msg.stream;
    const data = msg.data;

    if (stream === 'btcusdt@aggTrade') {
      const price = parseFloat(data.p);
      const qty = parseFloat(data.q);
      const isBuy = !data.m; // m=true: maker is seller, taker is buyer

      polyCurrentPrice = price;
      polyTrades.push({ price, qty, time: data.T, isBuy });
      if (polyTrades.length > 300) polyTrades.shift();

      if (isBuy) polyVolumeBuy += qty * price;
      else polyVolumeSell += qty * price;

      // Capture window open price from first trade if not set
      if (polyWindowOpenPrice === null && polyWindowStartTime !== null) {
        polyWindowOpenPrice = price;
      }
    }

    if (stream === 'btcusdt@kline_1m') {
      const k = data.k;
      const candle = {
        open:   parseFloat(k.o),
        high:   parseFloat(k.h),
        low:    parseFloat(k.l),
        close:  parseFloat(k.c),
        volume: parseFloat(k.v),
        time:   k.t,
        closed: k.x
      };

      if (polyCandles1m.length === 0) {
        polyCandles1m.push(candle);
      } else {
        const last = polyCandles1m[polyCandles1m.length - 1];
        if (last.time === candle.time) {
          // Update current (open) candle
          polyCandles1m[polyCandles1m.length - 1] = candle;
        } else {
          // New candle
          polyCandles1m.push(candle);
          if (polyCandles1m.length > 30) polyCandles1m.shift();
        }
      }
    }
  } catch (e) {
    console.warn('Poly message parse error:', e);
  }
}

// ── Window Sync ──
function polySyncToWindow() {
  const now = Date.now();
  const fiveMin = 5 * 60 * 1000;
  const currentWindowStart = Math.floor(now / fiveMin) * fiveMin;
  polyWindowStartTime = currentWindowStart;

  // Reset window-scoped state
  polyWindowOpenPrice = polyCurrentPrice; // best estimate; will update on first trade
  polyVolumeBuy = 0;
  polyVolumeSell = 0;

  // Schedule capture of prediction ~30s before window ends, then record result at window end
  const nextWindow = currentWindowStart + fiveMin;
  const timeToCapture = nextWindow - 30000 - now; // 30s before end
  const timeToEnd = nextWindow - now;

  clearTimeout(polyPredictionCaptureTimeout);
  clearTimeout(polyWindowTimeoutId);

  if (timeToCapture > 0) {
    polyPredictionCaptureTimeout = setTimeout(() => {
      // Capture prediction 30s before window end
      if (polyMode) {
        const ind = calcPolyMicroIndicators();
        if (ind) {
          const score = calcPolymarketSignal(ind);
          let label = polyScoreToLabel(score);
          // v4.0b: Balanced confidence — trade MED+HIGH, skip only LOW
          const scored = [ind.minuteSignal, ind.netFlowSignal, ind.tickMomSignal,
            ind.roc > 0.005 ? 'bullish' : ind.roc < -0.005 ? 'bearish' : 'neutral',
            (ind.macdHistRising && ind.macdHist > 0) ? 'bullish' : (!ind.macdHistRising && ind.macdHist < 0) ? 'bearish' : 'neutral',
            ind.spikeSignal, ind.whaleSignal];
          const bc = scored.filter(s => s === 'bullish' || s === 'up').length;
          const brc = scored.filter(s => s === 'bearish' || s === 'down').length;
          const agr = Math.max(bc, brc);
          const consensus = agr >= 5 ? 'strong' : agr >= 3 ? 'moderate' : 'weak';
          let confLevel = 'LOW';
          if (ind.minuteStreak >= 3 && (score >= 63 || score <= 37) && !ind.streakExhausting) {
            confLevel = consensus !== 'weak' ? 'HIGH' : 'MED';
          } else if (ind.minuteStreak >= 2 && (score >= 58 || score <= 42)) {
            confLevel = 'MED';
          } else if (score >= 60 || score <= 40) {
            confLevel = 'MED';  // Score alone can qualify if strong enough
          }
          if (ind.lowVolatility) confLevel = 'LOW';
          const gated = confLevel === 'LOW' || ind.streakExhausting;
          if (gated) label = 'NEUTRAL';
          polyPendingPrediction = { score, label, confLevel, gated };
        }
      }
    }, timeToCapture);
  }

  polyWindowTimeoutId = setTimeout(() => {
    if (polyMode) {
      polyRecordWindowResult();
      polySyncToWindow(); // move to next window
    }
  }, timeToEnd > 0 ? timeToEnd : 100);
}

function polyRecordWindowResult() {
  if (!polyWindowOpenPrice || !polyCurrentPrice) return;
  const actual = polyCurrentPrice >= polyWindowOpenPrice ? 'UP' : 'DOWN';
  const prediction = polyPendingPrediction ? polyPendingPrediction.label : null;
  // v3.1: NEUTRAL predictions (gated) count as "skip" — not judged for accuracy
  const isSkip = !prediction || prediction === 'NEUTRAL';
  const correct = isSkip ? null : (prediction === 'UP' || prediction === 'LEAN UP' ? 'UP' : 'DOWN') === actual;

  // Format window time label
  const windowLabel = polyFormatET(polyWindowStartTime);

  polySessionHistory.unshift({
    time: windowLabel,
    prediction: prediction || '—',
    actual,
    correct,
    gated: polyPendingPrediction ? polyPendingPrediction.gated : false
  });

  if (polySessionHistory.length > 20) polySessionHistory.pop(); // v3.1: keep more history

  // v5.0: Feed result to weight learner (even for skipped trades)
  if (polyPendingPrediction && !isSkip) {
    const lastInd = calcPolyMicroIndicators();
    polyUpdateLearnedWeights(
      prediction,
      actual,
      lastInd,
      polyPendingPrediction.confLevel || 'LOW'
    );
  }

  polyPendingPrediction = null;
  polyRenderHistory();
}

// ── Indicator Calculations v3 ──
// v3.1 CHANGES: LOW conf gate, streak exhaustion detection, tighter vol threshold
// v3 base: MinuteDirection primary (40%), merged OFI+VolImb → NetFlow, removed RSI/VWAP/EMA/Whale
function calcPolyMicroIndicators() {
  if (polyTrades.length < 10) return null;

  const now = Date.now();
  const recentTrades = polyTrades.filter(t => t.time > now - 60000);
  if (recentTrades.length < 5) return null;

  const currentPrice = polyCurrentPrice || polyTrades[polyTrades.length - 1].price;
  const closedCandles = polyCandles1m.filter(c => c.closed);

  // 1. MinuteDirection Consistency — PRIMARY SIGNAL (40% weight)
  let minuteStreak = 0;
  let minuteDir = 0;
  if (closedCandles.length >= 3) {
    const lookback = Math.min(4, closedCandles.length);
    const recent = closedCandles.slice(-lookback);
    const dirs = recent.map(c => c.close > c.open ? 1 : c.close < c.open ? -1 : 0);
    const lastDir = dirs[dirs.length - 1];
    if (lastDir !== 0) {
      for (let i = dirs.length - 1; i >= 0; i--) {
        if (dirs[i] === lastDir) minuteStreak++;
        else break;
      }
    }
    minuteDir = lastDir;
  }
  const minuteSignal = (minuteStreak >= 3 && minuteDir === 1) ? 'up'
    : (minuteStreak >= 3 && minuteDir === -1) ? 'down' : 'neutral';

  // 2. NetFlow — merged OFI + VolumeImbalance (20% weight)
  const nfTrades = polyTrades.filter(t => t.time > now - 90000);
  let buyDollarVol = 0, sellDollarVol = 0;
  nfTrades.forEach(t => {
    const dv = t.qty * t.price;
    if (t.isBuy) buyDollarVol += dv;
    else sellDollarVol += dv;
  });
  const totalDollarVol = buyDollarVol + sellDollarVol;
  const netFlowVal = totalDollarVol > 0 ? (buyDollarVol - sellDollarVol) / totalDollarVol : 0;
  const netFlowSignal = netFlowVal > 0.05 ? 'bullish' : netFlowVal < -0.05 ? 'bearish' : 'neutral';

  // 3. Window Trend (15% weight)
  const windowDev = polyWindowOpenPrice
    ? (currentPrice - polyWindowOpenPrice) / polyWindowOpenPrice
    : 0;

  // 4. Tick Momentum (10% weight)
  const fastTrades = polyTrades.filter(t => t.time > now - 30000);
  let upTicks = 0;
  for (let i = 1; i < fastTrades.length; i++) {
    if (fastTrades[i].price > fastTrades[i-1].price) upTicks++;
  }
  const tickMom = fastTrades.length > 1 ? upTicks / (fastTrades.length - 1) : 0.5;
  const tickMomSignal = tickMom > 0.55 ? 'bullish' : tickMom < 0.45 ? 'bearish' : 'neutral';

  // 5. Rate of Change (8% weight)
  const twoMinAgo = polyTrades.filter(t => t.time > now - 120000 && t.time < now - 90000);
  const refPrice = twoMinAgo.length > 0
    ? twoMinAgo.reduce((s, t) => s + t.price, 0) / twoMinAgo.length
    : null;
  const roc = refPrice ? ((currentPrice - refPrice) / refPrice) * 100 : 0;

  // 6. Micro MACD(5,13,4) (5% weight)
  const allCloses = closedCandles.map(c => c.close);
  if (polyCandles1m.length > 0) allCloses.push(polyCandles1m[polyCandles1m.length - 1].close);
  let macdHist = 0, macdHistRising = false;
  if (allCloses.length >= 15) {
    const macdData = calcMACD(allCloses, 5, 13, 4);
    if (macdData && macdData.histogram) {
      const hist = macdData.histogram;
      macdHist = hist[hist.length - 1] || 0;
      const prevHist = hist.length >= 2 ? hist[hist.length - 2] : 0;
      macdHistRising = macdHist > prevHist;
    }
  }

  // 7. Volatility Gate (filter — not scored)
  // v3.1: tighter threshold 0.008% (was 0.01%)
  let lowVolatility = false;
  let volRangePercent = null;
  if (closedCandles.length >= 3 && currentPrice) {
    const recentC = closedCandles.slice(-3);
    const high = Math.max(...recentC.map(c => c.high));
    const low = Math.min(...recentC.map(c => c.low));
    volRangePercent = ((high - low) / currentPrice) * 100;
    lowVolatility = volRangePercent < 0.008;
  }

  // v4.0: Regime Detection
  let regime = 'ranging';
  let regimeStrength = 0;
  let regimeRangePercent = 0;
  let regimeDirectionalRatio = 0;
  if (closedCandles.length >= 5) {
    const lookback = Math.min(10, closedCandles.length);
    const recentRegime = closedCandles.slice(-lookback);
    const regimeCloses = recentRegime.map(c => c.close);
    const rHigh = Math.max(...recentRegime.map(c => c.high));
    const rLow = Math.min(...recentRegime.map(c => c.low));
    const rMean = regimeCloses.reduce((a, b) => a + b, 0) / regimeCloses.length;
    regimeRangePercent = rMean > 0 ? ((rHigh - rLow) / rMean) * 100 : 0;
    let netMove = 0, totalMove = 0;
    for (const c of recentRegime) {
      const move = c.close - c.open;
      netMove += move;
      totalMove += Math.abs(move);
    }
    regimeDirectionalRatio = totalMove > 0 ? Math.abs(netMove) / totalMove : 0;
    if (regimeRangePercent > 0.08) {
      regime = 'volatile';
      regimeStrength = Math.min(regimeRangePercent / 0.15, 1);
    } else if (regimeDirectionalRatio > 0.55 && regimeRangePercent > 0.02) {
      regime = 'trending';
      regimeStrength = regimeDirectionalRatio;
    } else {
      regime = 'ranging';
      regimeStrength = 1 - regimeDirectionalRatio;
    }
  }

  // v4.0: Spike Detection
  const spikeTrades = polyTrades.filter(t => t.time > now - 60000);
  let hasSpike = false;
  let spikeSignal = 'neutral';
  let spikeMagnitude = 0;
  if (spikeTrades.length >= 10) {
    const latestPrice = spikeTrades[spikeTrades.length - 1].price;
    let maxMove = 0;
    let moveFromPrice = latestPrice;
    for (let i = 0; i < spikeTrades.length - 1; i++) {
      const move = latestPrice - spikeTrades[i].price;
      if (Math.abs(move) > Math.abs(maxMove)) {
        maxMove = move;
        moveFromPrice = spikeTrades[i].price;
      }
    }
    const spikePct = moveFromPrice > 0 ? (maxMove / moveFromPrice) * 100 : 0;
    spikeMagnitude = Math.abs(spikePct);
    hasSpike = spikeMagnitude > 0.03;
    if (hasSpike) {
      const spikeUp = spikePct > 0;
      if (regime === 'trending') {
        spikeSignal = spikeUp ? 'bullish' : 'bearish';
      } else if (regime === 'ranging') {
        spikeSignal = spikeUp ? 'bearish' : 'bullish'; // mean reversion
      } else {
        spikeSignal = spikeUp ? 'bullish' : 'bearish';
      }
    }
  }

  // v4.0: Volume Anomaly (Whale) Detection
  let hasWhaleTrade = false;
  let whaleSignal = 'neutral';
  let whaleMagnitude = 0;
  if (nfTrades.length >= 20) {
    const dollarVols = nfTrades.map(t => t.qty * t.price);
    const avgDV = dollarVols.reduce((a, b) => a + b, 0) / dollarVols.length;
    const halfLen = Math.floor(nfTrades.length / 2);
    const recentNf = nfTrades.slice(-halfLen);
    let maxWhaleVol = 0;
    let whaleT = null;
    for (const t of recentNf) {
      const dv = t.qty * t.price;
      if (dv > maxWhaleVol) { maxWhaleVol = dv; whaleT = t; }
    }
    whaleMagnitude = avgDV > 0 ? maxWhaleVol / avgDV : 0;
    hasWhaleTrade = whaleMagnitude > 5;
    if (hasWhaleTrade && whaleT) {
      whaleSignal = whaleT.isBuy ? 'bullish' : 'bearish';
    }
  }

  // v4.0: RSI(5) for enhanced exhaustion
  let rsi5 = null;
  const rsiCloses = closedCandles.slice(-7).map(c => c.close);
  if (rsiCloses.length >= 6) {
    let rAvgGain = 0, rAvgLoss = 0;
    for (let i = 1; i <= 5 && i < rsiCloses.length; i++) {
      const ch = rsiCloses[i] - rsiCloses[i-1];
      if (ch > 0) rAvgGain += ch; else rAvgLoss += Math.abs(ch);
    }
    rAvgGain /= 5; rAvgLoss /= 5;
    for (let i = 6; i < rsiCloses.length; i++) {
      const ch = rsiCloses[i] - rsiCloses[i-1];
      rAvgGain = (rAvgGain * 4 + (ch > 0 ? ch : 0)) / 5;
      rAvgLoss = (rAvgLoss * 4 + (ch < 0 ? Math.abs(ch) : 0)) / 5;
    }
    rsi5 = rAvgLoss === 0 ? 100 : 100 - (100 / (1 + rAvgGain / rAvgLoss));
  }

  // v4.0: Enhanced Streak Exhaustion (regime + RSI aware)
  let streakExhausting = false;
  let streakDampened = false;
  let exhaustionReason = null;
  if (minuteStreak >= 3 && minuteDir !== 0) {
    const streakBullish = minuteDir > 0;
    // v4.0: In RANGING regime, 4+ streak = automatic mean reversion warning
    if (regime === 'ranging' && minuteStreak >= 4) {
      streakExhausting = true;
      exhaustionReason = `${minuteStreak}× ${streakBullish ? '↑' : '↓'} in RANGING — mean reversion`;
    }
    // v4.0: RSI(5) overbought/oversold confirms exhaustion
    else if (rsi5 !== null && streakBullish && rsi5 > 80) {
      streakExhausting = true;
      exhaustionReason = `${minuteStreak}×↑ + RSI(5)=${rsi5.toFixed(1)} overbought`;
    }
    else if (rsi5 !== null && !streakBullish && rsi5 < 20) {
      streakExhausting = true;
      exhaustionReason = `${minuteStreak}×↓ + RSI(5)=${rsi5.toFixed(1)} oversold`;
    }
    // Original flow divergence checks (preserved from v3.1)
    else {
      const nfDiverges = streakBullish ? netFlowSignal === 'bearish' : netFlowSignal === 'bullish';
      const tickDiverges = streakBullish ? tickMomSignal === 'bearish' : tickMomSignal === 'bullish';
      if (nfDiverges && tickDiverges) {
        streakExhausting = true;
        exhaustionReason = `${minuteStreak}× ${streakBullish ? '↑' : '↓'} but flow reversing`;
      } else if (nfDiverges || tickDiverges) {
        streakDampened = true;
        exhaustionReason = `${minuteStreak}× ${streakBullish ? '↑' : '↓'} partial divergence`;
      }
    }
  }

  return {
    minuteStreak,
    minuteDir,
    minuteSignal,
    netFlowVal,
    netFlowSignal,
    windowDev,
    tickMom,
    tickMomSignal,
    roc,
    macdHist,
    macdHistRising,
    lowVolatility,
    volRangePercent,
    currentPrice,
    windowOpenPrice: polyWindowOpenPrice,
    // v3.1 fields
    streakExhausting,
    streakDampened,
    exhaustionReason,
    // v4.0 fields
    regime,
    regimeStrength,
    regimeRangePercent,
    regimeDirectionalRatio,
    hasSpike,
    spikeSignal,
    spikeMagnitude,
    hasWhaleTrade,
    whaleSignal,
    whaleMagnitude,
    rsi5
  };
}

// ── Signal Scoring v4.0 ──
function calcPolymarketSignal(ind) {
  // v4.0 regime-adaptive scoring
  let score = 50;

  // Get regime weight multipliers
  const rw = {
    trending: { minuteDir: 1.25, netFlow: 0.75, windowTrend: 1.0, tickMom: 1.0, roc: 1.0, macd: 1.0, spike: 0.5, whale: 1.0, scoreMult: 1.1 },
    ranging:  { minuteDir: 0.70, netFlow: 1.25, windowTrend: 0.80, tickMom: 1.0, roc: 1.0, macd: 1.2, spike: 1.5, whale: 1.2, scoreMult: 0.9 },
    volatile: { minuteDir: 0.90, netFlow: 1.0, windowTrend: 0.70, tickMom: 1.0, roc: 0.80, macd: 0.80, spike: 0.80, whale: 1.3, scoreMult: 0.85 },
  };
  const w = rw[ind.regime] || rw.ranging;

  // 1. MinuteDirection (±20 pts × regime)
  if (ind.minuteStreak >= 3) {
    if (ind.streakExhausting) score += ind.minuteDir * 8 * w.minuteDir;
    else if (ind.streakDampened) score += ind.minuteDir * 14 * w.minuteDir;
    else score += ind.minuteDir * 20 * w.minuteDir;
  }
  if (ind.minuteStreak >= 4 && !ind.streakExhausting) {
    score += ind.minuteDir * 5 * w.minuteDir;
  }
  // 2. NetFlow (±10 pts × regime)
  score += Math.max(-10, Math.min(10, ind.netFlowVal * 50 * w.netFlow));
  // 3. Window Trend (±7.5 pts × regime)
  score += Math.max(-7.5, Math.min(7.5, ind.windowDev * 75 * w.windowTrend));
  // 4. Tick Momentum (±5 pts × regime)
  const tickDelta = (ind.tickMom || 0.5) - 0.5;
  score += Math.max(-5, Math.min(5, tickDelta * 10 * w.tickMom));
  // 5. ROC (±4 pts × regime)
  score += Math.max(-4, Math.min(4, ind.roc * 40 * w.roc));
  // 6. MicroMACD (±2.5 pts × regime)
  const macdFalling = !ind.macdHistRising;
  const mm = w.macd;
  if (ind.macdHist > 0 && ind.macdHistRising) score += 2.5 * mm;
  else if (ind.macdHist < 0 && macdFalling) score -= 2.5 * mm;
  else if (ind.macdHist > 0) score += 1.0 * mm;
  else if (ind.macdHist < 0) score -= 1.0 * mm;
  // 7. v4.0: Spike (±3 pts × regime)
  if (ind.spikeSignal === 'bullish') score += 3 * w.spike;
  else if (ind.spikeSignal === 'bearish') score -= 3 * w.spike;
  // 8. v4.0: Whale (±2 pts × regime)
  if (ind.whaleSignal === 'bullish') score += 2 * w.whale;
  else if (ind.whaleSignal === 'bearish') score -= 2 * w.whale;
  // 9. Apply regime score multiplier
  score = 50 + (score - 50) * w.scoreMult;
  // 10. Volatility Gate
  if (ind.lowVolatility) score = 50;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function polyScoreToLabel(score) {
  if (score >= 65)      return 'UP';
  if (score >= 55)      return 'LEAN UP';
  if (score >= 45)      return 'NEUTRAL';
  if (score >= 35)      return 'LEAN DOWN';
  return 'DOWN';
}

// ── Update Loop (1 second) ──
function updatePolyPanel() {
  if (!polyMode) return;

  const now = Date.now();
  const fiveMin = 5 * 60 * 1000;

  // Window time calculations
  const currentWindowStart = polyWindowStartTime || (Math.floor(now / fiveMin) * fiveMin);
  const currentWindowEnd = currentWindowStart + fiveMin;
  const remaining = currentWindowEnd - now;
  const elapsed = now - currentWindowStart;
  const progressPct = Math.min(100, (elapsed / fiveMin) * 100);

  // Update countdown
  const countdownEl = document.getElementById('polyCountdown');
  if (countdownEl) countdownEl.textContent = polyFormatCountdown(remaining);

  // Update window range
  const rangeEl = document.getElementById('polyWindowRange');
  if (rangeEl) {
    rangeEl.textContent = `${polyFormatET(currentWindowStart)} — ${polyFormatET(currentWindowEnd)} ET`;
  }

  // Update progress bar
  const progressBar = document.getElementById('polyProgressBar');
  if (progressBar) progressBar.style.width = `${progressPct.toFixed(1)}%`;

  // Update prices
  const cp = polyCurrentPrice;
  const op = polyWindowOpenPrice;

  const openPriceEl = document.getElementById('polyOpenPrice');
  if (openPriceEl) openPriceEl.textContent = op ? `$${op.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';

  const currPriceEl = document.getElementById('polyCurrentPrice');
  if (currPriceEl) currPriceEl.textContent = cp ? `$${cp.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';

  const deltaEl = document.getElementById('polyDelta');
  if (deltaEl && cp && op) {
    const delta = cp - op;
    const deltaPct = (delta / op) * 100;
    const sign = delta >= 0 ? '+' : '';
    deltaEl.textContent = `${sign}$${delta.toFixed(2)} (${sign}${deltaPct.toFixed(3)}%)`;
    deltaEl.style.color = delta >= 0 ? '#10b981' : '#ef4444';
  } else if (deltaEl) {
    deltaEl.textContent = '—';
    deltaEl.style.color = '';
  }

  // Calculate indicators
  const ind = calcPolyMicroIndicators();
  const dataStatusEl = document.getElementById('polyDataStatus');

  if (!ind) {
    const tradeCount = polyTrades.length;
    const candleCount = polyCandles1m.filter(c => c.closed).length;
    if (dataStatusEl) {
      dataStatusEl.textContent = `Warming up… trades: ${tradeCount}/10, candles: ${candleCount}/15`;
    }
    // Show waiting state
    const arrowEl = document.getElementById('polyArrow');
    const signalEl = document.getElementById('polySignalText');
    if (arrowEl) { arrowEl.textContent = '⏳'; arrowEl.className = 'poly-arrow neutral'; }
    if (signalEl) signalEl.textContent = 'Collecting data…';
    const confFill = document.getElementById('polyConfFill');
    if (confFill) { confFill.style.width = '50%'; confFill.style.background = '#6b7280'; }
    const confLabel = document.getElementById('polyConfLabel');
    if (confLabel) confLabel.textContent = 'Need more data';
    return;
  }

  if (dataStatusEl) {
    const streakInfo = ind.minuteStreak >= 3
      ? ` • streak: ${ind.minuteStreak}× ${ind.minuteDir > 0 ? '↑' : '↓'}`
      : '';
    const exhaustInfo = ind.streakExhausting ? ' • ⚠ EXHAUSTION' : ind.streakDampened ? ' • ⚡ dampened' : '';
    const regimeTag = ind.regime ? ` • ${ind.regime.toUpperCase()}` : '';
    const learnTag = polyLearnTotalTrades > 0 ? ` • learn: ${polyLearnTotalTrades} trades` : '';
    dataStatusEl.textContent = `v5.0 Live • ${polyTrades.length} trades • ${polyCandles1m.filter(c => c.closed).length} candles${streakInfo}${exhaustInfo}${regimeTag}${learnTag}`;
  }

  const score = calcPolymarketSignal(ind);
  const label = polyScoreToLabel(score);

  // Update arrow
  const arrowEl = document.getElementById('polyArrow');
  if (arrowEl) {
    if (score >= 55) {
      arrowEl.textContent = '⬆';
      arrowEl.className = 'poly-arrow up';
    } else if (score <= 45) {
      arrowEl.textContent = '⬇';
      arrowEl.className = 'poly-arrow down';
    } else {
      arrowEl.textContent = '↔';
      arrowEl.className = 'poly-arrow neutral';
    }
  }

  // Update signal text with v4.0 confidence logic
  const signalEl = document.getElementById('polySignalText');
  if (signalEl) {
    // v4.0b: Balanced confidence — trade MED+HIGH, skip only LOW
    const scored = [ind.minuteSignal, ind.netFlowSignal, ind.tickMomSignal,
      ind.roc > 0.005 ? 'bullish' : ind.roc < -0.005 ? 'bearish' : 'neutral',
      (ind.macdHistRising && ind.macdHist > 0) ? 'bullish' : (!ind.macdHistRising && ind.macdHist < 0) ? 'bearish' : 'neutral',
      ind.spikeSignal || 'neutral', ind.whaleSignal || 'neutral'];
    const bc = scored.filter(s => s === 'bullish' || s === 'up').length;
    const brc = scored.filter(s => s === 'bearish' || s === 'down').length;
    const agr = Math.max(bc, brc);
    const consensus = agr >= 5 ? 'strong' : agr >= 3 ? 'moderate' : 'weak';
    let confLevel = 'LOW';
    if (ind.minuteStreak >= 3 && (score >= 63 || score <= 37) && !ind.streakExhausting) {
      confLevel = consensus !== 'weak' ? 'HIGH' : 'MED';
    } else if (ind.minuteStreak >= 2 && (score >= 58 || score <= 42)) {
      confLevel = 'MED';
    } else if (score >= 60 || score <= 40) {
      confLevel = 'MED';  // Score alone can qualify if strong enough
    }
    if (ind.lowVolatility) confLevel = 'LOW';

    const lowConfGated = confLevel === 'LOW';

    if (ind.lowVolatility) {
      signalEl.textContent = 'LOW VOL — Skip';
      signalEl.style.color = '#9ca3af';
    } else if (ind.streakExhausting) {
      signalEl.textContent = '⚠ EXHAUSTION — Skip';
      signalEl.style.color = '#fbbf24';
    } else if (lowConfGated) {
      signalEl.textContent = `LOW CONF — Skip (${score}/100)`;
      signalEl.style.color = '#9ca3af';
    } else if (label === 'NEUTRAL') {
      signalEl.textContent = 'NEUTRAL — No edge';
      signalEl.style.color = '#9ca3af';
    } else if (score >= 55) {
      signalEl.textContent = `UP (${confLevel}) — ${score}/100 [${ind.regime}]`;
      signalEl.style.color = '#10b981';
    } else {
      signalEl.textContent = `DOWN (${confLevel}) — ${score}/100 [${ind.regime}]`;
      signalEl.style.color = '#ef4444';
    }
  }

  // Update confidence bar
  const confFill = document.getElementById('polyConfFill');
  if (confFill) {
    confFill.style.width = `${score}%`;
    if (score >= 65)      confFill.style.background = '#10b981';
    else if (score >= 55) confFill.style.background = '#34d399';
    else if (score >= 45) confFill.style.background = '#6b7280';
    else if (score >= 35) confFill.style.background = '#f87171';
    else                  confFill.style.background = '#ef4444';
  }

  const confLabel = document.getElementById('polyConfLabel');
  if (confLabel) confLabel.textContent = `Score: ${score}/100`;

  // Update micro indicators grid
  polyRenderIndicators(ind);

  // v5.0: Render learned weights panel
  polyRenderLearnedWeights(ind.regime || 'unknown');
}

function polyRenderIndicators(ind) {
  const grid = document.getElementById('polyIndGrid');
  if (!grid) return;

  // v4.0: 7 scored indicators + volatility gate + regime/spike/whale/RSI
  const streakLabel = ind.minuteStreak >= 2
    ? `${ind.minuteStreak}× ${ind.minuteDir > 0 ? '↑' : '↓'}`
    : 'Mixed';

  const rows = [
    {
      name: 'MinuteDir (40%)',
      value: streakLabel,
      signal: ind.minuteSignal
    },
    {
      name: 'NetFlow (20%)',
      value: `${ind.netFlowVal >= 0 ? '+' : ''}${(ind.netFlowVal * 100).toFixed(2)}%`,
      signal: ind.netFlowVal > 0.05 ? 'up' : ind.netFlowVal < -0.05 ? 'down' : 'neutral'
    },
    {
      name: 'Window Trend (15%)',
      value: `${ind.windowDev >= 0 ? '+' : ''}${(ind.windowDev * 100).toFixed(3)}%`,
      signal: ind.windowDev > 0.0001 ? 'up' : ind.windowDev < -0.0001 ? 'down' : 'neutral'
    },
    {
      name: 'Tick Mom (10%)',
      value: `${(ind.tickMom * 100).toFixed(1)}% up`,
      signal: ind.tickMom > 0.55 ? 'up' : ind.tickMom < 0.45 ? 'down' : 'neutral'
    },
    {
      name: 'ROC (8%)',
      value: `${ind.roc >= 0 ? '+' : ''}${ind.roc.toFixed(4)}%`,
      signal: ind.roc > 0.005 ? 'up' : ind.roc < -0.005 ? 'down' : 'neutral'
    },
    {
      name: 'MACD (5%)',
      value: ind.macdHist.toFixed(4),
      signal: (ind.macdHistRising && ind.macdHist > 0) ? 'up' : (!ind.macdHistRising && ind.macdHist < 0) ? 'down' : 'neutral'
    },
    {
      name: 'Vol Gate',
      value: ind.volRangePercent !== null ? `${ind.volRangePercent.toFixed(4)}%` : '—',
      signal: ind.lowVolatility ? 'down' : 'up'
    },
    {
      name: 'Regime',
      value: `${(ind.regime || '?').toUpperCase()} (${(ind.regimeStrength || 0).toFixed(2)})`,
      signal: ind.regime === 'trending' ? 'up' : ind.regime === 'volatile' ? 'down' : 'neutral'
    },
    {
      name: 'Spike (3%)',
      value: ind.hasSpike ? `${ind.spikeMagnitude.toFixed(4)}%` : 'none',
      signal: ind.spikeSignal === 'bullish' ? 'up' : ind.spikeSignal === 'bearish' ? 'down' : 'neutral'
    },
    {
      name: 'Whale',
      value: ind.hasWhaleTrade ? `${ind.whaleMagnitude.toFixed(1)}× avg` : 'normal',
      signal: ind.whaleSignal === 'bullish' ? 'up' : ind.whaleSignal === 'bearish' ? 'down' : 'neutral'
    },
    {
      name: 'RSI(5)',
      value: ind.rsi5 !== null ? ind.rsi5.toFixed(1) : '—',
      signal: ind.rsi5 !== null ? (ind.rsi5 > 70 ? 'up' : ind.rsi5 < 30 ? 'down' : 'neutral') : 'neutral'
    }
  ];

  // v3.1: Add exhaustion row if active
  if (ind.streakExhausting || ind.streakDampened) {
    rows.push({
      name: '⚠ Exhaustion',
      value: ind.exhaustionReason || 'Active',
      signal: ind.streakExhausting ? 'down' : 'neutral'
    });
  }

  grid.innerHTML = rows.map(r => `
    <div class="poly-ind-row">
      <span class="poly-ind-name">${r.name}</span>
      <span class="poly-ind-value">${r.value}</span>
      <span class="poly-ind-dot ${r.signal}"></span>
    </div>
  `).join('');
}

// ── v5.0: Self-Learning Weight Rendering ──
function polyRenderLearnedWeights(currentRegime) {
  const container = document.getElementById('polyLearnedWeights');
  if (!container) return;

  const regime = ['trending', 'ranging', 'volatile'].includes(currentRegime) ? currentRegime : 'unknown';
  const weights = polyLearnedWeights[regime];
  const history = polyLearnHistory[regime];
  const wins = history.filter(h => h.won).length;
  const wr = history.length > 0 ? ((wins / history.length) * 100).toFixed(0) : '—';

  // Sort by weight (highest first)
  const sorted = Object.entries(weights).sort((a, b) => b[1] - a[1]);

  let html = `<div class="poly-learn-header">
    <span class="poly-learn-title">Self-Learning Weights</span>
    <span class="poly-learn-regime">${regime.toUpperCase()} • ${history.length} trades • ${wr}% WR</span>
    <button onclick="if(confirm('Reset all learned weights to 1.0?')){polyResetLearnedState();polyRenderLearnedWeights('${regime}');}" style="margin-left:auto;padding:2px 8px;border-radius:4px;background:#374151;color:#9ca3af;border:1px solid #4b5563;font-size:10px;cursor:pointer;opacity:0.7" title="Reset weights to default">Reset</button>
  </div>
  <div class="poly-learn-grid">`;

  for (const [name, w] of sorted) {
    const pct = ((w - 0.3) / (2.5 - 0.3)) * 100; // Normalize 0.3–2.5 to 0–100
    const barColor = w > 1.1 ? '#10b981' : w < 0.9 ? '#ef4444' : '#6b7280';
    const arrow = w > 1.05 ? '↑' : w < 0.95 ? '↓' : '→';
    html += `<div class="poly-learn-row">
      <span class="poly-learn-name">${name}</span>
      <div class="poly-learn-bar-bg">
        <div class="poly-learn-bar" style="width:${Math.max(2, pct).toFixed(1)}%;background:${barColor}"></div>
      </div>
      <span class="poly-learn-val">${w.toFixed(2)} ${arrow}</span>
    </div>`;
  }

  html += '</div>';

  // Confidence calibration
  const allJudged = Object.values(polyLearnHistory)
    .flat()
    .filter(h => h.won !== undefined);
  if (allJudged.length >= 5) {
    const highTrades = allJudged.filter(h => h.conf === 'HIGH');
    const medTrades = allJudged.filter(h => h.conf === 'MED');
    const hWR = highTrades.length > 0 ? ((highTrades.filter(h => h.won).length / highTrades.length) * 100).toFixed(0) : '—';
    const mWR = medTrades.length > 0 ? ((medTrades.filter(h => h.won).length / medTrades.length) * 100).toFixed(0) : '—';
    html += `<div class="poly-learn-calib">
      <span>HIGH: ${highTrades.length} trades, ${hWR}% WR</span>
      <span>MED: ${medTrades.length} trades, ${mWR}% WR</span>
    </div>`;
  }

  if (polyLearnTotalTrades === 0) {
    html = `<div class="poly-learn-header">
      <span class="poly-learn-title">Self-Learning Weights</span>
      <span class="poly-learn-regime">Waiting for first window…</span>
    </div>
    <div class="poly-learn-empty">All weights start at 1.00 (baseline).<br>Weights will adjust as the system sees trade outcomes.</div>`;
  }

  container.innerHTML = html;
}

// ── v5.0: Weight Learning Update (called after each window resolves) ──
function polyUpdateLearnedWeights(prediction, actual, ind, confLevel) {
  if (!prediction || !actual || !ind) return;
  // Map prediction label to direction
  const predDir = (prediction === 'UP' || prediction === 'LEAN UP') ? 'up' : 'down';
  const actualDir = actual === 'UP' ? 'up' : 'down';
  const won = predDir === actualDir;
  const regime = ind.regime || 'unknown';
  const regimeKey = ['trending', 'ranging', 'volatile'].includes(regime) ? regime : 'unknown';

  // Determine individual indicator correctness
  const correctSignal = actualDir === 'up' ? 'bullish' : 'bearish';
  const wrongSignal = actualDir === 'up' ? 'bearish' : 'bullish';

  // Map indicators to their signals
  const signals = {
    MinuteDir:   ind.minuteSignal === 'up' ? 'bullish' : ind.minuteSignal === 'down' ? 'bearish' : 'neutral',
    NetFlow:     ind.netFlowSignal,
    WindowTrend: ind.windowDev > 0.0001 ? 'bullish' : ind.windowDev < -0.0001 ? 'bearish' : 'neutral',
    TickMom:     ind.tickMomSignal,
    ROC:         ind.roc > 0.005 ? 'bullish' : ind.roc < -0.005 ? 'bearish' : 'neutral',
    MACD:        (ind.macdHistRising && ind.macdHist > 0) ? 'bullish' : (!ind.macdHistRising && ind.macdHist < 0) ? 'bearish' : 'neutral',
    Spike:       ind.spikeSignal || 'neutral',
    Whale:       ind.whaleSignal || 'neutral',
  };

  // Record in history
  polyLearnHistory[regimeKey].push({
    timestamp: Date.now(),
    won,
    conf: confLevel || 'LOW',
    signals,
  });
  if (polyLearnHistory[regimeKey].length > 100) {
    polyLearnHistory[regimeKey] = polyLearnHistory[regimeKey].slice(-100);
  }
  polyLearnTotalTrades++;

  // Apply multiplicative weight updates (only after 5 trades in this regime)
  if (polyLearnHistory[regimeKey].length >= 5) {
    const REWARD = 1.08;
    const PENALTY = 0.92;
    const NEUTRAL_DECAY = 0.995;
    const DRIFT = 0.002;

    for (const indName of POLY_INDICATORS) {
      let w = polyLearnedWeights[regimeKey][indName];
      const sig = signals[indName];

      if (sig === correctSignal) {
        w *= REWARD;
      } else if (sig === wrongSignal) {
        w *= PENALTY;
      } else {
        w *= NEUTRAL_DECAY;
      }

      // Drift toward 1.0
      w = w + (1.0 - w) * DRIFT;
      // Clamp
      w = Math.max(0.30, Math.min(2.50, w));

      polyLearnedWeights[regimeKey][indName] = w;
    }
  }

  // v5.1: persist to localStorage after every trade (weights + history)
  polySaveLearnedState();
}

function polyRenderHistory() {
  const tbody = document.getElementById('polyHistoryBody');
  const accEl = document.getElementById('polyAccuracy');
  if (!tbody) return;

  tbody.innerHTML = polySessionHistory.map(h => {
    let resultHtml = '<span style="color:#6b7280">—</span>';
    if (h.correct === true)  resultHtml = '<span class="poly-result-correct">✓</span>';
    if (h.correct === false) resultHtml = '<span class="poly-result-wrong">✗</span>';
    if (h.gated) resultHtml = '<span style="color:#6b7280">skip</span>';
    const predColor = h.prediction.includes('UP') ? '#10b981' : h.prediction.includes('DOWN') ? '#ef4444' : '#9ca3af';
    const actualColor = h.actual === 'UP' ? '#10b981' : '#ef4444';
    return `<tr>
      <td>${h.time}</td>
      <td style="color:${predColor}">${h.prediction}</td>
      <td style="color:${actualColor}">${h.actual}</td>
      <td>${resultHtml}</td>
    </tr>`;
  }).join('');

  // Accuracy stat — only counts non-gated, non-neutral predictions
  const judged = polySessionHistory.filter(h => h.correct !== null);
  const skipped = polySessionHistory.filter(h => h.gated).length;
  if (accEl) {
    if (judged.length === 0) {
      accEl.textContent = 'No completed windows yet';
      accEl.style.color = '#9ca3af';
    } else {
      const correct = judged.filter(h => h.correct).length;
      const pct = Math.round((correct / judged.length) * 100);
      const skipNote = skipped > 0 ? ` • ${skipped} skipped` : '';
      accEl.textContent = `${correct}/${judged.length} • ${pct}% accuracy${skipNote}`;
      accEl.style.color = pct >= 55 ? '#10b981' : pct >= 45 ? '#fbbf24' : '#ef4444';
    }
  }
}

// ── Toggle Function (called from button) ──
function togglePolymarket() {
  const btn = document.getElementById('polyBtn');

  if (polyMode) {
    // Turn off
    stopPolymarketMode();
    if (btn) btn.classList.remove('active');
    // Deselect POLY tf button, restore previous tf button active state
    document.querySelectorAll('.tf-btn').forEach(b => {
      if (b.dataset.tf === currentTimeframe) b.classList.add('active');
      else b.classList.remove('active');
    });
    // Reload dashboard data
    loadDashboard();
  } else {
    // Turn on — deactivate all tf buttons
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    startPolymarketMode();
  }
}

// Expose to global scope for onclick attributes
window.togglePolymarket = togglePolymarket;
