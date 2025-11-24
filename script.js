// ===== CONFIG =====
const CONFIG = {
    API: 'https://api.coingecko.com/api/v3',
    HF: 'https://api-inference.huggingface.co/models/google/gemma-2b',
    CACHE_TTL: 60000
};

const STATE = {
    coins: JSON.parse(localStorage.getItem('coins') || '[]'),
    signals: new Map(),
    chart: null
};

// ===== UTILS =====
const $ = id => document.getElementById(id);
const toast = (msg, duration = 2500) => {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), duration);
};

const cache = {
    get: k => {
        const data = localStorage.getItem(`cache_${k}`);
        const meta = localStorage.getItem(`cache_${k}_meta`);
        if (!data || !meta) return null;
        return Date.now() - JSON.parse(meta).t > CONFIG.CACHE_TTL ? null : JSON.parse(data);
    },
    set: (k, v) => {
        localStorage.setItem(`cache_${k}`, JSON.stringify(v));
        localStorage.setItem(`cache_${k}_meta`, JSON.stringify({ t: Date.now() }));
    }
};

// ===== FETCH WITH CACHE =====
async function fetchAPI(url, name) {
    if (!navigator.onLine) {
        const c = cache.get(name);
        if (c) { toast('Using offline data', 'warning'); return c; }
        throw new Error('Offline');
    }
    
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(r.status);
        const d = await r.json();
        cache.set(name, d);
        return d;
    } catch (e) {
        const c = cache.get(name);
        if (c) { toast('Using cached data', 'warning'); return c; }
        throw e;
    }
}

// ===== LOAD COINS =====
async function loadCoins() {
    try {
        const url = `${CONFIG.API}/coins/markets?vs_currency=usd&per_page=50&price_change_percentage=1h`;
        const coins = await fetchAPI(url, 'coins');
        STATE.coins = coins;
        localStorage.setItem('coins', JSON.stringify(coins.slice(0, 20)));
        renderCoins(coins.slice(0, 20));
        coins.slice(0, 5).forEach(c => generateSignal(c));
    } catch (e) {
        toast(`Load failed: ${e.message}`);
        renderCoins(STATE.coins);
    }
}

// ===== RENDER COINS =====
function renderCoins(coins) {
    $('coins').innerHTML = coins.map(c => `
        <div class="coin-card" data-id="${c.id}">
            <div class="coin-symbol">${c.symbol.toUpperCase()}</div>
            <div class="coin-price ${c.price_change_percentage_1h_in_currency > 0 ? 'up' : 'down'}">
                $${c.current_price.toFixed(2)}
            </div>
            <div class="coin-change ${c.price_change_percentage_1h_in_currency > 0 ? 'up' : 'down'}">
                ${c.price_change_percentage_1h_in_currency?.toFixed(2)}%
            </div>
        </div>
    `).join('');
    
    document.querySelectorAll('.coin-card').forEach(card => {
        card.onclick = () => {
            document.querySelectorAll('.coin-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            loadChart(card.dataset.id);
            generateSignal(STATE.coins.find(c => c.id === card.dataset.id));
        };
    });
}

// ===== GENERATE SIGNAL =====
async function generateSignal(coin) {
    if (!coin) return;
    
    try {
        // Get price data
        const url = `${CONFIG.API}/coins/${coin.id}/market_chart?vs_currency=usd&days=1&interval=5m`;
        const data = await fetchAPI(url, `chart_${coin.id}`);
        const prices = data.prices.map(p => p[1]);
        
        // Calculate indicators
        const ind = calculateIndicators(prices);
        
        // Try AI API
        let signal = await callAI(coin, ind);
        
        // Fallback to local logic
        if (!signal) signal = localSignal(coin, ind);
        
        STATE.signals.set(coin.id, {...signal, symbol: coin.symbol});
        renderSignals();
        if (signal.confidence > 80) playAlert();
    } catch (e) {
        console.warn(`Signal failed for ${coin.id}: ${e.message}`);
    }
}

// ===== CALL HUGGINGFACE AI =====
async function callAI(coin, ind) {
    try {
        const prompt = JSON.stringify({
            data: { coin: coin.name, price: coin.current_price, rsi: ind.rsi, macd: ind.macd.histogram },
            required: { decision: "Buy|Sell|Hold", confidence: "0-100", entry: "number", stoploss: "number" }
        });
        
        const res = await fetch(CONFIG.HF, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 100 } }),
            signal: AbortSignal.timeout(5000)
        });
        
        if (res.status === 429) { toast('AI rate limited'); return null; }
        if (!res.ok) throw new Error(res.status);
        
        const data = await res.json();
        const match = data[0]?.generated_text?.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
    } catch (e) {
        return null;
    }
}

// ===== LOCAL SIGNAL LOGIC =====
function localSignal(coin, ind) {
    const rsi = ind.rsi;
    const price = coin.current_price;
    let decision = 'Hold', confidence = 50;
    
    if (rsi < 30) { decision = 'Buy'; confidence = 75; }
    else if (rsi > 70) { decision = 'Sell'; confidence = 75; }
    
    return {
        decision,
        confidence,
        entry_price: price,
        stoploss: price * 0.99,
        take_profit: price * (decision === 'Buy' ? 1.02 : 0.98),
        explanation: `RSI: ${rsi.toFixed(1)}`
    };
}

// ===== CALCULATE INDICATORS =====
function calculateIndicators(prices) {
    // Simple RSI
    const rsi = calculateRSI(prices);
    const macd = calculateMACD(prices);
    const bb = calculateBollinger(prices);
    return { rsi, macd, bollinger_bands: bb };
}

function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change; else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateEMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1];
    const multiplier = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = (prices[i] - ema) * multiplier + ema;
    }
    return ema;
}

function calculateMACD(prices) {
    const ema12 = calculateEMA(prices, 12);
    const ema26 = calculateEMA(prices, 26);
    const macd = ema12 - ema26;
    const signal = calculateEMA([macd], 9);
    return { histogram: macd - signal };
}

function calculateBollinger(prices, period = 20) {
    if (prices.length < period) return { upper: prices[0], middle: prices[0], lower: prices[0] };
    const sma = prices.slice(-period).reduce((a, b) => a + b) / period;
    const variance = prices.slice(-period).reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    return { upper: sma + 2 * std, middle: sma, lower: sma - 2 * std };
}

// ===== RENDER SIGNALS =====
function renderSignals() {
    const signals = Array.from(STATE.signals.values()).slice(0, 3);
    $('signals').innerHTML = signals.map(s => `
        <div class="signal">
            <div class="signal-title">
                <span>${s.symbol}</span>
                <span class="signal-decision ${s.decision}">${s.decision}</span>
            </div>
            <div class="signal-details">
                Confidence: ${s.confidence}% | Entry: $${s.entry_price?.toFixed(2)}
            </div>
        </div>
    `).join('');
}

// ===== LOAD CHART =====
async function loadChart(coinId) {
    const coin = STATE.coins.find(c => c.id === coinId);
    if (!coin) return;
    
    $('chartSymbol').textContent = coin.symbol.toUpperCase();
    
    if (STATE.chart) STATE.chart.remove();
    
    STATE.chart = LightweightCharts.createChart($('chart'), {
        layout: { background: { color: 'transparent' }, textColor: '#e2e8f0' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
        width: $('chart').clientWidth,
        height: 250
    });
    
    const url = `${CONFIG.API}/coins/${coinId}/market_chart?vs_currency=usd&days=1&interval=15m`;
    const data = await fetchAPI(url, `chart_${coinId}`);
    const series = STATE.chart.addCandlestickSeries();
    
    const candles = data.prices.map((p, i) => ({
        time: p[0] / 1000,
        open: p[1] * 0.99,
        high: p[1] * 1.01,
        low: p[1] * 0.98,
        close: p[1]
    }));
    
    series.setData(candles);
}

// ===== LOAD SENTIMENT =====
async function loadSentiment() {
    try {
        const fng = await fetchAPI('https://api.alternative.me/fng/?limit=1', 'fng');
        $('fng').classList.remove('skeleton');
        $('fng').textContent = fng.data[0].value;
        
        const gas = await fetchAPI('https://api.blocknative.com/gasprices/blockprices', 'gas');
        $('gas').classList.remove('skeleton');
        $('gas').textContent = Math.round(gas.blockPrices[0].estimatedPrices[0].price);
    } catch (e) {
        $('fng').textContent = 'N/A';
        $('gas').textContent = 'N/A';
    }
}

// ===== LOAD NEWS =====
async function loadNews() {
    try {
        const data = await fetchAPI('https://cryptopanic.com/api/free/v1/posts/?auth_token=demo&filter=hot', 'news');
        $('news').innerHTML = data.results.slice(0, 5).map(n => `
            <div class="news-item">
                <div class="news-title">${n.title}</div>
                <div class="news-meta">${n.source_domain}</div>
            </div>
        `).join('');
    } catch (e) {
        $('news').innerHTML = '<div class="news-item">📴 Offline</div>';
    }
}

// ===== AUDIO ALERT =====
function playAlert() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain).connect(ctx.destination);
        osc.frequency.value = 800;
        gain.gain.value = 0.1;
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
        if (navigator.vibrate) navigator.vibrate(200);
    } catch (e) {}
}

// ===== EVENTS =====
$('themeToggle').onclick = () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    $('themeToggle').textContent = isDark ? '☀️' : '🌙';
};

// ===== INIT =====
async function init() {
    await Promise.all([loadCoins(), loadSentiment(), loadNews()]);
    $('loader').style.opacity = '0';
    setTimeout(() => { $('loader').remove(); $('main').style.display = 'block'; }, 500);
    toast('✅ Ready!');
    
    setInterval(() => {
        if (!document.hidden) loadCoins();
    }, 5000);
}

// Start
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
