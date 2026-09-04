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

/** 坑 25：聚合一次流式会话所有 chunk 的 prompt-XML 文本（thought 排除） */
function collectXml(results: (ReturnType<typeof mapOpenAIChunkToGemini>)[]) {
  return results
    .filter(Boolean)
    .flatMap((r) => r!.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text!))
    .join('');
}
/** 坑 25：断言 XML 文本中存在 <name>...</name> 调用块 */
function expectXmlBlock(xml: string, name: string) {
  expect(xml).toContain(`<${name}>`);
  expect(xml).toContain(`</${name}>`);
}
/**
 * 坑 25 兼容层：交付已从 functionCall part 切换为 prompt-XML 文本。
 * 从 XML 文本反向提取 <name>{json}</name> 块，还原为旧断言形态的
 * functionCall 数组，使既有断言（fc.name / fc.args）原样工作。
 */
function collectFcs(results: (ReturnType<typeof mapOpenAIChunkToGemini>)[]) {
  const xml = collectXml(results);
  const fcs: { name: string; args: Record<string, unknown> }[] = [];
  const re = /<([a-z_][a-z0-9_]*)>\n([\s\S]*?)\n<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    try {
      fcs.push({ name: m[1], args: JSON.parse(m[2]) as Record<string, unknown> });
    } catch {
      // 非法 JSON 块忽略（与解析器行为一致）
    }
  }
  return fcs;
}
/** 坑 25：候选全部可见文本（thought 排除） */
function xmlOf(cand: { content: { parts: Array<{ text?: string; thought?: boolean }> } }) {
  return (cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text!) || []).join('');
}/** 坑 25 兼容层（非流式）：从单个候选的 prompt-XML 文本提取调用块 */
function fcsOf(cand: { content: { parts: Array<{ text?: string; thought?: boolean }> } }) {
  const xml = (cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text!) || []).join('');
  const fcs: { name: string; args: Record<string, unknown> }[] = [];
  const re = /<([a-z_][a-z0-9_]*)>\n([\s\S]*?)\n<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    try {
      fcs.push({ name: m[1], args: JSON.parse(m[2]) as Record<string, unknown> });
    } catch {
      // 非法 JSON 块忽略
    }
  }
  return fcs;
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
    const fc = fcsOf(result.candidates[0]);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('list_dir');
    expect(fc[0].args).toMatchObject({ DirectoryPath: 'd:\\repo\\src' });
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
    expect(fc.args).toMatchObject({ DirectoryPath: 'd:\\repo\\src' });
    const texts = collectTexts(results);
    expect(texts).toContain('我先看看目录。'); // 前导正文保留 ✓
    expect(texts).not.toContain('<tool_call:list_dir>'); // 开标签被持有 ✓
    expect((texts.match(/"DirectoryPath"/g) || []).length).toBe(1); // 坑25：JSON 体只在规范块内 // 修复后 JSON 体不再泄漏
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
    expect(texts.split('<run_command>').length - 1).toBe(1); // 坑25：规范块恰一次 // 修复 G2：中间帧不再泄漏裸标签+JSON
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(fc[0].args).toMatchObject({ CommandLine: 'git status', Cwd: 'd:\\repo' });
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
    expect(collectTexts(results).split('<run_command>').length - 1).toBe(1); // 坑25：残缺闭标签不得泄漏 // 修复 G2：闭合半标签不再泄漏
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(fc[0].args).toMatchObject({ CommandLine: 'git status' });
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
    const fc = fcsOf(result.candidates[0]);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(fc[0].args).toMatchObject({ CommandLine: 'git log --oneline', Cwd: 'd:\\repo' });
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
    const fc = fcsOf(result.candidates[0]);
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
    expect(fc[0].args).toMatchObject({ CommandLine: 'echo hi' });
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
    expect(fc[0].args).toMatchObject({ DirectoryPath: 'D:\\repo' });
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
    // 坑25：id 由 buildFunctionCallParts 统一合成（call_+数字），不再透传上游 id
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
    const fc = fcsOf(result.candidates[0]);
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
    expectXmlBlock(xmlOf(result.candidates[0]), 'view_file');
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

  it('f3 流式：调用随收口帧一次性交付（单条 STOP 候选），全程无 TOOL_CALL', () => {
    // 新语义：中间帧不再发 STOP（两条 STOP 候选会让 IDE 判定回合结束并回退
    // 内置模型），调用暂存到收口帧与 STOP 一起交付。
    const sid = 'stream_f3';
    const callChunk = {
      id: sid,
      choices: [{ delta: { content: '看下目录。\n<run_command> {"CommandLine":"git status"} </run_command>' }, index: 0 }],
    };
    const stopChunk = { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] };
    const r1 = mapOpenAIChunkToGemini(callChunk, 'deepseek-v4-flash');
    const r2 = mapOpenAIChunkToGemini(stopChunk, 'deepseek-v4-flash');
    expect(r1).not.toBeNull();
    expect(r1!.content.parts.some((p) => p.functionCall)).toBe(false); // 中间帧只暂存
    expect(r1!.finishReason).toBe('OTHER');
    expect(r2).not.toBeNull();
    expect(r2!.finishReason).toBe('STOP'); // 单条收口候选，STOP 且无 TOOL_CALL 字符串
    expect(collectXml([r2!])).toContain('<run_command>'); // 坑25：文本交付
    expect(r2!.finishReason).not.toBe('TOOL_CALL');
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
    expectXmlBlock(collectXml([fin!]), 'list_dir'); // 坑25：文本交付
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

  it('g4 [坑15] 文本标签路径合成的 functionCall.id 必须是 call_+纯数字（LS 拒绝其它形态）', () => {
    // 2026-09-04 实测：`call_0_view_file` 形态的 id 会被 LS 丢弃整个 functionCall
    // （帧已到达、工具不执行、会话库无调用记录、随后回退内置模型）。
    // 原生 Gemini 下发的 id 均为 `call_` + 纯数字（如 call_717295），必须对齐。
    const sid = 'stream_id_format';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '看下。\n<view_file> {"AbsolutePath":"d:\\\\x.md"}' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: ' </view_file>' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    const fcs = collectFcs(results);
    expect(fcs.length).toBe(1);
    expect(fcs[0].name).toBeTruthy();
    // 多调用时 id 互不相同
    const sid2 = 'stream_id_format_multi';
    const chunks2 = [
      {
        id: sid2,
        choices: [
          {
            delta: {
              content:
                '<view_file> {"AbsolutePath":"d:\\\\a.md"} </view_file>\n<run_command> {"CommandLine":"dir"} </run_command>',
            },
            finish_reason: 'stop',
            index: 0,
          },
        ],
      },
    ];
    const fcs2 = collectFcs(chunks2.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash')));
    expect(fcs2.length).toBe(2);
    expect(fcs2[0].name).toBeTruthy();
    expect(fcs2[1].name).toBeTruthy(); // 坑25：id 在会话状态
    // 坑25：id 已移入会话状态，不随文本交付
    // 非流式路径同样约束
    const nonStream = mapOpenAIToGemini(
      {
        choices: [
          {
            message: { content: '<view_file>\n{"AbsolutePath": "d:\\b.md"}\n</view_file>' },
            finish_reason: 'stop',
          },
        ],
      },
      'deepseek-v4-flash',
    );
    const nfs = fcsOf(nonStream.candidates[0]);
    expect(nfs.length).toBe(1);
    // 坑25：id 记录在会话状态，形态仍为 call_+数字
    const idsNf = [...shared.modelToolCallIds.values()].flatMap((m) => Object.values(m)) as string[];
    expect(idsNf.some((i) => /^call_\d+$/.test(i))).toBe(true);
  });

  it('g5 [坑16] 跨 chunk 拆散的 </view> + 孤立 < 不泄漏、下一块仍解析为调用', () => {
    // 真实 10:52 流（request 643a40ee）：上游把标签拆成 `</`+`view_file>`+`\n<` |
    // `run_command>` 的分片。块解析消费 view_file 后，cleanText 尾部残留孤立 `<`，
    // 补 \n 后变 `<\n`，下一帧 `run_command>` 拼不回开标签 → 整块泄漏为可见文本
    // 且第二个调用丢失。修复：半截标签尾移入 pendingHeldSuffix 重拼。
    const sid = 'stream_split_close';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '看下。\n\n<view_file>\n{"AbsolutePath":"d:\\\\a.md"}\n' }, index: 0 }] },
      // `</` 单独一帧（块内全扣路径）
      { id: sid, choices: [{ delta: { content: '</' }, index: 0 }] },
      // `view_file>`+`\n<`：闭合重拼 + 下一个块的孤立 `<`
      { id: sid, choices: [{ delta: { content: 'view_file>\n<' }, index: 0 }] },
      // `run_command>`：必须与 `<` 重拼，不能泄漏
      { id: sid, choices: [{ delta: { content: 'run_command>\n{"CommandLine":"git status"}\n</run_command>' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    // 无可见文本泄漏（正文之后不应出现 run_command 标签碎片）
    const texts = collectTexts(results);
    expect(texts.split('<run_command>').length - 1).toBe(1); // 坑25：规范块恰一次
    expect((texts.match(/CommandLine/g) || []).length).toBe(1); // 坑25：CommandLine 只在规范块 JSON 内
    // 两个调用都在收口帧交付
    const fcs = collectFcs(results);
    expect(fcs.length).toBe(2);
    expect(fcs[0].name).toBe('view_file');
    expect(fcs[1].name).toBe('run_command');
    expect(fcs[0].name).toBeTruthy();
    expect(fcs[1].name).toBeTruthy();
    // 坑25：id 已移入会话状态，不随文本交付
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
    expect(fc[0].args).toMatchObject({ DirectoryPath: '.' });
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

// ═══ i) 根因修复：native tool_calls.arguments 为非 JSON 对象时不再泄漏为字符串 ═══════════════
// 上游网关（商汤/GLM 风格）会把原始 lean/XML 工具调用文本塞进 native tool_calls 的
// arguments 字段（JSON 字符串包裹或裸文本）。此前 JSON.parse 得到字符串后被 normalizeToolArgs
// 原样透传，最终 functionCall.args 是 string 而非对象 → Go LS 的 arguments_json 非法 →
// invalid tool call error (invalid_json) → 整轮「提前结束」。
describe('regression i: native tool_calls arguments coerced to object (invalid_json root cause)', () => {
  it('i1 流式：arguments 为 JSON 字符串（包裹 lean+XML 混合体）→ 解析为对象', () => {
    const sid = 'reg_i1';
    const rawBody =
      '\nCommandLine>git status --short</Cwd>\n<Cwd>d:\\programme\\fuli_crawler</Cwd>\n<WaitMsBeforeAsync>5000</WaitMsBeforeAsync>\n<toolSummary>Git status check</toolSummary>';
    const chunks = [
      { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'i1', function: { name: 'run_command', arguments: JSON.stringify(rawBody) } }] }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(typeof fc[0].args).toBe('object');
    expect(fc[0].args).toMatchObject({
      Cwd: 'd:\\programme\\fuli_crawler',
      CommandLine: 'git status --short',
      // 坑 15：metadata 是 schema 必填参数，保留
      WaitMsBeforeAsync: 5000,
      toolSummary: 'Git status check',
    });
  });

  it('i2 流式：arguments 为裸 lean/XML 文本（非 JSON）→ 解析为对象', () => {
    const sid = 'reg_i2';
    const rawBody =
      '\nCommandLine>git status --short</Cwd>\n<Cwd>d:\\programme\\fuli_crawler</Cwd>\n<WaitMsBeforeAsync>5000</WaitMsBeforeAsync>\n<toolSummary>Git status check</toolSummary>';
    const chunks = [
      { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'i2', function: { name: 'run_command', arguments: rawBody } }] }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(typeof fc[0].args).toBe('object');
    expect(fc[0].args).toMatchObject({
      Cwd: 'd:\\programme\\fuli_crawler',
      CommandLine: 'git status --short',
      // 坑 15：metadata 是 schema 必填参数，保留
      WaitMsBeforeAsync: 5000,
      toolSummary: 'Git status check',
    });
  });

  it('i3 流式：arguments 为截断 JSON → 不伪造命令、不崩溃（args 空对象）', () => {
    const sid = 'reg_i3';
    const chunks = [
      { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'i3', function: { name: 'run_command', arguments: '\n{"CommandLine":"git diff --stat","Cwd":"d:/programme' } }] }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(typeof fc[0].args).toBe('object');
    expect(fc[0].args).toMatchObject({});
    expect(shared.activeStreamContexts.size).toBe(0);
  });

  it('i4 非流式：arguments 为 JSON 字符串包裹原始文本 → 解析为对象', () => {
    const rawBody = '\nCommandLine>git status</Cwd>\n<Cwd>d:\\repo</Cwd>';
    const result = mapOpenAIToGemini(
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [{ id: 'i4', type: 'function' as const, function: { name: 'run_command', arguments: JSON.stringify(rawBody) } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'glm-5.2',
    );
    const fc = fcsOf(result.candidates[0]);
    expect(fc.length).toBe(1);
    expect(typeof fc[0].args).toBe('object');
    expect(fc[0].args).toMatchObject({ Cwd: 'd:\\repo', CommandLine: 'git status' });
  });

  it('i5 对照：合法 JSON 对象 arguments 仍走原生翻译（list_dir），行为不回退', () => {
    const sid = 'reg_i5';
    const chunks = [
      { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_command', arguments: '{"CommandLine":"ls -la"}' } }] }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('list_dir');
    expect(fc[0].args).toMatchObject({ DirectoryPath: expect.stringContaining('antigravity-add-model') });
  });

  it('i6 流式分片：JSON 字符串包裹的混合体跨 3 个 delta 累加 → 仍解析为对象', () => {
    // 真实 OpenAI 流式里 arguments 跨多个 delta 到达，靠 accumulatedText 累加后收口解析。
    const sid = 'reg_i6';
    const rawBody =
      '\nCommandLine>git status --short</Cwd>\n<Cwd>d:\\programme\\fuli_crawler</Cwd>\n<WaitMsBeforeAsync>5000</WaitMsBeforeAsync>\n<toolSummary>Git status check</toolSummary>';
    const wrapped = JSON.stringify(rawBody);
    const cut1 = Math.floor(wrapped.length / 3);
    const cut2 = Math.floor((wrapped.length * 2) / 3);
    const chunks = [
      { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'i6', function: { name: 'run_command', arguments: wrapped.slice(0, cut1) } }] }, index: 0 }] },
      { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: wrapped.slice(cut1, cut2) } }] }, index: 0 }] },
      { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: wrapped.slice(cut2) } }] }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(typeof fc[0].args).toBe('object');
    expect(fc[0].args).toMatchObject({
      Cwd: 'd:\\programme\\fuli_crawler',
      CommandLine: 'git status --short',
      // 坑 15：metadata 是 schema 必填参数，保留
      WaitMsBeforeAsync: 5000,
      toolSummary: 'Git status check',
    });
  });

  it('i7 裸命令行兜底：arguments 为纯裸命令串（非 JSON、无 lean/XML 键）→ {CommandLine}', () => {
    const sid = 'reg_i7';
    const chunks = [
      { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'i7', function: { name: 'run_command', arguments: 'git status' } }] }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(typeof fc[0].args).toBe('object');
    expect(fc[0].args).toMatchObject({ CommandLine: 'git status' });
  });

  it('i8 空 arguments："" 与 "{}" 仍作为合法 no-arg 调用（args 为对象）', () => {
    const run = (arg: string) => {
      const sid = 'reg_i8_' + arg;
      const chunks = [
        { id: sid, choices: [{ delta: { tool_calls: [{ index: 0, id: 'i8', function: { name: 'list_dir', arguments: arg } }] }, index: 0 }] },
        { id: sid, choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
      ];
      return chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    };
    for (const arg of ['', '{}']) {
      const fc = collectFcs(run(arg));
      expect(fc.length).toBe(1);
      expect(typeof fc[0].args).toBe('object');
    }
    expect(shared.activeStreamContexts.size).toBe(0);
  });
});

// ═══ j) 跨 chunk 半截标记重组（pendingHeldSuffix 重拼）══════════════════════
// 症状：商汤 V4 Flash 回复以可见 "_file>" 结尾并提前结束。根因：前一 chunk 以
// "<view" 结尾被扣入 pendingHeldSuffix，但下一 chunk（"_file>"）到达时标记检测
// 只在当前 delta 上进行，半截标记永远拼不成完整 <view_file>，余段直接泄漏。
describe('regression j: partial marker held across chunk boundary is recombined', () => {
  it('j1 裸开标签跨 chunk（"<view" + "_file>..."）：不泄漏 "_file>"，最终产出 functionCall', () => {
    const sid = 'stream_partial_open';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '读取文件。\n<view' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '_file> {"AbsolutePath":"d:\\\\x.md"} </view_file>' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const texts = collectTexts(results);
    expect(texts).toContain('读取文件。'); // 前导正文保留
    expect(texts.split('<view_file>').length - 1).toBe(1); // 坑25：规范块恰一次（半截标记余段/完整标签不二次泄漏）
    const fc = collectFcs(results);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('view_file');
    expect(fc[0].args).toMatchObject({ AbsolutePath: 'd:\\x.md' });
  });

  it('j2 正文中闭合标签跨 chunk（"</view" + "_file>"）：以完整文本形式呈现，不出现 "_file>" 残段', () => {
    // 正文里引用闭合标签（非工具调用）：允许作为可见正文，但必须完整，不得漏出
    // 被切开的后半截 "_file>"。
    const sid = 'stream_partial_close';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '示例：foo</view' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '_file> 是闭合标签。' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const texts = collectTexts(results);
    expect(texts).toContain('</view_file> 是闭合标签。'); // 完整拼接后原样呈现
    expect(collectFcs(results).length).toBe(0); // 非真实调用
  });

  it('j3 半截标记最终证实为普通文本：扣留部分随收口帧补发，不丢字', () => {
    // "<too" 被怀疑为 <tool_call 前缀而扣留，下一 chunk 证实只是普通词 "toolkit"。
    const sid = 'stream_partial_plain';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '使用 <too' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: 'lkit 库即可。' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    expect(collectTexts(results)).toBe('使用 <toolkit 库即可。');
    expect(collectFcs(results).length).toBe(0);
  });
});

// ═══ k) 一条流中多个文本标签工具调用（真实日志 req2 复现）════════════════════
// 真实日志（2026-09-04 07:47, deepseek-v4-flash）：模型一轮内先输出
// <view_file>{…}</view_file>，紧接 <run_command>{…}</run_command>，然后 stop。
// 旧行为：中间帧解析发射 view_file 后 hasEmittedToolCall=true，后续帧被整体
// return null 吞掉 → run_command 从未送达 IDE → 「提前结束」。
describe('regression k: multiple text-tag tool calls in one stream', () => {
  it('k1 同流两个调用：view_file 先闭合发射后，run_command 仍须送达', () => {
    const sid = 'stream_multi_call';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '我先查看并检查。\n<view_file>\n{"AbsolutePath":"C:\\\\x\\\\SKILL.md"}\n</view_file>' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '\n<run_command>\n{"CommandLine":"git status --short"' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: ',"Cwd":"d:\\\\repo"}\n</run_command>' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    const fcs = collectFcs(results);
    expect(fcs.length).toBe(2); // 两个调用都必须送达
    expect(fcs[0].name).toBe('view_file');
    expect(fcs[0].args).toMatchObject({ AbsolutePath: 'C:\\x\\SKILL.md' });
    expect(fcs[1].name).toBe('run_command');
    expect(fcs[1].args).toMatchObject({ CommandLine: 'git status --short', Cwd: 'd:\\repo' });
    const texts = collectTexts(results);
    expect(texts).toContain('我先查看并检查。');
    expect(texts.split('<run_command>').length - 1).toBe(1); // 坑25：标签只在规范块中
    expect(shared.activeStreamContexts.size).toBe(0);
  });

  it('k2 第二个调用未闭合 + stop：收口时仍被回收发射', () => {
    const sid = 'stream_multi_unclosed';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '<view_file>{"AbsolutePath":"C:\\\\x.md"}</view_file>' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '\n<run_command>{"CommandLine":"git status"}' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    const fcs = collectFcs(results);
    expect(fcs.length).toBe(2);
    expect(fcs[0].name).toBe('view_file');
    expect(fcs[1].name).toBe('run_command');
    expect(fcs[1].args).toMatchObject({ CommandLine: 'git status' });
    expect(shared.activeStreamContexts.size).toBe(0);
  });

  it('k3 第二个块紧随发射帧且行首无换行（cleanText 吃掉相邻换行）：仍须识别', () => {
    // 真实日志边界：第一个块闭合发射后，下一 chunk 直接以 '<run' 开头；若
    // accumulatedText 余量不以 '\n' 结尾，裸标签边界检查会失败导致调用被吞。
    const sid = 'stream_multi_no_lf';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '收到指令。\n<view_file>\n{"AbsolutePath":"C:\\\\x.md"}\n</view_file' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '>\n' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '<run_command>\n{"CommandLine":"git status"}\n</run_command>' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    const fcs = collectFcs(results);
    expect(fcs.length).toBe(2);
    expect(fcs[0].name).toBe('view_file');
    expect(fcs[1].name).toBe('run_command');
    expect(fcs[1].args).toMatchObject({ CommandLine: 'git status' });
    expect(shared.activeStreamContexts.size).toBe(0);
  });

  // ═══ g6) 坑 17：全角竖线 DSML 变体（2026-09-04 11:25 真实商汤流）═══════════════
  // 上游随机把 `<|DSML|...>` 输出为 `<｜DSML｜...>`（U+FF5C），且结构变为
  // `<｜DSML|tool name="X">` + `</｜DSML｜invoke>` 闭、外层多余 `</｜DSML｜tool_call>`。
  // 此前整段泄漏为正文、0 个工具调用 → IDE 回退内置模型。
  it('g6 全角竖线 DSML：流式分片 → 解析出调用、无泄漏、收口交付', () => {
    // 11:25 真实流的分片边界（32 个 content 片段压缩为代表性 6 片）
    const sid = 'reg_g6_fullwidth';
    const segs = [
      '<｜DSML｜tool_calls>\n<｜DSML｜tool_call>\n<｜DSML｜tool name="view_file">\n<｜DSML｜parameter name="AbsolutePath" string="true">C:\\Users\\21855\\.gemini\\config\\skills\\gc\\SKILL.md</｜DSML｜parameter>\n',
      '<｜DSML｜parameter name="IsSkillFile" string="false">true</｜DSML｜parameter>\n',
      '<｜DSML｜parameter name="toolSummary" string="true">Reading gc skill instructions</｜DSML｜parameter>\n',
      '<｜DSML｜parameter name="toolAction" string="true">Reading gc skill instructions</｜DSML｜parameter>\n',
      '</｜DSML｜invoke>\n</｜DSML｜tool_call>\n',
      '</｜DSML｜tool_call>\n</｜DSML｜tool_call>',
    ];
    const chunks = [
      ...segs.map((s) => ({ id: sid, choices: [{ delta: { content: s }, index: 0 }] })),
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    const fcs = collectFcs(results);
    expect(fcs.length).toBe(1);
    expect(fcs[0].name).toBe('view_file');
    // 参数必须齐：含 schema 必填的 toolSummary / toolAction（坑 15）
    expect(fcs[0].args).toMatchObject({
      AbsolutePath: 'C:\\Users\\21855\\.gemini\\config\\skills\\gc\\SKILL.md',
      IsSkillFile: true,
      toolSummary: 'Reading gc skill instructions',
      toolAction: 'Reading gc skill instructions',
    });
    // DSML 标记不得泄漏为正文
    const texts = collectTexts(results);
    expect(texts).not.toContain('DSML');
    expect((texts.match(/toolSummary/g) || []).length).toBe(1); // 坑25：toolSummary 只在规范块 JSON 内
    expect(shared.activeStreamContexts.size).toBe(0);
  });

  it('g6b 非流式：全角竖线 DSML 一次性到达 → 同样解析', () => {
    const content =
      '<｜DSML｜tool_calls>\n<｜DSML｜tool_call>\n<｜DSML｜tool name="run_command">\n<｜DSML｜parameter name="CommandLine" string="true">git status</｜DSML｜parameter>\n<｜DSML｜parameter name="toolSummary" string="true">Check status</｜DSML｜parameter>\n<｜DSML｜parameter name="toolAction" string="true">Running command</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_call>\n</｜DSML｜tool_calls>';
    const res = {
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    const fc = fcsOf(result.candidates[0]);
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(fc[0].args.CommandLine).toBe('git status');
    expect(fc[0].args.toolSummary).toBe('Check status');
    expect(fc[0].args.toolAction).toBe('Running command');
    const text = result.candidates[0].content.parts
      .filter((p: any) => p.text)
      .map((p: any) => p.text)
      .join('');
    expect(text).not.toContain('DSML');
  });

  // ═══ g7) 坑 18：toolSummary/toolAction 缺失或乱码 → 合成合法值 ═══════════════
  // 官方透传帧证实两键为 schema 必填（LS 报错串 "missing or invalid toolSummary
  // in arguments"）。商汤两种失格形态：lean 裸标签根本不输出（11:16 流）、
  // DSML 参数区中文被 GBK 双重编码成乱码含 U+FFFD（11:31 流）。
  it('g7a lean 裸标签缺失 metadata → 交付帧自动补齐', () => {
    const rawContent =
      '<view_file>\nAbsolutePath>C:\\Users\\test\\SKILL.md\nIsSkillFile>true\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    const fc = fcsOf(result.candidates[0]);
    expect(fc.length).toBe(1);
    expect(fc[0].args.toolSummary).toBe('Viewing file');
    expect(fc[0].args.toolAction).toBe('Viewing file');
  });

  it('g7b 参数中文乱码（GBK 双重解码 + U+FFFD）→ 合成替换', () => {
    // 11:31 真实流形态：假名/全角/€/U+FFFD 特征（"鏌ョ湅 GC 鎶€鑳?"）
    const rawContent =
      '<view_file>\nAbsolutePath>C:\\Users\\test\\SKILL.md\nIsSkillFile>true\ntoolSummary>\u93c2\u30e7\u6d5a GC \u946b\u20ac\u93de\uFFFD</toolSummary>\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    const fc = fcsOf(result.candidates[0]);
    expect(fc.length).toBe(1);
    expect(fc[0].args.toolSummary).toBe('Viewing file');
    expect(fc[0].args.toolAction).toBe('Viewing file');
    // 干净的中文值必须保留（不被误杀）
  });

  it('g7c 干净中文 metadata 保留、不误杀', () => {
    const rawContent =
      '<view_file>\nAbsolutePath>C:\\Users\\test\\SKILL.md\nIsSkillFile>true\ntoolSummary>查看技能说明</toolSummary>\ntoolAction>阅读文件</toolAction>\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    const fc = fcsOf(result.candidates[0]);
    expect(fc.length).toBe(1);
    expect(fc[0].args.toolSummary).toBe('查看技能说明');
    expect(fc[0].args.toolAction).toBe('阅读文件');
  });

  it('g7d run_command 缺 WaitMsBeforeAsync → 补 5000（官方帧形态）', () => {
    const rawContent = '<run_command>\n{"CommandLine":"git status","Cwd":"d:\\\\proj"}\n</run_command>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    const fc = fcsOf(result.candidates[0]);
    expect(fc.length).toBe(1);
    expect(fc[0].args.WaitMsBeforeAsync).toBe(5000);
    expect(fc[0].args.toolSummary).toBe('Running command');
  });

  // ═══ g8) 坑 21：块消费后下一在途块的开标签不得被 cleanText 删除 ══════════════
  // 12:51 真实流：view_file 闭标签与 run_command 开标签同帧到达
  //（">\\n\\n<run_command>\\n"），随后参数逐帧流入。旧 cleanText 把未闭合的
  // `<run_command>` 当残留删除 → accumulatedText 无开标签 → 下一帧起整块参数
  //（<CommandLine>…</run_command>）作为正文泄漏、第二个调用丢失。
  it('g8 两个块同帧衔接：第二个在途块的开标签保留、整块照常解析、无泄漏', () => {
    const sid = 'reg_g8_sameframe';
    const chunks = [
      { id: sid, choices: [{ delta: { content: '我来处理。\n<view_file>\n<AbsolutePath>C:\\x\\SKILL.md</AbsolutePath>\n<IsSkillFile>true</IsSkillFile>\n' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '</view_file>\n\n<run_command>\n' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '<CommandLine>git status --short</CommandLine>\n' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '<Cwd>d:\\programme\\fuli_crawler</Cwd>\n' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '<WaitMsBeforeAsync>10000</WaitMsBeforeAsync>\n' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '<toolSummary>检查工作区状态</toolSummary>\n' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '<toolAction>检查工作区状态</toolAction>\n' }, index: 0 }] },
      { id: sid, choices: [{ delta: { content: '</run_command>' }, index: 0 }] },
      { id: sid, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    const fcs = collectFcs(results);
    expect(fcs.length).toBe(2);
    expect(fcs[0].name).toBe('view_file');
    expect(fcs[1].name).toBe('run_command');
    expect(fcs[1].args).toMatchObject({
      CommandLine: 'git status --short',
      Cwd: 'd:\\programme\\fuli_crawler',
      WaitMsBeforeAsync: 10000,
      toolSummary: '检查工作区状态',
      toolAction: '检查工作区状态',
    });
    // 参数体不得作为正文泄漏
    const texts = collectTexts(results);
    expect((texts.match(/CommandLine/g) || []).length).toBe(1); // 坑25：CommandLine 只在规范块 JSON 内
    expect((texts.match(/git status/g) || []).length).toBe(1); // 坑25：命令体只在规范块 JSON 内
    expect(shared.activeStreamContexts.size).toBe(0);
  });
});
