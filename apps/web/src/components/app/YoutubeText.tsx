'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n/client';

/** Description and chapters for YouTube, read-only, with a copy button (also in the export dialog and My videos). */
export function YoutubeText({ text, rows = 6 }: { text: string; rows?: number }) {
  const { t } = useI18n();
  const T = t.youtube;
  const [copied, setCopied] = useState(false);
  return (
    <Field label={T.title} hint={T.hint}>
      {(p) => (
        <div className="flex flex-col gap-2" data-testid="youtube-text">
          <Textarea {...p} readOnly value={text} rows={rows} className="tabular text-[13px]" />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="self-end"
            onClick={() => {
              void navigator.clipboard?.writeText(text).catch(() => {});
              setCopied(true);
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? T.copied : T.copy}
          </Button>
        </div>
      )}
    </Field>
  );
}
