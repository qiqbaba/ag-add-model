# Antigravity 自定义模型启用器

> ## Antigravity IDE（VS Code Fork）部署方案
> 本仓库为 **Antigravity IDE 独立版**（解包式 `resources\app`，VS Code Fork 架构）提供一键部署：
>
> - 📖 **[DEPLOY_ANTIGRAVITY_IDE.md](./DEPLOY_ANTIGRAVITY_IDE.md)** — 完整部署指南（ESM 注入、`jetski.cloudCodeUrl`、Schema 要求、5 个已踩坑与修复）
> - ⚙️ **`deploy-ide.ps1`** — 一键自动化部署脚本（含备份与回滚）
>
> ```powershell
> .\deploy-ide.ps1 -IdePath "C:\Users\21855\AppData\Local\Programs\Antigravity IDE"
> ```

本仓库包含一个针对 **Google Antigravity** 的补丁，可在内置 Gemini 模型之外启用外部 AI 模型（OpenAI、Anthropic、Together API、Ollama、Google AI Studio 以及任何 OpenAI 兼容的提供商）。它向 Electron 应用注入一个本地 HTTP 代理，逆向工程 Cloud Code 内部 API（`v1internal`），在各提供商格式之间翻译请求/响应，并在设置页提供内联的“添加模型”UI。

## 工作原理

### 架构

```
Antigravity IDE
  └── Language Server（Go 二进制）
        └── --api_server_url → http://127.0.0.1:50999（本地代理）
                                   ├── Google 模型 → daily-cloudcode-pa.googleapis.com
                                   └── 自定义模型 → 外部 API（Together、OpenAI 等）
```

### 关键组件

#### 代理核心
| 文件 | 作用 |
|---|---|
| [proxy.ts](src/proxy.ts) | 本地 HTTP 代理：拦截 Cloud Code API、合并自定义模型、翻译提供商格式、包装响应 |
| [registry.ts](src/proxy/registry.ts) | 自动发现式翻译器注册表，动态加载 `openai`、`anthropic`、`google`、`ollama` 翻译器 |
| [shared.ts](src/proxy/shared.ts) | 跨轮次状态管理，带自动 TTL 清理 |
| [modelUtils.ts](src/proxy/modelUtils.ts) | 集中式模型能力检测（thinking、DeepSeek、Claude） |

#### 格式翻译器
| 文件 | 作用 |
|---|---|
| [openai.ts](src/proxy/translators/openai.ts) | OpenAI ↔ Gemini 格式翻译（请求、响应、流式分块、工具调用） |
| [anthropic.ts](src/proxy/translators/anthropic.ts) | Anthropic ↔ Gemini 格式翻译（Claude tool_use、SSE 流式、thinking 支持） |
| [google.ts](src/proxy/translators/google.ts) | Google AI Studio 透传，带流式端点路由 |
| [ollama.ts](src/proxy/translators/ollama.ts) | Ollama ↔ Gemini 格式翻译（OpenAI 兼容的本地 LLM） |
| [utils.ts](src/proxy/translators/utils.ts) | 翻译器共享工具（工具调用映射、DSML 解析、参数类型修正） |

#### 安全与数据
| 文件 | 作用 |
|---|---|
| [cryptoStore.ts](src/cryptoStore.ts) | 通过 Electron `safeStorage` 进行 AES-256-GCM API 密钥加密 |
| [schemaValidator.ts](src/schemaValidator.ts) | 对 API 响应、自定义模型、流式分块进行运行时 Schema 校验 |

#### UI 与应用集成
| 文件 | 作用 |
|---|---|
| [preload.ts](src/preload.ts) | UI 注入：设置 → 模型中的自定义模型面板、带动画的内联添加模型弹窗、连通性测试按钮 |
| [main.ts](src/main.ts) | 应用生命周期：拦截并阻断 `SetCloudCodeURL` 请求，防止前端覆盖代理端点 |
| [ipcHandlers.ts](src/ipcHandlers.ts) | 后端 IPC：`storage:get-custom-models`、`storage:save-custom-model`、`storage:delete-custom-model`、`storage:test-model-connection` |
| [languageServer.ts](src/languageServer.ts) | 改造后的语言服务器管理器，应用启动时拉起代理 |

#### 部署脚本
| 文件 | 作用 |
|---|---|
| [deploy-ide.ps1](deploy-ide.ps1) | Antigravity IDE（VS Code Fork）— 一键部署：构建、备份、注入 ESM bootstrap、写入 `jetski.cloudCodeUrl`、（可选）LS 补丁 |
| [DEPLOY_ANTIGRAVITY_IDE.md](DEPLOY_ANTIGRAVITY_IDE.md) | 完整 IDE 部署指南：架构、关键技术点、已知坑、验证清单、回滚 |

> [!NOTE]
> 所有源码位于 `src/`（TypeScript），通过 `npx tsc` 编译到 `dist/`。`deploy-ide.ps1` 脚本将所需运行时文件复制到 `resources\app\out\proxy\`（解包式布局，无 `app.asar`）。

### Cloud Code API 逆向工程

Antigravity 使用 Google 的 **Cloud Code 内部 API**（`v1internal:*` 端点）而非公开 Gemini API。代理处理以下差异：

1. **fetchAvailableModels**：拦截并注入自定义模型定义。自定义模型 slug 被加入 `agentModelSorts`，从而出现在聊天模型下拉列表中。自定义模型省略配额信息，因为它们使用用户自己的 API 密钥。

2. **streamGenerateContent/generateContent**：Cloud Code 把 Gemini 请求包在一个 `request` 字段里：
   ```json
   {
     "project": "...",
     "requestId": "...",
     "request": { "contents": [...], "systemInstruction": {...}, "generationConfig": {...} },
     "model": "custom-deepseek-ai-deepseek-v4-pro"
   }
   ```
   代理在格式翻译前先提取出 `request`。

3. **systemInstruction**：Cloud Code 把模型身份/工具定义放在独立的 `systemInstruction` 字段中（不在 `contents` 内）。代理将其映射为 OpenAI 的 `role: "system"` 或 Anthropic 的 `system` 参数。

4. **响应信封**：Cloud Code 把响应包装为 `{"response": {...}, "traceId": "...", "metadata": {}}`。代理镜像该格式，使 IDE 能接受响应。

### 请求/响应流程

```
1. 用户选择自定义模型并发送消息
2. IDE → POST /v1internal:streamGenerateContent?alt=sse → 本地代理
3. 代理检测自定义模型匹配（按 slug 或基于哈希的 MODEL_PLACEHOLDER_* ID）
4. 提取 reqJson.request → 将 systemInstruction + contents 映射为提供商格式
5. POST 到外部 API（如 https://api.together.xyz/v1/chat/completions）
6. 将外部响应映射回 Gemini 格式
7. 包装进 Cloud Code 信封 {"response": {...}, "traceId": "", "metadata": {}}
8. 返回 SSE：data: {envelope}\n\n → IDE 展示响应
```

### 流式修复（关键）

代理区分**元数据请求**（需缓冲以重写 URL）与**生成请求**（必须直接透传流式）。若代理缓冲 `streamGenerateContent` 或 `generateContent` 响应，Go 语言服务器会因等待流结束而超时，导致应用崩溃并提示“terminated due to error”。

- **元数据请求**（`v1internal:*`，不含生成）：缓冲、解压、重写 URL 指回本地代理
- **生成请求**（`streamGenerateContent`、`generateContent`）：直接透传不缓冲，保留实时流式

### SetCloudCodeURL 阻断

Antigravity 前端会周期性调用 `SetCloudCodeURL`，这会用默认 Google API URL 覆盖本地代理端点。`main.ts` 进程通过 `webRequest.onBeforeRequest` 拦截并**取消**这些请求，确保语言服务器始终经由本地代理路由。

### DSML 工具调用解析器

DeepSeek 模型（及部分其他提供商）以自定义的 **DSML**（DeepSeek Markup Language）格式在文本内容中返回工具调用：

```xml
<DSML|invoke name="search_web">
  <DSML|parameter name="query" string="true">latest news</DSML|parameter>
</DSML|invoke>
```

代理自动检测 DSML 块，将其解析为 Gemini 格式的 `functionCall` 对象，并从展示文本中剥离 XML。同时支持原生 OpenAI `tool_calls` 与 Anthropic `tool_use` 块。

### Anthropic 工具调用

Claude 模型（`anthropic` 提供商）以 `tool_use` 内容块返回工具调用。代理将其映射为 Gemini 格式的 `functionCall` 部分，设置 `finishReason: "TOOL_CALL"`，并保存工具调用 ID 以便在后续轮次与 `functionResponse` 对象匹配。流式（SSE `content_block_start`/`content_block_delta`）与非流式响应均已完整处理。

### 安全：API 密钥加密

所有 API 密钥通过 Electron `safeStorage` 以 **AES-256-GCM** 静态加密。`cryptoStore.ts` 模块提供：

- **透明加解密**：密钥在落盘前加密，加载到内存时即时解密。
- **自动迁移**：任何明文 `custom_models.json` 配置都会在首次运行时被自动检测、加密并重写。
- **掩码展示**：UI 中的 API 密钥以 `sk-...XXXX`（仅末 4 位）展示，防止肩窥。
- **系统级密钥存储**：macOS 上 `safeStorage` 使用 Keychain；Windows 上使用 DPAPI。

### 动态端口管理

本地代理使用**动态端口分配**并自动回退：

```typescript
// proxy.ts → startProxy()
server.listen(50999, ...);  // 尝试默认端口
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    server.listen(0, ...);  // 回退：让 OS 选一个空闲端口
  }
});
```

若默认端口 `50999` 已被占用（如被另一实例或残留进程），代理自动回退到随机可用端口（`port: 0`）。`languageServer.ts` 模块读取动态分配的端口并在启动时注入 Go 语言服务器的 `--api_server_url` 参数，确保链路始终连通。

### 并发请求隔离

多个模型可同时发起请求而互不污染。状态以**按模型的 `Map` 结构**隔离，而非共享全局变量：

- `modelToolCallIds`（`Map<modelName, { fnName: toolCallId }>`）将工具调用 ID 跟踪限定在每个模型
- `modelReasoningContent`（`Map<modelName, string>`）将 DeepSeek 推理状态限定在每个模型
- `activeStreamContexts`（`Map<streamId, context>`）将流式累加器限定在每个流

### 自动状态清理

代理状态通过托管的垃圾回收间隔自动清理：
- **流上下文**：TTL 10 分钟
- **工具调用 ID 与推理**：TTL 30 分钟
- 间隔随 `startProxy()` 启动、随 `stopProxy()` 停止，避免遗留定时器

### Schema 校验

`schemaValidator.ts` 模块提供运行时校验，在畸形 API 响应到达 IDE 前端前拦截，避免晦涩报错。导出的校验器包括：

| 函数 | 校验内容 |
|---|---|
| `validateCandidate` | 单个 Gemini candidate 结构 |
| `validateGenerateContentResponse` | 完整 Gemini 响应载荷 |
| `validateCloudCodeEnvelope` | Cloud Code `{ response, traceId, metadata }` 包装 |
| `validateCustomModel` | 单个自定义模型配置（provider 枚举、URL 格式） |
| `validateCustomModels` | 自定义模型配置数组 |
| `validateGenerateContentRequest` | 请求体结构 |
| `validateOpenAiChunk` | OpenAI 流式分块 |
| `validateAnthropicEvent` | Anthropic SSE 事件类型 |

### 模型连通性测试

设置中每个自定义模型都有**“测试连接”**按钮，向模型 API 端点发送轻量请求：

- 快速连通性检查（10 秒超时）
- 绿色 ✅ 或红色 ❌ 状态指示
- 针对常见问题（鉴权、超时、SSL）的有用错误信息
- 通过 IPC 实现：`storage:test-model-connection`

### 请求重试与限流

代理自动以指数退避重试失败请求：

- **触发条件**：429（限流）、502、503、504（服务器错误）
- **退避**：1s → 2s → 4s → 8s（最多 3 次重试）
- **Retry-After**：尊重服务端下发的 `Retry-After` 头
- **可配置**：模型配置中的 `maxRetries` 字段（默认：3）

## 仓库结构

```
antigravity-add-model/
├── src/
│   ├── proxy.ts                   # HTTP 代理 + Cloud Code 拦截器 + 格式翻译
│   ├── proxy/
│   │   ├── registry.ts            # 自动发现式翻译器注册表
│   │   ├── shared.ts              # 跨轮次状态管理 + TTL 清理
│   │   ├── modelUtils.ts          # 集中式模型能力检测
│   │   └── translators/
│   │       ├── openai.ts          # OpenAI ↔ Gemini 翻译器
│   │       ├── anthropic.ts       # Anthropic ↔ Gemini 翻译器
│   │       ├── google.ts          # Google AI Studio 透传 + 流路由
│   │       └── utils.ts           # 翻译器共享工具（DSML、工具调用）
│   ├── languageServer.ts          # 改造后的语言服务器管理器
│   ├── ipcHandlers.ts             # 自定义模型 CRUD + 连通性测试 IPC
│   ├── cryptoStore.ts             # AES-256-GCM API 密钥加解密
│   ├── schemaValidator.ts         # 响应与模型的运行时 Schema 校验
│   ├── preload.ts                 # 设置 UI 注入（内联添加模型面板）
│   ├── main.ts                    # 应用生命周期 + SetCloudCodeURL 阻断
│   ├── constants.ts               # 端口与证书常量
│   ├── paths.ts                   # 路径工具
│   ├── storage.ts                 # StorageManager 类
│   ├── menu.ts                    # 应用菜单
│   ├── tray.ts                    # 系统托盘
│   ├── updater.ts                 # 自动更新器
│   ├── customScheme.ts            # 插件 scheme 处理器
│   ├── keybindings.ts             # 键盘快捷键
│   ├── loadingOverlay.ts          # 加载遮罩
│   ├── types.ts                   # 类型定义
│   ├── utils.ts                   # 窗口管理与工具
│   ├── services/
│   │   └── settingsService.ts
│   ├── ideInstall/                # IDE 安装向导
│   ├── __tests__/                  # 单元测试（vitest）
│   │   ├── registry.test.ts
│   │   ├── proxy.test.ts
│   │   ├── modelUtils.test.ts
│   │   ├── anthropic.test.ts
│   │   ├── openai.test.ts
│   │   └── utils.test.ts
│   ├── __mocks__/                 # 测试 mock
├── dist/                          # 编译后的 JavaScript 输出
├── tsconfig.json                  # TypeScript 配置
├── deploy-ide.ps1                 # Antigravity IDE 一键部署脚本
├── DEPLOY_ANTIGRAVITY_IDE.md      # IDE 部署指南
├── package.json                   # Electron 应用清单
└── README.md
```

## 支持的提供商

你可以**同时配置来自不同提供商的多个模型**。它们会一并出现在 Antigravity 聊天界面的模型选择下拉列表中，可实时切换。

<p align="center">
  <img src="assets/chat_model_dropdown.png" alt="模型选择下拉列表" width="600">
</p>

| 提供商 | 格式 | 环境变量 / 密钥 | 默认 API URL |
|---|---|---|---|
| **OpenAI** | `openai` | `apiKey`（或 `OPENAI_API_KEY`） | `https://api.openai.com/v1/chat/completions` |
| **Anthropic** | `anthropic` | `apiKey`（或 `ANTHROPIC_API_KEY`） | `https://api.anthropic.com/v1/messages` |
| **OpenRouter** | `openrouter` | `apiKey`（OpenRouter API 密钥） | `https://openrouter.ai/api/v1/chat/completions` |
| **Ollama**（本地） | `ollama` | *（无需）* | `http://localhost:11434/v1/chat/completions` |
| **Google AI Studio** | `google` | `apiKey` *（Gemini API 密钥）* | `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent` |
| **DeepSeek** | `deepseek` | `apiKey` | `https://api.deepseek.com/anthropic` |
| **Groq** | `groq` | `apiKey` | `https://api.groq.com/openai/v1` |
| **Mistral** | `mistral` | `apiKey` | `https://api.mistral.ai/v1` |
| **Cerebras** | `cerebras` | `apiKey` | `https://api.cerebras.ai/v1` |
| **Kimi（Moonshot）** | `kimi` | `apiKey` | `https://api.moonshot.ai/anthropic/v1` |
| **Fireworks AI** | `fireworks` | `apiKey` | `https://api.fireworks.ai/inference/v1` |
| **LM Studio**（本地） | `lmstudio` | *（无需）* | `http://localhost:1234/v1` |
| **llama.cpp**（本地） | `llamacpp` | *（无需）* | `http://localhost:8080/v1` |
| **NVIDIA NIM** | `nvidia` | `apiKey` | `https://integrate.api.nvidia.com/v1` |
| **自定义**（OpenAI 兼容） | `custom` | `apiKey` *（提供商 API 密钥）* | 任意 OpenAI 兼容端点 |

> [!NOTE]
> 对于**自定义**提供商，以 `/v1` 结尾的 URL 会自动追加 `/chat/completions`。它与 Together AI、OpenRouter、Groq、Mistral 及任何其他 OpenAI 兼容端点完全兼容。

> [!NOTE]
> **OpenRouter** 通过单一 API 提供对 300+ 模型（OpenAI、Anthropic、Google、Meta、DeepSeek 等）的统一访问。它使用 OpenAI 兼容格式，带 Bearer token 鉴权，并可选 `HTTP-Referer` / `X-Title` 头用于排名。

> [!NOTE]
> 对于 **Google AI Studio**，提供完整端点 URL 或仅基础 `https://generativelanguage.googleapis.com/v1beta/models/`。代理根据请求是否为流式自动判断 `streamGenerateContent` 还是 `generateContent`。

---

## 安装

### 一键部署（Antigravity IDE）

```powershell
.\deploy-ide.ps1 -IdePath "C:\Users\<User>\AppData\Local\Programs\Antigravity IDE"
```

脚本自动完成：
1. 构建 TypeScript → `dist/`（`npm run build`）
2. 将 `main.js`、`workbench.desktop.main.js`、语言服务器二进制备份到 `resources\app_backup\`（含一键 `rollback.ps1`）
3. 将代理运行时文件部署到 `resources\app\out\proxy\` 并安装 `electron-log`
4. 在 `out\main.js` 顶部注入 ESM 动态 `import('./proxy/bootstrap.js')`
5. 写入 `jetski.cloudCodeUrl` → 本地代理 URL（幂等）
6. （可选）对语言服务器二进制打补丁 — 用 `-SkipBinaryPatch` 跳过（此架构下非必需）
7. 启动 IDE

> [!TIP]
> IDE 采用解包式 `resources\app\` 布局（无 `app.asar`）。语言服务器的云端端点由 **`jetski.cloudCodeUrl`** 用户设置驱动，它会覆盖二进制内的硬编码 URL — 因此写入该设置是关键步骤。完整指南、架构与 5 个已知坑见 [DEPLOY_ANTIGRAVITY_IDE.md](DEPLOY_ANTIGRAVITY_IDE.md)。

### 从源码构建（TypeScript）

```bash
npm install
npx tsc
```

---

## Antigravity 更新恢复

### 问题

自 **Antigravity v2.0.6** 起，语言服务器的 `fetchAvailableModels` 调用指向 `https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`。若不拦截，自定义模型不会出现在聊天下拉列表中 — 只有 Google 内置的 Gemini 模型。

### 修复（IDE 架构）

在 **Antigravity IDE（VS Code Fork）** 架构下，语言服务器从用户设置 **`jetski.cloudCodeUrl`** 读取云端端点，并通过 `--cloud_code_endpoint` 传入。这会**覆盖**二进制内的硬编码 URL，因此二进制补丁在此**非必需**。`deploy-ide.ps1` 写入：

```json
"jetski.cloudCodeUrl": "http://127.0.0.1:50999/v1internal/xxxxxxx"
```

将全部 Cloud Code 流量导向本地代理是安全的 — 未被拦截的请求会透传到官方端点。`/v1internal/xxxxxxx` 填充由代理在转发给 Google 前剥离。

### 每次 IDE 更新后

Antigravity IDE 自动更新会覆盖已注入的文件（`out\main.js`、`out\proxy\`、可选的 LS 二进制）。重跑部署脚本即可全部恢复：

```powershell
.\deploy-ide.ps1 -IdePath "C:\Users\<User>\AppData\Local\Programs\Antigravity IDE"
```

> [!IMPORTANT]
> `settings.json`（`jetski.cloudCodeUrl`）与 `custom_models.json` 在更新后不受影响，因此只需重新注入文件。

> [!NOTE]
> 完整恢复流程、日志位置与验证清单见 [DEPLOY_ANTIGRAVITY_IDE.md](DEPLOY_ANTIGRAVITY_IDE.md)。

---

## 配置

模型存储在用户主目录的 `~/.gemini/antigravity/custom_models.json`。可通过设置中的**“添加模型”**弹窗轻松添加，也可直接编辑该 JSON 文件。

以下是一个**同时配置所有提供商多个模型**的 `custom_models.json` 完整示例：

```json
{
  "models": [
    {
      "name": "models/gpt-4o",
      "displayName": "GPT-4o (OpenAI)",
      "description": "经官方 API 的 OpenAI GPT-4o 模型",
      "provider": "openai",
      "apiKey": "sk-proj-...",
      "apiUrl": "https://api.openai.com/v1/chat/completions",
      "externalModelName": "gpt-4o"
    },
    {
      "name": "models/claude-3-5-sonnet",
      "displayName": "Claude 3.5 Sonnet",
      "description": "经官方 API 的 Anthropic Claude 3.5 Sonnet",
      "provider": "anthropic",
      "apiKey": "sk-ant-...",
      "apiUrl": "https://api.anthropic.com/v1/messages",
      "externalModelName": "claude-3-5-sonnet-latest"
    },
    {
      "name": "models/gemini-1.5-pro",
      "displayName": "Gemini 1.5 Pro (AI Studio)",
      "description": "经 Google AI Studio 密钥的 Gemini 1.5 Pro",
      "provider": "google",
      "apiKey": "AIzaSy...",
      "apiUrl": "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
      "externalModelName": "gemini-1.5-pro"
    },
    {
      "name": "models/llama3",
      "displayName": "Llama 3 (本地 Ollama)",
      "description": "运行在 Ollama 11434 端口的本地 Llama 3 模型",
      "provider": "ollama",
      "apiKey": "",
      "apiUrl": "http://localhost:11434/v1/chat/completions",
      "externalModelName": "llama3"
    },
    {
      "name": "models/deepseek-ai/deepseek-v4-pro",
      "displayName": "DeepSeek V4 Pro (Together)",
      "description": "经 Together API 的 DeepSeek V4 Pro",
      "provider": "custom",
      "apiKey": "YOUR_TOGETHER_API_KEY",
      "apiUrl": "https://api.together.xyz/v1",
      "externalModelName": "deepseek-ai/DeepSeek-V4-Pro",
      "maxRetries": 3
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `name` | 内部模型标识符（如 `models/gpt-4o`）。必须以 `models/` 前缀开头。 |
| `displayName` | 将出现在 Antigravity 聊天模型下拉列表中的友好名称。 |
| `description` | 设置中自定义模型列表里展示的副标题/描述。 |
| `provider` | `openai`、`anthropic`、`openrouter`、`ollama`、`google` 或 `custom` 之一。决定请求与响应格式的翻译方式。 |
| `apiKey` | 提供商的 API 凭证。本地提供商（如 Ollama）留空 `""`。 |
| `apiUrl` | 目标端点。会根据 UI 下拉选择自动预填。 |
| `externalModelName` | 目标提供商所期望的精确模型 ID（如 `gpt-4o`、`claude-3-5-sonnet-latest`、`llama3`）。 |
| `allowUnauthorized` | （可选）设为 `true` 可跳过 SSL 证书校验。适用于内部/自签名端点。默认：`false`。 |
| `timeout` | （可选）请求超时（毫秒）。默认：`120000`（2 分钟）。 |
| `maxRetries` | （可选）限流/失败请求的最大重试次数。默认：`3`。 |

## UI 功能

### 添加模型弹窗

点击设置 → 模型中的**“添加模型”**按钮，打开一个精致弹窗，包含：
- 提供商下拉（OpenAI、Anthropic、Google AI Studio、Ollama、OpenRouter、自定义）
- 根据所选提供商自动预填 URL
- 输入模型 ID 时动态生成 Google AI Studio URL
- 带背景模糊的平滑进入/退出动画
- 表单校验（必填：模型 ID、API 密钥、API URL）
- 留空时自动生成展示名称

<p align="center">
  <img src="assets/add_custom_model_modal.png" alt="添加自定义 AI 模型弹窗" width="45%">
  <img src="assets/add_custom_model_provider_dropdown.png" alt="API 提供商选择" width="45%">
</p>

### 自定义模型面板

在设置 → 模型中，MCP 区块下方有一个“自定义模型”区，展示所有已配置模型，包含：
- 模型名称与提供商/URL 详情
- **测试连接**按钮，带绿色 ✅ / 红色 ❌ 状态指示
- 列表项悬停效果
- 带确认对话框的删除按钮
- 未配置任何模型时的空状态占位
- 添加/删除操作后自动刷新
- **高效 DOM 监听**：使用 `MutationObserver` 加 200ms 防抖，替代 `setInterval(1000ms)`，大幅降低 CPU 开销。注入成功后观察器自动断开，并在 SPA 页面切换时通过 URL 变化检测重新挂载。

<p align="center">
  <img src="assets/custom_models_dashboard.png" alt="自定义模型面板" width="800">
</p>

### SSL 跳过（自签名 / 内部 CA）

对于使用自签名证书或内部 CA 的企业环境（如企业代理服务器、私有 API 端点），在模型配置中加入 `"allowUnauthorized": true`：

```json
{
  "name": "models/internal-model",
  "displayName": "内部 LLM（企业）",
  "description": "自签名证书后的公司托管模型",
  "provider": "custom",
  "apiKey": "...",
  "apiUrl": "https://llm.internal.company.com/v1",
  "externalModelName": "llama3",
  "allowUnauthorized": true
}
```

> [!WARNING]
> 启用 `allowUnauthorized` 时会在控制台记录一条警告。SSL 跳过**仅**作用于该特定模型，从不全局生效。

---

## 安全考量

> [!WARNING]
> **API 密钥安全**：所有 API 密钥通过 Electron `safeStorage` 以 AES-256-GCM 静态加密（macOS Keychain / Windows DPAPI）。切勿分享你的 `custom_models.json` 文件，或在日志中暴露 API 密钥。

> [!CAUTION]
> **SSL 校验**：`allowUnauthorized: true` 选项会禁用 TLS 证书校验。仅用于受信任的内部/自签名端点。对公开 API 连接启用它会让你暴露于中间人攻击。

### 安全默认值

- **超时**：自定义模型 API 请求默认超时 120 秒（可通过 `timeout` 字段配置）。Google 代理请求超时 30-60 秒。
- **请求体大小限制**：请求体上限 10MB 以防内存耗尽。超限返回 `413 Payload Too Large`。
- **无诊断泄漏**：原始 API 响应从不落盘。CSRF token 在控制台输出中掩码。
- **掩码密钥**：UI 中 API 密钥以 `sk-...XXXX`（仅末 4 位）展示。
- **托管状态**：代理清理间隔在关停时被正确停止，避免遗留定时器。

---

## 故障排查

### 端口冲突
若端口 `50999` 被占用，代理自动回退到随机端口。查看 `~/.gemini/antigravity/active_port`。

### 语言服务器崩溃
60 秒内最多自动重启 3 次。查看日志：
- **Windows**：`%LOCALAPPDATA%\antigravity\logs\`
- **macOS**：`~/Library/Logs/antigravity/`

### SSL/TLS 错误
1. 确认提供商证书有效
2. 作为最后手段，在模型配置中加入 `"allowUnauthorized": true`
3. 对于内部 CA，将 CA 证书安装到系统信任存储

### 模型未出现
1. 确认模型名称以 `models/` 开头
2. 检查 `apiUrl` 是否正确
3. 添加模型后重启 Antigravity
4. 用**测试连接**按钮验证端点可达性

### 连接超时
1. 检查提供商 API 是否可达（`curl -I <apiUrl>`）
2. 调大模型配置中的 `timeout`（如 `"timeout": 180000` 表示 3 分钟）
3. 核查网络/代理/VPN 设置

### 限流（429）
代理自动以指数退避最多重试 3 次。若仍出现限流错误：
1. 降低请求频率
2. 调大模型配置中的 `maxRetries`
3. 查看你的 API 提供商限流面板

---

## 开发者指南

### 项目准备

```bash
npm install          # 安装依赖
npx tsc              # 编译 TypeScript → dist/
npx tsc --watch      # 开发用监听模式
```

### 添加新提供商

1. 创建 `src/proxy/translators/<provider>.ts`，导出：
   - `mapGeminiTo<Provider>(geminiBody, modelName)` → 提供商格式请求
   - `map<Provider>ToGemini(providerRes, modelName)` → Gemini 格式响应
   - `map<Provider>ChunkToGemini(chunk, modelName)` → 流式分块处理器
2. 注册表会自动发现新翻译器模块，无需改配置
3. 若鉴权方式不同，在 `registry.ts` 的 `getProviderHeaders()` 中添加该提供商
4. 在 `src/preload.ts` 的 UI 下拉中添加该提供商选项
5. 若适用，在 `registry.ts` 中更新 `supportsStreaming()`

### TypeScript 架构

- **严格模式**：`tsconfig.json` 中 `strict: true`（target: ES2020，module: CommonJS）
- **集中式类型**：模型能力在 `modelUtils.ts`，共享状态在 `shared.ts`
- **无 `eval()`**：JSON 修复使用 `repairPartialJson()`，而非危险的 `eval()` 调用
- **关键路径无 `any`**：请求/响应映射使用显式接口

### 调试模式
```powershell
$env:HEADLESS="1"; .\Antigravity.exe
```

设置 `DEBUG=antigravity:*` 可获得详细日志（debug 级别会捕获流解析回退与线路层细节）。

---

## 贡献

欢迎提交 Pull Request。请确保：
1. 代码遵循既有风格（JSDoc 注释、一致的错误处理）
2. 新增提供商翻译器同时包含请求与响应映射
3. 安全敏感代码避免 `eval`、明文密钥日志、不当的 SSL 处理
4. TypeScript 可干净编译：`npx tsc --noEmit`

---

## 许可证

Apache License 2.0。详见 [LICENSE](LICENSE)。

---

## 开发者

**Abdulvahap OGUT**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/abdulvahap-ogut-343992398/)
