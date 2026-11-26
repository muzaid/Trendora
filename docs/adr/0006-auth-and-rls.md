# ADR 0006 — Authentication, authorization and RLS

**Status:** Accepted

- Tokens: HS256 JWTs. The server accepts its own sandbox tokens and Supabase Auth access tokens
  (`SUPABASE_JWT_SECRET`). `aal2` (MFA) is required for moderator/finance/admin when
  `REQUIRE_MFA_FOR_PRIVILEGED=true` (must be true in production).
- Web sessions use an HttpOnly SameSite=Lax cookie; cookie-authenticated mutations require a same-origin
  `Origin` header (CSRF). Mobile/API clients send `Authorization: Bearer`.
- Authorization happens in services: merchant permission matrix per role (`core/permissions.ts`),
  platform roles in `platform_roles`. Users cannot moderate/score their own entries.
- RLS is enabled and forced on every table. Clients may read only their own rows, merchant members their
  organization's rows; finance/moderation/ops tables are not granted at all. Anonymous users read only
  `app_public.*` views (verified stores, published campaigns, approved feed, leaderboard without voter
  data). `tests/rls` asserts cross-tenant denial and direct-API write denial.
