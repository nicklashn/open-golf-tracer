import { aiErrorJson, AiError, CHATGPT_USAGE_URL } from '@golf/compose';
import { describe, expect, it } from 'vitest';
import da from '../src/lib/i18n/da';
import en from '../src/lib/i18n/en';
import { aiErrorText } from '../src/lib/aiError';

const job = (e: AiError) => aiErrorJson(e);

describe('AI errors in the user’s language', () => {
  it('turns the exporter’s error codes into Danish, with the facts filled in', () => {
    expect(aiErrorText(job(new AiError('x', 'network', { reason: 'timeout', what: 'Anthropic', seconds: 120 })), da).text).toBe(
      'Anthropic svarede ikke inden for 120 s.',
    );
    expect(aiErrorText(job(new AiError('x', 'auth', { reason: 'key', what: 'api.openai.com', status: 401 })), da).text).toBe(
      'api.openai.com afviste API-nøglen (401).',
    );
    expect(aiErrorText(job(new AiError('x', 'config', { reason: 'noKey', what: 'Anthropic' })), da).text).toBe(
      'Anthropic kræver en API-nøgle (Indstillinger → AI).',
    );
    expect(aiErrorText(job(new AiError('x', 'http', { what: 'OpenRouter', status: 502, detail: 'upstream error' })), da).text).toBe(
      'OpenRouter svarede med en fejl (502). Besked fra udbyderen: upstream error',
    );
    expect(aiErrorText(job(new AiError('x', 'model', { reason: 'ollamaPull', what: 'Ollama', model: 'llama9' })), en).text).toBe(
      'Ollama does not have the model "llama9". Run: ollama pull llama9',
    );
  });

  it('knows the ChatGPT usage limit (for the link to ChatGPT’s settings)', () => {
    const r = aiErrorText(job(new AiError(`limit ${CHATGPT_USAGE_URL}`, 'limit', { what: 'ChatGPT' })), da);
    expect(r.limit).toBe(true);
    expect(r.text).toContain('ChatGPT-plan');
  });

  it('shows any other error as it is', () => {
    expect(aiErrorText('Workeren stoppede uventet.', da)).toEqual({ text: 'Workeren stoppede uventet.', limit: false });
    expect(aiErrorText('', da).text).toBe('');
  });
});
