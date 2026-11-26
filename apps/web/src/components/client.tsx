'use client';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

export interface ApiError { code: string; message: string; requestId: string; details?: unknown }

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw (json.error ?? { code: 'INTERNAL', message: res.statusText, requestId: '-' }) as ApiError;
  return json as T;
}

export function newIdempotencyKey() {
  return crypto.randomUUID().replace(/-/g, '');
}

export function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const details = error.details as { blockers?: string[]; failing?: string[] } | { path: string; message: string }[] | undefined;
  return (
    <div className="alert error" role="alert">
      <strong>{error.message}</strong>
      {Array.isArray(details) && <ul className="small">{details.map((d, i) => <li key={i}>{d.path}: {d.message}</li>)}</ul>}
      {details && !Array.isArray(details) && (details.blockers || details.failing) && <ul className="small">{(details.blockers ?? details.failing)!.map((b) => <li key={b}>{b}</li>)}</ul>}
      <div className="small muted">Code {error.code} · request {error.requestId}</div>
    </div>
  );
}

/** Button that calls the API, then refreshes server components. */
export function ActionButton({ path, method = 'POST', body, children, className = 'btn', confirm, idempotent, onDone, redirectTo }: { path: string; method?: string; body?: unknown; children: ReactNode; className?: string; confirm?: string; idempotent?: boolean; onDone?: (r: unknown) => void; redirectTo?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <span className="stack" style={{ gap: 6 }}>
      <button
        type="button"
        className={className}
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(null);
          try {
            const r = await api(path, { method, body: body ?? {}, headers: idempotent ? { 'idempotency-key': newIdempotencyKey() } : {} });
            onDone?.(r);
            if (redirectTo) router.push(redirectTo);
            router.refresh();
          } catch (e) {
            setError(e as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Working…' : children}
      </button>
      <ErrorBox error={error} />
    </span>
  );
}

export type Field =
  | { name: string; label: string; type?: 'text' | 'number' | 'textarea' | 'date' | 'datetime-local' | 'email'; required?: boolean; defaultValue?: string | number; help?: string; minor?: boolean }
  | { name: string; label: string; type: 'select'; options: { value: string; label: string }[]; defaultValue?: string; help?: string; required?: boolean; minor?: undefined }
  | { name: string; label: string; type: 'checkbox'; defaultValue?: boolean; help?: string; required?: boolean; minor?: undefined };

/**
 * Declarative form → JSON API call. Number fields marked `minor` are entered in
 * major units (e.g. dollars) and converted to integer minor units.
 */
/** Serializable body template: `{ $: 'fieldName' }` is replaced by that field's value; everything else is literal. */
export type Template = { $: string } | string | number | boolean | null | Template[] | { [k: string]: Template };
function fill(t: Template, v: Record<string, unknown>): unknown {
  if (t && typeof t === 'object' && !Array.isArray(t) && '$' in t && typeof (t as { $: unknown }).$ === 'string') return v[(t as { $: string }).$];
  if (Array.isArray(t)) return t.map((x) => fill(x, v));
  if (t && typeof t === 'object') return Object.fromEntries(Object.entries(t).map(([k, x]) => [k, fill(x, v)]).filter(([, x]) => x !== undefined && x !== ''));
  return t;
}

export function ApiForm({ path, method = 'POST', fields, submitLabel, extra, template, onDone, idempotent, resetOnSuccess = true, successText }: { path: string; method?: string; fields: Field[]; submitLabel: string; extra?: Record<string, unknown>; template?: Template; onDone?: (r: unknown) => void; idempotent?: boolean; resetOnSuccess?: boolean; successText?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [ok, setOk] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        const values: Record<string, unknown> = { ...extra };
        for (const f of fields) {
          if (f.type === 'checkbox') values[f.name] = fd.get(f.name) === 'on';
          else if (f.type === 'number') {
            const raw = String(fd.get(f.name) ?? '');
            if (raw === '') continue;
            values[f.name] = f.minor ? Math.round(Number(raw) * 100) : Number(raw);
          } else if (f.type === 'datetime-local') {
            const raw = String(fd.get(f.name) ?? '');
            if (raw) values[f.name] = new Date(raw).toISOString();
          } else {
            const raw = String(fd.get(f.name) ?? '');
            if (raw !== '' || f.required) values[f.name] = raw;
          }
        }
        setBusy(true);
        setError(null);
        setOk(false);
        try {
          const r = await api(path, { method, body: template ? fill(template, values) : values, headers: idempotent ? { 'idempotency-key': newIdempotencyKey() } : {} });
          setOk(true);
          if (resetOnSuccess) form.reset();
          onDone?.(r);
          router.refresh();
        } catch (err) {
          setError(err as ApiError);
        } finally {
          setBusy(false);
        }
      }}
    >
      {fields.map((f) => (
        <FieldInput key={f.name} f={f} />
      ))}
      <ErrorBox error={error} />
      {ok && successText && <div className="alert ok" role="status">{successText}</div>}
      <div><button className="btn primary" disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : submitLabel}</button></div>
    </form>
  );
}

function FieldInput({ f }: { f: Field }) {
  const id = `f-${f.name}`;
  const help = f.help ? <span className="small muted" id={`${id}-help`}>{f.help}</span> : null;
  if (f.type === 'checkbox') return <label className="check" htmlFor={id}><input id={id} name={f.name} type="checkbox" defaultChecked={f.defaultValue} /> {f.label} {help}</label>;
  if (f.type === 'select') return <label htmlFor={id}>{f.label}<select id={id} name={f.name} defaultValue={f.defaultValue} required={f.required}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>{help}</label>;
  if (f.type === 'textarea') return <label htmlFor={id}>{f.label}<textarea id={id} name={f.name} defaultValue={f.defaultValue as string} required={f.required} aria-describedby={help ? `${id}-help` : undefined} />{help}</label>;
  return <label htmlFor={id}>{f.label}<input id={id} name={f.name} type={f.type ?? 'text'} step={f.type === 'number' ? (f.minor ? '0.01' : '1') : undefined} defaultValue={f.defaultValue} required={f.required} aria-describedby={help ? `${id}-help` : undefined} />{help}</label>;
}
