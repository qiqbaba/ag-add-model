# 组长-组员 工作流（lead-worker）

> 一个可复用的"组长派发 → 多模型组员并行 → 组长汇总复核"工作流。

## 文件说明

| 文件 | 作用 |
|---|---|
| `script.txt` | workflow 的脚本正文（运行时要原样作为 `workflow` 的 `script` 参数） |
| `meta.json` | workflow 的 meta（运行时要作为 `workflow` 的 `meta` 参数） |
| `README.md` | 本说明 |

## 如何复用（推荐：交给主代理装载）

**不要手动复制粘贴脚本。** 直接对会话里的主代理说一句话：

> 用组长-组员工作流跑：<你的总任务>

主代理会读取 `script.txt` + `meta.json`，填入 `args.task` 后执行 `workflow`。可选参数：`args.workerCount`（组员数量，默认 3）、`args.pool`（自定义模型池，默认用 11 个 DSH 模型）。

## 手动调用格式（如需自行填 `workflow` 工具）

```jsonc
// meta 参数
{ /* 复制 meta.json 的全部内容 */ }

// args 参数
{
  "task": "<你的总任务>",
  "workerCount": 3
}

// script 参数
/* 复制 script.txt 的全部内容 */
```

## 常见改动

- **固定组长/组员**：把脚本里的随机抽取改成取固定下标（见 `workflow-lead-worker-template.md` 第五节）。
- **换模型池**：`args.pool` 传 `[{provider, model, label}, ...]`；或改 `script.txt` 顶部 `DEFAULT_POOL`。
