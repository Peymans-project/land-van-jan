import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

for (const name of [
  "APP_BASE_URL",
  "MONGODB_URI",
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_PUBLIC_DOMAIN",
  "SESSION_SECRET",
  "STRIPE_SECRET_KEY",
]) delete process.env[name];
process.env.NODE_ENV = "test";

const {
  claimStripeEvent,
  activitiesToIcal,
  createLandVanJanServer,
  decideAdminBootstrap,
  decryptStripeSecret,
  encryptStripeSecret,
  isSameOriginWrite,
  provisionStripeResources,
  readActivityFields,
  readDonationAmountCents,
  safeActivity,
  securityHeaders,
  stripeSubscriptionFields,
} = await import("../server.mjs");

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
let requestNumber = 0;

async function requestApp({ method = "GET", path = "/", body, headers = {} } = {}) {
  requestNumber += 1;
  const payload = body === undefined
    ? []
    : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const request = Readable.from(payload);
  request.method = method;
  request.url = path;
  request.headers = {
    host: "land.example.test",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(method === "GET" || method === "HEAD" ? {} : {
      origin: "http://land.example.test",
      "sec-fetch-site": "same-origin",
    }),
    ...headers,
  };
  request.socket = { encrypted: false, remoteAddress: `192.0.2.${requestNumber}` };

  const chunks = [];
  const response = {
    headers: {},
    headersSent: false,
    statusCode: 0,
    writeHead(statusCode, responseHeaders = {}) {
      this.statusCode = statusCode;
      this.headers = responseHeaders;
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      this.finished = true;
      return this;
    },
  };
  const server = createLandVanJanServer();
  const handler = server.listeners("request")[0];
  await handler(request, response);
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    status: response.statusCode,
    headers: response.headers,
    text,
    body: text ? JSON.parse(text) : null,
  };
}

function missingResource() {
  return Object.assign(new Error("missing"), { code: "resource_missing", statusCode: 404 });
}

function createFakeStripe() {
  const state = {
    products: [],
    prices: [],
    portalConfigurations: [],
    endpoints: [],
    webhookCreates: 0,
  };
  const find = (items, id) => items.find(item => item.id === id) || Promise.reject(missingResource());
  const client = {
    accounts: {
      retrieve: async () => ({ id: "acct_test_owner" }),
    },
    products: {
      retrieve: async id => find(state.products, id),
      list: async () => ({ data: [...state.products] }),
      create: async params => {
        const product = { id: `prod_${state.products.length + 1}`, active: true, ...params };
        state.products.push(product);
        return product;
      },
    },
    prices: {
      retrieve: async id => find(state.prices, id),
      list: async params => ({
        data: state.prices.filter(price => !params.lookup_keys || params.lookup_keys.includes(price.lookup_key)),
      }),
      create: async params => {
        const price = { id: `price_${state.prices.length + 1}`, ...params };
        state.prices.push(price);
        return price;
      },
    },
    billingPortal: {
      configurations: {
        retrieve: async id => find(state.portalConfigurations, id),
        list: async () => ({ data: [...state.portalConfigurations] }),
        create: async params => {
          const configuration = { id: `bpc_${state.portalConfigurations.length + 1}`, active: true, ...params };
          state.portalConfigurations.push(configuration);
          return configuration;
        },
        update: async (id, params) => {
          const existing = await find(state.portalConfigurations, id);
          Object.assign(existing, params);
          return existing;
        },
      },
    },
    webhookEndpoints: {
      retrieve: async id => find(state.endpoints, id),
      list: async () => ({ data: [...state.endpoints] }),
      create: async params => {
        state.webhookCreates += 1;
        const endpoint = {
          id: `we_${state.endpoints.length + 1}`,
          status: "enabled",
          secret: `whsec_unit_${state.endpoints.length + 1}`,
          api_version: params.api_version,
          ...params,
        };
        state.endpoints.push(endpoint);
        return endpoint;
      },
      update: async (id, params) => {
        const endpoint = await find(state.endpoints, id);
        Object.assign(endpoint, params, params.disabled === undefined ? {} : { status: params.disabled ? "disabled" : "enabled" });
        return endpoint;
      },
    },
  };
  return { client, state };
}

class FakeEventCollection {
  constructor() {
    this.documents = new Map();
  }

  async updateOne(filter, update) {
    const document = this.documents.get(filter.eventId);
    if (!document) return { modifiedCount: 0 };
    const now = filter.$or?.find(item => item.status === "processing" && item.leaseUntil?.$lte)?.leaseUntil.$lte;
    const retryable = document.status === "failed"
      || (document.status === "processing" && (!document.leaseUntil || (now && document.leaseUntil <= now)));
    if (!retryable) return { modifiedCount: 0 };
    Object.assign(document, update.$set || {});
    for (const [key, amount] of Object.entries(update.$inc || {})) document[key] = (document[key] || 0) + amount;
    for (const key of Object.keys(update.$unset || {})) delete document[key];
    return { modifiedCount: 1 };
  }

  async insertOne(document) {
    if (this.documents.has(document.eventId)) throw Object.assign(new Error("duplicate"), { code: 11000 });
    this.documents.set(document.eventId, { ...document });
    return { insertedId: document.eventId };
  }

  async findOne(filter) {
    return this.documents.get(filter.eventId) || null;
  }
}

test("liveness, readiness and setup status stay redacted and typed", async () => {
  const health = await requestApp({ path: "/api/health" });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {
    ok: true,
    authConfigured: false,
    billingKeyConfigured: false,
  });

  const readiness = await requestApp({ path: "/api/health/ready" });
  assert.equal(readiness.status, 503);
  assert.equal(readiness.body.error, "De serviceconfiguratie is nog niet gereed.");

  const setup = await requestApp({ path: "/api/setup/status" });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.auth, "not_configured");
  assert.equal(setup.body.adminBootstrap, "not_checked");
  assert.equal(typeof setup.body.billing, "string");
  assert.equal(setup.body.billing, "not_configured");
  assert.match(setup.body.privacyNoticeVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(setup.body.marketingConsentVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(setup.body).sort(), [
    "adminBootstrap",
    "auth",
    "billing",
    "marketingConsentVersion",
    "privacyNoticeVersion",
  ]);
  assert.doesNotMatch(setup.text, /(?:sk|rk)_(?:test|live)_|whsec_|ciphertext|stripeAccountId|webhookEndpointId/i);
});

test("contact and registration require the advertised privacy notice version", async () => {
  const setup = await requestApp({ path: "/api/setup/status" });
  const version = setup.body.privacyNoticeVersion;
  const contact = {
    name: "Privacy Test",
    email: "privacy-contact@example.test",
    subject: "Kennismaking",
    message: "Dit is een geldig testbericht voor de contracttest.",
    privacyAccepted: true,
  };
  const rejectedContact = await requestApp({ method: "POST", path: "/api/contact", body: contact });
  assert.equal(rejectedContact.status, 400);
  assert.match(rejectedContact.body.error, /actuele privacyverklaring/i);
  const currentContactVersion = await requestApp({
    method: "POST",
    path: "/api/contact",
    body: { ...contact, name: "", privacyNoticeVersion: version },
  });
  assert.equal(currentContactVersion.status, 400);
  assert.doesNotMatch(currentContactVersion.body.error, /actuele privacyverklaring/i);

  const registration = {
    name: "Nieuw Lid",
    email: "privacy-register@example.test",
    password: "een-veilig-wachtwoord-voor-de-test",
    privacyAccepted: true,
    marketingConsent: true,
    marketingConsentVersion: setup.body.marketingConsentVersion,
  };
  const rejectedRegistration = await requestApp({ method: "POST", path: "/api/auth/register", body: registration });
  assert.equal(rejectedRegistration.status, 400);
  assert.match(rejectedRegistration.body.error, /actuele privacyverklaring/i);
  const currentRegistrationVersion = await requestApp({
    method: "POST",
    path: "/api/auth/register",
    body: { ...registration, password: "te-kort", privacyNoticeVersion: version },
  });
  assert.equal(currentRegistrationVersion.status, 400);
  assert.doesNotMatch(currentRegistrationVersion.body.error, /actuele privacyverklaring/i);
});

test("marketing opt-in stays bound to the advertised consent version", () => {
  assert.match(
    serverSource,
    /body\.marketingConsent === true && body\.marketingConsentVersion === MARKETING_CONSENT_VERSION/,
  );
  assert.match(
    serverSource,
    /body\.marketingConsent && body\.marketingConsentVersion !== MARKETING_CONSENT_VERSION/,
  );
});

test("account deletion confirms identity and commits local erasure before Stripe cleanup", () => {
  const routeStart = serverSource.indexOf('if ((pathname === "/api/member/profile" || pathname === "/api/member/account") && method === "DELETE") {');
  const routeEnd = serverSource.indexOf('if (pathname === "/api/billing/checkout" && method === "POST") {', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "account deletion route contract must remain present");
  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /body\.confirmation !== "VERWIJDER"/);
  assert.match(route, /typeof body\.password !== "string"/);
  assert.match(route, /comparePassword\(body\.password, user\.passwordHash\)/);
  assert.match(route, /listCustomerSubscriptions/);
  assert.match(route, /subscriptionCanBeDeletedSafely/);
  assert.match(route, /sole admin|Draag eerst het beheer over/);
  assert.match(route, /member_mutation:/);
  assert.match(route, /admin_account_delete/);
  assert.match(route, /deletionState: "processing"/);
  assert.doesNotMatch(route, /customers\.del/);

  const transactionAt = route.indexOf("await withTransaction");
  const jobInsertAt = route.indexOf('collection("privacy_deletion_jobs").insertOne');
  const cleanupAt = route.indexOf("completePrivacyDeletionJob");
  assert.ok(transactionAt > route.indexOf("listCustomerSubscriptions"));
  assert.ok(jobInsertAt > transactionAt);
  assert.ok(cleanupAt > jobInsertAt);
  assert.ok(serverSource.indexOf("sweepPrivacyDeletionJobs().catch") > serverSource.indexOf("async function sweepPrivacyDeletionJobs"));
});

test("startup requires transactional MongoDB and exhausts bounded retention batches", () => {
  assert.match(serverSource, /await verifyTransactionSupport\(database\)/);
  const probeStart = serverSource.indexOf("async function verifyTransactionSupport");
  const probeEnd = serverSource.indexOf("async function db()", probeStart);
  const probe = serverSource.slice(probeStart, probeEnd);
  assert.match(probe, /session\.withTransaction/);
  assert.match(probe, /readConcern: \{ level: "snapshot" \}/);

  const backfillStart = serverSource.indexOf("async function backfillRegistrationRetention");
  const backfillEnd = serverSource.indexOf("async function verifyTransactionSupport", backfillStart);
  const backfill = serverSource.slice(backfillStart, backfillEnd);
  assert.match(backfill, /while \(true\)/);
  assert.match(backfill, /\.limit\(1000\)/);
});

test("Railway rate limiting and Stripe setup waiters bind to trusted deployment state", () => {
  const ipStart = serverSource.indexOf("function requestIp");
  const ipEnd = serverSource.indexOf("function allowRate", ipStart);
  const ipSource = serverSource.slice(ipStart, ipEnd);
  assert.ok(ipSource.indexOf('request.headers["x-real-ip"]') >= 0);
  assert.ok(ipSource.indexOf('request.headers["x-real-ip"]') < ipSource.indexOf('request.headers["x-forwarded-for"]'));

  const waiterStart = serverSource.indexOf("async function waitForStripeSetup");
  const waiterEnd = serverSource.indexOf("async function ensureStripeConfiguration", waiterStart);
  const waiter = serverSource.slice(waiterStart, waiterEnd);
  assert.match(waiter, /current\.stripeAccountId === expectedAccountId/);
  assert.match(waiter, /Boolean\(current\.livemode\) === expectedLivemode/);
});

test("admin bootstrap never grants admin during registration logic", () => {
  assert.deepEqual(decideAdminBootstrap({ configuredEmails: [], adminCount: 0, matchingUsers: [] }), { state: "not_configured" });
  assert.deepEqual(
    decideAdminBootstrap({ configuredEmails: ["owner@example.test"], adminCount: 0, matchingUsers: [] }),
    { state: "awaiting_existing_account" },
  );
  const existing = { _id: "existing-user", email: "owner@example.test" };
  assert.deepEqual(
    decideAdminBootstrap({ configuredEmails: ["owner@example.test"], adminCount: 0, matchingUsers: [existing] }),
    { state: "promote", userId: "existing-user" },
  );
  assert.deepEqual(
    decideAdminBootstrap({ configuredEmails: ["one@example.test", "two@example.test"], adminCount: 0, matchingUsers: [] }),
    { state: "conflict" },
  );
});

test("admin transfer requires re-authentication and promotes only an existing member transactionally", () => {
  const routeStart = serverSource.indexOf('if (pathname === "/api/admin/transfer" && method === "POST") {');
  const routeEnd = serverSource.indexOf('if (pathname === "/api/admin/contact-messages" && method === "GET") {', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "admin transfer route contract must remain present");
  const route = serverSource.slice(routeStart, routeEnd);

  assert.match(route, /const admin = await requireAdmin\(request\)/);
  assert.match(route, /allowRate\(request, "admin-transfer", 6, 60 \* 60 \* 1000\)/);
  assert.match(route, /body\.confirmation !== "BEHEER OVERDRAGEN"/);
  assert.match(route, /comparePassword\(body\.password, admin\.passwordHash\)/);
  assert.match(route, /targetEmail === admin\.email/);
  assert.match(route, /acquireServiceLease\(database, "admin_role_change"/);
  assert.match(route, /await withTransaction\(async session/);
  assert.match(route, /_id: admin\._id, role: "admin", deletionState: \{ \$exists: false \}/);
  assert.match(route, /email: targetEmail, deletionState: \{ \$exists: false \}/);
  assert.match(route, /role: \{ \$ne: "admin" \}, deletionState: \{ \$exists: false \}/);
  assert.match(route, /adminPromotionSource: "admin-transfer"/);
  assert.match(route, /writeAudit\(database, "admin\.transfer\.promoted"/);
  assert.match(route, /return sendJson\(response, 200, \{ member: safeUser\(promotedUser\) \}\)/);
  assert.match(route, /deleteOne\(\{ _id: "admin_role_change", owner: lease\.owner, fence: lease\.fence \}\)/);
  assert.doesNotMatch(route, /\$set:\s*\{\s*role:\s*"member"/);
});

test("paused memberships stay on the existing-subscription portal path", () => {
  const portalSet = appSource.match(/const PORTAL_MEMBERSHIP_STATUSES = new Set\(\[([^\]]+)]\);/)?.[1] || "";
  assert.match(portalSet, /['"]paused['"]/);
  assert.match(appSource, /paused:\s*['"]Gepauzeerd['"]/);

  const checkoutStart = serverSource.indexOf('if (pathname === "/api/billing/checkout" && method === "POST") {');
  const checkoutEnd = serverSource.indexOf('if (pathname === "/api/billing/portal" && method === "POST") {', checkoutStart);
  const checkoutRoute = serverSource.slice(checkoutStart, checkoutEnd);
  assert.ok(checkoutStart >= 0 && checkoutEnd > checkoutStart, "checkout route contract must remain present");
  assert.match(checkoutRoute, /\["active", "trialing", "past_due", "unpaid", "incomplete", "paused"\]/);
});

test("activity input accepts the current admin form safely", () => {
  const fields = readActivityFields({
    title: "Oogstdag",
    description: "Samen oogsten op het land.",
    startsAt: "2026-08-02T10:00",
    capacity: 12,
    published: true,
  });
  assert.equal(fields.status, "published");
  assert.equal(fields.location, "Land van Jan, Huissen");
  assert.equal(fields.startsAt.toISOString(), "2026-08-02T08:00:00.000Z");
  assert.equal(fields.endsAt.toISOString(), "2026-08-02T10:00:00.000Z");

  const safe = safeActivity({ _id: "activity-1", registeredCount: 0, createdAt: new Date(), updatedAt: new Date(), ...fields });
  assert.equal(safe.published, true);
  assert.equal(safe.time, "10:00 – 12:00");
  assert.equal(safe.text, fields.description);
  assert.equal(safe.accentColor, "green");
  assert.equal(safe.textAlign, "left");
  assert.throws(() => readActivityFields({ ...fields, startsAt: "2026-08-02T10:00", endsAt: "2026-08-02T12:00", imageUrl: "javascript:alert(1)" }), error => error.statusCode === 400);
});

test("public calendar emits safe subscription events", () => {
  const calendar = activitiesToIcal([{ _id: "activity-1", title: "Oogst, soep & muziek", description: "Samen; buiten", location: "Huissen", startsAt: new Date("2026-08-02T08:00:00Z"), endsAt: new Date("2026-08-02T10:00:00Z"), updatedAt: new Date("2026-08-01T10:00:00Z") }]);
  assert.match(calendar, /BEGIN:VCALENDAR\r\n/);
  assert.match(calendar, /SUMMARY:Oogst\\, soep & muziek/);
  assert.match(calendar, /DESCRIPTION:Samen\\; buiten/);
  assert.match(calendar, /URL:https:\/\/landvanjan\.com\/agenda/);
});

test("webhook signing secrets are authenticated-encrypted with a stable server secret", () => {
  const encryptionSecret = "stable-session-secret-for-unit-tests";
  const encrypted = encryptStripeSecret("unit-signing-secret", encryptionSecret, "unit-aad");
  assert.equal(JSON.stringify(encrypted).includes("unit-signing-secret"), false);
  assert.equal(decryptStripeSecret(encrypted, encryptionSecret, "unit-aad"), "unit-signing-secret");
  assert.throws(() => decryptStripeSecret(encrypted, "rotated-session-secret", "unit-aad"));
  assert.throws(() => decryptStripeSecret(encrypted, encryptionSecret, "wrong-aad"));
});

test("donation amounts accept only whole euro cents within the public limits", () => {
  assert.equal(readDonationAmountCents(100), 100);
  assert.equal(readDonationAmountCents(2500), 2500);
  assert.equal(readDonationAmountCents(500_000), 500_000);
  for (const invalid of [99, 500_001, 12.5, "2500", NaN, Infinity, null]) {
    assert.throws(() => readDonationAmountCents(invalid), error => error.statusCode === 400);
  }
});

test("Stripe setup creates exactly €5 monthly resources and is reusable", async () => {
  const { client, state } = createFakeStripe();
  const encryptionSecret = "stable-session-secret-for-unit-tests";
  const first = await provisionStripeResources({
    client,
    baseUrl: "https://land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret,
    generation: "first",
  });
  assert.equal(state.products.length, 2);
  assert.equal(state.prices.length, 1);
  assert.equal(state.prices[0].currency, "eur");
  assert.equal(state.prices[0].unit_amount, 500);
  assert.equal(state.prices[0].recurring.interval, "month");
  assert.equal(state.webhookCreates, 1);
  assert.equal(first.config.webhookUrl, "https://land.example.test/api/stripe/webhook");
  assert.ok(first.config.donationProductId);

  const second = await provisionStripeResources({
    client,
    currentConfig: first.config,
    baseUrl: "https://land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret,
    generation: "second",
  });
  assert.equal(state.products.length, 2);
  assert.equal(state.prices.length, 1);
  assert.equal(state.webhookCreates, 1);
  assert.equal(second.config.webhookEndpointId, first.config.webhookEndpointId);
});

test("distinct public URLs do not obsolete each other's scoped Stripe endpoints", async () => {
  const { client, state } = createFakeStripe();
  const encryptionSecret = "stable-session-secret-for-unit-tests";
  const first = await provisionStripeResources({
    client,
    baseUrl: "https://one.land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret,
    generation: "one",
  });
  const second = await provisionStripeResources({
    client,
    baseUrl: "https://two.land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret,
    generation: "two",
  });
  assert.equal(state.products.length, 2);
  assert.equal(state.prices.length, 1);
  assert.equal(state.portalConfigurations.length, 2);
  assert.equal(state.webhookCreates, 2);
  assert.deepEqual(first.obsoleteEndpointIds, []);
  assert.deepEqual(second.obsoleteEndpointIds, []);
  assert.equal(state.endpoints.every(endpoint => endpoint.status === "enabled"), true);
});

test("Stripe API key rotation reuses the endpoint when encryption stays stable", async () => {
  const { client, state } = createFakeStripe();
  const encryptionSecret = "stable-session-secret-for-unit-tests";
  const first = await provisionStripeResources({
    client,
    baseUrl: "https://land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret,
    generation: "first",
  });
  const rotated = await provisionStripeResources({
    client,
    currentConfig: first.config,
    baseUrl: "https://land.example.test",
    secretKey: "sk_test_unit_key_two",
    encryptionSecret,
    generation: "rotated",
  });
  assert.equal(state.webhookCreates, 1);
  assert.equal(rotated.config.webhookEndpointId, first.config.webhookEndpointId);
  assert.deepEqual(rotated.obsoleteEndpointIds, []);
  const aad = `stripe_membership_v1:acct_test_owner:test`;
  assert.equal(decryptStripeSecret(rotated.config.webhookSigningSecret, encryptionSecret, aad), "whsec_unit_1");
  assert.throws(() => decryptStripeSecret(rotated.config.webhookSigningSecret, "sk_test_unit_key_two", aad));
});

test("encryption-secret rotation creates a recoverable replacement endpoint", async () => {
  const { client, state } = createFakeStripe();
  const first = await provisionStripeResources({
    client,
    baseUrl: "https://land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret: "old-session-secret-for-unit-tests",
    generation: "first",
  });
  const rotated = await provisionStripeResources({
    client,
    currentConfig: first.config,
    baseUrl: "https://land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret: "new-session-secret-for-unit-tests",
    generation: "rotated",
  });
  assert.equal(state.webhookCreates, 2);
  assert.notEqual(rotated.config.webhookEndpointId, first.config.webhookEndpointId);
  assert.deepEqual(rotated.obsoleteEndpointIds, [first.config.webhookEndpointId]);
  const aad = `stripe_membership_v1:acct_test_owner:test`;
  assert.equal(decryptStripeSecret(rotated.config.webhookSigningSecret, "new-session-secret-for-unit-tests", aad), "whsec_unit_2");
});

test("a decryptable webhook replacement retains a bounded previous-secret grace", async () => {
  const { client, state } = createFakeStripe();
  const encryptionSecret = "stable-session-secret-for-unit-tests";
  const first = await provisionStripeResources({
    client,
    baseUrl: "https://land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret,
    generation: "first",
  });
  state.endpoints[0].api_version = "2025-01-01.acacia";
  const replaced = await provisionStripeResources({
    client,
    currentConfig: first.config,
    baseUrl: "https://land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret,
    generation: "replacement",
  });
  assert.equal(state.webhookCreates, 2);
  assert.deepEqual(replaced.obsoleteEndpointIds, [first.config.webhookEndpointId]);
  assert.deepEqual(replaced.config.previousWebhookSigningSecret, first.config.webhookSigningSecret);
  assert.ok(replaced.config.previousWebhookValidUntil instanceof Date);
  const aad = "stripe_membership_v1:acct_test_owner:test";
  assert.equal(decryptStripeSecret(replaced.config.previousWebhookSigningSecret, encryptionSecret, aad), "whsec_unit_1");

  const reused = await provisionStripeResources({
    client,
    currentConfig: replaced.config,
    baseUrl: "https://land.example.test",
    secretKey: "sk_test_unit_key_one",
    encryptionSecret,
    generation: "reuse",
  });
  assert.equal(state.webhookCreates, 2);
  assert.deepEqual(reused.config.previousWebhookSigningSecret, replaced.config.previousWebhookSigningSecret);
  assert.equal(reused.config.previousWebhookValidUntil.getTime(), replaced.config.previousWebhookValidUntil.getTime());
});

test("Checkout completion validates resource, workflow and price before membership writes", () => {
  const processStart = serverSource.indexOf("async function processStripeEvent");
  const processEnd = serverSource.indexOf("export async function claimStripeEvent", processStart);
  const processSource = serverSource.slice(processStart, processEnd);
  const resourceAt = processSource.indexOf("STRIPE_RESOURCE_MARKER");
  const workflowAt = processSource.indexOf("pendingCheckoutWorkflowId: workflowId");
  const priceAt = processSource.indexOf("subscriptionHasConfiguredPrice");
  const canonicalWriteAt = processSource.indexOf("applyCanonicalSubscription");
  assert.ok(resourceAt >= 0);
  assert.ok(workflowAt > resourceAt);
  assert.ok(priceAt > workflowAt);
  assert.ok(canonicalWriteAt > priceAt);
});

test("public donations use one-time Stripe Checkout with a server-owned product", () => {
  const start = serverSource.indexOf('pathname === "/api/billing/donation-checkout"');
  const end = serverSource.indexOf('pathname === "/api/billing/checkout"', start);
  const donationSource = serverSource.slice(start, end);
  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(donationSource, /readDonationAmountCents\(body\.amountCents\)/);
  assert.match(donationSource, /mode: "payment"/);
  assert.match(donationSource, /submit_type: "donate"/);
  assert.match(donationSource, /product: stripeConfig\.donationProductId/);
  assert.match(donationSource, /customer_creation: "always"/);
  assert.match(donationSource, /branding_settings: STRIPE_CHECKOUT_BRANDING/);
  assert.doesNotMatch(donationSource, /requireUser/);
  assert.doesNotMatch(donationSource, /mode: "subscription"/);
});

test("all Checkout flows override unrelated account branding with Land van Jan", () => {
  assert.match(serverSource, /display_name: "Land van Jan"/);
  assert.match(serverSource, /background_color: "#f5f0e8"/);
  assert.match(serverSource, /button_color: "#a84824"/);
  assert.equal((serverSource.match(/branding_settings: STRIPE_CHECKOUT_BRANDING/g) || []).length, 2);
});

test("subscription period end follows Clover item-level periods", () => {
  const fields = stripeSubscriptionFields({
    id: "sub_unit",
    customer: "cus_unit",
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ current_period_end: 1_800_000_000 }] },
  }, { stripeAccountId: "acct_unit" });
  assert.equal(fields.membershipCurrentPeriodEnd.toISOString(), new Date(1_800_000_000 * 1000).toISOString());
});

test("failed and stale Stripe events can be claimed again", async () => {
  const collection = new FakeEventCollection();
  const event = { id: "evt_unit", type: "customer.subscription.updated", data: { object: { id: "sub_unit" } } };
  const first = await claimStripeEvent(collection, event, new Date("2026-08-02T10:00:00Z"));
  assert.equal(first.state, "claimed");
  assert.equal(first.fence, 1);
  assert.equal(typeof first.owner, "string");
  collection.documents.get(event.id).status = "failed";
  const reclaimed = await claimStripeEvent(collection, event, new Date("2026-08-02T10:01:00Z"));
  assert.equal(reclaimed.state, "claimed");
  assert.equal(reclaimed.fence, 2);
  assert.notEqual(reclaimed.owner, first.owner);
  assert.equal(collection.documents.get(event.id).attempts, 2);
  collection.documents.get(event.id).status = "processed";
  assert.deepEqual(await claimStripeEvent(collection, event, new Date("2026-08-02T10:02:00Z")), { state: "processed" });

  const handlerStart = serverSource.indexOf("async function handleStripeWebhook");
  const handlerEnd = serverSource.indexOf("function safeContactMessage", handlerStart);
  const handler = serverSource.slice(handlerStart, handlerEnd);
  assert.equal((handler.match(/owner: claim\.owner, fence: claim\.fence/g) || []).length, 2);
});

test("unsafe same-site and cross-site writes are rejected", () => {
  const baseRequest = {
    method: "POST",
    headers: {
      host: "land.example.test",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "land.example.test",
      origin: "https://land.example.test",
      "sec-fetch-site": "same-origin",
    },
    socket: {},
  };
  assert.equal(isSameOriginWrite(baseRequest), true);
  assert.equal(isSameOriginWrite({ ...baseRequest, headers: { ...baseRequest.headers, "sec-fetch-site": "same-site" } }), false);
  assert.equal(isSameOriginWrite({ ...baseRequest, headers: { ...baseRequest.headers, origin: "https://evil.example.test" } }), false);
});

test("responses carry security headers", () => {
  const headers = securityHeaders();
  assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(headers["X-Frame-Options"], "DENY");
});

test("Google login uses a server-side authorization-code flow and only links existing accounts", () => {
  assert.match(serverSource, /\/api\/auth\/google\/start/);
  assert.match(serverSource, /response_type:\s*"code"/);
  assert.match(serverSource, /scope:\s*"openid email profile"/);
  assert.match(serverSource, /lvj_google_oauth=.*HttpOnly; SameSite=Lax/);
  assert.match(serverSource, /oauth2\.googleapis\.com\/tokeninfo/);
  assert.match(serverSource, /identity\.aud !== googleClientId/);
  assert.match(serverSource, /tokenPayload\.nonce !== statePayload\.nonce/);
  assert.match(serverSource, /if \(!user\) return redirect\(response, `\$\{baseUrl\}\/leden\?google=maak-account`/);
});
