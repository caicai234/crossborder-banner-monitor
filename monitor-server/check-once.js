/**
 * 一次性检测脚本 - 用于手动运行或外部 cron 触发
 * 执行: node check-once.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const SHOT_WIDTH = 800;
const SHOT_HEIGHT = 600;

const SITES = [
  { id: 'amazon',     name: 'Amazon',      url: 'https://www.amazon.com/' },
  { id: 'shein',      name: 'Shein',       url: 'https://us.shein.com/' },
  { id: 'homedepot',  name: 'Home Depot',  url: 'https://www.homedepot.com/' },
  { id: 'temu',       name: 'Temu',        url: 'https://www.temu.com/' },
  { id: 'aliexpress', name: 'AliExpress',  url: 'https://www.aliexpress.com/' },
  { id: 'lowes',      name: "Lowe's",      url: 'https://www.lowes.com/' },
  { id: 'wayfair',    name: 'Wayfair',     url: 'https://www.wayfair.com/', htmlMode: true },
];

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function loadResults() {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8')); }
  catch { return { sites: {}, history: [], lastCheck: null, stats: {} }; }
}

function saveResults(data) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2));
}

function thumUrl(siteUrl) {
  return `https://image.thum.io/get/width/${SHOT_WIDTH}/crop/${SHOT_HEIGHT}/${siteUrl}`;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadScreenshot(siteUrl) {
  const tUrl = thumUrl(siteUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const res = await fetch(tUrl, { signal: controller.signal });
  clearTimeout(timeout);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function computeImageHash(buffer) {
  try {
    const sharp = require('sharp');
    const resized = await sharp(buffer)
      .resize(16, 16, { fit: 'fill' })
      .greyscale().raw().toBuffer();
    const pixels = Array.from(resized);
    const avg = pixels.reduce((a, b) => a + b, 0) / pixels.length;
    let hash = '';
    for (const p of pixels) hash += p > avg ? '1' : '0';
    return hash;
  } catch {
    return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 64);
  }
}

function hammingDistance(h1, h2) {
  if (!h1 || !h2 || h1.length !== h2.length) return 999;
  let d = 0;
  for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) d++;
  return d;
}

async function checkSite(site, data) {
  const prev = data.sites[site.id] || { status: 'baseline', changes: 0, errorCount: 0 };
  log(`  检测 ${site.name}...`);

  try {
    let hash;
    if (site.htmlMode) {
      try {
        const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(site.url)}`, {
          signal: AbortSignal.timeout(40000)
        });
        hash = res.ok
          ? crypto.createHash('sha256').update(await res.text()).digest('hex').slice(0, 64)
          : 'wayfair-manual-' + Date.now();
      } catch { hash = 'wayfair-manual-' + Date.now(); }
    } else {
      const buffer = await downloadScreenshot(site.url);
      ensureDir(SCREENSHOTS_DIR);
      fs.writeFileSync(path.join(SCREENSHOTS_DIR, `${site.id}_latest.jpg`), buffer);
      hash = await computeImageHash(buffer);
    }

    let status = 'normal';
    let changed = false;
    if (site.htmlMode && hash && hash.startsWith('wayfair-manual')) {
      status = 'normal';
    } else if (prev.hash) {
      const dist = hammingDistance(prev.hash, hash);
      if (dist > 15) { status = 'changed'; changed = true; }
    } else {
      status = 'baseline';
    }

    const now = Date.now();
    data.sites[site.id] = {
      status, hash, lastCheck: now,
      lastDist: prev.hash ? hammingDistance(prev.hash, hash) : 0,
      changes: (prev.changes || 0) + (changed ? 1 : 0),
      errorCount: 0,
    };

    if (changed) {
      data.history.unshift({
        site: site.id, siteName: site.name, time: now,
        dist: hammingDistance(prev.hash, hash),
      });
      if (data.history.length > 50) data.history = data.history.slice(0, 50);
      log(`  🔔 ${site.name} BANNER 变化！差异度: ${hammingDistance(prev.hash, hash)}`);
    }
    log(`  ✅ ${site.name}: ${status}${changed ? ' [CHANGED]' : ''}`);

  } catch (e) {
    log(`  ❌ ${site.name}: ${e.message}`);
    data.sites[site.id] = {
      ...prev, status: 'error', lastCheck: Date.now(),
      errorCount: (prev.errorCount || 0) + 1, errorMsg: e.message,
    };
  }
}

(async () => {
  log('🚀 一次性 Banner 检测开始');
  const data = loadResults();

  for (const site of SITES) {
    await checkSite(site, data);
    await sleep(3000);
  }

  data.lastCheck = Date.now();
  data.stats = {
    total: SITES.length,
    changes: Object.values(data.sites).reduce((s, c) => s + (c.changes || 0), 0),
  };
  saveResults(data);
  log('✅ 检测完成');
})();
