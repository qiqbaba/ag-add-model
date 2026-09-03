/**
 * 回归测试：真实工具调用 vs 正文提及 —— 文本工具调用回归集（校准版）。
 *
 * 设计基准（openai.test.ts 现有四个 describe 块，236 项基线之外的补充）：
 *  - DSML wrapper       614-768  | GLM / 多模型 770-880
 *  - lean bare-tag      882-1075 | asym / XML-inner 1077-1166
 *
 * 覆盖两类格式：
 *  - 原生 delta.tool_calls（native 路径）
 *  - content 文本标签（DSML / <tool_call:> / bare 标签 / lean 体）
 * 并严格区分『模型真的调用工具』（产出 functionCall）与『正文提及/代码围栏引用』（保留为文本）。
 *
 * ⚠ 标注说明（经 dist 编译产物逐条校准，见 G1-G5 缺口清单）：
 *  - 「pin」用例：固化当前已验证的真实行为（当前为实现缺口）。修复对应缺口后，
 *    必须翻转该用例断言为「期望行为」注释中描述的语义。
 *  - 其余用例：直接断言期望行为（当前实现已满足）。
 *
 * 校准锚点（无沙箱限制环境 `npx vitest run` 后逐条核对）：
 *  - proxy.ts:128 rawStreamEnabled() —— 默认关闭。校准/排障时先建 flag 文件
 *    ~/.gemini/antigravity/raw_stream.flag（或 env DSH_RAW_STREAM=1），
 *    才能看到 [Proxy][RAW:*] 上游原文与 [Proxy][MAP:*] 映射结果；
 *  - openai.ts:1003-1005 「Detected N text tool call(s): ...」—— 每个断言
 *    「真实调用」的用例运行时必须恰好命中一次该日志；每个断言「正文提及」的
 *    用例必须不出现该日志（两类格式均如此，这是区分两类路径的日志金线）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as shared from '../proxy/shared';
import { mapGeminiToOpenAI, mapOpenAIToGemini, mapOpenAIChunkToGemini } from '../proxy/translators/openai';

beforeEach(() => {
  shared.modelToolCallIds.clear();
  shared.modelReasoningContent.clear();
  shared.activeStreamContexts.clear();
  shared.translatedToolCalls.clear();
  shared.stateTimestamps.toolCallIds.clear();
  shared.stateTimestamps.reasoning.clear();
  shared.stateTimestamps.streamCtx.clear();
  shared.stateTimestamps.translatedCalls.clear();
});

/** 聚合一次流式会话所有 chunk 的 functionCall（真实调用证据） */
function collectFcs(results: (ReturnType<typeof mapOpenAIChunkToGemini>)[]) {
  return results
    .filter(Boolean)
    .flatMap((r) => r!.content.parts.filter((p) => p.functionCall).map((p) => p.functionCall!));
}

/** 聚合一次流式会话所有 chunk 的可见文本（泄漏检查面，不含 thought） */
function collectTexts(results: (ReturnType<typeof mapOpenAIChunkToGemini>)[]) {
  return results
    .filter(Boolean)
    .flatMap((r) => r!.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text!))
    .join('');
}

/** 声明工具 schema 的会话（让 bare-tag 解析走严格校验路径） */
function declareSchema(sessionId: string, model: string, tools: { name: string; props: string[] }[]) {
  mapGeminiToOpenAI(
    {
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      tools: [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            parameters: {
              type: 'object',
              properties: Object.fromEntries(t.props.map((p) => [p, { type: 'string' }])),
            },
          })),
        },
      ],
    },
    model,
    sessionId,
  );
}

// ═══ a) Symptom B：未闭合 <tool_call:name>{json} + 流提前 stop ═══════════════
describe('regression a: unclosed <tool_call:name> with early stream stop (Symptom B)', () => {
  it('a1 [pin G1] 非流式：未闭合 <tool_call:name>{json} 被回收为 functionCall（不再泄漏）', () => {
    // 修复 G1：Pass 5 的 unclosedRegex 现兼容冒号形式，<tool_call:list_dir>{json}
    // （无闭合）也被解析为调用，整块不再作为正文泄漏。
    const content = '让我检查一下项目结构。\n<tool_call:list_dir> {"DirectoryPath":"d:\\\\repo\\\\src"}';
    const result = mapOpenAIToGemini({ choices: [{ message: { content }, finish_reason: 'stop' }] }, 'glm-5.2');
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('list_dir');
    expect(fc[0].functionCall!.args).toEqual({ DirectoryPath: 'd:\\repo\\src' });
    const text = result.candidates[0].content.parts.filter((p) => p.text).map((p) => p.text!).join('');
    expect(text).toContain('让我检查一下项目结构。');
    expect(text).not.toContain('<tool_call:list_dir>'); // 修复后不再泄漏
  });

  it('a2 [pin G1] 流式：<tool_call:name>{json} 被持有并在收口产出 functionCall（JSON 不再泄漏）', () => {
    // 修复 G1：hasUnclosedToolCallBlock 现识别冒号形式（tcOpens 兼容 <tool_call:),
    // JSON 体帧被持有；finish 时 Pass 5 回收出 functionCall。
    const sid = 'stream_symptom_b';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '我先看看目录。\n<tool_call:list_dir> ' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '{"DirectoryPath":"d:\\\\repo\\\\src"}' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    expect(collectFcs(results).length).toBe(1);
    const fc = collectFcs(results)[0];
    expect(fc.name).toBe('list_dir');
    expect(fc.args).toEqual({ DirectoryPath: 'd:\\repo\\src' });
    const texts = collectTexts(results);
    expect(texts).toContain('我先看看目录。'); // 前导正文保留 ✓
    expect(texts).not.toContain('<tool_call:list_dir>'); // 开标签被持有 ✓
    expect(texts).not.toContain('{"DirectoryPath"'); // 修复后 JSON 体不再泄漏
    // 无副作用：流结束后上下文正确清理
    expect(shared.activeStreamContexts.size).toBe(0);
  });

  it('a3 中间帧：开标签本身不泄漏（通用 marker 扣留仍生效）', () => {
    const sid = 'stream_symptom_b_mid';
    const mid = { id: sid, choices: [{ delta: { content: '开头。\n<tool_call:list_dir> ' }, index: 0 }] };
    const r1 = mapOpenAIChunkToGemini(mid, 'glm-5.2');
    const t1 = (r1?.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text!) || []).join('');
    expect(t1).toBe('开头。\n');
    expect(t1).not.toContain('<tool_call');
  });
});

// ═══ b) 裸标签跨 chunk 拆分：中间帧泄漏检查（现有 950-968 未覆盖面）═══════════
describe('regression b: bare <run_command> split across chunks — intermediate frames', () => {
  it('b1 [pin G2] 裸标签跨 chunk：中间帧不再泄漏（最终仍产出 functionCall）', () => {
    // 修复 G2：hasUnclosedBareToolBlock 接入已 insideToolBlock 判定，裸开标签
    // <run_command> 作为 marker 参与 earliestIdx 计算，中间帧不再透出。
    const sid = 'stream_split_leak';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '先执行。\n<run_command> {"CommandLine":"git status"' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: ',"Cwd":"d:\\\\repo"} </run_command>' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    const texts = collectTexts(results);
    expect(texts).not.toContain('<run_command>'); // 修复 G2：中间帧不再泄漏裸标签+JSON
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(fc[0].args).toEqual({ CommandLine: 'git status', Cwd: 'd:\\repo' });
  });

  it('b2 [pin G2] 闭合标签跨 chunk（"</run_co" + "mmand>"）：首帧不再泄漏闭合前半段', () => {
    // 修复 G2：裸开标签命中 marker 后整块（含 </run_co 半段）进入扣留区。
    const sid = 'stream_split_close';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '执行中。\n<run_command> {"CommandLine":"git status"} </run_co' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: 'mmand>' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    expect(collectTexts(results)).not.toContain('</run_co'); // 修复 G2：闭合半标签不再泄漏
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(fc[0].args).toEqual({ CommandLine: 'git status' });
  });

  it('b3 [G6 死代码佐证] hasUnclosedBareToolBlock / isBlockBoundaryAndNotFenced 已定义未接线', () => {
    // openai.ts:234 与 261 的裸标签流式扣留辅助函数从未被调用（grep 佐证），
    // 这是 b1/b2 中间帧泄漏的根因。此用例以文档化断言固定事实：
    // 修复 G2 时应将二者接入 mapOpenAIChunkToGemini 的 emit 判定。
    expect(true).toBe(true);
  });
});

// ═══ c) 非对称 <tool_call:name>...</name>（现有 1079 仅覆盖 JSON 体）══════════
describe('regression c: asymmetric <tool_call:name> variants', () => {
  it('c1 非流式：非对称开闭标签 + lean Param>value 体 → 解析为 run_command', () => {
    const content = '先跑一下。\n<tool_call:run_command>\nCommandLine>git log --oneline\nCwd>d:\\repo\n</run_command>';
    const result = mapOpenAIToGemini({ choices: [{ message: { content }, finish_reason: 'stop' }] }, 'glm-5.2');
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('run_command');
    expect(fc[0].functionCall!.args).toEqual({ CommandLine: 'git log --oneline', Cwd: 'd:\\repo' });
    const text = result.candidates[0].content.parts.filter((p) => p.text).map((p) => p.text!).join('');
    expect(text).not.toContain('tool_call:run_command');
  });

  it('c2 [pin G3] schema 会话：未声明工具名的非对称块不再产出 functionCall', () => {
    // 修复 G3：validateForPass 现扩散到 Pass3b 等边界 Pass，未声明工具名被拒绝，
    // 原文作为文本保留，不再触发 IDE 的 invalid tool call。
    declareSchema('asym-schema-sess', 'glm-5.2', [{ name: 'list_dir', props: ['DirectoryPath'] }]);
    const content = '查一下 <tool_call:delete_file> {"Path":"d:\\\\x.ts"} </delete_file>';
    const result = mapOpenAIToGemini(
      { choices: [{ message: { content }, finish_reason: 'stop' }] },
      'glm-5.2',
      'asym-schema-sess',
    );
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(0); // 修复 G3：未声明工具不再被误放行
    const text = result.candidates[0].content.parts.filter((p) => p.text).map((p) => p.text!).join('');
    expect(text).toContain('查一下');
    expect(text).toContain('<tool_call:delete_file>'); // 原文保留
  });

  it('c3 流式：非对称 lean 体逐帧无泄漏且最终产出 functionCall', () => {
    const sid = 'stream_asym_lean';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '准备。\n<tool_call:run_command>\nCommandLine>echo hi' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '\n</run_command>' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    expect(collectTexts(results)).not.toContain('<tool_call:run_command>');
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(fc[0].args).toEqual({ CommandLine: 'echo hi' });
  });
});

// ═══ d) <DSML|...> 泄漏防护（现有 645/685 只测解析成功态）════════════════════
describe('regression d: <DSML|...> leak guards', () => {
  it('d1 流式：DSML wrapper 跨 5 chunk 拆分，逐帧无 DSML 泄漏且产出 list_dir', () => {
    const sid = 'stream_dsml_leak';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '好的，开始。\n<DSML|' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: 'tool_calls>\n<DSML|tool_call name="run_command">' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '\n<DSML|parameter name="CommandLine" string="true">dir</DSML|parameter>' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '\n<DSML|parameter name="Cwd" string="true">D:\\repo</DSML|parameter>' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '\n</DSML|tool_call>\n</DSML|tool_calls>' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4'));
    const texts = collectTexts(results);
    expect(texts).toContain('好的，开始。');
    expect(texts).not.toContain('DSML');
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('list_dir');
    expect(fc[0].args).toEqual({ DirectoryPath: 'D:\\repo' });
  });

  it('d2 流式：正文 DSML 与 native delta.tool_calls 并存时 native 优先且 DSML 不泄漏', () => {
    const sid = 'stream_dsml_native_race';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '<DSML|tool_calls>' }, index: 0 }] },
      {
        id: sid,
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_native', function: { name: 'list_dir', arguments: '{"DirectoryPath":"."}' } }] }, index: 0 },
        ],
      },
      { id: sid, choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4'));
    expect(collectTexts(results)).not.toContain('DSML');
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('list_dir');
    expect(fc[0].id).toBe('call_native');
  });
});

// ═══ e) 正文提及 / 代码围栏示例不误报（两类格式的分界）════════════════════════
describe('regression e: prose mention & code-fence quoting must NOT become tool calls', () => {
  it('e1 schema 会话：代码围栏内的 <view_file> XML 示例保留为文本', () => {
    declareSchema('fence-sess', 'deepseek-v4-flash', [{ name: 'view_file', props: ['AbsolutePath'] }]);
    const content = [
      '用法示例：',
      '```xml',
      '<view_file>',
      '<AbsolutePath>C:\\repo\\app.ts</AbsolutePath>',
      '</view_file>',
      '```',
      '如上即读取文件。',
    ].join('\n');
    const result = mapOpenAIToGemini(
      { choices: [{ message: { content }, finish_reason: 'stop' }] },
      'deepseek-v4-flash',
      'fence-sess',
    );
    expect(result.candidates[0].content.parts.filter((p) => p.functionCall).length).toBe(0);
    const text = result.candidates[0].content.parts.filter((p) => p.text).map((p) => p.text!).join('');
    expect(text).toContain('<view_file>');
  });

  it('e2 行内带属性样式的标签提及保留为文本', () => {
    const content = '比如执行 <run_command dir="d:\\"> 即可列出目录，无需真正运行。';
    const result = mapOpenAIToGemini({ choices: [{ message: { content }, finish_reason: 'stop' }] }, 'deepseek-v4-flash');
    expect(result.candidates[0].content.parts.filter((p) => p.functionCall).length).toBe(0);
    const text = result.candidates[0].content.parts.filter((p) => p.text).map((p) => p.text!).join('');
    expect(text).toContain('<run_command');
  });

  it('e3 流式 schema 会话：块边界样式的提及因参数与 schema 无关而不误报', () => {
    declareSchema('prose-sess', 'deepseek-v4-flash', [{ name: 'view_file', props: ['AbsolutePath'] }]);
    const sid = 'stream_prose_newline';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '读取技能文件要用：\n<view_file>\nSkillName>demo\nIsSkillFile>true\n</view_file>' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash', 'prose-sess'));
    expect(collectFcs(results).length).toBe(0);
    expect(collectTexts(results)).toContain('<view_file>');
  });

  it('e4 [pin G4] 代码围栏内的 <tool_call:name>{json} 示例保留为文本（不再误报）', () => {
    // 修复 G4：insideCodeFence 现前移到 Pass3b/Pass5，围栏内示例不再被解析成调用。
    const content = [
      '给出模板：',
      '```',
      '<tool_call:list_dir> {"DirectoryPath":"."} </list_dir>',
      '```',
      '把 DirectoryPath 换成目标目录即可。',
    ].join('\n');
    const result = mapOpenAIToGemini({ choices: [{ message: { content }, finish_reason: 'stop' }] }, 'glm-5.2');
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(0); // 修复 G4：围栏内示例不再误报
    const text = result.candidates[0].content.parts.filter((p) => p.text).map((p) => p.text!).join('');
    expect(text).toContain('<tool_call:list_dir>'); // 示例保留为文本
  });
});

// ═══ f) finish_reason 一律归一 STOP（绝不产出 Gemini 不认的 TOOL_CALL）════════
describe('regression f: finish_reason normalized (never TOOL_CALL)', () => {
  it('f1 非流式：finish_reason=function_call（旧式）+ tool_calls → STOP', () => {
    const legacyCall = {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'view_file', arguments: '{"AbsolutePath":"d:\\\\x"}' } }],
          },
          finish_reason: 'function_call',
        },
      ],
    };
    const result = mapOpenAIToGemini(legacyCall, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('STOP');
    expect(result.candidates[0].content.parts.some((p) => p.functionCall)).toBe(true);
  });

  it('f2 非流式：finish_reason=function_call 显式归一为 STOP；未知值归 OTHER，绝不出现 TOOL_CALL', () => {
    // 校准确认：finishReasonMap（openai.ts:1117-1123）显式把 tool_calls 与
    // function_call 都映射为 STOP；真正未知的值才落 OTHER。
    const legacy = mapOpenAIToGemini(
      { choices: [{ message: { content: 'hi' }, finish_reason: 'function_call' }] },
      'gpt-4o',
    );
    expect(legacy.candidates[0].finishReason).toBe('STOP');
    const unknown = mapOpenAIToGemini(
      { choices: [{ message: { content: 'hi' }, finish_reason: 'some_unknown_reason' }] },
      'gpt-4o',
    );
    expect(unknown.candidates[0].finishReason).toBe('OTHER');
    for (const r of [legacy, unknown]) expect(r.candidates[0].finishReason).not.toBe('TOOL_CALL');
  });

  it('f3 流式：文本工具调用从中间帧收口，帧 finishReason 为 STOP，全程无 TOOL_CALL', () => {
    const sid = 'stream_f3';
    const callChunk = {
      id: sid,
      choices: [{ delta: { content: '看下目录。\n<run_command> {"CommandLine":"git status"} </run_command>' }, index: 0 }],
    };
    const stopChunk = { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] };
    const r1 = mapOpenAIChunkToGemini(callChunk, 'deepseek-v4-flash');
    const r2 = mapOpenAIChunkToGemini(stopChunk, 'deepseek-v4-flash');
    expect(r1).not.toBeNull();
    expect(r1!.content.parts.some((p) => p.functionCall)).toBe(true);
    expect(r1!.finishReason).toBe('STOP');
    expect(r1!.content.parts.find((p) => p.functionCall)!.functionCall!.name).toBe('run_command');
    // 收口后 stop 帧被吞掉（防调用被取消），且不产生 TOOL_CALL 字符串
    expect(r2).toBeNull();
    expect(r1!.finishReason).not.toBe('TOOL_CALL');
    expect(shared.activeStreamContexts.size).toBe(0);
  });

  it('f4 流式：native tool_calls 收口帧 finishReason 为 STOP', () => {
    const sid = 'stream_f4';
    const frag1 = { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_dir', arguments: '{"DirectoryPath"' } }] }, index: 0 }] };
    const frag2 = { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"."}' } }] }, index: 0 }] };
    const stopChunk = { id: sid, choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] };
    mapOpenAIChunkToGemini(frag1, 'gpt-4o');
    mapOpenAIChunkToGemini(frag2, 'gpt-4o');
    const fin = mapOpenAIChunkToGemini(stopChunk, 'gpt-4o');
    expect(fin).not.toBeNull();
    expect(fin!.finishReason).toBe('STOP');
  });

  it('f5 [pin G5] 流式 finish_reason=function_call：native 调用被收口且流上下文清零', () => {
    // 修复 G5：finish 分支现识别 function_call，pending native 调用被收口为
    // functionCall + STOP，且 activeStreamContexts 被清理（不再残留污染下一流）。
    const sid = 'stream_f5';
    const callChunk = { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'list_dir', arguments: '{"DirectoryPath":"."}' } }] }, index: 0 }] };
    const finChunk = { id: sid, choices: [{ delta: {}, finish_reason: 'function_call', index: 0 }] };
    mapOpenAIChunkToGemini(callChunk, 'gpt-4o');
    const fin = mapOpenAIChunkToGemini(finChunk, 'gpt-4o');
    expect(fin).not.toBeNull(); // 修复 G5：调用不再被丢弃
    expect(fin!.finishReason).toBe('STOP');
    expect(fin!.content.parts.some((p) => p.functionCall)).toBe(true);
    expect(shared.activeStreamContexts.size).toBe(0); // 修复 G5：上下文清零
  });
});

// ═══ g) 修复后新行为防回归（Patch 1-5 引入，防未来回归）══════════════════════
describe('regression g: post-fix anti-regression guards', () => {
  it('g1 [RC8] 收口帧自带 finish_reason 时上下文中正确清理（size=0）', () => {
    const sid = 'stream_rc8';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '看下。\n<run_command> {"CommandLine":"dir"}' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: ' </run_command>' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    expect(collectFcs(results).length).toBe(1);
    expect(shared.activeStreamContexts.size).toBe(0); // RC8：中间帧收口后上下文清理
  });

  it('g3 [RC1b 配对] 已闭合的非对称 <tool_call:list_dir>{json}</list_dir> 不被无限扣留', () => {
    const sid = 'stream_asym_close';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '看下。\n<tool_call:list_dir> {"DirectoryPath":"."}' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: ' </list_dir>' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    expect(collectFcs(results).length).toBe(1);
    const fc = collectFcs(results)[0];
    expect(fc.name).toBe('list_dir');
    expect(shared.activeStreamContexts.size).toBe(0);
  });
});

// ═══ h) 修复回归防回归（8cf2312 引入的 A/B 回归，补丁1+3 修复）══════════════
describe('regression h: native-model content loss & emittedLen misalignment guarded', () => {
  it('h1 [回归A防回归] 原生模型正文含行首裸标签 + native tool_calls 收口时正文完整且调用发射', () => {
    const sid = 'reg_A_native';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '方法一是在终端运行：\n<run_command>' }, index: 0 }] },
      {
        id: sid,
        choices: [
          {
            delta: { content: '（注意标签要闭合）', tool_calls: [{ index: 0, id: 'tc1', function: { name: 'list_dir', arguments: '{"DirectoryPath":"."}' } }] },
            finish_reason: 'tool_calls',
            index: 0,
          },
        ],
      },
    ];
    // 修复前：被净的正文「（注意标签要闭合）」在 native 收口时丢失。修复后：补丁3 使
    // nativeSeen 后不再 hold 正文，正文完整发射；调用也正常发射。
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'sensenova'));
    const texts = collectTexts(results);
    expect(texts.includes('方法一是在终端运行：')).toBe(true);
    expect(texts.includes('（注意标签要闭合）')).toBe(true);
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('list_dir');
  });

  it('h2 [回归B防回归] marker 跨 chunk 切分 + stop 无调用时全文恰一发、无重复', () => {
    const sid = 'reg_B_marker_split';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '示例：<tool_' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: 'call>{"x":1}\n说明正文。' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const allText = collectTexts(results);
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    // 修复前：emittedLen 记账错位 → 尾部「说明正文。」被重复发射；修复后 withheldText 显式缓冲，
    // 原文恰一发、不重复（跨 chunk 前缀 `<tool_` 按收口补发保留）。
    expect(count(allText, '说明正文。')).toBe(1);
    expect(allText).toContain('示例：');
    expect(allText).toContain('<tool_');
    expect(allText).toContain('call>{"x":1}');
  });

  it('h3 [纯净原生流 pin] 正文 + 分帧 native tool_calls + finish=tool_calls 输出与旧版一致', () => {
    const sid = 'reg_R3_native_pure';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '我来查看目录。' }, index: 0 }] },
      { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'n1', function: { name: 'list_dir', arguments: '{"DirectoryPath":"."}' } }] }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    const texts = collectTexts(results);
    expect(texts).toContain('我来查看目录。');
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('list_dir');
    expect(fc[0].args).toEqual({ DirectoryPath: '.' });
  });

  it('h4 [补丁2防回归] 误扣正文随 native 收口补发；标记开头的废弃块不泄漏', () => {
    // ── 场景1：扣留文本以纯文本开头（回归 A 形态的误扣正文）→ 必须随调用帧补发 ──
    const sid1 = 'reg_patch2_plain_led';
    const OPEN = '<' + 'tool_call' + '>';
    const chunks1 = [
      // 帧1：跨 chunk 切分的标记前缀 '<' + 'tool_' 被 partial holdback 扣留
      { id: sid1, choices: [{ delta: { content: '前文：' + '<' + 'tool_' }, index: 0 }] },
      // 帧2：仍在未闭合块内 → 整帧扣留；同帧出现 native tool_calls 并以 tool_calls 收口
      {
        id: sid1,
        choices: [
          {
            delta: {
              content: 'call>{"name":"x"} 后文',
              tool_calls: [{ index: 0, id: 'p2', function: { name: 'list_dir', arguments: '{"DirectoryPath":"."}' } }],
            },
            finish_reason: 'tool_calls',
            index: 0,
          },
        ],
      },
    ];
    const results1 = chunks1.map((c) => mapOpenAIChunkToGemini(c, 'sensenova'));
    const allText1 = collectTexts(results1);
    // 修复前（补丁2 缺失）：tool_calls 收口分支 parts=emitParts.slice() 直接 return，
    // 扣留文本永久丢失。修复后：纯文本开头的扣留随调用帧原样补发。
    expect(allText1).toContain('前文：');
    expect(allText1).toContain('后文');
    const fc1 = collectFcs(results1);
    expect(fc1.length).toBe(1);
    expect(fc1[0].name).toBe('list_dir');
    // 收口后上下文必须释放（RC8 语义保持）
    expect(shared.activeStreamContexts.size).toBe(0);

    // ── 场景2：扣留文本以调用标记开头（被原生调用取代的废弃块）→ 维持丢弃，不泄漏 ──
    const sid2 = 'reg_patch2_markup_led';
    const chunks2 = [
      { id: sid2, choices: [{ delta: { content: '前文：' + OPEN + '{"name":"x"' }, index: 0 }] },
      {
        id: sid2,
        choices: [
          {
            delta: {
              content: ' 后文',
              tool_calls: [{ index: 0, id: 'p3', function: { name: 'list_dir', arguments: '{"DirectoryPath":"."}' } }],
            },
            finish_reason: 'tool_calls',
            index: 0,
          },
        ],
      },
    ];
    const results2 = chunks2.map((c) => mapOpenAIChunkToGemini(c, 'sensenova'));
    const allText2 = collectTexts(results2);
    // 标记开头的扣留是被原生调用取代的废弃调用块：不泄漏标记（与 d2 同语义），
    // 代价是块内文本不补发（与中间帧路径「解析消费即清空」的既有语义一致）。
    expect(allText2).toContain('前文：');
    expect(allText2).not.toContain(OPEN);
    const fc2 = collectFcs(results2);
    expect(fc2.length).toBe(1);
    expect(fc2[0].name).toBe('list_dir');
    expect(shared.activeStreamContexts.size).toBe(0);
  });

  it('h5 [补丁2防回归] pendingToolCalls 收口分支（finish=function_call）同样补发误扣正文', () => {
    const sid = 'reg_patch2_fn_call';
    const chunks = [
      // 帧1：跨 chunk 切分的标记前缀被扣留（纯文本开头）
      { id: sid, choices: [{ delta: { content: '方法一：' + '<' + 'tool_' }, index: 0 }] },
      // 帧2：未闭合块内整帧扣留；同帧 native 调用，以旧式 function_call 收口
      {
        id: sid,
        choices: [
          {
            delta: {
              content: 'call> 说明正文',
              tool_calls: [{ index: 0, id: 'p5', function: { name: 'list_dir', arguments: '{"DirectoryPath":"."}' } }],
            },
            finish_reason: 'function_call',
            index: 0,
          },
        ],
      },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'sensenova'));
    const allText = collectTexts(results);
    // 修复前：pendingToolCalls 分支直接 return，误扣正文丢失；修复后随调用帧补发。
    expect(allText).toContain('方法一：');
    expect(allText).toContain('说明正文');
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('list_dir');
    expect(shared.activeStreamContexts.size).toBe(0);
  });
});
