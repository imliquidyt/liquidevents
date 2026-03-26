(() => {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const STAFF_COOLDOWN_MS = 12 * 60 * 60 * 1000;
  const STAFF_COOLDOWN_PREFIX = "liquid_events_staff_cooldown_until";
  const APPLICATIONS_STORAGE_KEY = "liquid_events_admin_applications_v1";
  const APPLICATIONS_BACKUP_STORAGE_KEY = "liquid_events_admin_applications_backup_v1";
  const APPLICATIONS_API_ENDPOINT = "/api/applications";

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

  function normalizeApplicationType(type) {
    const normalized = sanitizeValue(type).toLowerCase();
    if (normalized === "staff" || normalized === "player") {
      return normalized;
    }
    return "unknown";
  }

  function normalizeReviewStatus(status) {
    const normalized = sanitizeValue(status).toLowerCase();
    if (normalized === "accepted" || normalized === "denied") {
      return normalized;
    }
    return "pending";
  }

  function reviewStatusLabel(status) {
    const normalized = normalizeReviewStatus(status);
    if (normalized === "accepted") {
      return "Accepted";
    }
    if (normalized === "denied") {
      return "Denied";
    }
    return "Pending";
  }

  function normalizeApplication(application, index = 0) {
    if (!application || typeof application !== "object" || Array.isArray(application)) {
      return null;
    }

    const answers =
      application.answers && typeof application.answers === "object" && !Array.isArray(application.answers)
        ? application.answers
        : {};

    const id = sanitizeValue(application.id) || `legacy-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
    const submittedAt = sanitizeValue(application.submittedAt) || new Date(0).toISOString();
    const discordUsername = sanitizeValue(application.discordUsername) || sanitizeValue(answers.discord_username) || "N/A";

    return {
      id,
      type: normalizeApplicationType(application.type),
      submittedAt,
      discordUsername,
      answers,
      reviewStatus: normalizeReviewStatus(application.reviewStatus),
      reviewedAt: sanitizeValue(application.reviewedAt)
    };
  }

  function canUseSharedApi() {
    return window.location.protocol === "https:" || window.location.protocol === "http:";
  }

  function parseStoredApplications(raw) {
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((entry, index) => normalizeApplication(entry, index))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function mergeApplications(primary, backup) {
    const mergedById = new Map();

    [...backup, ...primary].forEach((application) => {
      if (!application || !application.id) {
        return;
      }

      const existing = mergedById.get(application.id);
      if (!existing) {
        mergedById.set(application.id, application);
        return;
      }

      const existingTime = Date.parse(existing.submittedAt) || 0;
      const currentTime = Date.parse(application.submittedAt) || 0;
      if (currentTime >= existingTime) {
        mergedById.set(application.id, application);
      }
    });

    return Array.from(mergedById.values());
  }

  function getStoredApplications() {
    try {
      const primary = parseStoredApplications(localStorage.getItem(APPLICATIONS_STORAGE_KEY));
      const backup = parseStoredApplications(localStorage.getItem(APPLICATIONS_BACKUP_STORAGE_KEY));
      const merged = mergeApplications(primary, backup);

      if (merged.length) {
        try {
          setStoredApplications(merged);
        } catch {
          // Keep reading data even if browser storage write fails.
        }
      }

      return merged;
    } catch {
      return [];
    }
  }

  function setStoredApplications(applications) {
    const payload = JSON.stringify(applications);
    localStorage.setItem(APPLICATIONS_STORAGE_KEY, payload);
    localStorage.setItem(APPLICATIONS_BACKUP_STORAGE_KEY, payload);
  }

  function saveApplicationLocally(application) {
    const existing = getStoredApplications();
    const normalized = normalizeApplication(application, existing.length);
    if (!normalized) {
      throw new Error("Invalid application data.");
    }

    const merged = mergeApplications([normalized], existing);
    setStoredApplications(merged);
    return normalized;
  }

  function buildApiError(payload, fallbackMessage) {
    const error = new Error(sanitizeValue(payload?.error) || fallbackMessage);
    error.code = sanitizeValue(payload?.code) || "API_ERROR";
    error.retryAfterSeconds = Number(payload?.retryAfterSeconds || 0);
    return error;
  }

  async function saveApplication(application) {
    const existing = getStoredApplications();
    const normalized = normalizeApplication(application, existing.length);
    if (!normalized) {
      throw new Error("Invalid application data.");
    }

    if (!canUseSharedApi()) {
      const localOnlyCopy = saveApplicationLocally(normalized);
      return { mode: "local", application: localOnlyCopy };
    }

    const response = await fetch(APPLICATIONS_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(normalized)
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw buildApiError(payload, "Could not save application to shared storage.");
    }

    const remoteCopy = normalizeApplication(payload.application, 0) || normalized;
    const merged = mergeApplications([remoteCopy], getStoredApplications());
    setStoredApplications(merged);
    return { mode: "remote", application: remoteCopy };
  }

  async function loadApplicationsForAdmin() {
    if (!canUseSharedApi()) {
      return {
        applications: getStoredApplications(),
        storageMode: "local_only",
        storageMessage: "Local file mode: showing browser-only data."
      };
    }

    const response = await fetch(APPLICATIONS_API_ENDPOINT, {
      method: "GET",
      headers: {
        "x-admin-password": ADMIN_PASSWORD
      },
      cache: "no-store"
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw buildApiError(payload, "Could not load shared applications.");
    }

    const remote = Array.isArray(payload.applications)
      ? payload.applications
          .map((entry, index) => normalizeApplication(entry, index))
          .filter(Boolean)
      : [];

    setStoredApplications(remote);

    return {
      applications: remote,
      storageMode: "shared",
      storageMessage: "Synced from shared server storage."
    };
  }

  async function updateApplicationReviewStatus(applicationId, reviewStatus) {
    const normalizedId = sanitizeValue(applicationId);
    const normalizedStatus = normalizeReviewStatus(reviewStatus);

    if (!normalizedId) {
      throw new Error("Missing application id.");
    }

    if (!canUseSharedApi()) {
      const localApplications = getStoredApplications();
      const index = localApplications.findIndex((application) => application.id === normalizedId);
      if (index < 0) {
        throw new Error("Application not found.");
      }

      const updatedLocal = {
        ...localApplications[index],
        reviewStatus: normalizedStatus,
        reviewedAt: new Date().toISOString()
      };
      const mergedLocal = mergeApplications([updatedLocal], localApplications);
      setStoredApplications(mergedLocal);
      return { mode: "local", application: updatedLocal };
    }

    const response = await fetch(APPLICATIONS_API_ENDPOINT, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-password": ADMIN_PASSWORD
      },
      body: JSON.stringify({
        id: normalizedId,
        reviewStatus: normalizedStatus
      })
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw buildApiError(payload, "Could not update application review status.");
    }

    const normalizedRemote = normalizeApplication(payload.application, 0);
    if (!normalizedRemote) {
      throw new Error("Invalid application returned from server.");
    }

    const merged = mergeApplications([normalizedRemote], getStoredApplications());
    setStoredApplications(merged);
    return { mode: "remote", application: normalizedRemote };
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

  function setupRevealAnimations(root = document) {
    const revealSelector = [
      ".section-head",
      ".hero-copy",
      ".hero-badge",
      ".hero-stats",
      ".metric-card",
      ".status-card",
      ".app-card",
      ".cta-panel",
      ".event-card",
      ".details-card",
      ".gform-intro",
      ".gform-body",
      ".question-card",
      ".admin-panel-head",
      ".admin-toolbar",
      ".admin-list",
      ".admin-detail",
      ".admin-app-card"
    ].join(", ");

    const nodes = Array.from(root.querySelectorAll(revealSelector)).filter(
      (node) => !node.classList.contains("reveal-ready")
    );

    if (!nodes.length) {
      return;
    }

    nodes.forEach((node, index) => {
      node.classList.add("reveal", "reveal-ready");
      node.style.setProperty("--reveal-delay", `${Math.min(index * 42, 280)}ms`);
    });

    if (prefersReducedMotion || typeof window.IntersectionObserver !== "function") {
      nodes.forEach((node) => node.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries, activeObserver) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }
          entry.target.classList.add("is-visible");
          activeObserver.unobserve(entry.target);
        });
      },
      {
        threshold: 0.14,
        rootMargin: "0px 0px -10% 0px"
      }
    );

    nodes.forEach((node) => observer.observe(node));
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

  function buildApplicationData(formData) {
    const entries = {};
    for (const [key, value] of formData.entries()) {
      const normalizedValue = sanitizeValue(value);
      if (Object.prototype.hasOwnProperty.call(entries, key)) {
        if (Array.isArray(entries[key])) {
          entries[key].push(normalizedValue);
        } else {
          entries[key] = [entries[key], normalizedValue];
        }
      } else {
        entries[key] = normalizedValue;
      }
    }

    Object.keys(entries).forEach((key) => {
      if (Array.isArray(entries[key])) {
        entries[key] = entries[key].join(" | ");
      }
    });

    return entries;
  }

  function setupPlayerApplicationPage() {
    const startButton = document.getElementById("playerStartBtn");
    const messageNode = document.getElementById("playerStartMessage");
    const formWrap = document.getElementById("playerFormWrap");
    const form = document.getElementById("playerApplicationForm");
    const submitButton = document.getElementById("playerSubmitBtn");
    const submitMessage = document.getElementById("playerSubmitMessage");

    if (!startButton || !messageNode || !formWrap || !form || !submitButton || !submitMessage) {
      return;
    }

    messageNode.textContent = "Player applications are open.";
    messageNode.style.color = "#91f7c4";

    startButton.addEventListener("click", () => {
      formWrap.hidden = false;
      formWrap.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const hasSelectedDays = Boolean(form.querySelector('input[name="available_days"]:checked'));
      if (!hasSelectedDays) {
        submitMessage.textContent = "Select at least one available day.";
        submitMessage.style.color = "#ffcf9b";
        return;
      }

      const hasSelectedDuration = Boolean(form.querySelector('input[name="session_duration"]:checked'));
      if (!hasSelectedDuration) {
        submitMessage.textContent = "Select one session duration option.";
        submitMessage.style.color = "#ffcf9b";
        return;
      }

      if (!form.reportValidity()) {
        return;
      }

      const formData = new FormData(form);
      const answers = buildApplicationData(formData);
      const application = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "player",
        submittedAt: new Date().toISOString(),
        discordUsername: answers.discord_username || "N/A",
        answers
      };

      submitButton.disabled = true;
      submitButton.textContent = "Submitting...";
      submitMessage.textContent = "";

      try {
        const result = await saveApplication(application);
        if (result.mode === "remote") {
          submitMessage.textContent = "Player application submitted to shared review storage.";
        } else {
          submitMessage.textContent = "Player application saved locally (shared API not available in file mode).";
        }
        submitMessage.style.color = "#94ffc9";
        form.reset();
      } catch (error) {
        const retrySeconds = Number(error?.retryAfterSeconds || 0);
        if (retrySeconds > 0) {
          const retryMs = retrySeconds * 1000;
          submitMessage.textContent = `Cooldown active. Please wait ${formatCooldown(retryMs)} before submitting again.`;
          submitMessage.style.color = "#ffcf9b";
        } else {
          const message = sanitizeValue(error?.message) || "Could not save player application.";
          submitMessage.textContent = `Could not save player application. ${message}`;
          submitMessage.style.color = "#ffb5c3";
        }
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Submit Player Application";
      }
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
      const answers = buildApplicationData(formData);
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
        const result = await saveApplication(application);
        setCooldown();
        if (result.mode === "remote") {
          submitMessage.textContent = "Application submitted to shared review storage.";
        } else {
          submitMessage.textContent = "Application saved locally (shared API not available in file mode).";
        }
        submitMessage.style.color = "#94ffc9";
        form.reset();
      } catch (error) {
        const retrySeconds = Number(error?.retryAfterSeconds || 0);
        if (retrySeconds > 0) {
          const retryMs = retrySeconds * 1000;
          submitMessage.textContent = `Cooldown active. Please wait ${formatCooldown(retryMs)} before submitting again.`;
          submitMessage.style.color = "#ffcf9b";
        } else {
          const message = sanitizeValue(error?.message) || "Could not save application.";
          submitMessage.textContent = `Could not save application. ${message}`;
          submitMessage.style.color = "#ffb5c3";
        }
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

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (passwordInput.value === ADMIN_PASSWORD) {
        sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
        try {
          await renderAdminPanel(root);
        } catch {
          message.textContent = "Could not open admin panel.";
          message.style.color = "#ffb5c3";
        }
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
    const typeLabel = normalizeApplicationType(application.type).toUpperCase();
    const reviewStatus = normalizeReviewStatus(application.reviewStatus);
    const reviewPillClass =
      reviewStatus === "accepted"
        ? "admin-review-pill-accepted"
        : reviewStatus === "denied"
          ? "admin-review-pill-denied"
          : "admin-review-pill-pending";
    const reviewedMeta = application.reviewedAt ? ` • Reviewed: ${escapeHtml(formatDate(application.reviewedAt))}` : "";

    return `
      <div class="admin-detail-header">
        <h3>${escapeHtml(application.discordUsername || "N/A")}</h3>
        <p>Type: ${escapeHtml(typeLabel)} • Submitted: ${escapeHtml(formatDate(application.submittedAt))}</p>
        <p>
          Review:
          <span class="admin-review-pill ${reviewPillClass}">${escapeHtml(reviewStatusLabel(reviewStatus))}</span>
          ${reviewedMeta}
        </p>
      </div>
      <div class="admin-answer-list">${answersHtml || '<p class="hero-text">No answers found.</p>'}</div>
    `;
  }

  async function renderAdminPanel(root) {
    root.innerHTML = `
      <div class="admin-center">
        <article class="admin-login-card glass">
          <p class="eyebrow">Secret Panel</p>
          <h1>Loading Applications...</h1>
          <p class="hero-text">Syncing shared application data.</p>
        </article>
      </div>
    `;

    let applications = [];
    let storageMessage = "Showing browser-local data.";
    try {
      const loaded = await loadApplicationsForAdmin();
      applications = (loaded.applications || [])
        .slice()
        .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      storageMessage = loaded.storageMessage || storageMessage;
    } catch (error) {
      applications = getStoredApplications()
        .slice()
        .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      storageMessage = `Shared sync unavailable: ${sanitizeValue(error?.message) || "unknown error"}. Showing local backup only.`;
    }

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

        <section class="admin-toolbar glass">
          <div class="admin-toolbar-main">
            <div class="admin-counts">
              <span id="adminCountTotal" class="admin-count-pill"></span>
              <span id="adminCountStaff" class="admin-count-pill"></span>
              <span id="adminCountPlayer" class="admin-count-pill"></span>
              <span id="adminCountAcceptedStaff" class="admin-count-pill"></span>
              <span id="adminCountAcceptedPlayer" class="admin-count-pill"></span>
            </div>
            <p class="admin-storage-note">${escapeHtml(storageMessage)}</p>
            <p id="adminActionMessage" class="admin-storage-note"></p>
          </div>
          <div class="admin-filter-row">
            <button class="chip chip-active" data-admin-filter="all" type="button">All</button>
            <button class="chip" data-admin-filter="staff" type="button">Staff Only</button>
            <button class="chip" data-admin-filter="player" type="button">Player Only</button>
            <button class="chip" data-admin-filter="accepted_staff" type="button">Accepted Staff Applications</button>
            <button class="chip" data-admin-filter="accepted_player" type="button">Accepted Player Applications</button>
          </div>
        </section>

        <div class="admin-panel-grid">
          <aside class="admin-list" id="adminList"></aside>
          <section class="admin-detail" id="adminDetail"></section>
        </div>
      </div>
    `;

    const exitButton = document.getElementById("adminExitBtn");
    const listRoot = document.getElementById("adminList");
    const detailRoot = document.getElementById("adminDetail");
    const filterButtons = Array.from(root.querySelectorAll("[data-admin-filter]"));
    const actionMessageNode = document.getElementById("adminActionMessage");
    let activeFilter = "all";
    let activeApplicationId = "";

    if (exitButton) {
      exitButton.addEventListener("click", () => {
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
        history.replaceState(null, "", window.location.pathname + window.location.search);
        window.location.reload();
      });
    }

    function computeCounts() {
      return applications.reduce(
        (accumulator, application) => {
          const type = normalizeApplicationType(application.type);
          const reviewStatus = normalizeReviewStatus(application.reviewStatus);
          accumulator.total += 1;
          if (type === "staff") {
            accumulator.staff += 1;
            if (reviewStatus === "accepted") {
              accumulator.acceptedStaff += 1;
            }
          } else if (type === "player") {
            accumulator.player += 1;
            if (reviewStatus === "accepted") {
              accumulator.acceptedPlayer += 1;
            }
          } else {
            accumulator.other += 1;
          }
          return accumulator;
        },
        { total: 0, staff: 0, player: 0, acceptedStaff: 0, acceptedPlayer: 0, other: 0 }
      );
    }

    function renderCounts() {
      const counts = computeCounts();
      const totalNode = document.getElementById("adminCountTotal");
      const staffNode = document.getElementById("adminCountStaff");
      const playerNode = document.getElementById("adminCountPlayer");
      const acceptedStaffNode = document.getElementById("adminCountAcceptedStaff");
      const acceptedPlayerNode = document.getElementById("adminCountAcceptedPlayer");

      if (totalNode) {
        totalNode.textContent = `Total: ${counts.total}`;
      }
      if (staffNode) {
        staffNode.textContent = `Staff: ${counts.staff}`;
      }
      if (playerNode) {
        playerNode.textContent = `Player: ${counts.player}`;
      }
      if (acceptedStaffNode) {
        acceptedStaffNode.textContent = `Accepted Staff: ${counts.acceptedStaff}`;
      }
      if (acceptedPlayerNode) {
        acceptedPlayerNode.textContent = `Accepted Player: ${counts.acceptedPlayer}`;
      }
    }

    function setActionMessage(text, color = "") {
      if (!actionMessageNode) {
        return;
      }
      actionMessageNode.textContent = sanitizeValue(text);
      actionMessageNode.style.color = color;
    }

    function getFilteredApplications() {
      if (activeFilter === "all") {
        return applications;
      }
      if (activeFilter === "staff" || activeFilter === "player") {
        return applications.filter((application) => normalizeApplicationType(application.type) === activeFilter);
      }
      if (activeFilter === "accepted_staff") {
        return applications.filter(
          (application) =>
            normalizeApplicationType(application.type) === "staff" &&
            normalizeReviewStatus(application.reviewStatus) === "accepted"
        );
      }
      if (activeFilter === "accepted_player") {
        return applications.filter(
          (application) =>
            normalizeApplicationType(application.type) === "player" &&
            normalizeReviewStatus(application.reviewStatus) === "accepted"
        );
      }
      return applications;
    }

    function renderFilteredContent() {
      if (!listRoot || !detailRoot) {
        return;
      }

      const filtered = getFilteredApplications();
      if (!filtered.length) {
        listRoot.innerHTML = '<p class="hero-text">No applications for this filter yet.</p>';
        detailRoot.innerHTML = '<p class="hero-text">No answers to display for this filter.</p>';
        activeApplicationId = "";
        return;
      }

      if (!filtered.some((application) => application.id === activeApplicationId)) {
        activeApplicationId = filtered[0].id;
      }

      listRoot.innerHTML = filtered
        .map((application) => {
          const isActive = application.id === activeApplicationId;
          const reviewStatus = normalizeReviewStatus(application.reviewStatus);
          const reviewClass =
            reviewStatus === "accepted"
              ? "admin-app-card-accepted"
              : reviewStatus === "denied"
                ? "admin-app-card-denied"
                : "";
          return `
            <article class="admin-app-card ${isActive ? "active" : ""} ${reviewClass}" data-app-id="${escapeHtml(application.id)}">
              <button class="admin-app-main" data-app-select="${escapeHtml(application.id)}" type="button">
                <h3>${escapeHtml(application.discordUsername || "N/A")}</h3>
                <p>${escapeHtml(normalizeApplicationType(application.type).toUpperCase())}</p>
                <small>${escapeHtml(formatDate(application.submittedAt))}</small>
                <small class="admin-review-text">${escapeHtml(reviewStatusLabel(reviewStatus).toUpperCase())}</small>
              </button>
              <div class="admin-app-actions">
                <button
                  class="admin-review-btn admin-review-accept ${reviewStatus === "accepted" ? "is-selected" : ""}"
                  data-review-action="accepted"
                  data-review-id="${escapeHtml(application.id)}"
                  type="button"
                  title="Accept application"
                  aria-label="Accept application">✓</button>
                <button
                  class="admin-review-btn admin-review-deny ${reviewStatus === "denied" ? "is-selected" : ""}"
                  data-review-action="denied"
                  data-review-id="${escapeHtml(application.id)}"
                  type="button"
                  title="Deny application"
                  aria-label="Deny application">✕</button>
              </div>
            </article>
          `;
        })
        .join("");

      const selected = filtered.find((application) => application.id === activeApplicationId) || filtered[0];
      detailRoot.innerHTML = renderApplicationDetail(selected);

      listRoot.querySelectorAll("[data-app-select]").forEach((button) => {
        button.addEventListener("click", () => {
          activeApplicationId = button.getAttribute("data-app-select") || "";
          renderFilteredContent();
        });
      });

      listRoot.querySelectorAll("[data-review-action]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();

          const applicationId = sanitizeValue(button.getAttribute("data-review-id"));
          const action = normalizeReviewStatus(button.getAttribute("data-review-action"));
          if (!applicationId || (action !== "accepted" && action !== "denied")) {
            return;
          }

          const existing = applications.find((application) => application.id === applicationId);
          if (existing && normalizeReviewStatus(existing.reviewStatus) === action) {
            return;
          }

          button.disabled = true;
          setActionMessage("Saving review status...", "#8fdfff");
          try {
            const result = await updateApplicationReviewStatus(applicationId, action);
            applications = mergeApplications([result.application], applications);
            activeApplicationId = applicationId;
            renderCounts();
            setActionMessage(`Application marked as ${reviewStatusLabel(action).toLowerCase()}.`, "#91f7c4");
            renderFilteredContent();
          } catch (error) {
            const message = sanitizeValue(error?.message) || "Could not update review status.";
            setActionMessage(`Failed to update: ${message}`, "#ffc1cf");
          } finally {
            button.disabled = false;
          }
        });
      });

      setupRevealAnimations(root);
    }

    filterButtons.forEach((button) => {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.adminFilter || "all";
        filterButtons.forEach((item) => {
          item.classList.toggle("chip-active", item.dataset.adminFilter === activeFilter);
        });
        activeApplicationId = "";
        renderFilteredContent();
      });
    });

    renderCounts();
    renderFilteredContent();
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
      renderAdminPanel(overlay).catch(() => {
        renderAdminLogin(overlay);
      });
    } else {
      renderAdminLogin(overlay);
    }
  }

  function boot() {
    setYear();
    animatePageIn();
    setupPageTransitionLinks();
    setupRevealAnimations();
    setupEventsFilters();
    setupPlayerApplicationPage();
    setupStaffApplicationPage();
    setupHiddenAdminPanel();
  }

  boot();
})();
