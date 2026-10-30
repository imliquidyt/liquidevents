// Management Panel: shows every setting the bot publishes and sends changes back through /api/management.
// The page has no list of settings of its own; it is built from what the bot shares, so a setting added
// to the bot appears here automatically.
(function () {
  "use strict";

  const { h, api, submit, toast, showGate, handleAccessError, timeAgo } = Panel;

  // Shown above the danger zone and again in a confirmation before one of those settings is saved or reset.
  // Replace this text with your own warning.
  const DANGER_WARNING =
    "Warning: these settings decide who has power over the bot and the website panels. A wrong value can lock people out or give the wrong people access.";

  const ROUTE = "#management-panel";
  const root = document.getElementById("panelRoot");
  let state = null;
  let activeTab = null;
  const openGroups = new Set(["General"]);

  // ---- loading

  async function load(silent) {
    if (!silent) root.replaceChildren(h("p", { class: "pn-loading", text: "Loading settings…" }));
    const response = await api("management", "state");
    if (Panel.handleAccessError(root, response, ROUTE, () => load(false))) return;
    state = response.data;
    render();
  }

  // ---- controls: each returns { node, read(), changed(), valid(), onChange(fn) }

  const lines = (text) => text.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);

  function selectControl(s, options, locked) {
    const current = s.value || "";
    const select = h("select", { class: "pn-select", disabled: locked });
    if (!current) select.append(h("option", { value: "", text: "Not set" }));
    else if (!options.some((option) => option.id === current)) {
      select.append(h("option", { value: current, text: `Unknown (${current})` }));
    }
    for (const option of options) select.append(h("option", { value: option.id, text: option.name }));
    select.value = current;
    return {
      node: select,
      read: () => select.value,
      changed: () => select.value !== current,
      valid: () => select.value !== "",
      onChange: (fn) => select.addEventListener("change", fn)
    };
  }

  function textControl(s, locked, { check, type = "text", extra = {} }) {
    const current = s.value === null || s.value === undefined ? "" : String(s.value);
    const input = h("input", { class: "pn-input", type, value: current, disabled: locked, autocomplete: "off", ...extra });
    return {
      node: input,
      read: () => input.value.trim(),
      changed: () => input.value.trim() !== current,
      valid: () => check(input.value.trim()),
      onChange: (fn) => input.addEventListener("input", fn)
    };
  }

  function linesControl(s, locked, normalize, check) {
    const current = normalize(s.value || []);
    const area = h("textarea", { class: "pn-textarea", disabled: locked, spellcheck: "false" });
    area.value = current.join("\n");
    return {
      node: area,
      read: () => normalize(lines(area.value)),
      changed: () => JSON.stringify(normalize(lines(area.value))) !== JSON.stringify(current),
      valid: () => check(normalize(lines(area.value))),
      onChange: (fn) => area.addEventListener("input", fn)
    };
  }

  function chipsControl(s, options, locked, prefix) {
    const names = new Map(options.map((option) => [option.id, option.name]));
    const original = [...(s.value || [])];
    let selected = [...original];
    const chips = h("div", { class: "pn-chips" });
    const picker = h("select", { class: "pn-select", disabled: locked });
    const listeners = [];
    const fire = () => listeners.forEach((fn) => fn());

    function draw() {
      const items = selected.map((id) =>
        h("span", { class: "pn-chip" }, `${prefix}${names.get(id) || `Unknown (${id})`}`,
          h("button", { type: "button", "aria-label": "Remove", disabled: locked, text: "×", onclick: () => { selected = selected.filter((x) => x !== id); draw(); fire(); } }))
      );
      chips.replaceChildren(...(items.length ? items : [h("span", { class: "pn-empty", text: "None" })]));
      picker.replaceChildren(h("option", { value: "", text: "Add…" }));
      for (const option of options) {
        if (!selected.includes(option.id)) picker.append(h("option", { value: option.id, text: `${prefix}${option.name}` }));
      }
    }
    picker.addEventListener("change", () => {
      if (picker.value) { selected.push(picker.value); draw(); fire(); }
    });
    draw();
    return {
      node: h("div", {}, chips, picker),
      read: () => [...selected],
      changed: () => JSON.stringify([...selected].sort()) !== JSON.stringify([...original].sort()),
      valid: () => selected.length <= 50,
      onChange: (fn) => listeners.push(fn)
    };
  }

  function switchControl(s, locked) {
    const current = Boolean(s.value);
    const box = h("input", { type: "checkbox", disabled: locked });
    box.checked = current;
    const text = h("span", { text: current ? "On" : "Off" });
    box.addEventListener("change", () => { text.textContent = box.checked ? "On" : "Off"; });
    return {
      node: h("label", { class: "pn-switch" }, box, text),
      read: () => box.checked,
      changed: () => box.checked !== current,
      valid: () => true,
      onChange: (fn) => box.addEventListener("change", fn)
    };
  }

  function longTextControl(s, locked) {
    const current = s.value || "";
    const area = h("textarea", { class: "pn-textarea", maxlength: s.max, rows: 9, disabled: locked, spellcheck: "true" });
    area.value = current;
    const counter = h("p", { class: "pn-hint" });
    const update = () => { counter.textContent = `${area.value.length} / ${s.max}`; };
    update();
    area.addEventListener("input", update);
    return {
      node: h("div", {}, area, counter),
      read: () => area.value.trim(),
      changed: () => area.value.trim() !== current,
      valid: () => area.value.trim().length > 0 && area.value.length <= s.max,
      onChange: (fn) => area.addEventListener("input", fn)
    };
  }

  function buildControl(s, locked) {
    const snap = state.snapshot;
    const isId = (v) => /^\d{15,25}$/.test(v);
    switch (s.type) {
      case "role": return selectControl(s, snap.roles, locked);
      case "channel": return selectControl(s, snap.channels.map((c) => ({ id: c.id, name: `#${c.name}` })), locked);
      case "category": return selectControl(s, snap.categories, locked);
      case "roleList": return chipsControl(s, snap.roles, locked, "");
      case "channelList":
        return chipsControl(s, [
          ...snap.categories.map((c) => ({ id: c.id, name: `Category: ${c.name} (every channel inside)` })),
          ...snap.channels.map((c) => ({ id: c.id, name: `#${c.name}` }))
        ], locked, "");
      case "boolean": return switchControl(s, locked);
      case "longText": return longTextControl(s, locked);
      case "select": return selectControl(s, s.options.map((option) => ({ id: option.value, name: option.label })), locked);
      case "user": return textControl(s, locked, { check: isId, extra: { inputmode: "numeric", placeholder: "Discord user ID" } });
      case "userList":
        return linesControl(s, locked, (list) => [...new Set(list)], (list) => list.length >= 1 && list.length <= 10 && list.every(isId));
      case "wordList":
        return linesControl(s, locked, (list) => [...new Set(list.map((w) => w.toLowerCase()))], (list) => list.length <= 50 && list.every((w) => w.length <= 60));
      case "number": {
        const control = textControl(s, locked, {
          type: "number",
          extra: { min: s.min, max: s.max, step: 1 },
          check: (v) => v !== "" && Number.isInteger(Number(v)) && Number(v) >= s.min && Number(v) <= s.max
        });
        control.read = () => Number(control.node.value);
        return control;
      }
      case "url": return textControl(s, locked, { type: "url", check: (v) => /^https?:\/\//i.test(v) });
      default: return null;
    }
  }

  // ---- one setting

  function currentHint(s) {
    if (s.type !== "user" && s.type !== "userList") return null;
    const names = (s.labels || []).filter(Boolean);
    return names.length ? h("p", { class: "pn-hint" }, "Currently: ", h("b", { text: names.join(", ") })) : null;
  }

  function settingCard(s) {
    const locked = s.protected && !state.me.ownerLevel;
    const control = buildControl(s, locked);
    if (!control) return null;

    const saveButton = h("button", { class: "btn btn-small btn-primary", type: "button", text: "Save", disabled: true });
    const resetButton = s.source === "changed" && !locked
      ? h("button", { class: "btn btn-small btn-secondary", type: "button", text: "Reset to default" })
      : null;
    const buttons = [saveButton, resetButton].filter(Boolean);

    const refreshState = () => { saveButton.disabled = locked || !control.changed() || !control.valid(); };
    control.onChange(refreshState);

    const confirmDanger = (what) => !s.danger || window.confirm(`${DANGER_WARNING}\n\n${what} “${s.label}”?`);
    const run = async (action, body, confirmText) => {
      if (!confirmDanger(confirmText)) return;
      buttons.forEach((b) => { b.disabled = true; });
      saveButton.textContent = "Working…";
      const result = await submit("management", action, body);
      toast(result.message, result.ok ? "ok" : "error");
      if (result.ok) await load(true);
      else { saveButton.textContent = "Save"; buttons.forEach((b) => { b.disabled = false; }); refreshState(); }
    };

    saveButton.addEventListener("click", () => run("set", { key: s.key, value: control.read() }, "Save"));
    if (resetButton) {
      resetButton.addEventListener("click", () => {
        if (window.confirm(`Reset “${s.label}” to its default?`)) run("reset", { key: s.key }, "Reset");
      });
    }

    const badge = locked
      ? h("span", { class: "pn-badge is-locked", text: "OWNER ONLY" })
      : h("span", { class: `pn-badge ${s.source === "changed" ? "is-changed" : ""}`, text: s.source === "changed" ? "CUSTOMISED" : s.source === "env" ? "FROM .ENV" : "DEFAULT" });

    return h("div", { class: `pn-card ${s.danger ? "is-danger" : ""}` },
      h("div", { class: "pn-row-head" }, h("h3", { class: "pn-label", text: s.label }), badge),
      h("p", { class: "pn-desc", text: s.description }),
      h("div", { class: "pn-controls" },
        h("div", { class: "pn-field" }, control.node, currentHint(s)),
        h("div", { class: "pn-actions" }, buttons)
      ),
      locked ? h("p", { class: "pn-hint", text: "Only the server owner or someone with the owner role can change this setting." }) : null
    );
  }

  /** Settings that share a group (an automod rule, say) are shown together in a collapsible block. */
  function settingCards(list) {
    if (!list.some((s) => s.group)) return list.map(settingCard);
    const blocks = [];
    let box = null;
    let current = null;
    for (const s of list) {
      if (s.group !== current) {
        current = s.group;
        const name = s.group;
        const first = list.find((x) => x.group === name);
        const details = h("details", { class: "pn-group", open: openGroups.has(name) },
          h("summary", { class: "pn-group-title" },
            h("span", { text: name }),
            first.type === "boolean" ? h("span", { class: `pn-badge ${first.value ? "" : "is-locked"}`, text: first.value ? "ON" : "OFF" }) : null
          )
        );
        details.addEventListener("toggle", () => { if (details.open) openGroups.add(name); else openGroups.delete(name); });
        blocks.push(details);
        box = details;
      }
      box.append(settingCard(s));
    }
    return blocks;
  }

  // ---- bot status and bio

  function statusTab() {
    const p = state.snapshot.presence;
    const status = h("select", { class: "pn-select" }, p.statuses.map((x) => h("option", { value: x.value, text: x.label })));
    const kind = h("select", { class: "pn-select" }, p.activityTypes.map((x) => h("option", { value: x.value, text: x.label })));
    const text = h("input", { class: "pn-input", type: "text", maxlength: p.maxActivityLength, placeholder: "What the bot is doing" });
    status.value = p.status; kind.value = p.activityType; text.value = p.activityText || "";
    const saveStatus = h("button", { class: "btn btn-small btn-primary", type: "button", text: "Save status" });
    saveStatus.addEventListener("click", async () => {
      saveStatus.disabled = true;
      const result = await submit("management", "presence", { status: status.value, activityType: kind.value, activityText: text.value });
      toast(result.message, result.ok ? "ok" : "error");
      saveStatus.disabled = false;
      if (result.ok) await load(true);
    });

    const bio = h("textarea", { class: "pn-textarea", maxlength: state.snapshot.maxBioLength });
    bio.value = state.snapshot.bio || "";
    const counter = h("p", { class: "pn-hint", text: "" });
    const updateCounter = () => { counter.textContent = `${bio.value.length} / ${state.snapshot.maxBioLength}`; };
    bio.addEventListener("input", updateCounter);
    updateCounter();
    const saveBio = h("button", { class: "btn btn-small btn-primary", type: "button", text: "Save bio" });
    saveBio.addEventListener("click", async () => {
      saveBio.disabled = true;
      const result = await submit("management", "bio", { text: bio.value });
      toast(result.message, result.ok ? "ok" : "error");
      saveBio.disabled = false;
      if (result.ok) await load(true);
    });

    return [
      h("div", { class: "pn-card" },
        h("h3", { class: "pn-label", text: "Status and activity" }),
        h("p", { class: "pn-desc", text: "How the bot appears in the member list." }),
        h("div", { class: "pn-controls" }, h("div", { class: "pn-field" }, status), h("div", { class: "pn-field" }, kind), h("div", { class: "pn-field" }, text)),
        h("div", { class: "pn-actions", style: "margin-top:.8rem" }, saveStatus)
      ),
      h("div", { class: "pn-card" },
        h("h3", { class: "pn-label", text: "Bio" }),
        h("p", { class: "pn-desc", text: "The bot's “About Me” on Discord. Discord limits how often this can change." }),
        bio, counter,
        h("div", { class: "pn-actions", style: "margin-top:.8rem" }, saveBio)
      )
    ];
  }

  // ---- page

  function buildTabs() {
    const { sections, settings } = state.snapshot;
    const tabs = sections
      .map((section) => ({ id: section.id, label: section.label, note: section.description, settings: settings.filter((s) => s.section === section.id && !s.danger) }))
      .filter((tab) => tab.settings.length);
    tabs.push({ id: "status", label: "Bot status & bio", note: "How the bot looks on Discord.", special: true });
    const danger = settings.filter((s) => s.danger);
    if (danger.length) tabs.push({ id: "danger", label: "Danger zone", danger: true, note: "", settings: danger });
    return tabs;
  }

  function render() {
    const scroll = window.scrollY;
    const tabs = buildTabs();
    if (!tabs.some((tab) => tab.id === activeTab)) activeTab = tabs[0].id;
    const tab = tabs.find((t) => t.id === activeTab);
    const snap = state.snapshot;

    const body = tab.special ? statusTab() : settingCards(tab.settings);
    root.replaceChildren(
      h("section", { class: "container pn-shell section-top" },
        h("div", { class: "pn-head" },
          h("div", {},
            h("p", { class: "eyebrow", text: "Administration" }),
            h("h1", { class: "page-title", text: "Management Panel" }),
            h("p", { class: "pn-sub", text: `${snap.guild.name} · signed in as ${state.me.displayName || "you"} · synced ${timeAgo(snap.updatedAt)}` })
          ),
          h("div", { class: "pn-head-tools" },
            h("span", { class: `pn-pill ${state.online ? "" : "is-offline"}`, text: state.online ? "BOT ONLINE" : "BOT OFFLINE" }),
            h("button", { class: "btn btn-small btn-secondary", type: "button", text: "Refresh", onclick: async (e) => { e.target.disabled = true; await load(true); } })
          )
        ),
        h("div", { class: "pn-tabs" }, tabs.map((t) =>
          h("button", { class: `pn-tab ${t.id === activeTab ? "is-active" : ""} ${t.danger ? "is-danger" : ""}`, type: "button", text: t.label, onclick: () => { activeTab = t.id; render(); } })
        )),
        tab.note && !tab.danger ? h("p", { class: "pn-section-note", text: tab.note }) : null,
        tab.danger ? h("div", { class: "pn-danger-banner", text: DANGER_WARNING }) : null,
        body
      )
    );
    window.scrollTo(0, scroll);
  }

  load(false);
})();
