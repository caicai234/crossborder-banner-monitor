/**
 * CloudStudio 云端 Banner 监控服务器
 * 零依赖，纯 Node.js 内置模块
 * 部署后 24/7 运行，电脑关机也不影响
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============ 配置 ============
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'monitor-server', 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const SHOT_WIDTH = 800;
const SHOT_HEIGHT = 600;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12小时检测一次

const SITES = [
  { id: 'amazon',     name: 'Amazon',      url: 'https://www.amazon.com/' },
  { id: 'shein',      name: 'Shein',       url: 'https://us.shein.com/' },
  { id: 'homedepot',  name: 'Home Depot',  url: 'https://www.homedepot.com/' },
  { id: 'temu',       name: 'Temu',        url: 'https://www.temu.com/' },
  { id: 'aliexpress', name: 'AliExpress',  url: 'https://www.aliexpress.com/' },
  { id: 'lowes',      name: "Lowe's",      url: 'https://www.lowes.com/' },
  { id: 'wayfair',    name: 'Wayfair',     url: 'https://www.wayfair.com/', htmlMode: true },
];

// ============ 工具 ============
const log = (msg) => {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${ts}] ${msg}`);
};

const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

const loadResults = () => {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8')); }
  catch { return { sites: {}, history: [], lastCheck: null, stats: { total: 0, changes: 0, last24h: 0 } }; }
};

const saveResults = (data) => {
  ensureDir(DATA_DIR);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============ 截图下载 ============
const thumUrl = (siteUrl) => `https://image.thum.io/get/width/${SHOT_WIDTH}/crop/${SHOT_HEIGHT}/${siteUrl}`;

async function downloadScreenshot(siteUrl, siteId) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);
      const res = await fetch(thumUrl(siteUrl), { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 500) throw new Error('截图太小');
      return buffer;
    } catch (e) {
      if (attempt < 2) { log(`  ⚠️ ${siteId} 重试 ${attempt + 1}: ${e.message}`); await sleep(10000); }
      else throw e;
    }
  }
}

// ============ 图片哈希 ============
function computeImageHash(buffer) {
  const sampleSize = 256;
  const step = Math.max(1, Math.floor(buffer.length / sampleSize));
  const samples = [];
  for (let i = 0; i < buffer.length && samples.length < sampleSize; i += step) samples.push(buffer[i]);
  while (samples.length < sampleSize) samples.push(0);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  let hash = '';
  for (let i = 0; i < samples.length; i++) hash += samples[i] > avg ? '1' : '0';
  return hash;
}

function hammingDistance(h1, h2) {
  if (!h1 || !h2 || h1.length !== h2.length) return 999;
  let d = 0;
  for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) d++;
  return d;
}

// ============ 检测 ============
async function checkSite(site, data) {
  const prev = data.sites[site.id] || { status: 'pending', changes: 0, errorCount: 0 };
  data.sites[site.id] = { ...prev, status: 'checking', lastCheck: Date.now() };

  try {
    let hash;
    if (site.htmlMode) {
      try {
        const res = await fetch(
          `https://api.allorigins.win/raw?url=${encodeURIComponent(site.url)}`,
          { signal: AbortSignal.timeout(40000) }
        );
        hash = res.ok
          ? crypto.createHash('sha256').update(await res.text()).digest('hex').slice(0, 64)
          : `wayfair-manual-${Date.now()}`;
      } catch { hash = `wayfair-manual-${Date.now()}`; }
    } else {
      const buffer = await downloadScreenshot(site.url, site.id);
      hash = computeImageHash(buffer);
    }

    let status = 'normal', changed = false;
    if (site.htmlMode && hash.startsWith('wayfair-manual')) {
      status = 'normal';
    } else if (prev.hash) {
      const dist = hammingDistance(prev.hash, hash);
      if (dist > 15) { status = 'changed'; changed = true; }
    } else {
      status = 'baseline';
    }

    const dist = prev.hash ? hammingDistance(prev.hash, hash) : 0;
    data.sites[site.id] = {
      status, hash, lastCheck: Date.now(), lastDist: dist,
      changes: (prev.changes || 0) + (changed ? 1 : 0), errorCount: 0,
    };

    if (changed) {
      data.history.unshift({
        site: site.id, siteName: site.name,
        time: Date.now(), dist,
        oldHash: prev.hash ? prev.hash.slice(0, 16) + '...' : 'none',
        newHash: hash.slice(0, 16) + '...',
      });
      if (data.history.length > 50) data.history = data.history.slice(0, 50);
      log(`  🔔 ${site.name} BANNER变化！差异:${dist}`);
    }
    log(`  ✅ ${site.name}: ${status}${changed ? ' [CHANGED!]' : ''}`);
    return { status, changed };
  } catch (e) {
    log(`  ❌ ${site.name}: ${e.message}`);
    data.sites[site.id] = {
      ...prev, status: 'error', lastCheck: Date.now(),
      errorCount: (prev.errorCount || 0) + 1,
      lastError: e.message.slice(0, 100),
    };
    return { status: 'error', changed: false };
  }
}

async function checkAll() {
  log('🚀 开始全量检测...');
  const data = loadResults();
  const start = Date.now();
  let changed = 0;

  for (let i = 0; i < SITES.length; i++) {
    const r = await checkSite(SITES[i], data);
    if (r.changed) changed++;
    if (i < SITES.length - 1) await sleep(2000);
  }

  data.lastCheck = Date.now();
  const changed24h = data.history.filter(h => h.time > Date.now() - 86400000).length;
  data.stats = {
    total: SITES.length,
    ok: SITES.length - Object.values(data.sites).filter(s => s.status === 'error').length,
    failed: Object.values(data.sites).filter(s => s.status === 'error').length,
    changed,
    totalChanges: Object.values(data.sites).reduce((s, c) => s + (c.changes || 0), 0),
    last24h: changed24h,
  };
  saveResults(data);
  log(`✅ 检测完成 | 变化:${changed} | 耗时:${((Date.now()-start)/1000).toFixed(1)}s`);
}

// ============ HTTP 服务器 ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API
  if (url.pathname === '/api/status') {
    const data = loadResults();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      online: true, uptime: process.uptime(),
      lastCheck: data.lastCheck, stats: data.stats,
      sites: Object.entries(data.sites).map(([id, s]) => ({
        id, name: SITES.find(s2=>s2.id===id)?.name||id,
        status: s.status, lastCheck: s.lastCheck,
        changes: s.changes||0, lastDist: s.lastDist,
      })),
    }));
    return;
  }

  if (url.pathname === '/api/results') {
    const data = loadResults();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url.pathname === '/api/check' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started' }));
    checkAll().catch(e => log(`手动检测失败: ${e.message}`));
    return;
  }

  // 静态文件
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(__dirname, safePath);
  if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory()) {
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(fs.readFileSync(fullPath));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ============ 启动 ============
ensureDir(DATA_DIR);

server.listen(PORT, '0.0.0.0', () => {
  log('═══════════════════════════════');
  log('🖥  CloudStudio 云端监控服务器');
  log(`📍 端口: ${PORT}`);
  log(`🔄 检测间隔: ${CHECK_INTERVAL_MS/3600000}h`);
  log(`📊 API: /api/status /api/results`);
  log('═══════════════════════════════');

  // 启动5秒后首次检测
  setTimeout(async () => {
    await checkAll();
    // 之后每12小时检测一次
    setInterval(async () => {
      log('⏰ 定时检测触发...');
      await checkAll();
    }, CHECK_INTERVAL_MS);
  }, 5000);

  // 心跳
  setInterval(() => {
    const data = loadResults();
    const ok = Object.values(data.sites).filter(s => s.status !== 'error').length;
    log(`💓 心跳 | 正常:${ok}/${SITES.length} | 运行:${Math.floor(process.uptime()/3600)}h`);
  }, 3600000);
});

// 防崩溃
process.on('uncaughtException', (e) => log(`❌ 异常: ${e.message}`));
process.on('unhandledRejection', (e) => log(`❌ Promise拒绝: ${e?.message || e}`));
