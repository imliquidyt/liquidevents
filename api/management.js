// api/management.js: data and changes for the Management Panel (managers and owners only).
// Actions:
//   GET  ?action=state    current settings, bot status and the choices for the pickers
//   POST ?action=set      { key, value }            change one setting
//   POST ?action=reset    { key }                   put one setting back to its default
//   POST ?action=presence { status, activityType, activityText }
//   POST ?action=bio      { text }
//   GET  ?action=result&id=<jobId>                  outcome of a change once the bot has applied it
//
// Changes are signed jobs in the bot's queue. The bot checks the person's roles again and does the
// validation, so this file only refuses obviously broken requests.
const { sanitizeValue } = require("./discord-auth-shared");
const panel = require("../lib/panel-shared");

const MAX_VALUE_LENGTH = 20000;
const PRESENCE_FIELDS = ["status", "activityType", "activityText"];

function buildJob(action, body) {
  if (action === "set") {
    const key = sanitizeValue(body.key);
    if (!key || key.length > 100 || body.value === undefined || body.value === null) return null;
    if (JSON.stringify(body.value).length > MAX_VALUE_LENGTH) return null;
    return { type: "setSetting", payload: { key, value: body.value } };
  }
  if (action === "reset") {
    const key = sanitizeValue(body.key);
    return key && key.length <= 100 ? { type: "resetSetting", payload: { key } } : null;
  }
  if (action === "presence") {
    const payload = {};
    for (const field of PRESENCE_FIELDS) {
      if (body[field] === undefined) continue;
      if (typeof body[field] !== "string" || body[field].length > 300) return null;
      payload[field] = body[field];
    }
    return Object.keys(payload).length ? { type: "setPresence", payload } : null;
  }
  if (action === "bio") {
    return typeof body.text === "string" && body.text.length <= 1000
      ? { type: "setBio", payload: { text: body.text } }
      : null;
  }
  return undefined;
}

module.exports = async function handler(req, res) {
  try {
    const auth = await panel.authorize(req, res, "management");
    if (!auth) return;

    const action = sanitizeValue(req.query?.action).toLowerCase();

    if (action === "state") {
      if (req.method !== "GET") return panel.reply(res, 405, { ok: false, error: "Use GET." });
      if (!auth.snapshot) {
        return panel.reply(res, 503, {
          ok: false,
          code: "bot-offline",
          error: "The bot has not shared its settings with the website yet. Is it running?"
        });
      }
      return panel.reply(res, 200, {
        ok: true,
        me: { userId: auth.userId, displayName: auth.displayName, ownerLevel: auth.ownerLevel },
        online: await panel.isBotOnline(),
        snapshot: auth.snapshot
      });
    }

    if (action === "result") {
      return await panel.handleResultRequest(req, res);
    }

    const body = await panel.readWriteRequest(req, res);
    if (!body) return;
    const job = buildJob(action, body);
    if (job === undefined) return panel.reply(res, 404, { ok: false, error: "Unknown action." });
    if (job === null) return panel.reply(res, 400, { ok: false, error: "That request was not valid." });

    if (!(await panel.checkRateLimit(res, auth.userId))) return;
    const queued = await panel.enqueueJob(res, auth.userId, job.type, job.payload);
    if (!queued) return;
    return panel.reply(res, 202, { ok: true, jobId: queued.jobId });
  } catch (error) {
    console.error("management api error:", error);
    return panel.reply(res, 500, { ok: false, error: "Something went wrong on the server." });
  }
};
