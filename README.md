# workclaw

`workclaw` 是一个部署在 **Cloudflare Workers** 上的全功能 Telegram 机器人，同时提供 **OpenAI 兼容接口**。它在 `claw` 的基础上深度整合了 Cloudflare 免费层的所有可用资源。

## 核心能力

- **Telegram 入口** — 完整的长对话、按钮交互、流式输出
- **OpenAI 兼容接口** — `GET /v1/models`、`POST /v1/chat/completions`、支持 `stream: true`
- **Workers AI 推理** — 部署后自动可用，零额外 API Key 成本
- **网络搜索与网页抓取** — DuckDuckGo 搜索 + 网页正文提取
- **隐式长期记忆** — 自动提取、压缩、合并，支持 Vectorize 语义搜索
- **多格式回复** — 流式编辑、Markdown 清理、富按钮交互
- **定时任务** — 提醒投递 / 监控检查 / 记忆整理（Cron 触发）
- **待办 / 提醒 / 网页监控 / 模式切换 / 会话摘要**

## Cloudflare 免费资源集成

| 资源 | 用途 | 免费层配额 |
|------|------|-----------|
| **Durable Objects + SQLite** | 每个聊天会话的持久化状态 | 100K 请求/天 |
| **KV** | 搜索结果 / 网页抓取缓存 | 100K 读取/天 |
| **R2** | 网页快照 / 超长会话归档 | 10GB 存储 |
| **Workers AI** | 边缘推理 (Llama/BGE) | 10K neurons/天 |
| **Vectorize** | 语义记忆向量搜索 | 100K 查询/天 |
| **Cron Triggers** | 定时检查提醒和监控 | 3 个 Cron |
| **Pages** | 状态仪表盘 | 500 次构建/天 |

## 项目结构

```
workclaw/
├── public/
│   └── index.html                    # Pages 状态仪表盘
├── scripts/
│   └── generate-workclaw-prompts.mjs # 提示文件生成脚本
├── src/
│   ├── index.js                      # Worker 主入口 (路由 + Telegram + OpenAI)
│   ├── kv-cache.js                   # KV 缓存层 (搜索/抓取结果透明缓存)
│   ├── r2-storage.js                 # R2 对象存储层 (网页快照/上下文归档)
│   ├── ai-inference.js               # Workers AI 推理 + 摘要 + Embedding
│   ├── vectorize-search.js           # Vectorize 语义记忆搜索
│   └── generated/
│       └── claw-prompts.js           # (自动生成) 系统提示
├── test/
│   └── worker.test.js                # 核心行为测试
├── wrangler.jsonc                    # Cloudflare Workers 配置
├── package.json
├── soul.md                           # 人格设定
├── user.md                           # 用户偏好
├── .env.example                      # 环境变量示例
└── README.md
```

## 架构概览

```
                      ┌─────────────────────────────────────┐
                      │         Cloudflare Worker            │
                      │                                       │
  Telegram ──────────▶│  /telegram/webhook                    │
  OpenAI   ──────────▶│  /v1/chat/completions                 │
  Clients  ──────────▶│  /v1/models                           │
                      │  /cron/dispatch  (每5分钟)             │
                      │  /api/status      (Pages 仪表盘)       │
                      └──────────┬────────────────────────────┘
                                 │
               ┌─────────────────┼─────────────────┐
               ▼                 ▼                 ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │  Durable     │  │  KV Cache    │  │  R2 Storage  │
      │  Objects     │  │  (搜索/抓取)  │  │  (网页快照)   │
      │  + SQLite    │  └──────────────┘  └──────────────┘
      │  (会话状态)   │
      └──────────────┘
               │
               ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │  Workers AI  │  │  Vectorize   │  │  Cron        │
      │  (推理/嵌入)  │  │  (语义记忆)   │  │  (定时任务)   │
      └──────────────┘  └──────────────┘  └──────────────┘
```

### 多路径回复策略

| 优先级 | 路径 | 条件 | 成本 |
|--------|------|------|------|
| 1 | Workers AI | 未配置 OPENAI_BASE_URL | 免费 (10K/day) |
| 2 | 上游 OpenAI API | 配置了 OPENAI_BASE_URL | 取决于上游 |
| 3 | 本地兜底 | 无任何配置 | 免费 (简单 echo) |

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/hsjlyj/workclaw.git
cd workclaw
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置 Cloudflare Workers 绑定

```bash
# KV 缓存
npx wrangler kv namespace create WORKCLAW_CACHE

# R2 存储
npx wrangler r2 bucket create workclaw-assets

# Vectorize 语义搜索索引
npx wrangler vectorize create workclaw-memories --dimensions=768 --metric=cosine
```

### 4. 配置密钥和环境变量

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put CLAW_API_KEY        # 可选，仅使用上游 API 时需要
npx wrangler secret put OPENAI_API_KEY      # 可选
```

复制 `.env.example` 为 `.dev.vars` 用于本地开发。

### 5. 本地启动

```bash
npm run dev
```

### 6. 部署

```bash
npm run deploy
```

### 7. 设置 Telegram Webhook

部署后，把 Telegram Webhook 指到：

```
https://<your-worker-domain>/telegram/webhook
```

## 配置说明

| 变量 / Secret | 必填 | 用途 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | Telegram Bot API 访问令牌 |
| `TELEGRAM_WEBHOOK_SECRET` | 是 | webhook 校验用 secret token |
| `CLAW_API_KEY` | /v1 上游模式必填 | OpenAI 兼容接口的客户端访问密钥 |
| `OPENAI_BASE_URL` | 否 | 上游 OpenAI 兼容服务地址 |
| `OPENAI_API_KEY` | 否 | 上游接口鉴权 Bearer token |
| `CLAW_MODEL` | 否 | 优先使用的模型名 |
| `OPENAI_MODEL` | 否 | CLAW_MODEL 的备用来源 |
| `CLAW_ENV` | 否 | 运行环境标识 |

## Telegram 交互

### 命令

| 命令 | 作用 |
| --- | --- |
| `/start` | 显示帮助 |
| `/help` | 显示帮助 |
| `/model` | 查看当前模型、回复模式 |
| `/reset` | 清空当前会话 (不清长期记忆) |
| `/todo` | 管理待办事项 |
| `/remind` | 管理定时提醒 |
| `/watch` | 管理网页监控 |
| `/mode` | 查看或切换运行模式 |
| `/summary` | 查看或压缩近期摘要 |

### 按钮

| 按钮 | 作用 |
| --- | --- |
| 重试 | 重新生成上一条回复 |
| 重置 | 清空当前会话 |
| 帮助 | 打开帮助面板 |

## 长期记忆

`workclaw` 的长期记忆是**隐式自动**的，不要求用户手动管理。

- 只在消息像稳定事实或偏好时自动提取
- 不在 Telegram 里暴露记忆管理命令
- 记忆存储和短期对话分开
- `/reset` 只清短期会话，不清长期记忆
- 记忆自动索引到 Vectorize，支持语义搜索
- 每小时自动执行记忆整理和压缩

## 网络搜索与网页抓取

- 搜索使用 DuckDuckGo 的 HTML 页面
- 抓取使用普通 `fetch`
- 不依赖浏览器，也不执行网页 JavaScript
- 搜索结果和抓取内容自动缓存到 KV
- 大内容自动归档到 R2

## 定时任务 (Cron)

每 5 分钟自动执行提醒投递和监控检查，每小时执行记忆整理和过期清理。

## 开发与测试

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地启动 Worker |
| `npm test` | 运行测试 |
| `npm run deploy` | 部署到 Cloudflare Workers |

## 已知限制

- Workers AI 的模型选择有限
- Vectorize 索引创建后维度不可更改
- 网页抓取不渲染 JavaScript
- 自动记忆是启发式规则，不是完整的语义分类系统

## 推荐阅读顺序

1. README.md
2. wrangler.jsonc
3. src/index.js
4. src/kv-cache.js / src/r2-storage.js / src/ai-inference.js / src/vectorize-search.js
5. test/worker.test.js
6. user.md / soul.md
