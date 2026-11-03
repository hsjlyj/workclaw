import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramSession, handleRequest } from '../src/index.js';

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  let alarm = null;

  return {
    async get(key) {
      return data.has(key) ? data.get(key) : undefined;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async setAlarm(time) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = null;
    },
    async getAlarm() {
      return alarm;
    },
  };
}

function getCall(calls, suffix) {
  return calls.find((call) => String(call.input).endsWith(suffix));
}

test('responds with a JSON health payload', async () => {
  const response = await handleRequest(new Request('https://example.com/'), {}, {}, async () => {
    throw new Error('fetch should not be called');
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await response.json(), {
    name: "workclaw",
    status: 'ok',
  });
});

test('returns an OpenAI-compatible chat completion response', async () => {
  const response = await handleRequest(
    new Request('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'demo-model',
        messages: [
          { role: 'system', content: 'ignore' },
          { role: 'user', content: 'hello' },
        ],
      }),
    }),
    {},
    {},
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.model, 'demo-model');
  assert.equal(payload.choices[0].message.role, 'assistant');
  assert.equal(payload.choices[0].message.content, 'workclaw: hello');
});

test('returns a streaming OpenAI-compatible chat completion response', async () => {
  const response = await handleRequest(
    new Request('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'demo-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
    {},
    {},
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const text = await response.text();
  assert.match(text, /"object":"chat\.completion\.chunk"/);
  assert.match(text, /"role":"assistant"/);
  assert.match(text, /"content":"workclaw: "/);
  assert.match(text, /"content":"hello"/);
  assert.match(text, /data: \[DONE\]/);
});

test('returns upstream OpenAI-compatible chat completions with web context injected', async () => {
  const upstreamBodies = [];
  const upstreamAuthHeaders = [];

  const response = await handleRequest(
    new Request('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer client-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'demo-model',
        stream: true,
        messages: [
          { role: 'user', content: '搜索 Cloudflare Workers 文档 https://example.com/docs' },
        ],
      }),
    }),
    {
      CLAW_API_KEY: 'client-secret',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
      OPENAI_API_KEY: 'upstream-secret',
    },
    {},
    async (input, init) => {
      const url = String(input);

      if (url.includes('html.duckduckgo.com/html/')) {
        return new Response(
          '<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fdevelopers.cloudflare.com%2Fworkers%2F">Cloudflare Workers Docs</a></div>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          },
        );
      }

      if (url === 'https://example.com/docs') {
        return new Response(
          '<html><head><title>Example Docs</title></head><body><h1>Example Docs</h1><p>抓取内容</p></body></html>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          },
        );
      }

      if (url.startsWith('https://upstream.example/')) {
        upstreamBodies.push(JSON.parse(init.body));
        upstreamAuthHeaders.push(new Headers(init.headers).get('authorization'));
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"workclaw: "}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"search"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.deepEqual(upstreamAuthHeaders, ['Bearer upstream-secret']);
  assert.equal(upstreamBodies[0].messages[0].role, 'system');
  assert.match(upstreamBodies[0].messages[0].content, /幽默风趣的男高中生/);
  assert.match(upstreamBodies[0].messages[0].content, /主要入口是 Telegram/);
  assert.match(upstreamBodies[0].messages[1].content, /网络搜索结果/);
  assert.match(upstreamBodies[0].messages[1].content, /Cloudflare Workers Docs/);
  assert.match(upstreamBodies[0].messages[1].content, /网页抓取内容/);
  assert.match(upstreamBodies[0].messages[1].content, /Example Docs/);
  assert.equal(upstreamBodies[0].messages.at(-1).role, 'user');
  assert.match(upstreamBodies[0].messages.at(-1).content, /搜索 Cloudflare Workers 文档/);
});

test('requires a client API key before proxying upstream OpenAI-compatible requests', async () => {
  const response = await handleRequest(
    new Request('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'demo-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
    {
      CLAW_API_KEY: 'client-secret',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    {},
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      message: 'unauthorized',
    },
  });
});

test('fails closed when upstream OpenAI-compatible requests have no client API key configured', async () => {
  const response = await handleRequest(
    new Request('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'demo-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
    {
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    {},
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: {
      message: 'CLAW_API_KEY is required',
    },
  });
});

test('returns a local OpenAI-compatible model list', async () => {
  const response = await handleRequest(new Request('https://example.com/v1/models'), {}, {}, async () => {
    throw new Error('fetch should not be called');
  });

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.object, 'list');
  assert.equal(payload.data[0].id, 'workclaw-mini');
});

test('rejects telegram webhook requests when the secret token is not configured', async () => {
  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 1 },
          text: 'ping',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
    {},
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'TELEGRAM_WEBHOOK_SECRET is required',
  });
});

test('rejects telegram webhook requests with the wrong secret token', async () => {
  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 1 },
          text: 'ping',
        },
      }),
    }),
    {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    },
    {},
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'invalid secret token',
  });
});

test('sends a telegram reply through the Bot API', async () => {
  const calls = [];

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    },
    {},
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.telegram.org/botbot-token/sendMessage');
  assert.equal(calls[0].init.method, 'POST');

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    chat_id: 42,
    text: 'workclaw: ping',
  });
});

test('telegram webhook injects soul.md before upstream replies when no DO is configured', async () => {
  const telegramCalls = [];
  const upstreamBodies = [];

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    {},
    async (input, init) => {
      const url = String(input);

      if (url.startsWith('https://upstream.example/')) {
        upstreamBodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'workclaw: ping' } }],
          }),
          {
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      telegramCalls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.equal(upstreamBodies[0].messages[0].role, 'system');
  assert.match(upstreamBodies[0].messages[0].content, /幽默风趣的男高中生/);
  assert.match(upstreamBodies[0].messages[0].content, /优先利用 Cloudflare 免费层可用的存储能力/);
  assert.equal(upstreamBodies[0].messages.at(-1).role, 'user');
  assert.equal(upstreamBodies[0].messages.at(-1).content, 'ping');

  assert.equal(telegramCalls.length, 1);
  assert.equal(telegramCalls[0].input, 'https://api.telegram.org/botbot-token/sendMessage');

  const body = JSON.parse(telegramCalls[0].init.body);
  assert.equal(body.chat_id, 42);
  assert.equal(body.text, 'workclaw: ping');
});

test('queues telegram updates to a Durable Object when configured', async () => {
  const calls = [];
  let waited = null;

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_SESSION: {
        idFromName(value) {
          return `session:${value}`;
        },
        get() {
          return {
            async fetch(input, init) {
              calls.push({ input, init });
              return new Response(JSON.stringify({ ok: true }), {
                headers: {
                  'content-type': 'application/json',
                },
              });
            },
          };
        },
      },
    },
    {
      waitUntil(promise) {
        waited = promise;
      },
    },
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://telegram-session.local/update');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    message: {
      chat: { id: 42 },
      text: 'ping',
    },
  });

  await waited;
});

test('TelegramSession sends a help panel for /start', async () => {
  const calls = [];
  const session = new TelegramSession(
    { storage: createStorage() },
    { TELEGRAM_BOT_TOKEN: 'bot-token' },
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/start',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.telegram.org/botbot-token/sendMessage');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, 42);
  assert.match(body.text, /发送消息/);
  assert.match(body.text, /\/todo - 管理待办事项/);
  assert.match(body.text, /\/remind - 管理提醒任务/);
  assert.match(body.text, /\/watch - 管理网页监控/);
  assert.match(body.text, /\/mode - 查看或切换运行模式/);
  assert.match(body.text, /\/summary - 查看或压缩近期摘要/);
  assert.doesNotMatch(body.text, /长期记忆/);
  assert.doesNotMatch(body.text, /\/remember/);
  assert.doesNotMatch(body.text, /\/memories/);
  assert.doesNotMatch(body.text, /\/forget/);
  assert.match(body.text, /\/reset - 清空当前会话/);
  assert.deepEqual(
    body.reply_markup.inline_keyboard.flat().map((button) => button.text),
    ['重试', '重置', '帮助'],
  );
  assert.deepEqual(body.reply_markup.inline_keyboard[0].map((button) => button.callback_data), [
    'retry',
    'reset',
  ]);
});

test('TelegramSession shows the current model for /model', async () => {
  const calls = [];
  const session = new TelegramSession(
    { storage: createStorage() },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      CLAW_MODEL: 'claw-pro',
    },
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/model',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.telegram.org/botbot-token/sendMessage');

  const body = JSON.parse(calls[0].init.body);
  assert.match(body.text, /当前模型：claw-pro/);
  assert.match(body.text, /回复模式：本地/);
  assert.match(body.text, /流式输出：已开启/);
});

test('TelegramSession manages /todo items and keeps them across /reset', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  let response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/todo add 买牛奶',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  let body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.chat_id, 42);
  assert.equal(body.text, '已添加待办：买牛奶');

  let stored = await storage.get('telegram-session');
  assert.deepEqual(stored.todos, ['买牛奶']);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/reset',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /会话已清空/);

  stored = await storage.get('telegram-session');
  assert.deepEqual(stored.todos, ['买牛奶']);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/todo',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /当前待办：/);
  assert.match(body.text, /1\. 买牛奶/);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/todo done 1',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.text, '已完成待办：买牛奶');

  stored = await storage.get('telegram-session');
  assert.deepEqual(stored.todos, []);
});

test('TelegramSession manages /remind items, survives /reset, and fires due alarms', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  let response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/remind 0s 喝水',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  let body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.chat_id, 42);
  assert.match(body.text, /已添加提醒：立即 · 喝水/);

  let stored = await storage.get('telegram-session');
  assert.equal(stored.chatId, 42);
  assert.equal(stored.reminders.length, 1);
  assert.equal(stored.reminders[0].text, '喝水');
  assert.equal(await storage.getAlarm() >= stored.reminders[0].dueAt, true);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/reset',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /会话已清空/);

  stored = await storage.get('telegram-session');
  assert.equal(stored.history.length, 0);
  assert.equal(stored.reminders.length, 1);
  assert.equal(await storage.getAlarm() >= stored.reminders[0].dueAt, true);

  await session.alarm();

  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /⏰ 提醒：喝水/);

  stored = await storage.get('telegram-session');
  assert.equal(stored.reminders.length, 0);
  assert.equal(await storage.getAlarm(), null);
});

test('TelegramSession manages /watch items, survives /reset, and can delete or clear them', async () => {
  const calls = [];
  const storage = createStorage();
  const pageBodies = new Map([
    ['https://example.com/alpha', '<html><head><title>Alpha</title></head><body>版本一</body></html>'],
    ['https://example.com/beta', '<html><head><title>Beta</title></head><body>版本一</body></html>'],
  ]);
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (pageBodies.has(url)) {
        return new Response(pageBodies.get(url), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
          },
        });
      }

      return new Response(JSON.stringify({ ok: true, result: { message_id: 11 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  let response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/watch add https://example.com/alpha',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  let body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.chat_id, 42);
  assert.match(body.text, /已添加网页监控：Alpha/);
  assert.match(body.text, /首次检查：\d+分钟后/);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/watch add https://example.com/beta',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /已添加网页监控：Beta/);

  let stored = await storage.get('telegram-session');
  assert.equal(stored.chatId, 42);
  assert.equal(stored.watches.length, 2);
  assert.equal(stored.watches[0].url, 'https://example.com/alpha');
  assert.equal(stored.watches[0].title, 'Alpha');
  assert.equal(stored.watches[1].url, 'https://example.com/beta');
  assert.equal(stored.watches[1].title, 'Beta');
  assert.equal(await storage.getAlarm() > Date.now(), true);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/watch',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /当前网页监控：/);
  assert.match(body.text, /Alpha/);
  assert.match(body.text, /Beta/);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/reset',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /会话已清空/);

  stored = await storage.get('telegram-session');
  assert.equal(stored.watches.length, 2);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/watch del 1',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /已删除网页监控：Alpha/);

  stored = await storage.get('telegram-session');
  assert.equal(stored.watches.length, 1);
  assert.equal(stored.watches[0].url, 'https://example.com/beta');

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/watch clear',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.text, '网页监控已清空。');

  stored = await storage.get('telegram-session');
  assert.equal(stored.watches.length, 0);
  assert.equal(await storage.getAlarm(), null);
});

test('TelegramSession sends watch change notifications on alarm', async () => {
  const calls = [];
  const storage = createStorage();
  let version = 1;
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url === 'https://example.com/watch') {
        const body = version === 1
          ? '<html><head><title>Watcher</title></head><body>版本一</body></html>'
          : '<html><head><title>Watcher</title></head><body>版本二</body></html>';
        return new Response(body, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
          },
        });
      }

      return new Response(JSON.stringify({ ok: true, result: { message_id: 12 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  let response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/watch add https://example.com/watch',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  let stored = await storage.get('telegram-session');
  assert.equal(stored.watches.length, 1);
  assert.notEqual(stored.watches[0].contentHash, '');

  stored.watches[0].nextCheckAt = Date.now() - 1000;
  await storage.put('telegram-session', stored);

  version = 2;
  await session.alarm();

  const body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /网页已变化：Watcher/);
  assert.match(body.text, /版本二/);

  stored = await storage.get('telegram-session');
  assert.equal(stored.watches.length, 1);
  assert.notEqual(stored.watches[0].contentHash, '');
  assert.equal(await storage.getAlarm() > Date.now(), true);
});

test('TelegramSession alarm keeps processing when a reminder notification fails', async () => {
  const calls = [];
  const now = Date.now();
  const storage = createStorage({
    'telegram-session': {
      chatId: 42,
      history: [],
      memories: [],
      todos: [],
      reminders: [
        {
          id: 'reminder-1',
          text: '喝水',
          dueAt: now - 1000,
          createdAt: now - 2000,
        },
      ],
      watches: [
        {
          id: 'watch-1',
          url: 'https://example.com/watch',
          label: 'Watched',
          title: 'Old',
          contentHash: 'old-hash',
          nextCheckAt: now - 1000,
          createdAt: now - 2000,
          lastCheckedAt: now - 2000,
          lastNotifiedAt: 0,
        },
      ],
      mode: 'normal',
      lastPrompt: '',
      lastReply: '',
    },
  });
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
    async (input, init) => {
      const url = String(input);

      if (url === 'https://example.com/watch') {
        return new Response('<html><head><title>Watched</title></head><body><p>new content</p></body></html>', {
          headers: {
            'content-type': 'text/html; charset=utf-8',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        const body = JSON.parse(init.body);
        calls.push(body);
        if (body.text.startsWith('⏰')) {
          return new Response(JSON.stringify({ ok: false }), { status: 500 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 12 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => {
    errors.push(args);
  };
  try {
    await session.alarm();
  } finally {
    console.error = originalConsoleError;
  }

  const stored = await storage.get('telegram-session');
  assert.equal(errors.length, 1);
  assert.equal(stored.reminders.length, 1);
  assert.equal(stored.watches.length, 1);
  assert.equal(stored.watches[0].title, 'Watched');
  assert.notEqual(stored.watches[0].contentHash, 'old-hash');
  assert(calls.some((body) => body.text.startsWith('网页已变化：Watched')));
  assert.notEqual(await storage.getAlarm(), null);
});

test('TelegramSession manages /mode and shows /summary cards', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 13 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  let response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/mode brief',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  let body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /已切换到简洁模式/);

  let stored = await storage.get('telegram-session');
  assert.equal(stored.mode, 'brief');

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '我喜欢用简体中文',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.ok(calls.some((call) => JSON.parse(call.init.body).text === '思考中...'));

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/summary',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /会话摘要卡/);
  assert.match(body.text, /当前模式：简洁/);
  assert.match(body.text, /长期记忆/);
  assert.match(body.text, /简体中文/);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/reset',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /会话已清空/);

  stored = await storage.get('telegram-session');
  assert.equal(stored.mode, 'brief');
});

test('TelegramSession compacts long-term memories with /summary compact', async () => {
  const calls = [];
  const storage = createStorage({
    'telegram-session': {
      memories: [
        { id: 'm1', text: '记忆 1', source: 'auto', createdAt: 1 },
        { id: 'm2', text: '记忆 2', source: 'auto', createdAt: 2 },
        { id: 'm3', text: '记忆 3', source: 'auto', createdAt: 3 },
        { id: 'm4', text: '记忆 4', source: 'auto', createdAt: 4 },
        { id: 'm5', text: '记忆 5', source: 'auto', createdAt: 5 },
        { id: 'm6', text: '记忆 6', source: 'auto', createdAt: 6 },
        { id: 'm7', text: '记忆 7', source: 'auto', createdAt: 7 },
        { id: 'm8', text: '记忆 8', source: 'auto', createdAt: 8 },
        { id: 'm9', text: '记忆 9', source: 'auto', createdAt: 9 },
      ],
    },
  });
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 17 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/summary compact',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  const body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /会话摘要卡/);

  const stored = await storage.get('telegram-session');
  assert.equal(stored.memories.length, 7);
  assert.equal(stored.memories[0].source, 'summary');
  assert.match(stored.memories[0].text, /历史摘要/);
});

test('TelegramSession injects /mode and summary context into upstream replies', async () => {
  const calls = [];
  const upstreamBodies = [];
  const storage = createStorage();
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.startsWith('https://upstream.example/')) {
        upstreamBodies.push(JSON.parse(init.body));
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"workclaw: "}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      return new Response(JSON.stringify({ ok: true, result: { message_id: 14 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  for (const text of ['/mode detailed', '第一条消息', '第二条消息', '第三条消息']) {
    const response = await session.fetch(
      new Request('https://example.com/update', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            chat: { id: 42 },
            text,
          },
        }),
      }),
    );

    assert.equal(response.status, 200);
  }

  assert.ok(upstreamBodies.some((body) => body.messages.some((message) => message.role === 'system' && message.content.includes('当前对话模式：详细'))));
  assert.ok(upstreamBodies.some((body) => body.messages.some((message) => message.role === 'system' && message.content.includes('会话摘要（仅供参考'))));
});

test('TelegramSession captures hidden memories and keeps them across /reset', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
      headers: {
        'content-type': 'application/json',
      },
    });
  });

  let response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '以后请用简体中文回复',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  let body = JSON.parse(getCall(calls, '/sendMessage').init.body);
  assert.equal(body.text, '思考中...');

  let stored = await storage.get('telegram-session');
  assert.equal(stored.history.length, 2);
  assert.equal(stored.memories.length, 1);
  assert.equal(stored.memories[0].source, 'auto');
  assert.equal(stored.memories[0].text, '用户语言偏好：简体中文');
  assert.equal(stored.storage, undefined);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/reset',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /会话已清空/);

  stored = await storage.get('telegram-session');
  assert.equal(stored.history.length, 0);
  assert.equal(stored.memories.length, 1);
  assert.equal(stored.memories[0].source, 'auto');
  assert.equal(stored.memories[0].text, '用户语言偏好：简体中文');
});

test('TelegramSession ignores ordinary chatter for hidden memories', async () => {
  const storage = createStorage();
  const session = new TelegramSession(
    { storage },
    { TELEGRAM_BOT_TOKEN: 'bot-token' },
    async (input, init) => {
      const url = String(input);

      if (url.endsWith('/sendChatAction')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '今天先这样，晚点再说',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);

  const stored = await storage.get('telegram-session');
  assert.equal(stored.memories.length, 0);
});

test('TelegramSession automatically compacts older memories', async () => {
  const calls = [];
  const storage = createStorage({
    'telegram-session': {
      history: [],
      memories: [
        { id: 'm-1', text: '记忆 1', source: 'manual', createdAt: 1 },
        { id: 'm-2', text: '记忆 2', source: 'manual', createdAt: 2 },
        { id: 'm-3', text: '记忆 3', source: 'manual', createdAt: 3 },
        { id: 'm-4', text: '记忆 4', source: 'manual', createdAt: 4 },
        { id: 'm-5', text: '记忆 5', source: 'manual', createdAt: 5 },
        { id: 'm-6', text: '记忆 6', source: 'manual', createdAt: 6 },
        { id: 'm-7', text: '记忆 7', source: 'manual', createdAt: 7 },
        { id: 'm-8', text: '记忆 8', source: 'manual', createdAt: 8 },
        { id: 'm-9', text: '记忆 9', source: 'manual', createdAt: 9 },
      ],
      lastPrompt: '',
      lastReply: '',
    },
  });
  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    const url = String(input);

    if (url.endsWith('/sendChatAction')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/editMessageText')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);

  const stored = await storage.get('telegram-session');
  assert.equal(stored.memories.length, 7);
  assert.equal(stored.memories[0].source, 'summary');
  assert.match(stored.memories[0].text, /历史摘要：/);
  assert.match(stored.memories[0].text, /记忆 1/);
  assert.deepEqual(
    stored.memories.slice(1).map((memory) => memory.text),
    ['记忆 4', '记忆 5', '记忆 6', '记忆 7', '记忆 8', '记忆 9'],
  );
});

test('TelegramSession injects long-term memories into upstream requests', async () => {
  const calls = [];
  const upstreamBodies = [];
  const storage = createStorage({
    'telegram-session': {
      history: [],
      memories: [
        { id: 'm-1', text: '回复时先用简体中文', source: 'manual', createdAt: 1 },
      ],
      lastPrompt: '',
      lastReply: '',
    },
  });
  const session = new TelegramSession(
    {
      storage,
    },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.startsWith('https://upstream.example/')) {
        upstreamBodies.push(JSON.parse(init.body));
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"workclaw: "}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"ping"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      if (url.endsWith('/sendChatAction')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.equal(upstreamBodies[0].stream, true);
  assert.equal(upstreamBodies[0].messages[0].role, 'system');
  assert.match(upstreamBodies[0].messages[0].content, /幽默风趣的男高中生/);
  assert.match(upstreamBodies[0].messages[0].content, /用户可见内容优先使用简体中文/);
  assert.equal(upstreamBodies[0].messages[1].role, 'system');
  assert.match(upstreamBodies[0].messages[1].content, /长期记忆/);
  assert.match(upstreamBodies[0].messages[1].content, /回复时先用简体中文/);
  assert.equal(upstreamBodies[0].messages.at(-1).role, 'user');
  assert.equal(upstreamBodies[0].messages.at(-1).content, 'ping');

  const edits = calls.filter((call) => String(call.input).endsWith('/editMessageText'));
  assert.equal(JSON.parse(edits.at(-1).init.body).text, 'workclaw: ping');
});

test('TelegramSession injects web search and scrape context into upstream requests', async () => {
  const calls = [];
  const upstreamBodies = [];
  const storage = createStorage();

  const session = new TelegramSession(
    {
      storage,
    },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.includes('html.duckduckgo.com/html/')) {
        return new Response(
          '<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fdevelopers.cloudflare.com%2Fworkers%2F">Cloudflare Workers Docs</a></div>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          },
        );
      }

      if (url === 'https://example.com/docs') {
        return new Response(
          '<html><head><title>Example Docs</title></head><body><h1>Example Docs</h1><p>抓取内容</p></body></html>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          },
        );
      }

      if (url.startsWith('https://upstream.example/')) {
        upstreamBodies.push(JSON.parse(init.body));
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"workclaw: "}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"search"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      if (url.endsWith('/sendChatAction')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '搜索 Cloudflare Workers 文档 https://example.com/docs',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.equal(upstreamBodies[0].messages[0].role, 'system');
  assert.match(upstreamBodies[0].messages[0].content, /幽默风趣的男高中生/);
  assert.match(upstreamBodies[0].messages[0].content, /主要入口是 Telegram/);
  assert.equal(upstreamBodies[0].messages[1].role, 'system');
  assert.match(upstreamBodies[0].messages[1].content, /网络搜索结果/);
  assert.match(upstreamBodies[0].messages[1].content, /Cloudflare Workers Docs/);
  assert.match(upstreamBodies[0].messages[1].content, /网页抓取内容/);
  assert.match(upstreamBodies[0].messages[1].content, /Example Docs/);
  assert.equal(upstreamBodies[0].messages.at(-1).role, 'user');
  assert.match(upstreamBodies[0].messages.at(-1).content, /搜索 Cloudflare Workers 文档/);

  assert.equal(calls.some((call) => String(call.input).includes('html.duckduckgo.com/html/')), true);
  assert.equal(calls.some((call) => String(call.input) === 'https://example.com/docs'), true);
});

test('TelegramSession streams a reply and stores the turn', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    const url = String(input);

    if (url.endsWith('/sendChatAction')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/editMessageText')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);

  const methods = calls.map((call) => String(call.input).split('/').at(-1));
  assert.deepEqual(methods.slice(0, 2), ['sendChatAction', 'sendMessage']);
  assert(methods.includes('editMessageText'));

  const sendMessage = calls.find((call) => String(call.input).endsWith('/sendMessage'));
  assert.equal(JSON.parse(sendMessage.init.body).text, '思考中...');

  const edits = calls.filter((call) => String(call.input).endsWith('/editMessageText'));
  assert.equal(JSON.parse(edits.at(-1).init.body).text, 'workclaw: ping');

  const stored = await storage.get('telegram-session');
  assert.equal(stored.lastPrompt, 'ping');
  assert.equal(stored.lastReply, 'workclaw: ping');
  assert.deepEqual(
    stored.history.map((message) => message.role),
    ['user', 'assistant'],
  );
});

test('TelegramSession sends a proactive follow-up for actionable requests', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    const url = String(input);

    if (url.endsWith('/sendChatAction')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 15 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/editMessageText')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 15 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '帮我写 README',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  const sendMessages = calls
    .filter((call) => String(call.input).endsWith('/sendMessage'))
    .map((call) => JSON.parse(call.init.body).text);

  assert.equal(sendMessages[0], '思考中...');
  assert.ok(sendMessages.some((text) => text === '要不要我顺手帮你补一版 README 结构？'));
});

test('TelegramSession sends a proactive follow-up after retrying an actionable reply', async () => {
  const calls = [];
  const storage = createStorage({
    'telegram-session': {
      history: [
        { role: 'user', content: '帮我写 README' },
        { role: 'assistant', content: 'claw: 帮我写 README' },
      ],
      lastPrompt: '帮我写 README',
      lastReply: 'claw: 帮我写 README',
    },
  });
  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    const url = String(input);

    if (url.endsWith('/answerCallbackQuery')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/editMessageText')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 15 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 16 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        callback_query: {
          id: 'callback-1',
          data: 'retry',
          from: { id: 7 },
          message: {
            chat: { id: 42 },
            message_id: 15,
            text: '思考中...',
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls[0].input, 'https://api.telegram.org/botbot-token/answerCallbackQuery');
  assert.equal(String(calls.at(-1).input).endsWith('/sendMessage'), true);
  assert.equal(JSON.parse(calls.at(-1).init.body).text, '要不要我顺手帮你补一版 README 结构？');
});

test('TelegramSession stays quiet on casual chat', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    const url = String(input);

    if (url.endsWith('/sendChatAction')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 16 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/editMessageText')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 16 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '今天先这样，晚点再说',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  const sendMessages = calls
    .filter((call) => String(call.input).endsWith('/sendMessage'))
    .map((call) => JSON.parse(call.init.body).text);

  assert.equal(sendMessages.length, 1);
  assert.equal(sendMessages[0], '思考中...');
});

test('TelegramSession streams upstream deltas into message edits', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.startsWith('https://upstream.example/')) {
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"Hel"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"lo"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":" world"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      if (url.endsWith('/sendChatAction')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);

  const edits = calls.filter((call) => String(call.input).endsWith('/editMessageText'));
  assert.equal(edits.length, 1);
  assert.equal(JSON.parse(edits[0].init.body).text, 'Hello world');

  const stored = await storage.get('telegram-session');
  assert.equal(stored.lastReply, 'Hello world');
  assert.deepEqual(
    stored.history.map((message) => message.role),
    ['user', 'assistant'],
  );
});

test('TelegramSession strips markdown markers before editing telegram messages', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.startsWith('https://upstream.example/')) {
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"# 标题\\n* 第一项\\n* 第二项"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      if (url.endsWith('/sendChatAction')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);

  const edits = calls.filter((call) => String(call.input).endsWith('/editMessageText'));
  assert(edits.length >= 1);

  const body = JSON.parse(edits.at(-1).init.body);
  assert.equal(body.text, '标题\n- 第一项\n- 第二项');
  assert.doesNotMatch(body.text, /[*#`_]/);
});

test('TelegramSession handles callback query resets', async () => {
  const calls = [];
  const storage = createStorage({
    'telegram-session': {
      history: [
        { role: 'user', content: 'ping' },
        { role: 'assistant', content: 'workclaw: ping' },
      ],
      todos: ['买牛奶'],
      lastPrompt: 'ping',
      lastReply: 'workclaw: ping',
    },
  });

  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      headers: {
        'content-type': 'application/json',
      },
    });
  });

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        callback_query: {
          id: 'callback-1',
          data: 'reset',
          from: { id: 7 },
          message: {
            chat: { id: 42 },
            message_id: 9,
            text: '思考中...',
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(String(calls[0].input).endsWith('/answerCallbackQuery'), true);
  assert.equal(String(calls[1].input).endsWith('/editMessageText'), true);

  const body = JSON.parse(calls[1].init.body);
  assert.match(body.text, /会话已清空/);
  const stored = await storage.get('telegram-session');
  assert.equal(stored.history.length, 0);
  assert.equal(stored.lastPrompt, '');
  assert.equal(stored.lastReply, '');
  assert.deepEqual(stored.todos, ['买牛奶']);
  assert.deepEqual(stored.memories, []);
});

test('telegram webhook reports /todo storage is unavailable without a DO', async () => {
  const calls = [];

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/todo add 买牛奶',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    },
    {},
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.text, '当前还没有启用待办存储。请配置 TELEGRAM_SESSION 后再使用 /todo。');
});

test('telegram webhook reports /remind storage is unavailable without a DO', async () => {
  const calls = [];

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/remind add 10m 喝水',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    },
    {},
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.text, '当前还没有启用提醒存储。请配置 TELEGRAM_SESSION 后再使用 /remind。');
});

test('telegram webhook reports /mode storage is unavailable without a DO', async () => {
  const calls = [];

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/mode brief',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    },
    {},
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.text, '当前还没有启用模式存储。请配置 TELEGRAM_SESSION 后再使用 /mode。');
});

test('telegram webhook reports /watch storage is unavailable without a DO', async () => {
  const calls = [];

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/watch add https://example.com/watch',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    },
    {},
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.text, '当前还没有启用网页监控存储。请配置 TELEGRAM_SESSION 后再使用 /watch。');
});

test('telegram webhook reports /summary storage is unavailable without a DO', async () => {
  const calls = [];

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/summary',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    },
    {},
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.text, '当前还没有启用摘要存储。请配置 TELEGRAM_SESSION 后再使用 /summary。');
});

test('telegram webhook does not fall through on unknown slash commands without a DO', async () => {
  const calls = [];

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/nonsense',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    {},
    async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://upstream.example/')) {
        throw new Error(`unexpected upstream fetch: ${url}`);
      }

      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.telegram.org/botbot-token/sendMessage');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, 42);
  assert.equal(body.text, '暂不支持 /nonsense。输入 /help 查看可用命令。');
});
