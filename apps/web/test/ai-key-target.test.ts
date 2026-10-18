/** Settings → AI warns before a save that would drop the stored key (another provider or host). */
import { describe, expect, it } from 'vitest';
import { keyTarget } from '@/components/app/AiSettings';

const defaults = { 'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: '' }, anthropic: { baseUrl: 'https://api.anthropic.com', model: '' } };

describe('keyTarget', () => {
  it('is the provider plus the origin, with the default address for an empty one', () => {
    const saved = keyTarget('openai-compatible', '', defaults);
    expect(keyTarget('openai-compatible', 'https://api.openai.com/v2', defaults)).toBe(saved);
    expect(keyTarget('openai-compatible', 'https://API.openai.com:443/v1', defaults)).toBe(saved);
    expect(keyTarget('openai-compatible', 'https://evil.example/v1', defaults)).not.toBe(saved);
    expect(keyTarget('anthropic', '', defaults)).not.toBe(saved);
  });
});
