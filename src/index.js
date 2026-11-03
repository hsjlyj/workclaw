import { CLAW_SYSTEM_PROMPT } from './generated/claw-prompts.js';
import {
  cacheSearchResult,
  getCachedSearch,
  cacheScrapedPage,
  getCachedScrape,
} from './kv-cache.js';
import {
  storePageSnapshot,
  getPageSnapshot,
  archiveConversationContext,
} from './r2-storage.js';
import {
  generateWithAI,
  summarizeWithAI,
  generateEmbedding,
  buildAISystemPrompt,
} from './ai-inference.js';
import {
  upsertMemoryEmbedding,
  searchMemories,
  ensureVectorizeIndex,
} from './vectorize-search.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};
const OPENAI_STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

const DEFAULT_MODEL = 'workclaw-mini';
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_MEMORY_RECENT_LIMIT = 6;
const TELEGRAM_MEMORY_COMPACT_THRESHOLD = 8;
const TELEGRAM_MEMORY_SUMMARY_LIMIT = 240;
// ponytail: one fixed polling interval keeps watch alarms simple; per-watch cadence can come later.
const TELEGRAM_WATCH_POLL_INTERVAL_MS = 30 * 60 * 1000;
const TELEGRAM_STREAM_EDIT_MIN_CHARS = 80;
const WEB_SEARCH_RESULT_LIMIT = 3;
const WEB_SCRAPE_LIMIT = 2;
const WEB_CONTEXT_LIMIT = 1800;
const WEB_REQUEST_TIMEOUT_MS = 8000;
const CLAW_SYSTEM_MESSAGE = CLAW_SYSTEM_PROMPT
  ? Object.freeze({ role: 'system', content: CLAW_SYSTEM_PROMPT })
  : null;

function json(data, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('content-type', JSON_HEADERS['content-type']);
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

function methodNotAllowed(allow) {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: allow },
  });
}

function notFound() {
  return new Response('Not Found', { status: 404 });
}

function getPath(request) {
  return new URL(request.url).pathname.replace(/\/+$/, '') || '/';
}

function getConfiguredModel(env) {
  return env?.CLAW_MODEL || env?.OPENAI_MODEL || DEFAULT_MODEL;
}

function getOpenAIBaseUrl(env) {
  return env?.OPENAI_BASE_URL ? String(env.OPENAI_BASE_URL) : '';
}

function getSecretText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function digestSecretText(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || ''))));
}

async function timingSafeEqualText(provided, expected) {
  const [providedHash, expectedHash] = await Promise.all([
    digestSecretText(provided),
    digestSecretText(expected),
  ]);
  let diff = providedHash.length ^ expectedHash.length;
  const length = Math.max(providedHash.length, expectedHash.length);

  for (let index = 0; index < length; index += 1) {
    diff |= (providedHash[index] ?? 0) ^ (expectedHash[index] ?? 0);
  }

  return diff === 0;
}

function getBearerToken(request) {
  const match = String(request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/iu);
  return match ? match[1].trim() : '';
}

async function authorizeOpenAIRequest(request, env) {
  const clientKey = getSecretText(env?.CLAW_API_KEY);

  if (!clientKey) {
    if (getOpenAIBaseUrl(env) || getSecretText(env?.OPENAI_API_KEY)) {
      return json({ error: { message: 'CLAW_API_KEY is required' } }, { status: 500 });
    }
    return null;
  }

  if (!(await timingSafeEqualText(getBearerToken(request), clientKey))) {
    return json(
      { error: { message: 'unauthorized' } },
      {
        status: 401,
        headers: {
          'www-authenticate': 'Bearer',
        },
      },
    );
  }

  return null;
}

function resolveUpstreamUrl(baseUrl, requestUrl) {
  const upstream = new URL(baseUrl);
  const basePath = upstream.pathname.replace(/\/$/, '');
  const suffix = basePath.endsWith('/v1')
    ? requestUrl.pathname.replace(/^\/v1/, '')
    : requestUrl.pathname;

  upstream.pathname = `${basePath === '/' ? '' : basePath}${suffix}`;
  upstream.search = requestUrl.search;
  return upstream;
}

function getMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('')
      .trim();
  }
  return '';
}

function getTelegramText(message) {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text;
  if (typeof message.caption === 'string') return message.caption;
  return '';
}

function getTelegramChatId(update) {
  return (
    update?.message?.chat?.id ??
    update?.edited_message?.chat?.id ??
    update?.channel_post?.chat?.id ??
    update?.callback_query?.message?.chat?.id ??
    null
  );
}

function getTelegramCallbackQueryId(update) {
  return update?.callback_query?.id ?? '';
}

function getTelegramCallbackData(update) {
  return typeof update?.callback_query?.data === 'string' ? update.callback_query.data : '';
}

function parseTelegramCommand(text) {
  const firstToken = String(text || '').trim().split(/\s+/, 1)[0];
  if (!firstToken.startsWith('/')) return '';
  return firstToken.slice(1).split('@')[0].toLowerCase();
}

// Telegram 命令先集中登记，再由 help 面板和路由层一起读取。
const TELEGRAM_COMMAND_SPECS = Object.freeze([
  { command: 'start', description: '显示此帮助' },
  { command: 'help', description: '显示此帮助' },
  { command: 'model', description: '查看当前模型' },
  { command: 'reset', description: '清空当前会话' },
  { command: 'todo', description: '管理待办事项' },
  { command: 'remind', description: '管理提醒任务' },
  { command: 'watch', description: '管理网页监控' },
  { command: 'mode', description: '查看或切换运行模式' },
  { command: 'summary', description: '查看或压缩近期摘要' },
]);

function buildTelegramUnsupportedCommandText(command) {
  return `暂不支持 /${command}。输入 /help 查看可用命令。`;
}

const TELEGRAM_MODE_SPECS = Object.freeze([
  { mode: 'normal', label: '正常', description: '默认模式，平衡简洁和细节' },
  { mode: 'brief', label: '简洁', description: '尽量短，先给结论' },
  { mode: 'detailed', label: '详细', description: '回答更完整一些' },
  { mode: 'playful', label: '轻松', description: '语气更活泼一点' },
]);

function normalizeTelegramMode(mode) {
  const value = normalizeTelegramMemoryText(mode).toLowerCase();
  if (!value) return 'normal';

  if (value === 'normal' || value === 'default' || value === '默认' || value === '正常' || value === '普通') {
    return 'normal';
  }

  if (value === 'brief' || value === 'compact' || value === 'short' || value === '简洁' || value === '简短' || value === '精简') {
    return 'brief';
  }

  if (value === 'detailed' || value === 'detail' || value === 'long' || value === '详细' || value === '展开') {
    return 'detailed';
  }

  if (value === 'playful' || value === 'fun' || value === 'light' || value === '轻松' || value === '活泼' || value === '幽默') {
    return 'playful';
  }

  return '';
}

function buildTelegramModeDisplayName(mode) {
  const normalized = normalizeTelegramMode(mode);
  return TELEGRAM_MODE_SPECS.find((spec) => spec.mode === normalized)?.label || '正常';
}

function buildTelegramModeContextText(mode) {
  switch (normalizeTelegramMode(mode)) {
    case 'brief':
      return '当前对话模式：简洁。回答要短、直，先给结论，再补必要理由。';
    case 'detailed':
      return '当前对话模式：详细。回答可以更完整，分点说明，但不要灌水。';
    case 'playful':
      return '当前对话模式：轻松。语气可以更活泼一点，允许少量吐槽，但技术结论要准确。';
    default:
      return '';
  }
}

function buildTelegramModeListText(currentMode = 'normal') {
  const normalized = normalizeTelegramMode(currentMode) || 'normal';
  const lines = [
    `当前模式：${buildTelegramModeDisplayName(normalized)}（${normalized}）`,
    '',
    '可用模式：',
  ];

  TELEGRAM_MODE_SPECS.forEach((spec, index) => {
    lines.push(`${index + 1}. ${spec.label}（${spec.mode}）- ${spec.description}`);
  });

  lines.push(
    '',
    '命令：',
    '/mode - 查看当前模式',
    '/mode brief - 切换到简洁模式',
    '/mode detailed - 切换到详细模式',
    '/mode playful - 切换到轻松模式',
    '/mode normal - 切换回默认模式',
  );

  return lines.join('\n');
}

function buildTelegramModeUnavailableText() {
  return '当前还没有启用模式存储。请配置 TELEGRAM_SESSION 后再使用 /mode。';
}

function buildTelegramModeChangedText(mode) {
  return `已切换到${buildTelegramModeDisplayName(mode)}模式。`;
}

function buildTelegramSummaryUnavailableText() {
  return '当前还没有启用摘要存储。请配置 TELEGRAM_SESSION 后再使用 /summary。';
}

function buildTelegramConversationPreviewText(history = [], limit = 4) {
  const items = Array.isArray(history) ? history.slice(-limit) : [];
  if (items.length === 0) {
    return '近期对话：暂无。';
  }

  return [
    '近期对话：',
    ...items.map((message) => {
      const role = message?.role === 'assistant' ? 'workclaw' : message?.role === 'user' ? '你' : String(message?.role || '系统');
      const text = truncateContextText(normalizeTelegramDisplayText(getMessageText(message)), 120);
      return `- ${role}：${text}`;
    }),
  ].join('\n');
}

function buildTelegramSummaryCardText(session = {}) {
  const mode = buildTelegramModeDisplayName(session?.mode);
  const memorySummary = buildTelegramMemorySummaryText(Array.isArray(session?.memories) ? session.memories : [])
    .replace(/^历史摘要：\s*/u, '')
    .trim();
  const preview = buildTelegramConversationPreviewText(Array.isArray(session?.history) ? session.history : []);
  const lines = [
    '会话摘要卡：',
    `当前模式：${mode}`,
    preview,
    `长期记忆：${memorySummary || '暂无可压缩内容'}`,
  ];

  return lines.join('\n');
}

function buildTelegramSummaryContextText(session = {}) {
  const history = Array.isArray(session?.history) ? session.history : [];
  if (history.length <= 4) return '';
  const preview = buildTelegramConversationPreviewText(history);
  return `会话摘要（仅供参考，优先级低于用户当前消息）：\n${preview}`;
}

function normalizeTelegramSummaryText(text) {
  return normalizeTelegramMemoryText(text);
}

async function handleTelegramSlashCommand({ command, commandText = '', session, env, fetchImpl, chatId, replyMarkup }) {
  if (!command) return false;

  switch (command) {
    case 'start':
    case 'help':
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramHelpText(), replyMarkup);
      return true;
    case 'model':
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramModelText(env), replyMarkup);
      return true;
    case 'reset':
      if (session) {
        await resetTelegramConversation(session);
      }
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramResetText(), replyMarkup);
      return true;
    case 'todo':
      return handleTelegramTodoCommand({
        commandText,
        session,
        env,
        fetchImpl,
        chatId,
        replyMarkup,
      });
    case 'remind':
      return handleTelegramRemindCommand({
        commandText,
        session,
        env,
        fetchImpl,
        chatId,
        replyMarkup,
      });
    case 'watch':
      return handleTelegramWatchCommand({
        commandText,
        session,
        env,
        fetchImpl,
        chatId,
        replyMarkup,
      });
    case 'mode':
      return handleTelegramModeCommand({
        commandText,
        session,
        env,
        fetchImpl,
        chatId,
        replyMarkup,
      });
    case 'summary':
      return handleTelegramSummaryCommand({
        commandText,
        session,
        env,
        fetchImpl,
        chatId,
        replyMarkup,
      });
    default:
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramUnsupportedCommandText(command), replyMarkup);
      return true;
  }
}

async function handleTelegramTodoCommand({ commandText, session, env, fetchImpl, chatId, replyMarkup }) {
  if (!session) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramTodoUnavailableText(), replyMarkup);
    return true;
  }

  const todos = compactTelegramTodos(Array.isArray(session.todos) ? session.todos : []);
  const argsText = normalizeTelegramTodoText(getTelegramCommandArgs(commandText));

  if (!argsText) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramTodoListText(todos), replyMarkup);
    return true;
  }

  const [actionToken, ...restTokens] = argsText.split(/\s+/);
  const action = actionToken.toLowerCase();
  const valueText = normalizeTelegramTodoText(restTokens.join(' '));

  if (action === 'list' || action === 'ls' || action === 'show' || action === 'help') {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramTodoListText(todos), replyMarkup);
    return true;
  }

  if (action === 'add' || action === 'new' || action === 'create') {
    if (!valueText) {
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramTodoMissingText(), replyMarkup);
      return true;
    }

    session.todos = [...todos, valueText];
    await saveTelegramSession(session.storage, session);
    await sendTelegramMessage(env, fetchImpl, chatId, `已添加待办：${valueText}`, replyMarkup);
    return true;
  }

  if (action === 'clear' || action === 'empty') {
    session.todos = [];
    await saveTelegramSession(session.storage, session);
    await sendTelegramMessage(env, fetchImpl, chatId, '待办已清空。', replyMarkup);
    return true;
  }

  if (action === 'done' || action === 'finish' || action === 'complete') {
    if (!valueText) {
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramTodoMissingText(), replyMarkup);
      return true;
    }

    const index = resolveTelegramTodoIndex(todos, valueText);
    if (index === -1) {
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramTodoNotFoundText(), replyMarkup);
      return true;
    }

    const [removed] = todos.splice(index, 1);
    session.todos = todos;
    await saveTelegramSession(session.storage, session);
    await sendTelegramMessage(env, fetchImpl, chatId, `已完成待办：${removed}`, replyMarkup);
    return true;
  }

  if (action === 'del' || action === 'delete' || action === 'remove' || action === 'rm') {
    if (!valueText) {
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramTodoMissingText(), replyMarkup);
      return true;
    }

    const index = resolveTelegramTodoIndex(todos, valueText);
    if (index === -1) {
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramTodoNotFoundText(), replyMarkup);
      return true;
    }

    const [removed] = todos.splice(index, 1);
    session.todos = todos;
    await saveTelegramSession(session.storage, session);
    await sendTelegramMessage(env, fetchImpl, chatId, `已删除待办：${removed}`, replyMarkup);
    return true;
  }

  const todoText = normalizeTelegramTodoText(argsText);
  if (!todoText) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramTodoMissingText(), replyMarkup);
    return true;
  }

  session.todos = [...todos, todoText];
  await saveTelegramSession(session.storage, session);
  await sendTelegramMessage(env, fetchImpl, chatId, `已添加待办：${todoText}`, replyMarkup);
  return true;
}

async function handleTelegramRemindCommand({ commandText, session, env, fetchImpl, chatId, replyMarkup }) {
  if (!session) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramReminderUnavailableText(), replyMarkup);
    return true;
  }

  session.chatId = chatId;
  const reminders = compactTelegramReminders(Array.isArray(session.reminders) ? session.reminders : []);
  const argsText = normalizeTelegramReminderText(getTelegramCommandArgs(commandText));

  if (!argsText) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramRemindListText(reminders), replyMarkup);
    return true;
  }

  const [actionToken, ...restTokens] = argsText.split(/\s+/);
  const action = actionToken.toLowerCase();
  const valueText = normalizeTelegramReminderText(restTokens.join(' '));

  if (action === 'list' || action === 'ls' || action === 'show' || action === 'help') {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramRemindListText(reminders), replyMarkup);
    return true;
  }

  if (action === 'clear' || action === 'empty') {
    session.reminders = [];
    await saveTelegramSession(session.storage, session);
    await scheduleTelegramReminderAlarm(session);
    await sendTelegramMessage(env, fetchImpl, chatId, '提醒已清空。', replyMarkup);
    return true;
  }

  if (action === 'done' || action === 'finish' || action === 'complete' || action === 'del' || action === 'delete' || action === 'remove' || action === 'rm' || action === 'cancel') {
    if (!valueText) {
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramReminderMissingText(), replyMarkup);
      return true;
    }

    const index = resolveTelegramReminderIndex(reminders, valueText);
    if (index === -1) {
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramReminderNotFoundText(), replyMarkup);
      return true;
    }

    const [removed] = reminders.splice(index, 1);
    session.reminders = reminders;
    await saveTelegramSession(session.storage, session);
    await scheduleTelegramReminderAlarm(session);
    await sendTelegramMessage(env, fetchImpl, chatId, `已取消提醒：${removed.text}`, replyMarkup);
    return true;
  }

  const spec = buildTelegramReminderSpecFromArgs(action, valueText || restTokens.join(' '));
  if (!spec) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramReminderMissingText(), replyMarkup);
    return true;
  }

  const reminder = createTelegramReminder(spec.reminderText, Date.now() + spec.delayMs);
  session.reminders = [...reminders, reminder];
  await saveTelegramSession(session.storage, session);
  await scheduleTelegramReminderAlarm(session);
  await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramReminderAddedText(reminder), replyMarkup);
  return true;
}

// Telegram 的按钮交互只走 callback_query，不会额外发一条普通文本消息。
// 下面这组按钮统一复用：Retry 重新生成上一轮，Reset 清空会话，Help 打开帮助面板。
// 对应的 Telegram Bot API 细节：
// https://core.telegram.org/bots/api#callbackquery
// https://core.telegram.org/bots/api#answercallbackquery
// https://core.telegram.org/bots/api#editmessagetext
function buildTelegramReplyMarkup() {
  return {
    inline_keyboard: [
      [
        { text: '重试', callback_data: 'retry' },
        { text: '重置', callback_data: 'reset' },
      ],
      [{ text: '帮助', callback_data: 'help' }],
    ],
  };
}

function buildTelegramHelpText() {
  // /start 和 /help 返回同一份说明，目的不是"讲故事"，而是让用户
  // 一眼知道有哪些命令、按钮各自负责什么，以及下一步该点哪里。
  const lines = [
    '发送消息，我会在当前对话里回复。',
    '',
    '命令：',
  ];

  for (const spec of TELEGRAM_COMMAND_SPECS) {
    lines.push(`/${spec.command} - ${spec.description}`);
  }

  lines.push(
    '',
    '按钮：',
    '重试 - 重新生成上一条回复',
    '重置 - 清空当前会话',
  );

  return lines.join('\n');
}

function buildTelegramModelText(env) {
  // /model 只是只读查询：把当前模型、回复模式和是否开启流式返回给用户，
  // 不写入历史，不改变会话状态，也不触发新的推理。
  const model = getConfiguredModel(env);
  const hasUpstream = Boolean(getOpenAIBaseUrl(env));
  const hasAI = Boolean(env?.WORKCLAW_AI);
  let mode;
  if (hasUpstream) mode = '上游 OpenAI 兼容接口';
  else if (hasAI) mode = 'Workers AI（本机推理）';
  else mode = '本地';

  return [
    `当前模型：${model}`,
    `回复模式：${mode}`,
    '流式输出：已开启',
  ].join('\n');
}

function buildTelegramResetText() {
  // 重置后的确认文案要短，避免让用户误以为还有旧上下文残留。
  return '会话已清空。发送新消息即可重新开始。';
}

function buildTelegramThinkingText() {
  // 先发"思考中"，再把模型输出逐段编辑进同一条消息。
  return '思考中...';
}

// 主动跟进只做轻量的一句，不抢主回复的戏。
// 规则很克制：只有用户明显在提需求、而且回复里还没自己带出"要不要/如果你想"这类跟进语气时才发送。
const TELEGRAM_PROACTIVE_FOLLOW_UP_RULES = Object.freeze([
  {
    patterns: [/readme/iu, /说明文档/iu, /文档结构/iu],
    followUp: '要不要我顺手帮你补一版 README 结构？',
  },
  {
    patterns: [/部署/iu, /上线/iu, /worker/iu, /wrangler/iu, /cloudflare/iu],
    followUp: '要不要我顺手帮你列一份部署清单？',
  },
  {
    patterns: [/长期记忆/iu, /记忆/iu, /memory/iu],
    followUp: '要不要我顺手把长期记忆流程也补上？',
  },
  {
    patterns: [/telegram/iu, /机器人/iu, /webhook/iu, /回调/iu, /按钮/iu],
    followUp: '要不要我顺手把 Telegram 交互也补完整？',
  },
  {
    patterns: [/搜索/iu, /抓取/iu, /scrape/iu, /crawl/iu, /网页/iu],
    followUp: '要不要我顺手把搜索和抓取的入口也串起来？',
  },
  {
    patterns: [/todo/iu, /待办/iu, /提醒/iu, /watch/iu, /监控/iu],
    followUp: '要不要我顺手把这块的命令也整理成一套？',
  },
]);

const TELEGRAM_PROACTIVE_FOLLOW_UP_PROMPT_PATTERN = /(?:帮我|请|麻烦|写|生成|实现|修复|优化|补|整理|总结|分析|翻译|设计|部署|做|列出|改|接入|加上|支持|排查|调试|看看)/iu;
const TELEGRAM_PROACTIVE_FOLLOW_UP_REPLY_PATTERN = /(?:要不要|如果你想|需要的话|如果需要|要是你想|我也可以|我还能|还要我|需要我)/iu;

function buildTelegramProactiveFollowUpText(prompt, replyText) {
  const normalizedPrompt = normalizeTelegramDisplayText(prompt);
  if (!normalizedPrompt || !TELEGRAM_PROACTIVE_FOLLOW_UP_PROMPT_PATTERN.test(normalizedPrompt)) {
    return '';
  }

  const normalizedReply = normalizeTelegramDisplayText(replyText);
  if (normalizedReply && TELEGRAM_PROACTIVE_FOLLOW_UP_REPLY_PATTERN.test(normalizedReply)) {
    return '';
  }

  for (const rule of TELEGRAM_PROACTIVE_FOLLOW_UP_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalizedPrompt))) {
      return rule.followUp;
    }
  }

  return '要不要我顺手把下一步拆成清单？';
}

async function sendTelegramProactiveFollowUp({ env, fetchImpl, chatId, prompt, replyText }) {
  const followUpText = buildTelegramProactiveFollowUpText(prompt, replyText);
  if (!followUpText) {
    return false;
  }

  try {
    await sendTelegramMessage(env, fetchImpl, chatId, followUpText);
    return true;
  } catch (error) {
    console.error('Telegram proactive follow-up failed', error);
    return false;
  }
}

function buildTelegramMemoryContextText(memories = []) {
  const recentMemories = compactTelegramMemories(Array.isArray(memories) ? memories : []);
  if (recentMemories.length === 0) return '';

  return [
    '长期记忆（仅供参考，优先级低于用户当前消息）：',
    ...recentMemories.map((memory) => `- ${memory.text}`),
  ].join('\n');
}

function normalizeTelegramTodoText(text) {
  return normalizeTelegramMemoryText(text)
    .replace(/^[:：\s-]+/, '')
    .replace(/[。！？!?]+$/u, '')
    .trim();
}

function compactTelegramTodos(todos = []) {
  if (!Array.isArray(todos) || todos.length === 0) {
    return [];
  }

  return todos
    .map((todo) => normalizeTelegramTodoText(todo))
    .filter(Boolean);
}

function resolveTelegramTodoIndex(todos, rawTarget) {
  if (!Array.isArray(todos) || todos.length === 0) return -1;

  const target = normalizeTelegramTodoText(rawTarget);
  if (!target) return -1;

  const numeric = Number.parseInt(target, 10);
  if (Number.isInteger(numeric) && String(numeric) === target) {
    const index = numeric - 1;
    return index >= 0 && index < todos.length ? index : -1;
  }

  const lowerTarget = target.toLowerCase();
  return todos.findIndex((todo) => todo.toLowerCase().includes(lowerTarget));
}

function buildTelegramTodoListText(todos = []) {
  const items = compactTelegramTodos(todos);
  const lines = [];

  if (items.length === 0) {
    lines.push('当前没有待办。');
  } else {
    lines.push('当前待办：');
    items.forEach((todo, index) => {
      lines.push(`${index + 1}. ${truncateContextText(todo, 120)}`);
    });
  }

  lines.push(
    '',
    '命令：',
    '/todo - 查看当前待办',
    '/todo add 内容 - 添加待办',
    '/todo done 编号或关键词 - 标记完成并删除',
    '/todo del 编号或关键词 - 删除待办',
    '/todo clear - 清空全部待办',
  );

  return lines.join('\n');
}

function buildTelegramTodoUnavailableText() {
  return '当前还没有启用待办存储。请配置 TELEGRAM_SESSION 后再使用 /todo。';
}

function buildTelegramTodoMissingText() {
  return '请在 /todo 后面补充待办内容。';
}

function buildTelegramTodoNotFoundText() {
  return '没有找到要处理的待办。';
}

function normalizeTelegramReminderText(text) {
  return normalizeTelegramMemoryText(text);
}

function compactTelegramReminders(reminders = []) {
  if (!Array.isArray(reminders) || reminders.length === 0) {
    return [];
  }

  return reminders
    .map((reminder) => ({
      id: typeof reminder?.id === 'string' && reminder.id ? reminder.id : crypto.randomUUID(),
      text: normalizeTelegramReminderText(reminder?.text),
      dueAt: Number(reminder?.dueAt),
      createdAt: Number(reminder?.createdAt) || Date.now(),
    }))
    .filter((reminder) => reminder.text && Number.isFinite(reminder.dueAt))
    .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
}

function createTelegramReminder(text, dueAt) {
  return {
    id: crypto.randomUUID(),
    text: normalizeTelegramReminderText(text),
    dueAt,
    createdAt: Date.now(),
  };
}

function parseTelegramDurationMs(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, '').toLowerCase();
  if (!normalized) return null;

  const pattern = /(\d+)(分钟|小时|天|日|时|分|秒|d|h|m|s)/gi;
  let total = 0;
  let matched = '';
  let match;

  while ((match = pattern.exec(normalized))) {
    const amount = Number.parseInt(match[1], 10);
    if (!Number.isFinite(amount)) return null;

    const unit = match[2].toLowerCase();
    const factor =
      unit === '天' || unit === '日' || unit === 'd'
        ? 24 * 60 * 60 * 1000
        : unit === '小时' || unit === '时' || unit === 'h'
          ? 60 * 60 * 1000
          : unit === '分钟' || unit === '分' || unit === 'm'
            ? 60 * 1000
            : 1000;

    total += amount * factor;
    matched += match[0].toLowerCase();
  }

  if (matched !== normalized) return null;
  return total;
}

function formatTelegramReminderDelayText(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (!totalSeconds) return '立即';

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分钟`);
  if (seconds && parts.length === 0) parts.push(`${seconds}秒`);

  return `${parts.join('')}后`;
}

function resolveTelegramReminderIndex(reminders, rawTarget) {
  if (!Array.isArray(reminders) || reminders.length === 0) return -1;

  const target = normalizeTelegramReminderText(rawTarget);
  if (!target) return -1;

  const numeric = Number.parseInt(target, 10);
  if (Number.isInteger(numeric) && String(numeric) === target) {
    const index = numeric - 1;
    return index >= 0 && index < reminders.length ? index : -1;
  }

  const lowerTarget = target.toLowerCase();
  return reminders.findIndex((reminder) => reminder.text.toLowerCase().includes(lowerTarget));
}

function buildTelegramRemindListText(reminders = []) {
  const items = compactTelegramReminders(reminders);
  const lines = [];

  if (items.length === 0) {
    lines.push('当前没有提醒。');
  } else {
    lines.push('当前提醒：');
    items.forEach((reminder, index) => {
      lines.push(`${index + 1}. [${formatTelegramReminderDelayText(reminder.dueAt - Date.now())}] ${truncateContextText(reminder.text, 120)}`);
    });
  }

  lines.push(
    '',
    '命令：',
    '/remind - 查看当前提醒',
    '/remind add 10m 喝水 - 添加提醒',
    '/remind done 1 - 取消提醒',
    '/remind del 1 - 删除提醒',
    '/remind clear - 清空提醒',
  );

  return lines.join('\n');
}

function buildTelegramReminderUnavailableText() {
  return '当前还没有启用提醒存储。请配置 TELEGRAM_SESSION 后再使用 /remind。';
}

function buildTelegramReminderMissingText() {
  return '请用 /remind add 10m 喝水 这样的格式。';
}

function buildTelegramReminderNotFoundText() {
  return '没有找到要处理的提醒。';
}

function buildTelegramReminderAddedText(reminder) {
  return `已添加提醒：${formatTelegramReminderDelayText(reminder.dueAt - Date.now())} · ${reminder.text}`;
}

function buildTelegramReminderFiredText(reminder) {
  return `⏰ 提醒：${reminder.text}`;
}

function parseTelegramReminderAddSpec(text) {
  const valueText = normalizeTelegramReminderText(text);
  if (!valueText) return null;

  const [delayText, ...reminderTokens] = valueText.split(/\s+/);
  const delayMs = parseTelegramDurationMs(delayText);
  const reminderText = normalizeTelegramReminderText(reminderTokens.join(' '));

  if (delayMs === null || !reminderText) return null;
  return { delayMs, reminderText };
}

function buildTelegramReminderSpecFromArgs(action, valueText) {
  if (action === 'add' || action === 'new' || action === 'create') {
    return parseTelegramReminderAddSpec(valueText);
  }

  const delayMs = parseTelegramDurationMs(action);
  if (delayMs === null) return null;

  const reminderText = normalizeTelegramReminderText(valueText);
  if (!reminderText) return null;
  return { delayMs, reminderText };
}

function normalizeTelegramWatchText(text) {
  return normalizeTelegramMemoryText(text)
    .replace(/^[:：\s-]+/, '')
    .replace(/[。！？!?]+$/u, '')
    .trim();
}

function normalizeTelegramWatchUrl(rawUrl) {
  const normalized = normalizeTelegramMemoryText(rawUrl);
  if (!normalized) return '';

  try {
    const url = new URL(normalized);
    if (!/^https?:$/i.test(url.protocol)) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function buildTelegramWatchDisplayName(watch = {}) {
  const label = normalizeTelegramWatchText(watch?.label);
  if (label) return label;

  const title = normalizeTelegramWatchText(watch?.title);
  if (title) return title;

  try {
    return new URL(watch?.url).hostname;
  } catch {
    return normalizeTelegramWatchText(watch?.url) || '网页监控';
  }
}

function compactTelegramWatches(watches = []) {
  if (!Array.isArray(watches) || watches.length === 0) {
    return [];
  }

  const items = [];
  const seen = new Set();

  for (const watch of watches) {
    const url = normalizeTelegramWatchUrl(watch?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const nextCheckAt = Number(watch?.nextCheckAt);
    const createdAt = Number(watch?.createdAt);
    const lastCheckedAt = Number(watch?.lastCheckedAt);
    const lastNotifiedAt = Number(watch?.lastNotifiedAt);

    items.push({
      id: typeof watch?.id === 'string' && watch.id ? watch.id : crypto.randomUUID(),
      url,
      label: normalizeTelegramWatchText(watch?.label),
      title: normalizeTelegramWatchText(watch?.title),
      contentHash: typeof watch?.contentHash === 'string' ? watch.contentHash : '',
      nextCheckAt: Number.isFinite(nextCheckAt) ? nextCheckAt : Date.now(),
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      lastCheckedAt: Number.isFinite(lastCheckedAt) ? lastCheckedAt : 0,
      lastNotifiedAt: Number.isFinite(lastNotifiedAt) ? lastNotifiedAt : 0,
    });
  }

  return items.sort((a, b) => a.nextCheckAt - b.nextCheckAt || a.createdAt - b.createdAt);
}

function resolveTelegramWatchIndex(watches, rawTarget) {
  if (!Array.isArray(watches) || watches.length === 0) return -1;

  const target = normalizeTelegramWatchText(rawTarget);
  if (!target) return -1;

  const numeric = Number.parseInt(target, 10);
  if (Number.isInteger(numeric) && String(numeric) === target) {
    const index = numeric - 1;
    return index >= 0 && index < watches.length ? index : -1;
  }

  const lowerTarget = target.toLowerCase();
  return watches.findIndex((watch) => {
    const haystacks = [watch?.label, watch?.title, watch?.url];
    return haystacks.some((value) => normalizeTelegramWatchText(value).toLowerCase().includes(lowerTarget));
  });
}

function buildTelegramWatchListText(watches = []) {
  const items = compactTelegramWatches(watches);
  const lines = [];

  if (items.length === 0) {
    lines.push('当前没有网页监控。');
  } else {
    lines.push('当前网页监控：');
    items.forEach((watch, index) => {
      const name = truncateContextText(buildTelegramWatchDisplayName(watch), 120);
      const nextCheckText = formatTelegramReminderDelayText(Math.max(0, Number(watch.nextCheckAt) - Date.now()));
      lines.push(`${index + 1}. ${name}`);
      lines.push(`   ${truncateContextText(watch.url, 240)}`);
      lines.push(`   下次检查：${nextCheckText}`);
      if (!watch.contentHash) {
        lines.push('   状态：等待首次抓取');
      }
    });
  }

  lines.push(
    '',
    '命令：',
    '/watch - 查看当前网页监控',
    '/watch add URL - 添加网页监控',
    '/watch del 编号或关键词 - 删除网页监控',
    '/watch clear - 清空全部网页监控',
  );

  return lines.join('\n');
}

function buildTelegramWatchUnavailableText() {
  return '当前还没有启用网页监控存储。请配置 TELEGRAM_SESSION 后再使用 /watch。';
}

function buildTelegramWatchMissingText() {
  return '请在 /watch 后面补充网页 URL、编号或关键词。';
}

function buildTelegramWatchNotFoundText() {
  return '没有找到要处理的网页监控。';
}

function buildTelegramWatchAddedText(watch, hasBaseline = false) {
  const name = buildTelegramWatchDisplayName(watch);
  const lines = [
    `已添加网页监控：${name}`,
    watch.url,
  ];

  if (hasBaseline) {
    lines.push(`首次检查：${formatTelegramReminderDelayText(Math.max(0, Number(watch.nextCheckAt) - Date.now()))}`);
  } else {
    lines.push('首次抓取失败，稍后重试。');
  }

  return lines.join('\n');
}

function buildTelegramWatchChangedText(watch, page) {
  const name = buildTelegramWatchDisplayName({ ...watch, title: page?.title || watch?.title });
  const lines = [
    `网页已变化：${name}`,
    watch.url,
  ];

  const summary = truncateContextText(page?.text || '', 240);
  if (summary) {
    lines.push(`新内容摘要：${summary}`);
  } else {
    lines.push('已检测到更新，但正文抓取为空。');
  }

  return lines.join('\n');
}

async function hashTelegramWatchContent(page) {
  const text = normalizeTelegramMemoryText(`${page?.title || ''}\n${page?.text || ''}`);
  if (!text) return '';

  const buffer = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseTelegramWatchAddSpec(text) {
  const valueText = normalizeTelegramWatchText(text);
  if (!valueText) return null;

  const urls = extractUrlsFromText(valueText);
  if (urls.length === 0) return null;

  const url = normalizeTelegramWatchUrl(urls[0]);
  if (!url) return null;

  const label = normalizeTelegramWatchText(valueText.replace(urls[0], ''));
  return { url, label };
}

function createTelegramWatch(url, label = '') {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    url: normalizeTelegramWatchUrl(url),
    label: normalizeTelegramWatchText(label),
    title: '',
    contentHash: '',
    nextCheckAt: now + TELEGRAM_WATCH_POLL_INTERVAL_MS,
    createdAt: now,
    lastCheckedAt: 0,
    lastNotifiedAt: 0,
  };
}

async function scheduleTelegramReminderAlarm(session) {
  const storage = session?.storage;
  if (!storage) return;

  const reminders = compactTelegramReminders(Array.isArray(session?.reminders) ? session.reminders : []);
  const watches = compactTelegramWatches(Array.isArray(session?.watches) ? session.watches : []);
  session.reminders = reminders;
  session.watches = watches;

  const nextDueTimes = [];
  if (reminders.length > 0) {
    nextDueTimes.push(reminders[0].dueAt);
  }
  if (watches.length > 0) {
    nextDueTimes.push(watches[0].nextCheckAt);
  }

  if (nextDueTimes.length === 0) {
    if (typeof storage.deleteAlarm === 'function') {
      await storage.deleteAlarm();
    }
    return;
  }

  const nextDueAt = Math.max(Date.now(), Math.min(...nextDueTimes));
  if (typeof storage.setAlarm === 'function') {
    await storage.setAlarm(nextDueAt);
  }
}

async function deliverDueTelegramReminders(session, env, fetchImpl) {
  const reminders = compactTelegramReminders(Array.isArray(session?.reminders) ? session.reminders : []);
  if (reminders.length === 0) {
    await scheduleTelegramReminderAlarm(session);
    return [];
  }

  const now = Date.now();
  const dueReminders = reminders.filter((reminder) => reminder.dueAt <= now);
  if (dueReminders.length === 0) {
    await scheduleTelegramReminderAlarm(session);
    return [];
  }

  const chatId = session?.chatId ?? null;
  if (chatId === null || chatId === undefined) {
    session.reminders = reminders;
    await saveTelegramSession(session.storage, session);
    await scheduleTelegramReminderAlarm(session);
    return [];
  }

  let remaining = reminders.slice();
  for (const reminder of dueReminders) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramReminderFiredText(reminder), {
      reply_markup: buildTelegramReplyMarkup(),
    });
    remaining = remaining.filter((item) => item.id !== reminder.id);
    session.reminders = remaining;
    await saveTelegramSession(session.storage, session);
  }

  await scheduleTelegramReminderAlarm(session);
  return dueReminders;
}

async function handleTelegramWatchCommand({ commandText, session, env, fetchImpl, chatId, replyMarkup }) {
  if (!session) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramWatchUnavailableText(), replyMarkup);
    return true;
  }

  session.chatId = chatId;
  const watches = compactTelegramWatches(Array.isArray(session.watches) ? session.watches : []);
  const argsText = normalizeTelegramWatchText(getTelegramCommandArgs(commandText));

  if (!argsText) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramWatchListText(watches), replyMarkup);
    return true;
  }

  const [actionToken, ...restTokens] = argsText.split(/\s+/);
  const action = actionToken.toLowerCase();
  const valueText = normalizeTelegramWatchText(restTokens.join(' '));

  if (action === 'list' || action === 'ls' || action === 'show' || action === 'help') {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramWatchListText(watches), replyMarkup);
    return true;
  }

  if (action === 'clear' || action === 'empty') {
    session.watches = [];
    await saveTelegramSession(session.storage, session);
    await scheduleTelegramReminderAlarm(session);
    await sendTelegramMessage(env, fetchImpl, chatId, '网页监控已清空。', replyMarkup);
    return true;
  }

  if (action === 'del' || action === 'delete' || action === 'remove' || action === 'rm') {
    if (!valueText) {
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramWatchMissingText(), replyMarkup);
      return true;
    }

    const index = resolveTelegramWatchIndex(watches, valueText);
    if (index === -1) {
      await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramWatchNotFoundText(), replyMarkup);
      return true;
    }

    const [removed] = watches.splice(index, 1);
    session.watches = watches;
    await saveTelegramSession(session.storage, session);
    await scheduleTelegramReminderAlarm(session);
    await sendTelegramMessage(env, fetchImpl, chatId, `已删除网页监控：${buildTelegramWatchDisplayName(removed)}`, replyMarkup);
    return true;
  }

  const addSpec = action === 'add' || action === 'new' || action === 'create'
    ? parseTelegramWatchAddSpec(valueText || restTokens.join(' '))
    : parseTelegramWatchAddSpec(argsText);

  if (!addSpec) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramWatchMissingText(), replyMarkup);
    return true;
  }

  if (watches.some((watch) => watch.url === addSpec.url)) {
    await sendTelegramMessage(env, fetchImpl, chatId, '该网页已在监控中。', replyMarkup);
    return true;
  }

  const watch = createTelegramWatch(addSpec.url, addSpec.label);
  const page = await scrapeWebPage(fetchImpl, watch.url).catch(() => null);
  if (page) {
    const now = Date.now();
    watch.title = normalizeTelegramWatchText(page.title) || watch.label || watch.title || new URL(watch.url).hostname;
    watch.contentHash = await hashTelegramWatchContent(page);
    watch.lastCheckedAt = now;
    watch.nextCheckAt = now + TELEGRAM_WATCH_POLL_INTERVAL_MS;
  } else {
    watch.title = watch.label || (() => {
      try {
        return new URL(watch.url).hostname;
      } catch {
        return watch.url;
      }
    })();
    watch.nextCheckAt = Date.now() + TELEGRAM_WATCH_POLL_INTERVAL_MS;
  }

  session.watches = [...watches, watch];
  await saveTelegramSession(session.storage, session);
  await scheduleTelegramReminderAlarm(session);
  await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramWatchAddedText(watch, Boolean(page)), replyMarkup);
  return true;
}

async function handleTelegramModeCommand({ commandText, session, env, fetchImpl, chatId, replyMarkup }) {
  if (!session) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramModeUnavailableText(), replyMarkup);
    return true;
  }

  const currentMode = normalizeTelegramMode(session.mode) || 'normal';
  const argsText = normalizeTelegramMemoryText(getTelegramCommandArgs(commandText));
  const [actionToken = '', ...restTokens] = argsText.split(/\s+/);
  const action = actionToken.toLowerCase();
  const nextMode = normalizeTelegramMode(actionToken) || normalizeTelegramMode(restTokens.join(' '));

  if (!argsText || action === 'help' || action === 'list' || action === 'show') {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramModeListText(currentMode), replyMarkup);
    return true;
  }

  if (!nextMode) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramModeListText(currentMode), replyMarkup);
    return true;
  }

  session.mode = nextMode;
  await saveTelegramSession(session.storage, session);
  await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramModeChangedText(nextMode), replyMarkup);
  return true;
}

async function handleTelegramSummaryCommand({ commandText, session, env, fetchImpl, chatId, replyMarkup }) {
  if (!session) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramSummaryUnavailableText(), replyMarkup);
    return true;
  }

  const argsText = normalizeTelegramSummaryText(getTelegramCommandArgs(commandText));
  const [actionToken = ''] = argsText.split(/\s+/);
  const action = normalizeTelegramSummaryText(actionToken).toLowerCase();

  if (action === 'compact') {
    session.memories = compactTelegramMemories(Array.isArray(session.memories) ? session.memories : []);
    await saveTelegramSession(session.storage, session);
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramSummaryCardText(session), replyMarkup);
    return true;
  }

  if (action === 'help' || action === 'show' || action === 'list' || action === 'refresh') {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramSummaryCardText(session), replyMarkup);
    return true;
  }

  if (!argsText) {
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramSummaryCardText(session), replyMarkup);
    return true;
  }

  if (action === 'clear' || action === 'reset' || action === 'empty') {
    await sendTelegramMessage(env, fetchImpl, chatId, '摘要是动态生成的，不需要单独清空。', replyMarkup);
    return true;
  }

  await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramSummaryCardText(session), replyMarkup);
  return true;
}

async function deliverDueTelegramWatches(session, env, fetchImpl) {
  const watches = compactTelegramWatches(Array.isArray(session?.watches) ? session.watches : []);
  if (watches.length === 0) {
    await scheduleTelegramReminderAlarm(session);
    return [];
  }

  const now = Date.now();
  const dueWatches = watches.filter((watch) => watch.nextCheckAt <= now);
  if (dueWatches.length === 0) {
    await scheduleTelegramReminderAlarm(session);
    return [];
  }

  const chatId = session?.chatId ?? null;
  let remaining = watches.slice();

  for (const watch of dueWatches) {
    const index = remaining.findIndex((item) => item.id === watch.id);
    if (index === -1) continue;

    const current = remaining[index];
    const updated = {
      ...current,
      nextCheckAt: now + TELEGRAM_WATCH_POLL_INTERVAL_MS,
      lastCheckedAt: now,
    };

    const page = await scrapeWebPage(fetchImpl, current.url).catch(() => null);
    if (page) {
      updated.title = normalizeTelegramWatchText(page.title) || updated.title || current.label || current.title;
      const contentHash = await hashTelegramWatchContent(page);
      const changed = Boolean(updated.contentHash) && contentHash && contentHash !== updated.contentHash;
      if (contentHash) {
        updated.contentHash = contentHash;
      }

      if (changed && chatId !== null && chatId !== undefined) {
        try {
          await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramWatchChangedText(updated, page), {
            reply_markup: buildTelegramReplyMarkup(),
          });
          updated.lastNotifiedAt = now;
        } catch (error) {
          console.error('Telegram watch notification failed', error);
        }
      }
    }

    remaining[index] = updated;
    session.watches = remaining;
    await saveTelegramSession(session.storage, session);
  }

  await scheduleTelegramReminderAlarm(session);
  return dueWatches;
}

async function runTelegramAlarmTask(name, task) {
  try {
    await task();
    return true;
  } catch (error) {
    console.error(`Telegram alarm ${name} failed`, error);
    return false;
  }
}

function buildTelegramConversationMessages(messages, memories = [], webContext = '', sessionContext = {}) {
  const conversationMessages = Array.isArray(messages) ? messages : [];
  const contextMessages = [];
  if (CLAW_SYSTEM_MESSAGE) {
    contextMessages.push(CLAW_SYSTEM_MESSAGE);
  }
  const modeContext = buildTelegramModeContextText(sessionContext?.mode);
  if (modeContext) {
    contextMessages.push({ role: 'system', content: modeContext });
  }

  const summaryContext = buildTelegramSummaryContextText(sessionContext);
  if (summaryContext) {
    contextMessages.push({ role: 'system', content: summaryContext });
  }
  const memoryContext = buildTelegramMemoryContextText(memories);
  if (memoryContext) {
    contextMessages.push({ role: 'system', content: memoryContext });
  }

  const webContextText = typeof webContext === 'string' ? webContext.trim() : '';
  if (webContextText) {
    contextMessages.push({ role: 'system', content: webContextText });
  }

  if (contextMessages.length === 0) {
    return conversationMessages;
  }

  return [...contextMessages, ...conversationMessages];
}

function getTelegramCommandArgs(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return '';

  const firstSpace = trimmed.indexOf(' ');
  return firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
}

function decodeHtmlEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    if (lower.startsWith('#x')) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function truncateContextText(text, limit) {
  const value = String(text || '').trim();
  if (!limit || value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function extractUrlsFromText(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"'`]+/giu) ?? [];
  const urls = [];
  const seen = new Set();

  for (const rawUrl of matches) {
    const cleaned = rawUrl.replace(/[)\].,，。！？!?]+$/u, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }

  return urls;
}

function shouldSearchWeb(prompt) {
  const text = normalizeTelegramMemoryText(prompt);
  if (!text) return false;
  return /(?:搜索|查找|查询|查一下|搜一下|搜索一下|最新|新闻|官网|资料|价格|行情|版本|更新|release|文档|网页|互联网)/iu.test(text);
}

function buildSearchQueryFromPrompt(prompt) {
  const text = normalizeTelegramMemoryText(prompt);
  if (!text) return '';

  const withoutUrls = text.replace(/https?:\/\/[^\s<>"'`]+/giu, ' ');
  const withoutIntent = withoutUrls
    .replace(/^(?:请|帮我|麻烦)?(?:搜索一下|搜索|查找一下|查找|查询|查一下|搜一下|找一下|了解一下|看看)\s*/iu, '')
    .replace(/^(?:请|帮我|麻烦)\s*/iu, '')
    .trim();

  return withoutIntent || text;
}

function resolveDuckDuckGoResultUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function parseDuckDuckGoSearchResults(html, limit = WEB_SEARCH_RESULT_LIMIT) {
  const results = [];
  const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(String(html || ''))) && results.length < limit) {
    const title = truncateContextText(stripHtmlToText(match[2]), 160);
    const url = truncateContextText(resolveDuckDuckGoResultUrl(decodeHtmlEntities(match[1])), 300);
    if (!title || !url) continue;
    results.push({ title, url });
  }

  return results;
}

async function fetchTextWithTimeout(fetchImpl, input, init = {}, timeoutMs = WEB_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTextWithLimit(response, maxChars = 50000) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    return String(await response.text().catch(() => '')).slice(0, maxChars);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (text.length < maxChars) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= maxChars) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors from partially-consumed streams.
    }
  }

  return text.slice(0, maxChars);
}

// ── 带 KV 缓存的网络搜索 ──
async function searchWeb(fetchImpl, query, env) {
  // 优先读 KV 缓存
  if (env?.WORKCLAW_CACHE) {
    const cached = await getCachedSearch(env, query);
    if (cached) return cached;
  }

  const searchQuery = buildSearchQueryFromPrompt(query);
  if (!searchQuery) return [];

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
  let response;
  try {
    response = await fetchTextWithTimeout(fetchImpl, searchUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0 (compatible; workclaw/1.0)',
      },
    });
  } catch {
    return [];
  }

  if (!response?.ok) return [];
  const html = await readResponseTextWithLimit(response, 25000).catch(() => '');
  const results = parseDuckDuckGoSearchResults(html, WEB_SEARCH_RESULT_LIMIT);

  // 写入 KV 缓存 (30 min TTL)
  if (env?.WORKCLAW_CACHE && results.length > 0) {
    await cacheSearchResult(env, query, results);
  }

  return results;
}

// ── 带 KV/R2 缓存的网页抓取 ──
async function scrapeWebPage(fetchImpl, rawUrl, env) {
  // 优先读 KV 缓存
  if (env?.WORKCLAW_CACHE) {
    const cached = await getCachedScrape(env, rawUrl);
    if (cached) return cached;
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(url.protocol)) {
    return null;
  }

  let response;
  try {
    response = await fetchTextWithTimeout(fetchImpl, url.toString(), {
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (compatible; workclaw/1.0)',
      },
    });
  } catch {
    return null;
  }

  if (!response?.ok) return null;
  const rawText = await readResponseTextWithLimit(response, 50000).catch(() => '');
  if (!rawText) return null;

  const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = truncateContextText(
    stripHtmlToText(titleMatch?.[1] ?? '') || url.hostname,
    160,
  );
  const text = truncateContextText(stripHtmlToText(rawText), 900);

  const pageData = { title, url: url.toString(), text };

  // 写入 KV 缓存 (60 min TTL)
  if (env?.WORKCLAW_CACHE) {
    await cacheScrapedPage(env, rawUrl, pageData);
  }

  // 大内容存 R2 (用于后续参考)
  if (env?.WORKCLAW_ASSETS) {
    await storePageSnapshot(env, rawUrl, rawText, 'text/html').catch(() => {});
  }

  return pageData;
}

function buildWebContextText({ searchQuery = '', searchResults = [], scrapedPages = [] } = {}) {
  const sections = [];

  if (searchQuery) {
    sections.push(`搜索关键词：${truncateContextText(searchQuery, 160)}`);
  }

  if (Array.isArray(searchResults) && searchResults.length > 0) {
    sections.push('网络搜索结果（仅供参考）：');
    searchResults.forEach((result, index) => {
      sections.push(`${index + 1}. ${truncateContextText(result.title, 120)}`);
      sections.push(`   ${truncateContextText(result.url, 240)}`);
    });
  }

  if (Array.isArray(scrapedPages) && scrapedPages.length > 0) {
    sections.push('网页抓取内容（仅供参考）：');
    scrapedPages.forEach((page, index) => {
      sections.push(`${index + 1}. ${truncateContextText(page.title, 120)}`);
      sections.push(`   ${truncateContextText(page.url, 240)}`);
      sections.push(`   ${truncateContextText(page.text, 600)}`);
    });
  }

  return truncateContextText(sections.join('\n').trim(), WEB_CONTEXT_LIMIT);
}

async function prepareWebContext(prompt, fetchImpl, env) {
  const text = normalizeTelegramMemoryText(prompt);
  if (!text) return '';

  const urls = extractUrlsFromText(text).slice(0, WEB_SCRAPE_LIMIT);
  const searchQuery = shouldSearchWeb(text) ? buildSearchQueryFromPrompt(text) : '';

  if (!searchQuery && urls.length === 0) {
    return '';
  }

  const [searchResults, scrapedPages] = await Promise.all([
    searchQuery ? searchWeb(fetchImpl, searchQuery, env) : Promise.resolve([]),
    urls.length > 0
      ? Promise.all(urls.map((url) => scrapeWebPage(fetchImpl, url, env))).then((pages) => pages.filter(Boolean))
      : Promise.resolve([]),
  ]);

  return buildWebContextText({
    searchQuery,
    searchResults,
    scrapedPages,
  });
}

// ── Vectorize 语义记忆搜索 ──
async function searchMemoriesWithVectorize(env, query, chatId) {
  if (!env?.WORKCLAW_VECTORIZE) return [];

  try {
    const results = await searchMemories(env, query);
    // 只返回同 chatId 的记忆
    return results.filter((r) => {
      if (!chatId) return true;
      return r.metadata?.chatId === String(chatId) || r.metadata?.source === 'global';
    }).slice(0, 3);
  } catch {
    return [];
  }
}

async function indexMemoryInVectorize(env, memory) {
  if (!env?.WORKCLAW_VECTORIZE || !memory?.text) return;

  const memoryId = `memory:${Date.now()}:${memory.id || crypto.randomUUID()}`;
  try {
    await upsertMemoryEmbedding(env, memoryId, memory.text, {
      chatId: memory.chatId || '',
      source: memory.source || 'auto',
      text: memory.text.slice(0, 500),
    });
  } catch (err) {
    console.error('[Vectorize] index memory error:', err.message);
  }
}

function normalizeTelegramMemoryText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function normalizeTelegramDisplayText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[*+-]\s+/gm, '- ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[\s([{])\*(.+?)\*(?=$|[\s)\]},.!?:;])/g, '$1$2')
    .replace(/(^|[\s([{])_(.+?)_(?=$|[\s)\]},.!?:;])/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`{1,3}(.+?)`{1,3}/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function createTelegramMemory(text, source = 'manual') {
  return {
    id: crypto.randomUUID(),
    text: normalizeTelegramMemoryText(text),
    source,
    createdAt: Date.now(),
  };
}

function normalizeTelegramMemorySnippet(text) {
  return normalizeTelegramMemoryText(text)
    .replace(/^[:：\s-]+/, '')
    .replace(/[。！？!?]+$/u, '')
    .trim();
}

function buildTelegramMemorySummaryText(memories = []) {
  const seen = new Set();
  const items = [];

  for (const memory of Array.isArray(memories) ? memories : []) {
    const text = normalizeTelegramMemorySnippet(memory?.text);
    if (!text) continue;

    const summaryText = memory?.source === 'summary'
      ? text.replace(/^历史摘要[：:]\s*/u, '')
      : text;
    const key = summaryText.toLowerCase();
    if (!summaryText || seen.has(key)) continue;

    seen.add(key);
    items.push(summaryText);
  }

  const joined = items.join('；');
  if (!joined) {
    return '历史摘要：暂无可压缩内容';
  }

  const limit = Math.max(0, TELEGRAM_MEMORY_SUMMARY_LIMIT - '历史摘要：'.length);
  const body = joined.length > limit ? `${joined.slice(0, Math.max(0, limit - 1))}…` : joined;
  return `历史摘要：${body}`;
}

function compactTelegramMemories(memories = []) {
  const items = Array.isArray(memories)
    ? memories
        .filter((memory) => memory && typeof memory.text === 'string' && normalizeTelegramMemoryText(memory.text))
        .map((memory) => ({
          ...memory,
          text: normalizeTelegramMemoryText(memory.text),
          source: typeof memory.source === 'string' && memory.source ? memory.source : 'auto',
        }))
    : [];

  if (items.length <= TELEGRAM_MEMORY_COMPACT_THRESHOLD) {
    return items;
  }

  const recent = items.slice(-TELEGRAM_MEMORY_RECENT_LIMIT);
  const older = items.slice(0, items.length - recent.length);
  const summaryText = buildTelegramMemorySummaryText(older);
  const summaryMemory = createTelegramMemory(summaryText, 'summary');
  summaryMemory.createdAt = older[0]?.createdAt ?? summaryMemory.createdAt;
  summaryMemory.id = older.find((memory) => memory.source === 'summary')?.id ?? summaryMemory.id;

  return [summaryMemory, ...recent];
}

function extractTelegramMemoryCandidates(prompt) {
  const text = normalizeTelegramMemoryText(prompt);
  if (text.length < 4) return [];

  const candidates = [];
  const seen = new Set();
  let sawLanguagePreference = false;
  const languageKeywordPattern = /(?:简体中文|繁體中文|繁体中文|中文|英文|英语|日文|日语|韩文|韩语|Japanese|English|Chinese|Mandarin)/iu;
  const addCandidate = (label, value, source = 'auto') => {
    const candidate = normalizeTelegramMemorySnippet(value);
    if (candidate.length < 2 || candidate.length > 120) return;
    if (label === '用户要求' && sawLanguagePreference && languageKeywordPattern.test(candidate)) return;

    const textValue = `${label}：${candidate}`;
    const key = textValue.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    candidates.push({ text: textValue, source });
  };

  const rules = [
    { label: '用户名字', patterns: [/^(?:我叫|我的名字是|叫我)\s*(.+)$/iu] },
    { label: '用户偏好', patterns: [/^(?:我喜欢|我偏好|我更喜欢|我常用|我习惯)\s*(.+)$/iu] },
    { label: '用户不喜欢', patterns: [/^(?:我不喜欢|我讨厌|我不想|我不要|别用)\s*(.+)$/iu] },
    { label: '用户所在地', patterns: [/^(?:我住在|我来自)\s*(.+)$/iu] },
    { label: '用户工作内容', patterns: [/^(?:我正在|我在做|我做|我开发|我负责|我从事)\s*(.+)$/iu] },
    { label: '用户联系方式', patterns: [/^(?:我的)?(?:邮箱|邮件|电话|手机号|微信|地址|时区|生日)\s*(?:是|为|：|:)?\s*(.+)$/iu] },
    {
      label: '用户语言偏好',
      patterns: [
        /^(?:以后|今后|默认|请以后|以后请|从现在开始).*?(?:用|使用|回复|写|输出|说)\s*(简体中文|繁體中文|繁体中文|中文|英文|英语|日文|日语|韩文|韩语|Japanese|English|Chinese|Mandarin)(?:\s*(?:回复|输出|写|回答|答复|说))?$/iu,
        /^(?:我的)?(?:首选|默认)?语言(?:是|为|：|:)?\s*(简体中文|繁體中文|繁体中文|中文|英文|英语|日文|日语|韩文|韩语|Japanese|English|Chinese|Mandarin)$/iu,
      ],
      transform: (match) => match[1],
    },
    { label: '用户要求', patterns: [/^(?:以后|今后|默认|请以后|以后请|从现在开始)(?:都)?(?:用|使用|回复|写|输出|说)?\s*(.+)$/iu] },
    { label: '用户要求', patterns: [/^(?:请|帮我|麻烦)?(?:记住|长期记住|长期记忆)\s*[:：]?\s*(.+)$/iu] },
  ];

  for (const rule of rules) {
    for (const regex of rule.patterns) {
      const match = text.match(regex);
      if (!match) continue;

      const value = typeof rule.transform === 'function' ? rule.transform(match) : match[1];
      addCandidate(rule.label, value);
      if (rule.label === '用户语言偏好') {
        sawLanguagePreference = true;
      }
    }
  }

  return candidates;
}

async function captureAutomaticTelegramMemories(session, prompt, env) {
  const memoryCandidates = extractTelegramMemoryCandidates(prompt);
  if (memoryCandidates.length === 0) return [];

  const existing = Array.isArray(session.memories) ? session.memories.slice() : [];
  const seen = new Set(existing.map((memory) => normalizeTelegramMemoryText(memory?.text).toLowerCase()));
  const created = [];

  for (const candidate of memoryCandidates) {
    const key = candidate.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const memory = createTelegramMemory(candidate.text, candidate.source);
    memory.chatId = session.chatId;
    existing.push(memory);
    created.push(memory);
  }

  session.memories = compactTelegramMemories(existing);

  // 异步索引到 Vectorize
  if (env?.WORKCLAW_VECTORIZE) {
    for (const memory of created) {
      await indexMemoryInVectorize(env, memory).catch(() => {});
    }
  }

  return created;
}

function trimTelegramHistory(history, maxItems = 12) {
  if (!Array.isArray(history) || history.length <= maxItems) return Array.isArray(history) ? history : [];
  return history.slice(history.length - maxItems);
}

function createTelegramSessionState() {
  return {
    chatId: null,
    history: [],
    memories: [],
    todos: [],
    reminders: [],
    watches: [],
    mode: 'normal',
    lastPrompt: '',
    lastReply: '',
  };
}

async function loadTelegramSession(storage) {
  if (!storage) return createTelegramSessionState();
  const session = await storage.get('telegram-session');
  if (!session || typeof session !== 'object') return createTelegramSessionState();
  return {
    chatId: typeof session.chatId === 'number' || typeof session.chatId === 'string' ? session.chatId : null,
    history: Array.isArray(session.history) ? session.history : [],
    memories: compactTelegramMemories(Array.isArray(session.memories) ? session.memories : []),
    todos: compactTelegramTodos(Array.isArray(session.todos) ? session.todos : []),
    reminders: compactTelegramReminders(Array.isArray(session.reminders) ? session.reminders : []),
    watches: compactTelegramWatches(Array.isArray(session.watches) ? session.watches : []),
    mode: normalizeTelegramMode(session.mode) || 'normal',
    lastPrompt: typeof session.lastPrompt === 'string' ? session.lastPrompt : '',
    lastReply: typeof session.lastReply === 'string' ? session.lastReply : '',
  };
}

async function saveTelegramSession(storage, session) {
  if (!storage) return;
  const payload = {
    chatId: typeof session?.chatId === 'number' || typeof session?.chatId === 'string' ? session.chatId : null,
    history: trimTelegramHistory(Array.isArray(session?.history) ? session.history : []),
    memories: compactTelegramMemories(Array.isArray(session?.memories) ? session.memories : []),
    todos: compactTelegramTodos(Array.isArray(session?.todos) ? session.todos : []),
    reminders: compactTelegramReminders(Array.isArray(session?.reminders) ? session.reminders : []),
    watches: compactTelegramWatches(Array.isArray(session?.watches) ? session.watches : []),
    mode: normalizeTelegramMode(session?.mode) || 'normal',
    lastPrompt: typeof session?.lastPrompt === 'string' ? session.lastPrompt : '',
    lastReply: typeof session?.lastReply === 'string' ? session.lastReply : '',
  };

  if (session && typeof session === 'object') {
    session.chatId = payload.chatId;
    session.history = payload.history;
    session.memories = payload.memories;
    session.todos = payload.todos;
    session.reminders = payload.reminders;
    session.watches = payload.watches;
    session.mode = payload.mode;
    session.lastPrompt = payload.lastPrompt;
    session.lastReply = payload.lastReply;
  }

  await storage.put('telegram-session', payload);
}

async function resetTelegramConversation(session) {
  session.history = [];
  session.lastPrompt = '';
  session.lastReply = '';
  await saveTelegramSession(session.storage, session);
}

async function callTelegramBotApi(env, fetchImpl, method, payload) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with ${response.status}`);
  }

  return body;
}

async function sendTelegramMessage(env, fetchImpl, chatId, text, extra = {}) {
  return callTelegramBotApi(env, fetchImpl, 'sendMessage', {
    chat_id: chatId,
    text: normalizeTelegramDisplayText(text),
    ...extra,
  });
}

async function editTelegramMessage(env, fetchImpl, chatId, messageId, text, extra = {}) {
  return callTelegramBotApi(env, fetchImpl, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: normalizeTelegramDisplayText(text),
    ...extra,
  });
}

async function answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, text, extra = {}) {
  return callTelegramBotApi(env, fetchImpl, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    ...extra,
  });
}

async function sendTelegramChatAction(env, fetchImpl, chatId, action = 'typing') {
  return callTelegramBotApi(env, fetchImpl, 'sendChatAction', {
    chat_id: chatId,
    action,
  });
}

function getLatestUserMessage(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      const text = getMessageText(message);
      if (text) return text;
    }
  }
  return '';
}

function splitTextForStreaming(text) {
  const chunks = String(text || '').match(/\S+\s*/g);
  return chunks && chunks.length > 0 ? chunks : text ? [String(text)] : [''];
}

function shouldEditTelegramStream(rendered, lastEdited) {
  return String(rendered || '').length - String(lastEdited || '').length >= TELEGRAM_STREAM_EDIT_MIN_CHARS;
}

function buildLocalReply(prompt) {
  // ponytail: local echo fallback; replace with a real provider when OPENAI_BASE_URL is not set.
  return prompt ? `workclaw: ${prompt}` : 'workclaw is ready.';
}

function buildChatCompletionsResponse({ model, content }) {
  return json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}

function buildChatCompletionChunk({ id, model, created, delta, finishReason }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        ...(finishReason ? { finish_reason: finishReason } : {}),
      },
    ],
  };
}

function buildChatCompletionsStreamResponse({ model, content }) {
  // Source: https://developers.openai.com/api/docs/guides/streaming-responses
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const chunks = splitTextForStreaming(content);

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(buildChatCompletionChunk({
          id,
          model,
          created,
          delta: { role: 'assistant' },
        }))}\n\n`),
      );

      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(buildChatCompletionChunk({
            id,
            model,
            created,
            delta: { content: chunk },
          }))}\n\n`),
        );
      }

      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(buildChatCompletionChunk({
          id,
          model,
          created,
          delta: {},
          finishReason: 'stop',
        }))}\n\n`),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: OPENAI_STREAM_HEADERS,
  });
}

function buildModelsResponse(model) {
  return json({
    object: 'list',
    data: [
      {
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'workclaw',
      },
    ],
  });
}

async function proxyOpenAIRequest(request, env, fetchImpl) {
  const upstream = resolveUpstreamUrl(getOpenAIBaseUrl(env), new URL(request.url));
  const headers = new Headers(request.headers);
  headers.delete('authorization');

  if (env?.OPENAI_API_KEY) {
    headers.set('authorization', `Bearer ${env.OPENAI_API_KEY}`);
  }

  const init = {
    method: request.method,
    headers,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  return fetchImpl(new Request(upstream, init));
}

async function generateConversationReply(messages, env, fetchImpl) {
  const baseUrl = getOpenAIBaseUrl(env);
  const prompt = getLatestUserMessage(messages);
  if (!baseUrl) return buildLocalReply(prompt);

  const upstream = resolveUpstreamUrl(baseUrl, new URL('/v1/chat/completions', baseUrl));
  const model = getConfiguredModel(env);
  const response = await fetchImpl(upstream, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env?.OPENAI_API_KEY ? { authorization: `Bearer ${env.OPENAI_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI upstream failed with ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? '';
  return typeof content === 'string' && content.trim() ? content : buildLocalReply(prompt);
}

async function generateReply(prompt, env, fetchImpl) {
  const baseUrl = getOpenAIBaseUrl(env);
  if (!baseUrl && !env?.WORKCLAW_AI) {
    return buildLocalReply(prompt);
  }

  const webContext = await prepareWebContext(prompt, fetchImpl, env);
  const messages = buildTelegramConversationMessages([{ role: 'user', content: prompt }], [], webContext);

  // 优先使用上游 API
  if (baseUrl) {
    return generateConversationReply(messages, env, fetchImpl);
  }

  // 回退到 Workers AI
  if (env?.WORKCLAW_AI) {
    try {
      const systemMsg = CLAW_SYSTEM_MESSAGE || { role: 'system', content: '你是一个友好的 AI 助手。' };
      const aiMessages = [systemMsg, ...messages];
      return await generateWithAI(aiMessages, env, { model: getConfiguredModel(env), temperature: 0.7 });
    } catch (err) {
      console.error('[AI Inference] error:', err.message);
      return buildLocalReply(prompt);
    }
  }

  return buildLocalReply(prompt);
}

async function streamConversationReply(messages, env, fetchImpl, onText) {
  const baseUrl = getOpenAIBaseUrl(env);
  const prompt = getLatestUserMessage(messages);

  if (!baseUrl && !env?.WORKCLAW_AI) {
    const content = buildLocalReply(prompt);
    let rendered = '';
    for (const chunk of splitTextForStreaming(content)) {
      rendered += chunk;
      await onText(rendered, chunk);
    }
    return content;
  }

  // 优先使用上游 API 流式
  if (baseUrl) {
    const upstream = resolveUpstreamUrl(baseUrl, new URL('/v1/chat/completions', baseUrl));
    const model = getConfiguredModel(env);
    const response = await fetchImpl(upstream, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env?.OPENAI_API_KEY ? { authorization: `Bearer ${env.OPENAI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      return generateConversationReply(messages, env, fetchImpl);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let rendered = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let frameIndex = buffer.indexOf('\n\n');

      while (frameIndex !== -1) {
        const frame = buffer.slice(0, frameIndex).trim();
        buffer = buffer.slice(frameIndex + 2);
        frameIndex = buffer.indexOf('\n\n');

        if (!frame) continue;

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();
          if (data === '[DONE]') return rendered || buildLocalReply(prompt);

          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }

          const delta = payload?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            rendered += delta;
            await onText(rendered, delta);
          }
        }
      }
    }

    return rendered || generateConversationReply(messages, env, fetchImpl);
  }

  // 回退到 Workers AI (非流式)
  if (env?.WORKCLAW_AI) {
    try {
      const systemMsg = CLAW_SYSTEM_MESSAGE || { role: 'system', content: '你是一个友好的 AI 助手。' };
      const aiMessages = [systemMsg, ...messages];
      const content = await generateWithAI(aiMessages, env, { model: getConfiguredModel(env), temperature: 0.7 });
      let rendered = '';
      for (const chunk of splitTextForStreaming(content)) {
        rendered += chunk;
        await onText(rendered, chunk);
      }
      return rendered || buildLocalReply(prompt);
    } catch (err) {
      console.error('[AI Stream] error:', err.message);
    }
  }

  const content = buildLocalReply(prompt);
  let rendered = '';
  for (const chunk of splitTextForStreaming(content)) {
    rendered += chunk;
    await onText(rendered, chunk);
  }
  return content;
}

function getTelegramMessage(update) {
  const message =
    update?.message ||
    update?.edited_message ||
    update?.channel_post ||
    update?.callback_query?.message;

  return {
    chatId: message?.chat?.id,
    text: getTelegramText(message),
  };
}

async function streamTelegramReply(env, fetchImpl, chatId, messageId, messages, fallbackPrompt, extra = {}, memories = [], webContext = '', sessionContext = {}) {
  let lastRendered = '';
  let lastEdited = '';

  const conversationMessages = buildTelegramConversationMessages(messages, memories, webContext, sessionContext);
  const finalText = await streamConversationReply(conversationMessages, env, fetchImpl, async (rendered) => {
    lastRendered = rendered;
    if (messageId && shouldEditTelegramStream(rendered, lastEdited)) {
      await editTelegramMessage(env, fetchImpl, chatId, messageId, rendered, extra);
      lastEdited = rendered;
    }
  });

  const replyText = finalText || lastRendered || buildLocalReply(fallbackPrompt);
  if (!messageId) {
    await sendTelegramMessage(env, fetchImpl, chatId, replyText, extra);
  } else if (replyText !== lastEdited) {
    await editTelegramMessage(env, fetchImpl, chatId, messageId, replyText, extra);
  }

  return replyText;
}

async function generateAndStreamTelegramReply({ update, session, env, fetchImpl }) {
  const chatId = getTelegramChatId(update);
  if (chatId === null) {
    return json({ ok: true, ignored: true });
  }

  session.chatId = chatId;
  const commandText = getTelegramText(update?.message || update?.edited_message || update?.channel_post);
  const command = parseTelegramCommand(commandText);
  const replyMarkup = { reply_markup: buildTelegramReplyMarkup() };

  if (command) {
    const handled = await handleTelegramSlashCommand({
      command,
      commandText,
      session,
      env,
      fetchImpl,
      chatId,
      replyMarkup,
    });

    if (handled) {
      return json({ ok: true, sent: true, command });
    }
  }

  if (update?.callback_query) {
    const callbackQueryId = getTelegramCallbackQueryId(update);
    const callbackData = getTelegramCallbackData(update);
    const callbackMessage = update.callback_query.message;
    const callbackMessageId = callbackMessage?.message_id;

    if (callbackData === 'help') {
      if (callbackQueryId) {
        await answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, '已打开帮助');
      }
      if (callbackMessageId) {
        await editTelegramMessage(env, fetchImpl, chatId, callbackMessageId, buildTelegramHelpText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      } else {
        await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramHelpText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      }
      return json({ ok: true, sent: true, callback: callbackData });
    }

    if (callbackData === 'reset') {
      await resetTelegramConversation(session);
      if (callbackQueryId) {
        await answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, '会话已清空');
      }
      if (callbackMessageId) {
        await editTelegramMessage(env, fetchImpl, chatId, callbackMessageId, buildTelegramResetText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      } else {
        await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramResetText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      }
      return json({ ok: true, sent: true, callback: callbackData });
    }

    if (callbackData === 'retry') {
      if (!session.lastPrompt) {
        if (callbackQueryId) {
          await answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, '还没有可重试的上一条消息');
        }
        await sendTelegramMessage(env, fetchImpl, chatId, '还没有可重试的上一条消息。', {
          reply_markup: buildTelegramReplyMarkup(),
        });
        return json({ ok: true, sent: true, callback: callbackData, empty: true });
      }

      if (callbackQueryId) {
        await answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, '正在重新生成...');
      }
      if (callbackMessageId) {
        await editTelegramMessage(env, fetchImpl, chatId, callbackMessageId, buildTelegramThinkingText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      }

      const history = trimTelegramHistory(session.history.slice());
      if (history[history.length - 1]?.role === 'assistant') {
        history.pop();
      }
      const webContext = await prepareWebContext(session.lastPrompt, fetchImpl, env);
      const replyText = await streamTelegramReply(
        env,
        fetchImpl,
        chatId,
        callbackMessageId,
        history,
        session.lastPrompt,
        {
          reply_markup: buildTelegramReplyMarkup(),
        },
        session.memories,
        webContext,
        session,
      );

      session.history = trimTelegramHistory([...history, { role: 'assistant', content: replyText }]);
      session.lastReply = replyText;
      await saveTelegramSession(session.storage, session);
      await sendTelegramProactiveFollowUp({
        env,
        fetchImpl,
        chatId,
        prompt: session.lastPrompt,
        replyText,
      });
      return json({ ok: true, sent: true, callback: callbackData, retried: true });
    }
  }

  const text = getTelegramText(update?.message || update?.edited_message || update?.channel_post || update?.callback_query?.message);
  const prompt = text.trim();
  if (!prompt) {
    return json({ ok: true, ignored: true });
  }

  session.history.push({ role: 'user', content: prompt });
  session.history = trimTelegramHistory(session.history);
  session.lastPrompt = prompt;
  await captureAutomaticTelegramMemories(session, prompt, env);
  await saveTelegramSession(session.storage, session);

  const webContextPromise = prepareWebContext(prompt, fetchImpl, env);
  await sendTelegramChatAction(env, fetchImpl, chatId, 'typing');
  const placeholder = await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramThinkingText(), {
    reply_markup: buildTelegramReplyMarkup(),
  });
  const placeholderMessageId = placeholder?.result?.message_id;
  const webContext = await webContextPromise;

  const replyText = await streamTelegramReply(
    env,
    fetchImpl,
    chatId,
    placeholderMessageId,
    session.history,
    prompt,
    {
      reply_markup: buildTelegramReplyMarkup(),
    },
    session.memories,
    webContext,
    session,
  );

  session.history.push({ role: 'assistant', content: replyText });
  session.history = trimTelegramHistory(session.history);
  session.lastReply = replyText;
  await saveTelegramSession(session.storage, session);
  await sendTelegramProactiveFollowUp({
    env,
    fetchImpl,
    chatId,
    prompt,
    replyText,
  });

  return json({ ok: true, sent: true });
}

// ── Cron 调度入口 ──
// 注意: 每会话的定时任务（提醒/监控/记忆整理）由 TelegramSession.alarm() 处理，
//       DO 在存储 alarm 时会自动唤醒执行。此处仅处理全局任务。
async function handleCronDispatch(env, ctx) {
  const now = Date.now();
  const minute = new Date(now).getMinutes();

  // 每小时: 清理过期 Vectorize 记忆 (保留 30 天)
  if (minute === 0) {
    if (env?.WORKCLAW_VECTORIZE) {
      const deleted = await deleteExpiredMemories(env, 30 * 24 * 60 * 60 * 1000);
      console.log(`[Vectorize] Cleaned up ${deleted} expired memory embeddings`);
    }
  }

  return json({
    ok: true,
    triggeredAt: new Date(now).toISOString(),
    tasks: ['vectorize-cleanup'],
  });
}

// ── 状态 API (供 Pages 仪表盘使用) ──
async function handleStatusApi(env) {
  const cacheInfo = env?.WORKCLAW_CACHE
    ? { bound: true }
    : { bound: false };
  const r2Info = env?.WORKCLAW_ASSETS
    ? { bound: true }
    : { bound: false };
  const aiInfo = env?.WORKCLAW_AI
    ? { bound: true, models: ['@cf/meta/llama-3.1-8b-instruct'] }
    : { bound: false };
  const vectorizeInfo = env?.WORKCLAW_VECTORIZE
    ? { bound: true, index: 'workclaw-memories' }
    : { bound: false };

  return json({
    name: 'workclaw',
    version: '1.0.0',
    status: 'running',
    env: env?.CLAW_ENV || 'development',
    timestamp: new Date().toISOString(),
    resources: {
      cache: cacheInfo,
      r2: r2Info,
      ai: aiInfo,
      vectorize: vectorizeInfo,
      durableObjects: { bound: true, class: 'TelegramSession' },
    },
    features: [
      'telegram-webhook',
      'openai-compatible-api',
      'streaming',
      'web-search',
      'web-scrape',
      'long-term-memory',
      'todos',
      'reminders',
      'watch',
      'mode-switching',
      'kv-cache',
      'r2-storage',
      'ai-inference',
      'vectorize-search',
      'cron-triggers',
    ],
  });
}

// ── DOOM ──

async function handleTelegramWebhook(request, env, ctx, fetchImpl) {
  if (request.method !== 'POST') return methodNotAllowed('POST');

  const secret = getSecretText(env?.TELEGRAM_WEBHOOK_SECRET);
  if (!secret) {
    return json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET is required' }, { status: 500 });
  }

  if (!(await timingSafeEqualText(request.headers.get('x-telegram-bot-api-secret-token') || '', secret))) {
    return json({ ok: false, error: 'invalid secret token' }, { status: 401 });
  }

  const update = await request.json().catch(() => null);
  if (!update) {
    return json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const chatId = getTelegramChatId(update);
  if (chatId === undefined || chatId === null) {
    return json({ ok: true, ignored: true });
  }

  if (!env?.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is required' }, { status: 500 });
  }

  const sessionBinding = env?.TELEGRAM_SESSION;
  if (sessionBinding?.idFromName && sessionBinding?.get) {
    const sessionStub = sessionBinding.get(sessionBinding.idFromName(String(chatId)));
    const task = sessionStub
      .fetch('https://telegram-session.local/update', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(update),
      })
      .catch((error) => {
        console.error('TelegramSession failed', error);
      });

    if (typeof ctx?.waitUntil === 'function') {
      ctx.waitUntil(task);
    }

    return json({ ok: true, queued: true });
  }

  const { text } = getTelegramMessage(update);
  if (!text) {
    return json({ ok: true, ignored: true });
  }

  const command = parseTelegramCommand(text);
  if (command) {
    await handleTelegramSlashCommand({
      command,
      commandText: text,
      env,
      fetchImpl,
      chatId,
      replyMarkup: { reply_markup: buildTelegramReplyMarkup() },
    });
    return json({ ok: true, sent: true, command });
  }

  const reply = await generateReply(text, env, fetchImpl);
  await sendTelegramMessage(env, fetchImpl, chatId, reply);
  await sendTelegramProactiveFollowUp({
    env,
    fetchImpl,
    chatId,
    prompt: text,
    replyText: reply,
  });

  return json({ ok: true, sent: true });
}

export class TelegramSession {
  constructor(state, env, fetchImpl = fetch) {
    this.state = state;
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  async fetch(request) {
    if (request.method !== 'POST') return methodNotAllowed('POST');

    const update = await request.json().catch(() => null);
    if (!update) {
      return json({ ok: false, error: 'invalid json' }, { status: 400 });
    }

    const session = await loadTelegramSession(this.state.storage);
    session.storage = this.state.storage;
    const response = await generateAndStreamTelegramReply({
      update,
      session,
      env: this.env,
      fetchImpl: this.fetchImpl,
    });
    delete session.storage;
    return response;
  }

  async alarm() {
    const session = await loadTelegramSession(this.state.storage);
    session.storage = this.state.storage;
    try {
      await runTelegramAlarmTask('reminders', () => deliverDueTelegramReminders(session, this.env, this.fetchImpl));
      await runTelegramAlarmTask('watches', () => deliverDueTelegramWatches(session, this.env, this.fetchImpl));
      await scheduleTelegramReminderAlarm(session);
    } finally {
      delete session.storage;
    }
  }
}

// ── OpenAI 兼容接口 ──

async function handleChatCompletions(request, env, fetchImpl) {
  if (request.method !== 'POST') return methodNotAllowed('POST');

  const payload = await request.json().catch(() => null);
  if (!payload) {
    return json({ error: { message: 'invalid json' } }, { status: 400 });
  }

  const model = typeof payload.model === 'string' && payload.model ? payload.model : getConfiguredModel(env);

  if (getOpenAIBaseUrl(env)) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const prompt = getLatestUserMessage(messages);
    const webContext = await prepareWebContext(prompt, fetchImpl, env);
    const augmentedMessages = buildTelegramConversationMessages(messages, [], webContext);
    const upstream = resolveUpstreamUrl(getOpenAIBaseUrl(env), new URL('/v1/chat/completions', getOpenAIBaseUrl(env)));
    const headers = new Headers(request.headers);
    headers.delete('authorization');

    if (env?.OPENAI_API_KEY) {
      headers.set('authorization', `Bearer ${env.OPENAI_API_KEY}`);
    }

    headers.set('content-type', 'application/json');
    const response = await fetchImpl(upstream, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...payload,
        model,
        messages: augmentedMessages,
      }),
    });

    return response;
  }

  // 本地/AI 兜底
  const prompt = getLatestUserMessage(Array.isArray(payload.messages) ? payload.messages : []);
  let content;

  if (env?.WORKCLAW_AI) {
    try {
      content = await generateWithAI(
        [{ role: 'system', content: CLAW_SYSTEM_PROMPT || '你是一个友好的助手。' }, ...payload.messages],
        env,
        { model, stream: false, temperature: 0.7 }
      );
    } catch {
      content = buildLocalReply(prompt);
    }
  } else {
    content = buildLocalReply(prompt);
  }

  if (payload.stream) {
    return buildChatCompletionsStreamResponse({ model, content });
  }

  return buildChatCompletionsResponse({ model, content });
}

async function handleModels(request, env, fetchImpl) {
  if (request.method !== 'GET') return methodNotAllowed('GET');

  if (getOpenAIBaseUrl(env)) {
    return proxyOpenAIRequest(request, env, fetchImpl);
  }

  return buildModelsResponse(getConfiguredModel(env));
}

// ── 主路由 ──

async function handleRequest(request, env = {}, ctx = {}, fetchImpl = fetch) {
  const path = getPath(request);

  if (path === '/' || path === '/health') {
    return json({
      name: 'workclaw',
      status: 'ok',
    });
  }

  if (path === '/telegram/webhook') {
    return handleTelegramWebhook(request, env, ctx, fetchImpl);
  }

  if (path === '/v1/chat/completions') {
    const authResponse = await authorizeOpenAIRequest(request, env);
    if (authResponse) return authResponse;
    return handleChatCompletions(request, env, fetchImpl);
  }

  if (path === '/v1/models' || path.startsWith('/v1/models/')) {
    const authResponse = await authorizeOpenAIRequest(request, env);
    if (authResponse) return authResponse;
    return handleModels(request, env, fetchImpl);
  }

  // Cron 入口
  if (path === '/cron/dispatch') {
    return handleCronDispatch(env, ctx);
  }

  // 状态 API (Pages 仪表盘)
  if (path === '/api/status') {
    return handleStatusApi(env);
  }

  return notFound();
}

export { handleRequest };

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
