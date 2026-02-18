const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

const STRATEGY_FILE = path.join(__dirname, 'strategy.json');
const HISTORY_DIR = path.join(__dirname, '.strategy-history');

if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// GET strategy
app.get('/api/strategy', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: 'strategy.json not found' });
  }
});

// PUT strategy (save + backup old)
app.put('/api/strategy', (req, res) => {
  try {
    if (fs.existsSync(STRATEGY_FILE)) {
      const current = fs.readFileSync(STRATEGY_FILE, 'utf8');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(HISTORY_DIR, `strategy-${ts}.json`), current);
    }
    const s = req.body;
    s._lastUpdate = new Date().toISOString().split('T')[0];
    fs.writeFileSync(STRATEGY_FILE, JSON.stringify(s, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET version history
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

// POST rollback
app.post('/api/strategy/rollback', (req, res) => {
  try {
    const { filename } = req.body;
    const bp = path.join(HISTORY_DIR, filename);
    if (!fs.existsSync(bp)) return res.status(404).json({ error: 'Not found' });
    // backup current before rollback
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
