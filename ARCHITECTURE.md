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
  - [2.7 多模态/视觉（Vision）输入处理](#27-多模态视觉vision-输入处理)
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
│       ├── settingsSync.ts        # 运行时端口 ↔ settings.json / active_port 双向同步（JSONC 安全）
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
* **OpenAI 兼容协议族**（`openai`, `openrouter`, `custom`, `ollama`, `groq`, `mistral`, `cerebras`, `nvidia` 等）：统一路由至 `openai.ts` 转换器，支持流式 SSE、原生 `tool_calls`、DeepSeek DSML 标签解析，以及图像输入（`image_url` 内容块）。
* **Anthropic 协议族**（`anthropic`, `claude` 等）：路由至 `anthropic.ts`，映射 `system`、`tool_use`、`content_block_delta`、extended thinking 块，以及图像输入（`type: "image"` base64 内容块）。
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
* **Slug 唯一性（优先 `displayName`）**：`toSlug()` 以 `displayName || externalModelName || name` 生成 slug，并在加载时经 `assignUniqueSlugsAndPlaceholders()` 预分配唯一 `_slug`；`fetchAvailableModels` 合并时始终使用 `m._slug || toSlug(m)`。**切勿**在合并时重新调用 `toSlug()`，否则相同 `externalModelName` 的多模型会同名覆盖（见 [坑 10](#坑-10多自定义模型仅显示-n-1-个同名-slug-覆写)）。

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
2. **动态端口回退 + `settings.json` 自动同步**：代理默认监听 `50999` 端口，若端口冲突自动回退至系统随机空闲端口（`port: 0`）。**代理每次启动成功监听后**（[`src/proxy.ts`](file:///d:/programme/antigravity-add-model/src/proxy.ts) `startProxy()` 回调）会自动执行 [`src/proxy/settingsSync.ts`](file:///d:/programme/antigravity-add-model/src/proxy/settingsSync.ts)：
   - `syncActivePort(port)` 将实际运行端口写入 `~/.gemini/antigravity/active_port`（供 CLI、部署脚本与健康检查读取）；
   - `syncSettingsJson(port)` 将用户 `settings.json` 中的 `jetski.cloudCodeUrl` 精确同步为 `http://127.0.0.1:<actual_port>/v1internal/xxxxxxx`，保证 Language Server 始终连接代理的实际监听端口。端口恢复到 `50999` 时下次启动也会同步回 `50999`。
   - JSONC 安全读写：采用带注释/尾随逗号感知的插入与替换，保留用户排版、其余配置项及全部注释；端口一致时幂等跳过写入，避免触发无谓的文件监听事件。
   - 路径解析：优先通过 Electron `app.getPath('userData')`（如 `%APPDATA%\Antigravity IDE`），并跨平台回退（Windows `%APPDATA%` / macOS `Library/Application Support` / Linux `XDG_CONFIG_HOME`）以兼容独立测试与 CLI 环境。
3. **指数退避重试**：遇到 429（限流）或 5xx 错误时，根据服务端 `Retry-After` 头或以 `1s → 2s → 4s` 指数级退避重试（最多重试 `maxRetries` 次，默认 3 次）。

### 2.7 多模态/视觉（Vision）输入处理

当用户粘贴截图、或 Agent 自动截图并发送给模型时，Gemini 请求中的图像以 `parts[].inlineData`（`{ mimeType, data }`，`data` 为 base64）形式承载。代理不再将其退化为纯文本占位符，而是构造目标提供商的标准图像结构，使视觉模型真正“看见”图像：

* **OpenAI 兼容协议**（[`src/proxy/translators/openai.ts`](file:///d:/programme/antigravity-add-model/src/proxy/translators/openai.ts)）：当 `inlineData.mimeType` 以 `image/` 开头时，将消息 `content` 由 `string` 转为 `OpenAIUserContentPart[]`，生成：
  ```json
  [
    { "type": "text", "text": "描述这张图" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
  ]
  ```
  文本 part 与图像 part 按原始顺序交织；无图像的消息仍保持 `string` 形式（向后兼容）。

* **Anthropic 协议**（[`src/proxy/translators/anthropic.ts`](file:///d:/programme/antigravity-add-model/src/proxy/translators/anthropic.ts)）：同样将 `content` 转为 `AnthropicContentBlock[]`，生成 `type: "image"` 的 base64 内容块：
  ```json
  [
    { "type": "text", "text": "描述这张图" },
    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
  ]
  ```

**意义**：
1. 外部视觉模型（GPT-4o、Claude 3.5 Sonnet 等）能真正识别图像内容，而非看到 `[Image: data:...]` 占位文本；
2. 避免把极长的 base64 字符串当作纯文本输入，从而浪费 Token 或触发上下文超长报错。

> [!NOTE]
> 视觉能力是否生效仍取决于模型本身：`modelUtils.ts` 的 `detectModelCapabilities()` 通过 `supportsImages` 字段集中检测模型是否支持图像。该转换只改变传输结构，不会强制不支持图像的模型解码图像。

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
5. **写入用户设置**：向 `%APPDATA%\Antigravity IDE\User\settings.json` 写入本地代理端点（种子值，幂等）：
   ```json
   "jetski.cloudCodeUrl": "http://127.0.0.1:50999/v1internal/xxxxxxx"
   ```
   > [!NOTE]
   > 该端点常驻为默认端口 `50999` 的种子值；**代理实际启动时会通过 `syncSettingsJson` 将其自动校正为真实监听端口**（无论是 50999 还是动态回退端口），因此此处只保证键存在即可。
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

### 坑 10：多自定义模型仅显示 N-1 个（同名 slug 覆写）

* **症状**：`custom_models.json` 中有 N 个模型，但模型选择器中只出现 N-1 个；代理日志显示 `Loaded custom models count: N`（数量正确），注入后 `agentModelSorts[0].groups[0].modelIds` 里的 `extm-*` 数量却是 N-1，呈现“最多显示 N-1/10 个模型”的表象。
* **根因**：早期 `toSlug()` 以 **`externalModelName || name`** 生成 slug。当两个模型来自不同厂商、但上游模型 id 相同（例如“商汤 V4 Flash”与“BAI V4 Flash”的 `externalModelName` **都是 `deepseek-v4-flash`**）时，二者 slug 相同（`extm-deepseek-v4-fx`）。`fetchAvailableModels` 的 `mergeModels` 以 slug 作为 key 写入 `models` 映射，后者**覆盖**前者，或去重后只剩 1 项，于是第 4 个自定义模型静默丢失。
* **修复**（[`src/proxy.ts`](file:///d:/programme/antigravity-add-model/src/proxy.ts)）：
  1. `toSlug()` 改为 **`displayName || externalModelName || name` 优先级**，使同名上游模型的 slug 互不相同且具备描述性。
  2. `assignUniqueSlugsAndPlaceholders()` 在加载时为每个模型预分配唯一 `_slug`（冲突时追加 `-2` 后缀）与唯一占位符。
  3. `fetchAvailableModels` 合并时统一使用 `m._slug || toSlug(m)`，**不再重复计算 `toSlug(m)`**，从根源杜绝覆写（见 [`src/proxy.ts`](file:///d:/programme/antigravity-add-model/src/proxy.ts) `mergeModels` 注释）。
* **排查**：打开 `~/.gemini/antigravity/debug_fetchAvailableModels.json`，对比 `models` 映射与 `agentModelSorts[0].groups[0].modelIds` 中 `extm-*` 的数量即可定位：若某供应商的 `externalModelName` 与另一模型重复，其条目会被去重丢弃。

> [!NOTE]
> **视觉“10 项”截断 ≠ 数据丢失**。两者独立存在：
> * 数据侧：同名 slug 覆写导致少注入模型 → 本坑 10 修复；
> * 视觉侧：前端下拉面板 `POu` 的 `max-h-80`（320px）+ `scrollbar-none` + `overflow-hidden` 会裁剪约 10 项 → 由 `deploy-ide.ps1` 第 6 步的 85vh/600px 高度与滚动补丁解除。部署时务必确认 workbench 补丁已生效（`debug_fetchAvailableModels.json` 中模型齐全但界面仍显示不全时，多为补丁因 IDE 更新失效）。

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

## 六、已知限制与优化

1. **自动更新覆盖**：Antigravity IDE 自动更新会重写 `out\main.js` 与渲染层文件，更新后重新运行一次 `.\deploy-ide.ps1` 即可恢复（`settings.json` 与 `custom_models.json` 会永久保留）。
2. **前端选择器多模型支持（已完美优化）**：早期版本由于前端下拉面板 `POu` 的 `max-h-80`（320px）与 `scrollbar-none` 限制，导致第 4 个及以后的自定义模型被视觉遮挡。当前部署流程会自动对 `workbench.desktop.main.js` 应用高度与滚动补丁（扩展至 `min(85vh, 600px)` 并启用平滑滚动条，同步更新 `product.json` 校验哈希），已支持同时配置 20+ 个自定义模型无限制浏览与选用。**注意**：IDE 自动更新会重写该文件导致补丁失效，更新后需重新运行 `.\deploy-ide.ps1`。
3. **名称关键字过滤**：自定义模型的 `displayName` 应尽量避免包含 `flash`/`lite`/`pro`/`low`/`high`/`tier` 等词汇，防止命中国方分级过滤规则。
4. **同名上游模型 id**：不同提供商的模型若 `externalModelName` 相同，`toSlug()` 已按 `displayName` 优先生成互不相同的 slug（见 [坑 10](#坑-10多自定义模型仅显示-n-1-个同名-slug-覆写)），但**同一配置内 `displayName` 不宜重复**，否则仍会因 slug 冲突而丢失模型。
5. **图像输入取决于模型视觉能力**：代理会正确构造 `image_url` / `type: "image"` 结构（见 [2.7 节](#27-多模态视觉vision-输入处理)），但图像能否被“看见”仍取决于所用模型是否支持视觉。对不支持图像的模型（如部分 DeepSeek、Llama 文本模型），图像内容块可能被上游忽略或报错。

