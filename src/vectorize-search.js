/**
 * Vectorize 语义记忆搜索模块
 *
 * 使用 Cloudflare Vectorize 进行长期记忆的语义搜索，
 * 让用户可以用自然语言查询历史记忆 ("我之前说过什么关于...")。
 *
 * 流程:
 *   1. 记忆存入时生成嵌入 → 存入 Vectorize 索引
 *   2. 查询时将自然语言转为嵌入 → 向量相似度搜索
 *   3. 返回 top-K 最相关记忆
 */

const INDEX_NAME = 'workclaw-memories';

/**
 * 确保 Vectorize 索引存在 (幂等操作)
 */
export async function ensureVectorizeIndex(env) {
  if (!env?.WORKCLAW_VECTORIZE) return false;

  try {
    const indexes = await env.WORKCLAW_VECTORIZE.listIndexes();
    const exists = indexes.some((idx) => idx.name === INDEX_NAME);

    if (!exists) {
      await env.WORKCLAW_VECTORIZE.createIndex({
        name: INDEX_NAME,
        dimensions: 768, // bge-base-en-v1.5 输出维度
        metric: 'cosine',
      });
    }

    return true;
  } catch (err) {
    console.error('[Vectorize] ensure index error:', err.message);
    return false;
  }
}

/**
 * 将记忆条目插入 Vectorize 索引
 */
export async function upsertMemoryEmbedding(env, memoryId, text, metadata = {}) {
  if (!env?.WORKCLAW_VECTORIZE) return false;

  try {
    const embedding = await generateEmbedding(env, text);

    await env.WORKCLAW_VECTORIZE.upsert([
      {
        id: memoryId,
        values: embedding,
        metadata: {
          text: text.slice(0, 500), // 存储文本摘要
          ...metadata,
          storedAt: new Date().toISOString(),
        },
      },
    ]);

    return true;
  } catch (err) {
    console.error('[Vectorize] upsert error:', err.message);
    return false;
  }
}

/**
 * 语义搜索记忆
 * @returns {Promise<Array<{id, text, score, metadata}>>}
 */
export async function searchMemories(env, query, topK = 5) {
  if (!env?.WORKCLAW_VECTORIZE) return [];

  try {
    const embedding = await generateEmbedding(env, query);

    const results = await env.WORKCLAW_VECTORIZE.query(embedding, {
      topK,
      returnMetadata: true,
      returnValues: false,
    });

    return (results.matches || []).map((match) => ({
      id: match.id,
      score: match.score,
      text: match.metadata?.text || '',
      metadata: match.metadata || {},
    }));
  } catch (err) {
    console.error('[Vectorize] search error:', err.message);
    return [];
  }
}

/**
 * 删除指定记忆条目
 */
export async function deleteMemoryEmbedding(env, memoryId) {
  if (!env?.WORKCLAW_VECTORIZE) return false;

  try {
    await env.WORKCLAW_VECTORIZE.deleteByIds([memoryId]);
    return true;
  } catch (err) {
    console.error('[Vectorize] delete error:', err.message);
    return false;
  }
}

/**
 * 从 Vectorize 批量删除过期的记忆 (按 metadata.storedAt)
 */
export async function deleteExpiredMemories(env, olderThanMs) {
  if (!env?.WORKCLAW_VECTORIZE) return 0;

  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  let count = 0;

  try {
    // Vectorize 暂不支持服务端过滤查询，这里先列出再删除
    // 实际使用中可以配合 DO 存储的时间戳来管理
    const results = await env.WORKCLAW_VECTORIZE.listIds();
    const toDelete = [];

    for (const id of results.ids) {
      // id 格式约定: memory:<chatId>:<timestamp>
      const match = id.match(/^memory:(\d+):(\d+)$/);
      if (match) {
        const timestamp = Number(match[2]);
        if (Date.now() - timestamp > olderThanMs) {
          toDelete.push(id);
        }
      }
    }

    if (toDelete.length > 0) {
      await env.WORKCLAW_VECTORIZE.deleteByIds(toDelete);
      count = toDelete.length;
    }
  } catch (err) {
    console.error('[Vectorize] cleanup error:', err.message);
  }

  return count;
}

// ── 内部使用的 embedding 生成 ──

async function generateEmbedding(env, text) {
  if (!env?.WORKCLAW_AI) return flatEmbedding(text);

  try {
    const response = await env.WORKCLAW_AI.embeddings('@cf/baai/bge-base-en-v1.5', {
      text: text,
    });
    return response.embedding;
  } catch {
    return flatEmbedding(text);
  }
}

/**
 * 降级: 基于规则的简单伪向量 (仅用于无 AI 环境)
 */
function flatEmbedding(text) {
  const clean = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\s]/g, '');
  const words = clean.split(/\s+/).filter(Boolean);
  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  };
  const vector = new Array(768).fill(0);
  words.forEach((w) => {
    const idx = Math.abs(hash(w)) % 768;
    vector[idx] += 1;
  });
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}
