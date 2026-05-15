const {
  sanitizeValue,
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
} = require("./discord-auth-shared");

function redirectWithCookies(req, res, targetUrl) {
  setCorsHeaders(req, res);
  res.statusCode = 302;
  res.setHeader("Location", targetUrl);
  res.end();
}

function decodeReturnFromState(statePayload) {
  const normalized = sanitizeValue(statePayload);
  if (!normalized.includes(".")) {
    return "/index.html";
  }
  const encodedReturn = normalized.split(".").slice(1).join(".");
  if (!encodedReturn) {
    return "/index.html";
  }
  try {
    return getRelativeReturnUrl(Buffer.from(encodedReturn, "base64url").toString("utf8"));
  } catch {
    return "/index.html";
  }
}

async function handleLogin(req, res) {
  const config = getDiscordConfig(req);
  ensureDiscordOAuthConfig(config);

  const requestedReturnTo = getRelativeReturnUrl(req?.query?.returnTo);
  const nonce = createOAuthState();
  const encodedReturnTo = Buffer.from(requestedReturnTo).toString("base64url");
  const fullState = `${nonce}.${encodedReturnTo}`;

  setOauthStateCookie(req, res, fullState);
  const authorizeUrl = buildDiscordAuthorizeUrl(config, fullState);
  redirectWithCookies(req, res, authorizeUrl);
}

async function handleCallback(req, res) {
  const config = getDiscordConfig(req);
  ensureDiscordOAuthConfig(config);
  ensureDiscordBotConfig(config);

  const code = sanitizeValue(req?.query?.code);
  const incomingState = sanitizeValue(req?.query?.state);
  const expectedState = getOauthStateFromRequest(req);

  clearOauthStateCookie(req, res);

  if (!code || !incomingState || !expectedState || incomingState !== expectedState) {
    redirectWithCookies(req, res, "/index.html?login=failed");
    return;
  }

  const tokenPayload = await exchangeCodeForToken(config, code);
  const user = await fetchDiscordCurrentUser(tokenPayload.access_token);
  const member = await fetchGuildMemberFromBot(config, user.id);
  const session = buildSessionFromDiscordData(config, user, member);

  if (!session.userId) {
    redirectWithCookies(req, res, "/index.html?login=failed");
    return;
  }

  setSessionCookie(req, res, session);
  const returnTo = decodeReturnFromState(incomingState);
  redirectWithCookies(req, res, returnTo);
}

async function handleSession(req, res) {
  const session = getSessionFromRequest(req);
  if (!session) {
    sendJson(req, res, 200, {
      ok: true,
      loggedIn: false
    });
    return;
  }

  let refreshedSession = session;
  if (sanitizeValue(req?.query?.refreshRole) === "1") {
    const config = getDiscordConfig(req);
    ensureDiscordBotConfig(config);
    const member = await fetchGuildMemberFromBot(config, session.userId);
    refreshedSession = {
      ...session,
      guildMember: Boolean(member),
      isStaff: Array.isArray(member?.roles) ? member.roles.includes(config.staffRoleId) : false,
      roles: Array.isArray(member?.roles) ? member.roles.map((roleId) => sanitizeValue(roleId)).filter(Boolean) : []
    };
    setSessionCookie(req, res, refreshedSession);
  }

  sendJson(req, res, 200, {
    ok: true,
    loggedIn: true,
    user: {
      id: sanitizeValue(refreshedSession.userId),
      username: sanitizeValue(refreshedSession.username),
      globalName: sanitizeValue(refreshedSession.globalName),
      displayName: sanitizeValue(refreshedSession.displayName || refreshedSession.globalName || refreshedSession.username),
      avatar: sanitizeValue(refreshedSession.avatar),
      guildMember: Boolean(refreshedSession.guildMember),
      isStaff: Boolean(refreshedSession.isStaff)
    }
  });
}

async function handleLogout(req, res) {
  clearSessionCookie(req, res);
  clearOauthStateCookie(req, res);
  sendJson(req, res, 200, {
    ok: true,
    loggedIn: false
  });
}

module.exports = async (req, res) => {
  const action = sanitizeValue(req?.query?.action).toLowerCase();
  try {
    if (req.method === "OPTIONS") {
      setCorsHeaders(req, res);
      res.status(204).end();
      return;
    }

    if (req.method === "GET" && action === "login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "GET" && action === "callback") {
      await handleCallback(req, res);
      return;
    }

    if (req.method === "GET" && action === "session") {
      await handleSession(req, res);
      return;
    }

    if (req.method === "POST" && action === "logout") {
      await handleLogout(req, res);
      return;
    }

    sendJson(req, res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      error: "Method not allowed."
    });
  } catch (error) {
    if (req.method === "GET" && (action === "login" || action === "callback")) {
      setCorsHeaders(req, res);
      res.statusCode = 302;
      res.setHeader("Location", "/index.html?login=failed");
      res.end();
      return;
    }
    const errorCode = sanitizeValue(error?.code) || "DISCORD_AUTH_ERROR";
    sendJson(req, res, 500, {
      ok: false,
      code: errorCode,
      error: sanitizeValue(error?.message) || "Discord authentication failed."
    });
  }
};
