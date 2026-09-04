(() => {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const STAFF_COOLDOWN_MS = 12 * 60 * 60 * 1000;
  const STAFF_COOLDOWN_PREFIX = "liquid_events_staff_cooldown_until";
  const APPLICATIONS_STORAGE_KEY = "liquid_events_admin_applications_v1";
  const APPLICATIONS_BACKUP_STORAGE_KEY = "liquid_events_admin_applications_backup_v1";
  const APPLICATIONS_API_ENDPOINT = "/api/applications";
  const DISCORD_AUTH_ENDPOINT = "/api/discord-auth";
  const ACTIVE_PLAYER_APPLICATION_SEASON = 4;

  const ADMIN_HASH = "#review";
  const LEGACY_ADMIN_HASH = "#290348";
  const HASH_ROUTE_TO_PAGE = Object.freeze({
    "#home": "/index.html",
    "#events": "/events.html",
    "#event1": "/event-1-0.html",
    "#event2": "/event-2-0.html",
    "#staff": "/staff-application.html",
    "#player": "/player-application.html",
    "#review": "/index.html",
    "#290348": "/index.html",
    "#admin-hub": "/admin-hub.html",
    "#staff-guide": "/staff-guide.html"
  });
  const PAGE_TO_HASH_ROUTE = Object.freeze({
    "/index.html": "#home",
    "/events.html": "#events",
    "/event-1-0.html": "#event1",
    "/event-2-0.html": "#event2",
    "/staff-application.html": "#staff",
    "/player-application.html": "#player",
    "/admin-hub.html": "#admin-hub",
    "/staff-guide.html": "#staff-guide"
  });

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

  function normalizeStaffTeam(value) {
    const normalized = sanitizeValue(value).toLowerCase();
    if (!normalized) {
      return "moderation";
    }
    if (normalized.includes("production")) {
      return "production";
    }
    if (normalized.includes("prod") || normalized.includes("media") || normalized.includes("record")) {
      return "production";
    }
    if (normalized.includes("logistics") || normalized.includes("developer")) {
      return "logistics";
    }
    if (normalized.includes("tech") || normalized.includes("configuration") || normalized.includes("setup")) {
      return "logistics";
    }
    if (
      normalized.includes("moderation") ||
      normalized.includes("moderator") ||
      normalized.includes("admin") ||
      normalized.includes("helper") ||
      normalized.includes("manager")
    ) {
      return "moderation";
    }
    return "moderation";
  }

  function normalizePlayerSeason(value) {
    const numeric = Number(value);
    return [2, 3, 4].includes(numeric) ? numeric : 2;
  }

  function getDiscordUsernameFromAnswers(answers) {
    const source = answers && typeof answers === "object" ? answers : {};
    const candidates = [
      source.discord_username,
      source.production_discord_username,
      source.logistics_discord_username,
      source.discord,
      source.discord_tag
    ];

    for (const candidate of candidates) {
      const normalized = sanitizeValue(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return "";
  }

  function getApplicationPrimaryDiscordName(application) {
    const source = application && typeof application === "object" ? application : {};
    const candidates = [
      source.authUsername,
      source.authDisplayName,
      source.discordUsername,
      getDiscordUsernameFromAnswers(source.answers)
    ];

    for (const candidate of candidates) {
      const normalized = sanitizeValue(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return "";
  }

  function buildDiscordAvatarUrlByIdentity(userId, avatarHash, size = 96) {
    const normalizedUserId = sanitizeValue(userId);
    const normalizedAvatarHash = sanitizeValue(avatarHash);
    const parsedSize = Number(size);
    const normalizedSize = Number.isFinite(parsedSize) ? Math.max(16, Math.min(4096, Math.floor(parsedSize))) : 96;
    if (!normalizedUserId || !normalizedAvatarHash) {
      return "";
    }
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(normalizedUserId)}/${encodeURIComponent(normalizedAvatarHash)}.png?size=${normalizedSize}`;
  }

  function getApplicationDiscordAvatarUrl(application, size = 96) {
    const source = application && typeof application === "object" ? application : {};
    const explicitUrl = sanitizeValue(source.authAvatarUrl || source.discordAvatarUrl);
    if (explicitUrl) {
      return explicitUrl;
    }
    return buildDiscordAvatarUrlByIdentity(source.authUserId, source.authAvatar, size);
  }

  function buildAuthMetadataFromSession(session) {
    const user = session?.loggedIn ? session.user : null;
    if (!user) {
      return {};
    }

    return {
      authUserId: sanitizeValue(user.id),
      authUsername: sanitizeValue(user.username),
      authDisplayName: sanitizeValue(user.displayName || user.globalName || user.username),
      authAvatar: sanitizeValue(user.avatar),
      authAvatarUrl: getDiscordAvatarUrl(user)
    };
  }

  function getApplicationStaffTeam(application) {
    return normalizeStaffTeam(application?.answers?.staff_team || application?.answers?.staff_role || application?.answers?.position || "");
  }

  function getApplicationPlayerSeason(application) {
    if (normalizeApplicationType(application?.type) !== "player") {
      return null;
    }
    return normalizePlayerSeason(application?.season || application?.answers?.player_season || application?.answers?.season || 2);
  }

  function normalizePasteFlags(rawFlags) {
    if (!rawFlags || typeof rawFlags !== "object" || Array.isArray(rawFlags)) {
      return {};
    }

    const normalizedFlags = {};
    Object.entries(rawFlags).forEach(([key, value]) => {
      const normalizedKey = sanitizeValue(key);
      if (!normalizedKey) {
        return;
      }

      // New format: array of pasted text strings
      if (Array.isArray(value)) {
        const texts = value.map((t) => sanitizeValue(t)).filter(Boolean);
        if (texts.length > 0) {
          normalizedFlags[normalizedKey] = texts;
        }
        return;
      }

      // Legacy format: boolean
      if (value === true || value === 1) {
        normalizedFlags[normalizedKey] = true;
        return;
      }

      const normalizedValue = sanitizeValue(value).toLowerCase();
      if (normalizedValue === "true" || normalizedValue === "1") {
        normalizedFlags[normalizedKey] = true;
      }
    });

    return normalizedFlags;
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

  function formatAtHandle(value, fallback = "@unknown") {
    const normalized = sanitizeValue(value).replace(/^@+/, "");
    if (!normalized) {
      return fallback;
    }
    return `@${normalized}`;
  }

  function normalizeRoutePath(pathname) {
    const normalized = sanitizeValue(pathname);
    if (!normalized || normalized === "/") {
      return "/index.html";
    }
    return normalized;
  }

  function getCurrentSourcePagePath() {
    const datasetPathRaw = sanitizeValue(document.body?.dataset?.routePage);
    const datasetPath = datasetPathRaw ? (datasetPathRaw.startsWith("/") ? datasetPathRaw : `/${datasetPathRaw}`) : "";
    if (datasetPath) {
      return normalizeRoutePath(datasetPath);
    }
    return normalizeRoutePath(window.location.pathname);
  }

  function normalizeRouteHash(hash) {
    const raw = sanitizeValue(hash).toLowerCase();
    if (!raw) {
      return "";
    }
    const withPrefix = raw.startsWith("#") ? raw : `#${raw}`;
    if (withPrefix === LEGACY_ADMIN_HASH) {
      return ADMIN_HASH;
    }
    return withPrefix;
  }

  function getHashRouteTargetPage(hash) {
    const normalizedHash = normalizeRouteHash(hash);
    return HASH_ROUTE_TO_PAGE[normalizedHash] || "";
  }

  function getHashRouteFromLinkHref(href) {
    const normalizedHref = sanitizeValue(href);
    if (!normalizedHref) {
      return "";
    }

    try {
      const url = new URL(normalizedHref, window.location.href);
      const isLocalFileMode = window.location.protocol === "file:";
      if (!isLocalFileMode && url.origin !== window.location.origin) {
        return "";
      }
      return normalizeRouteHash(url.hash);
    } catch {
      return "";
    }
  }

  function applyHashRouteMapping() {
    const sourcePagePath = getCurrentSourcePagePath();
    const normalizedHash = normalizeRouteHash(window.location.hash);
    const routeTargetPage = getHashRouteTargetPage(normalizedHash);
    const search = sanitizeValue(window.location.search);

    if (routeTargetPage && sourcePagePath !== routeTargetPage) {
      window.location.replace(`${routeTargetPage}${search}${normalizedHash}`);
      return true;
    }

    const canonicalHash = routeTargetPage ? normalizedHash : PAGE_TO_HASH_ROUTE[sourcePagePath] || "";
    if (!canonicalHash) {
      return false;
    }

    const pathname = sanitizeValue(window.location.pathname);
    const shouldReplaceWithPrettyHash =
      pathname !== "/" || normalizeRouteHash(window.location.hash) !== canonicalHash || window.location.hash !== canonicalHash;

    if (shouldReplaceWithPrettyHash && window.history && typeof window.history.replaceState === "function") {
      window.history.replaceState({}, "", `/${search}${canonicalHash}`);
    }

    return false;
  }

  function getCurrentRelativeUrl() {
    const pathname = sanitizeValue(window.location.pathname) || "/";
    const search = sanitizeValue(window.location.search);
    const hash = sanitizeValue(window.location.hash);
    return `${pathname}${search}${hash}`;
  }

  function buildDiscordLoginUrl(returnTo = "/#home") {
    return `${DISCORD_AUTH_ENDPOINT}?action=login&returnTo=${encodeURIComponent(returnTo)}`;
  }

  function isProtectedApplicationPath(pathname) {
    const normalizedPath = getCurrentSourcePagePath();
    if (normalizedPath.endsWith("/staff-application.html") || normalizedPath.endsWith("/player-application.html")) {
      return true;
    }
    const normalizedHash = normalizeRouteHash(window.location.hash);
    return normalizedHash === "#staff" || normalizedHash === "#player";
  }

  function redirectToDiscordLogin(returnTo = getCurrentRelativeUrl()) {
    window.location.href = buildDiscordLoginUrl(returnTo);
  }

  async function fetchDiscordSession(options = {}) {
    const refreshRole = Boolean(options.refreshRole);
    const endpoint = `${DISCORD_AUTH_ENDPOINT}?action=session${refreshRole ? "&refreshRole=1" : ""}`;
    const response = await fetch(endpoint, {
      method: "GET",
      credentials: "include",
      cache: "no-store"
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(sanitizeValue(payload?.error) || "Could not fetch Discord session.");
    }

    if (!payload || payload.loggedIn !== true || !payload.user) {
      return {
        loggedIn: false,
        user: null
      };
    }

    const user = payload.user;
    return {
      loggedIn: true,
      user: {
        id: sanitizeValue(user.id),
        username: sanitizeValue(user.username),
        globalName: sanitizeValue(user.globalName),
        displayName: sanitizeValue(user.displayName || user.globalName || user.username),
        avatar: sanitizeValue(user.avatar),
        guildMember: Boolean(user.guildMember),
        isStaff: Boolean(user.isStaff)
      }
    };
  }

  function getDiscordAvatarUrl(user) {
    if (!user || !sanitizeValue(user.id) || !sanitizeValue(user.avatar)) {
      return "";
    }
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.png?size=96`;
  }

  function removeProfileMenu() {
    const existing = document.getElementById("discordProfileMenu");
    if (existing) {
      existing.remove();
    }
  }

  function renderProfileMenu(session) {
    removeProfileMenu();
    const topActions = document.querySelector(".top-actions");
    const signInBtn = document.getElementById("navSignIn");

    if (!session?.loggedIn || !session.user) {
      // Show Sign In button when not logged in
      if (signInBtn) signInBtn.style.display = "";
      return;
    }

    // Hide Sign In button when logged in
    if (signInBtn) signInBtn.style.display = "none";

    if (!topActions) return;

    const menu = document.createElement("div");
    menu.className = "profile-menu";
    menu.id = "discordProfileMenu";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-small btn-secondary profile-menu-btn";
    button.setAttribute("aria-expanded", "false");

    const avatarUrlForBtn = getDiscordAvatarUrl(session.user);
    const displayNameForBtn = session.user.displayName || session.user.username || "Profile";
    button.innerHTML = `${avatarUrlForBtn ? `<img src="${escapeHtml(avatarUrlForBtn)}" alt="" style="width:20px;height:20px;border-radius:50%;margin-right:6px;vertical-align:middle;border:1.5px solid rgba(56,189,248,.50);flex-shrink:0">` : ""}<span style="vertical-align:middle">${escapeHtml(displayNameForBtn)}</span>`;

    const popover = document.createElement("div");
    popover.className = "profile-popover";
    popover.hidden = true;
    const avatarUrl = getDiscordAvatarUrl(session.user);
    const nameText = sanitizeValue(session.user.displayName || session.user.username) || "Discord User";
    const tagText = sanitizeValue(session.user.username);
    popover.innerHTML = `
      <div class="profile-popover-header">
        ${avatarUrl ? `<img class="profile-avatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(nameText)} avatar">` : '<div class="profile-avatar profile-avatar-fallback"></div>'}
        <div>
          <p class="profile-name">${escapeHtml(nameText)}</p>
          <p class="profile-tag">${escapeHtml(tagText ? `@${tagText}` : "")}</p>
        </div>
      </div>
      <button type="button" class="profile-signout-btn">Sign out</button>
    `;

    const signOutButton = popover.querySelector(".profile-signout-btn");
    if (signOutButton) {
      signOutButton.addEventListener("click", async () => {
        signOutButton.setAttribute("disabled", "disabled");
        try {
          await fetch(`${DISCORD_AUTH_ENDPOINT}?action=logout`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json"
            }
          });
        } catch {
          // Continue with local cleanup even if the network request fails.
        }
        window.location.href = "/#home";
      });
    }

    button.addEventListener("click", () => {
      const nextExpanded = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(nextExpanded));
      popover.hidden = !nextExpanded;
    });

    document.addEventListener("click", (event) => {
      if (!menu.contains(event.target)) {
        button.setAttribute("aria-expanded", "false");
        popover.hidden = true;
      }
    });

    menu.appendChild(button);
    menu.appendChild(popover);
    topActions.appendChild(menu);
  }

  async function enforceDiscordGate(options = {}) {
    const pathname = sanitizeValue(window.location.pathname);
    const requiresAuth = isProtectedApplicationPath(pathname) || Boolean(options.force);

    let session = {
      loggedIn: false,
      user: null
    };

    try {
      session = await fetchDiscordSession({ refreshRole: Boolean(options.refreshRole) });
    } catch {
      session = {
        loggedIn: false,
        user: null
      };
    }

    renderProfileMenu(session);

    if (requiresAuth && !session.loggedIn) {
      redirectToDiscordLogin(getCurrentRelativeUrl());
      return {
        blocked: true,
        session
      };
    }

    return {
      blocked: false,
      session
    };
  }

  function setupProtectedApplicationLinks(session) {
    const links = Array.from(document.querySelectorAll("a[href]")).filter((link) => {
      const href = sanitizeValue(link.getAttribute("href"));
      if (!href) {
        return false;
      }
      if (href.endsWith("staff-application.html") || href.endsWith("player-application.html")) {
        return true;
      }
      const routeHash = getHashRouteFromLinkHref(href);
      return routeHash === "#staff" || routeHash === "#player";
    });
    if (!links.length) {
      return;
    }

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        if (session?.loggedIn) {
          return;
        }
        if (event.defaultPrevented || event.button !== 0) {
          return;
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        const href = sanitizeValue(link.getAttribute("href"));
        if (!href) {
          return;
        }
        event.preventDefault();
        const routeHash = getHashRouteFromLinkHref(href);
        if (routeHash === "#staff" || routeHash === "#player") {
          redirectToDiscordLogin(`/${routeHash}`);
          return;
        }
        const nextPath = href.startsWith("/") ? href : `/${href}`;
        redirectToDiscordLogin(nextPath);
      });
    });
  }

  function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
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
    const authUserId = sanitizeValue(application.authUserId);
    const authUsername = sanitizeValue(application.authUsername);
    const authDisplayName = sanitizeValue(application.authDisplayName);
    const authAvatar = sanitizeValue(application.authAvatar);
    const authAvatarUrl = sanitizeValue(application.authAvatarUrl) || buildDiscordAvatarUrlByIdentity(authUserId, authAvatar, 96);
    const discordUsername =
      authUsername || authDisplayName || sanitizeValue(application.discordUsername) || getDiscordUsernameFromAnswers(answers) || "N/A";
    const pasteFlags = normalizePasteFlags(application.pasteFlags);

    const type = normalizeApplicationType(application.type);
    const season =
      type === "player"
        ? normalizePlayerSeason(application.season || answers.player_season || answers.season || 2)
        : null;

    return {
      id,
      type,
      season,
      submittedAt,
      discordUsername,
      authUserId,
      authUsername,
      authDisplayName,
      authAvatar,
      authAvatarUrl,
      answers,
      pasteFlags,
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
      credentials: "include",
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
      credentials: "include",
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
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
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
      if (url.pathname.endsWith(".html")) {
        return true;
      }
      const routeHash = normalizeRouteHash(url.hash);
      return url.pathname === "/" && Boolean(HASH_ROUTE_TO_PAGE[routeHash]);
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

  // Reveal-animation nodes start at opacity:0 and are faded in by an
  // IntersectionObserver. Nodes inside a display:none container never
  // intersect, so they stay invisible after the container is unhidden.
  // Force them into their shown state whenever we reveal a hidden section.
  function revealHiddenSection(element) {
    if (!element) {
      return;
    }
    element.removeAttribute("hidden");
    if (element.classList.contains("reveal")) {
      element.classList.add("is-visible");
    }
    element.querySelectorAll(".reveal").forEach((node) => {
      node.classList.add("is-visible");
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

  const PLAYER_MIN_WORDS = 400;
  const PLAYER_WORD_COUNT_FIELDS = Object.freeze([
    { name: "civilization_experience_1", label: "Past Experience (Answer 1)", required: true },
    { name: "civilization_experience_2", label: "Past Experience (Answer 2)", required: true },
    { name: "civilization_experience_3", label: "Past Experience (Answer 3)", required: false },
    { name: "civilization_experience_4", label: "Past Experience (Answer 4)", required: false },
    { name: "character_type", label: "Character type", required: true },
    { name: "major_lore_event", label: "Major lore event", required: true },
    { name: "acceptance_reason", label: "Why accept you", required: true },
    { name: "civ_appeals", label: "Civ event appeal", required: true },
    { name: "playstyle", label: "Playstyle", required: true },
    { name: "leader_approach", label: "Leader approach", required: true },
    { name: "betrayal_response", label: "Betrayal response", required: true }
  ]);

  function countWords(text) {
    return sanitizeValue(text).split(/\s+/).filter(Boolean).length;
  }

  // Adds a live word counter under every textarea in the form. Fields with a
  // minimum show progress toward it and flag themselves until the min is met.
  function setupWordCounters(form) {
    if (!form) {
      return;
    }
    const minimums = new Map(PLAYER_WORD_COUNT_FIELDS.map((field) => [field.name, PLAYER_MIN_WORDS]));

    Array.from(form.querySelectorAll("textarea[name]")).forEach((field) => {
      const fieldName = sanitizeValue(field.getAttribute("name"));
      const minWords = minimums.get(fieldName) || 0;

      const counter = document.createElement("p");
      counter.className = "word-counter";
      field.insertAdjacentElement("afterend", counter);

      const update = () => {
        const words = countWords(field.value);
        if (minWords > 0) {
          counter.textContent = `${words} / ${minWords} words`;
          counter.classList.toggle("word-counter-short", words < minWords);
          counter.classList.toggle("word-counter-ok", words >= minWords);
        } else {
          counter.textContent = `${words} ${words === 1 ? "word" : "words"}`;
        }
      };

      field.addEventListener("input", update);
      update();
    });
  }

  function createFormPasteTracker(form) {
    const pastedFields = new Map(); // fieldName → string[]

    form.addEventListener("paste", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") {
        return;
      }
      const field = target.closest("input[name], textarea[name], select[name]");
      if (!field) {
        return;
      }
      const fieldName = sanitizeValue(field.getAttribute("name"));
      if (!fieldName) {
        return;
      }
      const rawPaste = event.clipboardData ? event.clipboardData.getData("text") : "";
      // Textarea values use \n, but clipboards often carry \r\n. Normalize so
      // the admin-side substring match against the saved answer succeeds.
      const pastedText = rawPaste.replace(/\r\n?/g, "\n").trim();
      if (!pastedText) {
        return;
      }
      const existing = pastedFields.get(fieldName) || [];
      existing.push(pastedText);
      pastedFields.set(fieldName, existing);
    });

    return {
      buildFlags(answers) {
        const answerMap = answers && typeof answers === "object" ? answers : {};
        const flags = {};
        pastedFields.forEach((texts, fieldName) => {
          if (Object.prototype.hasOwnProperty.call(answerMap, fieldName)) {
            flags[fieldName] = texts;
          }
        });
        return flags;
      },
      reset() {
        pastedFields.clear();
      }
    };
  }

  function setupPlayerApplicationPage(session) {
    const startButton = document.getElementById("playerStartBtn");
    const messageNode = document.getElementById("playerStartMessage");
    const formWrap = document.getElementById("playerFormWrap");
    const form = document.getElementById("playerApplicationForm");
    const submitButton = document.getElementById("playerSubmitBtn");
    const submitMessage = document.getElementById("playerSubmitMessage");
    const playerApplicationsOpen = true;

    if (!startButton || !messageNode || !formWrap || !form || !submitButton || !submitMessage) {
      return;
    }
    const pasteTracker = createFormPasteTracker(form);
    setupWordCounters(form);

    if (!playerApplicationsOpen) {
      messageNode.textContent = "Player applications are currently closed.";
      messageNode.style.color = "#ffcf9b";
      startButton.disabled = true;
      startButton.classList.remove("btn-primary");
      startButton.classList.add("btn-secondary");
      startButton.textContent = "Applications Closed";
      formWrap.hidden = true;
    } else {
      messageNode.textContent = "Player applications are open.";
      messageNode.style.color = "#91f7c4";
    }

    startButton.addEventListener("click", () => {
      if (!playerApplicationsOpen) {
        return;
      }
      pasteTracker.reset();
      revealHiddenSection(formWrap);
      const firstCard = formWrap.querySelector(".question-card, .section-divider");
      const target = firstCard || formWrap;
      setTimeout(() => {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
      startButton.textContent = "Continue Application ↓";
      startButton.classList.remove("btn-primary");
      startButton.classList.add("btn-secondary");
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!playerApplicationsOpen) {
        submitMessage.textContent = "Player applications are currently closed.";
        submitMessage.style.color = "#ffcf9b";
        return;
      }

      if (!form.reportValidity()) {
        return;
      }

      for (const field of PLAYER_WORD_COUNT_FIELDS) {
        const el = form.querySelector(`textarea[name="${field.name}"]`);
        if (!el) continue;
        const text = el.value.trim();
        if (!text && !field.required) continue;
        const words = countWords(text);
        if (words < PLAYER_MIN_WORDS) {
          submitMessage.textContent = `"${field.label}" requires at least ${PLAYER_MIN_WORDS} words (currently ${words}).`;
          submitMessage.style.color = "#ffcf9b";
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
      }

      const checkedSkills = form.querySelectorAll('input[name="skills"]:checked');
      if (checkedSkills.length < 2) {
        submitMessage.textContent = "Please select at least 2 skills you enjoy.";
        submitMessage.style.color = "#ffcf9b";
        return;
      }

      const formData = new FormData(form);
      const answers = buildApplicationData(formData);
      answers.player_season = String(ACTIVE_PLAYER_APPLICATION_SEASON);
      const pasteFlags = pasteTracker.buildFlags(answers);
      const authMetadata = buildAuthMetadataFromSession(session);
      const application = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "player",
        season: ACTIVE_PLAYER_APPLICATION_SEASON,
        submittedAt: new Date().toISOString(),
        discordUsername: authMetadata.authUsername || "N/A",
        ...authMetadata,
        pasteFlags,
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
        pasteTracker.reset();
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

  function setupStaffApplicationPage(session) {
    const startButton = document.getElementById("staffStartBtn");
    const startMessage = document.getElementById("staffStartMessage");
    const formWrap = document.getElementById("staffFormWrap");
    const form = document.getElementById("staffApplicationForm");
    const roleQuestionCard = document.getElementById("staffRoleQuestionCard");
    const roleSelect = document.getElementById("staffTeamSelect");
    const roleNextButton = document.getElementById("staffRoleNextBtn");
    const roleBackButton = document.getElementById("staffRoleBackBtn");
    const teamQuestionsWrap = document.getElementById("staffTeamQuestionsWrap");
    const submitButton = document.getElementById("staffSubmitBtn");
    const submitMessage = document.getElementById("staffSubmitMessage");
    const teamSections = Array.from(form?.querySelectorAll("[data-team-question-set]") || []);

    if (
      !startButton ||
      !startMessage ||
      !formWrap ||
      !form ||
      !roleQuestionCard ||
      !roleSelect ||
      !roleNextButton ||
      !roleBackButton ||
      !teamQuestionsWrap ||
      !submitButton ||
      !submitMessage
    ) {
      return;
    }
    const pasteTracker = createFormPasteTracker(form);

    function setActiveTeamSection(team) {
      const normalizedTeam = sanitizeValue(team);
      teamSections.forEach((section) => {
        const active = normalizedTeam && section.dataset.teamQuestionSet === normalizedTeam;
        section.hidden = !active;
        section.querySelectorAll("input, select, textarea").forEach((field) => {
          field.disabled = !active;
        });
      });
    }

    function resetToRoleStep() {
      revealHiddenSection(roleQuestionCard);
      teamQuestionsWrap.hidden = true;
      setActiveTeamSection("");
    }

    resetToRoleStep();

    resolveRateLimitKey().finally(() => {
      const initialCooldown = getRemainingCooldownMs();
      if (initialCooldown > 0) {
        startMessage.textContent = `Submission cooldown active: ${formatCooldown(initialCooldown)} remaining.`;
        startMessage.style.color = "#ffcf9b";
      }
    });

    startButton.addEventListener("click", () => {
      revealHiddenSection(formWrap);
      resetToRoleStep();
      pasteTracker.reset();
      setTimeout(() => {
        formWrap.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    });

    roleNextButton.addEventListener("click", () => {
      const selectedTeam = normalizeStaffTeam(roleSelect.value);
      if (!sanitizeValue(roleSelect.value)) {
        submitMessage.textContent = "Select a team role first.";
        submitMessage.style.color = "#ffcf9b";
        return;
      }
      roleQuestionCard.hidden = true;
      revealHiddenSection(teamQuestionsWrap);
      setActiveTeamSection(selectedTeam);
      submitMessage.textContent = "";
      submitMessage.style.color = "#91f7c4";
      teamQuestionsWrap.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    roleBackButton.addEventListener("click", () => {
      revealHiddenSection(roleQuestionCard);
      teamQuestionsWrap.hidden = true;
      setActiveTeamSection("");
      submitMessage.textContent = "";
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

      if (!sanitizeValue(roleSelect.value)) {
        submitMessage.textContent = "Select a team role and press Next Page first.";
        submitMessage.style.color = "#ffcf9b";
        return;
      }

      if (teamQuestionsWrap.hidden) {
        submitMessage.textContent = "Press Next Page to continue with the selected role questions.";
        submitMessage.style.color = "#ffcf9b";
        return;
      }

      if (!form.reportValidity()) {
        return;
      }

      const formData = new FormData(form);
      const answers = buildApplicationData(formData);
      answers.position = answers.staff_team || "";
      const pasteFlags = pasteTracker.buildFlags(answers);
      const authMetadata = buildAuthMetadataFromSession(session);
      const application = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "staff",
        submittedAt: new Date().toISOString(),
        discordUsername: getDiscordUsernameFromAnswers(answers) || "N/A",
        ...authMetadata,
        pasteFlags,
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
        resetToRoleStep();
        pasteTracker.reset();
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

  function renderAdminAccessMessage(root, options = {}) {
    const message = sanitizeValue(options.message) || "You must sign in with Discord to continue.";
    const showLoginButton = Boolean(options.showLoginButton);
    root.innerHTML = `
      <div class="admin-center">
        <article class="admin-login-card glass">
          <p class="eyebrow">Hidden Admin Panel</p>
          <h1>Liquid Events Review</h1>
          <p class="hero-text">${escapeHtml(message)}</p>
          ${showLoginButton ? '<button id="adminDiscordLoginBtn" class="btn btn-primary" type="button">Login With Discord</button>' : ""}
        </article>
      </div>
    `;

    const loginButton = document.getElementById("adminDiscordLoginBtn");
    if (loginButton) {
      loginButton.addEventListener("click", () => {
        redirectToDiscordLogin(getCurrentRelativeUrl());
      });
    }
  }

  function highlightPastedText(answerText, pasteData) {
    const text = String(answerText).replace(/\r\n?/g, "\n");
    if (!pasteData || pasteData === true || !Array.isArray(pasteData) || pasteData.length === 0) {
      return escapeHtml(text);
    }

    const ranges = [];
    pasteData.forEach((pasted) => {
      const p = String(pasted).replace(/\r\n?/g, "\n").trim();
      if (!p) return;
      let idx = text.indexOf(p);
      while (idx !== -1) {
        ranges.push({ start: idx, end: idx + p.length });
        idx = text.indexOf(p, idx + 1);
      }
    });

    if (ranges.length === 0) {
      return escapeHtml(text);
    }

    ranges.sort((a, b) => a.start - b.start);
    const merged = [{ ...ranges[0] }];
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      if (ranges[i].start <= last.end) {
        last.end = Math.max(last.end, ranges[i].end);
      } else {
        merged.push({ ...ranges[i] });
      }
    }

    let result = "";
    let cursor = 0;
    merged.forEach(({ start, end }) => {
      result += escapeHtml(text.slice(cursor, start));
      result += `<mark class="admin-paste-highlight">${escapeHtml(text.slice(start, end))}</mark>`;
      cursor = end;
    });
    result += escapeHtml(text.slice(cursor));
    return result;
  }

  function renderApplicationDetail(application) {
    const answersHtml = Object.entries(application.answers || {})
      .map(([key, value]) => {
        const pasteData = application.pasteFlags && application.pasteFlags[key];
        const isPasteFlagged = Boolean(pasteData);
        const pastedClass = isPasteFlagged ? " admin-answer-row-pasted" : "";
        const pastedTitle = isPasteFlagged ? ' title="Copy Pasted! Likely AI"' : "";
        return `
          <article class="admin-answer-row${pastedClass}"${pastedTitle}>
            <h4>${escapeHtml(humanizeKey(key))}${isPasteFlagged ? '<span class="admin-paste-flag">Copy Pasted</span>' : ""}</h4>
            <p>${highlightPastedText(value, pasteData)}</p>
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
    const acceptedSelected = reviewStatus === "accepted" ? "is-selected" : "";
    const deniedSelected = reviewStatus === "denied" ? "is-selected" : "";
    const primaryDiscordName = getApplicationPrimaryDiscordName(application) || "N/A";
    const avatarUrl = getApplicationDiscordAvatarUrl(application, 96);
    const fallbackLetter = (sanitizeValue(primaryDiscordName).charAt(0) || "?").toUpperCase();

    return `
      <div class="admin-detail-header">
        <div class="admin-detail-user-row">
          ${
            avatarUrl
              ? `<img class="admin-detail-avatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(primaryDiscordName)} avatar">`
              : `<div class="admin-detail-avatar admin-detail-avatar-fallback" aria-hidden="true">${escapeHtml(fallbackLetter)}</div>`
          }
          <h3>${escapeHtml(primaryDiscordName)}</h3>
        </div>
        <p>Type: ${escapeHtml(typeLabel)} • Submitted: ${escapeHtml(formatDate(application.submittedAt))}</p>
        <p>
          Review:
          <span class="admin-review-pill ${reviewPillClass}">${escapeHtml(reviewStatusLabel(reviewStatus))}</span>
          ${reviewedMeta}
        </p>
        <div class="admin-detail-actions">
          <button
            class="admin-review-btn admin-review-accept ${acceptedSelected}"
            data-detail-review-action="accepted"
            data-review-id="${escapeHtml(application.id)}"
            type="button">✓ Accept</button>
          <button
            class="admin-review-btn admin-review-deny ${deniedSelected}"
            data-detail-review-action="denied"
            data-review-id="${escapeHtml(application.id)}"
            type="button">✕ Deny</button>
        </div>
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

        <section class="admin-toolbar glass" id="adminSectionSelector">
          <div class="admin-toolbar-main">
            <p class="hero-text">Choose which applications area you want to review.</p>
          </div>
          <div class="admin-filter-row" id="adminPrimarySections">
            <button class="chip" data-admin-primary="staff" type="button">Staff Applications</button>
            <button class="chip" data-admin-primary="season2" type="button">Season 2 Applications</button>
            <button class="chip" data-admin-primary="season3" type="button">Season 3 Applications</button>
            <button class="chip" data-admin-primary="season4" type="button">Season 4 Applications</button>
          </div>
          <div class="admin-filter-row" id="adminSecondarySections" hidden></div>
        </section>

        <div id="adminReviewShell" hidden>
          <section class="admin-toolbar glass">
            <div class="admin-toolbar-main">
              <div class="admin-counts">
                <span id="adminCountTotal" class="admin-count-pill"></span>
                <span id="adminCountStaff" class="admin-count-pill"></span>
                <span id="adminCountPlayer" class="admin-count-pill"></span>
                <span id="adminCountAcceptedStaff" class="admin-count-pill"></span>
                <span id="adminCountAcceptedPlayer" class="admin-count-pill"></span>
                <span id="adminCountSeason4Player" class="admin-count-pill"></span>
                <span id="adminCountSeason4AcceptedPlayer" class="admin-count-pill"></span>
              </div>
              <p class="admin-storage-note">${escapeHtml(storageMessage)}</p>
              <p id="adminActionMessage" class="admin-storage-note"></p>
              <label class="admin-search-wrap">
                <input id="adminSearchInput" class="admin-search-input" type="text" placeholder="Search Discord username...">
              </label>
            </div>
            <div class="admin-filter-row">
              <button id="adminDownloadAcceptedPlayersBtn" class="btn btn-secondary btn-small admin-download-btn" type="button" hidden>Download Applications</button>
            </div>
          </section>

          <div class="admin-panel-grid">
            <aside class="admin-list" id="adminList"></aside>
            <section class="admin-detail" id="adminDetail"></section>
          </div>
        </div>
      </div>
    `;

    const exitButton = document.getElementById("adminExitBtn");
    const primarySectionButtons = Array.from(root.querySelectorAll("[data-admin-primary]"));
    const secondarySectionsRoot = document.getElementById("adminSecondarySections");
    const reviewShell = document.getElementById("adminReviewShell");
    const listRoot = document.getElementById("adminList");
    const detailRoot = document.getElementById("adminDetail");
    const actionMessageNode = document.getElementById("adminActionMessage");
    const downloadAcceptedPlayersButton = document.getElementById("adminDownloadAcceptedPlayersBtn");
    const searchInput = document.getElementById("adminSearchInput");
    let activePrimarySection = "";
    let activeFilter = "";
    let activeApplicationId = "";
    let searchQuery = "";

    if (exitButton) {
      exitButton.addEventListener("click", () => {
        history.replaceState(null, "", window.location.pathname + window.location.search);
        window.location.reload();
      });
    }

    function computeCounts() {
      return applications.reduce(
        (accumulator, application) => {
          const type = normalizeApplicationType(application.type);
          const reviewStatus = normalizeReviewStatus(application.reviewStatus);
          const season = getApplicationPlayerSeason(application);
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
            if (season === 4) {
              accumulator.season4Player += 1;
              if (reviewStatus === "accepted") {
                accumulator.season4AcceptedPlayer += 1;
              }
            }
          } else {
            accumulator.other += 1;
          }
          return accumulator;
        },
        { total: 0, staff: 0, player: 0, acceptedStaff: 0, acceptedPlayer: 0, season4Player: 0, season4AcceptedPlayer: 0, other: 0 }
      );
    }

    function renderCounts() {
      const counts = computeCounts();
      const totalNode = document.getElementById("adminCountTotal");
      const staffNode = document.getElementById("adminCountStaff");
      const playerNode = document.getElementById("adminCountPlayer");
      const acceptedStaffNode = document.getElementById("adminCountAcceptedStaff");
      const acceptedPlayerNode = document.getElementById("adminCountAcceptedPlayer");
      const season4PlayerNode = document.getElementById("adminCountSeason4Player");
      const season4AcceptedPlayerNode = document.getElementById("adminCountSeason4AcceptedPlayer");

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
      if (season4PlayerNode) {
        season4PlayerNode.textContent = `Season 4 Player: ${counts.season4Player}`;
      }
      if (season4AcceptedPlayerNode) {
        season4AcceptedPlayerNode.textContent = `Season 4 Accepted Player: ${counts.season4AcceptedPlayer}`;
      }
    }

    function getSecondaryOptions(primarySection) {
      if (primarySection === "staff") {
        return [
          { filter: "staff_moderation", label: "Moderation Team" },
          { filter: "staff_production", label: "Production Team" },
          { filter: "staff_logistics", label: "Logistics Team" },
          { filter: "staff_moderation_accepted", label: "Moderation Team Accepted" },
          { filter: "staff_production_accepted", label: "Production Team Accepted" },
          { filter: "staff_logistics_accepted", label: "Logistics Team Accepted" }
        ];
      }
      if (primarySection === "season2") {
        return [
          { filter: "season2_player", label: "Season 2 Player" },
          { filter: "season2_player_accepted", label: "Season 2 Accepted Player" }
        ];
      }
      if (primarySection === "season3") {
        return [
          { filter: "season3_player", label: "Season 3 Player" },
          { filter: "season3_player_accepted", label: "Season 3 Accepted Player" }
        ];
      }
      if (primarySection === "season4") {
        return [
          { filter: "season4_player", label: "Season 4 Player" },
          { filter: "season4_player_accepted", label: "Season 4 Accepted Player" }
        ];
      }
      return [];
    }

    function renderSecondarySectionOptions(primarySection) {
      if (!secondarySectionsRoot) {
        return;
      }

      const options = getSecondaryOptions(primarySection);
      if (!options.length) {
        secondarySectionsRoot.hidden = true;
        secondarySectionsRoot.innerHTML = "";
        return;
      }

      secondarySectionsRoot.hidden = false;
      secondarySectionsRoot.innerHTML = options
        .map((option) => `<button class="chip" data-admin-filter="${escapeHtml(option.filter)}" type="button">${escapeHtml(option.label)}</button>`)
        .join("");

      const optionButtons = Array.from(secondarySectionsRoot.querySelectorAll("[data-admin-filter]"));
      optionButtons.forEach((button) => {
        button.addEventListener("click", () => {
          activeFilter = sanitizeValue(button.dataset.adminFilter);
          optionButtons.forEach((item) => {
            item.classList.toggle("chip-active", item.dataset.adminFilter === activeFilter);
          });
          activeApplicationId = "";
          if (reviewShell) {
            reviewShell.hidden = false;
          }
          renderCounts();
          renderFilteredContent();
        });
      });
    }

    function setActionMessage(text, color = "") {
      if (!actionMessageNode) {
        return;
      }
      actionMessageNode.textContent = sanitizeValue(text);
      actionMessageNode.style.color = color;
    }

    function getFilteredApplications() {
      let byType = applications;
      if (activeFilter === "staff_moderation") {
        byType = applications.filter(
          (application) => normalizeApplicationType(application.type) === "staff" && getApplicationStaffTeam(application) === "moderation"
        );
      } else if (activeFilter === "staff_production") {
        byType = applications.filter(
          (application) => normalizeApplicationType(application.type) === "staff" && getApplicationStaffTeam(application) === "production"
        );
      } else if (activeFilter === "staff_logistics") {
        byType = applications.filter(
          (application) => normalizeApplicationType(application.type) === "staff" && getApplicationStaffTeam(application) === "logistics"
        );
      } else if (activeFilter === "staff_moderation_accepted") {
        byType = applications.filter(
          (application) =>
            normalizeApplicationType(application.type) === "staff" &&
            getApplicationStaffTeam(application) === "moderation" &&
            normalizeReviewStatus(application.reviewStatus) === "accepted"
        );
      } else if (activeFilter === "staff_production_accepted") {
        byType = applications.filter(
          (application) =>
            normalizeApplicationType(application.type) === "staff" &&
            getApplicationStaffTeam(application) === "production" &&
            normalizeReviewStatus(application.reviewStatus) === "accepted"
        );
      } else if (activeFilter === "staff_logistics_accepted") {
        byType = applications.filter(
          (application) =>
            normalizeApplicationType(application.type) === "staff" &&
            getApplicationStaffTeam(application) === "logistics" &&
            normalizeReviewStatus(application.reviewStatus) === "accepted"
        );
      } else if (activeFilter === "season2_player") {
        byType = applications.filter(
          (application) => normalizeApplicationType(application.type) === "player" && getApplicationPlayerSeason(application) === 2
        );
      } else if (activeFilter === "season2_player_accepted") {
        byType = applications.filter(
          (application) =>
            normalizeApplicationType(application.type) === "player" &&
            getApplicationPlayerSeason(application) === 2 &&
            normalizeReviewStatus(application.reviewStatus) === "accepted"
        );
      } else if (activeFilter === "season3_player") {
        byType = applications.filter(
          (application) => normalizeApplicationType(application.type) === "player" && getApplicationPlayerSeason(application) === 3
        );
      } else if (activeFilter === "season3_player_accepted") {
        byType = applications.filter(
          (application) =>
            normalizeApplicationType(application.type) === "player" &&
            getApplicationPlayerSeason(application) === 3 &&
            normalizeReviewStatus(application.reviewStatus) === "accepted"
        );
      } else if (activeFilter === "season4_player") {
        byType = applications.filter(
          (application) => normalizeApplicationType(application.type) === "player" && getApplicationPlayerSeason(application) === 4
        );
      } else if (activeFilter === "season4_player_accepted") {
        byType = applications.filter(
          (application) =>
            normalizeApplicationType(application.type) === "player" &&
            getApplicationPlayerSeason(application) === 4 &&
            normalizeReviewStatus(application.reviewStatus) === "accepted"
        );
      } else {
        byType = [];
      }

      const normalizedQuery = sanitizeValue(searchQuery).toLowerCase();
      if (!normalizedQuery) {
        return byType;
      }

      return byType.filter((application) =>
        sanitizeValue(getApplicationPrimaryDiscordName(application))
          .toLowerCase()
          .includes(normalizedQuery)
      );
    }

    function updateDownloadButtonVisibility() {
      if (!downloadAcceptedPlayersButton) {
        return;
      }
      const isAcceptedPlayerFilter = activeFilter === "season2_player_accepted" || activeFilter === "season3_player_accepted" || activeFilter === "season4_player_accepted";
      downloadAcceptedPlayersButton.hidden = !isAcceptedPlayerFilter;
    }

    async function applyReviewAction(applicationId, action, triggerButton) {
      const normalizedId = sanitizeValue(applicationId);
      const normalizedAction = normalizeReviewStatus(action);
      if (!normalizedId || (normalizedAction !== "accepted" && normalizedAction !== "denied")) {
        return;
      }

      const existing = applications.find((application) => application.id === normalizedId);
      if (existing && normalizeReviewStatus(existing.reviewStatus) === normalizedAction) {
        return;
      }

      if (triggerButton) {
        triggerButton.disabled = true;
      }
      setActionMessage("Saving review status...", "#8fdfff");
      try {
        const result = await updateApplicationReviewStatus(normalizedId, normalizedAction);
        applications = mergeApplications([result.application], applications);
        activeApplicationId = normalizedId;
        renderCounts();
        setActionMessage(`Application marked as ${reviewStatusLabel(normalizedAction).toLowerCase()}.`, "#91f7c4");
        renderFilteredContent();
      } catch (error) {
        const message = sanitizeValue(error?.message) || "Could not update review status.";
        setActionMessage(`Failed to update: ${message}`, "#ffc1cf");
      } finally {
        if (triggerButton) {
          triggerButton.disabled = false;
        }
      }
    }

    function renderFilteredContent() {
      if (!listRoot || !detailRoot) {
        return;
      }

      const filtered = getFilteredApplications();
      updateDownloadButtonVisibility();
      if (!filtered.length) {
        const message = sanitizeValue(searchQuery)
          ? "No applications match this Discord search in the selected category."
          : "No applications for this filter yet.";
        listRoot.innerHTML = `<p class="hero-text">${escapeHtml(message)}</p>`;
        detailRoot.innerHTML = '<p class="hero-text">No answers to display for this filter.</p>';
        activeApplicationId = "";
        return;
      }

      if (!filtered.some((application) => application.id === activeApplicationId)) {
        activeApplicationId = filtered[0].id;
      }

      listRoot.innerHTML = filtered
        .map((application, index) => {
          const isActive = application.id === activeApplicationId;
          const applicationType = normalizeApplicationType(application.type);
          const reviewStatus = normalizeReviewStatus(application.reviewStatus);
          const displayNumber = filtered.length - index;
          const isAcceptedPlayerView = activeFilter === "season2_player_accepted" || activeFilter === "season3_player_accepted";
          const shouldShowPlayerTeamLabel = isAcceptedPlayerView && applicationType === "player";
          const primaryDiscordName = getApplicationPrimaryDiscordName(application) || "N/A";
          const avatarUrl = getApplicationDiscordAvatarUrl(application, 64);
          const fallbackLetter = (sanitizeValue(primaryDiscordName).charAt(0) || "?").toUpperCase();
          const spawnPreference = sanitizeValue(application.answers?.spawn_preference);
          const listCardTitle = shouldShowPlayerTeamLabel
            ? `${primaryDiscordName}${spawnPreference ? ` - ${spawnPreference}` : ""}`
            : primaryDiscordName;
          const reviewClass =
            reviewStatus === "accepted"
              ? "admin-app-card-accepted"
              : reviewStatus === "denied"
                ? "admin-app-card-denied"
                : "";
          return `
            <article class="admin-app-card ${isActive ? "active" : ""} ${reviewClass}" data-app-id="${escapeHtml(application.id)}">
              <button class="admin-app-main" data-app-select="${escapeHtml(application.id)}" type="button">
                <div class="admin-app-title-row">
                  <div class="admin-app-user">
                    ${
                      avatarUrl
                        ? `<img class="admin-app-avatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(primaryDiscordName)} avatar">`
                        : `<div class="admin-app-avatar admin-app-avatar-fallback" aria-hidden="true">${escapeHtml(fallbackLetter)}</div>`
                    }
                    <h3>${escapeHtml(listCardTitle)}</h3>
                  </div>
                  <span class="admin-app-number">#${escapeHtml(String(displayNumber))}</span>
                </div>
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
          const applicationId = button.getAttribute("data-review-id");
          const action = button.getAttribute("data-review-action");
          await applyReviewAction(applicationId, action, button);
        });
      });

      detailRoot.querySelectorAll("[data-detail-review-action]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const applicationId = button.getAttribute("data-review-id");
          const action = button.getAttribute("data-detail-review-action");
          await applyReviewAction(applicationId, action, button);
        });
      });

      setupRevealAnimations(root);
    }

    primarySectionButtons.forEach((button) => {
      button.addEventListener("click", () => {
        activePrimarySection = sanitizeValue(button.dataset.adminPrimary);
        primarySectionButtons.forEach((item) => {
          item.classList.toggle("chip-active", item.dataset.adminPrimary === activePrimarySection);
        });
        if (reviewShell) {
          reviewShell.hidden = true;
        }
        activeFilter = "";
        activeApplicationId = "";
        searchQuery = "";
        if (searchInput) {
          searchInput.value = "";
        }
        renderSecondarySectionOptions(activePrimarySection);
      });
    });

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value || "";
        activeApplicationId = "";
        renderFilteredContent();
      });
    }

    if (downloadAcceptedPlayersButton) {
      downloadAcceptedPlayersButton.addEventListener("click", () => {
        const acceptedPlayers = getFilteredApplications().filter(
          (application) =>
            normalizeApplicationType(application.type) === "player" &&
            normalizeReviewStatus(application.reviewStatus) === "accepted"
        );

        if (!acceptedPlayers.length) {
          setActionMessage("No accepted player applications found to export.", "#ffcf9b");
          return;
        }

        const discordContent = acceptedPlayers
          .map((application) => formatAtHandle(getApplicationPrimaryDiscordName(application), "@unknown"))
          .join("\n");

        const minecraftContent = acceptedPlayers
          .map((application) => {
            const answers = application.answers || {};
            const username = formatAtHandle(answers.minecraft_username, "@unknown");
            const uuid = sanitizeValue(answers.minecraft_uuid) || "N/A";
            const edition = sanitizeValue(answers.edition) || "N/A";
            return `${username}\n${uuid}\n${edition}`;
          })
          .join("\n\n");

        downloadTextFile("discord.txt", discordContent);
        downloadTextFile("minecraft.txt", minecraftContent);
        setActionMessage(`Downloaded exports for ${acceptedPlayers.length} accepted player applications.`, "#91f7c4");
      });
    }

    renderCounts();
  }

  async function setupHiddenAdminPanel() {
    const normalizedHash = normalizeRouteHash(window.location.hash);
    if (normalizedHash !== ADMIN_HASH) {
      return;
    }

    hidePublicSiteForAdminMode();

    const overlay = document.createElement("section");
    overlay.id = "hiddenAdminOverlay";
    overlay.className = "admin-overlay";
    document.body.appendChild(overlay);

    let session = {
      loggedIn: false,
      user: null
    };
    try {
      session = await fetchDiscordSession({ refreshRole: true });
    } catch {
      session = {
        loggedIn: false,
        user: null
      };
    }

    if (!session.loggedIn) {
      renderAdminAccessMessage(overlay, {
        message: "Please sign in with Discord. Staff role members can access this panel.",
        showLoginButton: true
      });
      return;
    }

    if (!session.user?.isStaff) {
      renderAdminAccessMessage(overlay, {
        message: "You are signed in, but this Discord account does not have the required staff role.",
        showLoginButton: false
      });
      return;
    }

    renderAdminPanel(overlay).catch(() => {
      renderAdminAccessMessage(overlay, {
        message: "Could not open the admin panel right now.",
        showLoginButton: false
      });
    });
  }

  async function boot() {
    const isRedirectingForRoute = applyHashRouteMapping();
    if (isRedirectingForRoute) {
      return;
    }
    window.addEventListener("hashchange", () => {
      applyHashRouteMapping();
    });
    setYear();
    animatePageIn();
    setupRevealAnimations();
    setupEventsFilters();
    const gate = await enforceDiscordGate();
    setupProtectedApplicationLinks(gate.session);
    setupPageTransitionLinks();
    if (gate.blocked) {
      return;
    }
    setupPlayerApplicationPage(gate.session);
    setupStaffApplicationPage(gate.session);
    await setupHiddenAdminPanel();
  }

  boot().catch(() => {
    // Fail quietly to preserve baseline page rendering.
  });
})();
