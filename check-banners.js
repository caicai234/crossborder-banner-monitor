#!/usr/bin/env node
/**
 * check-banners.js — 头图 Banner 图片级监控（Playwright + thum.io 降级）
 *
 * 核心思路：
 * 1. 用 Playwright 打开网站，提取页面首屏头图/hero banner 图片 URL
 * 2. 下载每张图片，计算 SHA-256 哈希
 * 3. 对比上次运行的图片哈希集合，检测变化
 * 4. 如果 Playwright 被拦截，降级为 thum.io 截图 + 感知哈希
 *
 * 优势：只检测首页头图，不受页面下方促销图、分类图等噪声干扰
 */

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  console.error('❌ Playwright 未安装，请先运行: npm install playwright && npx playwright install chromium');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============ 配置 ============
const DATA_DIR = path.join(__dirname, 'monitor-server', 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const SHOT_WIDTH = 800;
const SHOT_HEIGHT = 600;
const CHANGE_THRESHOLD = 18; // 截图模式的汉明距离阈值

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const SITES = [
  { id: 'amazon',     name: 'Amazon',      url: 'https://www.amazon.com/' },
  { id: 'shein',      name: 'Shein',       url: 'https://us.shein.com/' },
  { id: 'homedepot',  name: 'Home Depot',  url: 'https://www.homedepot.com/' },
  { id: 'temu',       name: 'Temu',        url: 'https://www.temu.com/' },
  { id: 'aliexpress', name: 'AliExpress',  url: 'https://www.aliexpress.com/' },
  { id: 'lowes',      name: "Lowe's",      url: 'https://www.lowes.com/' },
  { id: 'wayfair',    name: 'Wayfair',     url: 'https://www.wayfair.com/' },
];

// ============ 工具 ============
const log = (msg) => {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${ts}] ${msg}`);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

const loadResults = () => {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8')); }
  catch { return { sites: {}, history: [], lastCheck: null, stats: {} }; }
};

const saveResults = (data) => {
  ensureDir(DATA_DIR);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
};

function normalizeUrl(src, pageUrl) {
  if (!src) return null;
  src = src.trim();
  if (src.startsWith('data:')) return null;
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('http')) return src;
  try { return new URL(src, pageUrl).href; } catch { return null; }
}

// ============ Playwright: 提取 Banner 图片 ============
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const step = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight || total >= 3000) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
}

async function extractBannerImages(page, pageUrl) {
  // 先滚动页面触发懒加载
  try { await autoScroll(page); } catch {}

  const raw = await page.evaluate(() => {
    const results = [];

    // 1. 提取 <img> 元素
    document.querySelectorAll('img').forEach(img => {
      const src = img.currentSrc || img.src || img.dataset.src || img.dataset.lazySrc || '';
      if (!src || src.startsWith('data:')) return;
      const rect = img.getBoundingClientRect();
      const w = img.naturalWidth || rect.width || 0;
      const h = img.naturalHeight || rect.height || 0;
      if (w < 600) return; // 头图banner 通常很大
      // 只关注首屏顶部区域 (top < 1000)
      const scrollTop = Math.round(rect.top + window.scrollY);
      if (scrollTop > 1000) return;
      results.push({
        src,
        w: Math.round(w),
        h: Math.round(h),
        type: 'img',
        cls: (img.className || '').toString(),
        parentCls: (img.parentElement?.className || '').toString(),
        alt: img.alt || '',
        top: scrollTop,
      });
    });

    // 2. 提取 CSS background-image
    document.querySelectorAll('*').forEach(el => {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (!bg || bg === 'none') return;
      const matches = bg.matchAll(/url\(["']?([^"')]+)["']?\)/g);
      for (const match of matches) {
        const src = match[1];
        if (!src || src.startsWith('data:')) continue;
        const rect = el.getBoundingClientRect();
        const w = rect.width;
        if (w < 600) continue;
        const bgTop = Math.round(rect.top + window.scrollY);
        if (bgTop > 1000) continue;
        results.push({
          src,
          w: Math.round(w),
          h: Math.round(rect.height),
          type: 'bg',
          cls: (el.className || '').toString(),
          parentCls: '',
          alt: '',
          top: bgTop,
        });
      }
    });

    // 3. 提取 srcset 中的大图（仅头图区域）
    document.querySelectorAll('img[srcset], source[srcset]').forEach(el => {
      const srcset = el.srcset || el.getAttribute('srcset') || '';
      if (!srcset) return;
      const parts = srcset.split(',');
      const last = parts[parts.length - 1].trim().split(/\s+/)[0];
      if (last) {
        const rect = el.getBoundingClientRect();
        const sTop = Math.round(rect.top + window.scrollY);
        if (sTop > 1000) return;
        results.push({
          src: last,
          w: Math.round(rect.width || 800),
          h: Math.round(rect.height || 400),
          type: 'srcset',
          cls: (el.className || '').toString(),
          parentCls: '',
          alt: el.alt || '',
          top: sTop,
        });
      }
    });

    return results;
  });

  // 归一化 URL 并去重
  const seen = new Set();
  const normalized = raw
    .map(r => ({ ...r, src: normalizeUrl(r.src, pageUrl) }))
    .filter(r => r.src && !seen.has(r.src) && seen.add(r.src));

  return normalized;
}

function scoreAndFilter(images) {
  const scored = images.map(img => {
    let score = 0;
    const ratio = img.w / (img.h || 1);

    // 尺寸评分 — 头图通常全宽
    if (img.w >= 1200) score += 5;
    else if (img.w >= 800) score += 3;

    // 横幅宽高比 (2:1 ~ 5:1 最典型)
    if (ratio >= 2 && ratio <= 5) score += 5;
    else if (ratio >= 1.5 && ratio < 2) score += 2;

    // 位置评分 — 头图一定在页面最顶部
    if (img.top < 200) score += 6;
    else if (img.top < 400) score += 4;
    else if (img.top < 600) score += 2;
    else score -= 3; // 超过 600px 不太可能是头图

    // class/alt 关键词评分
    const text = ((img.cls || '') + ' ' + (img.parentCls || '') + ' ' + (img.alt || '')).toLowerCase();
    if (text.includes('hero') || text.includes('banner')) score += 8;
    if (text.includes('carousel') || text.includes('swiper') || text.includes('slide')) score += 6;
    if (text.includes('promo') || text.includes('deal')) score += 3;
    if (text.includes('main') || text.includes('featured') || text.includes('spotlight')) score += 3;

    // 排除项 — 强惩罚
    if (text.includes('avatar') || text.includes('icon') && img.w < 500) score -= 8;
    if (text.includes('thumbnail') || text.includes('product-image')) score -= 6;
    if (text.includes('logo') && img.w < 500) score -= 8;
    if (text.includes('footer') || text.includes('breadcrumb')) score -= 8;

    return { ...img, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // 头图通常是一组轮播图 (1~3张)，取评分 >= 4 的前 3 张
  const filtered = scored.filter(s => s.score >= 4).slice(0, 3);

  // 降级：如果没有高分图，取评分 > 0 的前 2 张
  if (filtered.length === 0) {
    const fallback = scored.filter(s => s.score > 0).slice(0, 2);
    return fallback;
  }

  return filtered;
}

async function downloadImageHash(context, url) {
  try {
    const res = await context.request.get(url, {
      timeout: 15000,
      headers: { 'Referer': url.split('/').slice(0, 3).join('/') },
    });
    if (!res.ok()) return null;
    const buf = await res.body();
    if (buf.length < 2000) return null; // 太小，可能是占位图
    return {
      hash: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
    };
  } catch {
    return null;
  }
}

async function checkSiteWithPlaywright(site, context) {
  const page = await context.newPage();

  try {
    // 导航到页面
    await page.goto(site.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // 等待动态内容加载
    await sleep(4000);

    // 提取 banner 图片
    const rawImages = await extractBannerImages(page, site.url);
    log(`  📸 ${site.name}: 提取到 ${rawImages.length} 张候选头图`);

    if (rawImages.length === 0) {
      throw new Error('未找到任何头图');
    }

    // 评分筛选
    const banners = scoreAndFilter(rawImages);
    log(`  🎯 ${site.name}: 筛选后 ${banners.length} 张头图`);

    if (banners.length === 0) {
      throw new Error('筛选后无 banner 图片');
    }

    // 下载并哈希每张图片
    const bannerData = [];
    for (const banner of banners) {
      const result = await downloadImageHash(context, banner.src);
      if (result) {
        bannerData.push({
          url: banner.src,
          hash: result.hash,
          size: result.size,
          w: banner.w,
          h: banner.h,
          score: banner.score,
        });
      }
    }

    log(`  ✅ ${site.name}: 成功哈希 ${bannerData.length}/${banners.length} 张图片`);

    if (bannerData.length === 0) {
      throw new Error('所有图片下载失败');
    }

    // 计算组合哈希
    const combinedHash = crypto.createHash('sha256')
      .update(bannerData.map(b => b.hash).join(''))
      .digest('hex');

    // 截一张页面截图作为预览
    let preview = null;
    try {
      const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 70, clip: { x: 0, y: 0, width: 800, height: 600 } });
      preview = 'data:image/jpeg;base64,' + screenshotBuf.toString('base64');
    } catch {}

    return {
      hash: combinedHash,
      banners: bannerData,
      method: 'images',
      preview,
    };
  } finally {
    await page.close();
  }
}

// ============ 降级: thum.io 截图 ============
const thumUrl = (siteUrl) => {
  return `https://image.thum.io/get/width/${SHOT_WIDTH}/crop/${SHOT_HEIGHT}/${siteUrl}`;
};

function computeImageHash(buffer) {
  const sampleSize = 256;
  const step = Math.max(1, Math.floor(buffer.length / sampleSize));
  const samples = [];
  for (let i = 0; i < buffer.length && samples.length < sampleSize; i += step) {
    samples.push(buffer[i]);
  }
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

async function checkSiteWithThumio(site) {
  const url = thumUrl(site.url);
  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`thum.io HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 500) throw new Error(`截图太小(${buffer.length}字节)`);
  const hash = computeImageHash(buffer);
  return { hash, method: 'screenshot', banners: [] };
}

// ============ 图片集对比 ============
function compareBannerSets(oldBanners, newBanners) {
  const oldHashes = new Map((oldBanners || []).map(b => [b.hash, b.url]));
  const newHashes = new Map(newBanners.map(b => [b.hash, b.url]));

  let added = 0, removed = 0, unchanged = 0;

  for (const [hash, url] of newHashes) {
    if (oldHashes.has(hash)) {
      unchanged++;
    } else {
      added++;
    }
  }
  for (const [hash, url] of oldHashes) {
    if (!newHashes.has(hash)) removed++;
  }

  const changed = added + removed;
  return { added, removed, unchanged, changed };
}

// ============ 检测单个网站 ============
async function checkSite(site, data, context) {
  const prev = data.sites[site.id] || { status: 'pending', changes: 0, errorCount: 0 };
  data.sites[site.id] = { ...prev, status: 'checking', lastCheck: Date.now() };
  log(`  🔍 正在检测 ${site.name}...`);

  let result;
  let usedFallback = false;

  // 方案1: Playwright 图片提取
  try {
    result = await checkSiteWithPlaywright(site, context);
    log(`  🖼️ ${site.name}: 头图提取成功 (${result.banners.length} 张)`);
  } catch (e) {
    log(`  ⚠️ ${site.name} Playwright 失败: ${e.message}, 降级 thum.io...`);
    usedFallback = true;

    // 方案2: thum.io 截图降级
    try {
      result = await checkSiteWithThumio(site);
      log(`  📸 ${site.name}: thum.io 截图降级成功`);
    } catch (e2) {
      log(`  ❌ ${site.name} thum.io 也失败: ${e2.message}`);
      result = { hash: `${site.id}-manual-placeholder`, method: 'manual', banners: [] };
    }
  }

  // 对比上次结果
  let status = 'normal';
  let changed = false;
  let dist = 0;
  let changeDetail = null;

  if (result.method === 'manual') {
    status = 'manual';
  } else if (prev.hash && (prev.method === result.method)) {
    if (result.method === 'images') {
      // 图片集对比
      const cmp = compareBannerSets(prev.banners, result.banners);
      dist = cmp.changed;
      changeDetail = { added: cmp.added, removed: cmp.removed, unchanged: cmp.unchanged };
      if (cmp.changed > 0) {
        status = 'changed';
        changed = true;
      }
    } else {
      // 截图哈希对比
      dist = hammingDistance(prev.hash, result.hash);
      if (dist > CHANGE_THRESHOLD) {
        status = 'changed';
        changed = true;
      }
    }
  } else {
    status = 'baseline';
  }

  data.sites[site.id] = {
    status,
    hash: result.hash,
    method: result.method,
    banners: result.banners,
    bannerCount: result.banners.length,
    preview: result.preview || null,
    lastCheck: Date.now(),
    lastDist: dist,
    changes: (prev.changes || 0) + (changed ? 1 : 0),
    errorCount: 0,
    changeDetail,
  };

  // 记录变化历史
  if (changed) {
    const detail = changeDetail
      ? `新增${changeDetail.added}张, 移除${changeDetail.removed}张`
      : `差异度 ${dist}`;
    data.history.unshift({
      site: site.id,
      siteName: site.name,
      time: Date.now(),
      dist,
      method: result.method,
      detail,
      oldHash: prev.hash ? String(prev.hash).slice(0, 16) + '...' : 'none',
      newHash: String(result.hash).slice(0, 16) + '...',
    });
    if (data.history.length > 50) data.history = data.history.slice(0, 50);
    log(`  🔔 ${site.name} 头图变化！${detail}`);
  }

  log(`  ✅ ${site.name}: ${status}${changed ? ' [CHANGED!]' : ''} (${result.method})`);
  return { status, changed };
}

// ============ 主流程 ============
(async () => {
  const startTime = Date.now();
  log('═══════════════════════════════════════');
  log('🚀 Banner 图片级监控开始 (Playwright)');
  log('═══════════════════════════════════════');
  log(`📋 共 ${SITES.length} 个平台待检测`);

  // 启动浏览器
  log('🌐 启动 Chromium 无头浏览器...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // 反自动化检测
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  const data = loadResults();
  let changedCount = 0;
  let okCount = 0;
  let failCount = 0;
  let imagesMethodCount = 0;
  let screenshotMethodCount = 0;
  let manualMethodCount = 0;

  for (let i = 0; i < SITES.length; i++) {
    try {
      const result = await checkSite(SITES[i], data, context);
      if (result.status === 'changed') changedCount++;
      if (result.status === 'error' || result.status === 'manual') failCount++;
      else if (result.status === 'normal' || result.status === 'baseline') okCount++;

      const siteData = data.sites[SITES[i].id];
      if (siteData.method === 'images') imagesMethodCount++;
      else if (siteData.method === 'screenshot') screenshotMethodCount++;
      else manualMethodCount++;
    } catch (e) {
      log(`  ❌ ${SITES[i].name}: ${e.message}`);
      failCount++;
      const prev = data.sites[SITES[i].id] || { changes: 0, errorCount: 0 };
      data.sites[SITES[i].id] = {
        ...prev,
        status: 'error',
        lastCheck: Date.now(),
        errorCount: (prev.errorCount || 0) + 1,
        lastError: String(e.message).slice(0, 100),
      };
    }

    // 间隔 2 秒避免请求过密
    if (i < SITES.length - 1) await sleep(2000);
  }

  await browser.close();

  // 更新统计
  const now = Date.now();
  const changed24h = data.history.filter(h => h.time > now - 86400000).length;
  data.lastCheck = now;
  data.stats = {
    total: SITES.length,
    monitored: imagesMethodCount + screenshotMethodCount,
    ok: okCount,
    failed: failCount,
    changed: changedCount,
    totalChanges: Object.values(data.sites).reduce((sum, s) => sum + (s.changes || 0), 0),
    last24h: changed24h,
    methodBreakdown: {
      images: imagesMethodCount,
      screenshot: screenshotMethodCount,
      manual: manualMethodCount,
    },
  };

  saveResults(data);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('───────────────────────────────────────');
  log(`📊 检测完成 | 正常:${okCount} | 变化:${changedCount} | 失败:${failCount} | 耗时:${elapsed}s`);
  log(`📈 监控方式 | 图片级:${imagesMethodCount} | 截图级:${screenshotMethodCount} | 手动:${manualMethodCount}`);
  log('═══════════════════════════════════════');

  if (changedCount > 0) {
    console.log('\n🔔 ===== 变化详情 =====');
    const changed = data.history.filter(h => h.time > now - 60000);
    changed.forEach(h => console.log(`   ${h.siteName}: ${h.detail || '差异度 ' + h.dist}`));
  }
})();
