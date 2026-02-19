const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '1mb' }));

const STRATEGY_FILE = path.join(__dirname, 'strategy.json');
const HISTORY_DIR = path.join(__dirname, '.strategy-history');
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// ── Yahoo Finance Proxy ──
function yahooFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Yahoo parse error')); }
      });
    }).on('error', reject);
  });
}

// ── OKX API Proxy ──
app.get('/api/okx/candles/:instId', async (req, res) => {
  try {
    const { instId } = req.params;
    const barRaw = req.query.bar || '1H';
    const BAR_MAP = {'1h':'1H','2h':'2H','4h':'4H','6h':'6H','12h':'12H','1d':'1D','1w':'1W','1mo':'1M'};
    const bar = BAR_MAP[barRaw] || barRaw;

    // Determine how many pages to fetch based on timeframe
    // OKX max 300 per request; we want ~500+ candles for good backtest
    const pagesMap = {'1m':1,'5m':2,'15m':3,'30m':3,'1H':5,'2H':5,'4H':6,'6H':6,'12H':5,'1D':7,'1W':4,'1M':3};
    const pages = pagesMap[bar] || 2;

    let allCandles = [];
    let after = '';

    for (let p = 0; p < pages; p++) {
      const params = `instId=${encodeURIComponent(instId)}&bar=${bar}&limit=300${after ? '&after=' + after : ''}`;
      // First page: /candles (recent), subsequent pages: /history-candles (older)
      const endpoint = p === 0 ? 'candles' : 'history-candles';
      const url = `https://www.okx.com/api/v5/market/${endpoint}?${params}`;
      const data = await yahooFetch(url);

      if (data.code !== '0' || !data.data?.length) break;

      // OKX returns newest first
      allCandles = allCandles.concat(data.data);

      // 'after' = oldest timestamp in this batch → fetches older data next
      const oldest = data.data[data.data.length - 1][0];
      after = oldest;

      // If less than 300 returned, no more data
      if (data.data.length < 300) break;
    }

    if (!allCandles.length) {
      return res.status(404).json({ error: 'OKX: No data for ' + instId + ' ' + bar });
    }

    // Deduplicate by timestamp, sort chronologically (oldest first)
    const seen = new Set();
    const candles = allCandles
      .filter(k => {
        if (seen.has(k[0])) return false;
        seen.add(k[0]);
        return true;
      })
      .sort((a, b) => +a[0] - +b[0])
      .map(k => ({
        time: Math.floor(+k[0] / 1000),
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
      }))
      .filter(c => c.open && c.close);

    res.json({ instId, bar, pages: allCandles.length, candles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// OKX instruments search (cached)
let okxInstrumentsCache = null;
let okxCacheTime = 0;
app.get('/api/search/okx', async (req, res) => {
  try {
    const q = (req.query.q || '').toUpperCase();
    if (q.length < 1) return res.json([]);

    // Cache for 1 hour
    if (!okxInstrumentsCache || Date.now() - okxCacheTime > 3600000) {
      const data = await yahooFetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT');
      okxInstrumentsCache = (data.data || [])
        .filter(i => i.instId.endsWith('-USDT') && i.state === 'live')
        .map(i => ({ symbol: i.instId, base: i.baseCcy, name: i.baseCcy + '/USDT' }));
      okxCacheTime = Date.now();
    }

    const results = okxInstrumentsCache
      .filter(s => s.symbol.includes(q) || s.base.includes(q))
      .slice(0, 15);
    res.json(results);
  } catch (e) { res.json([]); }
});

// Yahoo Finance OHLCV endpoint
app.get('/api/yahoo/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const range = req.query.range || '1y';
    const interval = req.query.interval || '1d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
    const data = await yahooFetch(url);

    if (!data.chart?.result?.[0]) {
      return res.status(404).json({ error: 'Symbol not found' });
    }

    const r = data.chart.result[0];
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const candles = ts.map((t, i) => ({
      time: t,
      open: q.open?.[i] || 0,
      high: q.high?.[i] || 0,
      low: q.low?.[i] || 0,
      close: q.close?.[i] || 0,
      volume: q.volume?.[i] || 0,
    })).filter(c => c.open && c.close && c.high && c.low);

    res.json({
      symbol,
      currency: r.meta?.currency || 'USD',
      exchange: r.meta?.exchangeName || '',
      name: r.meta?.shortName || symbol,
      candles,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Symbol Search APIs ──
// Yahoo Finance autocomplete
app.get('/api/search/yahoo', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (q.length < 1) return res.json([]);
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0`;
    const data = await yahooFetch(url);
    const results = (data.quotes || [])
      .filter(r => r.symbol && r.quoteType !== 'MUTUALFUND')
      .map(r => ({
        symbol: r.symbol,
        name: r.shortname || r.longname || r.symbol,
        type: r.quoteType || '',
        exchange: r.exchange || '',
      }));
    res.json(results);
  } catch (e) { res.json([]); }
});

// OKX SWAP instruments (perpetual futures) — lever, ctVal, ctMult, minSz
let okxSwapCache = null;
let okxSwapCacheTime = 0;
app.get('/api/okx/swap-info', async (req, res) => {
  try {
    if (!okxSwapCache || Date.now() - okxSwapCacheTime > 3600000) {
      const data = await yahooFetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
      okxSwapCache = {};
      (data.data || []).filter(i => i.instId.endsWith('-USDT-SWAP') && i.state === 'live').forEach(i => {
        const base = i.instId.replace('-USDT-SWAP', '');
        okxSwapCache[base] = {
          instId: i.instId,
          maxLever: +i.lever || 75,
          ctVal: +i.ctVal || 1,
          ctMult: +i.ctMult || 1,
          minSz: +i.minSz || 1,
          lotSz: +i.lotSz || 1,
          tickSz: +i.tickSz || 0.01,
          ctValCcy: i.ctValCcy || 'USD',
        };
      });
      okxSwapCacheTime = Date.now();
    }
    const sym = req.query.sym; // e.g. "BTC" or "all"
    if (sym && sym !== 'all' && okxSwapCache[sym]) {
      res.json(okxSwapCache[sym]);
    } else {
      res.json(okxSwapCache);
    }
  } catch (e) { res.json({}); }
});

// ── Strategy APIs ──
app.get('/api/strategy', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8'))); }
  catch (e) { res.status(500).json({ error: 'strategy.json not found' }); }
});

app.put('/api/strategy', (req, res) => {
  try {
    if (fs.existsSync(STRATEGY_FILE)) {
      const cur = fs.readFileSync(STRATEGY_FILE, 'utf8');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(HISTORY_DIR, `strategy-${ts}.json`), cur);
    }
    const s = req.body;
    s._lastUpdate = new Date().toISOString().split('T')[0];
    fs.writeFileSync(STRATEGY_FILE, JSON.stringify(s, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/strategy/history', (req, res) => {
  try {
    if (!fs.existsSync(HISTORY_DIR)) return res.json([]);
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 20);
    const history = files.map(f => {
      const stat = fs.statSync(path.join(HISTORY_DIR, f));
      let ver = '?';
      try { ver = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'))._version || '?'; } catch {}
      return { filename: f, date: stat.mtime.toISOString(), version: ver };
    });
    res.json(history);
  } catch (e) { res.json([]); }
});

app.post('/api/strategy/rollback', (req, res) => {
  try {
    const { filename } = req.body;
    const bp = path.join(HISTORY_DIR, filename);
    if (!fs.existsSync(bp)) return res.status(404).json({ error: 'Not found' });
    const cur = fs.readFileSync(STRATEGY_FILE, 'utf8');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(HISTORY_DIR, `strategy-${ts}-pre-rollback.json`), cur);
    fs.writeFileSync(STRATEGY_FILE, fs.readFileSync(bp, 'utf8'));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Martingale Backtester running on port ${PORT}`));
