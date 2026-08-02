import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  createCipheriv,
  createHash,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const scrypt = promisify(scryptCallback);
const root = join(process.cwd(), "dist", "client");
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_ENVIRONMENT);
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const MAX_JSON_BYTES = 16 * 1024;
const PRIVACY_NOTICE_VERSION = "2026-08-02";
const MARKETING_CONSENT_VERSION = "2026-08-02";
const REGISTRATION_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVITY_LOCATION = "Land van Jan, Huissen";
const STRIPE_API_VERSION = "2026-02-25.clover";
const STRIPE_CONFIG_ID = "stripe_membership_v1";
const STRIPE_RESOURCE_MARKER = "land_van_jan_membership_v1";
const STRIPE_DONATION_RESOURCE_MARKER = "land_van_jan_donation_v1";
const STRIPE_PRICE_LOOKUP_KEY = "land_van_jan_membership_eur_monthly_v1";
const STRIPE_PRICE_CENTS = 500;
const DONATION_MIN_CENTS = 100;
const DONATION_MAX_CENTS = 500_000;
const STRIPE_CHECKOUT_BRANDING = {
  display_name: "Land van Jan",
  background_color: "#f5f0e8",
  button_color: "#a84824",
  border_style: "rectangular",
};
const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || "land_van_jan";
const sessionSecret = process.env.SESSION_SECRET || "";
const adminEmails = new Set((process.env.ADMIN_EMAILS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const configuredAppBaseUrl = normalizeBaseUrl(process.env.APP_BASE_URL || "");
const railwayPublicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
const PUBLIC_ROUTES = new Set(["/", "/over-het-land", "/agenda", "/verhalen", "/contact", "/lid-worden", "/privacy", "/leden", "/beheer", "/404"]);
const mime = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".mp4": "video/mp4", ".png": "image/png",
    ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".webp": "image/webp", ".xml": "application/xml; charset=utf-8",
};

let mongoClient;
let database;
let databasePromise;
let stripeClient;
let adminBootstrapState = "not_checked";
let privacyDeletionSweepPromise;
let billingSetupRuntimeState = "pending";
const rateWindows = new Map();
const stripeSetupPromises = new Map();

function apiConfigError() {
  if (!mongoUri) return "MONGODB_URI ontbreekt.";
  if (sessionSecret.length < 32 || /(replace|example|changeme|password|secret)/i.test(sessionSecret)) {
    return "SESSION_SECRET moet een willekeurige, unieke waarde van minimaal 32 tekens zijn.";
  }
  return null;
}

function billingConfigError() {
  if (!stripeSecretKey) return "STRIPE_SECRET_KEY ontbreekt.";
  if (!/^(?:sk|rk)_(?:test|live)_/.test(stripeSecretKey)) return "STRIPE_SECRET_KEY heeft geen ondersteund formaat.";
  return null;
}

export function readDonationAmountCents(value) {
  if (!Number.isSafeInteger(value) || value < DONATION_MIN_CENTS || value > DONATION_MAX_CENTS) {
    const error = new Error("Kies een donatiebedrag tussen €1 en €5.000.");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function stripe() {
  const error = billingConfigError();
  if (error) { const configurationError = new Error("Betalingen zijn nog niet geconfigureerd."); configurationError.statusCode = 503; throw configurationError; }
  return stripeClient ||= new Stripe(stripeSecretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 15_000 });
}

export function decideAdminBootstrap({ configuredEmails, adminCount, matchingUsers }) {
  if (!configuredEmails.length) return { state: "not_configured" };
  if (adminCount > 0) return { state: "ready" };
  if (configuredEmails.length !== 1) return { state: "conflict" };
  const match = matchingUsers.find(user => user.email === configuredEmails[0]);
  return match ? { state: "promote", userId: match._id } : { state: "awaiting_existing_account" };
}

async function writeAudit(databaseHandle, action, details = {}, options = {}) {
  await databaseHandle.collection("audit_events").insertOne({
    action,
    actorId: details.actorId || null,
    subjectId: details.subjectId || null,
    createdAt: new Date(),
  }, options);
}

async function reconcileBootstrapAdmin(databaseHandle) {
  const configuredEmails = [...adminEmails];
  const adminCount = await databaseHandle.collection("users").countDocuments({ role: "admin" }, { limit: 1 });
  const matchingUsers = configuredEmails.length === 1
    ? await databaseHandle.collection("users").find({ email: { $in: configuredEmails } }).project({ email: 1 }).toArray()
    : [];
  const decision = decideAdminBootstrap({ configuredEmails, adminCount, matchingUsers });
  adminBootstrapState = decision.state;
  if (decision.state !== "promote") return;
  const promoted = await databaseHandle.collection("users").updateOne(
    { _id: decision.userId, role: { $ne: "admin" } },
    { $set: { role: "admin", adminPromotedAt: new Date(), adminPromotionSource: "startup-bootstrap" } },
  );
  if (promoted.modifiedCount) {
    await writeAudit(databaseHandle, "admin.bootstrap.promoted", { subjectId: decision.userId });
    adminBootstrapState = "ready";
  } else {
    adminBootstrapState = "conflict";
  }
}

async function connectDatabase() {
  const configError = apiConfigError();
  if (configError) {
    const error = new Error("Authentication service is not configured.");
    error.statusCode = 503;
    throw error;
  }
  mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10, retryWrites: true });
  await mongoClient.connect();
  database = mongoClient.db(databaseName);
  await Promise.all([
    database.collection("users").createIndex({ email: 1 }, { unique: true }),
    database.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection("sessions").createIndex({ userId: 1 }),
    database.collection("activities").createIndex({ status: 1, startsAt: 1 }),
    database.collection("registrations").createIndex({ activityId: 1, userId: 1 }, { unique: true }),
    database.collection("registrations").createIndex({ userId: 1, createdAt: -1 }),
    database.collection("registrations").createIndex({ retentionAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection("stripe_events").createIndex({ eventId: 1 }, { unique: true }),
    database.collection("stripe_events").createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
    database.collection("users").createIndex({ stripeCustomerId: 1 }, { sparse: true }),
    database.collection("users").createIndex({ stripeSubscriptionId: 1 }, { sparse: true }),
    database.collection("users").createIndex(
      { stripeAccountId: 1, stripeCustomerId: 1 },
      { unique: true, name: "stripe_account_customer_unique", partialFilterExpression: { stripeAccountId: { $type: "string" }, stripeCustomerId: { $type: "string" } } },
    ),
    database.collection("users").createIndex(
      { stripeAccountId: 1, stripeSubscriptionId: 1 },
      { unique: true, name: "stripe_account_subscription_unique", partialFilterExpression: { stripeAccountId: { $type: "string" }, stripeSubscriptionId: { $type: "string" } } },
    ),
    database.collection("consent_events").createIndex({ userId: 1, createdAt: -1 }),
    database.collection("contact_messages").createIndex({ status: 1, createdAt: -1 }),
    database.collection("contact_messages").createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 }),
    database.collection("audit_events").createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 400 }),
    database.collection("service_locks").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection("privacy_deletion_jobs").createIndex({ status: 1, nextAttemptAt: 1 }),
    database.collection("privacy_deletion_jobs").createIndex({ retentionUntil: 1 }, { expireAfterSeconds: 0 }),
    database.collection("privacy_deletion_jobs").createIndex(
      { stripeAccountId: 1, stripeCustomerId: 1 },
      { unique: true, partialFilterExpression: { stripeAccountId: { $type: "string" }, stripeCustomerId: { $type: "string" } } },
    ),
  ]);
  await verifyTransactionSupport(database);
  await backfillRegistrationRetention(database);
  await reconcileBootstrapAdmin(database);
  return database;
}

async function backfillRegistrationRetention(databaseHandle) {
  while (true) {
    const registrations = await databaseHandle.collection("registrations")
      .find({ retentionAt: { $exists: false } })
      .project({ activityId: 1, createdAt: 1 })
      .limit(1000)
      .toArray();
    if (!registrations.length) return;
    const activityIds = [...new Map(registrations.map(item => [item.activityId.toString(), item.activityId])).values()];
    const activities = await databaseHandle.collection("activities")
      .find({ _id: { $in: activityIds } })
      .project({ endsAt: 1 })
      .toArray();
    const endsAtById = new Map(activities.map(item => [item._id.toString(), item.endsAt]));
    await databaseHandle.collection("registrations").bulkWrite(registrations.map(registration => {
      const baseDate = endsAtById.get(registration.activityId.toString()) || registration.createdAt || new Date();
      return {
        updateOne: {
          filter: { _id: registration._id, retentionAt: { $exists: false } },
          update: { $set: { retentionAt: new Date(new Date(baseDate).getTime() + REGISTRATION_RETENTION_MS) } },
        },
      };
    }), { ordered: false });
  }
}

async function verifyTransactionSupport(databaseHandle) {
  if (!mongoClient) throw Object.assign(new Error("Databaseverbinding ontbreekt."), { statusCode: 503 });
  const session = mongoClient.startSession();
  try {
    await session.withTransaction(
      () => databaseHandle.collection("service_config").findOne({ _id: "transaction_support_probe" }, { session, projection: { _id: 1 } }),
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    );
  } finally {
    await session.endSession();
  }
}

async function db() {
  if (!databasePromise) {
    databasePromise = connectDatabase().catch(async error => {
      databasePromise = undefined;
      database = undefined;
      await mongoClient?.close().catch(() => {});
      mongoClient = undefined;
      throw error;
    });
  }
  return databasePromise;
}

function base64url(value) { return Buffer.from(value).toString("base64url"); }
function unbase64url(value) { return Buffer.from(value, "base64url").toString("utf8"); }
function sign(value) { return createHmac("sha256", sessionSecret).update(value).digest("base64url"); }
function makeToken(payload) {
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  const expected = sign(encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(unbase64url(encoded));
    return payload.exp > Math.floor(Date.now() / 1000) && payload.sub && payload.sid ? payload : null;
  } catch { return null; }
}

function cookies(request) {
  try {
    return Object.fromEntries((request.headers.cookie || "").split(";").map(part => part.trim().split(/=(.*)/s)).filter(([key]) => key).map(([key, value]) => [key, decodeURIComponent(value || "")]));
  } catch {
    return {};
  }
}
function sessionCookie(token, seconds = SESSION_TTL_SECONDS) {
  return `lvj_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}; Priority=High${isProduction ? "; Secure" : ""}`;
}
function clearSessionCookie() { return sessionCookie("", 0); }
export function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...(isProduction ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}
function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { ...securityHeaders(), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}
function sendApiError(response, status, message) { sendJson(response, status, { error: message }); }
export function safeUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt),
    marketingConsent: Boolean(user.marketingConsent),
    marketingConsentUpdatedAt: user.marketingConsentUpdatedAt || null,
    membershipStatus: user.membershipStatus || "inactive",
    membershipCurrentPeriodEnd: user.membershipCurrentPeriodEnd || null,
    membershipCancelAtPeriodEnd: Boolean(user.membershipCancelAtPeriodEnd),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

function requestIp(request) {
  const realIp = request.headers["x-real-ip"];
  if ((isProduction || process.env.TRUST_PROXY === "1") && realIp) {
    const value = String(realIp).split(",")[0].trim();
    if (value) return value;
  }
  const forwarded = request.headers["x-forwarded-for"];
  if ((isProduction || process.env.TRUST_PROXY === "1") && forwarded) {
    const values = forwarded.toString().split(",").map(value => value.trim()).filter(Boolean);
    if (values.length) return values[0];
  }
  return request.socket.remoteAddress || "unknown";
}
function allowRate(request, action, limit, windowMs = 15 * 60 * 1000) {
  const key = `${action}:${requestIp(request)}`;
  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || current.resetAt <= now) { rateWindows.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  if (current.count >= limit) return false;
  current.count += 1; return true;
}
function allowAccountRate(action, value, limit, windowMs = 15 * 60 * 1000) {
  const digest = createHmac("sha256", sessionSecret || "unconfigured").update(String(value)).digest("base64url");
  const key = `${action}:${digest}`;
  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || current.resetAt <= now) { rateWindows.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}
function cleanRateWindows() {
  const now = Date.now();
  for (const [key, value] of rateWindows) if (value.resetAt <= now) rateWindows.delete(key);
}
setInterval(cleanRateWindows, 60 * 1000).unref();

export function normalizeBaseUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    if (isProduction && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function forwardedHeader(request, name) {
  const value = request.headers[name];
  return value ? String(value).split(",")[0].trim() : "";
}

export function requestBaseUrl(request) {
  const forwardedProto = forwardedHeader(request, "x-forwarded-proto");
  const protocol = forwardedProto || (request.socket.encrypted ? "https" : "http");
  const host = forwardedHeader(request, "x-forwarded-host") || String(request.headers.host || "");
  if (!["http", "https"].includes(protocol) || !host || /[\s/@]/.test(host)) return "";
  return normalizeBaseUrl(`${protocol}://${host}`);
}

function canonicalBaseUrl(request) {
  if (configuredAppBaseUrl) return configuredAppBaseUrl;
  if (railwayPublicDomain && !/[\s/@/]/.test(railwayPublicDomain)) return normalizeBaseUrl(`https://${railwayPublicDomain}`);
  return request && !isProduction ? requestBaseUrl(request) : "";
}

export function isSameOriginWrite(request) {
  const method = request.method || "GET";
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") return false;
  const suppliedOrigin = String(request.headers.origin || "");
  if (!suppliedOrigin) return !isProduction;
  const expectedOrigin = requestBaseUrl(request);
  return Boolean(expectedOrigin) && normalizeBaseUrl(suppliedOrigin) === expectedOrigin;
}

function enforceSameOriginWrite(request) {
  if (isSameOriginWrite(request)) return;
  const error = new Error("De aanvraag kwam niet van de eigen site.");
  error.statusCode = 403;
  throw error;
}

function readJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type moet application/json zijn.");
    error.statusCode = 415;
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES && !tooLarge) {
        tooLarge = true;
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        reject(error);
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { const error = new Error("Ongeldige JSON."); error.statusCode = 400; reject(error); }
    });
    request.on("error", reject);
  });
}
function readRawBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let tooLarge = false;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes && !tooLarge) {
        tooLarge = true;
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        reject(error);
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    request.on("error", reject);
  });
}
function validEmail(value) { return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254; }
function validName(value) { return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 80; }
function validPassword(value) { return typeof value === "string" && value.length >= 12 && value.length <= 128; }
async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString("base64url")}`;
}
async function comparePassword(password, encoded) {
  const [algorithm, salt, expected] = String(encoded).split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const expectedBuffer = Buffer.from(expected, "base64url");
  return expectedBuffer.length === derived.length && timingSafeEqual(expectedBuffer, derived);
}
let dummyPasswordHashPromise;
function dummyPasswordHash() {
  return dummyPasswordHashPromise ||= hashPassword(randomBytes(32).toString("base64url"));
}
async function createSession(database, user, options = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  const sid = randomUUID();
  await database.collection("sessions").insertOne({ sid, userId: user._id, createdAt: now, expiresAt }, options);
  return makeToken({ sub: user._id.toString(), sid, exp: Math.floor(expiresAt.getTime() / 1000) });
}
async function currentUser(request) {
  const payload = verifyToken(cookies(request).lvj_session);
  const userId = payload ? parseId(payload.sub) : null;
  if (!payload || !userId) return null;
  const database = await db();
  const session = await database.collection("sessions").findOne({ sid: payload.sid, userId, expiresAt: { $gt: new Date() } });
  if (!session) return null;
  return database.collection("users").findOne({ _id: userId, deletionState: { $exists: false } });
}

function parseId(value) { return ObjectId.isValid(value) ? new ObjectId(value) : null; }
function amsterdamDateParts(date) {
  const formatter = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function parseActivityDate(value) {
  if (value instanceof Date) return new Date(value);
  const text = String(value || "").trim();
  const localMatch = text.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/);
  if (localMatch && !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(text)) {
    const [, year, month, day, hour, minute, second = "0"] = localMatch;
    const desiredUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    let result = new Date(desiredUtc);
    result = new Date(desiredUtc - timeZoneOffsetMs(result, "Europe/Amsterdam"));
    result = new Date(desiredUtc - timeZoneOffsetMs(result, "Europe/Amsterdam"));
    return result;
  }
  return new Date(text);
}

export function safeActivity(activity) {
  const startParts = activity.startsAt instanceof Date && !Number.isNaN(activity.startsAt.getTime()) ? amsterdamDateParts(activity.startsAt) : {};
  const endParts = activity.endsAt instanceof Date && !Number.isNaN(activity.endsAt.getTime()) ? amsterdamDateParts(activity.endsAt) : {};
  return {
    id: activity._id.toString(), title: activity.title, description: activity.description, startsAt: activity.startsAt,
    endsAt: activity.endsAt, location: activity.location, capacity: activity.capacity, registeredCount: activity.registeredCount || 0,
    status: activity.status, published: activity.status === "published", createdAt: activity.createdAt, updatedAt: activity.updatedAt,
    day: String(startParts.weekday || "").replace(".", "").toUpperCase(),
    date: startParts.day || "",
    month: String(startParts.month || "").replace(".", "").toUpperCase(),
    time: startParts.hour ? `${startParts.hour}:${startParts.minute} – ${endParts.hour || ""}:${endParts.minute || ""}` : "",
    text: activity.description,
  };
}
export function readActivityFields(body, existing = {}) {
  const title = body.title === undefined ? existing.title : String(body.title || "").trim();
  const description = body.description === undefined ? existing.description : String(body.description || "").trim();
  const location = body.location === undefined ? (existing.location || DEFAULT_ACTIVITY_LOCATION) : String(body.location || "").trim();
  const startsAt = body.startsAt === undefined ? existing.startsAt : parseActivityDate(body.startsAt);
  const defaultEnd = startsAt instanceof Date && !Number.isNaN(startsAt.getTime()) ? new Date(startsAt.getTime() + 2 * 60 * 60 * 1000) : undefined;
  const endsAt = body.endsAt === undefined ? (existing.endsAt || defaultEnd) : parseActivityDate(body.endsAt);
  const capacity = body.capacity === undefined ? existing.capacity : Number(body.capacity);
  const requestedStatus = body.status === undefined && typeof body.published === "boolean" ? (body.published ? "published" : "draft") : body.status;
  const status = requestedStatus === undefined ? (existing.status || "draft") : String(requestedStatus);
  if (!title || title.length > 160 || !description || description.length > 10000 || !location || location.length > 180 || Number.isNaN(startsAt?.getTime()) || Number.isNaN(endsAt?.getTime()) || endsAt <= startsAt || !Number.isInteger(capacity) || capacity < 1 || capacity > 10000 || !["draft", "published", "cancelled"].includes(status)) {
    const error = new Error("Controleer titel, omschrijving, locatie, datum, capaciteit en status."); error.statusCode = 400; throw error;
  }
  return { title, description, location, startsAt, endsAt, capacity, status };
}
async function requireUser(request) {
  const user = await currentUser(request);
  if (!user) { const error = new Error("Niet ingelogd."); error.statusCode = 401; throw error; }
  return user;
}
async function requireAdmin(request) {
  const user = await requireUser(request);
  if (user.role !== "admin") { const error = new Error("Geen toegang."); error.statusCode = 403; throw error; }
  return user;
}

async function withTransaction(callback) {
  if (!mongoClient) throw Object.assign(new Error("Databaseverbinding ontbreekt."), { statusCode: 503 });
  const session = mongoClient.startSession();
  let result;
  try {
    await session.withTransaction(async () => { result = await callback(session); }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function stripeEncryptionKey(encryptionSecret) {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(encryptionSecret, "utf8"),
    Buffer.from("land-van-jan/stripe-config/v1", "utf8"),
    Buffer.from("webhook-signing-secret", "utf8"),
    32,
  ));
}

export function encryptStripeSecret(value, encryptionSecret, aad = STRIPE_CONFIG_ID) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", stripeEncryptionKey(encryptionSecret), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptStripeSecret(encrypted, encryptionSecret, aad = STRIPE_CONFIG_ID) {
  if (!encrypted || encrypted.version !== 1) throw new Error("Niet-ondersteunde versleuteling.");
  const decipher = createDecipheriv("aes-256-gcm", stripeEncryptionKey(encryptionSecret), Buffer.from(encrypted.iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function retrieveOrNull(callback) {
  try {
    return await callback();
  } catch (error) {
    if (error?.code === "resource_missing" || error?.statusCode === 404) return null;
    throw error;
  }
}

function resourceMetadataMatches(resource) {
  return resource?.metadata?.lvj_resource === STRIPE_RESOURCE_MARKER;
}

function donationResourceMetadataMatches(resource) {
  return resource?.metadata?.lvj_resource === STRIPE_DONATION_RESOURCE_MARKER;
}

function baseUrlScope(baseUrl) {
  return createHash("sha256").update(baseUrl).digest("hex").slice(0, 24);
}

function scopedResourceMetadata(baseUrl) {
  return { lvj_resource: STRIPE_RESOURCE_MARKER, lvj_base_url: baseUrlScope(baseUrl) };
}

function scopedResourceMetadataMatches(resource, baseUrl) {
  const metadata = scopedResourceMetadata(baseUrl);
  return resourceMetadataMatches(resource) && resource?.metadata?.lvj_base_url === metadata.lvj_base_url;
}

function membershipPriceTermsMatch(price) {
  return Boolean(
    price
    && price.active !== false
    && price.currency === "eur"
    && price.unit_amount === STRIPE_PRICE_CENTS
    && price.recurring?.interval === "month"
    && Number(price.recurring?.interval_count || 1) === 1
    && price.recurring?.usage_type !== "metered",
  );
}

function membershipPriceMatches(price, productId) {
  const priceProduct = typeof price?.product === "string" ? price.product : price?.product?.id;
  return membershipPriceTermsMatch(price) && priceProduct === productId;
}

function portalConfigurationParameters(baseUrl) {
  return {
    default_return_url: `${baseUrl}/leden`,
    features: {
      customer_update: { enabled: false, allowed_updates: [] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        cancellation_reason: { enabled: true, options: ["too_expensive", "unused", "other"] },
      },
      subscription_update: { enabled: false, default_allowed_updates: [] },
    },
    metadata: scopedResourceMetadata(baseUrl),
  };
}

export async function provisionStripeResources({
  client,
  currentConfig = {},
  baseUrl,
  secretKey,
  encryptionSecret = secretKey,
  generation = randomUUID(),
  account: suppliedAccount,
}) {
  const account = suppliedAccount || await client.accounts.retrieve();
  const livemode = /_(?:live)_/.test(secretKey);
  const sameAccount = currentConfig.stripeAccountId === account.id && Boolean(currentConfig.livemode) === livemode;
  const resourceScope = baseUrlScope(baseUrl);

  let managedProducts = [];
  let product = sameAccount && currentConfig.productId
    ? await retrieveOrNull(() => client.products.retrieve(currentConfig.productId))
    : null;
  if (!resourceMetadataMatches(product)) product = null;
  if (!product) {
    const products = await client.products.list({ active: true, limit: 100 });
    managedProducts = products.data.filter(resourceMetadataMatches);
    product = managedProducts[0] || null;
  }
  if (!product) {
    product = await client.products.create({
      name: "Land van Jan lidmaatschap",
      description: "Lidmaatschap van Land van Jan in Huissen.",
      metadata: { lvj_resource: STRIPE_RESOURCE_MARKER },
    }, { idempotencyKey: "lvj-membership-product-v1" });
  }

  let donationProduct = sameAccount && currentConfig.donationProductId
    ? await retrieveOrNull(() => client.products.retrieve(currentConfig.donationProductId))
    : null;
  if (!donationResourceMetadataMatches(donationProduct)) donationProduct = null;
  if (!donationProduct) {
    const products = await client.products.list({ active: true, limit: 100 });
    donationProduct = products.data.find(donationResourceMetadataMatches) || null;
  }
  if (!donationProduct) {
    donationProduct = await client.products.create({
      name: "Donatie aan Land van Jan",
      description: "Eenmalige vrijblijvende bijdrage aan Land van Jan in Huissen.",
      metadata: { lvj_resource: STRIPE_DONATION_RESOURCE_MARKER },
    }, { idempotencyKey: "lvj-donation-product-v1" });
  }

  let price = sameAccount && currentConfig.priceId
    ? await retrieveOrNull(() => client.prices.retrieve(currentConfig.priceId))
    : null;
  if (!membershipPriceMatches(price, product.id)) price = null;
  if (!price) {
    const prices = await client.prices.list({ active: true, lookup_keys: [STRIPE_PRICE_LOOKUP_KEY], limit: 10 });
    const lookupPrice = prices.data[0];
    const lookupProductId = typeof lookupPrice?.product === "string" ? lookupPrice.product : lookupPrice?.product?.id;
    if (lookupPrice && membershipPriceTermsMatch(lookupPrice) && lookupProductId !== product.id) {
      let lookupProduct = managedProducts.find(candidate => candidate.id === lookupProductId);
      lookupProduct ||= await retrieveOrNull(() => client.products.retrieve(lookupProductId));
      if (resourceMetadataMatches(lookupProduct)) product = lookupProduct;
    }
    if (lookupPrice && !membershipPriceMatches(lookupPrice, product.id)) {
      const error = new Error("De bestaande Stripe-prijs met de vaste lookup key wijkt af van €5 per maand.");
      error.statusCode = 503;
      error.code = "stripe_price_conflict";
      throw error;
    }
    price = prices.data.find(candidate => membershipPriceMatches(candidate, product.id)) || null;
  }
  if (!price) {
    price = await client.prices.create({
      active: true,
      currency: "eur",
      unit_amount: STRIPE_PRICE_CENTS,
      product: product.id,
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      lookup_key: STRIPE_PRICE_LOOKUP_KEY,
      nickname: "Land van Jan · €5 per maand",
      metadata: { lvj_resource: STRIPE_RESOURCE_MARKER },
    }, { idempotencyKey: "lvj-membership-price-eur-month-v1" });
  }

  let portalConfiguration = sameAccount && currentConfig.portalConfigurationId
    ? await retrieveOrNull(() => client.billingPortal.configurations.retrieve(currentConfig.portalConfigurationId))
    : null;
  if (!scopedResourceMetadataMatches(portalConfiguration, baseUrl)) portalConfiguration = null;
  if (!portalConfiguration) {
    const configurations = await client.billingPortal.configurations.list({ active: true, limit: 100 });
    portalConfiguration = configurations.data.find(candidate => scopedResourceMetadataMatches(candidate, baseUrl)) || null;
  }
  const portalParameters = portalConfigurationParameters(baseUrl);
  portalConfiguration = portalConfiguration
    ? await client.billingPortal.configurations.update(portalConfiguration.id, portalParameters)
    : await client.billingPortal.configurations.create(portalParameters, { idempotencyKey: `lvj-membership-portal-${resourceScope}-v1` });

  const webhookUrl = `${baseUrl}/api/stripe/webhook`;
  const endpointList = await client.webhookEndpoints.list({ limit: 100 });
  const managedEndpoints = endpointList.data.filter(candidate => scopedResourceMetadataMatches(candidate, baseUrl));
  let endpoint = sameAccount && currentConfig.webhookEndpointId
    ? managedEndpoints.find(candidate => candidate.id === currentConfig.webhookEndpointId)
      || await retrieveOrNull(() => client.webhookEndpoints.retrieve(currentConfig.webhookEndpointId))
    : null;
  let webhookSigningSecret = null;
  let previousWebhookSigningSecret = null;
  let previousWebhookValidUntil = null;
  if (sameAccount && currentConfig.previousWebhookSigningSecret && new Date(currentConfig.previousWebhookValidUntil) > new Date()) {
    try {
      decryptStripeSecret(
        currentConfig.previousWebhookSigningSecret,
        encryptionSecret,
        `${STRIPE_CONFIG_ID}:${account.id}:${livemode ? "live" : "test"}`,
      );
      previousWebhookSigningSecret = currentConfig.previousWebhookSigningSecret;
      previousWebhookValidUntil = new Date(currentConfig.previousWebhookValidUntil);
    } catch {
      previousWebhookSigningSecret = null;
      previousWebhookValidUntil = null;
    }
  }
  if (endpoint && !scopedResourceMetadataMatches(endpoint, baseUrl)) endpoint = null;
  if (endpoint && sameAccount && currentConfig.webhookSigningSecret) {
    try {
      webhookSigningSecret = decryptStripeSecret(
        currentConfig.webhookSigningSecret,
        encryptionSecret,
        `${STRIPE_CONFIG_ID}:${account.id}:${livemode ? "live" : "test"}`,
      );
    } catch {
      webhookSigningSecret = null;
    }
  }
  if (endpoint?.api_version !== STRIPE_API_VERSION) {
    endpoint = null;
    webhookSigningSecret = null;
  }
  if (endpoint && webhookSigningSecret) {
    endpoint = await client.webhookEndpoints.update(endpoint.id, {
      url: webhookUrl,
      enabled_events: STRIPE_WEBHOOK_EVENTS,
      disabled: false,
      description: "Land van Jan membership sync",
      metadata: scopedResourceMetadata(baseUrl),
    });
  } else {
    if (sameAccount && currentConfig.webhookSigningSecret) {
      try {
        decryptStripeSecret(
          currentConfig.webhookSigningSecret,
          encryptionSecret,
          `${STRIPE_CONFIG_ID}:${account.id}:${livemode ? "live" : "test"}`,
        );
        previousWebhookSigningSecret = currentConfig.webhookSigningSecret;
        previousWebhookValidUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
      } catch {
        previousWebhookSigningSecret = null;
      }
    }
    endpoint = await client.webhookEndpoints.create({
      url: webhookUrl,
      api_version: STRIPE_API_VERSION,
      enabled_events: STRIPE_WEBHOOK_EVENTS,
      description: "Land van Jan membership sync",
      metadata: { ...scopedResourceMetadata(baseUrl), generation },
    }, { idempotencyKey: `lvj-membership-webhook-${account.id}-${resourceScope}-${generation}` });
    webhookSigningSecret = endpoint.secret;
  }
  if (!webhookSigningSecret) {
    const error = new Error("Stripe gaf geen webhook signing secret terug.");
    error.statusCode = 503;
    error.code = "stripe_webhook_secret_missing";
    throw error;
  }

  const aad = `${STRIPE_CONFIG_ID}:${account.id}:${livemode ? "live" : "test"}`;
  return {
    config: {
      schemaVersion: 1,
      setupState: "ready",
      stripeAccountId: account.id,
      livemode,
      productId: product.id,
      donationProductId: donationProduct.id,
      priceId: price.id,
      portalConfigurationId: portalConfiguration.id,
      webhookEndpointId: endpoint.id,
      webhookUrl,
      webhookApiVersion: STRIPE_API_VERSION,
      webhookSigningSecret: encryptStripeSecret(webhookSigningSecret, encryptionSecret, aad),
      previousWebhookSigningSecret,
      previousWebhookValidUntil,
      updatedAt: new Date(),
    },
    obsoleteEndpointIds: managedEndpoints.filter(candidate => candidate.id !== endpoint.id).map(candidate => candidate.id),
  };
}

async function acquireServiceLease(databaseHandle, lockId, ttlMs = 60_000) {
  const owner = randomUUID();
  const now = new Date();
  try {
    const document = await databaseHandle.collection("service_locks").findOneAndUpdate(
      {
        _id: lockId,
        $or: [
          { expiresAt: { $lte: now } },
          { owner },
        ],
      },
      {
        $set: { owner, expiresAt: new Date(now.getTime() + ttlMs), updatedAt: now },
        $setOnInsert: { createdAt: now },
        $inc: { fence: 1 },
      },
      { upsert: true, returnDocument: "after" },
    );
    return document?.owner === owner ? { owner, fence: document.fence, ttlMs } : null;
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

async function renewServiceLease(databaseHandle, lockId, lease) {
  const now = new Date();
  const result = await databaseHandle.collection("service_locks").updateOne(
    { _id: lockId, owner: lease.owner, fence: lease.fence },
    { $set: { expiresAt: new Date(now.getTime() + lease.ttlMs), updatedAt: now } },
  );
  return result.modifiedCount === 1;
}

async function waitForStripeSetup(databaseHandle, baseUrl, expectedAccountId, expectedLivemode) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await databaseHandle.collection("service_config").findOne({ _id: STRIPE_CONFIG_ID });
    if (
      current?.setupState === "ready"
      && current.webhookUrl === `${baseUrl}/api/stripe/webhook`
      && current.stripeAccountId === expectedAccountId
      && Boolean(current.livemode) === expectedLivemode
    ) {
      try {
        decryptStripeSecret(
          current.webhookSigningSecret,
          sessionSecret,
          `${STRIPE_CONFIG_ID}:${current.stripeAccountId}:${current.livemode ? "live" : "test"}`,
        );
        return current;
      } catch {
        // A key rotation requires the lease holder to replace the endpoint.
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  const error = new Error("Stripe-instellingen worden door een andere instantie voorbereid.");
  error.statusCode = 503;
  throw error;
}

async function ensureStripeConfiguration(databaseHandle, request) {
  const baseUrl = canonicalBaseUrl(request);
  if (!baseUrl) {
    const error = new Error("Een publieke HTTPS-basis-URL ontbreekt.");
    error.statusCode = 503;
    throw error;
  }
  const cacheKey = baseUrl;
  if (stripeSetupPromises.has(cacheKey)) return stripeSetupPromises.get(cacheKey);
  billingSetupRuntimeState = "pending";
  const setupPromise = (async () => {
    const client = stripe();
    const account = await client.accounts.retrieve();
    const expectedLivemode = /_(?:live)_/.test(stripeSecretKey);
    const lockId = "stripe_setup_v1";
    const lease = await acquireServiceLease(databaseHandle, lockId);
    if (!lease) return waitForStripeSetup(databaseHandle, baseUrl, account.id, expectedLivemode);
    let leaseLost = false;
    const renewal = setInterval(() => {
      renewServiceLease(databaseHandle, lockId, lease).then(renewed => { if (!renewed) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, Math.floor(lease.ttlMs / 3));
    renewal.unref();
    let currentConfig = {};
    try {
      currentConfig = await databaseHandle.collection("service_config").findOne({ _id: STRIPE_CONFIG_ID }) || {};
      const generation = randomUUID();
      const provisioned = await provisionStripeResources({
        client,
        currentConfig,
        baseUrl,
        secretKey: stripeSecretKey,
        encryptionSecret: sessionSecret,
        generation,
        account,
      });
      const activeLease = !leaseLost && await databaseHandle.collection("service_locks").findOne({
        _id: lockId,
        owner: lease.owner,
        fence: lease.fence,
        expiresAt: { $gt: new Date() },
      });
      if (!activeLease) throw Object.assign(new Error("Stripe setup-lease is verlopen."), { statusCode: 503, code: "stripe_setup_lease_lost" });
      const generationFilter = currentConfig._id
        ? (currentConfig.setupGeneration ? { setupGeneration: currentConfig.setupGeneration } : { setupGeneration: { $exists: false } })
        : {};
      const stored = await databaseHandle.collection("service_config").updateOne(
        { _id: STRIPE_CONFIG_ID, ...generationFilter },
        {
          $set: { ...provisioned.config, setupGeneration: generation, setupFence: lease.fence },
          $setOnInsert: { createdAt: new Date() },
          $unset: { lastSetupErrorCode: "", lastSetupFailedAt: "" },
        },
        { upsert: !currentConfig._id },
      );
      if (!stored.matchedCount && !stored.upsertedCount) {
        throw Object.assign(new Error("Een nieuwere Stripe-configuratie is al opgeslagen."), { statusCode: 503, code: "stripe_setup_fenced" });
      }
      let cleanupPending = false;
      const stillOwner = await databaseHandle.collection("service_config").findOne({ _id: STRIPE_CONFIG_ID, setupGeneration: generation });
      if (stillOwner) {
        for (const endpointId of provisioned.obsoleteEndpointIds) {
          try {
            await client.webhookEndpoints.update(endpointId, { disabled: true });
          } catch {
            cleanupPending = true;
          }
        }
      } else {
        cleanupPending = true;
      }
      if (cleanupPending) {
        await databaseHandle.collection("service_config").updateOne(
          { _id: STRIPE_CONFIG_ID, setupGeneration: generation },
          { $set: { cleanupPending: true } },
        );
      } else {
        await databaseHandle.collection("service_config").updateOne(
          { _id: STRIPE_CONFIG_ID, setupGeneration: generation },
          { $unset: { cleanupPending: "" } },
        );
      }
      return { _id: STRIPE_CONFIG_ID, ...provisioned.config, setupGeneration: generation, cleanupPending };
    } catch (error) {
      const errorCode = String(error?.code || error?.type || "setup_failed").replace(/[^a-z0-9_.-]/gi, "").slice(0, 80);
      await databaseHandle.collection("service_config").updateOne(
        { _id: STRIPE_CONFIG_ID },
        {
          $set: { lastSetupErrorCode: errorCode, lastSetupFailedAt: new Date() },
          $setOnInsert: { setupState: "error", createdAt: new Date(), updatedAt: new Date() },
        },
        { upsert: true },
      ).catch(() => {});
      throw error;
    } finally {
      clearInterval(renewal);
      await databaseHandle.collection("service_locks").deleteOne({ _id: lockId, owner: lease.owner, fence: lease.fence }).catch(() => {});
    }
  })();
  stripeSetupPromises.set(cacheKey, setupPromise);
  setupPromise.then(result => {
    billingSetupRuntimeState = "ready";
    const timeout = setTimeout(() => {
      if (stripeSetupPromises.get(cacheKey) === setupPromise) stripeSetupPromises.delete(cacheKey);
    }, result.cleanupPending ? 1_000 : 5 * 60 * 1000);
    timeout.unref();
  }, () => {
    billingSetupRuntimeState = "error";
    if (stripeSetupPromises.get(cacheKey) === setupPromise) stripeSetupPromises.delete(cacheKey);
  });
  return setupPromise;
}

export function stripeSubscriptionFields(subscription, { stripeAccountId, observedAt = new Date() } = {}) {
  const itemPeriodEnds = (subscription.items?.data || [])
    .map(item => Number(item.current_period_end || 0))
    .filter(Boolean);
  const periodEndSeconds = itemPeriodEnds.length ? Math.max(...itemPeriodEnds) : Number(subscription.current_period_end || 0);
  return {
    stripeAccountId,
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
    stripeSubscriptionId: subscription.id,
    membershipStatus: subscription.status,
    membershipCancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    membershipCurrentPeriodEnd: periodEndSeconds ? new Date(periodEndSeconds * 1000) : null,
    membershipUpdatedAt: observedAt,
  };
}

function subscriptionHasConfiguredPrice(subscription, priceId) {
  return (subscription.items?.data || []).some(item => {
    const itemPrice = typeof item.price === "string" ? item.price : item.price?.id;
    return itemPrice === priceId;
  });
}

function subscriptionCanBeDeletedSafely(subscription) {
  return ["canceled", "incomplete_expired"].includes(subscription.status);
}

async function listCustomerSubscriptions(client, customerId) {
  try {
    const subscriptions = await client.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    return subscriptions.data;
  } catch (error) {
    if (error?.code === "resource_missing") return [];
    throw error;
  }
}

async function completePrivacyDeletionJob(databaseHandle, client, job) {
  try {
    await client.customers.del(job.stripeCustomerId);
  } catch (error) {
    if (error?.code !== "resource_missing") {
      await databaseHandle.collection("privacy_deletion_jobs").updateOne(
        { _id: job._id, status: "pending" },
        {
          $inc: { attempts: 1 },
          $set: {
            lastAttemptAt: new Date(),
            lastErrorCode: safeErrorCode(error),
            nextAttemptAt: new Date(Date.now() + 15 * 60 * 1000),
          },
        },
      );
      return false;
    }
  }
  const completedAt = new Date();
  await databaseHandle.collection("privacy_deletion_jobs").updateOne(
    { _id: job._id },
    {
      $set: {
        status: "completed",
        completedAt,
        retentionUntil: new Date(completedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
      $unset: { lastErrorCode: "", nextAttemptAt: "" },
    },
  );
  return true;
}

async function processPrivacyDeletionJobs(databaseHandle, client, stripeConfig) {
  const jobs = await databaseHandle.collection("privacy_deletion_jobs").find({
    status: "pending",
    stripeAccountId: stripeConfig.stripeAccountId,
    nextAttemptAt: { $lte: new Date() },
  }).sort({ createdAt: 1 }).limit(20).toArray();
  for (const job of jobs) await completePrivacyDeletionJob(databaseHandle, client, job);
}

async function applyCanonicalSubscription(databaseHandle, client, config, eventObject, userId) {
  let subscription = await retrieveOrNull(() => client.subscriptions.retrieve(eventObject.id));
  subscription ||= eventObject;
  if (!subscriptionHasConfiguredPrice(subscription, config.priceId)) return;
  const parsedUserId = parseId(userId || subscription.metadata?.userId);
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  const filter = parsedUserId
    ? { _id: parsedUserId }
    : {
      $or: [
        { stripeAccountId: config.stripeAccountId, stripeSubscriptionId: subscription.id },
        { stripeAccountId: config.stripeAccountId, stripeCustomerId: customerId },
      ],
    };
  await databaseHandle.collection("users").updateOne(
    filter,
    { $set: stripeSubscriptionFields(subscription, { stripeAccountId: config.stripeAccountId }) },
  );
}

async function processStripeEvent(databaseHandle, client, config, event) {
  const object = event.data.object;
  if (event.type === "checkout.session.completed") {
    if (object.metadata?.lvj_resource !== STRIPE_RESOURCE_MARKER) return;
    const userId = object.metadata?.userId || object.client_reference_id;
    const parsedUserId = parseId(userId);
    if (!parsedUserId) return;
    const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
    const workflowId = object.metadata?.checkoutWorkflowId;
    if (!subscriptionId || !workflowId) return;
    const user = await databaseHandle.collection("users").findOne({ _id: parsedUserId, pendingCheckoutWorkflowId: workflowId });
    if (!user) return;
    const subscription = await client.subscriptions.retrieve(subscriptionId);
    if (!subscriptionHasConfiguredPrice(subscription, config.priceId)) return;
    await applyCanonicalSubscription(databaseHandle, client, config, subscription, userId);
    await databaseHandle.collection("users").updateOne(
      { _id: parsedUserId, pendingCheckoutWorkflowId: workflowId },
      { $unset: {
        pendingCheckoutWorkflowId: "",
        pendingCheckoutPriceId: "",
        pendingCheckoutSessionId: "",
        pendingCheckoutUrl: "",
        pendingCheckoutExpiresAt: "",
        pendingCheckoutUpdatedAt: "",
      } },
    );
    return;
  }
  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    await applyCanonicalSubscription(databaseHandle, client, config, object, object.metadata?.userId);
  }
}

export async function claimStripeEvent(collection, event, now = new Date()) {
  const leaseUntil = new Date(now.getTime() + 2 * 60 * 1000);
  const owner = randomUUID();
  const reclaimed = await collection.updateOne(
    {
      eventId: event.id,
      $or: [
        { status: "failed" },
        { status: "processing", leaseUntil: { $lte: now } },
        { status: "processing", leaseUntil: { $exists: false } },
      ],
    },
    {
      $set: { status: "processing", leaseUntil, lastAttemptAt: now, type: event.type, owner },
      $inc: { attempts: 1, fence: 1 },
      $unset: { failedAt: "", lastErrorCode: "" },
    },
  );
  if (reclaimed.modifiedCount) {
    const document = await collection.findOne({ eventId: event.id });
    return { state: "claimed", owner, fence: document?.fence };
  }
  try {
    await collection.insertOne({
      eventId: event.id,
      type: event.type,
      objectId: event.data?.object?.id || null,
      status: "processing",
      attempts: 1,
      fence: 1,
      owner,
      leaseUntil,
      createdAt: now,
      lastAttemptAt: now,
    });
    return { state: "claimed", owner, fence: 1 };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await collection.findOne({ eventId: event.id });
    return { state: existing?.status === "processed" ? "processed" : "busy" };
  }
}

async function handleStripeWebhook(request, response) {
  if (billingConfigError()) return sendApiError(response, 503, "Betalingen zijn nog niet geconfigureerd.");
  const signature = request.headers["stripe-signature"];
  if (typeof signature !== "string") return sendApiError(response, 400, "Stripe-handtekening ontbreekt.");
  const rawBody = await readRawBody(request);
  const databaseHandle = await db();
  const config = await databaseHandle.collection("service_config").findOne({ _id: STRIPE_CONFIG_ID, setupState: "ready" });
  if (!config) return sendApiError(response, 503, "Stripe wordt nog voorbereid.");
  const webhookSigningSecrets = [];
  const webhookAad = `${STRIPE_CONFIG_ID}:${config.stripeAccountId}:${config.livemode ? "live" : "test"}`;
  try {
    webhookSigningSecrets.push(decryptStripeSecret(
      config.webhookSigningSecret,
      sessionSecret,
      webhookAad,
    ));
  } catch {
    return sendApiError(response, 503, "Stripe wordt opnieuw gekoppeld.");
  }
  if (config.previousWebhookSigningSecret && new Date(config.previousWebhookValidUntil) > new Date()) {
    try {
      webhookSigningSecrets.push(decryptStripeSecret(config.previousWebhookSigningSecret, sessionSecret, webhookAad));
    } catch {
      // The current signing secret remains authoritative.
    }
  }
  const client = stripe();
  let event;
  for (const signingSecret of webhookSigningSecrets) {
    try {
      event = client.webhooks.constructEvent(rawBody, signature, signingSecret);
      break;
    } catch {
      // Try the short-lived previous secret during endpoint cutover.
    }
  }
  if (!event) return sendApiError(response, 400, "Ongeldige Stripe-handtekening.");
  const collection = databaseHandle.collection("stripe_events");
  const claim = await claimStripeEvent(collection, event);
  if (claim.state === "processed") return sendJson(response, 200, { received: true, duplicate: true });
  if (claim.state === "busy") return sendApiError(response, 503, "Webhook wordt opnieuw geprobeerd.");
  try {
    await processStripeEvent(databaseHandle, client, config, event);
    await collection.updateOne(
      { eventId: event.id, status: "processing", owner: claim.owner, fence: claim.fence },
      { $set: { status: "processed", processedAt: new Date() }, $unset: { leaseUntil: "", failedAt: "", lastErrorCode: "" } },
    );
  } catch (error) {
    const errorCode = String(error?.code || error?.type || "processing_failed").replace(/[^a-z0-9_.-]/gi, "").slice(0, 80);
    await collection.updateOne(
      { eventId: event.id, status: "processing", owner: claim.owner, fence: claim.fence },
      { $set: { status: "failed", failedAt: new Date(), lastErrorCode: errorCode }, $unset: { leaseUntil: "" } },
    );
    throw error;
  }
  return sendJson(response, 200, { received: true });
}

function safeContactMessage(message) {
  return {
    id: message._id.toString(),
    name: message.name,
    email: message.email,
    subject: message.subject || "",
    message: message.message,
    status: message.status,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt || null,
  };
}

async function handleApi(request, response, pathname) {
  const method = request.method || "GET";
  if (pathname === "/api/health" && method === "GET") {
    return sendJson(response, 200, {
      ok: true,
      authConfigured: !apiConfigError(),
      billingKeyConfigured: !billingConfigError(),
    });
  }
  if (pathname === "/api/health/ready" && method === "GET") {
    if (apiConfigError()) return sendApiError(response, 503, "De serviceconfiguratie is nog niet gereed.");
    try {
      const databaseHandle = await db();
      await databaseHandle.command({ ping: 1 });
      let billing = "not_configured";
      if (!billingConfigError()) {
        try {
          const stripeConfig = await ensureStripeConfiguration(databaseHandle, request);
          billing = stripeConfig.setupState === "ready" ? "ready" : "error";
        } catch {
          // Stripe is an optional external dependency: keep the site and member
          // backend available while setup status and payment endpoints stay red.
          billing = "error";
        }
      }
      return sendJson(response, 200, { ok: true, database: "ready", billing });
    } catch {
      return sendApiError(response, 503, "De backend is nog niet gereed.");
    }
  }
  if (pathname === "/api/contact" && method === "POST") {
    if (!allowRate(request, "contact", 6, 60 * 60 * 1000)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const body = await readJson(request);
    if (body.website) return sendJson(response, 202, { ok: true });
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const subject = String(body.subject || "").trim();
    const message = String(body.message || body.body || "").trim();
    if (body.privacyAccepted !== true || body.privacyNoticeVersion !== PRIVACY_NOTICE_VERSION) {
      return sendApiError(response, 400, "Bevestig de actuele privacyverklaring.");
    }
    if (!validName(name) || !validEmail(email) || subject.length > 160 || message.length < 10 || message.length > 5000) {
      return sendApiError(response, 400, "Controleer naam, e-mailadres en bericht.");
    }
    if (!allowAccountRate("contact-email", email, 4, 60 * 60 * 1000)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const databaseHandle = await db();
    const now = new Date();
    await databaseHandle.collection("contact_messages").insertOne({
      name,
      email,
      subject,
      message,
      status: "new",
      privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      createdAt: now,
      retentionUntil: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000),
    });
    return sendJson(response, 201, { ok: true, message: "Bedankt. Je bericht is veilig ontvangen." });
  }
  if (pathname === "/api/setup/status" && method === "GET") {
    const authError = apiConfigError();
    if (authError) {
      return sendJson(response, 200, {
        auth: "not_configured",
        adminBootstrap: "not_checked",
        billing: billingConfigError() ? "not_configured" : "waiting_for_database",
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        marketingConsentVersion: MARKETING_CONSENT_VERSION,
      });
    }
    const databaseHandle = await db();
    const stripeConfig = await databaseHandle.collection("service_config").findOne(
      { _id: STRIPE_CONFIG_ID },
      { projection: { setupState: 1, webhookUrl: 1, stripeAccountId: 1, livemode: 1, webhookSigningSecret: 1, cleanupPending: 1, lastSetupFailedAt: 1 } },
    );
    let billing = billingConfigError() ? "not_configured" : billingSetupRuntimeState;
    const baseUrl = canonicalBaseUrl(request);
    if (!baseUrl && !billingConfigError()) billing = "needs_public_url";
    if (stripeConfig?.setupState === "error") billing = "error";
    if (stripeConfig?.setupState === "ready" && stripeConfig.webhookUrl === `${baseUrl}/api/stripe/webhook`) {
      try {
        decryptStripeSecret(
          stripeConfig.webhookSigningSecret,
          sessionSecret,
          `${STRIPE_CONFIG_ID}:${stripeConfig.stripeAccountId}:${stripeConfig.livemode ? "live" : "test"}`,
        );
        billing = stripeConfig.cleanupPending
          ? "ready_cleanup_pending"
          : stripeConfig.lastSetupFailedAt ? "ready_with_warning" : "ready";
      } catch {
        billing = "key_rotation_pending";
      }
    }
    return sendJson(response, 200, {
      auth: "ready",
      adminBootstrap: adminBootstrapState,
      billing,
      privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      marketingConsentVersion: MARKETING_CONSENT_VERSION,
    });
  }
  if (pathname === "/api/auth/me" && method === "GET") {
    const user = await currentUser(request);
    return user ? sendJson(response, 200, { user: safeUser(user) }) : sendApiError(response, 401, "Niet ingelogd.");
  }
  if (pathname === "/api/auth/register" && method === "POST") {
    if (!allowRate(request, "register", 8)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = body.password;
    if (body.privacyAccepted !== true || body.privacyNoticeVersion !== PRIVACY_NOTICE_VERSION) {
      return sendApiError(response, 400, "Bevestig de actuele privacyverklaring.");
    }
    if (!validName(name) || !validEmail(email) || !validPassword(password)) return sendApiError(response, 400, "Controleer naam, e-mailadres en wachtwoord (minimaal 12 tekens)." );
    if (!allowAccountRate("register-account", email, 4, 60 * 60 * 1000)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const database = await db();
    const now = new Date();
    const marketingConsent = body.marketingConsent === true && body.marketingConsentVersion === MARKETING_CONSENT_VERSION;
    const user = {
      _id: new ObjectId(),
      name,
      email,
      passwordHash: await hashPassword(password),
      role: "member",
      emailVerifiedAt: null,
      privacyAcceptedAt: now,
      privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      marketingConsent,
      marketingConsentUpdatedAt: marketingConsent ? now : null,
      marketingConsentVersion: marketingConsent ? MARKETING_CONSENT_VERSION : null,
      createdAt: now,
      lastLoginAt: now,
    };
    let token;
    try {
      await withTransaction(async session => {
        await database.collection("users").insertOne(user, { session });
        const consentEvents = [{
          userId: user._id,
          consent: "privacy_notice_acknowledgement",
          granted: true,
          version: PRIVACY_NOTICE_VERSION,
          source: "registration",
          createdAt: now,
        }];
        if (marketingConsent) consentEvents.push({
          userId: user._id,
          consent: "marketing_email",
          granted: true,
          version: MARKETING_CONSENT_VERSION,
          source: "registration",
          createdAt: now,
        });
        await database.collection("consent_events").insertMany(consentEvents, { session });
        await writeAudit(database, "auth.registered", { subjectId: user._id }, { session });
        token = await createSession(database, user, { session });
      });
    } catch (error) {
      if (error?.code === 11000) return sendApiError(response, 409, "Er bestaat al een account voor dit e-mailadres.");
      throw error;
    }
    return sendJson(response, 201, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(token) });
  }
  if (pathname === "/api/auth/login" && method === "POST") {
    if (!allowRate(request, "login", 15)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = body.password;
    if (!validEmail(email) || typeof password !== "string") return sendApiError(response, 400, "Controleer je gegevens.");
    if (!allowAccountRate("login-account", email, 12)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const database = await db();
    const user = await database.collection("users").findOne({ email, deletionState: { $exists: false } });
    const passwordMatches = await comparePassword(password, user?.passwordHash || await dummyPasswordHash());
    if (!user || !passwordMatches) return sendApiError(response, 401, "E-mailadres of wachtwoord klopt niet.");
    const memberLockId = `member_mutation:${user._id.toString()}`;
    const memberLease = await acquireServiceLease(database, memberLockId, 60_000);
    if (!memberLease) return sendApiError(response, 409, "Er wordt al een wijziging aan dit account verwerkt.");
    try {
      const now = new Date();
      let token;
      await withTransaction(async session => {
        const updated = await database.collection("users").updateOne(
          { _id: user._id, deletionState: { $exists: false } },
          { $set: { lastLoginAt: now } },
          { session },
        );
        if (!updated.matchedCount) throw Object.assign(new Error("Het account is niet beschikbaar."), { statusCode: 409 });
        token = await createSession(database, user, { session });
      });
      user.lastLoginAt = now;
      return sendJson(response, 200, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(token) });
    } finally {
      await database.collection("service_locks").deleteOne({ _id: memberLockId, owner: memberLease.owner, fence: memberLease.fence }).catch(() => {});
    }
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    const payload = verifyToken(cookies(request).lvj_session);
    if (payload) {
      const database = await db();
      await database.collection("sessions").deleteOne({ sid: payload.sid });
    }
    return sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }
  if (pathname === "/api/member/profile" && method === "GET") {
    const user = await requireUser(request);
    return sendJson(response, 200, { profile: safeUser(user) });
  }
  if (pathname === "/api/member/profile" && method === "PATCH") {
    const user = await requireUser(request);
    if (!allowRate(request, "profile-update", 30)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const body = await readJson(request);
    const updates = {};
    if (body.name !== undefined) {
      const name = String(body.name || "").trim();
      if (!validName(name)) return sendApiError(response, 400, "Controleer je naam.");
      updates.name = name;
    }
    let consentEvent = null;
    if (body.marketingConsent !== undefined) {
      if (typeof body.marketingConsent !== "boolean") return sendApiError(response, 400, "Ongeldige toestemmingskeuze.");
      if (body.marketingConsent && body.marketingConsentVersion !== MARKETING_CONSENT_VERSION) {
        return sendApiError(response, 400, "Bevestig de actuele toestemmingstekst.");
      }
      const now = new Date();
      updates.marketingConsent = body.marketingConsent;
      updates.marketingConsentUpdatedAt = now;
      updates.marketingConsentVersion = body.marketingConsent ? MARKETING_CONSENT_VERSION : null;
      consentEvent = {
        userId: user._id,
        consent: "marketing_email",
        granted: body.marketingConsent,
        version: body.marketingConsent ? MARKETING_CONSENT_VERSION : (user.marketingConsentVersion || MARKETING_CONSENT_VERSION),
        source: "member_profile",
        createdAt: now,
      };
    }
    if (!Object.keys(updates).length) return sendApiError(response, 400, "Er zijn geen geldige wijzigingen aangeleverd.");
    const database = await db();
    await withTransaction(async session => {
      const profileUpdate = await database.collection("users").updateOne(
        { _id: user._id, deletionState: { $exists: false } },
        { $set: updates },
        { session },
      );
      if (!profileUpdate.matchedCount) throw Object.assign(new Error("Het account wordt verwijderd."), { statusCode: 409 });
      if (consentEvent) await database.collection("consent_events").insertOne(consentEvent, { session });
      await writeAudit(database, "member.profile.updated", { actorId: user._id, subjectId: user._id }, { session });
    });
    const updated = await database.collection("users").findOne({ _id: user._id });
    return sendJson(response, 200, { profile: safeUser(updated) });
  }
  if ((pathname === "/api/member/profile" || pathname === "/api/member/account") && method === "DELETE") {
    const user = await requireUser(request);
    if (!allowRate(request, "account-delete", 5, 60 * 60 * 1000)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const body = await readJson(request);
    if (body.confirmation !== "VERWIJDER") return sendApiError(response, 400, "Typ VERWIJDER om de verwijdering te bevestigen.");
    if (typeof body.password !== "string" || !(await comparePassword(body.password, user.passwordHash))) {
      return sendApiError(response, 401, "Bevestig je huidige wachtwoord.");
    }
    const database = await db();
    const memberLockId = `member_mutation:${user._id.toString()}`;
    const memberLease = await acquireServiceLease(database, memberLockId, 120_000);
    if (!memberLease) return sendApiError(response, 409, "Er wordt al een wijziging aan dit account verwerkt.");
    let adminLease = null;
    let deletionMarked = false;
    let deletionCommitted = false;
    let deletionJob = null;
    let billingClient = null;
    try {
      if (user.stripeCustomerId) {
        const stripeConfig = await ensureStripeConfiguration(database, request);
        if (user.stripeAccountId !== stripeConfig.stripeAccountId) return sendApiError(response, 503, "De betaalomgeving moet eerst worden hersteld.");
        billingClient = stripe();
        const subscriptions = await listCustomerSubscriptions(billingClient, user.stripeCustomerId);
        const blockingSubscription = subscriptions.find(subscription => !subscriptionCanBeDeletedSafely(subscription));
        if (blockingSubscription) {
          if (subscriptionHasConfiguredPrice(blockingSubscription, stripeConfig.priceId)) {
            await applyCanonicalSubscription(database, billingClient, stripeConfig, blockingSubscription, user._id.toString());
          }
          return sendApiError(response, 409, "Beëindig eerst ieder actief lidmaatschap via het Stripe-portaal.");
        }
        deletionJob = {
          _id: randomUUID(),
          status: "pending",
          stripeAccountId: stripeConfig.stripeAccountId,
          stripeCustomerId: user.stripeCustomerId,
          attempts: 0,
          createdAt: new Date(),
          nextAttemptAt: new Date(),
        };
      } else if (["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(user.membershipStatus)) {
        return sendApiError(response, 409, "De betaalstatus moet eerst worden hersteld voordat het account kan worden verwijderd.");
      }

      if (user.role === "admin") {
        adminLease = await acquireServiceLease(database, "admin_account_delete", 120_000);
        if (!adminLease) return sendApiError(response, 409, "Een andere beheerwijziging wordt al verwerkt.");
        if (await database.collection("users").countDocuments({ role: "admin", deletionState: { $exists: false } }, { limit: 2 }) <= 1) {
          return sendApiError(response, 409, "Draag eerst het beheer over aan een andere beheerder.");
        }
      }

      const marked = await database.collection("users").updateOne(
        { _id: user._id, deletionState: { $exists: false } },
        { $set: { deletionState: "processing", deletionStartedAt: new Date() } },
      );
      if (!marked.modifiedCount) return sendApiError(response, 409, "Het account wordt al verwijderd.");
      deletionMarked = true;

      await withTransaction(async session => {
        const registrations = await database.collection("registrations").find({ userId: user._id }, { session }).toArray();
        for (const registration of registrations) {
          await database.collection("activities").updateOne(
            { _id: registration.activityId, registeredCount: { $gt: 0 } },
            { $inc: { registeredCount: -1 }, $set: { updatedAt: new Date() } },
            { session },
          );
        }
        await database.collection("registrations").deleteMany({ userId: user._id }, { session });
        await database.collection("sessions").deleteMany({ userId: user._id }, { session });
        await database.collection("consent_events").deleteMany({ userId: user._id }, { session });
        if (deletionJob) await database.collection("privacy_deletion_jobs").insertOne(deletionJob, { session });
        await writeAudit(database, "member.account.deleted", { actorId: user._id, subjectId: user._id }, { session });
        await database.collection("users").deleteOne({ _id: user._id, deletionState: "processing" }, { session });
      });
      deletionCommitted = true;
      const externalCleanup = deletionJob
        ? (await completePrivacyDeletionJob(database, billingClient, deletionJob).catch(() => false) ? "completed" : "pending")
        : "not_required";
      return sendJson(response, externalCleanup === "pending" ? 202 : 200, { ok: true, externalCleanup }, { "Set-Cookie": clearSessionCookie() });
    } finally {
      if (deletionMarked && !deletionCommitted) {
        await database.collection("users").updateOne(
          { _id: user._id, deletionState: "processing" },
          { $unset: { deletionState: "", deletionStartedAt: "" } },
        ).catch(() => {});
      }
      if (adminLease) await database.collection("service_locks").deleteOne({ _id: "admin_account_delete", owner: adminLease.owner, fence: adminLease.fence }).catch(() => {});
      await database.collection("service_locks").deleteOne({ _id: memberLockId, owner: memberLease.owner, fence: memberLease.fence }).catch(() => {});
    }
  }
  if (pathname === "/api/billing/donation-checkout" && method === "POST") {
    if (!allowRate(request, "donation-checkout", 8, 60 * 60 * 1000)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const body = await readJson(request);
    const amountCents = readDonationAmountCents(body.amountCents);
    const client = stripe();
    const database = await db();
    const stripeConfig = await ensureStripeConfiguration(database, request);
    const donationId = randomUUID();
    const checkoutSession = await client.checkout.sessions.create({
      mode: "payment",
      submit_type: "donate",
      locale: "nl",
      customer_creation: "always",
      branding_settings: STRIPE_CHECKOUT_BRANDING,
      line_items: [{
        price_data: {
          currency: "eur",
          unit_amount: amountCents,
          product: stripeConfig.donationProductId,
        },
        quantity: 1,
      }],
      success_url: `${canonicalBaseUrl(request)}/?donatie=bedankt`,
      cancel_url: `${canonicalBaseUrl(request)}/?donatie=geannuleerd`,
      metadata: {
        lvj_resource: STRIPE_DONATION_RESOURCE_MARKER,
        donationId,
        amountCents: String(amountCents),
      },
      payment_intent_data: {
        description: "Vrijblijvende donatie aan Land van Jan",
        metadata: { lvj_resource: STRIPE_DONATION_RESOURCE_MARKER, donationId },
      },
    }, { idempotencyKey: `donation-checkout-${donationId}` });
    if (!checkoutSession.url) return sendApiError(response, 503, "Stripe Checkout kon niet worden geopend.");
    return sendJson(response, 200, { checkoutUrl: checkoutSession.url });
  }
  if (pathname === "/api/billing/checkout" && method === "POST") {
    const user = await requireUser(request);
    if (!allowRate(request, "billing-checkout", 10)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const client = stripe();
    const database = await db();
    const memberLockId = `member_mutation:${user._id.toString()}`;
    const memberLease = await acquireServiceLease(database, memberLockId, 120_000);
    if (!memberLease) return sendApiError(response, 409, "Er wordt al een wijziging aan dit account verwerkt.");
    try {
      const stripeConfig = await ensureStripeConfiguration(database, request);
      let freshUser = await database.collection("users").findOne({ _id: user._id, deletionState: { $exists: false } });
      if (!freshUser) return sendApiError(response, 409, "Het account is niet beschikbaar.");
      if (["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(freshUser.membershipStatus)) {
        return sendApiError(response, 409, "Er bestaat al een lidmaatschap. Beheer het via de ledenomgeving.");
      }
      if (freshUser.stripeCustomerId && freshUser.stripeAccountId === stripeConfig.stripeAccountId) {
        const subscriptions = await client.subscriptions.list({ customer: freshUser.stripeCustomerId, status: "all", limit: 100 });
        const existingSubscription = subscriptions.data.find(subscription => (
          !["canceled", "incomplete_expired"].includes(subscription.status)
          && subscriptionHasConfiguredPrice(subscription, stripeConfig.priceId)
        ));
        if (existingSubscription) {
          await applyCanonicalSubscription(database, client, stripeConfig, existingSubscription, user._id.toString());
          return sendApiError(response, 409, "Er bestaat al een lidmaatschap. Beheer het via de ledenomgeving.");
        }
      }
      const now = new Date();
      if (freshUser.pendingCheckoutSessionId && freshUser.pendingCheckoutExpiresAt > now) {
        const pendingSession = await retrieveOrNull(() => client.checkout.sessions.retrieve(freshUser.pendingCheckoutSessionId));
        if (pendingSession?.status === "open" && pendingSession.url) return sendJson(response, 200, { checkoutUrl: pendingSession.url, reused: true });
        if (pendingSession?.status === "complete") return sendApiError(response, 409, "Je betaling wordt verwerkt. Vernieuw over enkele ogenblikken je ledenomgeving.");
      }
      const proposedWorkflowId = randomUUID();
      await database.collection("users").updateOne(
        {
          _id: user._id,
          deletionState: { $exists: false },
          $or: [
            { pendingCheckoutWorkflowId: { $exists: false } },
            { pendingCheckoutExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            pendingCheckoutWorkflowId: proposedWorkflowId,
            pendingCheckoutPriceId: stripeConfig.priceId,
            pendingCheckoutExpiresAt: new Date(now.getTime() + 30 * 60 * 1000),
            pendingCheckoutUpdatedAt: now,
          },
          $unset: { pendingCheckoutSessionId: "", pendingCheckoutUrl: "" },
        },
      );
      freshUser = await database.collection("users").findOne({ _id: user._id, deletionState: { $exists: false } });
      if (!freshUser?.pendingCheckoutWorkflowId) return sendApiError(response, 409, "Het account is niet beschikbaar.");
      const workflowId = freshUser.pendingCheckoutWorkflowId;
      const checkoutSession = await client.checkout.sessions.create({
        mode: "subscription",
        branding_settings: STRIPE_CHECKOUT_BRANDING,
        line_items: [{ price: stripeConfig.priceId, quantity: 1 }],
        success_url: `${canonicalBaseUrl(request)}/leden?betaling=geslaagd`,
        cancel_url: `${canonicalBaseUrl(request)}/lid-worden?betaling=geannuleerd`,
        client_reference_id: user._id.toString(),
        metadata: { lvj_resource: STRIPE_RESOURCE_MARKER, userId: user._id.toString(), checkoutWorkflowId: workflowId },
        subscription_data: { metadata: { lvj_resource: STRIPE_RESOURCE_MARKER, userId: user._id.toString(), checkoutWorkflowId: workflowId } },
        ...(freshUser.stripeCustomerId && freshUser.stripeAccountId === stripeConfig.stripeAccountId ? { customer: freshUser.stripeCustomerId } : { customer_email: user.email }),
      }, { idempotencyKey: `membership-checkout-${user._id.toString()}-${stripeConfig.priceId}-${workflowId}` });
      const checkoutExpiresAt = checkoutSession.expires_at ? new Date(checkoutSession.expires_at * 1000) : new Date(now.getTime() + 30 * 60 * 1000);
      await database.collection("users").updateOne(
        { _id: user._id, pendingCheckoutWorkflowId: workflowId, deletionState: { $exists: false } },
        {
          $set: {
            pendingCheckoutSessionId: checkoutSession.id,
            pendingCheckoutUrl: checkoutSession.url,
            pendingCheckoutExpiresAt: checkoutExpiresAt,
            pendingCheckoutUpdatedAt: new Date(),
          },
        },
      );
      return sendJson(response, 200, { checkoutUrl: checkoutSession.url });
    } finally {
      await database.collection("service_locks").deleteOne({ _id: memberLockId, owner: memberLease.owner, fence: memberLease.fence }).catch(() => {});
    }
  }
  if (pathname === "/api/billing/portal" && method === "POST") {
    const user = await requireUser(request);
    if (!allowRate(request, "billing-portal", 20)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const client = stripe();
    const database = await db();
    const memberLockId = `member_mutation:${user._id.toString()}`;
    const memberLease = await acquireServiceLease(database, memberLockId, 120_000);
    if (!memberLease) return sendApiError(response, 409, "Er wordt al een wijziging aan dit account verwerkt.");
    try {
      const freshUser = await database.collection("users").findOne({ _id: user._id, deletionState: { $exists: false } });
      if (!freshUser?.stripeCustomerId) return sendApiError(response, 409, "Er is nog geen Stripe-lidmaatschap om te beheren.");
      const stripeConfig = await ensureStripeConfiguration(database, request);
      if (freshUser.stripeAccountId !== stripeConfig.stripeAccountId) return sendApiError(response, 503, "De betaalomgeving moet eerst worden hersteld.");
      const session = await client.billingPortal.sessions.create({
        customer: freshUser.stripeCustomerId,
        configuration: stripeConfig.portalConfigurationId,
        return_url: `${canonicalBaseUrl(request)}/leden`,
      });
      return sendJson(response, 200, { portalUrl: session.url });
    } finally {
      await database.collection("service_locks").deleteOne({ _id: memberLockId, owner: memberLease.owner, fence: memberLease.fence }).catch(() => {});
    }
  }
  if (pathname === "/api/activities" && method === "GET") {
    const database = await db();
    const activities = await database.collection("activities").find({ status: "published", endsAt: { $gt: new Date() } }).sort({ startsAt: 1 }).limit(100).toArray();
    return sendJson(response, 200, { activities: activities.map(safeActivity) });
  }
  if (pathname === "/api/member/registrations" && method === "GET") {
    const user = await requireUser(request);
    const database = await db();
    const registrations = await database.collection("registrations").aggregate([
      { $match: { userId: user._id } },
      { $lookup: { from: "activities", localField: "activityId", foreignField: "_id", as: "activity" } },
      { $unwind: "$activity" }, { $sort: { "activity.startsAt": 1 } },
    ]).toArray();
    return sendJson(response, 200, {
      registrations: registrations.map(registration => {
        const activity = safeActivity(registration.activity);
        return {
          id: registration._id.toString(),
          createdAt: registration.createdAt,
          status: "registered",
          activity,
          activityTitle: activity.title,
          title: activity.title,
          date: activity.date ? `${activity.date} ${activity.month}` : "",
          startsAt: activity.startsAt,
        };
      }),
    });
  }
  if (pathname === "/api/admin/activities" && method === "GET") {
    await requireAdmin(request);
    const database = await db();
    const activities = await database.collection("activities").find({}).sort({ startsAt: 1 }).limit(250).toArray();
    return sendJson(response, 200, { activities: activities.map(safeActivity) });
  }
  if (pathname === "/api/admin/activities" && method === "POST") {
    await requireAdmin(request);
    if (!allowRate(request, "admin-activity", 60)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const fields = readActivityFields(await readJson(request));
    const database = await db();
    const now = new Date();
    const activity = { ...fields, registeredCount: 0, createdAt: now, updatedAt: now };
    const result = await database.collection("activities").insertOne(activity);
    activity._id = result.insertedId;
    return sendJson(response, 201, { activity: safeActivity(activity) });
  }
  const activityMatch = pathname.match(/^\/api\/activities\/([a-f\d]{24})(?:\/(register))?$/i);
  if (activityMatch && activityMatch[2] === "register" && method === "POST") {
    const user = await requireUser(request);
    if (!allowRate(request, "activity-register", 30)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const activityId = parseId(activityMatch[1]);
    const database = await db();
    try {
      await withTransaction(async session => {
        const liveUser = await database.collection("users").updateOne(
          { _id: user._id, deletionState: { $exists: false } },
          { $set: { lastRegistrationMutationAt: new Date() } },
          { session },
        );
        if (!liveUser.matchedCount) throw Object.assign(new Error("Het account is niet beschikbaar."), { statusCode: 409 });
        const previous = await database.collection("registrations").findOne({ activityId, userId: user._id }, { session });
        if (previous) {
          const error = new Error("Je bent al aangemeld voor deze activiteit.");
          error.statusCode = 409;
          throw error;
        }
        const claimedActivity = await database.collection("activities").findOneAndUpdate(
          {
            _id: activityId,
            status: "published",
            endsAt: { $gt: new Date() },
            $expr: { $lt: [{ $ifNull: ["$registeredCount", 0] }, "$capacity"] },
          },
          { $inc: { registeredCount: 1 }, $set: { updatedAt: new Date() } },
          { session, returnDocument: "after" },
        );
        if (!claimedActivity) {
          const activity = await database.collection("activities").findOne({ _id: activityId, status: "published" }, { session });
          const error = new Error(activity ? "Deze activiteit zit vol of is al afgelopen." : "Deze activiteit is niet beschikbaar.");
          error.statusCode = activity ? 409 : 404;
          throw error;
        }
        await database.collection("registrations").insertOne({
          activityId,
          userId: user._id,
          createdAt: new Date(),
          retentionAt: new Date(claimedActivity.endsAt.getTime() + REGISTRATION_RETENTION_MS),
        }, { session });
      });
    } catch (error) {
      if (error?.code === 11000) return sendApiError(response, 409, "Je bent al aangemeld voor deze activiteit.");
      throw error;
    }
    return sendJson(response, 201, { ok: true, activityId: activityId.toString() });
  }
  if (activityMatch && activityMatch[2] === "register" && method === "DELETE") {
    const user = await requireUser(request);
    if (!allowRate(request, "activity-cancel", 30)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const activityId = parseId(activityMatch[1]);
    const database = await db();
    await withTransaction(async session => {
      const liveUser = await database.collection("users").updateOne(
        { _id: user._id, deletionState: { $exists: false } },
        { $set: { lastRegistrationMutationAt: new Date() } },
        { session },
      );
      if (!liveUser.matchedCount) throw Object.assign(new Error("Het account is niet beschikbaar."), { statusCode: 409 });
      const removed = await database.collection("registrations").deleteOne({ activityId, userId: user._id }, { session });
      if (!removed.deletedCount) {
        const error = new Error("Je hebt geen aanmelding voor deze activiteit.");
        error.statusCode = 404;
        throw error;
      }
      await database.collection("activities").updateOne(
        { _id: activityId, registeredCount: { $gt: 0 } },
        { $inc: { registeredCount: -1 }, $set: { updatedAt: new Date() } },
        { session },
      );
    });
    return sendJson(response, 200, { ok: true });
  }
  if (activityMatch && !activityMatch[2] && method === "GET") {
    const activityId = parseId(activityMatch[1]);
    const database = await db();
    const activity = await database.collection("activities").findOne({ _id: activityId, status: "published" });
    return activity ? sendJson(response, 200, { activity: safeActivity(activity) }) : sendApiError(response, 404, "Niet gevonden.");
  }
  const adminActivityMatch = pathname.match(/^\/api\/admin\/activities\/([a-f\d]{24})(?:\/(registrations))?$/i);
  if (adminActivityMatch && adminActivityMatch[2] === "registrations" && method === "GET") {
    await requireAdmin(request);
    const activityId = parseId(adminActivityMatch[1]);
    const database = await db();
    const registrations = await database.collection("registrations").aggregate([
      { $match: { activityId } },
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
      { $unwind: "$user" }, { $sort: { createdAt: 1 } },
      { $project: { createdAt: 1, "user.name": 1, "user.email": 1 } },
    ]).toArray();
    return sendJson(response, 200, {
      registrations: registrations.map(registration => ({
        id: registration._id.toString(),
        createdAt: registration.createdAt,
        status: "registered",
        name: registration.user.name,
        email: registration.user.email,
        member: { name: registration.user.name, email: registration.user.email },
      })),
    });
  }
  if (adminActivityMatch && !adminActivityMatch[2] && method === "PATCH") {
    await requireAdmin(request);
    const activityId = parseId(adminActivityMatch[1]);
    const database = await db();
    const existing = await database.collection("activities").findOne({ _id: activityId });
    if (!existing) return sendApiError(response, 404, "Niet gevonden.");
    const fields = readActivityFields(await readJson(request), existing);
    let activity;
    await withTransaction(async session => {
      const updated = await database.collection("activities").updateOne(
        { _id: activityId, $expr: { $lte: [{ $ifNull: ["$registeredCount", 0] }, fields.capacity] } },
        { $set: { ...fields, updatedAt: new Date() } },
        { session },
      );
      if (!updated.matchedCount) {
        const live = await database.collection("activities").findOne({ _id: activityId }, { session });
        const error = new Error(live ? "De capaciteit kan niet lager zijn dan het actuele aantal aanmeldingen." : "Niet gevonden.");
        error.statusCode = live ? 409 : 404;
        throw error;
      }
      await database.collection("registrations").updateMany(
        { activityId },
        { $set: { retentionAt: new Date(fields.endsAt.getTime() + REGISTRATION_RETENTION_MS) } },
        { session },
      );
      activity = await database.collection("activities").findOne({ _id: activityId }, { session });
    });
    return sendJson(response, 200, { activity: safeActivity(activity) });
  }
  if (pathname === "/api/admin/members" && method === "GET") {
    await requireAdmin(request);
    const database = await db();
    const url = new URL(request.url || pathname, "http://localhost");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const members = await database.collection("users").find({}, { projection: { passwordHash: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
    return sendJson(response, 200, { members: members.map(safeUser) });
  }
  if (pathname === "/api/admin/transfer" && method === "POST") {
    const admin = await requireAdmin(request);
    if (!allowRate(request, "admin-transfer", 6, 60 * 60 * 1000)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const body = await readJson(request);
    const targetEmail = String(body.email || "").trim().toLowerCase();
    if (!validEmail(targetEmail) || body.confirmation !== "BEHEER OVERDRAGEN") {
      return sendApiError(response, 400, "Controleer het e-mailadres en typ BEHEER OVERDRAGEN.");
    }
    if (typeof body.password !== "string" || !(await comparePassword(body.password, admin.passwordHash))) {
      return sendApiError(response, 401, "Bevestig je huidige wachtwoord.");
    }
    if (targetEmail === admin.email) return sendApiError(response, 400, "Kies het account van de nieuwe beheerder.");
    if (!allowAccountRate("admin-transfer-target", targetEmail, 6, 60 * 60 * 1000)) return sendApiError(response, 429, "Probeer later opnieuw.");

    const database = await db();
    const lease = await acquireServiceLease(database, "admin_role_change", 120_000);
    if (!lease) return sendApiError(response, 409, "Een andere beheerwijziging wordt al verwerkt.");
    try {
      let promotedUser;
      await withTransaction(async session => {
        const liveAdmin = await database.collection("users").findOne(
          { _id: admin._id, role: "admin", deletionState: { $exists: false } },
          { session },
        );
        if (!liveAdmin) throw Object.assign(new Error("Je beheertoegang is gewijzigd. Log opnieuw in."), { statusCode: 409 });
        const target = await database.collection("users").findOne(
          { email: targetEmail, deletionState: { $exists: false } },
          { session },
        );
        if (!target) throw Object.assign(new Error("Laat de nieuwe beheerder eerst zelf een account maken."), { statusCode: 404 });
        if (target.role === "admin") throw Object.assign(new Error("Dit account is al beheerder."), { statusCode: 409 });
        const promoted = await database.collection("users").findOneAndUpdate(
          { _id: target._id, role: { $ne: "admin" }, deletionState: { $exists: false } },
          { $set: { role: "admin", adminPromotedAt: new Date(), adminPromotedBy: admin._id, adminPromotionSource: "admin-transfer" } },
          { session, returnDocument: "after" },
        );
        if (!promoted) throw Object.assign(new Error("De beheerwijziging kon niet worden voltooid."), { statusCode: 409 });
        promotedUser = promoted;
        await writeAudit(database, "admin.transfer.promoted", { actorId: admin._id, subjectId: target._id }, { session });
      });
      return sendJson(response, 200, { member: safeUser(promotedUser) });
    } finally {
      await database.collection("service_locks").deleteOne({ _id: "admin_role_change", owner: lease.owner, fence: lease.fence }).catch(() => {});
    }
  }
  if (pathname === "/api/admin/contact-messages" && method === "GET") {
    await requireAdmin(request);
    const databaseHandle = await db();
    const url = new URL(request.url || pathname, "http://localhost");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const status = url.searchParams.get("status");
    const filter = ["new", "read", "archived"].includes(status) ? { status } : {};
    const messages = await databaseHandle.collection("contact_messages").find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    return sendJson(response, 200, { messages: messages.map(safeContactMessage) });
  }
  const adminContactMatch = pathname.match(/^\/api\/admin\/contact-messages\/([a-f\d]{24})$/i);
  if (adminContactMatch && method === "PATCH") {
    const admin = await requireAdmin(request);
    const body = await readJson(request);
    const status = String(body.status || "");
    if (!["new", "read", "archived"].includes(status)) return sendApiError(response, 400, "Ongeldige berichtstatus.");
    const databaseHandle = await db();
    const messageId = parseId(adminContactMatch[1]);
    const result = await databaseHandle.collection("contact_messages").updateOne(
      { _id: messageId },
      { $set: { status, updatedAt: new Date() } },
    );
    if (!result.matchedCount) return sendApiError(response, 404, "Bericht niet gevonden.");
    await writeAudit(databaseHandle, "contact.status.updated", { actorId: admin._id, subjectId: messageId });
    const message = await databaseHandle.collection("contact_messages").findOne({ _id: messageId });
    return sendJson(response, 200, { message: safeContactMessage(message) });
  }
  return sendApiError(response, 404, "Niet gevonden.");
}

function sendFile(request, response, path, method, status = 200) {
  const fileSize = statSync(path).size;
  const contentType = mime[extname(path)] || "application/octet-stream";
  const baseHeaders = {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (contentType === "video/mp4" && status === 200) {
    const range = String(request.headers.range || "");
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { ...baseHeaders, "Accept-Ranges": "bytes", "Content-Range": `bytes */${fileSize}` });
        return response.end();
      }
      const suffixLength = match[1] ? null : Number(match[2]);
      const start = suffixLength === null ? Number(match[1]) : Math.max(0, fileSize - suffixLength);
      const end = match[2] && suffixLength === null ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= fileSize) {
        response.writeHead(416, { ...baseHeaders, "Accept-Ranges": "bytes", "Content-Range": `bytes */${fileSize}` });
        return response.end();
      }
      response.writeHead(206, {
        ...baseHeaders,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      });
      if (method === "HEAD") return response.end();
      return createReadStream(path, { start, end }).pipe(response);
    }
    baseHeaders["Accept-Ranges"] = "bytes";
  }
  response.writeHead(status, { ...baseHeaders, "Content-Length": fileSize });
  if (method === "HEAD") return response.end();
  createReadStream(path).pipe(response);
}

function sendMethodNotAllowed(response, allow) {
  response.writeHead(405, { ...securityHeaders(), Allow: allow, "Cache-Control": "no-store" });
  response.end();
}

function safeErrorCode(error) {
  return String(error?.code || error?.type || error?.name || "unknown_error").replace(/[^a-z0-9_.-]/gi, "").slice(0, 80);
}

export function createLandVanJanServer() {
  return createServer(async (request, response) => {
    const method = request.method || "GET";
    try {
      const pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname;
      if (pathname === "/api/stripe/webhook") {
        if (method !== "POST") return sendMethodNotAllowed(response, "POST");
        return await handleStripeWebhook(request, response);
      }
      if (pathname.startsWith("/api/")) {
        enforceSameOriginWrite(request);
        return await handleApi(request, response, pathname);
      }
      if (!["GET", "HEAD"].includes(method)) return sendMethodNotAllowed(response, "GET, HEAD");
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(pathname);
      } catch {
        return sendApiError(response, 400, "Ongeldig pad.");
      }
      const relative = normalize(decodedPath).replace(/^[/\\]+/, "");
      const candidate = join(root, relative);
      const isSafeFile = candidate.startsWith(`${root}${sep}`) && existsSync(candidate) && statSync(candidate).isFile();
      if (isSafeFile) return sendFile(request, response, candidate, method);

      const canonicalPath = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
      if (pathname !== canonicalPath && PUBLIC_ROUTES.has(canonicalPath)) {
        response.writeHead(308, { ...securityHeaders(), Location: canonicalPath, "Cache-Control": "no-cache" });
        return response.end();
      }
      if (PUBLIC_ROUTES.has(canonicalPath)) {
        const routeIndex = canonicalPath === "/" ? join(root, "index.html") : join(root, canonicalPath.slice(1), "index.html");
        return sendFile(request, response, existsSync(routeIndex) ? routeIndex : join(root, "index.html"), method);
      }
      const notFound = join(root, "404", "index.html");
      return sendFile(request, response, existsSync(notFound) ? notFound : join(root, "index.html"), method, 404);
    } catch (error) {
      if (!response.headersSent) {
        const status = error.statusCode || 500;
        sendApiError(response, status, status === 503 ? "De service is tijdelijk nog niet beschikbaar." : status >= 500 ? "Er ging iets mis. Probeer later opnieuw." : error.message);
      } else {
        response.end();
      }
      if (![400, 401, 403, 404, 409, 413, 415, 429].includes(error.statusCode)) {
        console.error("Request failed", { statusCode: error.statusCode || 500, code: safeErrorCode(error) });
      }
    }
  });
}

async function warmConfiguredServices() {
  if (apiConfigError()) return;
  const databaseHandle = await db();
  if (!billingConfigError() && canonicalBaseUrl()) {
    const stripeConfig = await ensureStripeConfiguration(databaseHandle, null);
    await processPrivacyDeletionJobs(databaseHandle, stripe(), stripeConfig);
  }
}

async function sweepPrivacyDeletionJobs() {
  if (!database || billingConfigError() || !canonicalBaseUrl()) return;
  if (privacyDeletionSweepPromise) return privacyDeletionSweepPromise;
  privacyDeletionSweepPromise = (async () => {
    const stripeConfig = await ensureStripeConfiguration(database, null);
    await processPrivacyDeletionJobs(database, stripe(), stripeConfig);
  })().finally(() => { privacyDeletionSweepPromise = undefined; });
  return privacyDeletionSweepPromise;
}

setInterval(() => {
  sweepPrivacyDeletionJobs().catch(error => {
    console.error("Privacy deletion retry failed", { code: safeErrorCode(error) });
  });
}, 60 * 1000).unref();

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
let runningServer;
if (isMainModule) {
  runningServer = createLandVanJanServer();
  runningServer.listen(port, "0.0.0.0", () => {
    console.log(`Land van Jan listens on ${port}`);
    warmConfiguredServices().catch(error => {
      console.error("Service warmup failed", { code: safeErrorCode(error) });
    });
  });
  process.on("SIGTERM", async () => {
    await mongoClient?.close();
    runningServer.close(() => process.exit(0));
  });
}
