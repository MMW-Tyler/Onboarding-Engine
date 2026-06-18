import type { StepContext } from '../types.js';

/**
 * Shared HTTP helper for integration workers. Centralizes the spec's
 * "one step_events row per external call" rule (section 06/10): it logs a
 * redacted request event before the call and a response event after, parses
 * JSON defensively, and throws a useful error on non-2xx so the runner's
 * retry/flag logic kicks in.
 *
 * Secrets in headers/body are stripped by the redaction helper inside logEvent,
 * so callers may pass real auth headers here.
 */
export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body (object) - serialized and content-type set automatically */
  json?: unknown;
  /** raw body (string), used instead of json when set */
  body?: string;
  /** form-encoded body (object) */
  form?: Record<string, string>;
  timeoutMs?: number;
  /** treat these non-2xx statuses as success (e.g. 409 already-exists) */
  okStatuses?: number[];
}

export interface CallResult<T = any> {
  status: number;
  ok: boolean;
  body: T;
  raw: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Perform an HTTP call within a step, logging request + response to step_events.
 * `label` names the logical operation (used as the event endpoint suffix).
 */
export async function callApi<T = any>(
  ctx: StepContext,
  url: string,
  label: string,
  opts: CallOptions = {},
): Promise<CallResult<T>> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };

  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] = headers['content-type'] ?? 'application/json';
  } else if (opts.form !== undefined) {
    body = new URLSearchParams(opts.form).toString();
    headers['content-type'] = headers['content-type'] ?? 'application/x-www-form-urlencoded';
  } else if (opts.body !== undefined) {
    body = opts.body;
  }

  await ctx.logEvent({
    level: 'info',
    endpoint: `${method} ${label}`,
    request: { url, method, headers, body: opts.json ?? opts.form ?? opts.body ?? null },
  });

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.logEvent({ level: 'error', endpoint: `${method} ${label}`, parsed_error: `network: ${message}`, duration_ms: Date.now() - started });
    throw new HttpError(`${label}: network error: ${message}`, 0, null);
  } finally {
    clearTimeout(timeout);
  }

  const raw = await res.text();
  let parsed: any = raw;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json') || (raw.startsWith('{') || raw.startsWith('['))) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  const ok = res.ok || (opts.okStatuses?.includes(res.status) ?? false);
  await ctx.logEvent({
    level: ok ? 'info' : 'error',
    endpoint: `${method} ${label}`,
    response_status: res.status,
    response_body: parsed,
    parsed_error: ok ? undefined : summarizeError(parsed, res.status),
    duration_ms: Date.now() - started,
  });

  if (!ok) {
    throw new HttpError(`${label}: HTTP ${res.status} - ${summarizeError(parsed, res.status)}`, res.status, parsed);
  }

  return { status: res.status, ok, body: parsed as T, raw };
}

function summarizeError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = b.message ?? b.error ?? b.error_description ?? (b.errors && JSON.stringify(b.errors));
    if (msg) return String(msg);
  }
  if (typeof body === 'string' && body.length > 0) return body.slice(0, 300);
  return `status ${status}`;
}
