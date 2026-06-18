# Prompt 2 — Normalize client form

- **Step:** `profile.normalize_clientform`
- **Model:** `claude-haiku`
- **Mode:** structured JSON
- **Safety:** read-safe

Same mechanism as Prompt 1 against the richer client-form keys, plus a
sensitive-field rule.

## System (delta from Prompt 1)

```
...same as Prompt 1, plus:
If a raw field maps to a sensitive key (npi, dea, state_license,
domain_credentials, website_credentials), map it correctly but set
"sensitive": true so the caller routes the value to restricted storage.
Never echo sensitive values in any summary text.
```

## User (template)

```
CANONICAL_KEYS: {{json: client-form keys + sensitive flag}}
UNMAPPED_FIELDS: {{json: [{raw_label, raw_value}]}}
```

## Note

After any Google Form edit, eyeball the first real submission's unmapped log.
Sensitive keys are enforced again in code via `SENSITIVE_KEYS` (see `src/redact.ts`).
