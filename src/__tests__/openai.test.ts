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

  it('should handle functionResponse parts as tool messages', () => {
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
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].content).toBe('result data');
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
    expect(result.candidates[0].content.parts[0].functionCall).toBeDefined();
    expect(result.candidates[0].content.parts[0].functionCall!.name).toBe('search');
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
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBeGreaterThan(0);
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
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBe(1);
    expect(fcParts[0].functionCall!.name).toBe('list_dir');
    expect(fcParts[0].functionCall!.id).toBeDefined();
    const id = fcParts[0].functionCall!.id!;
    expect(shared.modelToolCallIds.get('deepseek-v4')?.['run_command']).toBe(id);
    expect(shared.translatedToolCalls.get(id)?.originalName).toBe('run_command');
    expect(shared.translatedToolCalls.get(id)?.translatedName).toBe('list_dir');
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
    const fc = response.candidates[0].content.parts.find((p) => p.functionCall)!.functionCall!;
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
    expect(parts.some((p) => p.functionCall)).toBe(true);
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
    const fcParts = result!.content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBeGreaterThan(0);
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
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBe(1);
    expect(fcParts[0].functionCall!.name).toBe('list_dir');
    expect(fcParts[0].functionCall!.args).toEqual({ DirectoryPath: 'D:\\repo' });
    // raw markup must not leak into text parts
    const text = result.candidates[0].content.parts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join('');
    expect(text).not.toContain('DSML');
  });

  it('should register tool_call-wrapper calls for response round-trip', () => {
    const res = {
      choices: [{ message: { content: wrapperBlock }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    const id = fcParts[0].functionCall!.id!;
    expect(shared.modelToolCallIds.get('deepseek-v4')?.['run_command']).toBe(id);
    expect(shared.translatedToolCalls.get(id)?.originalName).toBe('run_command');
    expect(shared.translatedToolCalls.get(id)?.translatedName).toBe('list_dir');
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
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBe(1);
    expect(fcParts[0].functionCall!.name).toBe('list_dir');
    // intro text survives, but no DSML markup leaks
    const text = result.candidates[0].content.parts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join('');
    expect(text).toContain('Some intro.');
    expect(text).not.toContain('DSML');
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
    // Completed block: a real functionCall is emitted, still no raw markup
    expect(r2).not.toBeNull();
    const fc = r2!.content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('list_dir');
    const texts2 = (r2!.content.parts.filter((p) => p.text).map((p) => p.text!) || []).join('');
    expect(texts2).not.toContain('DSML');
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('run_command');
    expect(fc[0].functionCall!.args).toEqual({
      CommandLine: 'git diff ARCHITECTURE.md',
      Cwd: 'd:\\repo',
    });
    // metadata keys are stripped; raw markup never leaks into text
    expect(fc[0].functionCall!.args).not.toHaveProperty('toolSummary');
    expect(fc[0].functionCall!.args).not.toHaveProperty('WaitMsBeforeAsync');
    const text = result.candidates[0].content.parts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join('');
    expect(text).not.toContain('DSML');
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('list_dir');
    expect(fc[0].functionCall!.args).toEqual({ DirectoryPath: 'd:\\programme\\fuli_crawler' });
    // lead-in text is preserved, raw tags stripped
    const text = result.candidates[0].content.parts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join('');
    expect(text).toContain('我来检查项目的所有代码');
    expect(text).not.toContain('<tool_call>');
    expect(text).not.toContain('toolAction');
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('view_file');
    expect(fc[0].functionCall!.args).toEqual({ AbsolutePath: 'd:\\test\\app.ts' });
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('grep_search');
    expect(fc[0].functionCall!.args).toEqual({ Query: 'findMe', SearchPath: 'D:\\project' });
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('list_dir');
    expect(fc[0].functionCall!.args).toEqual({ DirectoryPath: 'D:\\workspace' });
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
    const fc = r2!.content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('list_dir');
    expect(fc[0].functionCall!.args).toEqual({ DirectoryPath: 'd:\\programme\\fuli_crawler' });
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('run_command');
    expect(fc[0].functionCall!.args).toEqual({ CommandLine: 'git status', Cwd: 'd:\\project' });
    const text = result.candidates[0].content.parts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join('');
    expect(text).not.toContain('run_command>');
  });

  it('should parse bare <view_file> with Param>value lean args (BAI leak)', () => {
    const rawContent =
      '<view_file>\nAbsolutePath>C:\\Users\\test\\SKILL.md\nIsSkillFile>true toolSummary>Reading skill file\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('view_file');
    expect(fc[0].functionCall!.args).toEqual({ AbsolutePath: 'C:\\Users\\test\\SKILL.md', IsSkillFile: true });
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
    const fc = r2!.content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('run_command');
    expect(fc[0].functionCall!.args).toEqual({ CommandLine: 'git status -s', Cwd: 'd:\\project' });
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
    // The closed bare tag must still be parsed into a functionCall at finish (the
    // bare-tag parser runs even when pre-today streaming emission doesn't hold the
    // tag itself). The important guarantee is the tool call is NOT dropped.
    const fc = results
      .filter(Boolean)
      .flatMap((r) => r!.content.parts.filter((p) => p.functionCall).map((p) => p.functionCall!));
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('run_command');
    expect(fc[0].args).toEqual({ CommandLine: 'git status' });
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
    // into a bogus functionCall. The lead-in text must survive.
    const fc = results
      .filter(Boolean)
      .flatMap((r) => r!.content.parts.filter((p) => p.functionCall).map((p) => p.functionCall!));
    expect(fc.length).toBe(0);
    expect(allText).toContain('前言。');
    // The malformed markup is not a valid tool call (no parseable args), so it is
    // not emitted as a bogus functionCall. Newer emission logic (emittedLen
    // revival) flushes the held, unparseable markup back as visible text rather
    // than silently dropping it — the guarantee is that no invalid tool call
    // reaches the IDE (which would abort the conversation), while the user's
    // content is preserved.
    expect(allText).toContain('<tool_call>'); // 未解析的持有标记被冲刷回文本，不再静默丢弃
  });

  it('should NOT parse a bare tag mentioned inline in prose (false-positive guard)', () => {
    const rawContent = '你可以使用 <view_file> 工具来读取文件内容，或用 <run_command> 执行命令。';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(0);
    const text = result.candidates[0].content.parts.filter((p) => p.text).map((p) => p.text!).join('');
    expect(text).toContain('view_file');
  });

  it('should NOT parse a bare tag inside a code fence (quoted example)', () => {
    const rawContent = '示例：\n```\n<run_command>\nCommandLine>git status\n</run_command>\n```\n如上所示。';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4-flash');
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(0);
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(0);
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('view_file');
    expect(fc[0].functionCall!.args).toEqual({ AbsolutePath: 'C:\\repo\\app.ts' });
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('list_dir');
    expect(fc[0].functionCall!.args).toEqual({ DirectoryPath: 'd:\\programme\\antigravity-add-model\\src\\translators' });
    // The raw markup must be stripped from visible text
    const text = result.candidates[0].content.parts.filter((p) => p.text).map((p) => p.text!).join('');
    expect(text).not.toContain('<tool_call:list_dir>');
    expect(text).toContain('让我检查一下项目中实际实现了哪些提供商/翻译器。');
  });

  it('should NOT emit the asymmetric markup as visible text (streaming)', () => {
    const streamId = 'stream_glm_asym';
    const chunks = [
      { id: streamId, choices: [{ delta: { content: '让我检查一下项目中实际实现了哪些提供商/翻译器。\n<tool_call:list_dir> ' }, index: 0 }] },
      { id: streamId, choices: [{ delta: { content: '{"DirectoryPath":"d:\\programme\\antigravity-add-model\\src\\translators"}' }, index: 0 }] },
      { id: streamId, choices: [{ delta: { content: ' </list_dir>' }, finish_reason: 'stop', index: 0 }] },
    ];
    const results = chunks.map((c) => mapOpenAIChunkToGemini(c, 'glm-5.2'));
    const allText = results
      .filter(Boolean)
      .flatMap((r) => r!.content.parts.filter((p) => p.text).map((p) => p.text!))
      .join('');
    expect(allText).not.toContain('<tool_call:list_dir>');
    expect(allText).toContain('让我检查一下项目中实际实现了哪些提供商/翻译器。');
    const fc = results
      .filter(Boolean)
      .flatMap((r) => r!.content.parts.filter((p) => p.functionCall).map((p) => p.functionCall!));
    expect(fc.length).toBe(1);
    expect(fc[0].name).toBe('list_dir');
    expect(fc[0].args).toEqual({ DirectoryPath: 'd:\\programme\\antigravity-add-model\\src\\translators' });
  });

  it('should parse bare <view_file> with <Param>value</Param> XML-inner args (BAI / SenseNova)', () => {
    const rawContent =
      'Let me first read the README.md to see what platform support claims need to be removed.\n<view_file>\n<AbsolutePath>d:\\programme\\antigravity-add-model\\README.md</AbsolutePath>\n<IsSkillFile>true</IsSkillFile>\n<toolSummary>Reading project README</toolSummary>\n</view_file>';
    const res = {
      choices: [{ message: { content: rawContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    };
    const result = mapOpenAIToGemini(res, 'sensenova-6.8-flash-lite');
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('view_file');
    expect(fc[0].functionCall!.args.AbsolutePath).toBe('d:\\programme\\antigravity-add-model\\README.md');
    expect(fc[0].functionCall!.args.IsSkillFile).toBe(true);
    // toolSummary metadata must be stripped
    expect(fc[0].functionCall!.args.toolSummary).toBeUndefined();
    const text = result.candidates[0].content.parts.filter((p) => p.text).map((p) => p.text!).join('');
    expect(text).not.toContain('<view_file>');
    expect(text).toContain('Let me first read the README.md');
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
    const fc = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fc.length).toBe(1);
    expect(fc[0].functionCall!.name).toBe('view_file');
    expect(fc[0].functionCall!.args.AbsolutePath).toBe('d:\\repo\\app.ts');
  });
});


