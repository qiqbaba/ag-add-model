/**
 * Unit tests for OpenAI translator (openai.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as shared from '../proxy/shared';
import { mapGeminiToOpenAI, mapOpenAIToGemini, mapOpenAIChunkToGemini } from '../proxy/translators/openai';

// Reset shared state before each test
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

/**
 * 坑 25：交付层已从 functionCall part 切换为 prompt-XML 文本 part。
 * 从候选的全部文本 part 中拼出 prompt-XML 串（thought part 排除）。
 */
function xmlOf(result: { content: { parts: Array<{ text?: string; thought?: boolean; functionCall?: unknown }> } } | null): string {
  if (!result) return '';
  return (result.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text!) || []).join('');
}
/** 旧断言辅助：等价于 fcParts.length（文本交付下检查 xml 是否含对应块） */
function expectXmlCall(xml: string, name: string): void {
  expect(xml).toContain(`<${name}>`);
  expect(xml).toContain(`</${name}>`);
}

// ─── mapGeminiToOpenAI ─────────────────────────────────────────────────────

describe('mapGeminiToOpenAI', () => {
  it('should convert systemInstruction to system message', () => {
    const body = {
      systemInstruction: { parts: [{ text: 'You are helpful.' }] },
      contents: [],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('should convert user messages correctly', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should convert model role to assistant', () => {
    const body = {
      contents: [{ role: 'model', parts: [{ text: 'Hi there!' }] }],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'assistant', content: 'Hi there!', reasoning_content: '' });
  });

  it('should handle functionCall parts as tool_calls', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'search', args: { query: 'test' }, id: 'call_123' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].function.name).toBe('search');
  });

  it('should preserve assistant text and reasoning_content alongside functionCall', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'Thinking about files...', thought: true },
            { text: 'Let me list the files.', thought: false },
            {
              functionCall: { name: 'list_dir', args: { DirectoryPath: '.' }, id: 'call_123' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBe('Let me list the files.');
    expect(result.messages[0].reasoning_content).toBe('Thinking about files...');
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].function.name).toBe('list_dir');
  });

  it('should handle functionResponse parts as tool messages when native tool_calls exist (坑25: 无原生 tool_calls 时转 user 文本)', () => {
    const body = {
      contents: [
        {
          parts: [
            {
              functionResponse: { name: 'search', response: 'result data' },
            },
          ],
        },
      ],
    };
    // 坑 25：无前置 model 轮 tool_calls（prompt-XML 模式）时，functionResponse
    // 转为 user 文本（LS prompt 约定工具结果由 user 回传）。
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('user');
    expect(String(result.messages[0].content)).toContain('search');
    expect(String(result.messages[0].content)).toContain('result data');
  });

  it('should include temperature and max_tokens from generationConfig', () => {
    const body = {
      contents: [],
      generationConfig: { temperature: 0.5, maxOutputTokens: 2000 },
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.temperature).toBe(0.5);
    expect(result.max_tokens).toBe(2000);
  });

  it('should use defaults when generationConfig is missing', () => {
    const body = { contents: [] };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.temperature).toBe(0.7);
    expect(result.max_tokens).toBe(4000);
  });

  it('should convert Gemini tools to OpenAI format', () => {
    const body = {
      contents: [],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } } },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].type).toBe('function');
    expect(result.tools![0].function.name).toBe('get_weather');
    expect((result.tools![0].function.parameters as Record<string, string>).type).toBe('object');
  });

  it('should include reasoning_content on assistant messages', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'answer', thought: false },
            { text: 'thinking...', thought: true },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'deepseek-model');
    const assistant = result.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('answer');
    expect(assistant.reasoning_content).toBe('thinking...');
  });

  it('should handle multiple contents', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Q1' }] },
        { role: 'model', parts: [{ text: 'A1' }] },
        { role: 'user', parts: [{ text: 'Q2' }] },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[2].role).toBe('user');
  });

  it('should convert image inlineData to image_url content part', () => {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Describe this image' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    const msg = result.messages[0];
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content).toEqual([
      { type: 'text', text: 'Describe this image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('should keep user content as string when no image present', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].content).toBe('Hello');
    expect(typeof result.messages[0].content).toBe('string');
  });
});

// ─── mapOpenAIToGemini ─────────────────────────────────────────────────────

describe('mapOpenAIToGemini', () => {
  it('should convert simple text response', () => {
    const res = {
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].content.parts[0]).toEqual({ text: 'Hello!' });
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('should convert tool_calls to functionCall parts', () => {
    const res = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function' as const,
                function: { name: 'search', arguments: '{"query":"test"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('STOP');
    // 坑 25：交付为 prompt-XML 文本（LS 对自定义模型只解析文本标记）
    const textParts = result.candidates[0].content.parts.filter((p) => p.text && !p.thought);
    const xml = textParts.map((p) => p.text).join('');
    expect(xml).toContain('<search>');
    expect(xml).toContain('"query":"test"');
    expect(xml).toContain('</search>');
  });

  it('should parse DSML tool calls from text content', () => {
    const res = {
      choices: [
        {
          message: {
            content:
              'Here is result\n<DSML|invoke name="search_web">\n<DSML|parameter name="query" string="true">news</DSML|parameter>\n</DSML|invoke>',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    expect(result.candidates[0].finishReason).toBe('STOP');
    // 坑 25：DSML 标记消费后以标准 prompt-XML 文本交付
    const xml = result.candidates[0].content.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    expect(xml).toContain('<search_web>');
    expect(xml).toContain('"query":"news"');
  });

  it('should register DSML tool calls for response round-trip', () => {
    const res = {
      choices: [
        {
          message: {
            content:
              '<DSML|invoke name="run_command">\n<DSML|parameter name="CommandLine" string="true">ls</DSML|parameter>\n<DSML|parameter name="Cwd" string="true">/repo</DSML|parameter>\n</DSML|invoke>',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    // 坑 25：文本交付下验证 prompt-XML 块与状态注册
    const xml = result.candidates[0].content.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    expect(xml).toContain('<list_dir>');
    // ls → list_dir 翻译后参数为 DirectoryPath（原 CommandLine 已翻译）
    expect(xml).toContain('"DirectoryPath"');
    expect(xml).toContain('</list_dir>');
    const id = shared.modelToolCallIds.get('deepseek-v4')?.['run_command'];
    expect(id).toBeDefined();
    expect(shared.translatedToolCalls.get(id!)?.originalName).toBe('run_command');
    expect(shared.translatedToolCalls.get(id!)?.translatedName).toBe('list_dir');
  });

  it('should scope tool-call state per sessionId (concurrent sessions are isolated)', () => {
    const resA = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_a',
                type: 'function' as const,
                function: { name: 'run_command', arguments: '{"CommandLine":"ls","Cwd":"/repo"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const resB = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_b',
                type: 'function' as const,
                function: { name: 'run_command', arguments: '{"CommandLine":"ls","Cwd":"/repo2"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    // Same model (deepseek-v4) used by TWO concurrent sessions.
    mapOpenAIToGemini(resA, 'deepseek-v4', 'conv-a');
    mapOpenAIToGemini(resB, 'deepseek-v4', 'conv-b');
    // Each session's tool_call_id is stored under its own composite key, so the
    // later request cannot overwrite the earlier session's mapping.
    expect(shared.modelToolCallIds.get('deepseek-v4|conv-a')?.['run_command']).toBe('call_a');
    expect(shared.modelToolCallIds.get('deepseek-v4|conv-b')?.['run_command']).toBe('call_b');
    // The unsplit model-name key no longer aggregates across sessions.
    expect(shared.modelToolCallIds.get('deepseek-v4')?.run_command).toBeUndefined();
  });

  it('should resolve functionResponse tool_call_id from in-request history when id is missing', () => {
    // Turn 1 response: model emits a translated tool call
    const response = mapOpenAIToGemini(
      {
        choices: [
          {
            message: {
              content:
                '<DSML|invoke name="run_command">\n<DSML|parameter name="CommandLine" string="true">ls</DSML|parameter>\n</DSML|invoke>',
            },
            finish_reason: 'stop',
          },
        ],
      },
      'deepseek-v4',
    );
    // 坑 25：交付是 prompt-XML 文本（无 functionCall part）；反向历史中的
    // model 轮以 assistant tool_calls 形态重建（保持 tool role 通道语义），
    // 此处手工构造 model 轮 functionCall（LS 真实历史里工具结果由 user 文本回传，
    // 但若 LS 发来 functionCall+functionResponse 结构，链路须仍成立）。
    const fc = { name: 'list_dir', args: { DirectoryPath: '/repo' }, id: 'call_xml_1' };
    // Turn 2 request: the client sends back a functionResponse WITHOUT an id, in the
    // same request as the assistant's functionCall (as Gemini history does).
    const request = mapGeminiToOpenAI(
      {
        contents: [
          { role: 'model', parts: [{ functionCall: { name: fc.name, args: fc.args, id: fc.id } }] },
          { role: 'user', parts: [{ functionResponse: { name: fc.name, response: 'ls output' } }] },
        ],
      },
      'deepseek-v4',
      'conv-a',
    );
    const toolMsg = request.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe(fc.id);
  });

  it('should correctly pair multiple parallel tool calls of the same name with their responses', () => {
    const request = mapGeminiToOpenAI(
      {
        contents: [
          {
            role: 'model',
            parts: [
              { functionCall: { name: 'list_dir', args: { DirectoryPath: '/folder1' } } },
              { functionCall: { name: 'list_dir', args: { DirectoryPath: '/folder2' } } },
              { functionCall: { name: 'list_dir', args: { DirectoryPath: '/folder3' } } },
            ],
          },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'list_dir', response: 'dir1 output' } },
              { functionResponse: { name: 'list_dir', response: 'dir2 output' } },
              { functionResponse: { name: 'list_dir', response: 'dir3 output' } },
            ],
          },
        ],
      },
      'deepseek-v4',
      'session-parallel',
    );

    const assistantMsg = request.messages.find((m) => m.role === 'assistant')!;
    expect(assistantMsg.tool_calls).toHaveLength(3);
    const id1 = assistantMsg.tool_calls![0].id;
    const id2 = assistantMsg.tool_calls![1].id;
    const id3 = assistantMsg.tool_calls![2].id;

    // All 3 IDs must be unique
    expect(new Set([id1, id2, id3]).size).toBe(3);

    const toolMsgs = request.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs[0].tool_call_id).toBe(id1);
    expect(toolMsgs[0].content).toContain('dir1 output');
    expect(toolMsgs[1].tool_call_id).toBe(id2);
    expect(toolMsgs[1].content).toContain('dir2 output');
    expect(toolMsgs[2].tool_call_id).toBe(id3);
    expect(toolMsgs[2].content).toContain('dir3 output');
  });

  it('should preserve reasoning_content alongside tool_calls', () => {
    const res = {
      choices: [
        {
          message: {
            reasoning_content: 'thinking...',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'run_command', arguments: '{"CommandLine":"ls","Cwd":"/repo"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    const parts = result.candidates[0].content.parts;
    expect(parts.some((p) => p.thought && p.text === 'thinking...')).toBe(true);
    // 坑 25：native tool_calls 交付为 prompt-XML 文本
    expect(parts.some((p) => p.text && !p.thought && p.text.includes('<list_dir>'))).toBe(true);
  });

  it('should include reasoning_content as thought part', () => {
    const res = {
      choices: [
        {
          message: { content: 'answer', reasoning_content: 'thinking...' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    const parts = result.candidates[0].content.parts;
    expect(parts.some((p) => p.thought)).toBe(true);
    expect(parts.some((p) => p.text === 'thinking...')).toBe(true);
    expect(parts.some((p) => p.text === 'answer')).toBe(true);
  });

  it('should handle empty choices gracefully', () => {
    const res = { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    expect(() => mapOpenAIToGemini(res, 'gpt-4o')).not.toThrow();
  });

  it('should handle missing usage', () => {
    const res = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.usageMetadata).toBeDefined();
    expect(result.usageMetadata!.totalTokenCount).toBe(0);
  });

  it('should map finish_reason length to MAX_TOKENS', () => {
    const res = {
      choices: [{ message: { content: 'truncated...' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('MAX_TOKENS');
  });

  it('should map finish_reason content_filter to SAFETY', () => {
    const res = {
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('SAFETY');
  });
});

// ─── mapOpenAIChunkToGemini (Streaming) ────────────────────────────────────

describe('mapOpenAIChunkToGemini', () => {
  it('should return text delta chunk', () => {
    const chunk = {
      id: 'stream_1',
      choices: [{ delta: { content: 'Hello' }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'gpt-4o');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'Hello' });
  });

  it('should return reasoning delta as thought part', () => {
    const chunk = {
      id: 'stream_1',
      choices: [{ delta: { reasoning_content: 'thinking...' }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'deepseek-v4');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'thinking...', thought: true });
  });

  it('should keep content when reasoning and content arrive in the same chunk', () => {
    const chunk = {
      id: 'stream_mixed',
      choices: [{ delta: { reasoning_content: 'thinking...', content: 'answer' }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'deepseek-v4');
    expect(result).not.toBeNull();
    const parts = result!.content.parts;
    expect(parts.some((p) => p.thought && p.text === 'thinking...')).toBe(true);
    expect(parts.some((p) => p.text === 'answer')).toBe(true);
  });

  it('should accumulate and emit tool calls on finish_reason tool_calls', () => {
    // Accumulate tool call fragments
    mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q"' } }] },
            index: 0,
          },
        ],
      },
      'gpt-4o',
    );
    mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"test"}' } }] }, index: 0 }],
      },
      'gpt-4o',
    );

    // Final chunk with tool_calls finish
    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('STOP');
  });

  it('should handle stop finish with pending tool calls', () => {
    mapOpenAIChunkToGemini(
      {
        id: 'stream_stop_tc',
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"/f"}' } }] },
            index: 0,
          },
        ],
      },
      'gpt-4o',
    );

    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_stop_tc',
        choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    // If tool calls were pending, they should be emitted
  });

  it('should handle stop finish with no pending state', () => {
    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_clean',
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('STOP');
  });

  it('should return null for empty choice', () => {
    const chunk = { id: 'empty', choices: [] };
    const result = mapOpenAIChunkToGemini(chunk, 'gpt-4o');
    expect(result).toBeNull();
  });

  it('should detect DSML tool calls in accumulated streaming text', () => {
    const dsmlText =
      'Result:\n<DSML|invoke name="run_command">\n<DSML|parameter name="CommandLine" string="true">ls</DSML|parameter>\n</DSML|invoke>';
    const chunk = {
      id: 'stream_dsml',
      choices: [{ delta: { content: dsmlText }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'deepseek-v4');
    expect(result).not.toBeNull();
    // 新语义：中间帧只暂存调用（正文安全发射、标签不泄漏），收口帧一次性交付
    expect(result!.content.parts.filter((p) => p.text && p.text.includes('<list_dir>')).length).toBe(0);
    const stop = mapOpenAIChunkToGemini({ id: 'stream_dsml', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }, 'deepseek-v4');
    expect(stop).not.toBeNull();
    // 坑 25：收口帧交付 prompt-XML 文本
    const xml = stop!.content.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    expect(xml).toContain('<list_dir>');
  });
});

// ─── SenseNova / DeepSeek-V4 DSML `tool_calls`/`tool_call` wrapper format ──

describe('mapOpenAIToGemini DSML tool_call wrapper', () => {
  const wrapperBlock = [
    '<DSML|tool_calls>',
    '<DSML|tool_call name="run_command">',
    '<DSML|parameter name="CommandLine" string="true">dir</DSML|parameter>',
    '<DSML|parameter name="Cwd" string="true">D:\\repo</DSML|parameter>',
    '</DSML|tool_call>',
    '</DSML|tool_calls>',
  ].join('\n');

  it('should parse tool_call wrapped inside tool_calls into a functionCall', () => {
    const res = {
      choices: [
        {
          message: { content: wrapperBlock },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    expect(result.candidates[0].finishReason).toBe('STOP');
    // 坑 25：prompt-XML 文本交付
    const xml = result.candidates[0].content.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    expect(xml).toContain('<list_dir>');
    expect(xml).toContain('"DirectoryPath":"D:\\\\repo"');
    // raw markup must not leak into text parts
    expect(xml).not.toContain('DSML');
  });

  it('should register tool_call-wrapper calls for response round-trip', () => {
    const res = {
      choices: [{ message: { content: wrapperBlock }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    const id = shared.modelToolCallIds.get('deepseek-v4')?.['run_command'];
    expect(id).toBeDefined();
    expect(shared.translatedToolCalls.get(id!)?.originalName).toBe('run_command');
    expect(shared.translatedToolCalls.get(id!)?.translatedName).toBe('list_dir');
    expect(shared.translatedToolCalls.get(id)?.cmd).toBe('dir');
  });

  it('should still extract a complete tool_call when the outer tool_calls wrapper is unclosed', () => {
    const truncated = [
      'Some intro.',
      '<DSML|tool_calls>',
      '<DSML|tool_call name="run_command">',
      '<DSML|parameter name="CommandLine" string="true">dir</DSML|parameter>',
      '</DSML|tool_call>',
    ].join('\n');
    const res = {
      choices: [{ message: { content: truncated }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    expect(result.candidates[0].finishReason).toBe('STOP');
    // 坑 25：prompt-XML 文本交付
    const xml = result.candidates[0].content.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    expect(xml).toContain('<list_dir>');
    // intro text survives, but no DSML markup leaks
    expect(xml).toContain('Some intro.');
    expect(xml).not.toContain('DSML');
  });

  it('should NOT extract a genuinely incomplete tool_call (no closing tag) and fall through to text', () => {
    const truncated = [
      'Some intro.',
      '<DSML|tool_calls>',
      '<DSML|tool_call name="run_command">',
      '<DSML|parameter name="CommandLine" string="true">dir</DSML|parameter>',
    ].join('\n');
    const res = {
      choices: [{ message: { content: truncated }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    expect(result.candidates[0].finishReason).toBe('STOP');
    const text = result.candidates[0].content.parts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join('');
    expect(text).toContain('Some intro.');
  });

  it('should hold partial DSML markup during streaming and emit the functionCall once the wrapper completes', () => {
    const streamId = 'stream_wrapper';
    const chunk1: { id: string; choices: { delta: { content: string }; index: number }[] } = {
      id: streamId,
      choices: [
        {
          delta: {
            content:
              'Lead in.\n<DSML|tool_calls>\n<DSML|tool_call name="run_command">\n<DSML|parameter name="CommandLine" string="true">dir</DSML|parameter>',
          },
          index: 0,
        },
      ],
    };
    const chunk2: { id: string; choices: { delta: { content: string }; index: number }[] } = {
      id: streamId,
      choices: [{ delta: { content: '\n</DSML|tool_call>\n</DSML|tool_calls>' }, index: 0 }],
    };

    const r1 = mapOpenAIChunkToGemini(chunk1, 'deepseek-v4');
    // Unclosed block: lead-in is shown, raw markup is held back (never leaks as text)
    const texts1 = (r1?.content.parts.filter((p) => p.text).map((p) => p.text!) || []).join('').trim();
    expect(texts1).toBe('Lead in.');
    expect(texts1).not.toContain('DSML');

    const r2 = mapOpenAIChunkToGemini(chunk2, 'deepseek-v4');
    // Completed block: call is stashed mid-stream (no markup leak), delivered
    // on the finish frame — one candidate, single STOP.
    const texts2 = (r2?.content.parts.filter((p) => p.text).map((p) => p.text!) || []).join('');
    expect(texts2).not.toContain('DSML');
    expect(r2?.content.parts.filter((p) => p.functionCall).length ?? 0).toBe(0);
    const r3 = mapOpenAIChunkToGemini({ id: streamId, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }, 'deepseek-v4');
    expect(r3).not.toBeNull();
    expect(r3!.finishReason).toBe('STOP');
    // 坑 25：收口帧交付 prompt-XML 文本
    const xml = r3!.content.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    expect(xml).toContain('<list_dir>');
  });

  it('should parse a bare DSML JSON-body tag such as <DSML|_command>{...}</DSML|_command>', () => {
    const content =
      '<DSML|_command>{"CommandLine":"git diff ARCHITECTURE.md","Cwd":"d:\\\\repo","WaitMsBeforeAsync":10000,"toolSummary":"Viewing ARCHITECTURE.md diff","toolAction":"Inspecting ARCHITECTURE.md changes"}</DSML|_command>';
    const res = {
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    expect(result.candidates[0].finishReason).toBe('STOP');
    // 坑 25：prompt-XML 文本交付（JSON 单行内嵌）
    const xml = result.candidates[0].content.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    expect(xml).toContain('<run_command>');
    expect(xml).toContain('"CommandLine":"git diff ARCHITECTURE.md"');
    expect(xml).toContain('"Cwd":"d:\\\\repo"');
    expect(xml).toContain('"WaitMsBeforeAsync":10000');
    expect(xml).toContain('"toolSummary":"Viewing ARCHITECTURE.md diff"');
    expect(xml).toContain('"toolAction":"Inspecting ARCHITECTURE.md changes"');
    expect(xml).toContain('</run_command>');
    // 坑 15：metadata 键是 IDE schema 必填参数，必须保留；原始标记不得泄漏进文本
    expect(xml).not.toContain('DSML');
  });
});

// ─── GLM-5.2 / SenseNova / Hermes / Qwen / XML Text Tool Call Support ─────────

describe('mapOpenAIToGemini GLM & Multi-Model Text Tool Calls', () => {
  it('should parse GLM-5.2 concatenated key-value format without leading brace or closing tag', () => {
    const rawContent =
      '我来检查项目的所有代码，首先了解项目结构。\n<tool_call>list_dirDirectoryPath":"d:\\programme\\fuli_crawler"toolAction":"Listing project directory"toolSummary":"Directory listing"}';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 25, total_tokens: 35 },
    };
    const result = mapOpenAIToGemini(res, 'glm-5.2');
    expect(result.candidates[0].finishReason).toBe('STOP');
    // 坑 25：prompt-XML 文本交付；lead-in 文本保留、原始标记不泄漏
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'list_dir');
    expect(xml).toContain('"DirectoryPath":"d:\\\\programme\\\\fuli_crawler"');
    expect(xml).toContain('"toolAction":"Listing project directory"');
    expect(xml).toContain('"toolSummary":"Directory listing"');
    expect(xml).toContain('我来检查项目的所有代码');
    expect(xml).not.toContain('<tool_call>');
  });

  it('should parse GLM / standard <tool_call>name\n{...}</tool_call>', () => {
    const rawContent =
      'Checking files:\n<tool_call>view_file\n{"AbsolutePath": "d:\\\\test\\\\app.ts"}\n</tool_call>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'glm-5.2');
    expect(result.candidates[0].finishReason).toBe('STOP');
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'view_file');
    expect(xml).toContain('"AbsolutePath":"d:\\\\test\\\\app.ts"');
  });

  it('should parse Hermes / Qwen format <tool_call>{"name": "...", "arguments": {...}}</tool_call>', () => {
    const rawContent =
      '<tool_call>\n{"name": "grep_search", "arguments": {"Query": "findMe", "SearchPath": "D:\\\\project"}}\n</tool_call>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'qwen-2.5');
    expect(result.candidates[0].finishReason).toBe('STOP');
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'grep_search');
    expect(xml).toContain('"Query":"findMe"');
    expect(xml).toContain('"SearchPath":"D:\\\\project"');
  });

  it('should parse Antigravity call tag format <call:default_api:list_dir{...}>', () => {
    const rawContent =
      '<call:default_api:list_dir{"DirectoryPath": "D:\\workspace"}>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'custom-model');
    expect(result.candidates[0].finishReason).toBe('STOP');
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'list_dir');
    expect(xml).toContain('"DirectoryPath":"D:\\\\workspace"');
  });

  it('should hold GLM-5.2 <tool_call> markup during streaming and emit STOP at finish', () => {
    const streamId = 'stream_glm_52';
    const chunk1 = {
      id: streamId,
      choices: [
        {
          delta: {
            content: '我来检查项目的所有代码。\n<tool_call>list_dirDirectoryPath":"d:\\programme\\fuli_crawler"',
          },
          index: 0,
        },
      ],
    };
    const chunk2 = {
      id: streamId,
      choices: [
        {
          delta: {
            content: 'toolAction":"Listing project directory"toolSummary":"Directory listing"}',
          },
          finish_reason: 'stop',
          index: 0,
        },
      ],
    };

    const r1 = mapOpenAIChunkToGemini(chunk1, 'glm-5.2');
    const text1 = (r1?.content.parts.filter((p) => p.text).map((p) => p.text!) || []).join('').trim();
    expect(text1).toBe('我来检查项目的所有代码。');
    expect(text1).not.toContain('<tool_call>');

    const r2 = mapOpenAIChunkToGemini(chunk2, 'glm-5.2');
    expect(r2).not.toBeNull();
    expect(r2!.finishReason).toBe('STOP');
    // 坑 25：收口帧交付 prompt-XML 文本
    const xml = xmlOf(r2!);
    expectXmlCall(xml, 'list_dir');
    expect(xml).toContain('"DirectoryPath":"d:\\\\programme\\\\fuli_crawler"');
    expect(xml).toContain('"toolAction":"Listing project directory"');
    expect(xml).toContain('"toolSummary":"Directory listing"');
  });
});

// ─── Antigravity Lean Bare-Tag Tool Calls (BAI / GLM-5.2 regression) ────────

describe('Antigravity lean bare-tag tool calls', () => {
  it('should parse bare <run_command>{...}</run_command> with JSON body (BAI leak)', () => {
    const rawContent =
      '让我先查看状态。\n<run_command> {"CommandLine":"git status","Cwd":"d:\\\\project"} </run_command>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    // 坑 25：prompt-XML 文本交付
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'run_command');
    expect(xml).toContain('"CommandLine":"git status"');
    expect(xml).toContain('"Cwd":"d:\\\\project"');
    // 原始标记不得二次泄漏：正文里不应再出现裸开标签残余（规范块恰一次）
    expect(xml.split('<run_command>').length - 1).toBe(1);
  });

  it('should parse bare <view_file> with Param>value lean args (BAI leak)', () => {
    const rawContent =
      '<view_file>\nAbsolutePath>C:\\Users\\test\\SKILL.md\nIsSkillFile>true toolSummary>Reading skill file\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    // 坑 25：prompt-XML 文本交付；lean 参数子标签规范化为 JSON
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'view_file');
    expect(xml).toContain('"AbsolutePath":"C:\\\\Users\\\\test\\\\SKILL.md"');
    expect(xml).toContain('"IsSkillFile":true');
    expect(xml).toContain('"toolSummary":"Reading skill file"');
  });

  it('should parse <tool_call> with lean args (GLM early-end) instead of dropping it', () => {
    const streamId = 'stream_glm_lean';
    const chunk1 = {
      id: streamId,
      choices: [
        {
          delta: {
            content: '我来执行 gc 指令，首先检查工作区的 Git 变动状态。\n<tool_call>run_command\nCommandLine>git status -s',
          },
          index: 0,
        },
      ],
    };
    const chunk2 = {
      id: streamId,
      choices: [{ delta: { content: '\nCwd>d:\\project\n</tool_call>' }, finish_reason: 'stop', index: 0 }],
    };

    const r1 = mapOpenAIChunkToGemini(chunk1, 'glm-5.2');
    const text1 = (r1?.content.parts.filter((p) => p.text).map((p) => p.text!) || []).join('');
    expect(text1.trim()).toBe('我来执行 gc 指令，首先检查工作区的 Git 变动状态。');
    expect(text1).not.toContain('<tool_call>');

    const r2 = mapOpenAIChunkToGemini(chunk2, 'glm-5.2');
    expect(r2).not.toBeNull();
    expect(r2!.finishReason).toBe('STOP');
    // 坑 25：收口帧交付 prompt-XML 文本
    const xml = xmlOf(r2!);
    expectXmlCall(xml, 'run_command');
    expect(xml).toContain('"CommandLine":"git status -s"');
    expect(xml).toContain('"Cwd":"d:\\\\project"');
  });

  it('should hold bare <run_command> markup during streaming and emit functionCall', () => {
    const streamId = 'stream_bai_bare';
    const chunks = [
      { id: streamId, choices: [{ delta: { content: '先检查状态。\n<run_comm' }, index: 0 }] },
      { id: streamId, choices: [{ delta: { content: 'and> {"CommandLine":"git ' }, index: 0 }] },
      { id: streamId, choices: [{ delta: { content: 'status"} </run_command>' }, index: 0 }] },
      { id: streamId, choices: [{ delta: { content: '' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'deepseek-v4-flash'));
    // The closed bare tag must still be parsed into a tool call at finish (the
    // bare-tag parser runs even when pre-today streaming emission doesn't hold the
    // tag itself). The important guarantee is the tool call is NOT dropped.
    // 坑 25：交付为 prompt-XML 文本
    const xml = results.filter(Boolean).map((r) => xmlOf(r!)).join('');
    expectXmlCall(xml, 'run_command');
    expect(xml).toContain('"CommandLine":"git status"');
  });

  it('should flush held markup as text instead of silently dropping it when parsing fails', () => {
    const streamId = 'stream_unparseable';
    const chunks = [
      { id: streamId, choices: [{ delta: { content: '前言。\n<tool_call>run_command\n???' }, index: 0 }] },
      { id: streamId, choices: [{ delta: { content: '' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const allText = results
      .filter(Boolean)
      .flatMap((r) => r!.content.parts.filter((p) => p.text).map((p) => p.text!))
      .join('');
    // Malformed markup (`???`) is not a valid tool call — it must not be turned
    // into a bogus tool call. The lead-in text must survive.
    const xml = results.filter(Boolean).map((r) => xmlOf(r!)).join('');
    expect(xml).not.toContain('<run_command>');
    expect(xml).toContain('前言。');
    // The malformed markup is not a valid tool call (no parseable args), so it is
    // not emitted as a bogus tool call. The withheld-text buffer flushes the
    // held, unparseable markup back as visible text rather than silently dropping
    // it — the guarantee is that no invalid tool call reaches the IDE (which would
    // abort the conversation), while the user's content is preserved.
    expect(xml).toContain('<tool_call>'); // 未解析的持有标记被冲刷回文本，不再静默丢弃
  });

  it('should NOT parse a bare tag mentioned inline in prose (false-positive guard)', () => {
    const rawContent = '你可以使用 <view_file> 工具来读取文件内容，或用 <run_command> 执行命令。';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    // 坑 25：prose 中的内联标签不得被误解析成调用块（文本保持原样）
    const xml = xmlOf(result.candidates[0]);
    expect(xml).not.toContain('<view_file>\n{');
    expect(xml).toContain('view_file');
  });

  it('should NOT parse a bare tag inside a code fence (quoted example)', () => {
    const rawContent = '示例：\n```\n<run_command>\nCommandLine>git status\n</run_command>\n```\n如上所示。';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    // 坑 25：代码围栏内的标签是引用示例，不得产生调用块
    expect(xmlOf(result.candidates[0])).not.toContain('<run_command>\n{');
  });

  it('should NOT parse a bare tag whose args do not match the declared schema', () => {
    // Prose quoting a tag with param names the IDE never declared → would abort
    // the turn with "invalid tool call" if emitted.
    const rawContent = '读取技能：\n<view_file>\nIsSkillFile>true toolSummary>Reading skill file\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    // mapGeminiToOpenAI registers the session schema (AbsolutePath only)…
    mapGeminiToOpenAI(
      {
        systemInstruction: { parts: [{ text: 'sys' }] },
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        tools: [
          {
            functionDeclarations: [
              { name: 'view_file', parameters: { type: 'object', properties: { AbsolutePath: { type: 'string' } } } },
              { name: 'run_command', parameters: { type: 'object', properties: { CommandLine: { type: 'string' } } } },
            ],
          },
        ],
      },
      'deepseek-v4-flash',
      'schema-session-1',
    );
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash', 'schema-session-1');
    // 坑 25：args 与声明 schema 不匹配 → 不得产生调用块
    expect(xmlOf(result.candidates[0])).not.toContain('<view_file>\n{');
  });

  it('should still parse a REAL bare lean call whose args match the declared schema', () => {
    const rawContent = '让我查看文件。\n<view_file>\nAbsolutePath>C:\\repo\\app.ts\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    mapGeminiToOpenAI(
      {
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        tools: [
          {
            functionDeclarations: [
              { name: 'view_file', parameters: { type: 'object', properties: { AbsolutePath: { type: 'string' } } } },
            ],
          },
        ],
      },
      'deepseek-v4-flash',
      'schema-session-2',
    );
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash', 'schema-session-2');
    // 坑 25：prompt-XML 文本交付
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'view_file');
    expect(xml).toContain('"AbsolutePath":"C:\\\\repo\\\\app.ts"');
  });
});

// ─── Asymmetric close tag & XML-inner args (SenseNova / GLM / BAI) ──────────
describe('asymmetric close tag and XML-inner bare-tag args', () => {
  it('should parse asymmetric <tool_call:list_dir>{json}</list_dir> (GLM leak)', () => {
    const rawContent =
      '让我检查一下项目中实际实现了哪些提供商/翻译器。 <tool_call:list_dir> {"DirectoryPath":"d:\\programme\\antigravity-add-model\\src\\translators","toolSummary":"Listing translators directory","toolAction":"Listing translators directory"} </list_dir>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'glm-5.2');
    // 坑 25：prompt-XML 文本交付
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'list_dir');
    expect(xml).toContain('"DirectoryPath":"d:\\\\programme\\\\antigravity-add-model\\\\src\\\\translators"');
    expect(xml).toContain('"toolSummary":"Listing translators directory"');
    expect(xml).toContain('"toolAction":"Listing translators directory"');
    // The raw markup must be stripped from visible text
    expect(xml).not.toContain('<tool_call:list_dir>');
    expect(xml).toContain('让我检查一下项目中实际实现了哪些提供商/翻译器。');
  });

  it('should NOT emit the asymmetric markup as visible text (streaming)', () => {
    const streamId = 'stream_glm_asym';
    const chunks = [
      { id: streamId, choices: [{ delta: { content: '让我检查一下项目中实际实现了哪些提供商/翻译器。\n<tool_call:list_dir> ' }, index: 0 }] },
      { id: streamId, choices: [{ delta: { content: '{"DirectoryPath":"d:\\programme\\antigravity-add-model\\src\\translators"}' }, index: 0 }] },
      { id: streamId, choices: [{ delta: { content: ' </list_dir>' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    // 坑 25：全部文本合并后校验
    const xml = results.filter(Boolean).map((r) => xmlOf(r!)).join('');
    expect(xml).not.toContain('<tool_call:list_dir>');
    expect(xml).toContain('让我检查一下项目中实际实现了哪些提供商/翻译器。');
    expectXmlCall(xml, 'list_dir');
    expect(xml).toContain('"DirectoryPath":"d:\\\\programme\\\\antigravity-add-model\\\\src\\\\translators"');
  });

  it('should parse bare <view_file> with <Param>value</Param> XML-inner args (BAI / SenseNova)', () => {
    const rawContent =
      'Let me first read the README.md to see what platform support claims need to be removed.\n<view_file>\n<AbsolutePath>d:\\programme\\antigravity-add-model\\README.md</AbsolutePath>\n<IsSkillFile>true</IsSkillFile>\n<toolSummary>Reading project README</toolSummary>\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'sensenova-6.8-flash-lite');
    // 坑 25：prompt-XML 文本交付
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'view_file');
    expect(xml).toContain('"AbsolutePath":"d:\\\\programme\\\\antigravity-add-model\\\\README.md"');
    expect(xml).toContain('"IsSkillFile":true');
    expect(xml).toContain('"toolSummary":"Reading project README"');
    expect(xml).not.toContain('<view_file>\n<AbsolutePath>');
    expect(xml).toContain('Let me first read the README.md');
  });

  it('should accept bare tool calls with extra metadata keys when declared schema has at least one param', () => {
    const rawContent = '让我查看文件。\n<view_file>\n<AbsolutePath>d:\\repo\\app.ts</AbsolutePath>\n<IsSkillFile>true</IsSkillFile>\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    // Register a session that declares ONLY AbsolutePath for view_file
    mapGeminiToOpenAI(
      {
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        tools: [
          {
            functionDeclarations: [
              { name: 'view_file', parameters: { type: 'object', properties: { AbsolutePath: { type: 'string' } } } },
            ],
          },
        ],
      },
      'sensenova-6.8-flash-lite',
      'schema-metadata-sess',
    );
    const result = mapOpenAIToGemini(res, 'sensenova-6.8-flash-lite', 'schema-metadata-sess');
    // 坑 25：prompt-XML 文本交付
    const xml = xmlOf(result.candidates[0]);
    expectXmlCall(xml, 'view_file');
    expect(xml).toContain('"AbsolutePath":"d:\\\\repo\\\\app.ts"');
  });
});


