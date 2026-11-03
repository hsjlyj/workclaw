/**
 * Cloudflare Workers AI 推理模块
 *
 * 提供免外部 API Key 的本地推理能力，使用 Cloudflare 免费层包含的 AI quota:
 *   - 免费计划: 每天约 10,000 neurons
 *   - 支持模型: @cf/meta/llama-3.1-8b-instruct 等
 *
 * 作为外部 API 的降级方案，或在开发/测试阶段使用。
 */

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

/**
 * 通过 Workers AI 生成聊天回复
 */
export async function generateWithAI(messages, env, options = {}) {
  if (!env?.WORKCLAW_AI) {
    throw new Error('WORKCLAW_AI binding is not configured');
  }

  const model = options.model || AI_MODEL;
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens ?? 1024;

  try {
    const response = await env.WORKCLAW_AI.run(model, {
      messages: messages.map((msg) => ({
        role: msg.role === 'system' ? 'system' : msg.role === 'user' ? 'user' : 'assistant',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      })),
      stream: options.stream ?? false,
      temperature,
      max_tokens: maxTokens,
    });

    if (options.stream) {
      return response; // 直接返回流式响应
    }

    return response.response;
  } catch (err) {
    console.error('[AI Inference] error:', err.message);
    throw err;
  }
}

/**
 * 使用 AI 生成文本摘要 (用于记忆压缩)
 */
export async function summarizeWithAI(text, env, options = {}) {
  const prompt = `请将以下内容压缩成一段简洁的中文摘要，保留核心事实和要点，不超过 100 字：

${text}`;

  try {
    const response = await generateWithAI(
      [
        { role: 'system', content: '你是一个高效的摘要生成器，只输出简洁的摘要内容，不加修饰。' },
        { role: 'user', content: prompt },
      ],
      env,
      { ...options, maxTokens: options.maxTokens ?? 150 }
    );

    return response.trim();
  } catch (err) {
    console.error('[AI Summarize] error:', err.message);
    return null; // 摘要失败时不阻塞主流程
  }
}

/**
 * 使用 AI 生成文本嵌入 (用于 Vectorize 语义搜索)
 * 如果 WORKCLAW_AI 不支持 embeddings，回退到简单分词
 */
export async function generateEmbedding(text, env) {
  if (!env?.WORKCLAW_AI) return simpleTokenize(text);

  try {
    const response = await env.WORKCLAW_AI.embeddings('@cf/baai/bge-base-en-v1.5', {
      text: text,
    });

    return response.embedding;
  } catch (err) {
    console.error('[AI Embedding] error:', err.message);
    return simpleTokenize(text);
  }
}

/**
 * 简单分词回退 (用于 embedding 不可用时)
 */
function simpleTokenize(text) {
  // 非常简单的基于字符的 n-gram 近似，不依赖外部服务
  const clean = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\s]/g, '');
  const words = clean.split(/\s+/).filter(Boolean);
  // 生成伪向量 (仅用于降级场景，不用于精确语义搜索)
  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  };
  const vector = new Array(384).fill(0);
  words.forEach((w) => {
    const idx = Math.abs(hash(w)) % 384;
    vector[idx] += 1;
  });
  // 归一化
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/**
 * 构建 AI 友好的系统提示
 */
export function buildAISystemPrompt(sessionContext = {}) {
  const lines = [
    '你是一个部署在 Cloudflare Workers 上的轻量 AI 助手，名叫 workclaw。',
    '回答简洁直接，优先使用简体中文。',
    '不要编造不确定的信息，不确定时如实说明。',
  ];

  if (sessionContext.mode) {
    lines.push(`当前对话模式：${sessionContext.mode}。`);
  }

  if (sessionContext.preferences) {
    lines.push(`用户偏好：${sessionContext.preferences}`);
  }

  return lines.join('\n');
}
