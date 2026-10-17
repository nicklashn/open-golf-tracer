'use client';

/**
 * Settings → AI: which model "Make a video for me" may use. The key is sent to the server once
 * and never comes back – the page only ever sees it masked. "ChatGPT (your plan)" signs in with
 * ChatGPT instead (OpenAI's flow for local apps); the tokens stay on the server.
 */
import { CHATGPT_USAGE_URL, DEFAULT_AI_MAX_TOKENS, largeRound, typicalTokenEstimate, videoTokenEstimate } from '@golf/compose';
import { ExternalLink, LogOut, PlugZap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, Switch } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { aiErrorText } from '@/lib/aiError';
import { api, errorMessage } from '@/lib/api';
import type { JobInfo } from '@/lib/events';
import { useI18n } from '@/lib/i18n/client';

type Provider = 'server' | 'none' | 'ollama' | 'openai-compatible' | 'anthropic' | 'chatgpt';

export interface AiSettingsInfo {
  /** Only on a save: the stored key was removed because the provider or address changed. */
  keyCleared?: boolean;
  provider: Provider;
  model: string;
  baseUrl: string;
  keyMasked: string;
  maxTokens: number;
  /** Still frames from the green may be sent when the putt count is unsure. */
  vision: boolean;
  effective: {
    provider: Exclude<Provider, 'server'>;
    model: string;
    baseUrl: string;
    source: string;
    keyMasked: string;
    maxTokens: number;
    cloud: boolean;
    vision: boolean;
  };
  server: { provider: Exclude<Provider, 'server'>; model: string; keyMasked: string };
  defaults: Record<string, { baseUrl: string; model: string }>;
  /** Sign in with ChatGPT: never a token, only whether it can be used. */
  chatgpt: { signedIn: boolean; registered: boolean; email: string; expiresAt: string | null; problem: '' | 'sign_in_again' | 'no_plan' };
}

/** One line on what leaves the machine with the current choice. */
export function aiPrivacy(t: ReturnType<typeof useI18n>['t'], eff: AiSettingsInfo['effective'] | undefined): string {
  if (!eff || eff.provider === 'none') return t.ai.privacyNone;
  if (eff.provider === 'ollama') return t.ai.privacyLocal;
  if (eff.provider === 'chatgpt') return eff.vision ? t.ai.privacyChatgptVision : t.ai.privacyChatgpt;
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
  return (eff.vision ? t.ai.privacyCloudVision : t.ai.privacyCloud).replace('{provider}', who);
}

/** "Using ChatGPT plan" with the link to ChatGPT's usage settings (OpenAI's UI guidelines). */
export function ChatGptPlanNote({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <p className={`flex flex-wrap items-center gap-x-2 text-[13px] ${className ?? ''}`} data-testid="chatgpt-plan">
      <span className="font-medium">{t.ai.chatgpt.using}</span>
      <ManageUsage />
    </p>
  );
}

export function ManageUsage() {
  const { t } = useI18n();
  return (
    <a
      href={CHATGPT_USAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-accent-fg underline-offset-4 hover:underline"
    >
      {t.ai.chatgpt.manageUsage}
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

/**
 * "≈ N tokens per video" for a full round with what is switched on (both plan calls, and the
 * pictures' own allowance), what a large round needs, and a warning when the ceiling is too low.
 */
function TokenBudget({ maxTokens, vision }: { maxTokens: number; vision: boolean }) {
  const { t, f, locale } = useI18n();
  const e = useMemo(() => typicalTokenEstimate({ vision }), [vision]);
  const large = useMemo(() => {
    const r = largeRound();
    return videoTokenEstimate(r.summary, '', r.plan).needed;
  }, []);
  const n = (v: number) => (Math.ceil(v / 100) * 100).toLocaleString(locale === 'da' ? 'da-DK' : 'en-GB');
  return (
    <div className="grid gap-1 text-[13px]" data-testid="ai-estimate">
      <p className="text-fg-muted">
        {f(t.aiPlan.estimate, { total: n(e.total), plan: n(e.plan) })} {f(t.aiPlan.estimateLarge, { needed: n(large) })}
        {vision ? ` ${f(t.aiPlan.estimateVision, { n: n(e.vision) })}` : ''}
      </p>
      {maxTokens < e.needed ? (
        <p role="status" className="text-accent-fg">
          {f(t.aiPlan.tooLow, { needed: n(e.needed) })}
        </p>
      ) : null}
    </div>
  );
}

/** Provider and origin a stored key is sent to (the server drops the key when this changes). */
export function keyTarget(provider: string, baseUrl: string, defaults: AiSettingsInfo['defaults']): string {
  const url = baseUrl.trim() || defaults[provider]?.baseUrl || '';
  try {
    return `${provider} ${new URL(url).origin}`;
  } catch {
    return `${provider} ${url}`;
  }
}

const MIN_TOKENS = 500;
const MAX_TOKENS = 200_000;
const clampTokens = (v: number) => Math.min(MAX_TOKENS, Math.max(MIN_TOKENS, Math.round(v)));

/**
 * The ceiling as typed: the text is the user's while they type (clearing the field to type a new
 * number does not snap back to the default); the number follows whenever the text is one, and
 * the field shows the number in range again when it loses focus.
 */
function TokenField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((x) => (Number(x) === value ? x : String(value)));
  }, [value]);
  return (
    <Field label={t.ai.maxTokens} hint={t.ai.maxTokensHint}>
      {(p) => (
        <Input
          {...p}
          type="number"
          min={MIN_TOKENS}
          max={MAX_TOKENS}
          step={500}
          value={text}
          data-testid="ai-max-tokens"
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() && Number.isFinite(v) && v > 0) onChange(Math.round(v));
          }}
          onBlur={() => {
            const v = clampTokens(value);
            setText(String(v));
            if (v !== value) onChange(v);
          }}
        />
      )}
    </Field>
  );
}

const isLocalHost = (h: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h) || h.endsWith('.localhost');

/** Signs in, shows the account, picks the model, signs out. */
function ChatGptPanel({ info, model, onModel, reload }: { info: AiSettingsInfo; model: string; onModel: (m: string) => void; reload: () => Promise<void> }) {
  const { t, f } = useI18n();
  const T = t.ai.chatgpt;
  const c = info.chatgpt;
  const [models, setModels] = useState<{ slug: string; name: string }[] | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [busy, setBusy] = useState<'in' | 'out' | null>(null);
  const [local, setLocal] = useState(true);
  useEffect(() => setLocal(isLocalHost(window.location.hostname)), []);

  useEffect(() => {
    if (!c.signedIn) return;
    setModelsError('');
    void api<{ models: { slug: string; name: string }[] }>('/ai/chatgpt/models').then(
      (r) => {
        setModels(r.models);
        if (!model && r.models[0]) onModel(r.models[0].slug);
      },
      (e) => setModelsError(errorMessage(e, t)),
    );
    // Once per sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.signedIn, c.email]);

  async function signIn(newAccount = false) {
    setBusy('in');
    // Opened right away (still inside the click), pointed at OpenAI once the server has the URL.
    const w = window.open('', '_blank');
    try {
      const { url } = await api<{ url: string }>('/ai/chatgpt/start', { body: { returnTo: window.location.origin, newAccount } });
      if (w) {
        w.opener = null;
        w.location.href = url;
      } else window.location.assign(url);
    } catch (e) {
      w?.close();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy('out');
    try {
      const r = await api<{ revoked: boolean }>('/ai/chatgpt/signout', { method: 'POST' });
      toast.success(r.revoked ? T.signedOut : T.signedOutUnconfirmed);
      setModels(null);
      await reload();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }

  if (!c.signedIn)
    return (
      <div className="grid gap-3 rounded-md border border-border p-4" data-testid="chatgpt-signin">
        <div>
          <h3 className="text-sm font-semibold">{T.title}</h3>
          <p className="text-[13px] text-fg-muted">{T.lead}</p>
        </div>
        {c.problem ? (
          <p role="status" className="text-[13px] text-accent-fg">
            {c.problem === 'no_plan' ? T.noPlan : T.signInAgain}
          </p>
        ) : null}
        {!local ? <p className="text-[13px] text-accent-fg">{T.samePc}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void signIn()}
            loading={busy === 'in'}
            className="border-0 bg-black text-white hover:bg-black/85 active:bg-black dark:bg-white dark:text-black dark:hover:bg-white/85"
          >
            {T.continue}
          </Button>
          {c.registered ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void signIn(true)}>
              {T.otherAccount}
            </Button>
          ) : null}
        </div>
        <p className="text-[12px] text-fg-muted">{T.samePcHint}</p>
      </div>
    );

  return (
    <div className="grid gap-3 rounded-md border border-border p-4" data-testid="chatgpt-account">
      <p className="text-sm">{f(T.signedInAs, { email: c.email || 'ChatGPT' })}</p>
      <ChatGptPlanNote />
      <Field label={T.model} hint={modelsError ? `${T.modelsFailed}: ${modelsError}` : T.modelHint}>
        {() =>
          models?.length ? (
            <Select<string>
              label={T.model}
              value={model}
              onChange={onModel}
              options={[
                ...(model && !models.some((m) => m.slug === model) ? [{ value: model, label: model }] : []),
                ...models.map((m) => ({ value: m.slug, label: m.name })),
              ]}
            />
          ) : (
            <p className="text-[13px] text-fg-muted">{model || '…'}</p>
          )
        }
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()} loading={busy === 'out'}>
          <LogOut />
          {T.signOut}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void signIn(true)}>
          {T.otherAccount}
        </Button>
      </div>
    </div>
  );
}

export function AiSettingsForm() {
  const { t, f } = useI18n();
  const [info, setInfo] = useState<AiSettingsInfo | null>(null);
  const [form, setForm] = useState({ provider: 'server' as Provider, model: '', baseUrl: '', apiKey: '', maxTokens: DEFAULT_AI_MAX_TOKENS, vision: false });
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string; limit?: boolean } | null>(null);

  const [welcome, setWelcome] = useState(false);

  useEffect(() => {
    void api<AiSettingsInfo>('/ai/settings').then((s) => {
      setInfo(s);
      setForm({ provider: s.provider, model: s.model, baseUrl: s.baseUrl, apiKey: '', maxTokens: s.maxTokens, vision: s.vision });
    });
  }, []);

  // Back from "Continue with ChatGPT" (the API's callback sends the browser here).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get('chatgpt');
    if (!r) return;
    if (r === 'ok') {
      toast.success(t.ai.chatgpt.signedIn);
      if (q.get('first') === '1') setWelcome(true);
    } else toast.error((t.ai.chatgpt.errors as Record<string, string>)[r] ?? t.ai.chatgpt.errors.error);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The sign-in finishes in another tab: pick it up when this one is used again.
  const reload = useCallback(async () => {
    const s = await api<AiSettingsInfo>('/ai/settings');
    setInfo(s);
    if (s.provider === 'chatgpt') setForm((x) => (x.provider === 'chatgpt' && !x.model ? { ...x, model: s.model } : x));
  }, []);
  useEffect(() => {
    const onFocus = () => void reload().catch(() => {});
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const own = form.provider !== 'server' && form.provider !== 'none' && form.provider !== 'chatgpt';
  const defaults = own ? info?.defaults[form.provider] : undefined;
  // Saving without a new key while pointing somewhere else removes the stored one.
  const keyWillClear =
    !!info?.keyMasked && !form.apiKey.trim() && keyTarget(info.provider, info.baseUrl, info.defaults) !== keyTarget(form.provider, form.baseUrl, info.defaults);

  async function save(apiKey?: string) {
    setBusy('save');
    try {
      const body = {
        provider: form.provider,
        model: form.model,
        baseUrl: form.baseUrl,
        maxTokens: clampTokens(form.maxTokens),
        vision: form.vision,
        ...(apiKey !== undefined ? { apiKey } : {}),
      };
      const s = await api<AiSettingsInfo>('/ai/settings', { method: 'PUT', body });
      setInfo(s);
      setForm((x) => ({ ...x, apiKey: '' }));
      setTest(null);
      if (s.keyCleared) toast.info(t.ai.saved, t.ai.keyCleared);
      else toast.success(t.ai.saved);
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
        // The test has a lane of its own in the exporter: still queued after a while means no exporter.
        if (j?.status === 'queued' && i === 4) setTest({ ok: true, text: t.ai.testQueued });
        if (j?.status === 'queued' && i >= 30) {
          await api(`/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {});
          setTest({ ok: false, text: t.ai.testNotStarted });
          return;
        }
        if (j?.status === 'succeeded') {
          const r = j.result as { model: string; usage: { inputTokens: number; outputTokens: number }; ms: number };
          setTest({ ok: true, text: f(t.ai.testOk, { model: r.model, tokens: r.usage.inputTokens + r.usage.outputTokens, ms: r.ms }) });
          return;
        }
        if (j && (j.status === 'failed' || j.status === 'canceled')) {
          setTest({ ok: false, text: `${t.ai.testFailed}: ${aiErrorText(j.error, t).text}`, limit: aiErrorText(j.error, t).limit });
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
  const providers: Provider[] = ['server', 'none', 'ollama', 'openai-compatible', 'anthropic', 'chatgpt'];
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
      {form.provider === 'chatgpt' ? (
        <>
          <ChatGptPanel info={info} model={form.model} onModel={(m) => setForm((x) => ({ ...x, model: m }))} reload={reload} />
          <TokenField value={form.maxTokens} onChange={(v) => setForm((x) => ({ ...x, maxTokens: v }))} />
        </>
      ) : null}
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
            <Field
              label={t.ai.apiKey}
              hint={info.keyMasked && !keyWillClear ? `${f(t.ai.keySaved, { key: info.keyMasked })} ${t.ai.apiKeyHint}` : t.ai.apiKeyHint}
            >
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
          <TokenField value={form.maxTokens} onChange={(v) => setForm((x) => ({ ...x, maxTokens: v }))} />
        </>
      ) : null}
      {form.provider !== 'none' ? (
        <div className="grid gap-1">
          <label className="flex items-center justify-between gap-3 text-sm">
            {t.ai.vision}
            <Switch checked={form.vision} onChange={(v) => setForm({ ...form, vision: v })} label={t.ai.vision} />
          </label>
          <p className="text-[13px] text-fg-muted">{t.ai.visionHint}</p>
          {form.vision &&
          (form.provider === 'ollama' || (form.provider === 'server' && info.server.provider === 'ollama')) &&
          /^llama3\.1\b/.test(form.model || info.effective.model || 'llama3.1') ? (
            <p className="text-[13px] text-accent-fg" data-testid="ai-vision-model">
              {t.aiPlan.visionOllama}
            </p>
          ) : null}
        </div>
      ) : null}
      {form.provider !== 'none' && (form.provider !== 'server' || info.server.provider !== 'none') ? (
        <TokenBudget maxTokens={form.provider === 'server' ? info.effective.maxTokens : form.maxTokens} vision={form.vision} />
      ) : null}
      {keyWillClear ? (
        <p role="status" className="text-[13px] text-accent-fg" data-testid="ai-key-will-clear">
          {t.ai.keyWillClear}
        </p>
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
          {!test.ok && test.limit ? (
            <>
              {' '}
              <ManageUsage />
            </>
          ) : null}
        </p>
      ) : null}
      <Dialog open={welcome} onOpenChange={setWelcome}>
        <DialogContent title={t.ai.chatgpt.welcomeTitle} description={t.ai.chatgpt.welcomeLead} closeLabel={t.common.close}>
          <DialogFooter>
            <Button type="button" variant="primary" onClick={() => setWelcome(false)}>
              {t.ai.chatgpt.gotIt}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
