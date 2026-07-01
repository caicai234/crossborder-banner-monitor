/**
 * Banner 云端检测脚本 — 专为 GitHub Actions 设计
 * 每天自动运行，截图 → 哈希对比 → 记录变化 → 写入 results.json
 * 完全不依赖本地文件系统持久化
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============ 配置 ============
const DATA_DIR = path.join(__dirname, 'monitor-server', 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const SHOT_WIDTH = 800;
const SHOT_HEIGHT = 600;
const CHANGE_THRESHOLD = 18; // 汉明距离阈值，与前端默认值一致

const SITES = [
  { id: 'amazon',     name: 'Amazon',      url: 'https://www.amazon.com/' },
  { id: 'shein',      name: 'Shein',       url: 'https://us.shein.com/' },
  { id: 'homedepot',  name: 'Home Depot',  url: 'https://www.homedepot.com/' },
  { id: 'temu',       name: 'Temu',        url: 'https://www.temu.com/' },
  { id: 'aliexpress', name: 'AliExpress',  url: 'https://www.aliexpress.com/', htmlMode: true,
    proxyUrl: 'https://translate.google.com/translate?hl=en&sl=en&u=https://www.aliexpress.com/' },
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
const thumUrl = (siteUrl, opts) => {
  const base = `https://image.thum.io/get/width/${SHOT_WIDTH}/crop/${SHOT_HEIGHT}`;
  const extra = opts ? `/${opts}` : '';
  return `${base}${extra}/${siteUrl}`;
};

async function downloadScreenshot(siteUrl, siteId, opts) {
  const url = thumUrl(siteUrl, opts);
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        log(`  ⚠️ ${siteId} HTTP ${res.status}, 重试 ${attempt + 1}/${maxRetries}`);
        await sleep(5000);
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 500) {
        log(`  ⚠️ ${siteId} 截图太小(${buffer.length}字节), 重试 ${attempt + 1}/${maxRetries}`);
        await sleep(5000);
        continue;
      }

      return buffer;
    } catch (e) {
      if (attempt < maxRetries) {
        log(`  ⚠️ ${siteId} 下载失败: ${e.message}, 重试 ${attempt + 1}/${maxRetries}`);
        await sleep(10000);
      } else {
        throw e;
      }
    }
  }
  throw new Error('所有重试均失败');
}

// ============ 图片哈希（纯 JS，零依赖） ============
function computeImageHash(buffer) {
  // 特征采样法：均匀取256个字节，二值化
  const sampleSize = 256;
  const step = Math.max(1, Math.floor(buffer.length / sampleSize));
  const samples = [];
  for (let i = 0; i < buffer.length && samples.length < sampleSize; i += step) {
    samples.push(buffer[i]);
  }
  // 填满到256
  while (samples.length < sampleSize) samples.push(0);

  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  let hash = '';
  for (let i = 0; i < samples.length; i++) {
    hash += samples[i] > avg ? '1' : '0';
  }
  return hash;
}

function hammingDistance(h1, h2) {
  if (!h1 || !h2 || h1.length !== h2.length) return 999;
  let d = 0;
  for (let i = 0; i < h1.length; i++) {
    if (h1[i] !== h2[i]) d++;
  }
  return d;
}

// ============ 检测单个网站 ============
async function checkSite(site, data) {
  const prev = data.sites[site.id] || { status: 'pending', changes: 0, errorCount: 0 };
  data.sites[site.id] = { ...prev, status: 'checking', lastCheck: Date.now() };
  log(`  🔍 正在检测 ${site.name}...`);

  try {
    let hash;

    // 反爬平台处理
    if (site.htmlMode) {
      // 策略1: 如果配了 proxyUrl，通过代理 URL + thum.io 截图
      if (site.proxyUrl) {
        try {
          const buffer = await downloadScreenshot(site.proxyUrl, site.id);
          hash = computeImageHash(buffer);
          log(`  ✅ ${site.name} 代理截图成功 (${hash.length}bit哈希)`);
        } catch (e) {
          log(`  ⚠️ ${site.name} 代理截图失败: ${e.message}, 尝试HTML模式...`);
          // 策略2: 降级为 HTML 代理
          try {
            const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(site.url)}`, {
              signal: AbortSignal.timeout(40000)
            });
            if (res.ok) {
              const html = await res.text();
              hash = crypto.createHash('sha256').update(html.slice(0, 50000)).digest('hex').slice(0, 64);
            } else {
              hash = `${site.id}-manual-placeholder`;
            }
          } catch {
            hash = `${site.id}-manual-placeholder`;
          }
        }
      } else {
        // 无 proxyUrl，直接 HTML 代理
        try {
          const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(site.url)}`, {
            signal: AbortSignal.timeout(40000)
          });
          if (res.ok) {
            const html = await res.text();
            hash = crypto.createHash('sha256').update(html.slice(0, 50000)).digest('hex').slice(0, 64);
          } else {
            hash = `${site.id}-manual-placeholder`;
          }
        } catch {
          hash = `${site.id}-manual-placeholder`;
        }
      }
    } else {
      // 正常平台：下载截图 + 计算哈希
      const buffer = await downloadScreenshot(site.url, site.id, site.thumOpts);
      hash = computeImageHash(buffer);
    }

    // 对比哈希
    let status = 'normal';
    let changed = false;

    if (site.htmlMode && hash && hash.includes('manual')) {
      status = 'manual';
    } else if (prev.hash && !prev.hash.includes('manual')) {
      const dist = hammingDistance(prev.hash, hash);
      if (dist > CHANGE_THRESHOLD) {
        status = 'changed';
        changed = true;
      }
    } else {
      status = 'baseline';
    }

    const dist = prev.hash ? hammingDistance(prev.hash, hash) : 0;
    data.sites[site.id] = {
      status,
      hash,
      lastCheck: Date.now(),
      lastDist: dist,
      changes: (prev.changes || 0) + (changed ? 1 : 0),
      errorCount: 0,
    };

    // 记录变化历史
    if (changed) {
      data.history.unshift({
        site: site.id,
        siteName: site.name,
        time: Date.now(),
        dist,
        oldHash: prev.hash ? prev.hash.slice(0, 16) + '...' : 'none',
        newHash: hash.slice(0, 16) + '...',
      });
      if (data.history.length > 50) data.history = data.history.slice(0, 50);
      log(`  🔔 ${site.name} BANNER 发生变化！差异度: ${dist}`);
    }

    log(`  ✅ ${site.name}: ${status}${changed ? ' [CHANGED!]' : ''}`);
    return { status, changed };

  } catch (e) {
    log(`  ❌ ${site.name}: ${e.message}`);
    const ec = (prev.errorCount || 0) + 1;
    data.sites[site.id] = {
      ...prev,
      status: ec >= 3 ? 'error' : prev.status || 'pending',
      lastCheck: Date.now(),
      errorCount: ec,
      lastError: e.message.slice(0, 100),
    };
    return { status: 'error', changed: false };
  }
}

// ============ 主流程 ============
(async () => {
  const startTime = Date.now();
  log('═══════════════════════════════════════');
  log('🚀 Banner 云端检测开始 (GitHub Actions)');
  log('═══════════════════════════════════════');
  log(`📋 共 ${SITES.length} 个平台待检测`);

  const data = loadResults();
  let changedCount = 0;
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < SITES.length; i++) {
    const result = await checkSite(SITES[i], data);
    if (result.status === 'changed') changedCount++;
    if (result.status === 'error') failCount++;
    else if (result.status === 'normal' || result.status === 'baseline') okCount++;

    // 间隔2秒避免请求过密
    if (i < SITES.length - 1) await sleep(2000);
  }

  // 更新统计
  const now = Date.now();
  const changed24h = data.history.filter(h => h.time > now - 86400000).length;
  data.lastCheck = now;
  data.stats = {
    total: SITES.length,
    monitored: SITES.filter(s => !s.htmlMode).length,
    ok: okCount,
    failed: failCount,
    changed: changedCount,
    totalChanges: Object.values(data.sites).reduce((sum, s) => sum + (s.changes || 0), 0),
    last24h: changed24h,
  };

  saveResults(data);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('───────────────────────────────────────');
  log(`📊 检测完成 | 正常:${okCount} | 变化:${changedCount} | 失败:${failCount} | 耗时:${elapsed}s`);
  log('═══════════════════════════════════════');

  // 如果有变化，输出详细信息
  if (changedCount > 0) {
    console.log('\n🔔 ===== 变化详情 =====');
    const changed = data.history.filter(h => h.time > now - 60000);
    changed.forEach(h => console.log(`   ${h.siteName}: 差异度 ${h.dist}`));
  }
})();
