# ADR 0004 — Provider adapters with explicit sandbox implementations

**Status:** Accepted

Payment provider, video provider and AI provider are interfaces (`packages/services/src/adapters`).
Until launch geography, underwriting and provider contracts are approved (open decisions), only
**sandbox** adapters ship, and every sandbox surface is labelled in the UI:

- `SandboxPaymentProvider` — hosted checkout page under `/sandbox/checkout/:id`; payment outcomes are
  delivered as **signed webhooks** through the same ingestion path as production.
- `SandboxVideoProvider` — signed direct-upload URL, magic-byte sniffing, ffprobe duration limits,
  metadata stripping (ffmpeg remux), SHA-256 content hash for duplicate detection, signed playback tokens.
- `SandboxAgentProvider` — deterministic rule-based advisory output; `ClaudeAgentProvider` is used when
  `ANTHROPIC_API_KEY` is set (structured outputs, cost tracking, monthly budget cap).
- Sandbox clock offsets (admin only, sandbox only) let demos/E2E move through campaign phases without
  editing published rules.

Real adapters (Stripe Connect / Adyen for Platforms; Mux / Cloudflare Stream) implement the same
interfaces; validate current provider docs before integrating.
