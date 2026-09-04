# Antigravity 自定义模型启用器 · 架构设计与部署全景指南

> 本文是 **Antigravity IDE 独立版**（VS Code Fork 架构，解包式 `resources\app`）的核心技术文档，完整整合了**系统架构设计**、**Cloud Code 内部 API 逆向工程**、**自动化部署实现**、**25 个深坑排查实录（含坑 25：prompt-based 工具调用终极范式）**、**验证清单与回滚手册**。

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
  - [3.4 可视化配置与连通性测试面板（Web Dashboard & RESTful API）](#34-可视化配置与连通性测试面板web-dashboard--restful-api)
<<<<<<< HEAD
- [四、踩坑实录与深度排障（1~13 坑完整收录）](#四踩坑实录与深度排障113-坑完整收录)
=======
- [四、踩坑实录与深度排障（1~12 坑完整收录）](#四踩坑实录与深度排障112-坑完整收录)
>>>>>>> a641afc (docs: 扩充踩坑实录至 12 例，收窄 URL 自动补全范围并新增模型提供商支持)
  - [坑 1：require 静默失败（ESM 主进程）](#坑-1require-静默失败esm-主进程)
  - [坑 2：Content-Length 与 Transfer-Encoding 冲突（Parse Error）](#坑-2content-length-与-transfer-encoding-冲突parse-error)
  - [坑 3：product.json 完整性校验警告](#坑-3productjson-完整性校验警告)
  - [坑 4：自定义模型未显示排查链路](#坑-4自定义模型未显示排查链路)
  - [坑 5：TUN 网卡失效与代理网络超时（ETIMEDOUT）](#坑-5tun-网卡失效与代理网络超时etimedout)
  - [坑 6：前端仅渲染 agentModelSorts 第一个分组](#坑-6前端仅渲染-agentmodelsorts-第一个分组)
  - [坑 7：字段缺失导致官方 Low/Medium/High 子菜单 NaN 崩溃](#坑-7字段缺失导致官方-lowmediumhigh-子菜单-nan-崩溃)
  - [坑 8：Protobuf 枚举类型不匹配（thinkingLevel 必须为 int32 数字）](#坑-8protobuf-枚举类型不匹配thinkinglevel-必须为-int32-数字)
  - [坑 9：自定义 provider 名称导致协议未转换（HTTP 400 required model）](#坑-9自定义-provider-名称导致协议未转换http-400-required-model)
  - [坑 10：多自定义模型仅显示 N-1 个（同名 slug 覆写）](#坑-10多自定义模型仅显示-n-1-个同名-slug-覆写)
  - [坑 11：Web 面板打不开 / 返回 Google 404（部署副本过期）](#坑-11web-面板打不开--返回-google-404部署副本过期)
<<<<<<< HEAD
  - [坑 12：GLM-5.2 / SenseNova 等模型在文本流中输出原始 <tool_call> 标签](#坑-12glm-52--sensenova-等模型在文本流中输出原始-tool_call-标签导致泄漏且工具不执行)
  - [坑 13：自定义模型回答过程中自动结束（finishReason 与多轮 content 丢弃）](#坑-13自定义模型回答过程中自动结束finishreason-与多轮-content-丢弃)
  - [坑 14：多工具/并行工具调用（Explored N folders）后 ID 错乱导致模型直接停止](#坑-14多工具并行工具调用explored-n-folders后-id-错乱导致模型直接停止)
=======
  - [坑 12：自定义模型工具调用「不执行 / 提前结束」——finishReason 回归](#坑-12自定义模型工具调用不执行--提前结束finishreason-回归)
>>>>>>> a641afc (docs: 扩充踩坑实录至 12 例，收窄 URL 自动补全范围并新增模型提供商支持)
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

当前代码库的全部核心功能分布在以下文件中（运行时源文件 17 个 + `src/__tests__/` 测试 10 个 + `src/__mocks__/` mock 1 个，共 28 个 `.ts` 文件）：

```
antigravity-add-model/
├── src/
│   ├── index.ts                   # 模块统一导出入口（生命周期、校验器、加解密工具）
│   ├── proxy.ts                   # 本地 HTTP 代理核心：请求拦截、URL 重写、SSE 流式包装
│   ├── cryptoStore.ts             # API 密钥安全存储（基于 Electron safeStorage AES-256-GCM）
│   ├── schemaValidator.ts         # 运行时 Schema 校验器（模型配置、API 响应、流分块）
│   ├── types.d.ts                 # 全局 Ambient 类型声明（Electron 与 Node.js 扩展）
│   ├── __tests__/                 # 单元/回归测试（vitest，共 10 个测试文件）
│   ├── __mocks__/                 # 测试 mock 模块（electron-log 等）
│   └── proxy/
│       ├── registry.ts            # 翻译器注册表：自动发现并动态加载 translators/ 模块
│       ├── shared.ts              # 跨轮次上下文状态管理（Map 隔离 + 托管 TTL 垃圾回收）
│       ├── modelUtils.ts          # 模型能力集中检测（Thinking、DeepSeek、Claude、Vision 等）
│       ├── settingsSync.ts        # 运行时端口 ↔ settings.json / active_port 双向同步（JSONC 安全）
│       ├── connectionTest.ts      # 连通性探测引擎（RTT 测量、401/403/404/429 诊断）
│       ├── dashboardHtml.ts       # Web 面板 SPA HTML 模板（约 1700+ 行）
│       ├── modelConfigManager.ts  # 模型增删改查、safeStorage 加解密、.bak 备份
│       └── translators/
│           ├── utils.ts           # 翻译器共享工具（DSML 解析、工具调用映射、参数归一化）
│           ├── openai.ts          # OpenAI ↔ Gemini 双向翻译器（请求、响应、SSE、Tool Calls）
│           ├── anthropic.ts       # Anthropic ↔ Gemini 双向翻译器（Claude tool_use、Thinking）
│           ├── google.ts          # Google AI Studio 透传与动态端点路由
│           └── ollama.ts          # Ollama 本地模型适配器（端点规范化与错误转译）
├── dist/                          # TypeScript 编译产物
├── deploy-ide.ps1                 # Antigravity IDE 一键部署与注入脚本
├── ARCHITECTURE.md                # 架构设计与部署全景指南（本文档）
└── README.md                      # 快速开始与使用说明
```

### 1.3 多协议翻译器体系

翻译器注册表（[`src/proxy/registry.ts`](file:///d:/programme/antigravity-add-model/src/proxy/registry.ts)）具备自动发现能力：
* **OpenAI 兼容协议族**（`openai`, `ollama`, `openrouter`, `custom`, `groq`, `mistral`, `cerebras`, `nvidia`, `opencode`, `codestral`）：统一路由至 `openai.ts` 转换器，支持流式 SSE、原生 `tool_calls`、DeepSeek DSML 标签解析，以及图像输入（`image_url` 内容块）。
* **Anthropic 兼容协议族**（`anthropic`, `deepseek`, `kimi`, `fireworks`, `lmstudio`, `llamacpp`, `wafer`, `zai`）：统一路由至 `anthropic.ts` 转换器，映射 `system`、`tool_use`、`content_block_delta`、extended thinking 块，以及图像输入（`type: "image"` base64 内容块）。
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
| `displayName` | `string` | 用户配置的原始显示名称（原样透传，**不做关键词清洗**） |
| `tagTitle` | `string` | `'Custom'` |
| `tagDescription` | `string` | `'User-configured model'` |
| `modelExperiments` | `object` | `{ experiments: {} }` |
| `modelFeatures` | `object` | **嵌套 ModelFeatures 消息**（27 字段，见下方说明；缺失时 LS 视模型为无工具能力） |
| `thinkingLevel` | `number (int32)` | **`0`**（`THINKING_LEVEL_UNSPECIFIED`，**切勿传字符串！**） |
| `thinkingBudget` | `number` | 思考模型填 `4096`，普通模型填 `0` |
| `minThinkingBudget` | `number` | 思考模型填 `1024`，普通模型填 `0` |
| `quotaInfo` | `object` | `{ remainingFraction: 1, resetTime: ISO时间戳 }` |
| `apiProvider` | `string` | `'API_PROVIDER_GOOGLE_GEMINI'` |
| `modelProvider` | `string` | `'MODEL_PROVIDER_GOOGLE'` |
| `toolFormatterType` | `string` | `'TOOL_FORMATTER_TYPE_XML'` |
| `tokenizerType` | `string` | `'LLAMA_WITH_SPECIAL'` |

**`modelFeatures` 嵌套结构（坑 24）**：`supportsToolCalls` 必须挂在 `entry.modelFeatures.supportsToolCalls`（嵌套消息字段），**顶层平铺无效**——proto 描述符中 `ModelInfo.model_features` 是独立嵌套消息（field 12 附近），Go LS 按 protojson 嵌套路径取值。注入最小集：
```json
"modelFeatures": {
  "zeroShotCapable": true,
  "supportsImages": false,
  "supportsToolCalls": true,
  "supportsThinking": true,
  "supportsStreaming": true,
  "supportsMultimodal": false
}
```
注意：`supportsToolCalls` 只影响 IDE 的 UI 能力展示与请求路由，**不改变 LS 的工具调用解析范式**——对自定义模型 LS 始终走 prompt-based 工具调用（见 [2.4 节](#24-工具调用prompt-based-解析与-prompt-xml-交付)与 [坑 25](#坑-25终极范式ls-对自定义模型只解析响应文本中的-prompt-xml-标记functioncall-part-被忽略)）。

#### 3. 分组注入规则
* **必须追加到 `agentModelSorts[0].groups[0].modelIds` 末尾**：前端只渲染第一个 Recommended 分组中的模型，独立分组会被前端忽略（详见 [坑 6](#坑-6前端仅渲染-agentmodelsorts-第一个分组)）。
* **名称与 Slug 原样保留（不做字符替换）**：`displayName` 与 `toSlug()` 生成的 slug（`extm-*`）均**原样保留**用户配置，不会将 `flash`/`pro`/`low`/`high` 等词汇替换为 `fx`/`pr0`/`l0w`/`h1gh`。Tier 归类紊乱由上层元数据兜底：注入条目补齐完整字段且 `thinkingLevel: 0`（`UNSPECIFIED`），前端不再因关键词归类而崩溃或过滤（见 [坑 7](#坑-7字段缺失导致官方-lowmediumhigh-子菜单-nan-崩溃) 与 [坑 8](#坑-8protobuf-枚举类型不匹配thinkinglevel-必须为-int32-数字)）。
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

### 2.4 工具调用（prompt-based 解析与 prompt-XML 交付）

#### 0. 核心范式：LS 对自定义模型走 prompt-based 工具调用（坑 25，2026-09-04 终局结论）

**这是整个项目最关键的机制认知**，此前十余轮修复失败均因对该范式认知错误。实测抓包（`streamGenerateContent` 请求体 dump）证实：

1. **LS 发给自定义模型的请求没有 `tools` 字段**。工具定义以如下形式写在 systemInstruction 文本里（90KB system prompt）：
   ```
   10. run_command:
   <run_command>
   {"$schema":"...","properties":{...},"required":[...]}
   </run_command>
   ```
2. system prompt 明文指示模型：
   > "Formulate your tool calls using the xml and json format specified for each tool. **The tool name should be the xml tag surrounding the tool call. The tool arguments should be in a valid json inside of it.**" 且 "ALL tool calls at the END of your message."
3. 因此 **LS 在响应侧只解析模型输出【文本】中的 `<tool_name>{json}</tool_name>` 块**——对占位模型（`MODEL_PLACEHOLDER_Mxxx`）的 functionCall part **一律忽略**。

**推论（代理的正确职责）**：
- **解析**：上游模型的文本标记（DSML/`<tool_call>`/裸标签/lean 体等）→ 归一化、参数校验、metadata 合成；
- **交付**：序列化回 LS 期待的标准 prompt-XML 文本块 `<name>\n{json}\n</name>`（`src/proxy/translators/prompt-xml.ts` 的 `serializeToolCallsAsPromptXml`），作为**普通 text part** 输出——**绝不交付 functionCall part**；
- **工具名/参数表注册**：请求无 `tools` 字段时，从 systemInstruction 文本中提取 `name:\n<name>\n{...schema...}` 定义段（平衡花括号扫 JSON），注册到 `modelToolNames` / `modelToolSchemas`，保证响应侧解析器有完整名称表；
- **反向链路**：无原生 `tool_calls` 历史时，`functionResponse` 转为 **user 文本**（`[Tool result for <name>]\n{...}`）回传上游——与 prompt 约定"After each tool use, the user will respond with the result of that tool use"一致；仅当会话历史中确有 assistant `tool_calls` 时才走 tool role 通道。

#### 1. DeepSeek DSML 标签解析
针对 DeepSeek 等模型在输出中以自定义 XML 形式返回工具调用的情况：
```xml
<DSML|invoke name="search_web">
  <DSML|parameter name="query" string="true">latest AI news</DSML|parameter>
</DSML|invoke>
```
解析器（`parseDSMLToolCalls`，多 Pass 扫描）捕获该模式，归一化后以 prompt-XML 文本块交付，并从文本流中剔除原始 XML 标记（防泄漏）。

**演进变体**：部分宿主（如商汤 SenseNova 的 `deepseek-v4-flash`）把同一结构包进容器，改用 `<DSML|tool_calls> ... <DSML|tool_call name="..."> ... </DSML|tool_call> ... </DSML|tool_calls>`；还会随机把 `|` 输出为全角 `｜`（坑 17）。解析器统一匹配，流式阶段对未闭合块 hold 住原始标记，块闭合后统一交付。对应回归用例见 `src/__tests__/openai.regression.test.ts` 的 g6/g6b。

#### 2. 原生工具调用转换与参数归一化
* **OpenAI** `tool_calls` 与 **Anthropic** `tool_use` 会双向映射为 Gemini 的 `functionCall` / `functionResponse`。
* 内置参数别名归一化（如把模型输出的 `absolute_path`、`filePath` 映射为 Antigravity 预期的 `AbsolutePath`）。

#### 3. 内容解析与工具调用往返一致性（[`src/proxy/translators/openai.ts`](file:///d:/programme/antigravity-add-model/src/proxy/translators/openai.ts)）

OpenAI 兼容自定义模型（`openai` / `custom` / `openrouter` / `ollama` 等）的响应内容由 `mapOpenAIToGemini`（非流式）与 `mapOpenAIChunkToGemini`（流式）翻译为 Gemini `candidates[].content.parts`。为保证工具调用能正确往返、且不丢失任何内容，翻译器遵循以下规则：

1. **所有工具调用统一走 prompt-XML 文本交付（坑 25）**。解析出的调用（含 native `tool_calls`）全部经 `buildFunctionCallParts` 单点出口：翻译改名（`translateToolCallToNative`）→ 注册会话状态（`modelToolCallIds`/`translatedToolCalls`，供历史往返与参数回译）→ `serializeToolCallsAsPromptXml` 序列化为 `<name>\n{json}\n</name>` 文本 part。toolSummary/toolAction 为 LS schema 必填参数，交付前由 `sanitizeToolMetadata` 保证存在且合法。
2. **`reasoning_content` / `reasoning` 与工具调用共存**。即使响应同时包含思考链与 `tool_calls`（或 DSML），翻译器也会把 `reasoning_content` 作为 `thought: true` 的 part 置于正文之前，而非整段丢弃。
3. **流式分块中 reasoning 与 content 同 chunk 不互斥**。流式 `delta` 若同时携带 `reasoning_content` 与 `content`，两者分别以 `thought` part 与普通 `text` part 一并输出，避免因提前 `return` 丢失正文。流式结束（`stop` / `length` / `tool_calls`）时会统一补齐未清空的累积文本与待发射的 reasoning。

对应回归用例见 `src/__tests__/openai.test.ts` 与 `src/__tests__/openai.regression.test.ts`（g6/g6b 全角 DSML、g7a-d metadata 合成、g8 同帧双块、k1-k3 多调用、j1 半截标签重拼等 50 项回归）。

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
> 视觉与思考能力判定：`modelUtils.ts` 的 `detectModelCapabilities()` 支持通过配置中的 `supportsImages` / `supportsThinking` 字段显式指定（最高优先级），或在未指定时根据模型名称与 Provider 智能推断。代理会将该能力向 Antigravity IDE 声明并自动完成多模态视觉协议转换。

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

#### 脚本自动化执行阶段（共 10 步，从 0 开始编号，与脚本内 `[N/9]` 输出一致）：
0. **环境检查**：验证 `out\main.js` 存在，读取 `resources\app\package.json` 确认名称/版本与 ESM（`type: "module"`）；非 ESM 时提示注入方式可能需调整；
1. **编译构建**：在当前目录执行 `npm run build` 生成 `dist/`；
2. **终止进程**：强制终止 `Antigravity IDE` 与 `language_server_windows_x64` 进程（避免文件占用）；
3. **安全备份**：将 `main.js`、`workbench.desktop.main.js`、`product.json` 及语言服务器 exe 备份至 `resources\app_backup\`（附带 `rollback.ps1`）；
4. **部署代理模块**：将代理运行时文件复制到 `resources\app\out\proxy\`，并在该目录安装 `electron-log`；自动对已部署的 `proxy.js` 应用 `transfer-encoding` 修复补丁，并生成 `bootstrap.js`；
5. **主进程注入**：在 `out\main.js` 顶部插入动态导入代码：
   ```js
   /* antigravity-add-model bootstrap */
   import('./proxy/bootstrap.js').catch(function(e){console.error('[agy-proxy] import failed',e);});
   ```
6. **前端补丁与哈希同步**：修复 workbench 模型选择器高度/滚动/宽度（`max-h-80`→`min(85vh, 600px)`、移除 `scrollbar-none`、`max-w-80`→`max-w-96`），并同步重算 `product.json` 的 `checksums`；
7. **写入用户设置**：向 `%APPDATA%\Antigravity IDE\User\settings.json` 写入本地代理端点（种子值，幂等）：
   ```json
   "jetski.cloudCodeUrl": "http://127.0.0.1:50999/v1internal/xxxxxxx"
   ```
   > [!NOTE]
   > 该端点常驻为默认端口 `50999` 的种子值；**代理实际启动时会通过 `syncSettingsJson` 将其自动校正为真实监听端口**（无论是 50999 还是动态回退端口），因此此处只保证键存在即可。
8. **LS 二进制补丁（可选）**：将语言服务器 exe 内的硬编码 URL 替换为本地代理（用 `-SkipBinaryPatch` 跳过；此架构下非必需）；
9. **初始化与启动**：创建 `~/.gemini/antigravity/custom_models.json`（若不存在），启动 IDE 并请求 `http://127.0.0.1:50999/health` 验证服务状态（`-OpenDashboard` 时自动打开可视化面板）。

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

### 3.4 可视化配置与连通性测试面板（Web Dashboard & RESTful API）

为解决 VS Code Fork 独立版中手动编辑 `custom_models.json` 容易产生格式/Schema 错误且无法排障连通性的痛点，本地代理服务（`http://127.0.0.1:<active_port>`，默认 `50999`）原生集成了**可视化模型管理面板与连通性探测引擎**：

* **访问入口**：`http://127.0.0.1:50999/`（或查阅 `%USERPROFILE%\.gemini\antigravity\dashboard_url`）
* **核心功能**：
  1. **多厂商快速预设**：一键预填 DeepSeek、OpenAI、Claude 3.5、Ollama、OpenRouter、Google AI Studio、硅基流动、商汤日日新、月之暗面等厂商标准 API Endpoint 与协议规则。
  2. **实时连通性探测**：发送真实握手测试，测量网络 RTT 延迟（毫秒），并针对 401（Key 无效）、403（IP/权限拦截）、404（路径/模型名错误）、429（额度超限）、ECONNREFUSED（Ollama 未启动）等提供中文排障诊断与修复建议。
  3. **一键测速全部**：批量测试所有已配置模型并展示状态汇总。
  4. **双向编辑模式**：支持表单级交互与 Raw JSON 语法高亮校验编辑器。
  5. **即时热重载**：保存后自动执行 Schema 校验、`safeStorage` 密钥加密与 `.bak` 备份，并即时热重载代理内存模型池，无需重启 IDE。

#### 代理内置 RESTful API 路由清单

| Method | Endpoint | 说明 |
| :--- | :--- | :--- |
| `GET` | `/`、`/dashboard`、`/ui`、`/index.html` | 返回可视化管理 Web 面板单页应用 (SPA) |
| `GET` | `/health`、`/healthz` | 健康检查：返回 `status`、运行时长、监听端口、内存占用与代理状态快照 |
| `GET` | `/api/status` | 获取代理运行状态（端口、内存占用、加密状态、配置路径等） |
| `GET` | `/api/models` | 获取模型列表视图（含脱敏 API Key、能力元数据与 Schema 校验状态） |
| `POST` | `/api/models` | 新增或更新自定义模型（自动 Schema 校验、加密与文件备份） |
| `POST` | `/api/models/batch` | 批量新增自定义模型：按 `name`/`externalModelName` 对本地去重并跳过重复项，单次原子写入（用于「自动获取模型 → 批量添加」流程） |
| `DELETE`| `/api/models` | 删除指定模型配置 |
| `POST` | `/api/models/test` | 对指定模型配置执行连通性探测，返回延迟与诊断信息 |
| `POST` | `/api/models/discover` | 探测上游 `/models` 接口并返回模型列表；每个模型标注 `exists`（是否已在本地配置）便于前端去重展示 |
| `GET` | `/api/models/raw` | 读取 `custom_models.json` 原始 JSON 字符串 |
| `PUT` | `/api/models/raw` | 校验并覆盖写入 `custom_models.json` |

---

## 四、踩坑实录与深度排障（1~25 坑完整收录）

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

### 坑 11：Web 面板打不开 / 返回 Google 404（部署副本过期）

* **症状**：浏览器访问 `http://127.0.0.1:50999/` 显示 **Google 官网风格 404**（响应头 `server: scaffolding on HTTPServer2`、`alt-svc: h3=":443"`），而不是自检面板页面；代理日志无任何面板路由命中记录。
* **根因**：IDE 安装目录 `resources\app\out\proxy\` 中正在运行的代理是**旧构建**，早于 Web 面板特性（`dashboardHtml.ts` / `connectionTest.ts` / `modelConfigManager.ts`）。旧 `proxy.js` **没有 `/` 面板路由**，因此对 `/` 的请求落入 Cloud Code 透传分支，被转发到 Google 官方端点而返回其 404。典型触发场景：代码更新（新增面板后）未重新部署，或 IDE 自动更新覆盖了 `out\proxy\`（见 README「每次 IDE 更新后」）。
* **鉴别**：前往 `resources\app\out\proxy\proxy\` 目录，若**缺少** `dashboardHtml.js`、`connectionTest.js`、`modelConfigManager.js` 即为旧构建；也可比对 `out\proxy\proxy.js` 的修改时间与新 `dist\proxy.js`，二者不一致即过期。
* **修复**：重新部署即可恢复 —— 关闭 IDE 后重新执行：

  ```powershell
  .\deploy-ide.ps1 -IdePath "C:\Users\<User>\AppData\Local\Programs\Antigravity IDE"
  ```

  部署脚本会用新编译的 `dist` 覆盖 `out\proxy\`（含面板三部曲模块），并重启代理。完成后用 `Invoke-WebRequest http://127.0.0.1:50999/` 应返回 HTTP 200 与 `<!DOCTYPE html>`（约 68 KB SPA），即面板恢复。
* **预防**：修改涉及 `src/proxy.ts`、`src/proxy/dashboardHtml.ts` 等代理源码后，务必重新运行 `deploy-ide.ps1`；IDE 自动更新后同样需重跑。任何情况下不要手工只改 `out\main.js` 注入而跳过代理模块部署。

---

### 坑 12：GLM-5.2 / SenseNova 等模型在文本流中输出原始 `<tool_call>` 标签导致泄漏且工具不执行

* **症状**：自定义接入 GLM-5.2、商汤 SenseNova、Hermes、Qwen 或其他 OpenAI 兼容模型时，模型回复直接把 `<tool_call>list_dirDirectoryPath":"d:\programme\..."toolAction":"..."toolSummary":"..."}` 或 `<tool_call>view_file\n{"AbsolutePath": "..."}</tool_call>` 作为普通纯文本输出到聊天界面，IDE 未能识别并自动执行对应工具。
* **根因**：部分模型 / API 网关（如 GLM-5.2、ChatGLM 系列、部分开源模型微调格式）未走标准的 OpenAI `choices[0].delta.tool_calls` 结构体，而是在 `content` 文本流中输出原生 `<tool_call>`、`<function_call>` 或未带起始大括号 `{` 的拼接键值对字符串。代理层原先仅支持 DeepSeek 格式的 `<DSML|...>` 匹配且只 hold back `<DSML|` 标记，导致其他模型发出的 `<tool_call>` 原始标记在流式阶段直接透传泄漏至前端，且在流结束时未能提取出 Gemini 标准的 `functionCall`。
* **修复**：
  1. 在 `src/proxy/translators/openai.ts` 中实现通用文本工具调用解析引擎（`parseDSMLToolCalls` / `parseTextToolCalls`），覆盖 DSML、XML 命名标签、Hermes/Qwen JSON 对象、GLM 拼接参数以及 Antigravity 原生 `<call:default_api:...>` 格式；
  2. 实现流式实时 Holdback 拦截列表（`TOOL_CALL_START_MARKERS`），在流式传输阶段遇到任何未闭合的工具调用标签时先 hold 住原始标记（仅发射标签前的导引正文），彻底防止 `<tool_call>` 等标签在界面闪烁泄漏；
  3. 流式结束或标签闭合后，自动将解析出的工具名与参数归一化为标准的 Gemini `functionCall` 并返回 `finishReason: "STOP"`，驱动 IDE 自动调用相应工具。
* **演进变体补充（2026-09-02）**：模型还会输出两种此前未覆盖的形态，均可能在流式阶段泄漏为可见文本或导致工具不执行：
  * **非对称闭合标签**：`<tool_call:list_dir>{...}</list_dir>`（闭合标签只写函数名、丢掉 `tool_call:` 前缀）。`tagNamedRegex` 要求闭合标签还原前缀，故不匹配。新增 `asymTagNamedRegex` 允许闭合标签仅回写函数名，单独作为 Pass 3b 处理。
  * **XML 内嵌参数**：裸标签 `<view_file>\n<AbsolutePath>d:\x\README.md</AbsolutePath>\n<IsSkillFile>true</IsSkillFile>\n</view_file>`。`parseArgsFromBlock` 只认 `<parameter>`、JSON、拼接键值对与 `Key>value` 瘦文本，不认 `<Param>value</Param>`。新增 `extractXmlInnerArgs` 提取这类参数。
  * **参数校验过严**：`validateBareArgs` 原先要求所有键都命中声明 schema。真实模型常附带 `IsSkillFile` / `toolSummary` / `toolAction` 等元数据键导致误拒。放宽为「至少有一个键命中声明 schema」才拒绝，避免误丢合法调用。
  * **反斜杠路径被 JSON 转义**：模型未转义的 Windows 路径（如 `...\src\translators`）里的 `\t`/`\n` 会被 `JSON.parse` 误转义。`extractJsonObject` 的恢复分支未命中时，把所有 `\x` 当路径分隔符处理，避免参数被破坏。
* **流式发射回归修复（2026-09-02 晚）**：前期为加固标签 Holdback 引入了 `emittedLen` / 多标记边界（bare-tag 标记 + `startMarkers`）的流式发射逻辑，反而导致 sensenova / GLM 在模型流式输出工具调用（如 `run_command`）后被 IDE 提前结束（工具未执行、随即切回内置模型）。已把 `mapOpenAIChunkToGemini` 的**流式发射逻辑还原为 HEAD~1（6f342da）的版本**（仅持有 `TOOL_CALL_START_MARKERS`，不再累计 `emittedLen`、不再把 bare-tag 纳入流式 Holdback），并**保留解析层的全部修复**：非对称闭合标签、`extractXmlInnerArgs`、`validateBareArgs` `some()` 放宽、反斜杠路径。这样既恢复此前可用的工具调用交付（模型发出的 `run_command` → 正确归一化 → 发射 `functionCall` + `STOP`），又保留了对 leak 的解析能力。真实请求验证：`run_command "ls -la"` → `list_dir`，正常发射 `functionCall`。

---

### 坑 13：自定义模型回答过程中自动结束（finishReason 与多轮 content 丢弃）

* **症状**：自定义模型在执行完第 1 轮工具调用后，第 2 轮输出思考或一两句话（如“让我深入了解项目的核心代码文件。”）后，直接弹出点赞/点踩按钮，任务意外终止，后续工具（如 `view_file`）未被执行。
* **根因**：
  1. **Protobuf 枚举不匹配**：在 Gemini 官方规范中，模型在流式结束或产生 `functionCall` 时，`finishReason` 的 Protobuf 枚举为 `STOP`（或 `OTHER`）。代理层先前误将其包装为 `'TOOL_CALL'`。Antigravity 的 Go 语言服务器（`language_server_windows_x64.exe`）通过 `protojson` 反序列化时由于枚举表中不存在 `TOOL_CALL`，导致整段响应 candidate 解析失败被丢弃，IDE 误以为生成已终止；
  2. **多轮对话上下文丢失**：在 `mapGeminiToOpenAI` 中，当 `item.role === 'model'` 且包含 `hasFunctionCall` 时，先前代码将 `messages.push({ role: 'assistant', content: null, ... })`，强行将上一轮模型的发言正文与思考过程丢弃（置为 `null`）。这导致上游模型在多轮会话中语境断裂，无法连贯判断后续工具调用动作。
* **修复**（[`src/proxy/translators/openai.ts`](file:///d:/programme/antigravity-add-model/src/proxy/translators/openai.ts) & [`src/proxy/translators/anthropic.ts`](file:///d:/programme/antigravity-add-model/src/proxy/translators/anthropic.ts)）：
  1. 将 OpenAI / Anthropic 翻译器中所有工具调用的 `finishReason` 从 `'TOOL_CALL'` 严格规范化为 Gemini 官方 Protobuf 标准的 `'STOP'`；
  2. 在 `mapGeminiToOpenAI` 中，`hasFunctionCall` 分支下完整保留并提取上一轮模型的正文 `content` 与 `reasoning_content`，确保多轮上下文完整连贯传给上游大模型。

---

### 坑 14：多工具/并行工具调用（Explored N folders）后 ID 错乱导致模型直接停止

* **症状**：自定义模型（如 GLM-5.2、DeepSeek、SenseNova）在执行完并发工具调用（如一次探索了 3 个文件夹 `Explored 3 folders`）后，在下一轮思考一句（如“现在让我查看核心代码文件。先从入口和配置开始。”）后立即无后续动作直接停下，弹出点赞点踩按钮。
* **根因**：
  1. **同名并行 Tool Call ID 覆盖**：先前代码使用标量字典 `lastCallIdByName[funcName] = callId` 记录 ID。当模型在同一轮发起 3 个同名工具调用（例如 3 个 `list_dir`）时，`lastCallIdByName['list_dir']` 会被连续覆写，最终只保留第 3 个 ID。紧接着在解析 3 个 `functionResponse` 时，全部取到了第 3 个 ID，导致构造给上游大模型的上下文出现 `tool_call_id` 重复且前 2 个工具调用缺失返回值，上游模型上下文混乱或返回 HTTP 400 并终止循环；
  2. **Math.random() 历史失步**：Gemini 上下文重传时未持久化 `id`，代理每次重新随机生成 ID，导致不同轮次间 `assistant.tool_calls` 与 `tool.tool_call_id` 匹配断裂；
  3. **Thinking 模型 Token 预算过低**：默认 `maxOutputTokens: 4000` 在深度思考模型生成长 reasoning 时被消耗殆尽，触发 `length` 截断。
* **修复**（[`src/proxy/translators/openai.ts`](file:///d:/programme/antigravity-add-model/src/proxy/translators/openai.ts) & [`src/proxy/translators/anthropic.ts`](file:///d:/programme/antigravity-add-model/src/proxy/translators/anthropic.ts)）：
  1. 引入严格的 FIFO 队列与双向索引机制（`pendingCallsQueue` + `allCallsById`），无论单次发起多少个同名或异名并行工具调用，均能 1-to-1 精确按序匹配对应 `tool_call_id`；
  2. 使用基于位置索引的确定性 ID 规则（`call_{itemIdx}_{partIdx}_{funcName}`），杜绝跨轮重新生成导致的 ID 错位；
  3. 为思考/GLM/DeepSeek/SenseNova 模型自动扩充 `max_tokens` 默认上限至 `16384`。

---

### 坑 15：toolSummary / toolAction / WaitMsBeforeAsync 被误判为"代理私有元数据"而剥除

* **症状**：functionCall 帧到达 LS 但工具不执行，会话库无调用记录，随后回退内置模型。LS 报错串：`missing or invalid toolSummary in arguments`。
* **根因**：这三个键**不是代理私有元数据，而是 IDE 工具 schema 的必填参数**（官方 Gemini 帧的 args 始终携带）。此前在解析层剥除导致 args 缺 required 字段，LS 直接丢弃整个调用。
* **修复**：`sanitizeToolMetadata` 在全部交付路径保证两键存在且值合法（缺失或含乱码特征时按官方风格合成英文短描述）；`run_command` 缺 `WaitMsBeforeAsync` 时补 `5000`（官方帧观察值）。

---

### 坑 16：跨 chunk 半截标签导致下一块整段泄漏

* **症状**（真实 10:52 流）：上游把标签拆成 `<` + `run_command>` 跨 chunk 发送，块解析消费后 cleanText 尾部残留孤立 `<`，下一帧 `run_command>` 拼不回开标签 → 整块参数作为正文泄漏且第二个调用丢失。
* **修复**：半截标签尾从 accumulatedText 移入 `pendingHeldSuffix`（打 `heldSuffixDetached` 标记），下一帧重拼前先补回，走既有 heldSuffix 通道。

---

### 坑 17：全角竖线 DSML 变体（2026-09-04 11:25 真实商汤流）

* **症状**：上游随机把 `<|DSML|...>` 输出为 `<｜DSML｜...>`（U+FF5C 全角竖线），结构变为 `<｜DSML|tool name="X">` + `</｜DSML｜invoke>` 闭、外层多余 `</｜DSML｜tool_call>`。整段泄漏为正文、0 个工具调用。
* **修复**：流式帧文本入口即归一化（`normalizeDSMLPipes`：全角 `｜` → ASCII `|`），保证 accumulatedText、holdback、块解析整条链路只处理 ASCII 形态。

---

### 坑 18：toolSummary/toolAction 乱码（GBK 双重解码）→ 合成替换

* **症状**（11:31 真实流）：商汤服务端对参数区中文做 GBK 双重编码（`查看` → `鏌ョ湅`，甚至含 U+FFFD 截断符），LS 判 `invalid` 丢弃整个调用。
* **修复**：`METADATA_MOJIBAKE_RE` 检测假名/全角拉丁/U+FFFD/GBK 双重解码高频字特征，命中即合成替换；干净中文值保留不误杀。

---

### 坑 19：functionCall 帧与 finishReason 同帧被 LS 忽略

* **症状**：代理按官方信封包装调用帧（含 finishReason: STOP），LS 视为终帧并把其中的调用丢弃（stopReason=STOP_PATTERN 遗留路径）。
* **根因**：官方流中**调用帧 candidate 只含 content（无 finishReason、无 index）**，终止由独立的空文本 STOP 帧（`parts:[{text:""}]`）下发。
* **修复**：拆帧交付——调用帧（仅 content）+ 独立 STOP 收口帧。注意：坑 25 落地后交付为纯文本，此拆帧逻辑不再触发（保留无害）。

---

### 坑 20 → 23：thoughtSignature 宁缺勿假

* **症状**：伪签名导致整个 part 被丢弃（13:08/13:29 实测复现两次）。
* **根因**：LS 对缺失签名不校验（官方 claude-sonnet-4-6 BYO 透传帧**没有** thoughtSignature 照样执行）；对**存在**的签名会验签，伪造的 Base64 串解不出合法结构 → part 判非法 → 丢弃。
* **结论**：`SYNTHETIC_THOUGHT_SIGNATURE` / `withThoughtSignature` 彻底移除。**签名宁缺勿假**。

---

### 坑 21：cleanText 误删下一在途块的开标签

* **症状**（12:51 截图）：`</view_file>\n\n<run_command>\n` 同帧到达，cleanText 的裸标签正则把未闭合的 `<run_command>` 删掉 → 整个下一块作为正文泄漏。
* **修复**：只删除**闭合**的裸标签对 `<(?:names)>[\s\S]*?</(?:names)>` 与孤立的闭标签残余；未闭合开标签必须保留（它是后续 alreadyInsideToolBlock / bare 边界检测的依据）。

---

### 坑 22：调用帧 response 级元数据缺失

* **修复**：对照官方 claude-sonnet-4-6 BYO 透传帧逐字段补齐——`usageMetadata`（从上游 SSE usage 尾帧取真实 token 数）、`modelVersion`、`responseId`；`traceId` 用非空会话派生值。

---

### 坑 24：supportsToolCalls 顶层平铺无效（嵌套消息字段）

* **症状**：注入条目加 `supportsToolCalls: true` 顶层字段无效，LS 仍无工具能力。
* **根因**：proto 描述符中 `ModelInfo.model_features` 是独立嵌套消息；Go LS 按 protojson 嵌套路径取值，顶层平铺读不到。
* **修复**：注入完整嵌套 `modelFeatures` 对象（27 字段，最小集见 [2.1 节](#21-fetchavailablemodels-拦截与注入规范)）。**注意**：该字段只影响 IDE UI 能力展示与请求路由，**不是**工具调用解析的开关——真正的解析范式见坑 25。

---

### 坑 25（终极范式）：LS 对自定义模型只解析响应文本中的 prompt-XML 标记，functionCall part 被忽略

* **症状**（历时最久）：自定义模型输出 thinking + 一句话后提前结束，工具从不执行。此前 13 轮修复（拆帧/伪签名移除/元数据补齐/traceId/modelFeatures 嵌套注入……）全部无效。
* **根因**（请求体 dump 铁证）：LS 发给自定义模型的请求**没有 `tools` 字段**——工具定义全部写在 systemInstruction 文本里（prompt-based tool calling），且明文指示模型"工具名是包裹调用的 XML 标签、参数是其中的合法 JSON"。LS 在响应侧**只解析文本**中的 `<tool_name>{json}</tool_name>` 块，对占位模型的 functionCall part 一律忽略。代理把模型输出的文本标记消费掉、重建成 functionCall part 交付，恰好消灭了 LS 唯一会解析的东西。
* **修复**（范式级，2026-09-04 终局）：
  1. 新增 [`src/proxy/translators/prompt-xml.ts`](file:///d:/programme/antigravity-add-model/src/proxy/translators/prompt-xml.ts)：`serializeToolCallsAsPromptXml` 把解析出的调用序列化回标准 `<name>\n{json}\n</name>` 文本；
  2. `buildFunctionCallParts` 改为单点出口：翻译改名 → 注册会话状态 → 文本交付（流式 5 条路径 + 非流式 2 条路径全部收敛）；
  3. 请求无 tools 字段时从 systemInstruction 提取 `name:\n<name>\n{schema}` 定义段（平衡花括号扫 JSON），注册 `modelToolNames`/`modelToolSchemas`；
  4. 反向链路：无原生 tool_calls 历史时 functionResponse 转 user 文本（匹配 prompt 约定）。
* **验证**：商汤 V4 Flash 发 `gc`（Git 自动提交技能）→ view_file + run_command 工具芯片弹出并真实执行，完整流程跑通；286/286 测试通过。
* **教训**：**排查第三方宿主行为时，优先抓真实请求体/响应体做对照，而不是反复试探响应格式**——本次靠恢复请求体 dump 一步定位。

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
- [ ] **工具执行验证（坑 25 终极标准）**：让自定义模型执行一个需调用工具的任务（如读文件/跑命令）。`main.log` 应出现 `Detected N text tool call(s)`，且 IDE 界面弹出工具执行芯片并真实执行（而非回复一句话后提前结束）。若工具不执行：优先 dump `streamGenerateContent` 请求体确认请求形态，再核对响应交付的是 prompt-XML 文本（`<tool_name>{json}</tool_name>`）而非 functionCall part。
- [ ] 调试开关：建 `~/.gemini/antigravity/raw_stream.flag` 文件可开启 `[Proxy][RAW:*]`（上游原文）/`[Proxy][MAP:*]`（映射结果）流日志；删除即关闭。

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

### 5.3 便捷切换与一键回滚

#### 1. 一键开启 / 暂停代理（无需卸载，即时生效）
若仅需临时停用代理并切回 Google 官方纯净原生模式（或重新开启），运行：
```powershell
.\toggle-proxy.ps1                  # 自动切换状态
.\toggle-proxy.ps1 -Action Disable   # 暂停代理
.\toggle-proxy.ps1 -Action Enable    # 开启代理
```
*(或直接双击根目录下的 `toggle-proxy.bat`)*

#### 2. 一键彻底卸载回滚（恢复纯净官方文件）
若需彻底清理代理注入并恢复所有原版文件，执行：
```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\resources\app_backup\rollback.ps1"
```
该脚本将自动还原 `main.js` 与语言服务器二进制文件，并清理 `out\proxy` 注入目录。随后只需手动删除 `settings.json` 中的 `jetski.cloudCodeUrl` 项。

---

## 六、已知限制与优化

1. **自动更新覆盖**：Antigravity IDE 自动更新会重写 `out\main.js` 与渲染层文件，更新后重新运行一次 `.\deploy-ide.ps1` 即可恢复（`settings.json` 与 `custom_models.json` 会永久保留）。
2. **前端选择器多模型支持（已完美优化）**：早期版本由于前端下拉面板 `POu` 的 `max-h-80`（320px）与 `scrollbar-none` 限制，导致第 4 个及以后的自定义模型被视觉遮挡。当前部署流程会自动对 `workbench.desktop.main.js` 应用高度与滚动补丁（扩展至 `min(85vh, 600px)` 并启用平滑滚动条，同步更新 `product.json` 校验哈希），已支持同时配置 20+ 个自定义模型无限制浏览与选用。**注意**：IDE 自动更新会重写该文件导致补丁失效，更新后需重新运行 `.\deploy-ide.ps1`。
3. **名称关键字过滤（已解除）**：早期版本自定义模型的 `displayName` 含 `flash`/`lite`/`pro`/`low`/`high`/`tier` 等分级词汇会被前关键词清洗为 `fx`/`pr0` 等变体。现注入条目已补齐完整元数据且 `thinkingLevel: 0`，显示名称与 slug 均**原样透传**，不再清洗，也不会再被分级过滤（见 [坑 7](#坑-7字段缺失导致官方-lowmediumhigh-子菜单-nan-崩溃)）。
4. **同名上游模型 id**：不同提供商的模型若 `externalModelName` 相同，`toSlug()` 已按 `displayName` 优先生成互不相同的 slug（见 [坑 10](#坑-10多自定义模型仅显示-n-1-个同名-slug-覆写)），但**同一配置内 `displayName` 不宜重复**，否则仍会因 slug 冲突而丢失模型。
5. **图像输入取决于模型视觉能力**：代理会正确构造 `image_url` / `type: "image"` 结构（见 [2.7 节](#27-多模态视觉vision-输入处理)），但图像能否被“看见”仍取决于所用模型是否支持视觉。对不支持图像的模型（如部分 DeepSeek、Llama 文本模型），图像内容块可能被上游忽略或报错。

