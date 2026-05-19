const STAFF_COOLDOWN_SECONDS = 12 * 60 * 60;
const APPLICATIONS_LIST_KEY = "liquid_events_shared_applications_v1";
const MAX_APPLICATIONS = 5000;
const {
  sanitizeValue,
  setCorsHeaders,
  sendJson,
  getSessionFromRequest,
  getDiscordConfig,
  fetchGuildMemberFromBot,
  ensureDiscordBotConfig
} = require("./discord-auth-shared");

function normalizeType(type) {
  const normalized = sanitizeValue(type).toLowerCase();
  if (normalized === "staff" || normalized === "player") {
    return normalized;
  }
  return "unknown";
}

function normalizeReviewStatus(status) {
  const normalized = sanitizeValue(status).toLowerCase();
  if (normalized === "accepted" || normalized === "denied") {
    return normalized;
  }
  return "pending";
}

function buildDiscordAvatarUrlByIdentity(userId, avatarHash, size = 96) {
  const normalizedUserId = sanitizeValue(userId);
  const normalizedAvatarHash = sanitizeValue(avatarHash);
  const parsedSize = Number(size);
  const normalizedSize = Number.isFinite(parsedSize) ? Math.max(16, Math.min(4096, Math.floor(parsedSize))) : 96;
  if (!normalizedUserId || !normalizedAvatarHash) {
    return "";
  }
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(normalizedUserId)}/${encodeURIComponent(normalizedAvatarHash)}.png?size=${normalizedSize}`;
}

function normalizePasteFlags(rawFlags) {
  if (!rawFlags || typeof rawFlags !== "object" || Array.isArray(rawFlags)) {
    return {};
  }

  const normalizedFlags = {};
  Object.entries(rawFlags).forEach(([key, value]) => {
    const normalizedKey = sanitizeValue(key);
    if (!normalizedKey) {
      return;
    }

    if (value === true || value === 1) {
      normalizedFlags[normalizedKey] = true;
      return;
    }

    const normalizedValue = sanitizeValue(value).toLowerCase();
    if (normalizedValue === "true" || normalizedValue === "1") {
      normalizedFlags[normalizedKey] = true;
    }
  });

  return normalizedFlags;
}

async function getAuthContext(req, options = {}) {
  const session = getSessionFromRequest(req);
  const mustRefreshRole = Boolean(options.refreshRole);

  if (!session || !sanitizeValue(session.userId)) {
    return {
      loggedIn: false,
      isStaff: false,
      session: null
    };
  }

  if (!mustRefreshRole) {
    return {
      loggedIn: true,
      isStaff: Boolean(session.isStaff),
      session
    };
  }

  const config = getDiscordConfig(req);
  ensureDiscordBotConfig(config);
  const member = await fetchGuildMemberFromBot(config, session.userId);
  const roleIds = Array.isArray(member?.roles) ? member.roles.map((roleId) => sanitizeValue(roleId)).filter(Boolean) : [];
  return {
    loggedIn: true,
    isStaff: roleIds.includes(config.staffRoleId),
    session
  };
}

function normalizeApplication(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const answers =
    raw.answers && typeof raw.answers === "object" && !Array.isArray(raw.answers)
      ? raw.answers
      : {};

  const id = sanitizeValue(raw.id) || `app-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
  const submittedAt = sanitizeValue(raw.submittedAt) || new Date().toISOString();
  const authUserId = sanitizeValue(raw.authUserId);
  const authUsername = sanitizeValue(raw.authUsername);
  const authDisplayName = sanitizeValue(raw.authDisplayName);
  const authAvatar = sanitizeValue(raw.authAvatar);
  const authAvatarUrl = sanitizeValue(raw.authAvatarUrl) || buildDiscordAvatarUrlByIdentity(authUserId, authAvatar, 96);
  const discordUsername =
    authUsername || authDisplayName || sanitizeValue(raw.discordUsername) || sanitizeValue(answers.discord_username) || "N/A";
  const pasteFlags = normalizePasteFlags(raw.pasteFlags);

  return {
    id,
    type: normalizeType(raw.type),
    submittedAt,
    discordUsername,
    answers,
    authUserId,
    authUsername,
    authDisplayName,
    authAvatar,
    authAvatarUrl,
    pasteFlags,
    reviewStatus: normalizeReviewStatus(raw.reviewStatus),
    reviewedAt: sanitizeValue(raw.reviewedAt)
  };
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return sanitizeValue(req.headers["x-real-ip"]) || "unknown";
}

function parseRequestBody(req) {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  return {};
}

async function redisCommand(command) {
  const url = sanitizeValue(process.env.KV_REST_API_URL) || sanitizeValue(process.env.UPSTASH_REDIS_REST_URL);
  const token = sanitizeValue(process.env.KV_REST_API_TOKEN) || sanitizeValue(process.env.UPSTASH_REDIS_REST_TOKEN);

  if (!url || !token) {
    const missingError = new Error("Shared storage is not configured on the server.");
    missingError.code = "KV_NOT_CONFIGURED";
    throw missingError;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok || payload.error) {
    const redisError = new Error(sanitizeValue(payload.error) || "KV command failed.");
    redisError.code = "KV_COMMAND_FAILED";
    throw redisError;
  }

  return payload.result;
}

async function handleSubmit(req, res) {
  const auth = await getAuthContext(req, { refreshRole: false });
  if (!auth.loggedIn) {
    sendJson(req, res, 401, {
      ok: false,
      code: "AUTH_REQUIRED",
      error: "Sign in with Discord before submitting an application."
    });
    return;
  }

  const rawBody = parseRequestBody(req);
  const application = normalizeApplication(
    {
      ...rawBody,
      authUserId: auth.session.userId,
      authUsername: auth.session.username || "N/A",
      authDisplayName: auth.session.displayName || auth.session.globalName || auth.session.username || "N/A",
      authAvatar: auth.session.avatar || ""
    },
    0
  );

  if (!application) {
    sendJson(req, res, 400, {
      ok: false,
      code: "INVALID_APPLICATION",
      error: "Invalid application payload."
    });
    return;
  }

  const now = Date.now();
  const clientIp = getClientIp(req);
  const cooldownKey = `${APPLICATIONS_LIST_KEY}:cooldown:${clientIp}`;

  const existingCooldownUntilRaw = await redisCommand(["GET", cooldownKey]);
  const existingCooldownUntil = Number(existingCooldownUntilRaw || 0);
  if (existingCooldownUntil > now) {
    const retryAfterSeconds = Math.ceil((existingCooldownUntil - now) / 1000);
    sendJson(req, res, 429, {
      ok: false,
      code: "COOLDOWN_ACTIVE",
      error: "Cooldown active. Please wait before submitting again.",
      retryAfterSeconds
    });
    return;
  }

  const cooldownUntil = now + STAFF_COOLDOWN_SECONDS * 1000;
  await redisCommand(["SET", cooldownKey, String(cooldownUntil), "EX", String(STAFF_COOLDOWN_SECONDS)]);

  await redisCommand(["LPUSH", APPLICATIONS_LIST_KEY, JSON.stringify(application)]);
  await redisCommand(["LTRIM", APPLICATIONS_LIST_KEY, "0", String(MAX_APPLICATIONS - 1)]);

  sendJson(req, res, 200, {
    ok: true,
    application
  });
}

async function handleList(req, res) {
  const auth = await getAuthContext(req, { refreshRole: true });
  if (!auth.loggedIn) {
    sendJson(req, res, 401, {
      ok: false,
      code: "AUTH_REQUIRED",
      error: "Sign in with Discord to view applications."
    });
    return;
  }

  if (!auth.isStaff) {
    sendJson(req, res, 403, {
      ok: false,
      code: "STAFF_ROLE_REQUIRED",
      error: "You need the staff role to access the admin panel."
    });
    return;
  }

  const rawEntries = await redisCommand(["LRANGE", APPLICATIONS_LIST_KEY, "0", "-1"]);
  const applications = (Array.isArray(rawEntries) ? rawEntries : [])
    .map((item, index) => {
      try {
        return normalizeApplication(JSON.parse(item), index);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  sendJson(req, res, 200, {
    ok: true,
    applications
  });
}

async function handleReviewUpdate(req, res) {
  const auth = await getAuthContext(req, { refreshRole: true });
  if (!auth.loggedIn) {
    sendJson(req, res, 401, {
      ok: false,
      code: "AUTH_REQUIRED",
      error: "Sign in with Discord to update reviews."
    });
    return;
  }

  if (!auth.isStaff) {
    sendJson(req, res, 403, {
      ok: false,
      code: "STAFF_ROLE_REQUIRED",
      error: "You need the staff role to update reviews."
    });
    return;
  }

  const body = parseRequestBody(req);
  const applicationId = sanitizeValue(body.id);
  const rawReviewStatus = sanitizeValue(body.reviewStatus || body.status).toLowerCase();
  const reviewStatus = normalizeReviewStatus(rawReviewStatus);

  if (!applicationId) {
    sendJson(req, res, 400, {
      ok: false,
      code: "MISSING_APPLICATION_ID",
      error: "Application id is required."
    });
    return;
  }

  if (!["accepted", "denied", "pending"].includes(rawReviewStatus)) {
    sendJson(req, res, 400, {
      ok: false,
      code: "INVALID_REVIEW_STATUS",
      error: "Review status must be accepted, denied, or pending."
    });
    return;
  }

  const rawEntries = await redisCommand(["LRANGE", APPLICATIONS_LIST_KEY, "0", "-1"]);
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  let matchedIndex = -1;
  let matchedApplication = null;

  for (let index = 0; index < entries.length; index += 1) {
    try {
      const parsed = JSON.parse(entries[index]);
      const normalized = normalizeApplication(parsed, index);
      if (normalized && normalized.id === applicationId) {
        matchedIndex = index;
        matchedApplication = normalized;
        break;
      }
    } catch {
      // Ignore invalid rows and continue.
    }
  }

  if (matchedIndex < 0 || !matchedApplication) {
    sendJson(req, res, 404, {
      ok: false,
      code: "APPLICATION_NOT_FOUND",
      error: "Application not found."
    });
    return;
  }

  const updatedApplication = {
    ...matchedApplication,
    reviewStatus,
    reviewedAt: new Date().toISOString()
  };

  await redisCommand(["LSET", APPLICATIONS_LIST_KEY, String(matchedIndex), JSON.stringify(updatedApplication)]);

  sendJson(req, res, 200, {
    ok: true,
    application: updatedApplication
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      setCorsHeaders(req, res);
      res.status(204).end();
      return;
    }

    if (req.method === "POST") {
      await handleSubmit(req, res);
      return;
    }

    if (req.method === "GET") {
      await handleList(req, res);
      return;
    }

    if (req.method === "PATCH") {
      await handleReviewUpdate(req, res);
      return;
    }

    sendJson(req, res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      error: "Method not allowed."
    });
  } catch (error) {
    const isKvConfigError = sanitizeValue(error?.code) === "KV_NOT_CONFIGURED";
    sendJson(req, res, isKvConfigError ? 503 : 500, {
      ok: false,
      code: sanitizeValue(error?.code) || "SERVER_ERROR",
      error: sanitizeValue(error?.message) || "Server error."
    });
  }
};
