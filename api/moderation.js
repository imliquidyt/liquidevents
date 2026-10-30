// api/moderation.js: data and notes for the Moderation Panel (moderation team, managers, owners).
// Actions:
//   GET  ?action=cases   the latest moderation cases the bot has shared
//   POST ?action=note    { userId, text }   add a moderation note about a member
//   GET  ?action=result&id=<jobId>          outcome of a note once the bot has saved it
const { sanitizeValue } = require("./discord-auth-shared");
const panel = require("../lib/panel-shared");

const MAX_NOTE_LENGTH = 1000;

module.exports = async function handler(req, res) {
  try {
    const auth = await panel.authorize(req, res, "moderation");
    if (!auth) return;

    const action = sanitizeValue(req.query?.action).toLowerCase();

    if (action === "cases") {
      if (req.method !== "GET") return panel.reply(res, 405, { ok: false, error: "Use GET." });
      const data = await panel.redisGetJson(panel.KEYS.cases);
      if (!data) {
        return panel.reply(res, 503, {
          ok: false,
          code: "bot-offline",
          error: "The bot has not shared any cases with the website yet. Is it running?"
        });
      }
      return panel.reply(res, 200, {
        ok: true,
        me: { userId: auth.userId, displayName: auth.displayName },
        online: await panel.isBotOnline(),
        updatedAt: data.updatedAt,
        total: data.total,
        cases: data.cases
      });
    }

    if (action === "result") {
      return await panel.handleResultRequest(req, res);
    }

    if (action === "note") {
      const body = await panel.readWriteRequest(req, res);
      if (!body) return;
      const userId = sanitizeValue(body.userId);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!panel.SNOWFLAKE_PATTERN.test(userId)) {
        return panel.reply(res, 400, { ok: false, error: "Enter the member's Discord ID (digits only)." });
      }
      if (!text || text.length > MAX_NOTE_LENGTH) {
        return panel.reply(res, 400, { ok: false, error: `A note needs 1 to ${MAX_NOTE_LENGTH} characters.` });
      }
      if (!(await panel.checkRateLimit(res, auth.userId))) return;
      const queued = await panel.enqueueJob(res, auth.userId, "addNote", { userId, text });
      if (!queued) return;
      return panel.reply(res, 202, { ok: true, jobId: queued.jobId });
    }

    return panel.reply(res, 404, { ok: false, error: "Unknown action." });
  } catch (error) {
    console.error("moderation api error:", error);
    return panel.reply(res, 500, { ok: false, error: "Something went wrong on the server." });
  }
};
