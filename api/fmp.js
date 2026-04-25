const cache = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function yahooFetch(ticker) {
  const fetch = (await import('node-fetch')).default;

  const cookieRes = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const cookies = (cookieRes.headers.get('set-cookie') || '').split(';')[0];

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cookie': cookies
    }
  });
  const crumb = await crumbRes.text();

  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=price,defaultKeyStatistics,financialData,summaryDetail,cashflowStatementHistory&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cookie': cookies
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Yahoo Finance`);
  return res.json();
}

async function yahooHistory(ticker, days) {
  const fetch = (await import('node-fetch')).default;
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - days * 86400;

  const cookieRes = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const cookies = (cookieRes.headers.get('set-cookie') || '').split(';')[0];
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookies }
  });
  const crumb = await crumbRes.text();

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${period1}&period2=${period2}&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookies }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action = '', ticker: rawTicker = '', period = '3m' } = req.query;
  const ticker = rawTicker.toUpperCase().trim();
  const yahooTicker = ticker.replace('.', '-');

  try {
    // Connection test
    if (action === 'test') {
      const data = await yahooFetch('AAPL');
      const ok = !!(data?.quoteSummary?.result?.[0]?.price?.regularMarketPrice?.raw);
      return res.json({ ok });
    }

    // Price history
    if (action === 'history') {
      if (!ticker) return res.status(400).json({ error: 'ticker required' });
      const days = period === '1m' ? 30 : period === '3m' ? 90 : 365;
      const data = await yahooHistory(yahooTicker, days);
      const chart = data?.chart?.result?.[0];
      if (!chart) return res.json([]);
      const timestamps = chart.timestamp || [];
      const closes = chart.indicators?.quote?.[0]?.close || [];
      const result = timestamps
        .map((t, i) => ({
          date: new Date(t * 1000).toISOString().split('T')[0],
          close: parseFloat(closes[i]?.toFixed(2)) || 0
        }))
        .filter(d => d.close > 0);
      return res.json(result);
    }

    // Full fundamentals
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    if (cache[ticker] && (Date.now() - cache[ticker].fetchedAt < CACHE_TTL)) {
      return res.json(cache[ticker]);
    }

    const data = await yahooFetch(yahooTicker);
    const r = data?.quoteSummary?.result?.[0];
    if (!r) return res.status(404).json({ error: 'Ticker not found' });

    const pr = r.price                || {};
    const ks = r.defaultKeyStatistics || {};
    const fd = r.financialData        || {};
    const sd = r.summaryDetail        || {};
    const cf = r.cashflowStatementHistory?.cashflowStatements?.[0] || {};

    const price    = pr.regularMarketPrice?.raw       || 0;
    const eps      = ks.trailingEps?.raw               || 0;
    const div      = sd.dividendRate?.raw              || 0;
    const beta     = ks.beta?.raw                      || 1.2;
    const shares   = (ks.sharesOutstanding?.raw / 1e6) || 0;
    const pe       = ks.trailingPE?.raw                || 25;
    const evEbitda = ks.enterpriseToEbitda?.raw        || 15;
    const name     = pr.longName || pr.shortName       || ticker;

    const operatingCF = cf.totalCashFromOperatingActivities?.raw || 0;
    const capex       = Math.abs(cf.capitalExpenditures?.raw     || 0);
    const fcf         = Math.max((operatingCF - capex) / 1e6, 0);

    const totalDebt = fd.totalDebt?.raw || 0;
    const totalCash = fd.totalCash?.raw || 0;
    const netDebt   = Math.max((totalDebt - totalCash) / 1e6, 0);

    const revenueGrowth = fd.revenueGrowth?.raw || 0.08;
    const revGrowthPct  = Math.abs(revenueGrowth) < 2 ? revenueGrowth * 100 : revenueGrowth;
    const g1 = Math.min(Math.max(revGrowthPct, 2), 30);
    const g2 = Math.min(Math.max(revGrowthPct * 0.6, 2), 20);

    const result = {
      name, sector: '', industry: '',
      price, eps, div, fcf, shares,
      debt: netDebt, beta, g1, g2,
      tg: 2.5, wacc: 9, fcfm: 22,
      perT: Math.min(Math.max(pe, 10), 80),
      perG: Math.round(g1),
      evM:  Math.min(Math.max(evEbitda, 5), 50),
      evMg: 30,
      grG:  Math.round(g1 * 0.8),
      grY:  4.5,
      ddmG: div > 0 ? Math.min(g1 * 0.5, 8) : 0,
      ddmR: 8,
      fromApi:   true,
      fetchedAt: Date.now(),
    };

    cache[ticker] = result;
    return res.json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
