# Production member authentication

`server.mjs` now provides a same-origin API backed by MongoDB:

- `POST /api/auth/register` — creates a member account.
- `POST /api/auth/login` — starts a signed, HTTP-only session.
- `POST /api/auth/logout` — revokes the current server-side session.
- `GET /api/auth/me` — returns the current safe member profile.
- `GET /api/admin/members` — admin-only member list (maximum 100 records, never password hashes).
- `GET /api/health` — deployment health and authentication configuration status.

## Stripe memberships

The Stripe server SDK creates all payment links; the browser never receives a secret key.

- `POST /api/billing/checkout` — signed-in member only. Creates an idempotent Stripe Checkout subscription session and returns `{ "checkoutUrl": "https://checkout.stripe.com/..." }`. The frontend redirects to this URL.
- `POST /api/billing/portal` — signed-in member only. Returns `{ "portalUrl": "https://billing.stripe.com/..." }` for a member with a Stripe customer record.
- `POST /api/stripe/webhook` — Stripe-only raw-body endpoint. Verifies the `Stripe-Signature` header, then processes `checkout.session.completed` and `customer.subscription.*` events. It records Stripe event IDs in MongoDB to make completed deliveries idempotent.

Membership state is stored on the user record: `membershipStatus`, `stripeCustomerId`, `stripeSubscriptionId`, `membershipCurrentPeriodEnd`, and `membershipCancelAtPeriodEnd`. The subscription webhook is authoritative for ongoing status changes and cancellations; Checkout only records the initial association.

### Railway and Stripe configuration

Set these as **Railway Variables**, never in source control or browser-exposed `VITE_*` variables:

- `STRIPE_SECRET_KEY` — Stripe secret API key for the selected live/test environment.
- `STRIPE_WEBHOOK_SECRET` — signing secret for the exact webhook endpoint.
- `STRIPE_MEMBERSHIP_PRICE_ID` — recurring Stripe Price ID for the membership (for example, the €5/month price).
- `APP_BASE_URL` — canonical public app origin, without a trailing slash, used for Checkout success/cancel and portal return URLs.

Also retain `MONGODB_URI`, `MONGODB_DB`, `SESSION_SECRET`, `ADMIN_EMAILS`, and `NODE_ENV` from the authentication setup. In Stripe, configure the webhook endpoint as `https://YOUR_DOMAIN/api/stripe/webhook`, copy its signing secret into Railway, and subscribe it to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Configure the Stripe customer portal in the Stripe Dashboard before exposing the portal control.

## Activities and registrations

- `GET /api/activities` — public list of published activities.
- `GET /api/activities/:activityId` — public published activity detail.
- `POST /api/activities/:activityId/register` — signed-in member registration.
- `DELETE /api/activities/:activityId/register` — signed-in member cancellation.
- `GET /api/member/registrations` — signed-in member's registrations.
- `GET /api/admin/activities` and `POST /api/admin/activities` — admin list/create.
- `PATCH /api/admin/activities/:activityId` — admin edit, publish/cancel, adjust dates/capacity.
- `GET /api/admin/activities/:activityId/registrations` — admin attendee list.

Activities require `title`, `description`, `startsAt`, `endsAt`, `location`, a positive integer `capacity`, and a `draft`, `published`, or `cancelled` status. A MongoDB unique index prevents a member from registering twice. Capacity is atomically claimed before a registration is inserted, and reversed if insertion fails. An admin cannot lower capacity below existing registrations.

## Setup

1. Copy `.env.example` to `.env` locally or set the same values in Railway.
2. Add a MongoDB connection string and a separate database name for this project.
3. Generate a unique `SESSION_SECRET` of at least 32 characters; do not reuse application or database credentials.
4. Set `ADMIN_EMAILS` to the owner email **before** that account is registered. Only accounts created after their address appears in this list receive the admin role.
5. Run `npm run build` then `npm start`.

Passwords are hashed using Node's `scrypt`; session cookies are HTTP-only, SameSite=Lax, and Secure in production. Sessions also exist server-side and are revoked at logout. The API has in-memory per-IP rate limiting for registration and login. For multi-instance scaling, replace the in-memory limiter with Redis or the hosting platform's rate limiter.

## Security and privacy boundary

This is member authentication, not KYC. Do not collect identity documents until a certified identity-verification provider, DPA, retention policy, privacy notice, and data-subject request process are approved. See `KYC-IMPLEMENTATION.md`.

Bulk email is intentionally not implemented. It requires an explicit marketing opt-in separate from membership, an unsubscribe mechanism, a verified sender domain, an audit/send log, and a dedicated transactional/email provider.
