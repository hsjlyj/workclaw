/**
 * KV 缓存层 — 透明缓存搜索结果和网页抓取内容
 *
 * 键命名约定:
 *   search:<query>          — DuckDuckGo 搜索结果 (JSON)
 *   scrape:<url>            — 网页抓取纯文本 (JSON { text, title, url, cachedAt })
 *   session:<chatId>:meta   — 会话元数据 (JSON)
 *
 * TTL 策略:
 *   搜索结果  = 30 分钟 (资讯类时效性强)
 *   网页抓取  = 60 分钟 (文档类相对稳定)
 *   会话元数据 = 5 分钟  (频繁更新，不宜过长)
 */

const TTL = {
  SEARCH: 30 * 60,       // 30 min
  SCRAPE: 60 * 60,       // 60 min
  SESSION: 5 * 60,       // 5 min
};

/**
 * 生成缓存键
 */
function cacheKey(type, identifier) {
  const normalized = String(identifier).toLowerCase().trim();
  return `${type}:${normalized}`;
}

/**
 * 从 KV 读取缓存 (返回 null 表示未命中或过期)
 */
async function getCache(env, type, identifier) {
  if (!env?.WORKCLAW_CACHE) return null;

  try {
    const key = cacheKey(type, identifier);
    const raw = await env.WORKCLAW_CACHE.get(key, { type: 'json' });

    if (!raw) return null;

    // 检查是否过期
    if (raw.expiresAt && Date.now() > raw.expiresAt) {
      // 异步删除过期键，不阻塞主流程
      env.WORKCLAW_CACHE.delete(key).catch(() => {});
      return null;
    }

    return raw.data;
  } catch {
    return null;
  }
}

/**
 * 写入 KV 缓存
 */
async function setCache(env, type, identifier, data, ttlSeconds) {
  if (!env?.WORKCLAW_CACHE) return;

  try {
    const key = cacheKey(type, identifier);
    const entry = {
      data,
      cachedAt: Date.now(),
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    // Cloudflare KV 的 put 有 25 MiB 限制，这里不序列化超大值
    const serialized = JSON.stringify(entry);
    if (serialized.length > 20 * 1024 * 1024) return; // 超过 20MB 跳过

    await env.WORKCLAW_CACHE.put(key, serialized, {
      expirationTtl: ttlSeconds,
    });
  } catch (err) {
    console.error(`[KV Cache] set failed for ${type}:${identifier}`, err.message);
  }
}

/**
 * 缓存搜索结果
 */
export async function cacheSearchResult(env, query, results) {
  return setCache(env, 'search', query, results, TTL.SEARCH);
}

/**
 * 读取缓存的搜索结果
 */
export async function getCachedSearch(env, query) {
  return getCache(env, 'search', query);
}

/**
 * 缓存网页抓取结果
 */
export async function cacheScrapedPage(env, url, pageData) {
  return setCache(env, 'scrape', url, pageData, TTL.SCRAPE);
}

/**
 * 读取缓存的网页抓取结果
 */
export async function getCachedScrape(env, url) {
  return getCache(env, 'scrape', url);
}

/**
 * 缓存会话元数据
 */
export async function cacheSessionMeta(env, chatId, meta) {
  return setCache(env, 'session', chatId, meta, TTL.SESSION);
}

/**
 * 读取缓存的会话元数据
 */
export async function getCachedSessionMeta(env, chatId) {
  return getCache(env, 'session', chatId);
}

/**
 * 批量清除某类型的缓存 (调试用)
 */
export async function clearCacheByType(env, type) {
  if (!env?.WORKCLAW_CACHE) return 0;
  let cursor = null;
  let count = 0;

  do {
    const list = await env.WORKCLAW_CACHE.list({ prefix: `${type}:`, cursor, limit: 1000 });
    const keys = list.keys.map((k) => k.name);
    if (keys.length === 0) break;

    await Promise.all(keys.map((k) => env.WORKCLAW_CACHE.delete(k)));
    count += keys.length;
    cursor = list.cursor;
  } while (cursor);

  return count;
}
