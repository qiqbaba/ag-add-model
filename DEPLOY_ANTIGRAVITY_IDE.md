# Antigravity IDE 部署 antigravity-add-model 完整指南

> 针对 **Antigravity IDE 独立版**（VS Code Fork，解包式 `resources\app` 布局）的适配部署方案。
> 原仓库的 `deploy.ps1` 仅支持旧版单一 `app.asar` 路径，本方案使其在 IDE 独立版上完整可用。

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

自定义模型配置：`~/.gemini/antigravity/custom_models.json`（首次加载后自动加密迁移）。

## 二、与原版部署方案的 4 个关键差异

原 `deploy.ps1` 假设旧版 Antigravity（`app.asar` + CJS 主进程 + 二进制硬编码 URL）。
IDE 独立版完全不同：

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
      "name": "models/deepseek-chat",          // 必填，必须包含 "/"
      "displayName": "DeepSeek V3",
      "provider": "openai",                     // 必填。内置: openai/anthropic/google/ollama/custom/
                                                // openrouter/deepseek/groq/mistral/cerebras/kimi/
                                                // fireworks/lmstudio/llamacpp/nvidia
                                                // 任意其他值也可用：自动按 OpenAI 兼容协议处理；
                                                // Anthropic 风格 API 请填 "anthropic"
      "apiUrl": "https://api.deepseek.com/v1/chat/completions",  // 必填，完整端点 URL
      "apiKey": "YOUR_KEY",                     // 可选，首次加载后自动加密为 enc: 格式
      "externalModelName": "deepseek-chat"      // 发给上游的真实模型名
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

## 五、渲染层注入说明（可选，默认不做）

原方案的 preload UI 注入（Settings 面板 / Add Model 弹窗）依赖旧版的 `window.antigravityAPI`。
在 VS Code Fork 架构下，服务端注入（代理改写 `fetchAvailableModels`）已足够让自定义模型出现在
下拉菜单中，因此**默认不修改 `workbench.desktop.main.js`**——实测全局 XHR/fetch hook 反而有破坏
渲染层响应处理的风险。若需自定义 API Key 管理 UI，建议通过编辑 `custom_models.json` 完成。

## 六、验证清单

- [ ] `http://127.0.0.1:50999/health` 返回 `{"status":"ok",...}`
- [ ] `%APPDATA%\Antigravity IDE\logs\main.log` 出现 4 个 Translator 加载 + `Server listening`
- [ ] LS 命令行包含 `--cloud_code_endpoint http://127.0.0.1:50999/v1internal/xxxxxxx`
- [ ] 代理日志出现 `Loaded custom models count: 5` 及各模型 slug
- [ ] IDE 模型下拉出现 `custom-*` 条目
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

恢复 `main.js`、`workbench.desktop.main.js`、LS exe 原版文件并移除 `out\proxy`。
`jetski.cloudCodeUrl` 设置需手动删除（或改回空）。

## 九、已知限制

- IDE **自动更新会覆盖所有补丁**，更新后需重新部署（`settings.json` 与 `custom_models.json` 不受影响）
- `product.json` 校验仅覆盖渲染层文件，`out/main.js` 不在校验列表中，主进程注入不触发完整性警告
- 代理默认端口 50999 被占用时自动回退随机端口，此时必须依赖 `active_port` 文件确认实际端口

---

*基于 [vahapogut/antigravity-add-model](https://github.com/vahapogut/antigravity-add-model) v2.0.1，
针对 Antigravity IDE 1.107.0（Windows x64）实测适配，2026-08-26。*
