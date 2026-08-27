# Antigravity IDE 部署 antigravity-add-model 完整指南

> 针对 **Antigravity IDE 独立版**（VS Code Fork，解包式 `resources\app` 布局）的一键部署方案。

## 一、背景与架构

Antigravity IDE（VS Code Fork）的 AI 链路：

```
┌─────────────────┐   spawn    ┌──────────────────────────┐
│  extension.js   │ ────────▶  │  language_server (Go)    │
│  (antigravity   │            │  language_server_*_x64   │
│   扩展宿主)      │            └──────────┬───────────────┘
└─────────────────┘                       │ --cloud_code_endpoint
                                          ▼
                           ┌──────────────────────────┐
                           │  本地代理 127.0.0.1:50999 │  ◀── 注入到 Electron 主进程
                           │  - 拦截 fetchAvailableModels
                           │  - 注入自定义模型
                           │  - 翻译 OpenAI/Anthropic/Ollama 协议
                           └──────────┬───────────────┘
                                      │ https
                                      ▼
                        daily-cloudcode-pa.googleapis.com
```

自定义模型配置：`~/.gemini/antigravity/custom_models.json`（首次加载后自动加密）。

## 二、IDE 架构关键点

Antigravity IDE 独立版的架构要点：

### 1. 解包目录，无 app.asar
程序位于 `resources\app\out\`（`main.js`、`vs\workbench\workbench.desktop.main.js` 均为明文），无需 asar 解包/重打包，直接注入文件即可。

### 2. 主进程是 ESM
`resources/app/package.json` 声明了 `"type": "module"`，**在 `out/main.js` 中不能用 `require()`**（会静默失败，被 try/catch 吞掉）。必须用动态 `import()`：

```js
/* antigravity-add-model bootstrap */
import('./proxy/bootstrap.js').catch(function(e){console.error('[agy-proxy] import failed',e);});
```

同时被注入的模块目录必须保持 CommonJS 解析——在 `out\proxy\` 下放一个独立 `package.json`（不带 `"type"` 字段即可）。

### 3. LS 的云端地址由设置项动态下发（二进制补丁失效！）
IDE 通过 `vscode.getCloudCodeUrl()` 读取用户设置 **`jetski.cloudCodeUrl`**（默认空 → 生产地址），
并以 **`--cloud_code_endpoint`** 参数传给 Language Server，**完全覆盖** LS 二进制内的硬编码 URL。

因此正确的注入点是用户设置（`%APPDATA%\Antigravity IDE\User\settings.json`）：

```json
"jetski.cloudCodeUrl": "http://127.0.0.1:50999/v1internal/xxxxxxx"
```

> 对 LS 二进制做 URL 替换补丁在此架构下**无效**（可做可不做）。代理对未被拦截的请求会透传官方端点，因此把全部 Cloud Code 流量指到本地代理是安全的。

### 4. custom_models.json 有严格 Schema
代理加载时逐条校验，不合法的条目会被静默跳过（日志可见 `Skipping invalid model`）。要求：

```json
{
  "models": [
    {
      "name": "models/deepseek-v4-flash",       // 必填，必须以 "models/" 开头或包含 "/"
      "displayName": "DeepSeek V4 Flash",       // 显示名称（尽量避免包含 flash/lite/pro 等分级关键词）
      "provider": "openai",                     // 必填，协议类型！
                                                // ⚠️ 无论国内国外第三方平台（商汤SenseNova、DeepSeek、硅基流动、
                                                // 阿里百炼、Moonshot、智谱等），只要提供的是 OpenAI 兼容接口，
                                                // 必须填写 "openai" 或 "custom"！不能写 "SenseNova" 等自定义名称，
                                                // 否则代理无法匹配协议转换器，会导致请求透传报错 400（见坑 9）。
                                                // Anthropic 风格接口填 "anthropic"，Google AI Studio 填 "google"。
      "apiUrl": "https://token.sensenova.cn/v1/chat/completions",  // 必填，完整 chat/completions 或 messages 端点
      "apiKey": "YOUR_API_KEY",                 // 可选。手动填写明文时设置 "encrypted": false，代理启动后会自动加密
      "externalModelName": "deepseek-v4-flash", // 必填，上游 API 识别的真实模型 ID
      "encrypted": false                        // 初始手动填写明文 API Key 时置为 false（或留空），请勿对明文 Key 标记 true
    }
  ]
}
```

注意：**顶层必须是 `{ "models": [...] }`，不能是裸数组**；`apiUrl` 是完整的 chat/completions（或 messages）端点，不是 baseUrl。

## 三、部署步骤

前置条件：Node.js ≥ 20、npm、git；Antigravity IDE 已安装。

```powershell
# 一键部署（详见 deploy-ide.ps1）
cd D:\programme\antigravity-add-model
.\deploy-ide.ps1 -IdePath "C:\Users\21855\AppData\Local\Programs\Antigravity IDE"
```

脚本自动完成：

1. **编译**：`npm run build`（tsc → `dist/`）
2. **备份**：`main.js` / `workbench.desktop.main.js` / LS exe → `resources\app_backup\`（含一键 `rollback.ps1`）
3. **部署代理模块**：复制运行时所需文件到 `resources\app\out\proxy\`，并在该目录安装 `electron-log`
4. **注入主进程**：`out\main.js` 顶部插入 ESM 动态 `import('./proxy/bootstrap.js')`
5. **写入设置**：`jetski.cloudCodeUrl` → 本地代理地址（幂等）
6. **（可选）LS 二进制补丁**：`-SkipBinaryPatch` 可跳过（见上文，此架构下非必需）
7. **启动 IDE** 并验证代理健康检查

### bootstrap.js（随脚本生成）
在 app ready 后启动代理，并把实际端口写入 `~/.gemini/antigravity/active_port`（50999 被占用时自动回退随机端口）。

## 四、已踩过的坑（重要）

### 坑 1：`require` 静默失败（ESM）
**症状**：注入后无任何效果，代理不启动，无报错。
**原因**：主进程为 ESM，`require` 未定义，`try/catch` 吞掉了 ReferenceError。
**修复**：动态 `import()` + `out\proxy\` 独立 package.json 保持 CJS。

### 坑 2：`Content-Length can't be present with Transfer-Encoding`
**症状**：登录后"设置账号失败"、大量请求报 `Parse Error`，模型列表时好时坏。
**原因**：代理改写响应体后设置了 `Content-Length`，但把上游（经分块传输）的
`Transfer-Encoding: chunked` 头原样转发——HTTP 规范禁止两者共存，Go 写的 LS 严格解析直接拒绝。
**修复**（`proxy.js` 响应改写分支）：

```js
const modifiedHeaders = { ...proxyRes.headers };
delete modifiedHeaders['content-encoding'];
delete modifiedHeaders['transfer-encoding'];   // ← 关键修复
const modifiedBuffer = Buffer.from(text, 'utf-8');
modifiedHeaders['content-length'] = String(modifiedBuffer.length);
```

> 排查技巧：该错误不在代理日志里，而在 IDE 的 **`logs\<session>\cloudcode.log`**（LS stderr 转发）中。

### 坑 3："安装似乎损坏，请重新安装" 警告
**原因**：`product.json` 的 `checksums` 记录了核心文件的 SHA-256（base64 去填充），修改过的文件校验失败触发警告（仅警告，不影响功能）。
**修复**：重新计算修改后文件哈希并更新 `product.json`：

```js
crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '')
```

### 坑 4：自定义模型不显示
依次检查：
1. 代理日志是否出现 `Loaded custom models count: N`（N=0 → Schema 问题，见上文）
2. `jetski.cloudCodeUrl` 是否生效（LS 命令行参数应有 `--cloud_code_endpoint http://127.0.0.1:50999/...`）
3. 代理日志是否出现 `[Proxy] Request: POST /v1internal:fetchAvailableModels` + `Intercepting fetchAvailableModels`

### 坑 5：`ETIMEDOUT` / 登录失败（代理转发错误）
**原因**：本代理进程的出站依赖系统网络栈。若使用 Clash/mihomo 等 TUN 代理，**TUN 网卡消失或节点失效**时，
Node 的 `https.request` 会直连真实 IP 导致超时（fake-IP DNS 也不再返回 198.18.x）。
**排查**：`Resolve-DnsName daily-cloudcode-pa.googleapis.com` 若返回真实 IP 而非 198.18.x，说明 TUN 已失效。
**修复**：重启/修复 Clash（切换节点、重开 TUN 模式）。IDE 侧无需改动，恢复后自动重连。

### 坑 6：自定义模型不显示 —— 前端只渲染 `agentModelSorts` 第一个分组
**症状**：代理日志显示 `Loaded custom models count: N`（N>0）、且 `Intercepting fetchAvailableModels`，但模型选择器里就是看不到自定义模型。
**原因**：`fetchAvailableModels` 响应中 `models` 是**对象映射**（key 为模型 id，如 `gemini-3.6-flash-high`，无 `models/` 前缀），
`agentModelSorts` 是 `[{ "displayName": "Recommended", "groups": [{ "modelIds": [...] }] }]`。
实测前端**只渲染 `agentModelSorts[0].groups[0].modelIds`**（第一个 "Recommended" 分组）里列出的模型；
仅把自定义模型塞进 `models` 映射、却不放入该分组的 `modelIds`，前端不会显示。额外加的“Custom”分组同样被忽略。
**修复**（`proxy.ts` 的 `agentModelSorts` 注入段）：把每个自定义模型的 id（必须与 `models` 映射中的 key 一致）
append 进每个 sort 的 `groups[0].modelIds`。
**调试技巧**：在 `proxy.ts` 正常响应分支临时把合并后的 `googleJson` 写盘到
`~\.gemini\antigravity\debug_fetchAvailableModels.json`，即可看清真实结构（`models` 为对象映射、
`agentModelSorts` 如何按 `modelIds` 引用）。排查完记得移除该临时 dump。

### 坑 7：注入自定义模型弄坏官方 Low/Medium/High 子菜单（2026-08-27 已修复）

**症状**：自定义模型一旦出现在模型选择器列表，官方 Low/Medium/High 分级子菜单就不显示/被遮挡（只露一条边缘）；
自定义模型不显示时子菜单正常。

**最初定位的原因**（2026-08-26）：
1. 把自定义 slug **注入到所有** `agentModelSorts` 分组（包括官方分级分组）会污染 LS 的 tier-family 分组逻辑、破坏子菜单。
   `toSlug` 已把 `flash/pro/low/medium/high/tier` 关键字替换为 `flsh/pr0/l0w/med1um/h1gh/tter` 规避命中分级模式，
   但**只注入第一个分组**才是正解。
2. 自定义模型条目必须补全官方 Gemini 条目共有的字段，否则前端按等级分组时读到 `undefined` 产生 NaN 崩溃：
   `thinkingBudget`、`minThinkingBudget`、`quotaInfo`、`name` 等。

**2026-08-27 实际根因修正**：
通过 CDP 远程调试 IDE 渲染进程并直接检查 DOM 后发现，**子菜单被遮挡的真实根因是自定义模型字段不完整导致前端 NaN 崩溃**，并非纯粹的 CSS overflow/z-index 问题。补齐以下字段后子菜单完全恢复正常（即使自定义模型仍在 `groups[0]` 中）：

| 字段 | 说明 | 示例值 |
|------|------|--------|
| `tagTitle` | 模型标签标题 | `'Custom'` |
| `tagDescription` | 模型标签描述 | `'User-configured model'` |
| `modelExperiments` | 实验配置（空对象） | `{ experiments: {} }` |
| `thinkingLevel` | 思考等级（⚠️ int32 枚举，见下方坑 8） | `0`（UNSPECIFIED） |
| `quotaInfo.resetTime` | 配额重置时间 | ISO 时间戳 |
| `supportsAdaptiveThinking` | 自适应思考 | `false` |
| `supportsThoughtCirculation` | 思想循环 | `false` |
| `supportsRawThinking` | 原始思考 | `false` |
| `supportsDeferredToolLoading` | 延迟工具加载 | `false` |
| `requiresNoXmlToolExamples` | 无需 XML 工具示例 | `false` |
| `requiresLeadInGeneration` | 需要引导生成 | `false` |
| `requiresImageOutputOutsideFunctionResponses` | 函数外图片输出 | `false` |
| `toolFormatterType` | 工具格式化类型 | `'TOOL_FORMATTER_TYPE_XML'` |
| `vertexModelId` / `modelUrl` | 顶点模型 ID / URL | `''`（空串） |
| `supportsCumulativeContext` / `tabJumpPrintLineRange` / `supportsEstimateTokenCounter` | 上下文与跳转 | `false` |
| `addCursorToFindReplaceTarget` / `preview` / `disabled` / `beta` / `isInternal` | UI 开关 | `false` |

> **⚠️ 坑 8：枚举字段类型不匹配（JSON 反序列化失败）**  
> 补齐字段时注意 protobuf 枚举的 JSON 编码规则：`varint`（wireType 0）枚举在 JSON 中必须传**数字**，`length-delimited`
>（wireType 2）枚举传**字符串**。`thinkingLevel` 是 varint 枚举，必须传 `0`（`THINKING_LEVEL_UNSPECIFIED` 的值），
> **不能传**字符串 `'THINKING_LEVEL_UNSPECIFIED'`，否则 LS 的 Go protobuf 解码器报错：
> ```
> cannot decode field ModelDetails.thinking_level from JSON: expected number (int32), got "THINKING_LEVEL_UNSPECIFIED"
> ```
> 该错误会导致 `loadCodeAssist`/`fetchAvailableModels` 请求失败，IDE 登录流程卡死（加载几秒后报错）。
> 其他枚举字段如 `apiProvider`、`modelProvider`、`toolFormatterType` 等是 wireType 2 字符串枚举，传字符串值正常。

**修复**（`proxy.ts`）：
- 自定义条目补齐**所有 protobuf 字段**（原修复只补了 `thinkingBudget`/`minThinkingBudget`/`quotaInfo`/`name`，不够）。
- 新增 `sanitizeDisplayName()` 函数，同步清洗显示名称中的分级关键字，因为 LS 前端也会按显示名称匹配 tier 家族
  （`flash`→`flsh`→`fx`，`lite`→`lt`，`low`→`l0w`，`medium`→`med1um`，`high`→`h1gh`，`pro`→`pr0`，`tier`→`tter`）。
- 自定义模型保留在 `agentModelSorts[0].groups[0].modelIds` 末尾，不再使用独立分组（独立分组无法突破前端 10 项渲染上限）。

### 坑 9：自定义 provider 名称导致协议未转换 (HTTP 400 required model)（2026-08-27）

**症状**：模型选择器中能看到自定义模型并能正常选中，但发送任何消息后，IDE 思考 1 秒立即报错：
```
Agent execution terminated due to error.
Error ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**原因**：
1. **协议类型误填为厂商名**：在 `custom_models.json` 中，将 `provider` 填写成了具体的厂商名称（如 `"SenseNova"`、`"SiliconFlow"` 等），而非协议标识（`"openai"`）。
2. **协议转换器失效**：代理模块的 `registry.ts` 依据 `provider` 路由请求。当 `provider` 未匹配到内置支持列表时，代理**放弃协议转换**，直接将 Antigravity 的原生 Gemini 请求体（`{ contents: [...] }`）原样透传发送给了上游的 `/v1/chat/completions` 接口。
3. **上游报 400**：上游 OpenAI 兼容接口因为缺少 `model` 和 `messages` 参数直接返回 HTTP 400：
   ```json
   {"error":{"message":"required model","type":"invalid_request_error","code":"3"}}
   ```
4. **配额耗尽 429**：部分模型可能同时存在上游欠费或 Workspace 配额不足（如商汤返回 `429 insufficient_quota: Workspace allocated quota exceeded`），需在上游平台控制台补充额度。

**修复**：
- `custom_models.json` 中：所有国内/国际第三方平台的 OpenAI 兼容接口，`provider` 字段**一律填写 `"openai"` 或 `"custom"`**。
- 手动写入明文 API Key 时，务必将 `"encrypted": false`（或留空），代理启动后会自动调用 Electron `safeStorage` 进行加密。

## 五、渲染层注入说明（可选，默认不做）

渲染层 preload UI 注入（Settings 面板 / Add Model 弹窗）依赖 `window.antigravityAPI` 接口。
在 VS Code Fork 架构下，服务端注入（代理改写 `fetchAvailableModels`）已足够让自定义模型出现在
下拉菜单中，因此**默认不修改 `workbench.desktop.main.js`**——实测全局 XHR/fetch hook 反而有破坏
渲染层响应处理的风险。若需自定义 API Key 管理 UI，建议通过编辑 `custom_models.json` 完成。

> **重要区分**：`deploy-ide.ps1` 只把 `proxy.ts` 的主进程模块复制到 `out\proxy` 并注入到 `out\main.js`；
> 本仓库的 `preload.ts`（渲染层 UI 注入）**不会被复制或加载**到独立版 IDE 中。因此所有针对独立版 IDE 的修复
> 必须在 `proxy.ts`（主进程侧）实现，修改 `preload.ts` 对部署场景完全无效（仅对本仓库自带的 launcher 应用生效）。
> 若需排查部署后的问题，应检查 `%APPDATA%\Antigravity IDE\logs\main.log`（代理日志）和
> `logs\<session>\ls-main.log`（LS 日志），而非前端渲染层。

## 六、验证清单

- [ ] `http://127.0.0.1:50999/health` 返回 `{"status":"ok",...}`
- [ ] `%APPDATA%\Antigravity IDE\logs\main.log` 出现 4 个 Translator 加载 + `Server listening`
- [ ] LS 命令行包含 `--cloud_code_endpoint http://127.0.0.1:50999/v1internal/xxxxxxx`
- [ ] 代理日志出现 `Loaded custom models count: 5` 及各模型 slug
- [ ] IDE 模型下拉出现 `extm-*` 条目（自定义模型 id 前缀，见 `toSlug`）
- [ ] 模型选择器下拉中，官方 Low/Medium/High 分级子菜单在自定义模型存在时仍能正常展开（不遮挡、只露一条边缘）
- [ ] `debug_fetchAvailableModels.json` 中自定义条目包含 `tagTitle`、`modelExperiments`、`thinkingLevel`（数字 0）、`quotaInfo.resetTime` 等完整字段（见坑 7）
- [ ] `cloudcode.log` 中无 `cannot decode field ... thinking_level` 错误（若有则字段类型错误，见坑 8）
- [ ] 对话流式输出正常（`streamGenerateContent` 200）

## 七、日志位置速查

| 日志 | 路径 | 用途 |
|---|---|---|
| 代理日志 | `%APPDATA%\Antigravity IDE\logs\main.log` | 代理启停、请求/响应、模型注入 |
| LS 日志 | `%APPDATA%\Antigravity IDE\logs\<session>\cloudcode.log` | LS 侧错误（含 Parse Error） |
| LS 启动日志 | `%APPDATA%\Antigravity IDE\logs\<session>\ls-main.log` | LS stderr、请求 URL 追踪 |
| 自定义模型 | `~\.gemini\antigravity\custom_models.json` | 模型配置（自动加密） |
| 代理端口 | `~\.gemini\antigravity\active_port` | 实际监听端口 |

## 八、回滚

关闭 IDE 后执行：

```powershell
C:\Users\21855\AppData\Local\Programs\Antigravity IDE\resources\app_backup\rollback.ps1
```

恢复 `main.js`、`workbench.desktop.main.js`、LS exe 的原始文件并移除 `out\proxy`。
`jetski.cloudCodeUrl` 设置需手动删除（或改回空）。

## 九、已知限制

- IDE **自动更新会覆盖所有补丁**，更新后需重新部署（`settings.json` 与 `custom_models.json` 不受影响）
- `product.json` 校验仅覆盖渲染层文件，`out/main.js` 不在校验列表中，主进程注入不触发完整性警告
- 代理默认端口 50999 被占用时自动回退随机端口，此时必须依赖 `active_port` 文件确认实际端口
- **前端模型选择器下拉列表上限**：仅渲染约 10 项（官方分级模型折叠后约 7 项 + 自定义模型 3 项）。
  超出上限的自定义模型不会出现在下拉中（但仍在 `models` 映射中，可通过其他入口选择）。
- **自定义模型显示名称关键字**：若包含 `flash`/`lite`/`low`/`medium`/`high`/`pro`/`tier` 等分级词汇，
  即使被 `sanitizeDisplayName()` 清洗，也可能因前端排序/过滤逻辑而无法显示。建议在 `custom_models.json` 中避免。
- **Low/Medium/High 子菜单**：已修复（见坑 7）。补齐自定义模型全部字段后，子菜单在自定义模型出现时也能正常展开。

---

*针对 Antigravity IDE 1.107.0（Windows x64）实测，2026-08-26；坑 7 修复于 2026-08-27，坑 8 补充于 2026-08-27，坑 9 补充于 2026-08-27。*
