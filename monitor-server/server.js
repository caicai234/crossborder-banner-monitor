/**
 * Banner 后台监控服务器
 * - 每日定时检测各跨境平台首页 Banner 变化
 * - 截图 + SHA-256 哈希对比
 * - 数据持久化到 JSON 文件
 * - 关闭电脑后继续在云端运行
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ============ 配置 ============
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 默认 24 小时
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

// ============ 工具函数 ============
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadResults() {
  ensureDir(DATA_DIR);
  if (fs.existsSync(RESULTS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
    } catch (e) {
      log('读取 results.json 失败，使用默认数据');
    }
  }
  return { sites: {}, history: [], lastCheck: null, nextCheckAt: null, stats: { total: 0, changes: 0, last24h: 0 } };
}

function saveResults(data) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function formatTime(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function thumUrl(siteUrl) {
  return `https://image.thum.io/get/width/${SHOT_WIDTH}/crop/${SHOT_HEIGHT}/${siteUrl}`;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============ 截图下载 ============
async function downloadScreenshot(siteUrl, siteId) {
  const tUrl = thumUrl(siteUrl);
  const urls = [tUrl];

  // 尝试直接下载，失败则用代理
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) continue;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 500) continue;

      return buffer;
    } catch (e) {
      log(`截图下载失败 ${siteId}: ${e.message}`);
    }
  }
  throw new Error('所有截图方式均失败');
}

// ============ 图片哈希 ============
async function computeImageHash(buffer) {
  // 使用 sharp 缩放后计算感知哈希，更抗噪
  try {
    const sharp = require('sharp');
    const resized = await sharp(buffer)
      .resize(16, 16, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();

    const pixels = [];
    for (let i = 0; i < resized.length; i++) {
      pixels.push(resized[i]);
    }

    const avg = pixels.reduce((a, b) => a + b, 0) / pixels.length;
    let hash = '';
    for (let i = 0; i < pixels.length; i++) {
      hash += pixels[i] > avg ? '1' : '0';
    }
    return hash;
  } catch (e) {
    // sharp 不可用时，用 SHA-256 作为 fallback
    log(`sharp 不可用，使用 SHA-256 fallback: ${e.message}`);
    return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 64);
  }
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
async function checkSite(site) {
  const data = loadResults();
  const prev = data.sites[site.id] || { status: 'baseline', changes: 0, errorCount: 0 };

  data.sites[site.id] = { ...prev, status: 'checking', lastCheck: Date.now() };
  saveResults(data);

  try {
    let hash, screenshotPath = null, changed = false;

    if (site.htmlMode) {
      // Wayfair 反爬保护，尝试获取页面内容
      try {
        const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(site.url)}`, {
          signal: AbortSignal.timeout(40000)
        });
        if (res.ok) {
          const html = await res.text();
          hash = crypto.createHash('sha256').update(html.slice(0, 50000)).digest('hex').slice(0, 64);
        } else {
          hash = 'wayfair-manual-' + Date.now();
        }
      } catch {
        hash = 'wayfair-manual-' + Date.now();
      }
    } else {
      // 普通模式：截图 + 感知哈希
      const buffer = await downloadScreenshot(site.url, site.id);

      // 保存截图到文件
      ensureDir(SCREENSHOTS_DIR);
      screenshotPath = path.join(SCREENSHOTS_DIR, `${site.id}_latest.jpg`);
      fs.writeFileSync(screenshotPath, buffer);

      hash = await computeImageHash(buffer);
    }

    // 对比哈希
    const prevHash = prev.hash;
    let status = 'normal';

    if (site.htmlMode && hash && hash.startsWith('wayfair-manual')) {
      status = 'normal';
    } else if (prevHash) {
      const dist = hammingDistance(prevHash, hash);
      if (dist > 15) {
        status = 'changed';
        changed = true;

        // 备份旧截图
        if (screenshotPath && prev.hash) {
          const oldPath = path.join(SCREENSHOTS_DIR, `${site.id}_${prev.hash.slice(0, 8)}.jpg`);
          try { fs.copyFileSync(screenshotPath, oldPath); } catch {}
        }
      }
    } else {
      status = 'baseline';
    }

    const now = Date.now();
    const entry = {
      status,
      hash,
      lastCheck: now,
      lastDist: changed ? hammingDistance(prevHash, hash) : (prevHash ? hammingDistance(prevHash, hash) : 0),
      changes: (prev.changes || 0) + (changed ? 1 : 0),
      errorCount: 0,
      screenshot: screenshotPath ? `${site.id}_latest.jpg` : null,
    };

    data.sites[site.id] = entry;

    // 记录变化历史
    if (changed) {
      const histEntry = {
        site: site.id,
        siteName: site.name,
        time: now,
        dist: hammingDistance(prevHash, hash),
        oldHash: prevHash,
        newHash: hash,
      };
      data.history.unshift(histEntry);
      if (data.history.length > 50) data.history = data.history.slice(0, 50);
      log(`🔔 ${site.name} Banner 发生变化！差异度: ${histEntry.dist}`);
    }

    data.lastCheck = now;
    saveResults(data);
    log(`✅ ${site.name} 检测完成 (${status}${changed ? ' [CHANGED]' : ''})`);

    return { status, changed };

  } catch (e) {
    log(`❌ ${site.name} 检测失败: ${e.message}`);
    const ec = (prev.errorCount || 0) + 1;
    data.sites[site.id] = {
      ...prev,
      status: 'error',
      lastCheck: Date.now(),
      errorCount: ec,
      errorMsg: e.message,
    };
    saveResults(data);
    return { status: 'error', changed: false };
  }
}

// ============ 全量检测 ============
async function checkAll() {
  log('🚀 开始全量检测...');
  const startTime = Date.now();

  for (let i = 0; i < SITES.length; i++) {
    await checkSite(SITES[i]);
    if (i < SITES.length - 1) await sleep(3000); // 间隔3秒避免请求过密
  }

  const data = loadResults();
  data.lastCheck = Date.now();
  data.nextCheckAt = Date.now() + CHECK_INTERVAL_MS;

  // 更新统计
  const changed24h = data.history.filter(h => h.time > Date.now() - 86400000).length;
  data.stats = {
    total: SITES.length,
    changes: Object.values(data.sites).reduce((sum, s) => sum + (s.changes || 0), 0),
    last24h: changed24h,
  };

  saveResults(data);
  log(`✅ 全量检测完成，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

// ============ HTTP API ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // API 路由不处理
  if (filePath.startsWith('/api/')) return false;

  // 安全：防止路径穿越
  const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(__dirname, '..', safePath);

  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return false;

  const ext = path.extname(fullPath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(fs.readFileSync(fullPath));
  return true;
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API 路由
  if (url.pathname === '/api/status') {
    const data = loadResults();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      online: true,
      uptime: process.uptime(),
      lastCheck: data.lastCheck,
      nextCheckAt: data.nextCheckAt,
      stats: data.stats,
      sites: Object.entries(data.sites).map(([id, s]) => ({
        id,
        name: SITES.find(site => site.id === id)?.name || id,
        status: s.status,
        lastCheck: s.lastCheck,
        changes: s.changes || 0,
        lastDist: s.lastDist,
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

  if (url.pathname === '/api/history') {
    const data = loadResults();
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data.history.slice(0, limit)));
    return;
  }

  if (url.pathname === '/api/screenshot') {
    const site = url.searchParams.get('site');
    if (!site) {
      res.writeHead(400);
      res.end('Missing site parameter');
      return;
    }
    const filePath = path.join(SCREENSHOTS_DIR, `${site}_latest.jpg`);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Screenshot not found');
    }
    return;
  }

  // POST /api/check - 手动触发检测（带简单token验证）
  if (url.pathname === '/api/check' && req.method === 'POST') {
    const token = url.searchParams.get('token') || '';
    // 简单验证：token 为 admin123 或请求中包含
    if (token !== 'admin123' && req.headers['x-monitor-token'] !== 'monitor-secret-2024') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', hint: '需要 ?token=admin123 或 X-Monitor-Token header' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started', message: '检测任务已触发' }));
    // 异步执行检测
    checkAll().catch(e => log(`手动检测失败: ${e.message}`));
    return;
  }

  // 静态文件
  if (!serveStatic(req, res)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

// ============ 启动 ============
ensureDir(DATA_DIR);
ensureDir(SCREENSHOTS_DIR);

server.listen(PORT, '0.0.0.0', () => {
  log(`========================================`);
  log(`🖥  Banner 监控服务器已启动`);
  log(`📍 端口: ${PORT}`);
  log(`🔄 检测间隔: 每 ${CHECK_INTERVAL_MS / 3600000} 小时`);
  log(`📊 API: http://localhost:${PORT}/api/status`);
  log(`========================================`);

  // 启动后延迟 10 秒执行首次检测
  setTimeout(async () => {
    log('🔍 执行首次检测...');
    await checkAll();
    log('✅ 首次检测完成');
  }, 10000);

  // 设置定时检测
  setInterval(async () => {
    log('⏰ 定时检测触发...');
    await checkAll();
  }, CHECK_INTERVAL_MS);

  // 每小时输出心跳日志
  setInterval(() => {
    const data = loadResults();
    const ok = Object.values(data.sites).filter(s => s.status === 'normal' || s.status === 'baseline').length;
    log(`💓 心跳 | 在线平台: ${ok}/${SITES.length} | 下次检测: ${formatTime(data.nextCheckAt)}`);
  }, 3600000);
});

// 优雅退出
process.on('SIGTERM', () => {
  log('收到 SIGTERM，保存数据后退出...');
  const data = loadResults();
  data.shutdownAt = Date.now();
  saveResults(data);
  process.exit(0);
});

process.on('SIGINT', () => {
  log('收到 SIGINT，保存数据后退出...');
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log(`未捕获异常: ${e.message}`);
  console.error(e);
});
