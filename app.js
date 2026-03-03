/* app.js — MLCS Crypto Dashboard — Multi-Timeframe */
'use strict';

/* ═══════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════ */
let currentCoin = 'bitcoin';
let currentTF   = '15m';
let refreshTimer = null;
let isLoading    = false;

const COINS = {
  bitcoin:  { id: 'bitcoin',  symbol: 'BTC', color: '#f7931a' },
  ethereum: { id: 'ethereum', symbol: 'ETH', color: '#627eea' },
  solana:   { id: 'solana',   symbol: 'SOL', color: '#9945ff' },
  sui:      { id: 'sui',      symbol: 'SUI', color: '#4da2ff' },
};

const TF_LABELS = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
const TF_CANDLES = { '15m': 96, '1h': 168, '4h': 90, '1d': 90 };

/* CoinGecko interval mapping (free API) */
const TF_CG = {
  '15m': { days: 1,   interval: 'minutely' },
  '1h':  { days: 7,   interval: 'hourly' },
  '4h':  { days: 30,  interval: 'daily' },
  '1d':  { days: 90,  interval: 'daily' },
};

let priceCache = {}; /* { coinId_tf: { ts, ohlcv[] } } */

/* ═══════════════════════════════════════════
   HELPERS — MATH
   ═══════════════════════════════════════════ */
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

/* ═══════════════════════════════════════════
   INDICATOR CALCULATIONS
   ═══════════════════════════════════════════ */

/** Simple Moving Average */
function calcSMA(closes, period) {
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    result[i] = mean(slice);
  }
  return result;
}

/** Exponential Moving Average */
function calcEMA(closes, period) {
  const result = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  // seed with SMA
  const seed = mean(closes.slice(0, period));
  result[period - 1] = seed;
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/** RSI */
function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    result[i] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  }
  return result;
}

/** MACD */
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast   = calcEMA(closes, fast);
  const emaSlow   = calcEMA(closes, slow);
  const macdLine  = emaFast.map((v, i) =>
    v !== null && emaSlow[i] !== null ? v - emaSlow[i] : null);
  // signal EMA of macdLine (skip nulls)
  const macdValid = macdLine.filter(v => v !== null);
  const signalEMA = calcEMA(macdValid, signal);
  // re-align
  const firstValid = macdLine.findIndex(v => v !== null);
  const signalLine = new Array(closes.length).fill(null);
  let si = 0;
  for (let i = firstValid; i < closes.length; i++) {
    if (si < signalEMA.length && signalEMA[si] !== null) {
      signalLine[i] = signalEMA[si];
    }
    si++;
  }
  const histogram = macdLine.map((v, i) =>
    v !== null && signalLine[i] !== null ? v - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}

/** Bollinger Bands */
function calcBB(closes, period = 20, mult = 2) {
  const sma    = calcSMA(closes, period);
  const upper  = new Array(closes.length).fill(null);
  const lower  = new Array(closes.length).fill(null);
  const bwidth = new Array(closes.length).fill(null);
  const pctB   = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const sd = stddev(closes.slice(i - period + 1, i + 1));
    upper[i]  = sma[i] + mult * sd;
    lower[i]  = sma[i] - mult * sd;
    bwidth[i] = ((upper[i] - lower[i]) / sma[i]) * 100;
    pctB[i]   = (closes[i] - lower[i]) / (upper[i] - lower[i]);
  }
  return { sma, upper, lower, bwidth, pctB };
}

/** Stochastic */
function calcStoch(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const kLine = new Array(closes.length).fill(null);
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const highestH = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const lowestL  = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    const denom = highestH - lowestL;
    kLine[i] = denom === 0 ? 50 : ((closes[i] - lowestL) / denom) * 100;
  }
  const dLine = calcSMA(kLine.map(v => v ?? 0), dPeriod);
  return { kLine, dLine };
}

/** ATR */
function calcATR(highs, lows, closes, period = 14) {
  const tr  = new Array(closes.length).fill(null);
  const atr = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
  }
  if (tr.filter(v => v !== null).length < period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < closes.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

/** OBV */
function calcOBV(closes, volumes) {
  const obv = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    obv[i] = obv[i - 1] + (d > 0 ? volumes[i] : d < 0 ? -volumes[i] : 0);
  }
  return obv;
}

/** Volume ratio vs 20-bar avg */
function calcVolRatio(volumes, period = 20) {
  const avg = calcSMA(volumes, period);
  return volumes.map((v, i) => avg[i] ? v / avg[i] : null);
}

/* ═══════════════════════════════════════════
   FILTER LOGIC — returns { score 0-6, details }
   ═══════════════════════════════════════════ */
function runMLCSFilters(candles) {
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const n       = closes.length - 1; /* last index */

  /* --- Indicator calculations --- */
  const rsi    = calcRSI(closes, 14);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const macd   = calcMACD(closes);
  const bb     = calcBB(closes, 20, 2);
  const stoch  = calcStoch(highs, lows, closes, 14, 3);
  const atr    = calcATR(highs, lows, closes, 14);
  const obv    = calcOBV(closes, volumes);
  const volR   = calcVolRatio(volumes, 20);

  /* ─── Filter 1 · Trend EMA ─────────────────
     LONG : price > EMA20 > EMA50 > EMA200
     SHORT: price < EMA20 < EMA50 < EMA200       */
  const price = closes[n];
  const e20   = ema20[n], e50 = ema50[n], e200 = ema200[n];
  let trendBull = false, trendBear = false;
  if (e20 && e50 && e200) {
    trendBull = price > e20 && e20 > e50 && e50 > e200;
    trendBear = price < e20 && e20 < e50 && e50 < e200;
  }
  const f1 = trendBull ? 'long' : trendBear ? 'short' : 'neutral';

  /* ─── Filter 2 · RSI Zone ──────────────────
     LONG : RSI 45–70
     SHORT: RSI 30–55                            */
  const rsiVal = rsi[n];
  const f2 = rsiVal !== null
    ? (rsiVal >= 45 && rsiVal <= 70 ? 'long'
      : rsiVal >= 30 && rsiVal <= 55 ? 'short' : 'neutral')
    : 'neutral';

  /* ─── Filter 3 · MACD ──────────────────────
     LONG : MACD line > signal & histogram > 0
     SHORT: MACD line < signal & histogram < 0   */
  const ml = macd.macdLine[n], sl2 = macd.signalLine[n], hist = macd.histogram[n];
  let f3 = 'neutral';
  if (ml !== null && sl2 !== null && hist !== null) {
    if (ml > sl2 && hist > 0) f3 = 'long';
    else if (ml < sl2 && hist < 0) f3 = 'short';
  }

  /* ─── Filter 4 · Bollinger %B ──────────────
     LONG : %B 0.4–0.9 (mid-upper)
     SHORT: %B 0.1–0.6 (lower-mid)              */
  const pctB = bb.pctB[n];
  let f4 = 'neutral';
  if (pctB !== null) {
    if (pctB >= 0.4 && pctB <= 0.9) f4 = 'long';
    else if (pctB >= 0.1 && pctB <= 0.6) f4 = 'short';
  }

  /* ─── Filter 5 · Stochastic ────────────────
     LONG : K>D & K 40–80
     SHORT: K<D & K 20–60                       */
  const kv = stoch.kLine[n], dv = stoch.dLine[n];
  let f5 = 'neutral';
  if (kv !== null && dv !== null) {
    if (kv > dv && kv >= 40 && kv <= 80) f5 = 'long';
    else if (kv < dv && kv >= 20 && kv <= 60) f5 = 'short';
  }

  /* ─── Filter 6 · Volume ────────────────────
     LONG : vol ratio > 1.2 & price > EMA20
     SHORT: vol ratio > 1.2 & price < EMA20     */
  const vr = volR[n];
  let f6 = 'neutral';
  if (vr !== null && e20 !== null) {
    if (vr > 1.2 && price > e20) f6 = 'long';
    else if (vr > 1.2 && price < e20) f6 = 'short';
  }

  const filters = [f1, f2, f3, f4, f5, f6];
  const longScore  = filters.filter(f => f === 'long').length;
  const shortScore = filters.filter(f => f === 'short').length;
  const score = Math.max(longScore, shortScore);
  const direction = longScore > shortScore ? 'long'
                  : shortScore > longScore ? 'short' : 'neutral';

  return {
    score, direction, filters,
    indicators: {
      rsi: rsiVal,
      ema20: e20, ema50: e50, ema200: e200,
      macdLine: ml, macdSignal: sl2, macdHist: hist,
      bbPctB: pctB, bbWidth: bb.bwidth[n],
      stochK: kv, stochD: dv,
      atr: atr[n],
      obv: obv[n],
      volRatio: vr,
      price,
    },
  };
}

/* ═══════════════════════════════════════════
   API — COINGECKO (free, no key)
   ═══════════════════════════════════════════ */
async function fetchCoinGeckoOHLC(coinId, tf) {
  const cacheKey = `${coinId}_${tf}`;
  const cached   = priceCache[cacheKey];
  const now      = Date.now();
  const TTL      = tf === '1d' ? 600_000 : tf === '4h' ? 300_000 : 60_000;
  if (cached && now - cached.ts < TTL) return cached.data;

  const { days, interval } = TF_CG[tf];

  /* Try OHLC endpoint for 1d/4h; market_chart for finer grain */
  let candles = [];

  if (tf === '1d' || tf === '4h') {
    /* CoinGecko /coins/{id}/ohlc — returns [ts, o, h, l, c] */
    const ohlcDays = tf === '1d' ? 90 : 30;
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${ohlcDays}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`CG OHLC ${resp.status}`);
    const raw = await resp.json();
    /* Downsample for 4h: group every 4 daily-ish bars */
    if (tf === '4h') {
      for (let i = 0; i + 3 < raw.length; i += 4) {
        const chunk = raw.slice(i, i + 4);
        candles.push({
          ts:     chunk[0][0],
          open:   chunk[0][1],
          high:   Math.max(...chunk.map(r => r[2])),
          low:    Math.min(...chunk.map(r => r[3])),
          close:  chunk[chunk.length - 1][4],
          volume: 0,
        });
      }
    } else {
      candles = raw.map(r => ({ ts: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: 0 }));
    }
  } else {
    /* market_chart for hourly & minutely */
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=${interval}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`CG chart ${resp.status}`);
    const data = await resp.json();
    const prices  = data.prices   || [];
    const volumes = data.total_volumes || [];
    /* Convert to OHLCV — synthetic OHLC from close prices */
    for (let i = 1; i < prices.length; i++) {
      const prev  = prices[i - 1][1];
      const close = prices[i][1];
      const vol   = volumes[i] ? volumes[i][1] : 0;
      candles.push({
        ts:     prices[i][0],
        open:   prev,
        high:   Math.max(prev, close),
        low:    Math.min(prev, close),
        close,
        volume: vol,
      });
    }
  }

  priceCache[cacheKey] = { ts: now, data: candles };
  return candles;
}

/* Current price + 24h change */
async function fetchCurrentPrice(coinId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`CG price ${resp.status}`);
  const data = await resp.json();
  return {
    price:  data[coinId]?.usd ?? 0,
    change: data[coinId]?.usd_24h_change ?? 0,
  };
}

/* ═══════════════════════════════════════════
   SIGNAL HISTORY (in-memory)
   ═══════════════════════════════════════════ */
const signalHistory = []; /* { ts, coin, tf, type, price, score, filters } */

function recordSignal(coin, tf, type, price, score, filters) {
  signalHistory.unshift({ ts: Date.now(), coin, tf, type, price, score, filters });
  if (signalHistory.length > 50) signalHistory.pop();
}

/* ═══════════════════════════════════════════
   RENDER — CONVICTION PANEL
   ═══════════════════════════════════════════ */
function renderConvictionPanel(result, coin, tf) {
  const { score, direction, filters } = result;

  /* Ring */
  const pct     = score / 6;
  const circ    = 2 * Math.PI * 50; // 314.16
  const offset  = circ * (1 - pct);
  const ringEl  = document.getElementById('ringProgress');
  const valEl   = document.getElementById('ringValue');
  ringEl.style.strokeDashoffset = offset;

  const color = score >= 5 ? '#10b981'
              : score >= 3 ? '#06b6d4'
              : score >= 1 ? '#f59e0b' : '#64748b';
  ringEl.style.stroke = color;
  valEl.textContent   = score;

  /* Title */
  const symbol = COINS[coin].symbol;
  const tfLabel = TF_LABELS[tf];
  const titleEl = document.getElementById('convictionTitle');
  const subEl   = document.getElementById('convictionSubtitle');
  titleEl.textContent = score >= 5 ? `High-Conviction ${direction.toUpperCase()} Signal`
                      : score >= 3 ? `Moderate ${direction.toUpperCase()} Bias`
                      : score >= 1 ? `Weak ${direction.toUpperCase()} Signal`
                      : 'No Clear Signal';
  subEl.textContent = `${symbol} · ${tfLabel} · ${score}/6 filters confirmed`;

  /* Tags */
  const tagsEl = document.getElementById('convictionTags');
  tagsEl.innerHTML = '';
  if (score >= 5) tagsEl.innerHTML += `<span class="conviction-tag long">HOT</span>`;
  if (direction === 'long')  tagsEl.innerHTML += `<span class="conviction-tag long">${symbol} LONG</span>`;
  if (direction === 'short') tagsEl.innerHTML += `<span class="conviction-tag short">${symbol} SHORT</span>`;
  if (score <= 1) tagsEl.innerHTML += `<span class="conviction-tag neutral">WAIT</span>`;

  /* Signal dots */
  const FILTER_NAMES = ['EMA', 'RSI', 'MACD', 'BB', 'STOCH', 'VOL'];
  const gridEl = document.getElementById('signalGrid');
  gridEl.innerHTML = '';
  filters.forEach((f, i) => {
    const cls = f === 'long' ? 'green' : f === 'short' ? 'red' : 'gray';
    const icon = f === 'long' ? '▲' : f === 'short' ? '▼' : '–';
    gridEl.innerHTML += `
      <div class="signal-dot">
        <div class="signal-dot-circle ${cls}">${icon}</div>
        <div class="signal-dot-label">${FILTER_NAMES[i]}</div>
      </div>`;
  });
}

/* ═══════════════════════════════════════════
   RENDER — INDICATORS GRID
   ═══════════════════════════════════════════ */
function renderIndicators(result, price) {
  const { indicators, filters } = result;
  const { rsi, ema20, ema50, ema200,
          macdLine, macdSignal, macdHist,
          bbPctB, bbWidth, stochK, stochD,
          atr, volRatio } = indicators;

  const fmt = (v, d = 2) => v != null ? Number(v).toFixed(d) : '—';
  const pct  = (v)       => v != null ? (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%' : '—';

  const cards = [
    {
      name: 'RSI (14)',
      badge: filters[1],
      value: fmt(rsi, 1),
      sub: rsi != null
        ? (rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Neutral zone')
        : '—',
      bar: rsi != null ? rsi : 0,
      barMax: 100,
    },
    {
      name: 'MACD',
      badge: filters[2],
      value: fmt(macdHist, 4),
      sub: `Line ${fmt(macdLine, 4)} · Sig ${fmt(macdSignal, 4)}`,
      bar: macdHist != null ? Math.abs(macdHist) : 0,
      barMax: macdHist != null ? Math.abs(macdHist) * 3 : 1,
    },
    {
      name: 'Bollinger %B',
      badge: filters[3],
      value: fmt(bbPctB, 3),
      sub: `Width ${fmt(bbWidth, 1)}% · ${bbPctB > 0.8 ? 'Near upper' : bbPctB < 0.2 ? 'Near lower' : 'Mid-band'}`,
      bar: bbPctB != null ? bbPctB * 100 : 0,
      barMax: 100,
    },
    {
      name: 'Stochastic K/D',
      badge: filters[4],
      value: fmt(stochK, 1),
      sub: `K ${fmt(stochK, 1)} · D ${fmt(stochD, 1)}`,
      bar: stochK != null ? stochK : 0,
      barMax: 100,
    },
    {
      name: 'EMA Trend',
      badge: filters[0],
      value: price > ema20 ? 'Above' : 'Below',
      sub: `20: ${fmt(ema20)} · 50: ${fmt(ema50)} · 200: ${fmt(ema200)}`,
      bar: price && ema200 ? Math.min((price / ema200) * 50, 100) : 50,
      barMax: 100,
    },
    {
      name: 'Volume Ratio',
      badge: filters[5],
      value: fmt(volRatio, 2) + 'x',
      sub: volRatio != null
        ? (volRatio > 2 ? 'Very high volume' : volRatio > 1.2 ? 'Above average' : 'Below average')
        : '—',
      bar: volRatio != null ? Math.min(volRatio * 40, 100) : 0,
      barMax: 100,
    },
    {
      name: 'ATR (14)',
      badge: 'neutral',
      value: atr != null ? '$' + fmt(atr) : '—',
      sub: atr != null && price
        ? `${((atr / price) * 100).toFixed(2)}% of price`
        : '—',
      bar: atr && price ? Math.min((atr / price) * 1000, 100) : 0,
      barMax: 100,
    },
  ];

  const grid = document.getElementById('indicatorsGrid');
  grid.innerHTML = cards.map(card => {
    const barW = Math.min((card.bar / card.barMax) * 100, 100);
    return `
      <div class="indicator-card ${card.badge}">
        <div class="ind-header">
          <span class="ind-name">${card.name}</span>
          <span class="ind-badge ${card.badge}">${card.badge.toUpperCase()}</span>
        </div>
        <div class="ind-value">${card.value}</div>
        <div class="ind-sub">${card.sub}</div>
        <div class="ind-bar">
          <div class="ind-bar-fill ${card.badge}" style="width: ${barW}%"></div>
        </div>
      </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════
   RENDER — SIGNAL TABLE
   ═══════════════════════════════════════════ */
function renderSignalTable() {
  const tbody = document.getElementById('signalTableBody');
  const countEl = document.getElementById('signalCount');

  /* Filter by current coin + tf */
  const rows = signalHistory.filter(s => s.coin === currentCoin && s.tf === currentTF);
  countEl.textContent = rows.length + ' signals';

  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No signals yet for this coin / timeframe</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(s => {
    const dt   = new Date(s.ts);
    const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const FILTER_NAMES = ['EMA', 'RSI', 'MACD', 'BB', 'STOCH', 'VOL'];
    const pips = Array.from({ length: 6 }, (_, i) => {
      const filled = s.filters[i] === s.type ? 'filled' : '';
      return `<span class="signal-pip ${filled} ${s.type}"></span>`;
    }).join('');
    const tags = s.filters.map((f, i) =>
      f === s.type ? `<span class="signal-filter-tag">${FILTER_NAMES[i]}</span>` : ''
    ).join('');
    const convClass = s.score >= 5 ? 'conviction-high' : s.score >= 3 ? 'conviction-medium' : 'conviction-low';

    return `
      <tr class="${convClass}">
        <td><span class="mono">${time}</span><br><span style="color:var(--text-muted);font-size:.65rem">${date}</span></td>
        <td><span class="signal-type ${s.type}">${s.type === 'long' ? '▲' : '▼'} ${s.type.toUpperCase()}</span></td>
        <td class="price-col">$${Number(s.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td>
          <div class="signal-conviction">
            <span class="mono" style="min-width:20px">${s.score}/6</span>
            <div class="signal-pips">${pips}</div>
          </div>
        </td>
        <td><div class="signal-filters">${tags}</div></td>
      </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════
   MAIN LOAD
   ═══════════════════════════════════════════ */
async function loadData() {
  if (isLoading) return;
  isLoading = true;

  try {
    const [candles, priceData] = await Promise.all([
      fetchCoinGeckoOHLC(currentCoin, currentTF),
      fetchCurrentPrice(currentCoin),
    ]);

    if (!candles || candles.length < 30) {
      showError('Not enough candle data for indicators');
      return;
    }

    /* Price header */
    const priceEl  = document.getElementById('currentPrice');
    const changeEl = document.getElementById('priceChange');
    const updateEl = document.getElementById('lastUpdate');
    priceEl.textContent  = '$' + priceData.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ch = priceData.change;
    changeEl.textContent  = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '% (24h)';
    changeEl.className    = 'price-change ' + (ch >= 0 ? 'positive' : 'negative');
    updateEl.innerHTML    = `<span class="live-pulse"></span>Updated ${new Date().toLocaleTimeString()}`;

    /* Run indicators */
    const result = runMLCSFilters(candles);

    /* Record signal if score >= 3 */
    if (result.score >= 3 && result.direction !== 'neutral') {
      const lastSig = signalHistory.find(s => s.coin === currentCoin && s.tf === currentTF);
      /* Avoid duplicate within 5 min */
      if (!lastSig || Date.now() - lastSig.ts > 5 * 60_000) {
        recordSignal(currentCoin, currentTF, result.direction, priceData.price, result.score, result.filters);
      }
    }

    /* Render */
    renderConvictionPanel(result, currentCoin, currentTF);
    renderIndicators(result, priceData.price);
    renderSignalTable();

    hideLoading();

  } catch (err) {
    console.error('loadData error:', err);
    showError(err.message || 'Failed to fetch data');
  } finally {
    isLoading = false;
  }
}

/* ═══════════════════════════════════════════
   UI HELPERS
   ═══════════════════════════════════════════ */
function hideLoading() {
  document.getElementById('loadingOverlay').classList.add('hidden');
}

function showError(msg) {
  const el = document.getElementById('loadingOverlay');
  el.innerHTML = `
    <div style="text-align:center;padding:20px">
      <div style="font-size:2rem;margin-bottom:12px">⚠️</div>
      <div style="color:var(--red);font-weight:600;margin-bottom:8px">Error loading data</div>
      <div style="color:var(--text-muted);font-size:0.8rem;margin-bottom:16px">${msg}</div>
      <button onclick="refreshData()" style="background:var(--accent);color:#000;padding:8px 20px;border-radius:6px;font-weight:600;cursor:pointer">Retry</button>
    </div>`;
  el.classList.remove('hidden');
  isLoading = false;
}

/* ═══════════════════════════════════════════
   SWITCHERS
   ═══════════════════════════════════════════ */
function switchCoin(coin) {
  if (coin === currentCoin) return;
  currentCoin = coin;
  /* Update active btn */
  document.querySelectorAll('.coin-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.coin === coin);
  });
  /* Show loading */
  document.getElementById('loadingOverlay').classList.remove('hidden');
  document.getElementById('loadingOverlay').innerHTML = `
    <div class="loading-spinner"></div>
    <div class="loading-text">Fetching ${COINS[coin].symbol} data…</div>`;
  loadData();
}

function switchTF(tf) {
  if (tf === currentTF) return;
  currentTF = tf;
  document.querySelectorAll('.tf-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tf === tf);
  });
  loadData();
}

function refreshData() {
  /* Bust cache for current coin/tf */
  delete priceCache[`${currentCoin}_${currentTF}`];
  const overlay = document.getElementById('loadingOverlay');
  overlay.innerHTML = `
    <div class="loading-spinner"></div>
    <div class="loading-text">Refreshing…</div>`;
  overlay.classList.remove('hidden');
  loadData();
}

/* ═══════════════════════════════════════════
   AUTO-REFRESH (60s)
   ═══════════════════════════════════════════ */
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    delete priceCache[`${currentCoin}_${currentTF}`];
    loadData();
  }, 60_000);
}

/* ═══════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', loadDashboard);

function loadDashboard() {
  loadData();
  startAutoRefresh();
}