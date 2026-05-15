const crypto = require("node:crypto");

const DISCORD_API_BASE = "https://discord.com/api/v10";
const SESSION_COOKIE_NAME = "liquid_events_discord_session_v1";
const OAUTH_STATE_COOKIE_NAME = "liquid_events_discord_oauth_state_v1";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const STATE_MAX_AGE_SECONDS = 10 * 60;

const DEFAULT_GUILD_ID = "1437011415478304801";
const DEFAULT_STAFF_ROLE_ID = "1446824077317640245";

function sanitizeValue(value) {
  return String(value || "").trim();
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", [cookieValue]);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookieValue]);
    return;
  }
  res.setHeader("Set-Cookie", [String(existing), cookieValue]);
}

function parseCookies(req) {
  const rawHeader = sanitizeValue(req?.headers?.cookie);
  if (!rawHeader) {
    return {};
  }

  return rawHeader.split(";").reduce((accumulator, pair) => {
    const [rawName, ...rest] = pair.split("=");
    const name = sanitizeValue(rawName);
    if (!name) {
      return accumulator;
    }
    const rawValue = rest.join("=");
    try {
      accumulator[name] = decodeURIComponent(rawValue);
    } catch {
      accumulator[name] = rawValue;
    }
    return accumulator;
  }, {});
}

function isSecureRequest(req) {
  const forwardedProto = sanitizeValue(req?.headers?.["x-forwarded-proto"]).toLowerCase();
  if (forwardedProto) {
    return forwardedProto === "https";
  }
  return Boolean(req?.socket?.encrypted);
}

function serializeCookie(name, value, options = {}) {
  const segments = [`${name}=${encodeURIComponent(String(value))}`];
  const maxAge = Number(options.maxAge || 0);
  if (maxAge > 0) {
    segments.push(`Max-Age=${Math.floor(maxAge)}`);
  }
  segments.push(`Path=${options.path || "/"}`);
  if (options.httpOnly !== false) {
    segments.push("HttpOnly");
  }
  const sameSite = sanitizeValue(options.sameSite || "Lax");
  if (sameSite) {
    segments.push(`SameSite=${sameSite}`);
  }
  if (options.secure) {
    segments.push("Secure");
  }
  return segments.join("; ");
}

function getSessionSecret() {
  return (
    sanitizeValue(process.env.DISCORD_SESSION_SECRET) ||
    sanitizeValue(process.env.AUTH_SESSION_SECRET) ||
    sanitizeValue(process.env.ADMIN_PANEL_PASSWORD) ||
    ""
  );
}

function signPayload(encodedPayload) {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("Missing DISCORD_SESSION_SECRET.");
  }
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function createSignedSession(payload) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sessionBody = {
    ...payload,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_MAX_AGE_SECONDS
  };
  const encoded = base64UrlEncode(JSON.stringify(sessionBody));
  const signature = signPayload(encoded);
  return `${encoded}.${signature}`;
}

function readSignedSession(token) {
  const normalizedToken = sanitizeValue(token);
  if (!normalizedToken || !normalizedToken.includes(".")) {
    return null;
  }

  const [encodedPayload, signature] = normalizedToken.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  let expectedSignature = "";
  try {
    expectedSignature = signPayload(encodedPayload);
  } catch {
    return null;
  }

  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(base64UrlDecode(encodedPayload));
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!decoded || typeof decoded !== "object" || Number(decoded.exp || 0) <= nowSeconds) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  return readSignedSession(cookies[SESSION_COOKIE_NAME]);
}

function setSessionCookie(req, res, payload) {
  const token = createSignedSession(payload);
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE_NAME, token, {
      maxAge: SESSION_MAX_AGE_SECONDS,
      secure: isSecureRequest(req),
      sameSite: "Lax",
      httpOnly: true
    })
  );
}

function clearSessionCookie(req, res) {
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE_NAME, "", {
      maxAge: 0,
      secure: isSecureRequest(req),
      sameSite: "Lax",
      httpOnly: true
    })
  );
}

function setOauthStateCookie(req, res, state) {
  appendSetCookie(
    res,
    serializeCookie(OAUTH_STATE_COOKIE_NAME, state, {
      maxAge: STATE_MAX_AGE_SECONDS,
      secure: isSecureRequest(req),
      sameSite: "Lax",
      httpOnly: true
    })
  );
}

function getOauthStateFromRequest(req) {
  const cookies = parseCookies(req);
  return sanitizeValue(cookies[OAUTH_STATE_COOKIE_NAME]);
}

function clearOauthStateCookie(req, res) {
  appendSetCookie(
    res,
    serializeCookie(OAUTH_STATE_COOKIE_NAME, "", {
      maxAge: 0,
      secure: isSecureRequest(req),
      sameSite: "Lax",
      httpOnly: true
    })
  );
}

function setCorsHeaders(req, res) {
  const origin = sanitizeValue(req?.headers?.origin);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(req, res, status, payload) {
  setCorsHeaders(req, res);
  res.status(status).json(payload);
}

function getRequestOrigin(req) {
  const explicitBase = sanitizeValue(process.env.PUBLIC_BASE_URL) || sanitizeValue(process.env.APP_BASE_URL);
  if (explicitBase) {
    return explicitBase.replace(/\/+$/, "");
  }
  const host = sanitizeValue(req?.headers?.["x-forwarded-host"]) || sanitizeValue(req?.headers?.host);
  if (!host) {
    return "";
  }
  const proto = sanitizeValue(req?.headers?.["x-forwarded-proto"]) || "https";
  return `${proto}://${host}`;
}

function getDiscordConfig(req) {
  const baseOrigin = getRequestOrigin(req);
  const redirectUri =
    sanitizeValue(process.env.DISCORD_REDIRECT_URI) ||
    sanitizeValue(process.env.DISCORD_AUTH_REDIRECT_URI) ||
    (baseOrigin ? `${baseOrigin}/api/discord-auth?action=callback` : "");

  return {
    clientId: sanitizeValue(process.env.DISCORD_CLIENT_ID),
    clientSecret: sanitizeValue(process.env.DISCORD_CLIENT_SECRET),
    botToken: sanitizeValue(process.env.DISCORD_BOT_TOKEN),
    guildId: sanitizeValue(process.env.DISCORD_GUILD_ID) || DEFAULT_GUILD_ID,
    staffRoleId: sanitizeValue(process.env.DISCORD_STAFF_ROLE_ID) || DEFAULT_STAFF_ROLE_ID,
    redirectUri
  };
}

function ensureDiscordOAuthConfig(config) {
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    const error = new Error("Discord OAuth configuration is incomplete.");
    error.code = "DISCORD_OAUTH_NOT_CONFIGURED";
    throw error;
  }
}

function ensureDiscordBotConfig(config) {
  if (!config.botToken || !config.guildId || !config.staffRoleId) {
    const error = new Error("Discord guild role verification is not configured.");
    error.code = "DISCORD_BOT_NOT_CONFIGURED";
    throw error;
  }
}

function createOAuthState() {
  return crypto.randomBytes(32).toString("hex");
}

function buildDiscordAuthorizeUrl(config, state) {
  const scope = encodeURIComponent("identify");
  const redirectUri = encodeURIComponent(config.redirectUri);
  return `https://discord.com/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(
    config.clientId
  )}&scope=${scope}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}`;
}

async function exchangeCodeForToken(config, code) {
  ensureDiscordOAuthConfig(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: sanitizeValue(code),
    redirect_uri: config.redirectUri
  });

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded"
  };
  if (config.clientId && config.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  }

  const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: "POST",
    headers,
    body
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok || !sanitizeValue(payload.access_token)) {
    const error = new Error(sanitizeValue(payload.error_description) || "Could not exchange Discord OAuth code.");
    error.code = "DISCORD_TOKEN_EXCHANGE_FAILED";
    throw error;
  }

  return payload;
}

async function fetchDiscordCurrentUser(accessToken) {
  const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: {
      Authorization: `Bearer ${sanitizeValue(accessToken)}`
    }
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok || !sanitizeValue(payload.id)) {
    const error = new Error(sanitizeValue(payload.message) || "Could not fetch Discord user.");
    error.code = "DISCORD_USER_FETCH_FAILED";
    throw error;
  }

  return payload;
}

async function fetchGuildMemberFromBot(config, userId) {
  ensureDiscordBotConfig(config);
  const normalizedUserId = sanitizeValue(userId);
  const response = await fetch(`${DISCORD_API_BASE}/guilds/${config.guildId}/members/${normalizedUserId}`, {
    headers: {
      Authorization: `Bot ${config.botToken}`
    }
  });

  if (response.status === 404) {
    return null;
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(sanitizeValue(payload.message) || "Could not verify Discord guild membership.");
    error.code = "DISCORD_GUILD_MEMBER_FETCH_FAILED";
    throw error;
  }

  return payload;
}

function buildSessionFromDiscordData(config, user, member) {
  const roles = Array.isArray(member?.roles) ? member.roles.map((role) => sanitizeValue(role)).filter(Boolean) : [];
  const username = sanitizeValue(user?.username);
  const globalName = sanitizeValue(user?.global_name);
  const discriminator = sanitizeValue(user?.discriminator);

  return {
    userId: sanitizeValue(user?.id),
    username,
    globalName,
    discriminator,
    avatar: sanitizeValue(user?.avatar),
    displayName: globalName || username,
    guildMember: Boolean(member),
    isStaff: roles.includes(config.staffRoleId),
    roles
  };
}

function getRelativeReturnUrl(rawValue) {
  const normalized = sanitizeValue(rawValue);
  if (!normalized.startsWith("/")) {
    return "/index.html";
  }
  if (normalized.startsWith("//")) {
    return "/index.html";
  }
  return normalized;
}

module.exports = {
  SESSION_COOKIE_NAME,
  sanitizeValue,
  parseCookies,
  setCorsHeaders,
  sendJson,
  getSessionFromRequest,
  setSessionCookie,
  clearSessionCookie,
  setOauthStateCookie,
  getOauthStateFromRequest,
  clearOauthStateCookie,
  getDiscordConfig,
  createOAuthState,
  buildDiscordAuthorizeUrl,
  exchangeCodeForToken,
  fetchDiscordCurrentUser,
  fetchGuildMemberFromBot,
  buildSessionFromDiscordData,
  getRelativeReturnUrl,
  ensureDiscordOAuthConfig,
  ensureDiscordBotConfig
};
