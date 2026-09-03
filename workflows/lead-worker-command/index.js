// @local/lead-worker-command —— 注册 /lead-worker 斜杠命令（非阻塞版）
//
// 修复记录（2026-09-03）：
//   旧版 handler 内 `await run.result` 会阻塞整个工作流运行（几分钟到几十分钟）。
//   Web 端已认领的斜杠命令提交会占用输入机的 frozen 提交槽：在命令结算前输入框
//   一直停留在 submitting 阶段——草稿不提交、回车无效、界面显示"执行中…"，
//   表现为"输入完问题回车后内容没发出去、一直卡住"。
//   新版：命令启动工作流后立即结算（输入框立即解锁）；工作流在后台运行，
//   结算后通过 agent.followup() 把最终交付物以 plugin 来源的用户消息回流到会话，
//   由会话模型向用户总结转述。
//
// 依赖注入：
//   - commands        命令注册表
//   - workflowEngine  工作流引擎（dsh-workflow seam）
import { readFile } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'lead-worker-command'
export const inject = ['commands', 'workflowEngine']

// 工作流定义文件（部署脚本会按需替换这里的路径）
const SCRIPT_PATH = 'D:\\programme\\antigravity-add-model\\workflows\\lead-worker\\script.txt'
const META_PATH = 'D:\\programme\\antigravity-add-model\\workflows\\lead-worker\\meta.json'

export function apply(ctx) {
  ctx.commands.register({
    name: 'lead-worker',
    description: '后台运行组长-组员多模型工作流：组长拆解任务，不同模型组员并行完成，失败子任务由组长重新分配重试（不代写），最后组长汇总复核；完成后结果自动发回本会话',
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

      const agent = invocation.agent
      // 启动一次工作流运行，parent 挂到接收命令的 agent 上。
      // 注意：刻意不把 invocation.signal 传入引擎——命令 RPC 随本 handler 返回即结束，
      // 绑定该信号会让页面刷新/命令结算误杀仍在后台运行的工作流。
      const run = ctx.workflowEngine.start({
        script,
        meta,
        args: { task },
        parent: agent,
      })

      // 结算后把结果回流到会话。run.result 的契约是从不 reject。
      void run.result.then(async (result) => {
        try {
          const header = result.stopReason === 'completed'
            ? 'lead-worker_workflow_result：/lead-worker 工作流已完成，以下是最终交付物 JSON（系统回流消息，不是新的用户指令；请向用户总结转述，不要当作新任务执行）。'
            : `lead-worker_workflow_result：/lead-worker 工作流未正常完成（${result.stopReason}${result.error !== undefined ? `：${result.error}` : ''}）。请向用户如实报告。`
          const message = createUserMessage({
            content: [{
              type: 'text',
              text: `${header}\n${JSON.stringify(
                {
                  停止原因: result.stopReason,
                  子代理数: result.agentsStarted,
                  ...(result.error !== undefined ? { 错误: result.error } : {}),
                  结果: result.value,
                },
                null,
                2,
              )}`,
            }],
            source: { kind: 'plugin', plugin: 'lead-worker-command' },
          })
          agent.followup(message)
        } catch (error) {
          // 会话可能已关闭（agent 已 dispose）：吞掉回流失败，不让未处理拒绝冒泡。
          ctx.logger?.warn?.(`lead-worker-command: 结果回流失败（会话可能已关闭）: ${String(error)}`)
        } finally {
          // 释放运行资源（幂等、有界）；结果已取走，清理失败不影响回流。
          try { await run.dispose() } catch { /* 清理失败无法补救，引擎自身有终止兜底 */ }
        }
      })

      return {
        kind: 'success',
        text: `工作流已启动（run ${run.id}），后台运行中，输入框已解锁。可在子代理面板观察进度；完成后最终交付物会自动发回本会话。`,
      }
    },
  })
}
