// @local/lead-worker-command —— 注册 /lead-worker 斜杠命令
// 该命令读取工作流定义文件，并直接调用 DSH 的 workflow 引擎启动一次
// "组长派发 → 不同模型组员并行 → 组长汇总复核" 的运行。
//
// 依赖注入：
//   - commands        命令注册表
//   - workflowEngine  工作流引擎（dsh-workflow seam）
import { readFile } from 'node:fs/promises'

export const name = 'lead-worker-command'
export const inject = ['commands', 'workflowEngine']

// 工作流定义文件（部署脚本会按需替换这里的路径）
const SCRIPT_PATH = 'D:\\programme\\antigravity-add-model\\workflows\\lead-worker\\script.txt'
const META_PATH = 'D:\\programme\\antigravity-add-model\\workflows\\lead-worker\\meta.json'

export function apply(ctx) {
  ctx.commands.register({
    name: 'lead-worker',
    description: '运行组长-组员多模型工作流：组长拆解任务，若干不同模型组员并行完成，组长汇总复核',
    input: { hint: '<总任务>', images: false },
    handler: async (invocation) => {
      const task = invocation.rawInput.trim()
      if (task === '') return { kind: 'error', text: '用法：/lead-worker <总任务>' }

      const script = await readFile(SCRIPT_PATH, 'utf8').catch(() => null)
      const metaRaw = await readFile(META_PATH, 'utf8').catch(() => null)
      if (script === null || metaRaw === null) {
        return { kind: 'error', text: `无法读取工作流定义：${SCRIPT_PATH}` }
      }
      let meta
      try {
        meta = JSON.parse(metaRaw)
      } catch {
        return { kind: 'error', text: `工作流 meta 不是合法 JSON：${META_PATH}` }
      }

      // 启动一次工作流运行，parent 挂到接收命令的 agent 上
      const run = ctx.workflowEngine.start({
        script,
        meta,
        args: { task },
        parent: invocation.agent,
        signal: invocation.signal,
      })
      const result = await run.result

      if (result.stopReason !== 'completed') {
        const detail = result.error ? ` — ${result.error}` : ''
        return { kind: 'error', text: `工作流未完成：${result.stopReason}${detail}` }
      }
      return {
        kind: 'success',
        text: `工作流完成（${result.agentsStarted} 个子代理）。\n${JSON.stringify(result.value, null, 2)}`,
      }
    },
  })
}
