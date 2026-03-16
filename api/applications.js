const STAFF_COOLDOWN_SECONDS = 12 * 60 * 60;
const APPLICATIONS_LIST_KEY = "liquid_events_shared_applications_v1";
const MAX_APPLICATIONS = 5000;
const DEFAULT_ADMIN_PASSWORD = "JkPWJ19dXb#YVV4A3#My50eNrie350";

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password");
}

function sendJson(res, status, payload) {
  setCorsHeaders(res);
  res.status(status).json(payload);
}

function sanitizeValue(value) {
  return String(value || "").trim();
}

function normalizeType(type) {
  const normalized = sanitizeValue(type).toLowerCase();
  if (normalized === "staff" || normalized === "player") {
    return normalized;
  }
  return "unknown";
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
  const discordUsername = sanitizeValue(raw.discordUsername) || sanitizeValue(answers.discord_username) || "N/A";

  return {
    id,
    type: normalizeType(raw.type),
    submittedAt,
    discordUsername,
    answers
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
  const rawBody = parseRequestBody(req);
  const application = normalizeApplication(rawBody, 0);

  if (!application) {
    sendJson(res, 400, {
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
    sendJson(res, 429, {
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

  sendJson(res, 200, {
    ok: true,
    application
  });
}

async function handleList(req, res) {
  const adminPassword = sanitizeValue(process.env.ADMIN_PANEL_PASSWORD) || DEFAULT_ADMIN_PASSWORD;
  const suppliedPassword = sanitizeValue(req.headers["x-admin-password"]);

  if (!suppliedPassword || suppliedPassword !== adminPassword) {
    sendJson(res, 401, {
      ok: false,
      code: "UNAUTHORIZED",
      error: "Unauthorized."
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

  sendJson(res, 200, {
    ok: true,
    applications
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      setCorsHeaders(res);
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

    sendJson(res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      error: "Method not allowed."
    });
  } catch (error) {
    const isKvConfigError = sanitizeValue(error?.code) === "KV_NOT_CONFIGURED";
    sendJson(res, isKvConfigError ? 503 : 500, {
      ok: false,
      code: sanitizeValue(error?.code) || "SERVER_ERROR",
      error: sanitizeValue(error?.message) || "Server error."
    });
  }
};
