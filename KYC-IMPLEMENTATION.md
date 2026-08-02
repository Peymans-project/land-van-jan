# Member login and KYC boundary

The current member login is server-side and backed by MongoDB. Passwords use
Node `scrypt` and authentication uses revocable HTTP-only sessions. Stripe
membership status is synchronized through signed webhooks. It is still
deliberately **not KYC** and does not verify that a registrant controls the
submitted email address.

It is deliberately **not KYC**. No identity document, selfie, bank data, or proof of address is requested or stored.

## Required before a real launch

1. Choose an EU-appropriate identity-verification provider and execute a data-processing agreement (DPA).
2. Add verified email and password recovery through a suitable transactional
   provider; add MFA for administrators.
3. Keep the minimal data model and implemented deletion/retention controls,
   publish a privacy notice, and document the full access/deletion process under
   AVG/GDPR.
4. Store verification status and provider reference only; avoid storing documents unless legally necessary.
5. Maintain rate limits, audit logs, consent records, admin roles, access
   controls, and incident-response monitoring.
6. For bulk messages, use only a separate opt-in mailing list, an unsubscribe link, and an auditable send log. Membership must not be treated as marketing consent.

Until these steps are complete, the UI must describe this as a member account,
not an identity check. Do not request ID documents. A €5 community membership
does not by itself justify KYC; establish a documented legal need before adding
identity verification.
