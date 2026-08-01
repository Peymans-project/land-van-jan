# Member login and KYC boundary

The current member login is a **local preview only**. It lets a visitor create an account and sign in on the same browser/device. Passwords are SHA-256 hashed in the browser before being stored locally. It has no server, central member list, payment status, email delivery, or recovery flow.

It is deliberately **not KYC**. No identity document, selfie, bank data, or proof of address is requested or stored.

## Required before a real launch

1. Choose an EU-appropriate identity-verification provider and execute a data-processing agreement (DPA).
2. Create a server-side account system using authenticated, HTTPS-only sessions; never use browser local storage for production credentials.
3. Keep a minimal data model, define retention/deletion periods, publish a privacy notice, and provide access/deletion requests under AVG/GDPR.
4. Store verification status and provider reference only; avoid storing documents unless legally necessary.
5. Add verified email, password reset, rate limits, audit logs, consent records, admin roles, and access controls.
6. For bulk messages, use only a separate opt-in mailing list, an unsubscribe link, and an auditable send log. Membership must not be treated as marketing consent.

Until these steps are complete, the UI must continue to describe the flow as a local member-preview and not an identity check.
