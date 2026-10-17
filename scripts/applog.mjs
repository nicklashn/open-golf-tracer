/**
 * The launcher's log file: every line the API, worker, exporter and web print also goes to
 * DATA_DIR/logs/app-YYYYMMDD.log, so it is still there after the console window is closed
 * (Settings → About → "Save diagnostics" packs the newest ones).
 *
 * - A new file each day; files older than KEEP_DAYS are deleted.
 * - A file over MAX_BYTES is renamed to app-YYYYMMDD.1.log (replacing an older .1) and a fresh
 *   one started, so one day never takes more than ~2 × MAX_BYTES.
 * - Every line passes redact() first. The patterns match apps/api/golf_api/redact.py; both are
 *   tested with scripts/test/redact-cases.json.
 */
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_DAYS = 7;
export const MAX_BYTES = 20 * 1024 * 1024;
const MASK = '[redacted]';

const PATTERNS = [
  // Authorization: Bearer … / Basic …
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // key=value / "key": "value" for names that hold secrets
  [
    /((?:x-)?api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret[_-]?key|internal[_-]?token|password|secret|token|authorization)(["']?\s*[:=]\s*["']?)(?!bearer\b|basic\b)([^\s"'&,;}]{8,})/gi,
    `$1$2${MASK}`,
  ],
  // OAuth codes and state in a query string
  [/([?&](?:code|state|key)=)[^&\s"']+/g, `$1${MASK}`],
  // Provider keys: OpenAI (sk-, sk-proj-), Anthropic (sk-ant-), GitHub, Google, Hugging Face
  [/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{20,})/g, MASK],
  // JWTs (ChatGPT access / ID tokens)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  // Signed media URLs (/api/m/<payload>.<mac>)
  [/(\/m\/)[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, `$1${MASK}`],
];

/** `text` with known secret values and anything shaped like a key, bearer token or JWT masked. */
export function redact(text, secrets = []) {
  let out = text;
  for (const s of [...new Set(secrets)].filter((x) => x && x.length >= 6).sort((a, b) => b.length - a.length)) out = out.split(s).join(MASK);
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

// Colour codes from the children (and the launcher's own tags) do not belong in a text file.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const day = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** Deletes app-*.log files whose day is more than `keepDays` before `now`. */
export function prune(dir, now = new Date(), keepDays = KEEP_DAYS) {
  const cutoff = day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays + 1));
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^app-(\d{8})(?:\.\d+)?\.log$/.exec(n);
    if (m && m[1] < cutoff) rmSync(join(dir, n), { force: true });
  }
}

/**
 * A log sink: write(name, line) appends "<time> <name>| <line>" (redacted, no colours) to today's
 * file. Never throws: a full disk or a locked file must not stop the app.
 */
export function createLog(dir, { secrets = [], keepDays = KEEP_DAYS, maxBytes = MAX_BYTES, clock = () => new Date() } = {}) {
  let ok = true;
  try {
    mkdirSync(dir, { recursive: true });
    prune(dir, clock(), keepDays);
  } catch {
    ok = false;
  }
  let current = '';
  let size = 0;
  return {
    dir,
    get file() {
      return current;
    },
    write(name, line) {
      if (!ok) return;
      try {
        const now = clock();
        const file = join(dir, `app-${day(now)}.log`);
        if (file !== current) {
          if (current) prune(dir, now, keepDays);
          current = file;
          try {
            size = statSync(file).size;
          } catch {
            size = 0;
          }
        }
        if (size > maxBytes) {
          renameSync(file, file.replace(/\.log$/, '.1.log'));
          size = 0;
        }
        const text = `${now.toISOString()} ${name.padEnd(8)}| ${redact(line.replace(ANSI, ''), secrets)}\n`;
        appendFileSync(file, text);
        size += Buffer.byteLength(text);
      } catch {
        /* logging must never take the app down */
      }
    },
  };
}
