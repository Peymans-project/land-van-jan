import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const scrypt = promisify(scryptCallback);
const root = join(process.cwd(), "dist", "client");
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const MAX_JSON_BYTES = 16 * 1024;
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || "land_van_jan";
const sessionSecret = process.env.SESSION_SECRET || "";
const adminEmails = new Set((process.env.ADMIN_EMAILS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripeMembershipPriceId = process.env.STRIPE_MEMBERSHIP_PRICE_ID || "";
const appBaseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const mime = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
};

let mongoClient;
let database;
let indexesPromise;
let stripeClient;
const rateWindows = new Map();

function apiConfigError() {
  if (!mongoUri) return "MONGODB_URI ontbreekt.";
  if (sessionSecret.length < 32) return "SESSION_SECRET moet minimaal 32 tekens zijn.";
  return null;
}

function billingConfigError({ webhook = false } = {}) {
  if (!stripeSecretKey) return "STRIPE_SECRET_KEY ontbreekt.";
  if (!stripeMembershipPriceId && !webhook) return "STRIPE_MEMBERSHIP_PRICE_ID ontbreekt.";
  if (!appBaseUrl && !webhook) return "APP_BASE_URL ontbreekt.";
  if (webhook && !stripeWebhookSecret) return "STRIPE_WEBHOOK_SECRET ontbreekt.";
  return null;
}
function stripe() {
  const error = billingConfigError();
  if (error) { const configurationError = new Error("Betalingen zijn nog niet geconfigureerd."); configurationError.statusCode = 503; throw configurationError; }
  return stripeClient ||= new Stripe(stripeSecretKey);
}

async function db() {
  const configError = apiConfigError();
  if (configError) {
    const error = new Error("Authentication service is not configured.");
    error.statusCode = 503;
    throw error;
  }
  if (!database) {
    mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
    await mongoClient.connect();
    database = mongoClient.db(databaseName);
  }
  if (!indexesPromise) {
    indexesPromise = Promise.all([
      database.collection("users").createIndex({ email: 1 }, { unique: true }),
      database.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      database.collection("sessions").createIndex({ userId: 1 }),
      database.collection("activities").createIndex({ status: 1, startsAt: 1 }),
      database.collection("registrations").createIndex({ activityId: 1, userId: 1 }, { unique: true }),
      database.collection("registrations").createIndex({ userId: 1, createdAt: -1 }),
      database.collection("stripe_events").createIndex({ eventId: 1 }, { unique: true }),
      database.collection("stripe_events").createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
      database.collection("users").createIndex({ stripeCustomerId: 1 }, { sparse: true }),
      database.collection("users").createIndex({ stripeSubscriptionId: 1 }, { sparse: true }),
    ]);
  }
  await indexesPromise;
  return database;
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
  return Object.fromEntries((request.headers.cookie || "").split(";").map(part => part.trim().split(/=(.*)/s)).filter(([key]) => key).map(([key, value]) => [key, decodeURIComponent(value || "")]));
}
function sessionCookie(token, seconds = SESSION_TTL_SECONDS) {
  return `lvj_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${isProduction ? "; Secure" : ""}`;
}
function clearSessionCookie() { return sessionCookie("", 0); }
function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  response.end(JSON.stringify(body));
}
function sendApiError(response, status, message) { sendJson(response, status, { error: message }); }
function safeUser(user) { return { id: user._id.toString(), name: user.name, email: user.email, role: user.role, membershipStatus: user.membershipStatus || "inactive", membershipCurrentPeriodEnd: user.membershipCurrentPeriodEnd || null, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt || null }; }

function requestIp(request) { return (request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").toString().split(",")[0].trim(); }
function allowRate(request, action, limit, windowMs = 15 * 60 * 1000) {
  const key = `${action}:${requestIp(request)}`;
  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || current.resetAt <= now) { rateWindows.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  if (current.count >= limit) return false;
  current.count += 1; return true;
}
function cleanRateWindows() {
  const now = Date.now();
  for (const [key, value] of rateWindows) if (value.resetAt <= now) rateWindows.delete(key);
}
setInterval(cleanRateWindows, 60 * 1000).unref();

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) { const error = new Error("Request body is too large."); error.statusCode = 413; reject(error); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { const error = new Error("Ongeldige JSON."); error.statusCode = 400; reject(error); }
    });
    request.on("error", reject);
  });
}
function readRawBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    request.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) { const error = new Error("Request body is too large."); error.statusCode = 413; reject(error); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
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
async function createSession(database, user) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  const sid = randomUUID();
  await database.collection("sessions").insertOne({ sid, userId: user._id, createdAt: now, expiresAt });
  return makeToken({ sub: user._id.toString(), sid, exp: Math.floor(expiresAt.getTime() / 1000) });
}
async function currentUser(request) {
  const payload = verifyToken(cookies(request).lvj_session);
  if (!payload) return null;
  const database = await db();
  const session = await database.collection("sessions").findOne({ sid: payload.sid, userId: new ObjectId(payload.sub), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  return database.collection("users").findOne({ _id: new ObjectId(payload.sub) });
}

function parseId(value) { return ObjectId.isValid(value) ? new ObjectId(value) : null; }
function safeActivity(activity) {
  return {
    id: activity._id.toString(), title: activity.title, description: activity.description, startsAt: activity.startsAt,
    endsAt: activity.endsAt, location: activity.location, capacity: activity.capacity, registeredCount: activity.registeredCount || 0,
    status: activity.status, createdAt: activity.createdAt, updatedAt: activity.updatedAt,
  };
}
function readActivityFields(body, existing = {}) {
  const title = body.title === undefined ? existing.title : String(body.title || "").trim();
  const description = body.description === undefined ? existing.description : String(body.description || "").trim();
  const location = body.location === undefined ? existing.location : String(body.location || "").trim();
  const startsAt = body.startsAt === undefined ? existing.startsAt : new Date(body.startsAt);
  const endsAt = body.endsAt === undefined ? existing.endsAt : new Date(body.endsAt);
  const capacity = body.capacity === undefined ? existing.capacity : Number(body.capacity);
  const status = body.status === undefined ? existing.status : String(body.status);
  if (!title || title.length > 160 || description.length > 10000 || !location || location.length > 180 || Number.isNaN(startsAt?.getTime()) || Number.isNaN(endsAt?.getTime()) || endsAt <= startsAt || !Number.isInteger(capacity) || capacity < 1 || capacity > 10000 || !["draft", "published", "cancelled"].includes(status)) {
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

function stripeSubscriptionFields(subscription) {
  const currentPeriodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
  return {
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
    stripeSubscriptionId: subscription.id,
    membershipStatus: subscription.status,
    membershipCancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    membershipCurrentPeriodEnd: currentPeriodEnd,
    membershipUpdatedAt: new Date(),
  };
}
async function processStripeEvent(database, event) {
  const object = event.data.object;
  if (event.type === "checkout.session.completed") {
    const userId = object.metadata?.userId || object.client_reference_id;
    if (!parseId(userId)) return;
    const status = object.payment_status === "paid" ? "active" : "pending";
    await database.collection("users").updateOne(
      { _id: parseId(userId) },
      { $set: { stripeCustomerId: typeof object.customer === "string" ? object.customer : object.customer?.id, stripeSubscriptionId: typeof object.subscription === "string" ? object.subscription : object.subscription?.id, membershipStatus: status, membershipUpdatedAt: new Date() } },
    );
    return;
  }
  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    const userId = object.metadata?.userId;
    const filter = parseId(userId) ? { _id: parseId(userId) } : { stripeSubscriptionId: object.id };
    await database.collection("users").updateOne(filter, { $set: stripeSubscriptionFields(object) });
  }
}
async function handleStripeWebhook(request, response) {
  const configurationError = billingConfigError({ webhook: true });
  if (configurationError) return sendApiError(response, 503, "Betalingen zijn nog niet geconfigureerd.");
  const signature = request.headers["stripe-signature"];
  if (typeof signature !== "string") return sendApiError(response, 400, "Stripe-handtekening ontbreekt.");
  const rawBody = await readRawBody(request);
  let event;
  try { event = new Stripe(stripeSecretKey).webhooks.constructEvent(rawBody, signature, stripeWebhookSecret); }
  catch { return sendApiError(response, 400, "Ongeldige Stripe-handtekening."); }
  const database = await db();
  try { await database.collection("stripe_events").insertOne({ eventId: event.id, type: event.type, status: "processing", createdAt: new Date() }); }
  catch (error) {
    if (error?.code === 11000) {
      const previous = await database.collection("stripe_events").findOne({ eventId: event.id });
      if (previous?.status === "processed") return sendJson(response, 200, { received: true, duplicate: true });
      return sendApiError(response, 500, "Webhook wordt opnieuw geprobeerd.");
    }
    throw error;
  }
  try {
    await processStripeEvent(database, event);
    await database.collection("stripe_events").updateOne({ eventId: event.id }, { $set: { status: "processed", processedAt: new Date() } });
  } catch (error) {
    await database.collection("stripe_events").updateOne({ eventId: event.id }, { $set: { status: "failed", failedAt: new Date() } });
    throw error;
  }
  return sendJson(response, 200, { received: true });
}

async function handleApi(request, response, pathname) {
  const method = request.method || "GET";
  if (pathname === "/api/health" && method === "GET") return sendJson(response, 200, { ok: true, authConfigured: !apiConfigError() });
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
    if (!validName(name) || !validEmail(email) || !validPassword(password)) return sendApiError(response, 400, "Controleer naam, e-mailadres en wachtwoord (minimaal 12 tekens)." );
    const database = await db();
    const now = new Date();
    const user = { name, email, passwordHash: await hashPassword(password), role: adminEmails.has(email) ? "admin" : "member", createdAt: now, lastLoginAt: now };
    try { const result = await database.collection("users").insertOne(user); user._id = result.insertedId; }
    catch (error) { if (error?.code === 11000) return sendApiError(response, 409, "Er bestaat al een account voor dit e-mailadres."); throw error; }
    const token = await createSession(database, user);
    return sendJson(response, 201, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(token) });
  }
  if (pathname === "/api/auth/login" && method === "POST") {
    if (!allowRate(request, "login", 15)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = body.password;
    if (!validEmail(email) || typeof password !== "string") return sendApiError(response, 400, "Controleer je gegevens.");
    const database = await db();
    const user = await database.collection("users").findOne({ email });
    if (!user || !(await comparePassword(password, user.passwordHash))) return sendApiError(response, 401, "E-mailadres of wachtwoord klopt niet.");
    const now = new Date();
    await database.collection("users").updateOne({ _id: user._id }, { $set: { lastLoginAt: now } });
    user.lastLoginAt = now;
    const token = await createSession(database, user);
    return sendJson(response, 200, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(token) });
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
  if (pathname === "/api/billing/checkout" && method === "POST") {
    const user = await requireUser(request);
    if (!allowRate(request, "billing-checkout", 10)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const client = stripe();
    const database = await db();
    const freshUser = await database.collection("users").findOne({ _id: user._id });
    if (["active", "trialing", "past_due"].includes(freshUser.membershipStatus)) return sendApiError(response, 409, "Je lidmaatschap is al actief. Beheer het via de ledenomgeving.");
    const session = await client.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: stripeMembershipPriceId, quantity: 1 }],
      success_url: `${appBaseUrl}/leden?betaling=geslaagd&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appBaseUrl}/lid-worden?betaling=geannuleerd`,
      client_reference_id: user._id.toString(),
      metadata: { userId: user._id.toString() },
      subscription_data: { metadata: { userId: user._id.toString() } },
      ...(freshUser.stripeCustomerId ? { customer: freshUser.stripeCustomerId } : { customer_email: user.email }),
    }, { idempotencyKey: `membership-checkout-${user._id.toString()}-${stripeMembershipPriceId}` });
    return sendJson(response, 200, { checkoutUrl: session.url });
  }
  if (pathname === "/api/billing/portal" && method === "POST") {
    const user = await requireUser(request);
    if (!allowRate(request, "billing-portal", 20)) return sendApiError(response, 429, "Probeer later opnieuw.");
    const client = stripe();
    if (!user.stripeCustomerId) return sendApiError(response, 409, "Er is nog geen Stripe-lidmaatschap om te beheren.");
    const session = await client.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${appBaseUrl}/leden` });
    return sendJson(response, 200, { portalUrl: session.url });
  }
  if (pathname === "/api/activities" && method === "GET") {
    const database = await db();
    const activities = await database.collection("activities").find({ status: "published" }).sort({ startsAt: 1 }).limit(100).toArray();
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
    return sendJson(response, 200, { registrations: registrations.map(registration => ({ id: registration._id.toString(), createdAt: registration.createdAt, activity: safeActivity(registration.activity) })) });
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
    const activity = await database.collection("activities").findOne({ _id: activityId, status: "published" });
    if (!activity) return sendApiError(response, 404, "Deze activiteit is niet beschikbaar.");
    const previous = await database.collection("registrations").findOne({ activityId, userId: user._id });
    if (previous) return sendApiError(response, 409, "Je bent al aangemeld voor deze activiteit.");
    const claimed = await database.collection("activities").updateOne({ _id: activityId, status: "published", $expr: { $lt: ["$registeredCount", "$capacity"] } }, { $inc: { registeredCount: 1 }, $set: { updatedAt: new Date() } });
    if (!claimed.modifiedCount) return sendApiError(response, 409, "Deze activiteit zit vol.");
    try {
      await database.collection("registrations").insertOne({ activityId, userId: user._id, createdAt: new Date() });
    } catch (error) {
      await database.collection("activities").updateOne({ _id: activityId, registeredCount: { $gt: 0 } }, { $inc: { registeredCount: -1 }, $set: { updatedAt: new Date() } });
      if (error?.code === 11000) return sendApiError(response, 409, "Je bent al aangemeld voor deze activiteit.");
      throw error;
    }
    return sendJson(response, 201, { ok: true, activityId: activityId.toString() });
  }
  if (activityMatch && activityMatch[2] === "register" && method === "DELETE") {
    const user = await requireUser(request);
    const activityId = parseId(activityMatch[1]);
    const database = await db();
    const removed = await database.collection("registrations").deleteOne({ activityId, userId: user._id });
    if (!removed.deletedCount) return sendApiError(response, 404, "Je hebt geen aanmelding voor deze activiteit.");
    await database.collection("activities").updateOne({ _id: activityId, registeredCount: { $gt: 0 } }, { $inc: { registeredCount: -1 }, $set: { updatedAt: new Date() } });
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
    return sendJson(response, 200, { registrations: registrations.map(registration => ({ id: registration._id.toString(), createdAt: registration.createdAt, member: { name: registration.user.name, email: registration.user.email } })) });
  }
  if (adminActivityMatch && !adminActivityMatch[2] && method === "PATCH") {
    await requireAdmin(request);
    const activityId = parseId(adminActivityMatch[1]);
    const database = await db();
    const existing = await database.collection("activities").findOne({ _id: activityId });
    if (!existing) return sendApiError(response, 404, "Niet gevonden.");
    const fields = readActivityFields(await readJson(request), existing);
    if (fields.capacity < (existing.registeredCount || 0)) return sendApiError(response, 400, "De capaciteit kan niet lager zijn dan het aantal bestaande aanmeldingen.");
    await database.collection("activities").updateOne({ _id: activityId }, { $set: { ...fields, updatedAt: new Date() } });
    const activity = await database.collection("activities").findOne({ _id: activityId });
    return sendJson(response, 200, { activity: safeActivity(activity) });
  }
  if (pathname === "/api/admin/members" && method === "GET") {
    await requireAdmin(request);
    const database = await db();
    const members = await database.collection("users").find({}, { projection: { passwordHash: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
    return sendJson(response, 200, { members: members.map(safeUser) });
  }
  return sendApiError(response, 404, "Niet gevonden.");
}

function sendFile(response, path, method) {
  response.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache", "X-Content-Type-Options": "nosniff" });
  if (method === "HEAD") return response.end();
  createReadStream(path).pipe(response);
}

const server = createServer(async (request, response) => {
  const method = request.method || "GET";
  const pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname;
  try {
    if (pathname === "/api/stripe/webhook") {
      if (method !== "POST") { response.writeHead(405, { Allow: "POST" }); return response.end(); }
      return await handleStripeWebhook(request, response);
    }
    if (pathname.startsWith("/api/")) return await handleApi(request, response, pathname);
    if (!["GET", "HEAD"].includes(method)) { response.writeHead(405, { Allow: "GET, HEAD" }); return response.end(); }
    const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
    const candidate = join(root, relative);
    const isSafeFile = candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile();
    sendFile(response, isSafeFile ? candidate : join(root, "index.html"), method);
  } catch (error) {
    if (!response.headersSent) {
      const status = error.statusCode || 500;
      sendApiError(response, status, status === 503 ? "De ledenservice is nog niet geconfigureerd." : status >= 500 ? "Er ging iets mis. Probeer later opnieuw." : error.message);
    } else response.end();
    if (error.statusCode !== 400 && error.statusCode !== 401 && error.statusCode !== 403 && error.statusCode !== 409 && error.statusCode !== 413 && error.statusCode !== 429) console.error("Request failed", error);
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Land van Jan listens on ${port}`));
process.on("SIGTERM", async () => { await mongoClient?.close(); server.close(() => process.exit(0)); });
