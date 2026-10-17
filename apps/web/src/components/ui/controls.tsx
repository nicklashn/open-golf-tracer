'use client';

import * as CheckboxP from '@radix-ui/react-checkbox';
import * as SelectP from '@radix-ui/react-select';
import * as SliderP from '@radix-ui/react-slider';
import * as SwitchP from '@radix-ui/react-switch';
import * as TabsP from '@radix-ui/react-tabs';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useOptionalLocale } from '@/lib/i18n/client';

export function Slider({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  className,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SliderP.Root
      className={cn('relative flex h-5 w-full touch-none select-none items-center', className)}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(v) => onChange(v[0])}
      onValueCommit={(v) => onCommit?.(v[0])}
    >
      <SliderP.Track className="relative h-1 grow rounded-full bg-border-strong">
        <SliderP.Range className="absolute h-full rounded-full bg-accent" />
      </SliderP.Track>
      <SliderP.Thumb
        aria-label={label}
        className="block size-3.5 rounded-full border border-border-strong bg-white shadow-sm transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
      />
    </SliderP.Root>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <SwitchP.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
      className="relative h-5 w-9 shrink-0 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <SwitchP.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-[120ms] data-[state=checked]:translate-x-[18px]" />
    </SwitchP.Root>
  );
}

export function Checkbox({ checked, onChange, id, ...rest }: { checked: boolean; onChange: (v: boolean) => void; id?: string; 'aria-describedby'?: string }) {
  return (
    <CheckboxP.Root
      id={id}
      checked={checked}
      onCheckedChange={(v) => onChange(v === true)}
      className="flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border border-border-strong bg-surface data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      {...rest}
    >
      <CheckboxP.Indicator>
        <Check className="size-3.5 text-white" strokeWidth={3} />
      </CheckboxP.Indicator>
    </CheckboxP.Root>
  );
}

export const Tabs = TabsP.Root;
export function TabsList({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <TabsP.List aria-label={label} className={cn('flex gap-1 border-b border-border', className)}>
      {children}
    </TabsP.List>
  );
}
export function TabsTrigger({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <TabsP.Trigger
      value={value}
      className={cn(
        '-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-[13px] font-medium text-fg-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg',
        className,
      )}
    >
      {children}
    </TabsP.Trigger>
  );
}
export const TabsContent = TabsP.Content;

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <SelectP.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectP.Trigger
        aria-label={label}
        className={cn(
          'inline-flex w-full items-center justify-between gap-2 rounded-sm border border-border-strong bg-surface px-3 text-left text-sm text-fg hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--focus)_25%,transparent)]',
          size === 'sm' ? 'h-8 text-[13px]' : 'h-10',
          className,
        )}
      >
        <SelectP.Value />
        <SelectP.Icon>
          <ChevronDown className="size-4 text-fg-muted" />
        </SelectP.Icon>
      </SelectP.Trigger>
      <SelectP.Portal>
        <SelectP.Content
          position="popper"
          sideOffset={4}
          className="z-[60] max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-surface-raised text-sm text-fg shadow-md"
        >
          <SelectP.Viewport className="p-1">
            {options.map((o) => (
              <SelectP.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex h-8 cursor-default select-none items-center rounded-sm pl-7 pr-3 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-sunken"
              >
                <SelectP.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5" />
                </SelectP.ItemIndicator>
                <SelectP.ItemText>{o.label}</SelectP.ItemText>
              </SelectP.Item>
            ))}
          </SelectP.Viewport>
        </SelectP.Content>
      </SelectP.Portal>
    </SelectP.Root>
  );
}

/** Segmented control (radio group look). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-sm border border-border-strong bg-surface-sunken p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 whitespace-nowrap rounded-[4px] px-2.5 font-medium text-fg-muted transition-colors hover:text-fg aria-checked:bg-surface-raised aria-checked:text-fg aria-checked:shadow-sm',
            size === 'sm' ? 'h-6 text-[12px]' : 'h-8 text-[13px]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A number as typed in the user's language: "1,5" in Danish. */
export function formatNumber(v: number, step: number, locale: string | null): string {
  const s = String(round(v, step));
  return locale === 'da' ? s.replace('.', ',') : s;
}

/** Reads "1,5" and "1.5" alike (a decimal comma or point); NaN when it is not a number. */
export function parseNumber(raw: string): number {
  const s = raw.replace(/\s/g, '').replace(',', '.');
  return s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? NaN : Number(s);
}

/** Numeric input that commits on blur/Enter (only when the number changed) and supports arrow keys. */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  label,
  className,
  placeholder,
  nullable,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label: string;
  className?: string;
  placeholder?: string;
  nullable?: boolean;
}) {
  const locale = useOptionalLocale();
  const shown = value == null ? '' : formatNumber(value, step, locale);
  const [text, setText] = useState(shown);
  const id = useId();
  useEffect(() => setText(shown), [shown]);
  const commit = (raw: string) => {
    // Tabbing through the field is not an edit (no undo step, no refit).
    if (raw.trim() === shown) return setText(shown);
    if (raw.trim() === '' && nullable) return value == null ? undefined : onChange(null);
    const n = parseNumber(raw);
    if (!Number.isFinite(n)) return setText(shown);
    const next = clamp(n, min, max);
    if (next === value) return setText(shown);
    onChange(next);
    // A clamped or rounded number shows as it was stored.
    setText(formatNumber(next, step, locale));
  };
  return (
    <div className={cn('flex h-8 items-center rounded-sm border border-border-strong bg-surface focus-within:border-[var(--focus)]', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        inputMode="decimal"
        className="tabular h-full w-full min-w-0 bg-transparent px-2 text-[13px] text-fg outline-none placeholder:text-fg-subtle"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const k = (e.shiftKey ? 10 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
            onChange(clamp((value ?? 0) + k, min, max));
          }
        }}
      />
      {unit ? <span className="pr-2 text-[12px] text-fg-subtle">{unit}</span> : null}
    </div>
  );
}

function clamp(v: number, lo?: number, hi?: number) {
  return Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, v));
}
function round(v: number, step: number) {
  const d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return Number(v.toFixed(d));
}

const SWATCHES = ['#ff3b30', '#ffc83d', '#39ff88', '#ffffff', '#3b82f6', '#111113'];

export function ColorField({
  value,
  onChange,
  label,
  swatches = SWATCHES,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  swatches?: string[];
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="flex items-center gap-1.5">
      {swatches.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`${label} ${c}`}
          aria-pressed={value.toLowerCase() === c}
          onClick={() => onChange(c)}
          className="size-6 rounded-full border border-border-strong aria-pressed:ring-2 aria-pressed:ring-[var(--focus)] aria-pressed:ring-offset-2 aria-pressed:ring-offset-[var(--surface)]"
          style={{ background: c }}
        />
      ))}
      <label className="relative ml-1 flex h-7 items-center gap-1 rounded-sm border border-border-strong bg-surface pl-1 pr-2">
        <input
          type="color"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="size-5 cursor-pointer appearance-none rounded-[3px] border-0 bg-transparent p-0"
        />
        <input
          aria-label={`${label} hex`}
          className="tabular w-16 bg-transparent text-[12px] uppercase text-fg outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => (/^#[0-9a-fA-F]{6}$/.test(text) ? onChange(text.toLowerCase()) : setText(value))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>
    </div>
  );
}
