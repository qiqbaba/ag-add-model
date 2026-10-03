import { describe, it, expect, afterEach } from 'vitest';
import {
  parseCatalogText,
  resolveContextWindow,
  registerOfficialContextWindows,
  DEFAULT_CONTEXT_WINDOW,
} from '../proxy/modelWindow';

/**
 * Mirrors the shape of the local agent catalog observed on disk
 * (`~/.dsh/settings.yaml`): providers -> models -> `- id:` entries that may or
 * may not carry a `contextWindow`.
 */
const CATALOG_SAMPLE = `
llm-pi-ai:
  providers:
    sensenova:
      displayName: 商汤
      models:
        - id: deepseek-v4-flash
          name: deepseek-v4-flash
          contextWindow: 1048576
        - id: glm-5.2
          name: glm-5.2
          contextWindow: 1048576
        - id: sensenova-6.8-flash-lite
          name: sensenova-6.8-flash-lite
          contextWindow: 262144
          input: [ text, image ]
      retryPolicy:
        mode: normal
        maxRetries: 10
    bai:
      models:
        - id: hy3
        - id: qwen3.8-flash
          input:
            - text
            - image
agent-default-model:
  provider: sensenova
  model: kimi-k3
`;

describe('modelWindow.parseCatalogText', () => {
  it('extracts id/name -> contextWindow pairs', () => {
    const map = parseCatalogText(CATALOG_SAMPLE);
    expect(map.get('deepseek-v4-flash')).toBe(1048576);
    expect(map.get('glm-5.2')).toBe(1048576);
    expect(map.get('sensenova-6.8-flash-lite')).toBe(262144);
  });

  it('does not invent a window for entries without one', () => {
    const map = parseCatalogText(CATALOG_SAMPLE);
    expect(map.has('hy3')).toBe(false);
    expect(map.has('qwen3.8-flash')).toBe(false);
  });

  it('does not confuse unrelated sibling keys with a window', () => {
    const map = parseCatalogText(CATALOG_SAMPLE);
    // `maxRetries: 10` lives under retryPolicy, not on a model entry -- if it
    // were picked up it would either add an entry or produce a bogus value.
    expect([...map.values()].every((v) => v >= 1000)).toBe(true);
    expect(map.size).toBe(3); // id === name for each entry, so the map dedupes
    expect(map.has('retrypolicy')).toBe(false);
  });

  it('survives malformed input without throwing', () => {
    expect(parseCatalogText('').size).toBe(0);
    expect(parseCatalogText('not yaml at all').size).toBe(0);
    expect(parseCatalogText('  - id: broken\n    contextWindow:').size).toBe(0);
  });

  it('accepts alternative window key spellings', () => {
    const map = parseCatalogText('- id: x\n  max_input_tokens: 30000\n');
    expect(map.get('x')).toBe(30000);
  });
});

describe('modelWindow.resolveContextWindow', () => {
  afterEach(() => {
    // Official captures are process-global; keep test isolation by using
    // distinct slugs per test rather than resetting shared state.
  });

  it('prefers the explicit configuration over every other source', () => {
    const result = resolveContextWindow({ explicit: 64000, externalModelName: 'glm-5.2' });
    expect(result).toEqual({ contextWindow: 64000, source: 'explicit' });
  });

  it('falls back to a heuristic family match', () => {
    const result = resolveContextWindow({ externalModelName: 'some-unknown-claude-4-model' });
    expect(result.source).toBe('heuristic');
    expect(result.contextWindow).toBe(200000);
  });

  it('falls back to the default window when nothing matches', () => {
    const result = resolveContextWindow({ externalModelName: 'zzz-9' });
    expect(result).toEqual({ contextWindow: DEFAULT_CONTEXT_WINDOW, source: 'default' });
  });

  it('resolves from the captured official model list, ignoring Custom entries', () => {
    registerOfficialContextWindows({
      'gemini-official-x': { maxTokens: 250000 },
      'extm-placeholder': { maxTokens: 1048576, tagTitle: 'Custom' },
    });
    expect(resolveContextWindow({ name: 'gemini-official-x' })).toEqual({
      contextWindow: 250000,
      source: 'official',
    });
    // The placeholder window of an injected custom entry must not be trusted.
    expect(resolveContextWindow({ name: 'extm-placeholder' }).source).not.toBe('official');
  });

  it('strips the models/ prefix when matching candidates', () => {
    registerOfficialContextWindows({ 'strip-prefix-model': { maxTokens: 32768 } });
    expect(resolveContextWindow({ name: 'models/strip-prefix-model' }).contextWindow).toBe(32768);
  });
});
