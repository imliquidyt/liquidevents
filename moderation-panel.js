// Moderation Panel: recent moderation cases (read-only) and moderation notes.
// Data comes from /api/moderation; the bot shares its latest cases and saves new notes.
(function () {
  "use strict";

  const { h, api, submit, toast, timeAgo, formatDuration } = Panel;

  const ROUTE = "#moderation-panel";
  const PAGE_SIZE = 50;
  const MAX_NOTE = 1000;
  const TYPES = [
    ["all", "All"], ["warn", "Warnings"], ["note", "Notes"], ["timeout", "Timeouts"], ["untimeout", "Timeouts removed"],
    ["kick", "Kicks"], ["ban", "Bans"], ["unban", "Unbans"], ["automod", "Automod"]
  ];
  const TYPE_LABELS = { warn: "WARN", note: "NOTE", timeout: "TIMEOUT", untimeout: "TIMEOUT REMOVED", kick: "KICK", ban: "BAN", unban: "UNBAN", automod: "AUTOMOD" };
  const RULE_LABELS = { spam: "Spam", invites: "Invite link", links: "Link", mentions: "Too many mentions", caps: "Too many capitals", blockedWords: "Blocked word" };
  const ACTION_LABELS = { removed: "message removed", timed_out: "member timed out", logged: "logged only" };
  const SOURCE_LABELS = { website: "added on the website", command: "slash command", discord: "done in Discord", automod: "automod", security: "security trap" };

  const root = document.getElementById("panelRoot");
  let data = null;
  let built = false;
  let shown = PAGE_SIZE;
  const filters = { q: "", type: "all", userId: null };
  const el = {};

  // ---- loading

  async function load(silent) {
    if (!silent && !built) root.replaceChildren(h("p", { class: "pn-loading", text: "Loading cases…" }));
    const response = await api("moderation", "cases");
    if (Panel.handleAccessError(root, response, ROUTE, () => { built = false; load(false); })) { built = false; return; }
    data = response.data;
    if (!built) buildShell();
    renderAll();
  }

  // ---- filtering

  function matches(c) {
    if (filters.userId && c.userId !== filters.userId) return false;
    if (filters.type !== "all" && c.type !== filters.type) return false;
    const q = filters.q.trim().toLowerCase();
    if (!q) return true;
    if (/^#\d+$/.test(q)) return c.number === Number(q.slice(1));
    if (/^\d{15,25}$/.test(q)) return c.userId === q || c.moderatorId === q;
    return [c.userName, c.moderatorName, c.reason, c.excerpt, c.userId, RULE_LABELS[c.rule]]
      .some((value) => value && String(value).toLowerCase().includes(q));
  }

  // ---- pieces

  function caseCard(c) {
    const moderator = c.source === "automod" ? "Automod" : c.moderatorName || "Unknown moderator";
    const facts = [`By ${moderator}`, SOURCE_LABELS[c.source]];
    if (c.action) facts.push(ACTION_LABELS[c.action]);
    if (c.durationMs) facts.push(`for ${formatDuration(c.durationMs)}`);
    if (c.rule) facts.push(RULE_LABELS[c.rule] || c.rule);

    return h("div", { class: "pn-card pn-case" },
      h("div", { class: "pn-case-top" },
        h("span", { class: "pn-case-num", text: `#${c.number}` }),
        h("span", { class: `pn-type t-${c.type}`, text: TYPE_LABELS[c.type] || c.type.toUpperCase() }),
        h("span", { class: "pn-time", title: new Date(c.createdAt).toLocaleString(), text: timeAgo(c.createdAt) })
      ),
      h("div", { class: "pn-case-who" },
        h("button", { class: "pn-link", type: "button", text: c.userName || "Unknown user", title: "Show only this member", onclick: () => setUserFilter(c.userId) }),
        " ", h("span", { class: "pn-mono", text: c.userId })
      ),
      c.reason ? h("div", { class: "pn-reason", text: c.reason }) : h("div", { class: "pn-empty", text: "No reason recorded" }),
      c.excerpt ? h("div", { class: "pn-quote", text: c.excerpt }) : null,
      h("div", { class: "pn-meta" }, facts.filter(Boolean).join(" · "), " · ",
        h("button", { class: "pn-link", type: "button", text: "Add a note about this member", onclick: () => prepareNote(c.userId) }))
    );
  }

  function memberBar() {
    if (!filters.userId) return null;
    const all = data.cases.filter((c) => c.userId === filters.userId);
    const counts = {};
    for (const c of all) counts[c.type] = (counts[c.type] || 0) + 1;
    const latestName = (all.find((c) => c.userName) || {}).userName;
    const summary = Object.entries(counts).map(([type, n]) => `${n} ${(TYPE_LABELS[type] || type).toLowerCase()}`).join(" · ");
    return h("div", { class: "pn-member-bar" },
      h("h3", { text: latestName || "Unknown user" }),
      h("p", { class: "pn-meta" }, h("span", { class: "pn-mono", text: filters.userId }), summary ? ` · ${summary}` : " · no recent cases loaded"),
      h("div", { class: "pn-actions", style: "margin-top:.6rem" },
        h("button", { class: "btn btn-small btn-secondary", type: "button", text: "Show everyone", onclick: () => setUserFilter(null) }),
        h("button", { class: "btn btn-small btn-primary", type: "button", text: "Add a note", onclick: () => prepareNote(filters.userId) })
      )
    );
  }

  // ---- actions

  function setUserFilter(userId) {
    filters.userId = userId;
    shown = PAGE_SIZE;
    renderList();
    window.scrollTo({ top: el.filters.offsetTop - 120, behavior: "smooth" });
  }

  function prepareNote(userId) {
    el.noteUser.value = userId;
    el.noteText.focus();
    el.noteForm.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function saveNote() {
    const userId = el.noteUser.value.trim();
    const text = el.noteText.value.trim();
    if (!/^\d{15,25}$/.test(userId)) return toast("Enter the member's Discord ID (digits only).", "error");
    if (!text) return toast("Write the note first.", "error");
    el.noteSave.disabled = true;
    el.noteSave.textContent = "Saving…";
    const result = await submit("moderation", "note", { userId, text });
    el.noteSave.disabled = false;
    el.noteSave.textContent = "Save note";
    toast(result.message, result.ok ? "ok" : "error");
    if (result.ok) {
      el.noteText.value = "";
      updateCounter();
      await load(true);
    }
  }

  function updateCounter() {
    el.noteCounter.textContent = `${el.noteText.value.length} / ${MAX_NOTE}`;
  }

  // ---- page

  function buildShell() {
    el.sub = h("p", { class: "pn-sub" });
    el.pill = h("span", { class: "pn-pill" });
    el.refresh = h("button", { class: "btn btn-small btn-secondary", type: "button", text: "Refresh", onclick: async () => { el.refresh.disabled = true; await load(true); el.refresh.disabled = false; } });

    el.noteUser = h("input", { class: "pn-input", type: "text", inputmode: "numeric", placeholder: "Member's Discord ID", autocomplete: "off" });
    el.noteText = h("textarea", { class: "pn-textarea", maxlength: MAX_NOTE, placeholder: "What should other moderators know?" });
    el.noteCounter = h("p", { class: "pn-hint" });
    el.noteSave = h("button", { class: "btn btn-small btn-primary", type: "button", text: "Save note", onclick: saveNote });
    el.noteText.addEventListener("input", updateCounter);
    updateCounter();
    el.noteForm = h("div", { class: "pn-card pn-note-form" },
      h("h3", { class: "pn-label", text: "Add a moderation note" }),
      h("p", { class: "pn-desc", text: "Notes are private to staff and appear in the case list. You can also use /mod note in Discord." }),
      h("div", { class: "pn-controls" }, h("div", { class: "pn-field" }, el.noteUser), h("div", { class: "pn-field" }, el.noteText, el.noteCounter)),
      h("div", { class: "pn-actions" }, el.noteSave)
    );

    el.search = h("input", { class: "pn-input", type: "search", placeholder: "Search a name, Discord ID, case number (#12) or text…", autocomplete: "off" });
    el.search.addEventListener("input", () => { filters.q = el.search.value; shown = PAGE_SIZE; renderList(); });
    el.filters = h("div", { class: "pn-filters" }, el.search);
    el.chips = h("div", { class: "pn-type-chips" });
    el.member = h("div");
    el.list = h("div");
    el.more = h("div", { class: "pn-actions", style: "justify-content:center" });
    el.info = h("p", { class: "pn-hint" });

    root.replaceChildren(
      h("section", { class: "container pn-shell section-top" },
        h("div", { class: "pn-head" },
          h("div", {}, h("p", { class: "eyebrow", text: "Administration" }), h("h1", { class: "page-title", text: "Moderation Panel" }), el.sub),
          h("div", { class: "pn-head-tools" }, el.pill, el.refresh)
        ),
        el.noteForm, el.filters, el.chips, el.member, el.list, el.more, el.info
      )
    );
    built = true;
  }

  function renderAll() {
    el.sub.textContent = `Signed in as ${data.me.displayName || "you"} · updated ${timeAgo(data.updatedAt)}`;
    el.pill.className = `pn-pill ${data.online ? "" : "is-offline"}`;
    el.pill.textContent = data.online ? "BOT ONLINE" : "BOT OFFLINE";
    renderList();
  }

  function renderList() {
    const counts = { all: 0 };
    for (const c of data.cases) {
      if (filters.userId && c.userId !== filters.userId) continue;
      counts.all += 1;
      counts[c.type] = (counts[c.type] || 0) + 1;
    }
    el.chips.replaceChildren(...TYPES.filter(([type]) => type === "all" || counts[type]).map(([type, label]) =>
      h("button", { class: `pn-type-chip ${filters.type === type ? "is-active" : ""}`, type: "button", text: `${label} (${counts[type] || 0})`, onclick: () => { filters.type = type; shown = PAGE_SIZE; renderList(); } })
    ));

    const bar = memberBar();
    el.member.replaceChildren(...(bar ? [bar] : []));

    const found = data.cases.filter(matches);
    const visible = found.slice(0, shown);
    el.list.replaceChildren(...(visible.length ? visible.map(caseCard) : [h("p", { class: "pn-empty", text: "No cases match." })]));
    el.more.replaceChildren(...(found.length > shown ? [h("button", { class: "btn btn-small btn-secondary", type: "button", text: `Show more (${found.length - shown} left)`, onclick: () => { shown += PAGE_SIZE; renderList(); } })] : []));
    el.info.textContent = data.total > data.cases.length
      ? `Showing the latest ${data.cases.length} of ${data.total} cases. Older cases are in the bot's data.`
      : `${data.total} case${data.total === 1 ? "" : "s"} in total.`;
  }

  load(false);
})();
