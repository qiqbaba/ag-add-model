# Antigravity 自定义模型启用器 · 架构设计与部署全景指南

> 本文是 **Antigravity IDE 独立版**（VS Code Fork 架构，解包式 `resources\app`）的核心技术文档，完整整合了**系统架构设计**、**Cloud Code 内部 API 逆向工程**、**自动化部署实现**、**9 个深坑排查实录**、**验证清单与回滚手册**。

---

## 目录

- [一、系统架构总览](#一系统架构总览)
  - [1.1 拓扑与数据流向](#11-拓扑与数据流向)
  - [1.2 核心模块与文件清单](#12-核心模块与文件清单)
  - [1.3 多协议翻译器体系](#13-多协议翻译器体系)
- [二、Cloud Code 内部 API 逆向与协议转换](#二cloud-code-内部-api-逆向与协议转换)
  - [2.1 fetchAvailableModels 拦截与注入规范](#21-fetchavailablemodels-拦截与注入规范)
  - [2.2 streamGenerateContent / generateContent 拆包与包装](#22-streamgeneratecontent--generatecontent-拆包与包装)
  - [2.3 流式修复：元数据缓冲 vs 生成直通](#23-流式修复元数据缓冲-vs-生成直通)
  - [2.4 工具调用（DSML 解析与 tool_use 映射）](#24-工具调用dsml-解析与-tool_use-映射)
  - [2.5 运行时状态管理与 TTL 清理](#25-运行时状态管理与-ttl-清理)
  - [2.6 Schema 校验、动态端口与请求重试](#26-schema-校验动态端口与请求重试)
- [三、IDE 部署指南与环境要求](#三ide-部署指南与环境要求)
  - [3.1 IDE 架构要点](#31-ide-架构要点)
  - [3.2 一键部署流程（deploy-ide.ps1）](#32-一键部署流程deploy-ideps1)
  - [3.3 custom_models.json 配置规范与加解密](#33-custom_modelsjson-配置规范与加解密)
- [四、踩坑实录与深度排障（1~9 坑完整收录）](#四踩坑实录与深度排障19-坑完整收录)
  - [坑 1：require 静默失败（ESM 主进程）](#坑-1require-静默失败esm-主进程)
  - [坑 2：Content-Length 与 Transfer-Encoding 冲突（Parse Error）](#坑-2content-length-与-transfer-encoding-冲突parse-error)
  - [坑 3：product.json 完整性校验警告](#坑-3productjson-完整性校验警告)
  - [坑 4：自定义模型未显示排查链路](#坑-4自定义模型未显示排查链路)
  - [坑 5：TUN 网卡失效与代理网络超时（ETIMEDOUT）](#坑-5tun-网卡失效与代理网络超时etimedout)
  - [坑 6：前端仅渲染 agentModelSorts 第一个分组](#坑-6前端仅渲染-agentmodelsorts-第一个分组)
  - [坑 7：字段缺失导致官方 Low/Medium/High 子菜单 NaN 崩溃](#坑-7字段缺失导致官方-lowmediumhigh-子菜单-nan-崩溃)
  - [坑 8：Protobuf 枚举类型不匹配（thinkingLevel 必须为 int32 数字）](#坑-8protobuf-枚举类型不匹配thinkinglevel-必须为-int32-数字)
  - [坑 9：自定义 provider 名称导致协议未转换（HTTP 400 required model）](#坑-9自定义-provider-名称导致协议未转换http-400-required-model)
- [五、验证清单、日志速查与回滚](#五验证清单日志速查与回滚)
  - [5.1 部署验证清单](#51-部署验证清单)
  - [5.2 关键日志位置速查](#52-关键日志位置速查)
  - [5.3 一键回滚操作](#53-一键回滚操作)
- [六、已知限制](#六已知限制)

---

## 一、系统架构总览

### 1.1 拓扑与数据流向

Antigravity IDE（VS Code Fork）中，语言服务器与云端大模型交互的完整数据流向如下：

```
┌─────────────────────────────────────────────────────────┐
│                    Antigravity IDE                      │
│                                                         │
│  ┌─────────────────┐   spawn    ┌─────────────────────┐ │
│  │  extension.js   │ ────────▶  │ language_server(Go) │ │
│  │  (扩展宿主进程)  │            └──────────┬──────────┘ │
│  └─────────────────┘                       │            │
│                                            │ --cloud_code_endpoint
│                                            │ (由 jetski.cloudCodeUrl 下发)
│                                            ▼            │
│                            ┌──────────────────────────┐ │
│                            │   本地代理 127.0.0.1:50999 │ │ ◀── 注入到 Electron 主进程
│                            │   - 拦截 fetchAvailableModels │
│                            │   - 注入自定义模型定义    │ │
│                            │   - 协议翻译 (OpenAI/Claude)│
│                            └──────────┬───────────────┘ │
└───────────────────────────────────────┼─────────────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    │                                       │
                    ▼ https                                 ▼ https / http
     daily-cloudcode-pa.googleapis.com          外部 API (OpenAI / DeepSeek /
            (官方 Gemini 模型)                     Anthropic / Ollama / 本地 LLM)
```

### 1.2 核心模块与文件清单

当前代码库采用极简聚焦的设计，所有核心功能分布在以下文件中：

```
antigravity-add-model/
├── src/
│   ├── index.ts                   # 模块统一导出入口（生命周期、校验器、加解密工具）
│   ├── proxy.ts                   # 本地 HTTP 代理核心：请求拦截、URL 重写、SSE 流式包装
│   ├── cryptoStore.ts             # API 密钥安全存储（基于 Electron safeStorage AES-256-GCM）
│   ├── schemaValidator.ts         # 运行时 Schema 校验器（模型配置、API 响应、流分块）
│   ├── types.d.ts                 # 全局 Ambient 类型声明（Electron 与 Node.js 扩展）
│   └── proxy/
│       ├── registry.ts            # 翻译器注册表：自动发现并动态加载 translators/ 模块
│       ├── shared.ts              # 跨轮次上下文状态管理（Map 隔离 + 托管 TTL 垃圾回收）
│       ├── modelUtils.ts          # 模型能力集中检测（Thinking、DeepSeek、Claude、Vision 等）
│       └── translators/
│           ├── openai.ts          # OpenAI ↔ Gemini 双向翻译器（请求、响应、SSE、Tool Calls）
│           ├── anthropic.ts       # Anthropic ↔ Gemini 双向翻译器（Claude tool_use、Thinking）
│           ├── google.ts          # Google AI Studio 透传与动态端点路由
│           ├── ollama.ts          # Ollama 本地模型适配器（端点规范化与错误转译）
│           └── utils.ts           # 翻译器共享工具（DSML 解析、工具调用映射、参数归一化）
├── dist/                          # TypeScript 编译产物
├── deploy-ide.ps1                 # Antigravity IDE 一键部署与注入脚本
├── ARCHITECTURE.md                # 架构设计与部署全景指南（本文档）
└── README.md                      # 快速开始与使用说明
```

### 1.3 多协议翻译器体系

翻译器注册表（[`src/proxy/registry.ts`](file:///d:/programme/antigravity-add-model/src/proxy/registry.ts)）具备自动发现能力：
* **OpenAI 兼容协议族**（`openai`, `openrouter`, `custom`, `ollama`, `groq`, `mistral`, `cerebras`, `nvidia` 等）：统一路由至 `openai.ts` 转换器，支持流式 SSE、原生 `tool_calls` 以及 DeepSeek DSML 标签解析。
* **Anthropic 协议族**（`anthropic`, `claude` 等）：路由至 `anthropic.ts`，映射 `system`、`tool_use`、`content_block_delta` 及 extended thinking 块。
* **Google AI Studio 协议**（`google`）：原生 Gemini 格式透传，动态根据流式状态挂载 `:streamGenerateContent` 或 `:generateContent`。

---

## 二、Cloud Code 内部 API 逆向与协议转换

Antigravity 使用 Google 专有的 **Cloud Code 内部 API**（`v1internal:*` 端点），而非公网 Gemini API。代理层针对以下关键差异进行了逆向工程与深度适配：

### 2.1 fetchAvailableModels 拦截与注入规范

当 IDE 请求模型列表时，代理拦截 `/v1internal:fetchAvailableModels` 并与官方返回的模型数据进行合并注入。

#### 1. 数据结构要求
官方响应中 `models` 是**对象映射**（Key 为模型 slug，无 `models/` 前缀），`agentModelSorts` 定义展示分组：
```json
{
  "models": {
    "gemini-3.6-flash-high": { ... },
    "extm-gpt-4o": { ... }
  },
  "agentModelSorts": [
    {
      "displayName": "Recommended",
      "groups": [
        { "modelIds": ["gemini-3.6-flash-high", "extm-gpt-4o"] }
      ]
    }
  ]
}
```

#### 2. 自定义模型完整字段补齐（关键）
实测发现前端按等级（Tier）分组时会严格读取 Protobuf 字段，若字段缺失会导致 `NaN` 运算崩溃进而遮挡官方子菜单（详见 [坑 7](#坑-7字段缺失导致官方-lowmediumhigh-子菜单-nan-崩溃) 与 [坑 8](#坑-8protobuf-枚举类型不匹配thinkinglevel-必须为-int32-数字)）。自定义模型注入时必须完整补齐以下条目：

| 字段 | 类型 | 说明 / 注入值 |
|---|---|---|
| `name` | `string` | 模型 Slug（如 `extm-gpt-4o`） |
| `model` | `string` | 占位符 ID（如 `MODEL_PLACEHOLDER_M401`） |
| `displayName` | `string` | 清洗后的显示名称（由 `sanitizeDisplayName()` 处理） |
| `tagTitle` | `string` | `'Custom'` |
| `tagDescription` | `string` | `'User-configured model'` |
| `modelExperiments` | `object` | `{ experiments: {} }` |
| `thinkingLevel` | `number (int32)` | **`0`**（`THINKING_LEVEL_UNSPECIFIED`，**切勿传字符串！**） |
| `thinkingBudget` | `number` | 思考模型填 `4096`，普通模型填 `0` |
| `minThinkingBudget` | `number` | 思考模型填 `1024`，普通模型填 `0` |
| `quotaInfo` | `object` | `{ remainingFraction: 1, resetTime: ISO时间戳 }` |
| `apiProvider` | `string` | `'API_PROVIDER_GOOGLE_GEMINI'` |
| `modelProvider` | `string` | `'MODEL_PROVIDER_GOOGLE'` |
| `toolFormatterType` | `string` | `'TOOL_FORMATTER_TYPE_XML'` |
| `tokenizerType` | `string` | `'LLAMA_WITH_SPECIAL'` |

#### 3. 分组注入规则
* **必须追加到 `agentModelSorts[0].groups[0].modelIds` 末尾**：前端只渲染第一个 Recommended 分组中的模型，独立分组会被前端忽略（详见 [坑 6](#坑-6前端仅渲染-agentmodelsorts-第一个分组)）。
* **Slug 与显示名称清洗**：`toSlug()` 与 `sanitizeDisplayName()` 会自动将 `flash`→`fx`、`pro`→`pr0`、`low`→`l0w`、`high`→`h1gh` 等分级词汇替换，避免命中国方 Tier 模式导致归类紊乱。

---

### 2.2 streamGenerateContent / generateContent 拆包与包装

1. **请求解包**：Cloud Code 将 Gemini 请求封装在 `request` 顶层字段中：
   ```json
   {
     "project": "...",
     "requestId": "...",
     "request": {
       "contents": [...],
       "systemInstruction": { "parts": [{ "text": "..." }] },
       "generationConfig": { ... }
     },
     "model": "extm-gpt-4o"
   }
   ```
   代理在翻译前先提取 `reqJson.request || reqJson`，并将 `systemInstruction` 转换为目标提供商的系统消息（OpenAI 的 `role: "system"` 或 Anthropic 的 `system` 字段）。

2. **响应包装信封**：外部大模型响应必须被重新包装为 Cloud Code 期望的标准信封结构：
   ```json
   {
     "response": {
       "candidates": [
         {
           "content": {
             "parts": [{ "text": "Hello world" }],
             "role": "model"
           },
           "finishReason": "STOP",
           "index": 0
         }
       ]
     },
     "traceId": "",
     "metadata": {}
   }
   ```
   流式响应时以 SSE 格式输出：`data: {"response":{...},"traceId":"","metadata":{}}\n\n`。

---

### 2.3 流式修复：元数据缓冲 vs 生成直通

代理根据请求 URL 严格区分处理策略：
* **元数据请求**（`v1internal:*`，非生成请求）：进行缓冲、解压（gzip/gunzip）、改写 URL 指回本地代理，并剔除 `transfer-encoding` 头；
* **生成请求**（`streamGenerateContent` / `generateContent`）：**绝不进行缓冲**，直接建立实时流式管道。若缓冲生成响应，Go 语言服务器会因等待流结束超时而崩溃，报 `terminated due to error`。

---

### 2.4 工具调用（DSML 解析与 tool_use 映射）

#### 1. DeepSeek DSML 标签解析
针对 DeepSeek 等模型在输出中以自定义 XML 形式返回工具调用的情况：
```xml
<DSML|invoke name="search_web">
  <DSML|parameter name="query" string="true">latest AI news</DSML|parameter>
</DSML|invoke>
```
[`src/proxy/translators/utils.ts`](file:///d:/programme/antigravity-add-model/src/proxy/translators/utils.ts) 自动捕获该模式，将其转换为 Gemini 标准的 `functionCall` 对象，并从文本流中剔除原始 XML 标记。

#### 2. 原生工具调用转换与参数归一化
* **OpenAI** `tool_calls` 与 **Anthropic** `tool_use` 会双向映射为 Gemini 的 `functionCall` / `functionResponse`。
* 内置参数别名归一化（如把模型输出的 `absolute_path`、`filePath` 映射为 Antigravity 预期的 `AbsolutePath`）。

---

### 2.5 运行时状态管理与 TTL 清理

为支持多轮会话及并发工具调用，状态通过按模型的 `Map` 进行隔离（[`src/proxy/shared.ts`](file:///d:/programme/antigravity-add-model/src/proxy/shared.ts)）：
* `modelToolCallIds`：记录模型与工具调用 ID 的对应关系；
* `modelReasoningContent`：保存 DeepSeek / O 系列模型的思考链推理内容；
* `activeStreamContexts`：管理流式分块的累积上下文。

**托管 TTL 垃圾回收**：
* 状态记录带有访问时间戳；
* 流式上下文 TTL 为 10 分钟，工具调用与推理内容 TTL 为 30 分钟；
* 定时器与代理服务的 `startProxy()` / `stopProxy()` 生命周期严格绑定，杜绝进程退出后的定时器遗留。

---

### 2.6 Schema 校验、动态端口与请求重试

1. **运行时 Schema 校验**（[`src/schemaValidator.ts`](file:///d:/programme/antigravity-add-model/src/schemaValidator.ts)）：在模型配置加载、API 响应解析、SSE 分块接收时进行严格校验，防止畸形数据导致前端白屏。
2. **动态端口回退**：代理默认监听 `50999` 端口，若端口冲突自动回退至系统随机空闲端口（`port: 0`），并将实际运行端口写入 `~/.gemini/antigravity/active_port`。
3. **指数退避重试**：遇到 429（限流）或 5xx 错误时，根据服务端 `Retry-After` 头或以 `1s → 2s → 4s` 指数级退避重试（最多重试 `maxRetries` 次，默认 3 次）。

---

## 三、IDE 部署指南与环境要求

### 3.1 IDE 架构要点

1. **解包式目录（无 `app.asar`）**：Antigravity IDE 独立版程序文件位于 `resources\app\out\`（`main.js` 明文存放），可直接注入代码。
2. **主进程为 ESM 环境**：`package.json` 声明了 `"type": "module"`，在 `out\main.js` 中必须使用动态 `import()`，使用 `require()` 会被静默吞掉（见 [坑 1](#坑-1require-静默失败esm-主进程)）。
3. **端点由用户设置动态下发**：IDE 读取用户设置中的 **`jetski.cloudCodeUrl`** 并通过 `--cloud_code_endpoint` 传给语言服务器，覆盖二进制内的硬编码端点。

---

### 3.2 一键部署流程（`deploy-ide.ps1`）

#### 前置要求
* Node.js ≥ 20、npm、PowerShell 5.1+；
* 已安装 Antigravity IDE 独立版。

#### 执行部署
```powershell
.\deploy-ide.ps1 -IdePath "$env:LOCALAPPDATA\Programs\Antigravity IDE"
```

#### 脚本自动化执行阶段：
1. **编译构建**：在当前目录执行 `npm run build` 生成 `dist/`；
2. **安全备份**：将 `main.js` 及语言服务器 exe 备份至 `resources\app_backup\`（附带 `rollback.ps1`）；
3. **部署代理模块**：将代理运行时文件复制到 `resources\app\out\proxy\`，并在该目录安装 `electron-log`；
4. **主进程注入**：在 `out\main.js` 顶部插入动态导入代码：
   ```js
   /* antigravity-add-model bootstrap */
   import('./proxy/bootstrap.js').catch(function(e){console.error('[agy-proxy] import failed',e);});
   ```
5. **写入用户设置**：向 `%APPDATA%\Antigravity IDE\User\settings.json` 写入本地代理端点：
   ```json
   "jetski.cloudCodeUrl": "http://127.0.0.1:50999/v1internal/xxxxxxx"
   ```
6. **启动与健康检查**：启动 IDE 并请求 `http://127.0.0.1:50999/health` 验证服务状态。

---

### 3.3 `custom_models.json` 配置规范与加解密

配置文件位于：`~/.gemini/antigravity/custom_models.json`

```json
{
  "models": [
    {
      "name": "models/gpt-4o",
      "displayName": "GPT-4o",
      "description": "经官方 API 的 OpenAI GPT-4o 模型",
      "provider": "openai",
      "apiKey": "sk-proj-...",
      "apiUrl": "https://api.openai.com/v1/chat/completions",
      "externalModelName": "gpt-4o",
      "encrypted": false
    },
    {
      "name": "models/claude-3-5-sonnet",
      "displayName": "Claude 3.5 Sonnet",
      "description": "Anthropic 官方 API",
      "provider": "anthropic",
      "apiKey": "sk-ant-...",
      "apiUrl": "https://api.anthropic.com/v1/messages",
      "externalModelName": "claude-3-5-sonnet-latest",
      "encrypted": false
    },
    {
      "name": "models/deepseek-v3",
      "displayName": "DeepSeek V3 (SiliconFlow)",
      "description": "硅基流动 OpenAI 兼容端点",
      "provider": "openai",
      "apiKey": "sk-...",
      "apiUrl": "https://api.siliconflow.cn/v1/chat/completions",
      "externalModelName": "deepseek-ai/DeepSeek-V3",
      "encrypted": false
    }
  ]
}
```

> [!IMPORTANT]
> **API 密钥加密机制**：
> 初始手动填写明文 API Key 时，设置 `"encrypted": false`（或留空）。代理服务启动后会自动调用 Electron `safeStorage`（Windows DPAPI / macOS Keychain）对密钥进行 AES-256-GCM 静态加密，并将 `"encrypted"` 自动置为 `true`。

---

## 四、踩坑实录与深度排障（1~9 坑完整收录）

### 坑 1：`require` 静默失败（ESM 主进程）
* **症状**：主进程代码注入后无任何效果，代理未启动，控制台无报错。
* **根因**：`resources/app/package.json` 声明了 `"type": "module"`，直接写 `require('./proxy')` 会抛出 `ReferenceError` 并被外部的 `try/catch` 吞掉。
* **修复**：使用动态 `import('./proxy/bootstrap.js')`，并在 `out\proxy\` 目录下创建独立的 `package.json`（不声明 type）以确保子模块按 CommonJS 解析。

---

### 坑 2：`Content-Length` 与 `Transfer-Encoding` 冲突（Parse Error）
* **症状**：IDE 登录后提示“设置账号失败”、大量请求报 `Parse Error`，模型列表时好时坏。
* **根因**：代理改写响应体后设置了 `Content-Length`，但原样透传了上游分块传输的 `Transfer-Encoding: chunked` 头。HTTP 规范严格禁止两者共存，Go 语言服务器解析器直接拒绝连接。
* **修复**（[`src/proxy.ts:308-314`](file:///d:/programme/antigravity-add-model/src/proxy.ts#L308-L314)）：
  ```ts
  const modifiedHeaders = { ...proxyRes.headers };
  delete modifiedHeaders['content-encoding'];
  delete modifiedHeaders['transfer-encoding']; // 关键修复：必须剔除
  const modifiedBuffer = Buffer.from(text, 'utf-8');
  modifiedHeaders['content-length'] = String(modifiedBuffer.length);
  ```

---

### 坑 3：`product.json` 完整性校验警告
* **症状**：启动 IDE 时弹窗提示“安装似乎损坏，请重新安装”。
* **根因**：`product.json` 的 `checksums` 记录了核心渲染层文件的 SHA-256 哈希。
* **修复**：主进程 `out\main.js` 不在校验哈希表中，只要避免不必要地修改 `workbench.desktop.main.js`，就不会触发完整性警告。

---

### 坑 4：自定义模型未显示排查链路
若模型未出现在下拉列表中，按以下顺序排查：
1. 检查代理日志是否有 `Loaded custom models count: N`（若为 0 说明 JSON Schema 校验失败）；
2. 检查 `settings.json` 中 `jetski.cloudCodeUrl` 是否生效；
3. 检查代理日志是否包含 `Intercepting fetchAvailableModels request`。

---

### 坑 5：TUN 网卡失效与代理网络超时（`ETIMEDOUT`）
* **症状**：登录失败或模型请求报 `ETIMEDOUT`。
* **根因**：在使用 Clash / Sing-box / Mihomo 等 TUN 虚拟网卡代理时，若 TUN 核心崩溃或节点失效，Node.js 的 `https.request` 无法解析 Fake-IP 导致超时。
* **排查**：在终端执行 `Resolve-DnsName daily-cloudcode-pa.googleapis.com`，若返回公网真实 IP 而非 `198.18.x.x`，说明 TUN 网卡代理已失效，重启网络代理软件即可。

---

### 坑 6：前端仅渲染 `agentModelSorts` 第一个分组
* **症状**：日志显示模型成功注入，但界面下拉列表完全不显示自定义模型。
* **根因**：前端模型选择器**仅渲染 `agentModelSorts[0].groups[0].modelIds`（Recommended 分组）**中的模型，额外追加的自定义分组会被前端静默忽略。
* **修复**：代理在拦截 `fetchAvailableModels` 时，必须将自定义模型的 slug 追加进每个 sort 的 `groups[0].modelIds` 列表中。

---

### 坑 7：字段缺失导致官方 Low/Medium/High 子菜单 NaN 崩溃
* **症状**：自定义模型出现后，官方 Gemini 模型的 Low/Medium/High 分级子菜单无法展开或被遮挡（仅露出一条边缘）。
* **根因**：前端在渲染分级子菜单时会读取各模型的 `thinkingBudget`、`quotaInfo.resetTime`、`tagTitle`、`modelExperiments` 等元数据。自定义模型若缺失这些字段，前端在计算分级权重时得到 `NaN` 导致组件异常崩溃。
* **修复**：自定义模型注入条目必须补齐官方模型的全部元数据字段（见 [2.1 节表格](#2-自定义模型完整字段补齐关键)）。

---

### 坑 8：Protobuf 枚举类型不匹配（`thinkingLevel` 必须为 int32 数字）
* **症状**：IDE 启动后登录流程卡死在 Loading 界面，几秒后报错。
* **根因**：补齐字段时，`thinkingLevel` 是 Protobuf 的 `varint` 枚举（wireType 0）。在 JSON 序列化中**必须传数字 `0`**（`THINKING_LEVEL_UNSPECIFIED`）。若错误传为字符串 `'THINKING_LEVEL_UNSPECIFIED'`，Go 语言服务器的 protobuf 解码器会直接崩溃：
  ```
  cannot decode field ModelDetails.thinking_level from JSON: expected number (int32), got "THINKING_LEVEL_UNSPECIFIED"
  ```
* **修复**：确保 `thinkingLevel: 0`。

---

### 坑 9：自定义 provider 名称导致协议未转换（HTTP 400 required model）
* **症状**：自定义模型可正常选中，但发送消息后立即报错 `Agent execution terminated due to error`。
* **根因**：在 `custom_models.json` 中将 `provider` 填为了厂商名称（如 `"SenseNova"`、`"SiliconFlow"`）。由于未能匹配内置协议转换器，代理原样透传了 Gemini 请求体（`{ contents: [...] }`），上游 `/v1/chat/completions` 接口因缺少 `model` 和 `messages` 抛出 HTTP 400。
* **修复**：所有 OpenAI 兼容接口，`provider` **必须统一填写 `"openai"` 或 `"custom"`**。

---

## 五、验证清单、日志速查与回滚

### 5.1 部署验证清单

- [ ] 访问 `http://127.0.0.1:50999/health`，返回 `{"status":"ok", ...}`；
- [ ] 查看 `%APPDATA%\Antigravity IDE\logs\main.log`，出现 4 个 Translator 加载日志与 `Server listening`；
- [ ] 检查语言服务器启动参数包含 `--cloud_code_endpoint http://127.0.0.1:50999/v1internal/xxxxxxx`；
- [ ] 代理日志显示 `Loaded custom models count: N`；
- [ ] IDE 模型下拉菜单中出现自定义模型（带 `extm-*` 前缀）；
- [ ] 官方 Low/Medium/High 分级子菜单能够正常悬停并展开展开；
- [ ] 发送消息可获得流畅的流式 SSE 响应（HTTP 200）。

---

### 5.2 关键日志位置速查

| 日志类别 | 路径 | 核心排查用途 |
|---|---|---|
| **代理主日志** | `%APPDATA%\Antigravity IDE\logs\main.log` | 代理启停、请求路由拦截、协议转换日志 |
| **语言服务器日志** | `%APPDATA%\Antigravity IDE\logs\<session>\cloudcode.log` | LS 接收与解析报错（如 Parse Error、Protobuf 报错） |
| **LS 启动日志** | `%APPDATA%\Antigravity IDE\logs\<session>\ls-main.log` | 命令行参数、端点下发记录、stderr |
| **模型配置文件** | `~/.gemini/antigravity/custom_models.json` | 自定义模型配置（含加密状态） |
| **运行端口记录** | `~/.gemini/antigravity/active_port` | 代理实际监听的本地端口号 |

---

### 5.3 一键回滚操作

若需恢复官方纯净状态，关闭 IDE 后在 PowerShell 中执行备份目录下的回滚脚本即可：

```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\resources\app_backup\rollback.ps1"
```

该脚本将自动还原 `main.js` 与语言服务器二进制文件，并清理 `out\proxy` 注入目录。随后只需手动删除 `settings.json` 中的 `jetski.cloudCodeUrl` 项。

---

## 六、已知限制

1. **自动更新覆盖**：Antigravity IDE 自动更新会重写 `out\main.js`，更新后重新运行一次 `.\deploy-ide.ps1` 即可恢复（`settings.json` 与 `custom_models.json` 会永久保留）。
2. **前端选择器数量上限**：前端下拉框渲染上限约为 10 项（官方折叠项 7 个 + 自定义模型约 3 个）。超出数量的模型虽在 `models` 映射中，但不会展示在首屏下拉中。
3. **名称关键字过滤**：自定义模型的 `displayName` 应尽量避免包含 `flash`/`lite`/`pro`/`low`/`high`/`tier` 等词汇，防止命中国方分级过滤规则。
