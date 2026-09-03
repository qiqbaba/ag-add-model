# 反重力 IDE 自定义模型「提前结束 / 返回内容解析错误」问题解决报告

> 生成时间：2026-09-02（基于本地会话日志复盘）
> 项目：`D:\programme\antigravity-add-model`（Antigravity / 反重力 IDE 自定义模型注入插件）
> 数据来源：`~/.dsh/sessions/--D-programme-antigravity-add-model--` 下相关会话的完整日志
> 说明：本报告是**复盘**各对话中已经做过的排障与结论，非新的修复方案。
> 注：因沙箱限制无法写入 D 盘根目录，本报告暂存于工作区目录，可手动移动。

---

## 一、问题概述

**症状（用户原话归纳）**：

1. **自定义模型提前结束**：模型输出到一半就停（例如 sensenova-6.8-flash-lite 只回复一句 "Let me first read the README.md..." 就中断），工具从未真正执行，随后 IDE 直接切回内置模型（日志表现为 `run_command`/工具检测后紧接着 `gemini-3.1-flash-lite`）。
2. **模型返回内容解析错误**：模型返回里出现原始 XML/DSML 标签泄漏，例如 GLM5.2 把 `<tool_call:list_dir> {...} </list_dir>` 当作普通可见文本直接显示在聊天界面，而不是被解析成工具调用。

**影响范围**：所有通过本项目接入的自定义 OpenAI 兼容模型（GLM 5.2、BAI V4 Flash / Vision、商汤 SenseNova V4 Flash、sensenova-6.8-flash-lite 等）。

**关键背景**：在**今天（2026-09-02）的特定提交之前**，商汤 V4 Flash 与 sensenova-6.8-flash-lite 是**可以正常使用**的；今天的提交把原本能用的模型也弄坏了（回归），导致**所有自定义模型全面不可用**。

---

## 二、架构背景（排障所依赖的机制）

- **角色**：这是一个注入式插件，向反重力 IDE 插入自定义模型。核心是本地 HTTP 代理（`src/proxy/proxy.ts`，运行于 `127.0.0.1:50999`），负责在 **Gemini 协议 ↔ OpenAI 兼容协议** 之间互译。
- **路由**：所有自定义 OpenAI 兼容模型（`openai`/`custom`/`openrouter`/`ollama`/`groq` 等）统一走 `src/proxy/translators/openai.ts` 转换器。
- **翻译函数**：
  - 非流式：`mapOpenAIToGemini`
  - 流式：`mapOpenAIChunkToGemini(chunk, modelName, sessionId, streamKey)` → `GeminiCandidate | null`
- **工具调用两种形态**：
  1. **原生**：标准 OpenAI `choices[0].delta.tool_calls` 结构体（sensenova/部分主流模型走这条）。
  2. **文本标签**：模型在 `content` 文本流里直接输出 `<tool_call>`、`<run_command>`、`<view_file>`、`<DSML|...>` 等原始标记（GLM5.2、部分开源模型/网关走这条）。
- **关键解析器**：`parseDSMLToolCalls`（多遍扫描，包含 DSML、XML named、tag-named、通用 block、bare-lean-tags、未闭合块回退等 Pass）。
- **流式 Holdback 机制**：`src/proxy/shared.ts` 的 `StreamContext`，用 `pendingHeldSuffix` / `emittedLen` 暂存未闭合的工具标签，避免原始标记闪烁泄漏；块闭合后才发射 `functionCall`。

---

## 三、排障完整时间线（按会话重组）

问题跨越多个会话持续排障，为避免按会话割裂，这里按**排障阶段**归类（会话 ID 均属于 `antigravity-add-model` 工作区）。

### 阶段 0：问题首次上报（`session-32fa0381`，对话 seq16）

用户报告：
> "自定义添加的模型中，glm5.2会自动提前结束，BAI V4 Flash Vision调用工具会出现解析问题，但是两个v4 flash都能正常使用，找出原因"

随后补充：
> "不，bai v4 flash也会出现问题"

**初始定位**：助手发现 GLM5.2 与 BAI 不走标准 `delta.tool_calls`，而是在文本流里输出 `run_command`、`view_file` 等**原始标签格式**；代理层原先只处理 DeepSeek `<DSML|...>` 格式且只 hold `<DSML|` 标记，导致其它模型的 `<tool_call>` 等在流式阶段直接透传泄漏，流结束时又未能提取出 Gemini 标准 `functionCall`。

### 阶段 1：第一次修复（`session-32fa0381`，助手总结 seq=36894）

针对 GLM5.2 / BAI V4 Flash 加了**裸标签解析**。改动集中在 `src/proxy/translators/openai.ts`（另在 `shared.ts` 加了注册表与 `emittedLen`）：

1. **裸标签解析**（新 Pass 4b）：`<run_command>{...}</run_command>`、`<view_file>Param>value</view_file>` 等精简格式，匹配"会话声明工具名 ∪ 内置常见工具名"。
2. **精简参数解析**（`extractLeanKeyValues`）：`CommandLine>git status -s`、`IsSkillFile>true` 这类 `Key>value` 语法，含类型转换。
3. **跨块标记合并**：上一块被 hold 的半截标记与下一块拼接后再检测，堵住标记被 chunk 边界切开的泄漏。
4. **静默丢弃修复**：流结束时把解析失败的被 hold 文本全部 flush，不再"凭空消失"。
5. 会话工具名注册 + 流式 hold 检测纳入裸标签。

**部署验证**：声称 GLM5.2 与 BAI V4 Flash 都正确返回 `functionCall`，无泄漏、无提前结束。**（注意：这是表面上"修复完成"，实际埋下了后续回归。）**

### 阶段 2：第一次修复引入回归（`session-32fa0381`，助手总结 seq=66400）

**用户反馈**：
> "刚才的修改没有解决问题，甚至原来正常的商汤 V4 Flash也出现了同样的问题"
> "sensenova-6.8-flash-lite原来也可以正常使用，刚才修改完也出现了提前结束的问题"

**根因**：上一轮给裸标签（`<run_command>`、`<view_file>`）加的解析**过于宽松，产生误报**：
- 模型在正文里**引用/讨论**工具标签（例如复述 SKILL.md 里的 `<view_file>` 示例、解释工具格式）时，被当成真实工具调用；
- 从正文抠出的参数往往不匹配工具 schema，发给 IDE 后校验失败 → **"The model produced an invalid tool call"** → 整个会话中断（表现为"提前结束"）；
- 原本正常的商汤 V4 Flash / sensenova 也因此中招。

**修复**（`openai.ts` + `shared.ts`）：给裸标签解析加**三重严格校验**：
1. **只用会话声明的工具名**：匹配 `modelToolNames`（IDE 本会话真实注册的工具），去掉通用内置兜底误报源。
2. **参数 schema 校验**（`validateBareArgs` + 新增 `modelToolSchemas`）：提取参数键必须全部在声明参数内且非空，否则视为正文。
3. **位置/围栏校验**（`isBlockBoundaryAndNotFenced`）：裸标签必须位于行首（前仅空白）且不在 Markdown 代码围栏内。

同时重构流式发射逻辑（基于 `accumulatedText` 未发射尾部 + `emittedLen`），保证被 hold 的正文既不泄漏也不丢失。**全部 232 个测试通过**（含 5 个新回归用例）。

> 但此后用户仍反馈（`session-32fa0381` 更晚阶段）："bai平台的两个模型还是有问题，glm5.2可以正常使用了"、"这个模型提前结束"、"商汤 V4 Flash也会提前结束"、"glm5.2也有问题了"。问题仍反复。

### 阶段 3：回归归因到"今天的提交"（`session-5de22404`，最重要的最终排障会话）

**用户反馈（seq15）**：
> "自定义模型仍然存在提前结束、模型返回内容解析错误的问题……所有的自定义模型都存在问题，没有一个可以使用的。但是在今天的提交之前的版本中，glm5.2等模型不能使用，但是商汤 V4 Flash、sensenova-6.8-flash-lite是可以正常使用的"

进一步（seq233580）：
> "无效，还是会提前结束，你参考今天之前的版本是怎么解析的，至少要把原来就能用的改回来"

**根因定位（最终结论，助手总结 seq=326265）**：

> 经真实日志与请求复现，定位到两点：
> 1. **流式发射回归**：今天的提交把流式 Holdback 改成基于 `emittedLen` + bare-tag 多标记边界（`startMarkers`）。结果模型在流中输出的工具调用（如 `run_command`）**未作为标准 `functionCall` 正确交付给 IDE**，IDE 随即切回内置模型（日志里 `run_command` 检测后立刻 `gemini-3.1-flash-lite`），表现为提前结束。
> 2. **参考格式差异**：`sensenova-6.8-flash-lite` 走的是标准 OpenAI `delta.tool_calls`（native tool call），非纯文本标签；原始模型发 `run_command "ls -la"`，代理应翻译为 `list_dir` 并发射 `functionCall`。

**最终修复方案（本次会话采纳的方向）**：按用户"至少把原来就能用的改回来"的意见，把流式发射逻辑**还原到 HEAD~1（`6f342da`，即之前对 sensenova 有效的版本）**，同时保留解析层的泄漏修复：

- **还原 `mapOpenAIChunkToGemini` 为 pre-today 版本**：只持有 `TOOL_CALL_START_MARKERS`，去掉 `emittedLen` 累计与 bare-tag 多标记 Holdback，恢复之前可用的工具调用交付逻辑。
- **保留解析层修复**（位于 `parseDSMLToolCalls`，不涉流式发射）：非对称闭合标签（`asymTagNamedRegex`）、`extractXmlInnerArgs`、`validateBareArgs` `some()` 放宽、反斜杠路径转义。
- 相应调整 2 个流式测试断言。
- **验证**：全部 **236 个测试通过**；重新 `tsc` 编译（确认 `dist` 中无 `emittedLen`/bare `startMarkers`、保留解析层修复）；重新部署并重启 IDE；真实请求验证 `run_command "ls -la"` → 翻译为 `list_dir` 并正确发射 `functionCall` + `STOP`。

**部署产物 / 备份**：
- 源层构建：`D:\programme\antigravity-add-model\dist\proxy\translators\openai.js`
- 部署：`C:\Users\21855\AppData\Local\Programs\Antigravity IDE\resources\app\out\proxy\proxy\translators\openai.js`
- 备份目录：`C:\Users\21855\AppData\Local\Temp\out_proxy_backup_183258`

> ⚠️ 特别注意：会话中还记录到一个 **`git stash`（`temp-baseline-test`）**，其 `mapOpenAIChunkToGemini` 用的是另一套 `emittedTextLen` 边界算法，且**不含**非对称 / XML 泄漏修复。这可能是用户想保留的另一候选版本，需要后续甄别——它是排障过程中的"备选方案"之一，可能与最终代码不一致。

### 阶段 4：最新提交与仪表盘相关修复（`session-4cb87f37` 及 HEAD 提交 `abcc210`）

- 最新提交 `abcc210`（19:14）："feat: 新增raw stream调试开关 优化仪表盘UI与翻译器 补充测试和部署脚本"。其中 **raw stream 调试开关**实际落在 `src/proxy.ts`（`rawStreamEnabled()`，字节 123–674 区域），用于输出原始上游 chunk 日志，辅助排查 tool-call 失败。
- 另有一个**独立 bug**（`session-4cb87f37`）：**自定义模型在面板中不显示**。根因是 `src/proxy/dashboardHtml.ts` 内联 `<script>` 包在反引号模板字符串里，其中正则 `id.replace(/^models\//, '')` 用**单反斜杠**书写，模板字符串运行时把 `\/` 还原成 `/`、`\b` 还原为退格符、`\w` 还原为 `w`，生成到浏览器的内联脚本变成**非法 JS**（`/^models//` → `Unexpected token ','`），导致模型列表（"已加载模型" 0）渲染失败。修复为把反斜杠加倍，209 个测试通过、console 0 错误、5 张卡片正常渲染。**注意：这是"面板不显示模型"的问题，与"提前结束/解析错误"的运行时工具调用问题是两回事，但同样发生在今天。**

---

## 四、根因总结（提炼）

综合各会话的分析，**"自定义模型提前结束 / 返回内容解析错误"的本质是两类问题叠加、且被反复修复反复引入回归**：

1. **原生工具调用 vs 文本标签流 的兼容缺失**：不同模型（GLM5.2/部分开源 vs 商汤/sensenova/主流）以完全不同的方式表达工具调用（标准 `delta.tool_calls` vs 文本流里的 `<tool_call>`/`<run_command>`/`<DSML|...>` 标签）。代理必须同时支持两者，且要能正确识别"模型**真的在调用工具**"与"模型**在正文里提及工具标签**"。

2. **流式 Holdback / 发射逻辑的反复**：
   - 一开始**不 hold** → 原始标签泄漏成可见文本；
   - 加了**裸标签 + emittedLen 边界** → 又因为发射逻辑改动，使工具调用**未作为标准 `functionCall` 交付**，IDE 切回内置模型 → 提前结束；
   - 加了**过度宽松的裸标签解析** → 正文引用工具标签被误判为真实调用 → `invalid tool call` → 中断；
   - 加了**三重校验** → 又可能收紧过头 / 引入其它边界问题。

3. **"模型在流中先 open 工具块、但流提前结束/未闭合标签"**：模型输出了 `<tool_call:run_command>` 但没有等到闭合标签，或先发正文后发 `finish_reason: stop`，导致解析器在"未闭合"与"已发射"之间处理不当。

**关键技术纠结点**：`finishReason` 的规范化（Gemini Protobuf 只认 `STOP`，若代理包装成 `TOOL_CALL` 会导致 Go 语言服务器反序列化失败）、`emittedLen`/`pendingHeldSuffix` 的发射时机、以及"误报"与"漏报"不可两全的平衡。

---

## 五、当前状态与"仍未解决"的诚实评估

**结论（据已读取的会话日志）**：

- 最近的**明确修复**（`session-5de22404`，还原流式发射到 `6f342da` + 保留解析层修复、236 测试、真实请求验证 `run_command→list_dir` 正确）在该会话中是**已完成并部署的**，但该会话里**没有用户再次确认"已解决"的新反馈**——用户随后只说"继续"（继续会话），因此无法从日志判断这次是否真正修复。
- 用户在本轮明确指出"**最后仍然没有解决问题**"，说明在已尝试的所有修复之后，**问题实质上仍未彻底解决**。
- 代码仓库当前状态（截至检查）：
  - HEAD = `abcc210`（19:14），工作区仅有新增的 `.dsh-read/`（本报告读取会话时产生的临时解读目录，非项目代码）。
  - `src/proxy/translators/openai.ts` 中 `emittedLen`、`startMarkers` **已不存在**（说明"还原流式发射"已进入源码），而 `asymTagNamedRegex`、`extractXmlInnerArgs`、`validateBareArgs` **仍存在**（解析层修复保留），`rawStreamEnabled` 在 `openai.ts` 中为 0、在 `proxy.ts` 中为 128–674（raw stream 调试开关）。
  - ⚠️ 但 `dist/proxy/translators/openai.js` 的编译时间为 **18:32:33**，早于 HEAD 提交时间（19:14）——**存在"源码已更新、而 dist 构建产物未同步"的潜在不一致**，可能导致运行中的代理使用的是较旧的构建。这可能是"最后一次修复后仍未生效"的一个现实疑点（本次会话曾多次遇到"磁盘文件是修复版，但运行进程加载的是旧内存副本/旧端口进程"的类似情况）。

**为何仍难解决（从日志归纳）**：这是一个"回归型"问题——每次修复 A，就可能引入 B；而不同模型（商汤/sensenova 走原生，GLM/BAI 走文本标签）需求相反，很难用一种发射逻辑同时满足。加上"源码 ↔ dist ↔ IDE 部署目录 ↔ 运行进程内存"存在多层不一致风险，导致**代码看起来修好了，但运行时仍未生效**。

---

## 六、后续建议（供参考，需在实际会话中验证）

1. **先锁定"运行时代码到底是什么"**：确认运行中的代理是否加载了 `dist` 最新版；核对 `dist` 编译时间是否晚于最新源码修改；必要时彻底结束并重启 IDE / 代理进程（本会话曾遇到旧进程占用 50999 端口、加载旧内存副本的情况）。
2. **核对 `git stash temp-baseline-test`**：确认其是否为需要保留/合并的候选版本，避免与当前 `openai.ts` 混用。
3. **谨慎重写、优先"精确归因"的测试驱动修复**：不要盲目"加规则"（历史上每次加规则都带来回归）。建议建立**覆盖两类格式**（原生 `delta.tool_calls` 与 `content` 文本标签）**且区分"真实调用"与"正文提及/代码围栏"** 的最小回归集，再用真实日志（`rawStreamEnabled`、日志里的 `Detected N text tool call(s)`）逐条校准。
4. **重点排查 `finishReason` 与"未闭合标签 + 提前停止"分支**：这是"提前结束"最可能的残留根因，需要针对"模型输出 `run_command` 后未等到闭合标签/流提前结束"单独处理。
5. **确认是否存在"两类模型互相踩踏"的情况**：尝试在**只保留商汤/sensenova** 与 **只保留 GLM/BAI** 两种配置下分别测试，观察是否仍有"提前结束/泄漏"，从而定位是否为第三类共享逻辑（如全局 `StreamContext`）导致。

---

## 七、关键文件对照表

| 文件 | 作用 | 相关改动/问题 |
|------|------|--------------|
| `src/proxy/translators/openai.ts` | OpenAI 兼容模型翻译 / 工具调用解析与流式发射 | 核心排障文件；裸标签解析、`parseDSMLToolCalls`、流式发射逻辑 |
| `src/proxy/shared.ts` | `StreamContext`、`modelToolNames` / `modelToolSchemas`、`emittedLen`、`pendingHeldSuffix` | Holdback 机制、工具名注册 |
| `src/proxy/proxy.ts` | 本地代理、SSE 流式包装、路由、raw stream 调试开关 | `rawStreamEnabled()`、模型路由 |
| `src/proxy/modelConfigManager.ts` | 自定义模型配置读写 | 曾有"配置解析失败被当作空列表导致清空"bug（已修复） |
| `src/proxy/dashboardHtml.ts` | 可视化面板 / 仪表盘 | 内联脚本模板字符串反斜杠问题 → 面板不显示模型（已修复） |
| `src/proxy/translators/anthropic.ts` | Anthropic 协议翻译 | 曾修 `input_delta`→`input_json_delta` |
| `ARCHITECTURE.md` | 踩坑实录 | 坑 12 记录了本问题从 `<tool_call>` 泄漏到流式发射回归的完整演进 |

---

## 附：相关会话列表（`antigravity-add-model` 工作区）

| 会话 ID | 主题 |
|---------|------|
| `session-32fa0381` | **问题首次上报与多轮修复**（GLM5.2 / BAI V4 Flash 提前结束、解析问题；含两次"修复→回归"） |
| `session-5de22404` | **今日最终排障**（所有自定义模型全面失效；还原流式发射到 6f342da，236 测试，部署） |
| `session-4cb87f37` | 代码审查找出多 bug 并修复；**面板不显示模型**（dashboardHtml 反斜杠问题） |
| `session-c3900f99` | 添加自定义模型窗口 / 批量导入 / 自动获取模型列表 |
| `session-2f2d86e4` | （关联）工具调用不同模型 / 组长-组员模型工作流 |
| `session-90061189` | （关联）仪表盘按来源平台合并显示卡片 |

---

*报告完。本报告为基于本地会话日志的复盘，技术结论以会话中原助手分析为准；"当前是否彻底解决"因缺少用户最终确认，如实标注为"仍未确认/仍需验证"。*

---

## 八、本次落地修复（2026-09-03）

在上文复盘基础之上，本次基于**两轮 lead-worker（BAI 组长模型）根因核验 + 对源码逐条比对**，针对 `src/proxy/translators/openai.ts` 实施并验证了最小修复（根因与补丁细节见 `docs/` 目录的根因与最小修复文档）：

1. **RC1**：`hasUnclosedToolCallBlock` 识别冒号非对称 `<tool_call:name>` 并配对闭合，杜绝「opens>closes 永真」导致的无限扣留。
2. **RC1 / 中间帧泄漏**：流式发射器接入裸标签（基于 `isBlockBoundaryAndNotFenced` 的边界+围栏门控），并跟踪 `emittedLen`，修复 `<run_command>` 等裸标签在中间帧透出、以及「解析失败时静默丢弃正文」。
3. **RC2**：Pass5 的 `unclosedRegex` 兼容 `<tool_call:name>{json}`（无闭合），修复未闭合标签的泄漏与「调用丢失 + 提前 STOP」。
4. **RC3 / RC4**：新增 `validateForPass` 并扩散到各 Pass（未声明工具名不再误放行，避免 `invalid tool call` 中止整轮），并把代码围栏检查前移到多个 Pass。
5. **RC5 / RC8**：流式 `finish_reason='function_call'` 纳入工具调用收口，并在收口帧正确清理 `activeStreamContexts`。
6. **G6**：原本定义但未接线的 `hasUnclosedBareToolBlock` / `isBlockBoundaryAndNotFenced` 正式接线。

**验证**：258 项测试全部通过（236 基线 + 20 回归，其中 7 个「pin」用例已从固化旧缺陷行为翻转为期望行为；另新增 2 个防回归用例）。`tsc --noEmit` 0 错误，`dist` 已重建。

**部署**：已将修复后的 `dist\proxy\translators\openai.js` 覆盖到 Antigravity IDE 安装目录资源（`...\resources\app\out\proxy\proxy\translators\openai.js`），原文件备份为同目录 `openai.js.bak-20260903_104513`。IDE 重启后生效。

> 注：本文档早前的「当前是否彻底解决仍未确认」现已被本次落地修复与全部单测、部署验证更新；但**在真实 IDE 会话中是否对 GLM 5.2 / BAI V4 Flash / BAI V4 Flash Vision 完全生效**，仍以用户 IDE 重启后实测为准。
