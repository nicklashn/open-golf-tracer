'use client';

/**
 * Settings → AI: which model "Make a video for me" may use. The key is sent to the server once
 * and never comes back – the page only ever sees it masked.
 */
import { PlugZap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/controls';
import { Field, Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import type { JobInfo } from '@/lib/events';
import { useI18n } from '@/lib/i18n/client';

type Provider = 'server' | 'none' | 'ollama' | 'openai-compatible' | 'anthropic';

export interface AiSettingsInfo {
  provider: Provider;
  model: string;
  baseUrl: string;
  keyMasked: string;
  maxTokens: number;
  effective: { provider: Exclude<Provider, 'server'>; model: string; baseUrl: string; source: string; keyMasked: string; maxTokens: number; cloud: boolean };
  server: { provider: Exclude<Provider, 'server'>; model: string; keyMasked: string };
  defaults: Record<string, { baseUrl: string; model: string }>;
}

/** One line on what leaves the machine with the current choice. */
export function aiPrivacy(t: ReturnType<typeof useI18n>['t'], eff: AiSettingsInfo['effective'] | undefined): string {
  if (!eff || eff.provider === 'none') return t.ai.privacyNone;
  if (eff.provider === 'ollama') return t.ai.privacyLocal;
  const who =
    eff.provider === 'anthropic'
      ? 'Anthropic'
      : (() => {
          try {
            return new URL(eff.baseUrl).host;
          } catch {
            return eff.provider;
          }
        })();
  return t.ai.privacyCloud.replace('{provider}', who);
}

export function AiSettingsForm() {
  const { t, f } = useI18n();
  const [info, setInfo] = useState<AiSettingsInfo | null>(null);
  const [form, setForm] = useState({ provider: 'server' as Provider, model: '', baseUrl: '', apiKey: '', maxTokens: 8000 });
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void api<AiSettingsInfo>('/ai/settings').then((s) => {
      setInfo(s);
      setForm({ provider: s.provider, model: s.model, baseUrl: s.baseUrl, apiKey: '', maxTokens: s.maxTokens });
    });
  }, []);

  const own = form.provider !== 'server' && form.provider !== 'none';
  const defaults = own ? info?.defaults[form.provider] : undefined;

  async function save(apiKey?: string) {
    setBusy('save');
    try {
      const body = {
        provider: form.provider,
        model: form.model,
        baseUrl: form.baseUrl,
        maxTokens: form.maxTokens,
        ...(apiKey !== undefined ? { apiKey } : {}),
      };
      const s = await api<AiSettingsInfo>('/ai/settings', { method: 'PUT', body });
      setInfo(s);
      setForm((x) => ({ ...x, apiKey: '' }));
      setTest(null);
      toast.success(t.ai.saved);
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy('test');
    setTest(null);
    try {
      const job = await api<JobInfo>('/ai/test', { method: 'POST' });
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { jobs } = await api<{ jobs: JobInfo[] }>('/jobs');
        const j = jobs.find((x) => x.id === job.id);
        if (j?.status === 'succeeded') {
          const r = j.result as { model: string; usage: { inputTokens: number; outputTokens: number }; ms: number };
          setTest({ ok: true, text: f(t.ai.testOk, { model: r.model, tokens: r.usage.inputTokens + r.usage.outputTokens, ms: r.ms }) });
          return;
        }
        if (j && (j.status === 'failed' || j.status === 'canceled')) {
          setTest({ ok: false, text: `${t.ai.testFailed}: ${j.error}` });
          return;
        }
      }
      setTest({ ok: false, text: t.ai.testFailed });
    } catch (e) {
      setTest({ ok: false, text: `${t.ai.testFailed}: ${errorMessage(e, t)}` });
    } finally {
      setBusy(null);
    }
  }

  if (!info) return null;
  const providers: Provider[] = ['server', 'none', 'ollama', 'openai-compatible', 'anthropic'];
  return (
    <form
      className="grid max-w-md gap-4"
      data-testid="ai-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save(form.apiKey ? form.apiKey : undefined);
      }}
    >
      <Field label={t.ai.provider} hint={form.provider === 'server' ? f(t.ai.serverIs, { provider: t.ai.providers[info.server.provider] }) : undefined}>
        {() => (
          <Select<Provider>
            label={t.ai.provider}
            value={form.provider}
            onChange={(v) => setForm({ ...form, provider: v, model: '', baseUrl: '' })}
            options={providers.map((p) => ({ value: p, label: t.ai.providers[p] }))}
          />
        )}
      </Field>
      {own ? (
        <>
          <Field label={t.ai.model} hint={f(t.ai.modelHint, { model: defaults?.model ?? '' })}>
            {(p) => (
              <Input {...p} value={form.model} maxLength={120} placeholder={defaults?.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            )}
          </Field>
          <Field label={t.ai.baseUrl} hint={f(t.ai.baseUrlHint, { url: defaults?.baseUrl ?? '' })}>
            {(p) => (
              <Input
                {...p}
                type="url"
                value={form.baseUrl}
                maxLength={300}
                placeholder={defaults?.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            )}
          </Field>
          {form.provider !== 'ollama' ? (
            <Field label={t.ai.apiKey} hint={info.keyMasked ? `${f(t.ai.keySaved, { key: info.keyMasked })} ${t.ai.apiKeyHint}` : t.ai.apiKeyHint}>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="off"
                  value={form.apiKey}
                  maxLength={400}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
              )}
            </Field>
          ) : null}
          <Field label={t.ai.maxTokens} hint={t.ai.maxTokensHint}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={500}
                max={200000}
                step={500}
                value={form.maxTokens}
                onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) || 8000 })}
              />
            )}
          </Field>
        </>
      ) : null}
      <p className="text-[13px] text-fg-muted" data-testid="ai-privacy">
        {aiPrivacy(t, info.effective)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" loading={busy === 'save'}>
          {t.ai.save}
        </Button>
        <Button type="button" variant="ghost" onClick={() => void runTest()} loading={busy === 'test'} disabled={info.effective.provider === 'none'}>
          <PlugZap />
          {t.ai.test}
        </Button>
        {info.keyMasked && own ? (
          <Button type="button" variant="ghost" onClick={() => void save('')}>
            {t.ai.removeKey}
          </Button>
        ) : null}
      </div>
      {test ? (
        <p role="status" className={test.ok ? 'text-sm text-fg' : 'text-sm text-accent-fg'}>
          {test.text}
        </p>
      ) : null}
    </form>
  );
}
