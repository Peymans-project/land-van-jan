# Production member, admin and billing operations

`server.mjs` provides a same-origin API backed by MongoDB. Secrets belong only
in Railway Variables. Never paste a real secret into source, frontend variables,
logs, issues, chat, or documentation.

## Required Railway variables

- `MONGODB_URI` — TLS MongoDB connection string for this project.
- `MONGODB_DB` — dedicated database name, for example `land_van_jan`.
- `SESSION_SECRET` — unique random value of at least 32 characters. The server
  rejects example/placeholder-like values. It signs sessions and, through a
  domain-separated HKDF key, encrypts the Stripe webhook signing secret. Keep it
  stable; rotating it signs every member out and requires a controlled webhook
  endpoint replacement.
- `NODE_ENV=production`.
- `STRIPE_SECRET_KEY` — a newly issued server-side Stripe key. This is the only
  Stripe value the owner supplies.

`APP_BASE_URL` is optional on Railway because `RAILWAY_PUBLIC_DOMAIN` is
available automatically. Set `APP_BASE_URL` to the canonical custom HTTPS
origin when a custom domain is used. No trailing slash.

Do not set `STRIPE_WEBHOOK_SECRET` or `STRIPE_MEMBERSHIP_PRICE_ID`. The server
creates and manages those values itself.

## Safe first-admin bootstrap

Open registration never grants admin, including when a registration email
matches `ADMIN_EMAILS`.

1. Deploy with `ADMIN_EMAILS` empty.
2. The owner registers and successfully logs into the ordinary member account.
3. Only after that proof, set `ADMIN_EMAILS` to that one exact address in
   Railway Variables.
4. Restart/redeploy once. Startup reconciliation promotes the already-existing
   account and records an audit event.
5. Check `GET /api/setup/status`. `adminBootstrap` must be `ready`.

If the account does not exist when startup reconciliation runs, the status is
`awaiting_existing_account`. A later registration stays a member until another
explicit restart. Multiple configured bootstrap addresses produce `conflict`.
Once any admin exists, the environment variable never auto-promotes additional
accounts.

This ceremony keeps a registration request from granting admin immediately, but
email matching alone does not prove ownership. Keep public registration closed
until the owner's account has been bootstrapped, or add verified email and admin
MFA before a broad public launch.

## Safe admin transfer

A sole admin cannot delete their own account. First add a second admin through
the supported flow in `/beheer`:

1. The intended new admin creates an ordinary member account and successfully
   logs in to it themselves.
2. The current admin opens **Beheer overdragen**, enters that member's exact
   email address, re-enters their own current password, and types the literal
   confirmation `BEHEER OVERDRAGEN`.
3. `POST /api/admin/transfer` re-checks the current persisted admin role,
   promotes only an existing non-deleting member, records an audit event, and
   returns a safe member projection.
4. Confirm the second account can open `/beheer`. Only then may the original
   admin delete their own account from the members area.

The operation is serialized with the `admin_role_change` lease and committed in
a MongoDB transaction. It deliberately promotes a second admin without silently
demoting the current admin, so a failed hand-off cannot leave the project with
no administrator. It does not replace email verification or admin MFA.

## Auth, profile and privacy endpoints

- `POST /api/auth/register` — creates a member account only.
- `POST /api/auth/login` — starts a signed server-side session.
- `POST /api/auth/logout` — revokes the current session.
- `GET /api/auth/me` — returns the safe current member profile.
- `GET /api/member/profile` — safe profile.
- `PATCH /api/member/profile` — changes name and/or explicit marketing consent.
- `DELETE /api/member/account` — account deletion requiring both the literal
  confirmation `VERWIJDER` and the member's current password. The legacy alias
  `DELETE /api/member/profile` is also accepted.
- `POST /api/admin/transfer` — admin-only, password-confirmed promotion of an
  existing member so administration can be handed over safely.
- `GET /api/setup/status` — redacted auth/admin/billing readiness; never returns
  email addresses, Stripe IDs, keys, ciphertext, or signing secrets.

Contact and registration require the current `privacyNoticeVersion` returned by
the setup endpoint. Marketing opt-in requires its current
`marketingConsentVersion`; registration payloads without that exact marketing
version remain opted out. Consent changes are separately logged. Membership is
never treated as marketing consent.

Account deletion first retrieves canonical Stripe subscriptions. The local
transaction then removes sessions, registrations, and consent records, updates
activity capacity, and persists any Stripe cleanup job before the irreversible
external deletion is attempted. Pending jobs are retried every minute. A sole
admin must promote a second admin through the supported transfer flow first.

Login, Checkout, portal access, and deletion serialize on the same
`member_mutation:<userId>` lease. Profile mutations and activity
registration/cancellation re-check a non-deleting user inside their final
transaction; deletion marks the account before erasure and separately
serializes last-admin checks. These invariants still need production-shaped
concurrency testing on the replica set, as listed in
`docs/backend-security.md`.

Contact:

- `POST /api/contact` — validated contact request, rate limited.
- `GET /api/admin/contact-messages` — admin-only inbox.
- `PATCH /api/admin/contact-messages/:id` — marks a message new, read, or
  archived.

Contact messages expire automatically after 180 days. Security audit records
expire after 400 days. Sessions expire after 14 days and Stripe event
deduplication records after 90 days. Completed external-deletion job metadata
expires after 30 days; pending jobs remain until cleanup succeeds.

## Activities and registrations

- `GET /api/activities` and `GET /api/activities/:activityId` — public,
  published activity data.
- `POST /api/activities/:activityId/register` — authenticated registration.
- `DELETE /api/activities/:activityId/register` — authenticated cancellation.
- `GET /api/member/registrations` — current member registrations.
- `GET/POST /api/admin/activities` — admin list/create.
- `PATCH /api/admin/activities/:activityId` — admin edit/publish/cancel.
- `GET /api/admin/activities/:activityId/registrations` — admin attendee list.

Registration and cancellation use MongoDB transactions. Capacity is claimed
atomically, duplicate registration is protected by a unique index, and an admin
capacity edit uses a conditional update so it cannot race below the live count.
Production MongoDB must therefore support multi-document transactions (Atlas or
another replica set).

Railway's standard MongoDB template starts a standalone `mongod` and is not
sufficient for these routes unless it is explicitly converted to a replica set.
Prefer a production MongoDB Atlas replica set. Backend initialization now runs a
real transaction-capability probe, so an unsupported topology fails readiness.

The API accepts the current admin UI payload. Missing location defaults to
Land van Jan in Huissen, missing end time defaults to two hours after start, and
`published` is mapped to the canonical `draft`/`published` status.

## One-step Stripe setup

On service warmup (or first Checkout request), the server uses only
`STRIPE_SECRET_KEY` to provision and verify:

1. a marked Land van Jan membership Product;
2. an exact EUR 5.00 recurring monthly Price with a fixed lookup key;
3. a customer portal configuration with invoice history, payment-method update,
   and cancellation at period end;
4. a version-pinned webhook endpoint for Checkout completion and subscription
   lifecycle events.

Product, Price, portal, and endpoint IDs are stored only in the MongoDB
`service_config` collection. The endpoint signing secret is returned by Stripe
only when the endpoint is created; the server immediately encrypts it with
AES-256-GCM. Its encryption key is derived server-side from the stable
`SESSION_SECRET` using a domain-separated HKDF key, so ordinary Stripe API-key
rotation cannot make the signing secret unreadable. Neither IDs nor secrets are
returned through the API.

Provisioning uses a MongoDB lease, Stripe idempotency keys, resource metadata,
fixed lookup keys, lease renewal, a fencing token, and post-write cleanup.
Repeated deploys reuse the same resources. Rotating the Stripe API key within
the same account reuses the existing endpoint because encryption remains bound
to `SESSION_SECRET`. A `SESSION_SECRET` rotation or unreadable stored secret
creates a replacement endpoint, stores its new encrypted signing secret, and
then disables managed predecessor endpoints. When the old ciphertext is still
decryptable, its signing secret remains accepted for a bounded 24-hour grace
period, including across ordinary setup reuse. Treat `SESSION_SECRET` replacement
as a controlled maintenance operation: it removes the old decryption key, so
avoid rotating it during live webhook delivery.

A transient provisioning failure does not demote an already-ready stored
configuration: while `SESSION_SECRET` remains unchanged, webhook verification
continues with the last known good secret, and `lastSetupFailedAt` records the
warning for `/api/setup/status`. Failed setup promises are evicted so a later
request or warmup can retry.

A key belonging to a different Stripe account cannot disable endpoints in the
old account. Clean those up in the old Stripe account before revoking access.
Webhook and portal resources are scoped by public URL, but Product/Price and the
MongoDB service-config record are shared assumptions. Do not share one
`MONGODB_DB` or Stripe environment between distinct deployed applications.

Webhook processing verifies the raw body signature, leases each event, retries
failed or abandoned work, fences late workers, and records processed event IDs.
Checkout completion is accepted only for the marked pending workflow and exact
configured price. Subscription events retrieve the canonical current
Subscription from Stripe, so out-of-order
delivery cannot roll membership state backward. With the pinned Clover API,
period end is read from subscription items.

## Security boundary

- Passwords use Node `scrypt` with a random per-password salt and constant-time
  comparison.
- Session cookies are HTTP-only, SameSite=Lax, Secure in production, and backed
  by revocable MongoDB sessions.
- State-changing browser requests require exact same-origin `Origin` and
  `Sec-Fetch-Site` semantics; JSON endpoints require
  `Content-Type: application/json`.
- Responses include CSP, frame denial, no-referrer, MIME hardening,
  permissions policy, and HSTS in production.
- Login, registration, profile, billing, contact, and registration routes are
  rate limited. The limiter is process-local; use a shared Railway/Redis limiter
  before multi-instance scaling.
- Admin APIs enforce the persisted server-side role. Frontend checks are not an
  authorization boundary.

`GET /api/health` is liveness only. Railway must use
`GET /api/health/ready`, which verifies required configuration, completes the
MongoDB connection/index setup and transaction probe, pings MongoDB, and
verifies configured billing setup before returning HTTP 200. A missing optional
Stripe key is reported as
`billing=not_configured`; a configured but unusable Stripe setup returns 503.

No KYC, identity documents, bulk email sending, or password recovery is
implemented. Do not add KYC unless there is a documented legal need, approved
provider/DPA, and retention policy. Before launch, publish the privacy notice,
document Railway/MongoDB/Stripe processors and transfers, and establish data
access/deletion and incident-response procedures.

## Verification

Run:

```sh
node --check server.mjs
npm run build
npm test
```

Use Stripe sandbox mode first. Confirm `billing=ready` through the redacted
setup endpoint, complete a test Checkout, verify the webhook delivery, open the
portal, cancel at period end, and confirm the member status follows the
canonical Stripe subscription before enabling a live key.
