> 本方案仅针对 **Antigravity IDE 独立版**（VS Code Fork，解包式 `resources\app`）测试验证，其他安装形态未测试，效果未知。
>
> ⚠️ **平台验证重要声明**：本项目由 [vahapogut/antigravity-add-model](https://github.com/vahapogut/antigravity-add-model) 二开改造而来。文档中记录着支持众多模型平台，但**实际上只有本地已添加的平台（商汤 SenseNova、智源/蜂动 B.AI）经过了完整联调实测并确认可正常稳定使用（含工具调用）；其他所有平台在本项目中均未经任何验证，效果未知**。

# Antigravity 自定义模型启用器

> **Antigravity IDE（VS Code Fork）部署方案**
>
> 本仓库为 **Antigravity IDE 独立版**（解包式 `resources\app`，VS Code Fork 架构）提供一键部署，可在内置 Gemini 模型之外启用外部 AI 模型。
>
> 它向 Electron 应用注入一个本地 HTTP 代理，逆向工程 Cloud Code 内部 API（`v1internal`），在各提供商格式之间翻译请求/响应，并通过 `custom_models.json` 配置实现外部模型无缝接入。
>
> **特别注意**：虽然代理代码中保留了上游的多协议翻译分支，但**只有本地已添加并深度适配的平台（商汤 SenseNova、B.AI）可以正常稳定使用**。其他未经测试验证的平台，在 Antigravity 的高标准要求（特别是 prompt-XML 工具调用、流式分块）下无法保证正常工作。

## 文档导航

| 文档 | 适用对象 | 内容 |
|---|---|---|
| **本 README** | 使用者 | 安装、配置、参数说明、安全机制、常见故障排查 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 维护者 / 部署者 | **全景技术指南**：系统架构设计、内部 API 逆向规范、自动化部署、**25 个已踩坑与修复（含工具调用 prompt-XML 终极范式）**、验证清单与回滚 |

---

## 快速开始

### 一键部署（Antigravity IDE）

```powershell
# 基础部署
.\deploy-ide.ps1 -IdePath "C:\Users\<User>\AppData\Local\Programs\Antigravity IDE"

# 部署并自动在浏览器打开可视化管理面板
.\deploy-ide.ps1 -IdePath "C:\Users\<User>\AppData\Local\Programs\Antigravity IDE" -OpenDashboard
```

脚本自动完成（共 10 步，从 0 开始编号）：
0. 环境检查（验证 `out\main.js` 存在、读取 `package.json` 确认 ESM）
1. 构建 TypeScript → `dist/`（`npm run build`）
2. 终止 Antigravity / language_server 进程
3. 将 `main.js`、`workbench.desktop.main.js`、`product.json`、语言服务器二进制备份到 `resources\app_backup\`（含一键 `rollback.ps1`）
4. 将代理运行时文件部署到 `resources\app\out\proxy\` 并安装 `electron-log`，应用 `transfer-encoding` 修复补丁，生成 `bootstrap.js`
5. 在 `out\main.js` 顶部注入 ESM 动态 `import('./proxy/bootstrap.js')`
6. 修复前端模型选择器高度/滚动/宽度 + 同步 `product.json` checksums
7. 写入 `jetski.cloudCodeUrl` → 本地代理 URL（幂等，代理启动时自动校正为实际端口）
8. （可选）对语言服务器二进制打补丁 — 用 `-SkipBinaryPatch` 跳过（此架构下非必需）
9. 初始化 `custom_models.json` 并启动 IDE 与健康检查

> [!TIP]
> IDE 采用解包式 `resources\app\` 布局（无 `app.asar`）。语言服务器的云端端点由 **`jetski.cloudCodeUrl`** 用户设置驱动，它会覆盖二进制内的硬编码 URL — 因此写入该设置是关键步骤。完整技术实现与 25 个已知坑见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

### 一键开启 / 暂停代理（日常便捷切换）

如果需要临时停用代理并切回 100% 官方原生模式（或重新开启）：

```powershell
# 自动切换状态（开启 -> 暂停 / 暂停 -> 开启）
.\toggle-proxy.ps1

# 或强制指定动作
.\toggle-proxy.ps1 -Action Disable   # 暂停代理（恢复纯官方模式）
.\toggle-proxy.ps1 -Action Enable    # 开启代理
.\toggle-proxy.ps1 -Action Status    # 查看当前状态
```

> **提示**：在 Windows 资源管理器中，也可以直接**双击运行 `toggle-proxy.bat`** 实现一键切换！

### 从源码构建（TypeScript）

```bash
npm install
npx tsc
```

---

## 支持的提供商与平台验证状态

你可以**同时配置来自不同提供商的多个模型**。它们会一并出现在 Antigravity 聊天界面的模型选择下拉列表中，可实时切换。

> [!CAUTION]
> **真实可用性与平台验证声明**：
> 文档与代码中保留了上游声明的多个平台和协议转换分支，但**实际上只有本地已添加并深度适配的平台是可以正常稳定使用的，其他平台均未经任何测试与验证**！
> 
> Antigravity IDE 内部语言服务器（LS）对自定义模型的要求极为严苛（尤其是**工具调用 Tool Calls 仅识别模型响应文本中的 prompt-XML 格式，忽略原生 `functionCall`**，且对流式分块、标签闭合、参数编码敏感，详见 [ARCHITECTURE.md](./ARCHITECTURE.md) 坑 12~25）。**未经实际验证的平台极大概率会出现：工具调用不触发/被忽略、模型回答一句话后提前结束、流式卡死或报错 400 等严重问题**。

### 1. 本地已实测验证可用平台（推荐使用）

以下平台为本地已添加、经过真实流量与 Agent 完整链路联调验证，确认可正常稳定使用的平台：

| 提供商 / 平台 | 协议格式（`provider`） | 常用端点（`apiUrl`） | 本地已验证模型示例 | 验证说明与适配特性 |
|---|---|---|---|---|
| **商汤日日新 SenseNova** | `openai` | `https://token.sensenova.cn/v1/chat/completions`<br>或 `https://api.sensenova.cn/v1/llm/chat-completions` | 商汤 V4 Flash (`deepseek-v4-flash`)、SenseNova 6.8 Flash Lite (`sensenova-6.8-flash-lite`)、GLM 5.2 (`glm-5.2`)、Deepseek V4 Pro (`deepseek-v4-pro`)、Kimi K3 (`kimi-k3`) 等 | **✅ 已实测验证可用**<br>已深度适配 DSML 容器、全角竖线（`｜`）、XML 裸标签与 `Param` 嵌套参数解析、GBK 乱码合成修复及 prompt-XML 工具调用（坑 12~25），Agent 工具与流式稳定跑通。 |
| **智源 / 蜂动 B.AI** | `openai` | `https://api.b.ai/v1/chat/completions` | Hy3 (`hy3`)、GLM 5.3 Flash (`glm-5.3-flash`)、Qwen3.8 Flash (`qwen3.8-flash`)、Mimo V2.5 (`mimo-v2.5`) 等 | **✅ 已实测验证可用**<br>标准 OpenAI 协议兼容良好，XML 裸标签与参数解析正常，工具调用已真实验证通过。 |

---

### 2. 其他提供商（上游声明，未经任何验证）

以下列表源自上游开源项目（vahapogut/antigravity-add-model）的原始代码实现。**在本项目中未经任何实际测试与验证，效果完全未知，无法保证正常可用**。若需使用，请做好自行抓包、适配与排查故障的准备：

| 提供商 | 格式（`provider`） | 环境变量 / 密钥 | 默认 API URL | 验证状态 |
|---|---|---|---|---|
| **OpenAI** | `openai` | `apiKey`（或 `OPENAI_API_KEY`） | `https://api.openai.com/v1/chat/completions` | ⚠️ **未经任何验证** |
| **Anthropic** | `anthropic` | `apiKey`（或 `ANTHROPIC_API_KEY`） | `https://api.anthropic.com/v1/messages` | ⚠️ **未经任何验证** |
| **OpenRouter** | `openrouter` | `apiKey`（OpenRouter API 密钥） | `https://openrouter.ai/api/v1/chat/completions` | ⚠️ **未经任何验证** |
| **Ollama**（本地） | `ollama` | *（无需）* | `http://localhost:11434/v1/chat/completions` | ⚠️ **未经任何验证** |
| **Google AI Studio** | `google` | `apiKey` *（Gemini API 密钥）* | `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent` | ⚠️ **未经任何验证** |
| **DeepSeek（官方）** | `deepseek` | `apiKey` | `https://api.deepseek.com/anthropic` | ⚠️ **未经任何验证** |
| **Groq** | `groq` | `apiKey` | `https://api.groq.com/openai/v1` | ⚠️ **未经任何验证** |
| **Mistral** | `mistral` | `apiKey` | `https://api.mistral.ai/v1` | ⚠️ **未经任何验证** |
| **Cerebras** | `cerebras` | `apiKey` | `https://api.cerebras.ai/v1` | ⚠️ **未经任何验证** |
| **Kimi（Moonshot 官方）** | `kimi` | `apiKey` | `https://api.moonshot.ai/anthropic/v1` | ⚠️ **未经任何验证** |
| **Fireworks AI** | `fireworks` | `apiKey` | `https://api.fireworks.ai/inference/v1` | ⚠️ **未经任何验证** |
| **LM Studio**（本地） | `lmstudio` | *（无需）* | `http://localhost:1234/v1` | ⚠️ **未经任何验证** |
| **llama.cpp**（本地） | `llamacpp` | *（无需）* | `http://localhost:8080/v1` | ⚠️ **未经任何验证** |
| **NVIDIA NIM** | `nvidia` | `apiKey` | `https://integrate.api.nvidia.com/v1` | ⚠️ **未经任何验证** |
| **Codestral** | `codestral` | `apiKey` | `https://api.mistral.ai/v1` | ⚠️ **未经任何验证** |
| **opencode** | `opencode` | `apiKey` | 任意 OpenAI 兼容端点（opencode CLI 自带） | ⚠️ **未经任何验证** |
| **wafer** | `wafer` | `apiKey` | 任意 Anthropic 兼容端点 | ⚠️ **未经任何验证** |
| **zai** | `zai` | `apiKey` | 任意 Anthropic 兼容端点 | ⚠️ **未经任何验证** |
| **自定义**（OpenAI 兼容） | `custom` 或 `openai` | `apiKey` *（提供商 API 密钥）* | 任意 OpenAI 兼容端点 | ⚠️ **未经任何验证** |

> [!IMPORTANT]
> **第三方模型平台配置协议须知**：
> 在 `custom_models.json` 中，`provider` 字段指的是**协议翻译器类型**，而非厂商品牌名。只要平台提供的是标准 OpenAI 兼容的 `/v1/chat/completions` 接口，`provider` **必须填写 `"openai"` 或 `"custom"`**，切勿填写 `"SenseNova"` 等自定义厂商名，否则代理将无法识别协议类型并导致请求透传报错 400（详见 [ARCHITECTURE.md](./ARCHITECTURE.md) 坑 9）。

> [!NOTE]
> **URL 自动补全**：对于 `openai`、`custom`、`openrouter` 三种 provider，以 `/v1` 结尾的 URL 会自动追加 `/chat/completions`，否则自动补齐 `/v1/chat/completions`。**注意**：该自动补全**仅**对上述三种 provider 生效——`groq`、`mistral`、`cerebras`、`nvidia`、`codestral`、`opencode` 等其他 OpenAI 兼容 provider 不会触发自动追加，填写这些 provider 的 `apiUrl` 时需带上完整的 `/chat/completions` 路径。（`ollama` 的 URL 规范化在 `translators/ollama.ts` 中独立实现。）

> [!NOTE]
> **多模态 / 视觉（Vision）支持**：代理会将聊天中粘贴、或 Agent 自动截图并发送的图像（Gemini 的 `inlineData` 图像 part）翻译为目标提供商的标准结构 — OpenAI 的 `image_url` 内容块、Anthropic 的 `type: "image"` 内容块。能否真正解码图像仍取决于目标模型本身是否具备多模态能力。

---

## 配置

模型存储在用户主目录的 `~/.gemini/antigravity/custom_models.json`。

你可以通过代理服务内置的**可视化配置与连通性测试面板**（访问 `http://127.0.0.1:50999/`）以图形化界面轻松添加、测试连通性、编辑与管理模型，也可直接编辑该 JSON 文件。

以下为**本地已实测验证可用的真实模型配置示例**（基于商汤日日新与 B.AI）：

```json
{
  "models": [
    {
      "name": "models/deepseek-v4-flash",
      "displayName": "商汤 V4 Flash",
      "description": "商汤 SenseNova 托管的 DeepSeek V4 Flash（已深度适配工具调用）",
      "provider": "openai",
      "apiKey": "YOUR_SENSENOVA_API_KEY",
      "apiUrl": "https://token.sensenova.cn/v1/chat/completions",
      "externalModelName": "deepseek-v4-flash"
    },
    {
      "name": "models/sensenova-6.8-flash-lite",
      "displayName": "SenseNova 6.8 Flash Lite",
      "description": "商汤日日新轻量闪电模型",
      "provider": "openai",
      "apiKey": "YOUR_SENSENOVA_API_KEY",
      "apiUrl": "https://token.sensenova.cn/v1/chat/completions",
      "externalModelName": "sensenova-6.8-flash-lite"
    },
    {
      "name": "models/hy3",
      "displayName": "Hy3 (B.AI)",
      "description": "B.AI 托管模型",
      "provider": "openai",
      "apiKey": "YOUR_BAI_API_KEY",
      "apiUrl": "https://api.b.ai/v1/chat/completions",
      "externalModelName": "hy3"
    },
    {
      "name": "models/glm-5-3-flash",
      "displayName": "Glm 5.3 Flash (B.AI)",
      "description": "B.AI 托管 GLM 5.3 Flash",
      "provider": "openai",
      "apiKey": "YOUR_BAI_API_KEY",
      "apiUrl": "https://api.b.ai/v1/chat/completions",
      "externalModelName": "glm-5.3-flash"
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `name` | 内部模型标识符（如 `models/gpt-4o`）。必须以 `models/` 前缀开头。 |
| `displayName` | 将出现在 Antigravity 聊天模型下拉列表中的友好名称。 |
| `description` | 管理面板与模型卡片中展示的副标题/描述。 |
| `provider` | `openai`、`anthropic`、`openrouter`、`ollama`、`google` 或 `custom` 之一。决定请求与响应格式的翻译方式。 |
| `apiKey` | 提供商的 API 凭证。本地提供商（如 Ollama）留空 `""`。 |
| `apiUrl` | 目标端点。在 Web 面板选择预设或提供商时会自动预填。 |
| `externalModelName` | 目标提供商所期望的精确模型 ID（如 `gpt-4o`、`claude-3-5-sonnet-latest`、`llama3`）。 |
| `supportsImages` | （可选）显式指定是否支持图片/多模态输入（`true`/`false`）。留空时按模型名称与协议自动推断。设为 `true` 时 Antigravity IDE 允许上传图片并自动进行多模态协议转换。 |
| `supportsThinking` | （可选）显式指定是否支持深度思考/推理（`true`/`false`）。留空时按模型名称与协议自动推断。设为 `true` 时 Antigravity IDE 将展示思考预算与思考过程。 |
| `allowUnauthorized` | （可选）设为 `true` 可跳过 SSL 证书校验。适用于内部/自签名端点。默认：`false`。 |
| `timeout` | （可选）请求超时（毫秒）。默认：`120000`（2 分钟）。 |
| `maxRetries` | （可选）限流/失败请求的最大重试次数（支持 `0~5` 次，默认：`3`）。 |
| `encrypted` | （可选）API Key 是否已启用 `safeStorage` 静态加密。初始手动填写明文 Key 时为 `false`（或留空），代理启动后自动加密并置为 `true`。默认：`false`。 |

---

## 可视化管理面板（Web Dashboard）

代理服务原生集成了零依赖、现代化暗黑风格的**可视化配置与连通性测试 Web 单页应用（SPA）**，免去手动编辑 JSON 产生语法或格式错误的困扰。

- **访问入口**：在浏览器打开 [`http://127.0.0.1:50999/`](http://127.0.0.1:50999/)（或查阅 `%USERPROFILE%\.gemini\antigravity\dashboard_url`）。
- **一键直达**：在执行部署脚本时加上 `-OpenDashboard` 开关（`.\deploy-ide.ps1 -OpenDashboard`），部署完成后将自动在默认浏览器中调出面板。

### 核心特性

1. **多厂商快速预设模板**：
   - 顶部提供一键预填芯片：**DeepSeek 官方**、**DeepSeek-R1（深度思考）**、**OpenAI GPT-4o**、**Claude 3.5 Sonnet**、**Ollama 本地**、**OpenRouter 聚合**、**硅基流动 SiliconFlow**、**商汤日日新 SenseNova**、**月之暗面 Kimi**、**Google AI Studio** 等，点击即可一键填入标准 API Endpoint 与推荐参数。（*提示：预设芯片主要为通用配置模板，除商汤日日新 SenseNova 等本地已验证平台外，其余预设端点在本项目中均未经任何联调验证，填入后请务必先点击“测试连接”并自行排查工具调用兼容性*）。
2. **智能连通性探测引擎**：
   - 支持单个模型卡片 **“测试连接”** 与顶栏 **“一键测速全部”**，向目标上游发送真实轻量握手请求。
   - 实时测量网络 **RTT 延迟（毫秒）**，并抓取模型真实输出片段。
   - 针对 **401（Key 无效/过期）**、**403（区域/权限拦截）**、**404（端点或模型名不存在）**、**429（额度超限/限流）**、**ECONNREFUSED（Ollama 未启动）** 等常见异常，提供中文排障诊断与修复建议。
3. **模型添加与编辑**：
   - 提供精致的模态表单弹窗，支持配置模型标识、显示名称、Provider 协议、API Key（支持显隐切换）、API URL 及高级参数（超时时间、重试次数、自签名 SSL 跳过等）。
   - **连接配置靠前、自动填充字段靠后**：表单按「协议翻译器 → 完整 API URL → API Key → 显示名称 → 内部标识 → 外部模型名称」排列，先填好 Provider/URL/Key 即可触发下方模型字段的自动填充。
   - **一键自动获取模型列表 + 批量添加**：填入完整 API URL（可选 API Key，本地免 Key 服务如 Ollama 无需 Key）后点击「自动获取模型」，代理会探测上游 `/models` 接口并列出全部可用模型，勾选后一键「批量添加所选」。
   - **本地去重**：已在本地配置过的模型会被标记为「已添加」并禁用勾选/隐藏应用到表单按钮，避免重复添加。
   - **自动填充内部标识 (Name)**：点击「应用到表单」会自动按 `models/<slug>` 生成内部模型标识，并同时填充外部模型名称与显示名称。
   - 留空时自动生成友好的展示名称，并提供实时表单格式校验。
4. **双向编辑模式（GUI + Raw JSON）**：
   - 点击顶栏 **“Raw JSON”** 按钮可直接在弹出的语法高亮在线编辑器中查看或编辑完整的 `custom_models.json` 配置，内置一键格式化与实时 JSON 语法校验。
5. **实时状态监控与搜索过滤**：
   - 顶部状态栏实时展示代理当前监听端口、已加载模型总数、`safeStorage`（Windows DPAPI / macOS Keychain）密钥加密保护状态。
   - 支持按模型标识、显示名称实时模糊搜索，支持按 Provider 分类筛选。
6. **即时热重载与安全备份**：
   - 任何修改保存后，代理自动对 API Key 执行 `safeStorage` 静态加密，自动创建 `.bak` 历史备份文件，并立即热重载内存模型池，**无需重启 IDE**。

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

---

## 故障排查

### Web 配置面板打不开 / 返回 Google 404
浏览器访问 `http://127.0.0.1:50999/` 显示 **Google 官网风格的 404 页**（而非自检面板），说明 IDE 内运行的代理是**旧构建**（早于 Web 面板特性，缺少 `dashboardHtml.js` / `connectionTest.js` / `modelConfigManager.js`，其 `proxy.js` 没有 `/` 面板路由，导致 `/` 被透传到 Google 官方端点而 404）。

**解决**：重新部署一次即可恢复：

```powershell
.\deploy-ide.ps1 -IdePath "C:\Users\<User>\AppData\Local\Programs\Antigravity IDE"
```

> [!TIP]
> 修改代理源码（`src/proxy.ts`、`src/proxy/dashboardHtml.ts` 等）或 IDE 自动更新覆盖 `out\proxy\` 后，**必须重跑 `deploy-ide.ps1`**。只用 `curl http://127.0.0.1:50999/` 验证：返回 HTTP 200 与 `<!DOCTYPE html>` 即正常。详见 [ARCHITECTURE.md](./ARCHITECTURE.md) 坑 11。

### 端口冲突
若端口 `50999` 被占用，代理自动回退到随机端口，并**自动同步**：
- 将实际端口写入 `~/.gemini/antigravity/active_port`；
- 将用户 `settings.json` 中的 `jetski.cloudCodeUrl` 精确更新为 `http://127.0.0.1:<actual_port>/v1internal/xxxxxxx`（保留你的注释与排版），确保 Language Server 始终连接到代理实际监听端口，无需手动修改。端口恢复为 `50999` 时也会自动同步回来。

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
5. 若界面显示的模型比配置数量少 1 个以上：多为**同名 slug 覆写**（两个模型 `externalModelName` 相同），已由 `toSlug()` 按 `displayName` 优先解决（见 ARCHITECTURE 文档“坑 10”）。
6. 若模型已注入配置齐全但仍超过约 10 项显示不全：为前端 `max-h-80`（320px）高度截断，需确保 `deploy-ide.ps1` 第 6 步的 workbench 高度/滚动补丁已生效（IDE 更新会使其失效），重跑部署即可。
7. 若模型显示名称含 `flash`/`lite`/`low`/`medium`/`high`/`pro`/`tier` 等分级词汇：现已原样透传不再清洗，一般不会导致过滤；仅当仍显示异常时再排查，不必改名。

### 连接超时
1. 检查提供商 API 是否可达（`curl -I <apiUrl>`）
2. 调大模型配置中的 `timeout`（如 `"timeout": 180000` 表示 3 分钟）
3. 核查网络/代理/VPN 设置

### 限流（429）
代理自动以指数退避最多重试 3 次。若仍出现限流错误：
1. 降低请求频率
2. 调大模型配置中的 `maxRetries`
3. 查看你的 API 提供商限流面板

### 模型回复一句话后提前结束 / 工具不执行
这是自定义模型接入的**头号问题**（本项目坑 12~25，终极根因为坑 25）。排查顺序：

1. **确认部署版本**：`dist/proxy.js` 构建时间 vs `resources\app\out\proxy\proxy.js`（重跑 `deploy-ide.ps1` 后必须**完全重启 IDE**——语言服务器只在启动时连接代理）；
2. **看代理日志**：`%APPDATA%\Antigravity IDE\logs\main.log` 搜 `Detected N text tool call(s)`——有即解析成功，问题在交付层；无则检查 `modelToolNames` 注册（请求 systemInstruction 里工具定义段是否被正确提取）；
3. **核对交付形态**（坑 25 终极范式）：LS 对自定义模型只解析响应**文本**中的 `<tool_name>{json}</tool_name>` 块，functionCall part 会被忽略。交付层由 `buildFunctionCallParts` 单点出口统一走 prompt-XML 文本（`src/proxy/translators/prompt-xml.ts`）；
4. **开启流日志**：建 `~/.gemini/antigravity/raw_stream.flag` 文件后重启，`[Proxy][RAW:*]` 显示上游原文、`[Proxy][MAP:*]` 显示映射结果，逐帧对照定位；
5. 若工具芯片弹出但参数异常（乱码/缺字段）：见坑 15/18（toolSummary/toolAction 必填合成与乱码替换）。

> 完整 25 坑排查实录见 [ARCHITECTURE.md](./ARCHITECTURE.md) 第四章。

> 更多深层排障（如 LS 崩溃、协议 400、登录卡死等）见 [ARCHITECTURE.md](./ARCHITECTURE.md) 的“踩坑实录与深度排障”与“关键日志位置速查”。

---

## 贡献

欢迎提交 Pull Request。请确保：
1. 代码遵循既有风格（JSDoc 注释、一致的错误处理）
2. 新增提供商翻译器同时包含请求与响应映射
3. 安全敏感代码避免 `eval`、明文密钥日志、不当的 SSL 处理
4. TypeScript 可干净编译：`npx tsc --noEmit`

> 开发与架构细节（协议翻译、流式、Schema 校验、添加新提供商指南）见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 许可证

Apache License 2.0。详见 [LICENSE](LICENSE)。

---

## 原作者

上游项目作者：**Abdulvahap OGUT**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/abdulvahap-ogut-343992398/)
