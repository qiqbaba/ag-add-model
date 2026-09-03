# 组长-组员 多模型协作 Workflow 模板

> 目标：**组长模型**拆解任务 → 派发给若干个**不同模型**的组员并行完成 → 组长最终**汇总并复核**。
> 组长与组员全部从「已添加模型」池中**随机挑选**，保证不同子代理用到不同模型。

## 一、模型池（随机来源）

本模板默认使用 DSH 配置 `~/.dsh/settings.yaml` 的 `llm-pi-ai` 网关下 11 个模型，分属两个 provider：

| provider | model | 说明 |
|---|---|---|
| `sensenova` | `deepseek-v4-flash` | 商汤 V4 Flash |
| `sensenova` | `glm-5.2` | GLM 5.2 |
| `sensenova` | `sensenova-6.8-flash-lite` | 商汤 6.8 Flash Lite |
| `sensenova` | `deepseek-v4-pro` | DeepSeek V4 Pro |
| `sensenova` | `kimi-k3` | Kimi K3 |
| `bai` | `hy3` | Hy3 |
| `bai` | `glm-5.3-flash` | GLM 5.3 Flash |
| `bai` | `qwen3.8-flash` | Qwen3.8 Flash |
| `bai` | `deepseek-v4-flash` | BAI V4 Flash |
| `bai` | `mimo-v2.5` | Mimo V2.5 |
| `bai` | `deepseek-v4-flash-vision-exp` | BAI V4 Flash Vision |

> 通过 `args.pool` 可覆盖默认池（例如改为 `custom_models.json` 里的模型）；`args.workerCount` 控制组员数量；`args.task` 传入总任务。

## 二、运行方式

`workflow` 的 `script` 通过工具参数传入（不是读文件）。需要运行时，把「脚本本体」复制到 `workflow` 工具的 `script` 参数，「meta」复制到 `meta` 参数，任务通过 `args` 传入：

```jsonc
// args 示例
{
  "task": "把一个具体的总任务写在这里",
  "workerCount": 3
}
```

也可以直接告诉本会话的主代理（我）要跑的 `task`，由我代你执行。

## 三、脚本本体（script）

```js
// ===== 模型池：DSH llm-pi-ai（sensenova + bai），共 11 个 =====
const DEFAULT_POOL = [
  { provider: "sensenova", model: "deepseek-v4-flash",        label: "商汤 V4 Flash" },
  { provider: "sensenova", model: "glm-5.2",                   label: "GLM 5.2" },
  { provider: "sensenova", model: "sensenova-6.8-flash-lite",  label: "商汤 6.8 Flash Lite" },
  { provider: "sensenova", model: "deepseek-v4-pro",           label: "DeepSeek V4 Pro" },
  { provider: "sensenova", model: "kimi-k3",                   label: "Kimi K3" },
  { provider: "bai",       model: "hy3",                       label: "Hy3" },
  { provider: "bai",       model: "glm-5.3-flash",            label: "GLM 5.3 Flash" },
  { provider: "bai",       model: "qwen3.8-flash",            label: "Qwen3.8 Flash" },
  { provider: "bai",       model: "deepseek-v4-flash",        label: "BAI V4 Flash" },
  { provider: "bai",       model: "mimo-v2.5",                label: "Mimo V2.5" },
  { provider: "bai",       model: "deepseek-v4-flash-vision-exp", label: "BAI V4 Flash Vision" },
];

// 以 provider+model 作为唯一标识去重，避免组长/组员撞车
const key = (m) => `${m.provider}:${m.model}`;

// 从池中随机抽取 n 个不重复元素
function pickRandom(pool, n) {
  const arr = [...pool];
  const out = [];
  while (out.length < n && arr.length > 0) {
    const i = Math.floor(Math.random() * arr.length);
    out.push(arr.splice(i, 1)[0]);
  }
  return out;
}

// ===== 入参（args 未传时使用默认值 / 占位）=====
const POOL = (args && Array.isArray(args.pool) && args.pool.length) ? args.pool : DEFAULT_POOL;
const WORKER_COUNT = (args && Number.isInteger(args.workerCount)) ? args.workerCount : 3;
const TASK = (args && args.task && String(args.task).trim())
  ? String(args.task).trim()
  : "（占位：请在调用时的 args.task 里填写总任务）";

// 组长 1 个（随机），组员 WORKER_COUNT 个（随机，排除组长）
const [组长] = pickRandom(POOL, 1);
const 剩余池 = POOL.filter((m) => key(m) !== key(组长));
const 组员们 = pickRandom(剩余池, Math.min(WORKER_COUNT, 剩余池.length));

// ① 组长：拆解总任务为可并行子任务
phase("组长拆解分配");
const 组长拆解 = await agent(
  `你是组长（${组长.label}，模型 ${组长.model}）。\n` +
  `总任务：${TASK}\n` +
  `请把总任务拆解为 ${组员们.length} 个可并行子任务，输出 JSON（键为 tasks）。\n` +
  `tasks 为数组，每项为 { id, title, hint }；hint 是给组员的执行提示。`,
  {
    provider: 组长.provider,
    model: 组长.model,
    label: `组长-拆解分配 [${组长.provider}/${组长.model}]`,
    schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              hint: { type: "string" },
            },
            required: ["id", "title", "hint"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
);

const 子任务 = (组长拆解 && Array.isArray(组长拆解.tasks) && 组长拆解.tasks.length)
  ? 组长拆解.tasks
  : 组员们.map((_, i) => ({ id: `t${i + 1}`, title: `子任务 ${i + 1}`, hint: "按总任务自行处理" }));

// ② 组员：各用不同模型并行完成
phase("组员并行执行");
const 组员结果 = await Promise.all(
  子任务.map((t, i) => {
    const m = 组员们[i % 组员们.length];
    return agent(
      `你是组员（${m.label}）。请完成子任务：${t.title}\n执行提示：${t.hint}`,
      { provider: m.provider, model: m.model, label: `组员-${t.id} [${m.provider}/${m.model}]` },
    );
  }),
);

// ③ 组长：汇总 + 复核
phase("组长汇总复核");
const 最终交付 = await agent(
  `你是组长（${组长.label}）。以下是各子任务与对应组员输出，请合并、交叉复核，修正明显错误，给出最终交付物。\n\n` +
  子任务.map((t, i) => JSON.stringify({ 子任务: t, 组员输出: 组员结果[i] })).join("\n\n"),
  { provider: 组长.provider, model: 组长.model, label: `组长-汇总复核 [${组长.provider}/${组长.model}]` },
);

return {
  组长: `${组长.label}（${组长.model}）`,
  组员: 组员们.map((m) => `${m.label}（${m.model}）`),
  子任务数: 子任务.length,
  最终交付,
};
```

## 四、meta（配合上面 script 一起传）

```json
{
  "name": "lead-worker-triage",
  "description": "组长模型随机派发任务给多个不同模型组员，完成后组长汇总复核",
  "whenToUse": "需要拆分多任务、用不同模型协作、再由组长统一汇总复核的场景",
  "phases": [
    { "title": "组长拆解分配", "detail": "组长模型拆解总任务" },
    { "title": "组员并行执行", "detail": "各组员模型并行完成子任务" },
    { "title": "组长汇总复核", "detail": "组长模型汇总并复核输出" }
  ]
}
```

## 五、改动提示

- **改用 Antigravity `custom_models.json` 的模型**：把 `DEFAULT_POOL` 的每项 `{ provider, model, label }` 换成 `custom_models.json` 里的 `externalModelName`（provider 用对应协议名）。但**注意**：`workflow` 的 `agent({ provider, model })` 只能调用 DSH 网关已注册的模型；`custom_models.json` 里那些只经 Antigravity 本地代理调用的模型，DSH 不一定认识，直接填可能调用失败。
- **固定组长/组员模型**：把「随机挑选」那句换成 `const 组长 = POOL[0];`、`const 组员们 = POOL.slice(1, 1 + WORKER_COUNT);` 即可，其余不变。
- **组员数量**：通过 `args.workerCount` 调节，默认 3。
