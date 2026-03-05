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
