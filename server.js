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

// Binance symbol search (from exchange info, cached)
let binanceSymbolsCache = null;
let binanceCacheTime = 0;
app.get('/api/search/binance', async (req, res) => {
  try {
    const q = (req.query.q || '').toUpperCase();
    if (q.length < 1) return res.json([]);

    // Cache for 1 hour
    if (!binanceSymbolsCache || Date.now() - binanceCacheTime > 3600000) {
      const data = await new Promise((resolve, reject) => {
        https.get('https://api.binance.com/api/v3/exchangeInfo', (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
      binanceSymbolsCache = (data.symbols || [])
        .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT')
        .map(s => ({ symbol: s.symbol, base: s.baseAsset, name: s.baseAsset + '/USDT' }));
      binanceCacheTime = Date.now();
    }

    const results = binanceSymbolsCache
      .filter(s => s.symbol.includes(q) || s.base.includes(q))
      .slice(0, 15);
    res.json(results);
  } catch (e) { res.json([]); }
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
