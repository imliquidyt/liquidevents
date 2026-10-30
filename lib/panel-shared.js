// Shared helpers for the Management and Moderation panels (api/management.js, api/moderation.js).
//
// The panels talk to the Discord bot through the Upstash Redis database this site already uses.
// The key names and the job format below are a contract with the bot (src/services/webSync in the
// bot repo); change them in both places together.
const crypto = require("node:crypto");
const {
  sanitizeValue,
  getSessionFromRequest,
  getDiscordConfig,
  fetchGuildMemberFromBot
} = require("../api/discord-auth-shared");

const KEYS = {
  snapshot: "liquidbot:snapshot",
  cases: "liquidbot:cases",
  queue: "liquidbot:queue",
  heartbeat: "liquidbot:heartbeat",
  result: (jobId) => `liquidbot:result:${jobId}`,
  rateLimit: (userId, minute) => `liquidbot:ratelimit:${userId}:${minute}`
};

// Same pattern as the Applications panel: an environment variable, with the live server's value
// as the fallback. The moderation (staff team) role is read from the bot instead, so it follows
// what is set in the management panel.
const DEFAULT_OWNER_ROLE_ID = "1437013714355228763"; // Event Hoster
const DEFAULT_MANAGER_ROLE_ID = "1446824077317640245"; // Management Team
const DEFAULT_STAFF_ROLE_ID = "1451316151429894155"; // Moderation Team

const WRITES_PER_MINUTE = 20;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const SNOWFLAKE_PATTERN = /^\d{15,25}$/;

function reply(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(payload);
}

function getUpstashConfig() {
  const url = sanitizeValue(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL).replace(/\/+$/, "");
  const token = sanitizeValue(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  return url && token ? { url, token } : null;
}

async function redis(args) {
  const config = getUpstashConfig();
  if (!config) {
    const error = new Error("The database is not configured.");
    error.code = "NOT_CONFIGURED";
    throw error;
  }
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(sanitizeValue(data.error) || `Database request failed (${response.status}).`);
  }
  return data.result;
}

async function redisGetJson(key) {
  const raw = await redis(["GET", key]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** True while the bot has checked in during the last few minutes. */
async function isBotOnline() {
  return Boolean(await redis(["GET", KEYS.heartbeat]));
}

function getRoleConfig() {
  return {
    ownerRoleId: sanitizeValue(process.env.DISCORD_OWNER_ROLE_ID) || DEFAULT_OWNER_ROLE_ID,
    managerRoleId: sanitizeValue(process.env.DISCORD_MANAGER_ROLE_ID) || DEFAULT_MANAGER_ROLE_ID,
    staffRoleId: sanitizeValue(process.env.DISCORD_MOD_ROLE_ID) || DEFAULT_STAFF_ROLE_ID
  };
}

function isSameOrigin(req) {
  const origin = sanitizeValue(req.headers?.origin);
  if (!origin) return true; // same-origin GETs and non-browser calls carry no Origin header
  const host = sanitizeValue(req.headers?.["x-forwarded-host"]) || sanitizeValue(req.headers?.host);
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Checks who is calling and whether they may open this panel ("management" or "moderation").
 * Their roles are read from Discord right now, never from the session cookie (which can be weeks old).
 * Sends the error response itself and returns null when access is refused.
 */
async function authorize(req, res, panel) {
  if (!isSameOrigin(req)) {
    reply(res, 403, { ok: false, code: "origin", error: "Request blocked." });
    return null;
  }

  const session = getSessionFromRequest(req);
  const userId = sanitizeValue(session?.userId);
  if (!userId) {
    reply(res, 401, { ok: false, code: "login", error: "Please sign in with Discord." });
    return null;
  }

  let member;
  let snapshot = null;
  try {
    member = await fetchGuildMemberFromBot(getDiscordConfig(req), userId);
    snapshot = await redisGetJson(KEYS.snapshot);
  } catch (error) {
    console.error("Panel access check failed:", error.message);
    reply(res, 503, { ok: false, code: "unavailable", error: "Could not verify your access right now." });
    return null;
  }

  const roles = Array.isArray(member?.roles) ? member.roles.map((role) => sanitizeValue(role)) : [];
  const config = getRoleConfig();
  const isServerOwner = Boolean(snapshot?.guild?.ownerId) && snapshot.guild.ownerId === userId;
  const isOwner = isServerOwner || roles.includes(config.ownerRoleId);
  const isManager = roles.includes(config.managerRoleId);
  const staffRoleId = sanitizeValue(snapshot?.access?.staffRoleId) || config.staffRoleId;
  const isStaff = roles.includes(staffRoleId);

  const allowed = panel === "management" ? isOwner || isManager : isOwner || isManager || isStaff;
  if (!allowed) {
    reply(res, 403, {
      ok: false,
      code: "denied",
      error:
        panel === "management"
          ? "The Management Panel is only for managers and owners."
          : "The Moderation Panel is only for the moderation team, managers and owners."
    });
    return null;
  }

  // What the bot treats as owner level decides which settings are locked; the bot itself enforces it.
  const botOwnerRoleId = sanitizeValue(snapshot?.access?.ownerRoleId) || config.ownerRoleId;
  return {
    userId,
    displayName: sanitizeValue(session.displayName || session.globalName || session.username),
    ownerLevel: isServerOwner || roles.includes(botOwnerRoleId),
    snapshot
  };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return null;
}

/** Only JSON posts from this site are accepted for changes. Returns the body, or null after replying. */
async function readWriteRequest(req, res) {
  if (req.method !== "POST") {
    reply(res, 405, { ok: false, error: "Use POST for changes." });
    return null;
  }
  if (!String(req.headers?.["content-type"] || "").toLowerCase().startsWith("application/json")) {
    reply(res, 415, { ok: false, error: "Expected JSON." });
    return null;
  }
  const body = await readJsonBody(req);
  if (!body || typeof body !== "object") {
    reply(res, 400, { ok: false, error: "That request could not be read." });
    return null;
  }
  return body;
}

/** At most a few changes per minute per person. Returns true when the request may continue. */
async function checkRateLimit(res, userId) {
  const key = KEYS.rateLimit(userId, Math.floor(Date.now() / 60000));
  const count = await redis(["INCR", key]);
  if (count === 1) await redis(["EXPIRE", key, "90"]);
  if (count > WRITES_PER_MINUTE) {
    reply(res, 429, { ok: false, error: "Too many changes at once. Wait a minute and try again." });
    return false;
  }
  return true;
}

function signJob(job) {
  const secret = sanitizeValue(process.env.WEBSYNC_SECRET);
  const body = JSON.stringify(job);
  return JSON.stringify({ body, sig: crypto.createHmac("sha256", secret).update(body).digest("hex") });
}

/**
 * Puts a change in the bot's queue. Refused while the bot is offline, so changes never pile up and
 * then apply hours later. Returns { jobId } or sends the error response and returns null.
 */
async function enqueueJob(res, userId, type, payload) {
  if (!sanitizeValue(process.env.WEBSYNC_SECRET)) {
    reply(res, 503, { ok: false, error: "The bot link is not set up on the website yet (WEBSYNC_SECRET)." });
    return null;
  }
  if (!(await isBotOnline())) {
    reply(res, 503, {
      ok: false,
      code: "bot-offline",
      error: "The bot is offline or not connected to the website, so changes can't be applied right now."
    });
    return null;
  }
  const jobId = crypto.randomBytes(12).toString("hex");
  await redis(["RPUSH", KEYS.queue, signJob({ id: jobId, type, by: { id: userId }, at: Date.now(), payload })]);
  return { jobId };
}

async function handleResultRequest(req, res) {
  const jobId = sanitizeValue(req.query?.id);
  if (!JOB_ID_PATTERN.test(jobId)) {
    reply(res, 400, { ok: false, error: "Invalid request id." });
    return;
  }
  const result = await redisGetJson(KEYS.result(jobId));
  reply(res, 200, { ok: true, done: Boolean(result), result });
}

module.exports = {
  KEYS,
  SNOWFLAKE_PATTERN,
  reply,
  redis,
  redisGetJson,
  isBotOnline,
  authorize,
  readWriteRequest,
  checkRateLimit,
  enqueueJob,
  handleResultRequest
};
