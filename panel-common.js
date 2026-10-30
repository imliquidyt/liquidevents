// Small helpers shared by the Management and Moderation panels.
(function () {
  const Panel = {};

  Panel.esc = function (value) {
    return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  };

  /** Builds an element: h("div", { class: "x", onclick: fn }, "text", childElement) */
  Panel.h = function (tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (name.startsWith("on") && typeof value === "function") el.addEventListener(name.slice(2), value);
      else if (name === "class") el.className = value;
      else if (name === "text") el.textContent = value;
      else el.setAttribute(name, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  };

  /** Calls /api/<endpoint>?action=... and returns { status, data }. Never throws. */
  Panel.api = async function (endpoint, action, options) {
    const { method = "GET", body, params = {} } = options || {};
    const query = new URLSearchParams({ action, ...params });
    try {
      const response = await fetch(`/api/${endpoint}?${query}`, {
        method,
        credentials: "same-origin",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await response.json().catch(() => ({}));
      return { status: response.status, data };
    } catch {
      return { status: 0, data: { ok: false, error: "Could not reach the website. Check your connection." } };
    }
  };

  /** Sends a change and waits for the bot to confirm it. Resolves to { ok, message, result }. */
  Panel.submit = async function (endpoint, action, body) {
    const sent = await Panel.api(endpoint, action, { method: "POST", body });
    if (sent.status !== 202 || !sent.data.jobId) {
      return { ok: false, message: sent.data.error || "The change could not be sent." };
    }
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const polled = await Panel.api(endpoint, "result", { params: { id: sent.data.jobId } });
      if (polled.data && polled.data.done) {
        return { ok: Boolean(polled.data.result.ok), message: polled.data.result.message, result: polled.data.result };
      }
    }
    return {
      ok: false,
      message: "The bot has not confirmed this yet. It may still apply; refresh in a moment to check."
    };
  };

  Panel.toast = function (message, kind) {
    let box = document.getElementById("pnToasts");
    if (!box) {
      box = Panel.h("div", { id: "pnToasts", class: "pn-toasts", "aria-live": "polite" });
      document.body.append(box);
    }
    const toast = Panel.h("div", { class: `pn-toast ${kind === "error" ? "is-error" : "is-ok"}`, text: message });
    box.append(toast);
    setTimeout(() => toast.remove(), kind === "error" ? 9000 : 5000);
  };

  Panel.loginUrl = function (route) {
    return `/api/discord-auth?action=login&returnTo=${encodeURIComponent(`/${route}`)}`;
  };

  /** Shows a full-page message (sign in, access denied, bot offline, error) instead of the panel. */
  Panel.showGate = function (root, { icon, title, text, actions }) {
    root.replaceChildren(
      Panel.h("div", { class: "pn-gate container" },
        Panel.h("div", { class: "glass pn-gate-card" },
          Panel.h("span", { class: "pn-gate-icon", text: icon }),
          Panel.h("h2", { text: title }),
          Panel.h("p", { class: "hero-text", text }),
          Panel.h("div", { class: "pn-gate-actions" }, (actions || []).map((a) =>
            Panel.h(a.href ? "a" : "button", { class: `btn btn-small ${a.primary ? "btn-primary" : "btn-secondary"}`, href: a.href, onclick: a.onclick, type: a.href ? undefined : "button", text: a.label })
          ))
        )
      )
    );
  };

  /** Turns an API failure into the right gate. Returns true when it handled the response. */
  Panel.handleAccessError = function (root, response, route, retry) {
    const { status, data } = response;
    const back = { label: "Back to Admin Hub", href: "/#admin-hub" };
    if (status === 401) {
      Panel.showGate(root, { icon: "🔒", title: "Sign in required", text: "Sign in with Discord to open this panel.", actions: [{ label: "Sign in with Discord", href: Panel.loginUrl(route), primary: true }, back] });
      return true;
    }
    if (status === 403) {
      Panel.showGate(root, { icon: "⛔", title: "Access denied", text: data.error || "Your Discord account does not have access to this panel.", actions: [back] });
      return true;
    }
    if (status !== 200) {
      const offline = data && data.code === "bot-offline";
      Panel.showGate(root, { icon: offline ? "🔌" : "⚠️", title: offline ? "Bot not connected" : "Something went wrong", text: (data && data.error) || "Please try again in a moment.", actions: [{ label: "Try again", onclick: retry, primary: true }, back] });
      return true;
    }
    return false;
  };

  Panel.timeAgo = function (ms) {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return "just now";
    const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
    for (const [name, size] of units) {
      if (seconds >= size) {
        const count = Math.floor(seconds / size);
        return `${count} ${name}${count === 1 ? "" : "s"} ago`;
      }
    }
    return "just now";
  };

  Panel.formatDuration = function (ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} h`;
    return `${Math.round(minutes / 1440)} d`;
  };

  window.Panel = Panel;
})();
