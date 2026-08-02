# Backend security and release gates

This note records the backend invariants covered by automated contract tests and
the production checks that still require integration work. It intentionally does
not contain Railway, MongoDB, or Stripe secrets.

## Tested contracts

- `GET /api/health` is a dependency-free liveness response.
- `GET /api/health/ready` fails closed when required backend configuration,
  MongoDB connectivity, or the startup transaction-capability probe fails.
- `GET /api/setup/status` returns redacted string states and the current privacy
  and marketing-consent versions. It must not expose Stripe IDs, keys, webhook
  secrets, or encrypted secret material.
- Contact and account registration reject an omitted or stale
  `privacyNoticeVersion`.
- Account deletion requires both the literal confirmation `VERWIJDER` and the
  member's current password. It queries canonical Stripe subscriptions, stores
  any cleanup job in the local deletion transaction, and only then attempts the
  irreversible external deletion. Pending jobs are retried by a periodic sweep.
- Admin transfer requires an authenticated admin, current-password
  re-authentication, the literal confirmation `BEHEER OVERDRAGEN`, an existing
  target member, a global role-change lease, a transaction, and an audit event.
- Login, Checkout, portal access, and deletion share the per-member mutation
  lease. Profile and activity registration/cancellation mutations re-check a
  non-deleting user in their final transaction.
- Startup exhausts legacy registration retention work in bounded batches,
  Railway throttling prefers `X-Real-IP`, and a waiting Stripe setup process
  accepts only the expected Stripe account and mode.
- Stripe webhook signing secrets use authenticated encryption with a key derived
  from the stable server-side `SESSION_SECRET`. Ordinary Stripe API-key rotation
  within the same account therefore reuses the endpoint; encryption-key rotation
  creates a replacement whose new signing secret remains decryptable.
- Stripe membership setup is idempotent and fixes the recurring price at EUR
  5.00 per month.
- Stripe portal and webhook resources are scoped by public URL. Checkout events
  must match this application's marker, pending workflow, and configured price
  before membership writes occur.
- Webhook-event claims carry an owner and fencing counter. Decryptable endpoint
  replacements retain a bounded previous-secret grace across ordinary setup
  reuse.
- A paused Stripe subscription is routed to the existing-customer portal and
  is never offered a second Checkout subscription.

Run the isolated backend suite with:

```sh
node --check server.mjs
node --test tests/backend.test.mjs
```

The test file clears backend and Stripe environment variables before importing
the server, so a developer shell containing production variables cannot make the
contract suite connect to live services.

## Production launch gates

The following items are not proven by the isolated contract suite and must be
resolved or explicitly accepted before broad production use:

1. **Account-mutation integration proof.** Deletion marks the user, serializes
   member and last-admin mutations, commits local erasure before external
   cleanup, and retries pending cleanup. Login, Checkout, and portal access use
   the same member lease; profile and activity registration/cancellation
   mutations re-check the user in their final transaction. Admin transfer is
   password-confirmed, globally serialized, transactional, and audited. These
   safeguards are contract-tested but still need deliberate race tests against
   the production replica set. Stripe customer deletion is permanent, so keep
   the documented live-subscription guard in every such test:
   <https://docs.stripe.com/api/customers/delete?lang=node>.
2. **Deployment namespace and domain migration.** Stripe portal and endpoint
   resources are now URL-scoped, so separate databases no longer disable each
   other's endpoints. The MongoDB `service_config` ID and setup lock remain
   database-global, so distinct public applications must not share one
   `MONGODB_DB`. A public-URL migration also needs explicit cleanup of the old
   scoped endpoint after its grace window. Prefer a dedicated database and
   Stripe environment for each deployed application.
3. **`SESSION_SECRET` rotation.** The previous-secret grace works when the old
   webhook ciphertext remains decryptable, such as an API-version replacement.
   Replacing `SESSION_SECRET` removes the old decryption key, so in-flight events
   signed by the predecessor cannot use that grace. Avoid live rotation until a
   controlled previous-key mechanism exists.
4. **Shared throttling.** Railway's documented `X-Real-IP` is now preferred at
   the trusted proxy boundary, but counters remain process-local. Replace them
   with shared Railway/Redis throttling before using multiple replicas. See
   <https://docs.railway.com/networking/public-networking/specs-and-limits>.
5. **Admin identity proof.** Startup bootstrap promotes an existing account by
   matching its email address. Because general email verification and admin MFA
   are not implemented, perform the documented bootstrap ceremony before public
   registration or add verified email plus MFA first. The supported transfer
   flow re-authenticates the current admin and promotes an existing member, but
   it does not prove control of the target member's mailbox.
6. **Production-shaped integration tests.** Exercise registration, deletion,
   activity-capacity races, lease fencing, Checkout, portal, webhook retry, key
   rotation, and rollback against a MongoDB replica set and Stripe sandbox.

## Railway readiness semantics

Railway uses the configured healthcheck while a new deployment is starting and
does not continuously monitor it after the deployment becomes active. The
current `/api/health/ready` endpoint initializes MongoDB, including a real
transaction-capability probe, and when a Stripe key is configured also verifies
or provisions billing. Railway's standard MongoDB template starts a standalone
`mongod`, while MongoDB standalone deployments do not support transactions; use
Atlas or another replica set. An unsupported topology now fails readiness. See
<https://docs.railway.com/guides/mongodb> and
<https://www.mongodb.com/docs/v8.0/core/transactions-production-consideration/>.
A temporary Stripe outage can keep a new deployment from becoming green while
Railway keeps the previous healthy deployment active; allow enough healthcheck
time for MongoDB initialization and first Stripe setup. See
<https://docs.railway.com/deployments/healthchecks>.

After deployment, verify both the Railway deployment state and the public URL:

```sh
curl --fail --show-error https://YOUR_DOMAIN/api/health/ready
curl --fail --show-error https://YOUR_DOMAIN/api/setup/status
```

The readiness response must report `database=ready`. When billing is configured,
the setup endpoint must report `billing=ready` (or a documented warning state)
without returning secret or internal Stripe fields.

A missing Stripe key intentionally still yields ready with
`billing=not_configured`. If membership billing is required for the release, the
deployment gate must assert the setup endpoint's billing state separately.
