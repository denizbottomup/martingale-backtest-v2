# Martingale V2 Backtester

Pine Script Martingale strategy backtester with **live Binance data**.

## Features

- 🔴 **26 crypto pairs** — BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, DOT, LINK...
- ⏱ **5 timeframes** — 15m, 1h, 4h, 1d, 1w
- 📡 **Live price** via Binance WebSocket
- 📊 **4 chart views** — Equity curve, Drawdown, Price, Trade Log
- 🎛 **Full parameter control** — Allocation %, APTR, Profit Target, EMA, RSI
- 🤖 **Auto/Manual mode** — ATR-based or fixed values
- 📈 **Risk analysis** — Win rate, Profit Factor, Max DD, R:R, Verdict

## Deploy to Railway

### 1. Create GitHub repo

```bash
cd martingale-backtest
git init
git add .
git commit -m "Initial commit"
gh repo create martingale-backtest --public --push
```

### 2. Deploy on Railway

1. Go to [railway.app](https://railway.app)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select `martingale-backtest`
4. Railway auto-detects Node.js → deploys automatically
5. Click **"Generate Domain"** in Settings to get a public URL

That's it! No env variables needed — Binance public API requires no auth.

### Alternative: One-click deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

## Local Development

```bash
npm install
npm start
# Open http://localhost:3000
```

## Tech Stack

- **Frontend**: React 18 + Recharts (CDN, no build step)
- **Backend**: Express.js (static file server)
- **Data**: Binance REST API (klines) + WebSocket (live price)
- **Deploy**: Railway (Node.js)

## Pine Script Source

Based on `Martingale V2 [MANUAL]` strategy for TradingView.
