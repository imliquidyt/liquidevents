// api/discord-guild.js — Staff role data endpoints
// Actions:
//   GET ?action=me          — returns calling user's staff-role info (session only, no bot)
//   GET ?action=leaderboard — full staff leaderboard (bot required, any staff role)
//   GET ?action=sotm        — staff of the month member(s) (bot required, any staff role)

const {
  sanitizeValue,
  sendJson,
  setCorsHeaders,
  getSessionFromRequest,
  getDiscordConfig,
  ensureDiscordBotConfig
} = require("./discord-auth-shared");

const DISCORD_API = "https://discord.com/api/v10";

// ---- Role definitions ---------------------------------------------------
const STAFF_ROLES = [
  { id: "1437013714355228763", name: "Event Hoster",    rank: 1, color: "#FFD700", emoji: "👑" },
  { id: "1453087719482982491", name: "Head Management", rank: 2, color: "#FF6B6B", emoji: "🔱" },
  { id: "1446824077317640245", name: "Management Team", rank: 3, color: "#FF8E53", emoji: "⚡" },
  { id: "1503462131209867364", name: "Logistics Team",  rank: 4, color: "#38BDF8", emoji: "⚙️" },
  { id: "1504589647840542962", name: "Production Team", rank: 5, color: "#A78BFA", emoji: "🎬" },
  { id: "1451316151429894155", name: "Moderation Team", rank: 5, color: "#34D399", emoji: "🛡️" }
];

const SOTM_ROLE_ID = "1497964612111302877";
const STAFF_ID_SET = new Set(STAFF_ROLES.map(r => r.id));

// ---- Helpers -----------------------------------------------------------
function hasAnyStaffRole(roles) {
  if (!Array.isArray(roles)) return false;
  return roles.some(r => STAFF_ID_SET.has(sanitizeValue(r)));
}

function getHighestRole(roles) {
  let best = null;
  for (const def of STAFF_ROLES) {
    if (roles.includes(def.id)) {
      if (!best || def.rank < best.rank) best = def;
    }
  }
  return best;
}

function avatarUrl(userId, hash, size = 128) {
  const uid  = sanitizeValue(userId);
  const hsh  = sanitizeValue(hash);
  if (!uid || !hsh) return "";
  const ext  = hsh.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${uid}/${hsh}.${ext}?size=${size}`;
}

async function fetchAllGuildMembers(botToken, guildId) {
  const all = [];
  let after = "0";

  for (let page = 0; page < 20; page++) {           // cap at 20 000 members
    const url = `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/members?limit=1000&after=${after}`;
    const res = await fetch(url, { headers: { Authorization: `Bot ${botToken}` } });

    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch {}
      const err = new Error(sanitizeValue(body.message) || "Failed to fetch guild members.");
      err.code = "GUILD_MEMBERS_FETCH_FAILED";
      throw err;
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }

  return all;
}

// ---- Handler -----------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCorsHeaders(req, res);
    res.status(204).end();
    return;
  }

  const session = getSessionFromRequest(req);
  if (!session || !sanitizeValue(session.userId)) {
    sendJson(req, res, 401, { ok: false, error: "Not authenticated." });
    return;
  }

  const sessionRoles = Array.isArray(session.roles)
    ? session.roles.map(r => sanitizeValue(r)).filter(Boolean)
    : [];

  const action = sanitizeValue(req.query?.action).toLowerCase();

  // ---- action=me (no bot token needed, reads session) ------------------
  if (action === "me") {
    const highestRole = getHighestRole(sessionRoles);
    sendJson(req, res, 200, {
      ok: true,
      userId:      sanitizeValue(session.userId),
      displayName: sanitizeValue(session.displayName || session.globalName || session.username),
      avatar:      avatarUrl(session.userId, session.avatar),
      isStaff:     hasAnyStaffRole(sessionRoles),
      highestRole: highestRole || null,
      staffRoles:  STAFF_ROLES.filter(r => sessionRoles.includes(r.id))
    });
    return;
  }

  // ---- All remaining actions require any staff role --------------------
  if (!hasAnyStaffRole(sessionRoles)) {
    sendJson(req, res, 403, { ok: false, error: "Staff access required." });
    return;
  }

  const config = getDiscordConfig(req);
  try {
    ensureDiscordBotConfig(config);
  } catch {
    sendJson(req, res, 503, { ok: false, error: "Discord bot token is not configured on this server." });
    return;
  }

  // ---- action=leaderboard --------------------------------------------
  if (action === "leaderboard") {
    try {
      const members = await fetchAllGuildMembers(config.botToken, config.guildId);

      const staff = members
        .filter(m => m.user && !m.user.bot)
        .reduce((acc, m) => {
          const roles = Array.isArray(m.roles) ? m.roles.map(r => sanitizeValue(r)) : [];
          const top   = getHighestRole(roles);
          if (!top) return acc;
          acc.push({
            userId:       sanitizeValue(m.user.id),
            displayName:  sanitizeValue(m.nick) || sanitizeValue(m.user.global_name) || sanitizeValue(m.user.username),
            username:     sanitizeValue(m.user.username),
            avatar:       avatarUrl(m.user.id, m.user.avatar),
            highestRole:  top,
            allStaffRoles: STAFF_ROLES.filter(r => roles.includes(r.id))
          });
          return acc;
        }, [])
        .sort((a, b) => {
          const d = a.highestRole.rank - b.highestRole.rank;
          return d !== 0 ? d : a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
        });

      sendJson(req, res, 200, { ok: true, leaderboard: staff, total: staff.length });
    } catch (err) {
      sendJson(req, res, 500, { ok: false, code: sanitizeValue(err?.code) || "LEADERBOARD_ERROR", error: sanitizeValue(err?.message) || "Failed." });
    }
    return;
  }

  // ---- action=sotm ---------------------------------------------------
  if (action === "sotm") {
    try {
      const members = await fetchAllGuildMembers(config.botToken, config.guildId);

      const sotm = members
        .filter(m => m.user && !m.user.bot && Array.isArray(m.roles) && m.roles.includes(SOTM_ROLE_ID))
        .map(m => ({
          userId:      sanitizeValue(m.user.id),
          displayName: sanitizeValue(m.nick) || sanitizeValue(m.user.global_name) || sanitizeValue(m.user.username),
          username:    sanitizeValue(m.user.username),
          avatar:      avatarUrl(m.user.id, m.user.avatar, 256)
        }));

      sendJson(req, res, 200, { ok: true, members: sotm });
    } catch (err) {
      sendJson(req, res, 500, { ok: false, code: sanitizeValue(err?.code) || "SOTM_ERROR", error: sanitizeValue(err?.message) || "Failed." });
    }
    return;
  }

  sendJson(req, res, 400, { ok: false, error: "Unknown action." });
};
