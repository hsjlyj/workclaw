/**
 * R2 对象存储层 — 存储较大的缓存内容 (网页快照、长文档等)
 *
 * 键命名约定:
 *   snapshot:<url-hash>     — 网页快照 (HTML 或纯文本)
 *   context:<chatId>:<seq>  — 超长会话上下文归档
 *
 * R2 适合存储 KV 放不下的大块内容，配合 KV 的元数据索引使用。
 */

import crypto from 'node:crypto';

/**
 * 生成内容的 SHA-256 哈希 (用于 R2 键名)
 */
function hashKey(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * 将网页快照存入 R2
 * @returns {Promise<string|null>} 存储成功的对象键名
 */
export async function storePageSnapshot(env, url, content, mimeType = 'text/plain') {
  if (!env?.WORKCLAW_ASSETS) return null;

  try {
    const key = `snapshot:${hashKey(url)}`;
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;

    await env.WORKCLAW_ASSETS.put(key, body, {
      httpMetadata: { contentType: mimeType },
      customMetadata: {
        url,
        storedAt: new Date().toISOString(),
        size: String(body.byteLength),
      },
    });

    return key;
  } catch (err) {
    console.error(`[R2] store snapshot failed: ${err.message}`);
    return null;
  }
}

/**
 * 从 R2 读取网页快照
 */
export async function getPageSnapshot(env, url) {
  if (!env?.WORKCLAW_ASSETS) return null;

  try {
    const key = `snapshot:${hashKey(url)}`;
    const object = await env.WORKCLAW_ASSETS.get(key);
    if (!object) return null;

    const text = await object.text();
    return {
      body: text,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    };
  } catch (err) {
    console.error(`[R2] get snapshot failed: ${err.message}`);
    return null;
  }
}

/**
 * 存储超长会话上下文归档
 * 当单次对话上下文超过 Token 限制时，将早期内容归档到 R2
 */
export async function archiveConversationContext(env, chatId, sequence, messages) {
  if (!env?.WORKCLAW_ASSETS) return null;

  try {
    const key = `context:${chatId}:${sequence}`;
    const body = JSON.stringify(messages);

    await env.WORKCLAW_ASSETS.put(key, body, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        chatId: String(chatId),
        archivedAt: new Date().toISOString(),
        messageCount: String(messages.length),
      },
    });

    return key;
  } catch (err) {
    console.error(`[R2] archive context failed: ${err.message}`);
    return null;
  }
}

/**
 * 从 R2 读取归档的会话上下文
 */
export async function loadArchivedContext(env, chatId, sequence) {
  if (!env?.WORKCLAW_ASSETS) return null;

  try {
    const key = `context:${chatId}:${sequence}`;
    const object = await env.WORKCLAW_ASSETS.get(key);
    if (!object) return null;

    const text = await object.text();
    return JSON.parse(text);
  } catch (err) {
    console.error(`[R2] load archived context failed: ${err.message}`);
    return null;
  }
}

/**
 * 列出某个会话的所有归档 (用于调试和管理)
 */
export async function listArchivedContexts(env, chatId) {
  if (!env?.WORKCLAW_ASSETS) return [];

  try {
    const listed = await env.WORKCLAW_ASSETS.list({ prefix: `context:${chatId}:` });
    return listed.objects.map((obj) => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded,
    }));
  } catch (err) {
    console.error(`[R2] list archives failed: ${err.message}`);
    return [];
  }
}
