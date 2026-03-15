(() => {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const STAFF_COOLDOWN_MS = 12 * 60 * 60 * 1000;
  const STAFF_COOLDOWN_PREFIX = "liquid_events_staff_cooldown_until";
  const APPLICATIONS_STORAGE_KEY = "liquid_events_admin_applications_v1";

  const ADMIN_HASH = "#290348";
  const ADMIN_PASSWORD = "JkPWJ19dXb#YVV4A3#My50eNrie350";
  const ADMIN_SESSION_KEY = "liquid_events_admin_session_v1";

  let rateLimitKey = `${STAFF_COOLDOWN_PREFIX}_browser`;
  let rateLimitResolved = false;
  let rateLimitPromise = null;

  function setYear() {
    const yearNode = document.getElementById("year");
    if (yearNode) {
      yearNode.textContent = String(new Date().getFullYear());
    }
  }

  function animatePageIn() {
    if (prefersReducedMotion || !document.body.animate) {
      return;
    }
    document.body.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 260,
      easing: "ease-out",
      fill: "both"
    });
  }

  function sanitizeValue(value) {
    return String(value || "").trim();
  }

  function escapeHtml(value) {
    return sanitizeValue(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(isoDate) {
    try {
      return new Date(isoDate).toLocaleString();
    } catch {
      return isoDate;
    }
  }

  function humanizeKey(key) {
    return key
      .replaceAll("_", " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function getStoredApplications() {
    try {
      const raw = localStorage.getItem(APPLICATIONS_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function setStoredApplications(applications) {
    localStorage.setItem(APPLICATIONS_STORAGE_KEY, JSON.stringify(applications));
  }

  function saveApplication(application) {
    const existing = getStoredApplications();
    existing.push(application);
    setStoredApplications(existing);
  }

  function isTransitionableLink(link) {
    const href = link.getAttribute("href");
    if (!href || href.startsWith("#")) {
      return false;
    }
    try {
      const url = new URL(href, window.location.href);
      const isLocalFileMode = window.location.protocol === "file:";
      if (!isLocalFileMode && url.origin !== window.location.origin) {
        return false;
      }
      return url.pathname.endsWith(".html");
    } catch {
      return false;
    }
  }

  function setupPageTransitionLinks() {
    const links = document.querySelectorAll("a[data-transition]");
    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        if (!isTransitionableLink(link)) {
          return;
        }
        if (event.defaultPrevented || event.button !== 0) {
          return;
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }

        event.preventDefault();
        if (document.body.classList.contains("page-leaving")) {
          return;
        }

        document.body.classList.add("page-leaving");
        window.setTimeout(() => {
          window.location.href = link.href;
        }, prefersReducedMotion ? 0 : 220);
      });
    });
  }

  function setupEventsFilters() {
    const buttons = Array.from(document.querySelectorAll("[data-event-filter]"));
    if (!buttons.length) {
      return;
    }

    const pastSection = document.getElementById("pastEventsSection");
    const upcomingSection = document.getElementById("upcomingEventsSection");
    const sectionsLayout = document.querySelector(".events-sections-layout");
    if (!pastSection || !upcomingSection) {
      return;
    }

    function setFilter(filter) {
      buttons.forEach((button) => {
        button.classList.toggle("chip-active", button.dataset.eventFilter === filter);
      });

      if (filter === "past") {
        pastSection.hidden = false;
        upcomingSection.hidden = true;
        sectionsLayout?.classList.add("events-sections-single");
        return;
      }
      if (filter === "upcoming") {
        pastSection.hidden = true;
        upcomingSection.hidden = false;
        sectionsLayout?.classList.add("events-sections-single");
        return;
      }

      pastSection.hidden = false;
      upcomingSection.hidden = false;
      sectionsLayout?.classList.remove("events-sections-single");
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => setFilter(button.dataset.eventFilter || "all"));
    });

    setFilter("all");
  }

  function formatCooldown(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  function getRemainingCooldownMs() {
    const until = Number(localStorage.getItem(rateLimitKey) || 0);
    return Math.max(0, until - Date.now());
  }

  function setCooldown() {
    localStorage.setItem(rateLimitKey, String(Date.now() + STAFF_COOLDOWN_MS));
  }

  function resolveRateLimitKey() {
    if (rateLimitResolved) {
      return Promise.resolve();
    }
    if (rateLimitPromise) {
      return rateLimitPromise;
    }

    rateLimitPromise = (async () => {
      try {
        const response = await fetch("https://api64.ipify.org?format=json", { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        const ip = sanitizeValue(data.ip);
        if (ip) {
          rateLimitKey = `${STAFF_COOLDOWN_PREFIX}_${ip}`;
        }
      } catch {
        // Keep browser fallback key.
      } finally {
        rateLimitResolved = true;
      }
    })();

    return rateLimitPromise;
  }

  function buildStaffApplicationData(formData) {
    const entries = {};
    for (const [key, value] of formData.entries()) {
      entries[key] = sanitizeValue(value);
    }
    return entries;
  }

  function setupPlayerApplicationPage() {
    const startButton = document.getElementById("playerStartBtn");
    const messageNode = document.getElementById("playerStartMessage");
    if (!startButton || !messageNode) {
      return;
    }

    startButton.addEventListener("click", () => {
      messageNode.textContent = "Player applications are opening soon. Please check back later.";
      messageNode.style.color = "#ffb5c3";
    });
  }

  function setupStaffApplicationPage() {
    const startButton = document.getElementById("staffStartBtn");
    const startMessage = document.getElementById("staffStartMessage");
    const formWrap = document.getElementById("staffFormWrap");
    const form = document.getElementById("staffApplicationForm");
    const submitButton = document.getElementById("staffSubmitBtn");
    const submitMessage = document.getElementById("staffSubmitMessage");

    if (!startButton || !startMessage || !formWrap || !form || !submitButton || !submitMessage) {
      return;
    }

    resolveRateLimitKey().finally(() => {
      const initialCooldown = getRemainingCooldownMs();
      if (initialCooldown > 0) {
        startMessage.textContent = `Submission cooldown active: ${formatCooldown(initialCooldown)} remaining.`;
        startMessage.style.color = "#ffcf9b";
      }
    });

    startButton.addEventListener("click", () => {
      formWrap.hidden = false;
      formWrap.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await resolveRateLimitKey();

      const remainingCooldown = getRemainingCooldownMs();
      if (remainingCooldown > 0) {
        submitMessage.textContent = `Cooldown active. Please wait ${formatCooldown(remainingCooldown)} before submitting again.`;
        submitMessage.style.color = "#ffcf9b";
        return;
      }

      if (!form.reportValidity()) {
        return;
      }

      const formData = new FormData(form);
      const answers = buildStaffApplicationData(formData);
      const application = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "staff",
        submittedAt: new Date().toISOString(),
        discordUsername: answers.discord_username || "N/A",
        answers
      };

      submitButton.disabled = true;
      submitButton.textContent = "Submitting...";
      submitMessage.textContent = "";

      try {
        saveApplication(application);
        setCooldown();
        submitMessage.textContent = "Application submitted and saved for admin review.";
        submitMessage.style.color = "#94ffc9";
        form.reset();
      } catch (error) {
        submitMessage.textContent = `Could not save application. ${String(error)}`;
        submitMessage.style.color = "#ffb5c3";
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Submit Staff Application";
      }
    });
  }

  function hidePublicSiteForAdminMode() {
    document.body.classList.add("admin-only-mode");
    document.querySelectorAll("header, main, footer").forEach((node) => {
      node.hidden = true;
    });
  }

  function renderAdminLogin(root) {
    root.innerHTML = `
      <div class="admin-center">
        <article class="admin-login-card glass">
          <p class="eyebrow">Hidden Admin Panel</p>
          <h1>Liquid Events Review</h1>
          <p class="hero-text">Enter password to access stored applications.</p>
          <form id="adminLoginForm" class="form-stack">
            <label>Password
              <input type="password" id="adminPasswordInput" required>
            </label>
            <button class="btn btn-primary" type="submit">Unlock Panel</button>
            <p id="adminLoginMessage" class="form-message"></p>
          </form>
        </article>
      </div>
    `;

    const form = document.getElementById("adminLoginForm");
    const passwordInput = document.getElementById("adminPasswordInput");
    const message = document.getElementById("adminLoginMessage");
    if (!form || !passwordInput || !message) {
      return;
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (passwordInput.value === ADMIN_PASSWORD) {
        sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
        renderAdminPanel(root);
        return;
      }
      message.textContent = "Wrong password.";
      message.style.color = "#ffb5c3";
    });
  }

  function renderApplicationDetail(application) {
    const answersHtml = Object.entries(application.answers || {})
      .map(([key, value]) => {
        return `
          <article class="admin-answer-row">
            <h4>${escapeHtml(humanizeKey(key))}</h4>
            <p>${escapeHtml(value)}</p>
          </article>
        `;
      })
      .join("");

    return `
      <div class="admin-detail-header">
        <h3>${escapeHtml(application.discordUsername || "N/A")}</h3>
        <p>Type: ${escapeHtml(application.type || "unknown")} • Submitted: ${escapeHtml(formatDate(application.submittedAt))}</p>
      </div>
      <div class="admin-answer-list">${answersHtml || '<p class="hero-text">No answers found.</p>'}</div>
    `;
  }

  function renderAdminPanel(root) {
    const applications = getStoredApplications()
      .slice()
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    root.innerHTML = `
      <div class="admin-panel-wrap">
        <header class="admin-panel-head">
          <div>
            <p class="eyebrow">Secret Panel</p>
            <h1>Applications Review</h1>
          </div>
          <div class="admin-head-actions">
            <button id="adminExitBtn" class="btn btn-primary btn-small" type="button">Exit</button>
          </div>
        </header>

        <div class="admin-panel-grid">
          <aside class="admin-list">
            ${
              applications.length
                ? applications
                    .map((application, index) => {
                      return `
                        <button class="admin-app-card ${index === 0 ? "active" : ""}" data-app-id="${escapeHtml(application.id)}" type="button">
                          <h3>${escapeHtml(application.discordUsername || "N/A")}</h3>
                          <p>${escapeHtml((application.type || "unknown").toUpperCase())}</p>
                          <small>${escapeHtml(formatDate(application.submittedAt))}</small>
                        </button>
                      `;
                    })
                    .join("")
                : '<p class="hero-text">No applications submitted yet.</p>'
            }
          </aside>

          <section class="admin-detail" id="adminDetail">
            ${
              applications.length
                ? renderApplicationDetail(applications[0])
                : '<p class="hero-text">No answers to display.</p>'
            }
          </section>
        </div>
      </div>
    `;

    const exitButton = document.getElementById("adminExitBtn");
    const detailRoot = document.getElementById("adminDetail");

    if (exitButton) {
      exitButton.addEventListener("click", () => {
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
        history.replaceState(null, "", window.location.pathname + window.location.search);
        window.location.reload();
      });
    }

    if (detailRoot) {
      root.querySelectorAll(".admin-app-card").forEach((button) => {
        button.addEventListener("click", () => {
          const appId = button.getAttribute("data-app-id");
          const selected = applications.find((entry) => entry.id === appId);
          if (!selected) {
            return;
          }

          root.querySelectorAll(".admin-app-card").forEach((node) => node.classList.remove("active"));
          button.classList.add("active");
          detailRoot.innerHTML = renderApplicationDetail(selected);
        });
      });
    }
  }

  function setupHiddenAdminPanel() {
    if (window.location.hash !== ADMIN_HASH) {
      return;
    }

    hidePublicSiteForAdminMode();

    const overlay = document.createElement("section");
    overlay.id = "hiddenAdminOverlay";
    overlay.className = "admin-overlay";
    document.body.appendChild(overlay);

    const hasSession = sessionStorage.getItem(ADMIN_SESSION_KEY) === "1";
    if (hasSession) {
      renderAdminPanel(overlay);
    } else {
      renderAdminLogin(overlay);
    }
  }

  function boot() {
    setYear();
    animatePageIn();
    setupPageTransitionLinks();
    setupEventsFilters();
    setupPlayerApplicationPage();
    setupStaffApplicationPage();
    setupHiddenAdminPanel();
  }

  boot();
})();
