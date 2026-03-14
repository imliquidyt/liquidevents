(() => {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const APPLICATION_WEBHOOK_URL = "https://discord.com/api/webhooks/1482343141154492448/klctKIQxb4_cPfhUsDrl64pkIULro3wh4PFcmdXk2HZzMdDhmx4VFEFUFmvULn2I80Di";
  const STAFF_COOLDOWN_MS = 12 * 60 * 60 * 1000;
  const STAFF_COOLDOWN_PREFIX = "liquid_events_staff_cooldown_until";
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

    document.body.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 260, easing: "ease-out", fill: "both" }
    );
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
    } catch (_error) {
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
        return;
      }

      if (filter === "upcoming") {
        pastSection.hidden = true;
        upcomingSection.hidden = false;
        return;
      }

      pastSection.hidden = false;
      upcomingSection.hidden = false;
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        setFilter(button.dataset.eventFilter || "all");
      });
    });

    setFilter("all");
  }

  function sanitizeValue(value) {
    return String(value || "").trim();
  }

  function cut(value, max = 400) {
    const text = sanitizeValue(value);
    if (!text) {
      return "N/A";
    }
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
  }

  function chunkArray(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
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
      } catch (_error) {
        // Browser-only fallback key is kept if IP lookup fails.
      } finally {
        rateLimitResolved = true;
      }
    })();

    return rateLimitPromise;
  }

  function buildStaffEmbeds(formData) {
    const questions = [
      ["Minecraft Username", "minecraft_username"],
      ["Discord Username (not display name)", "discord_username"],
      ["Email", "email"],
      ["Timezone and Region", "timezone_region"],
      ["Age", "age"],
      ["Agrees to Staff Guidebook", "agree_guidebook"],
      ["Agrees to Weekly Voice Meetings", "agree_voice_meetings"],
      ["Previous Staffing + Discord Link", "past_staffing_with_link"],
      ["Past Roles and Experience", "past_roles"],
      ["One Impactful Change", "impact_change"],
      ["Applied Position", "position"],
      ["Hours per Week", "hours_per_week"],
      ["Understands Inactivity Removal", "inactive_removal_ack"],
      ["Team Collaboration Rating", "teamwork_rating"],
      ["How They Heard About Liquid Events", "discovery_source"],
      ["Why Join Liquid Staff Team", "motivation"],
      ["Scenario: Repeated Rule-Breaking Player", "scenario_rule_breaker"],
      ["Scenario: Two Players Causing Chat Chaos", "scenario_chat_conflict"],
      ["Scenario: Bias/Abuse Accusation", "scenario_bias_claim"],
      ["Scenario: Staff Member Abuses Powers", "scenario_staff_abuse"],
      ["Played/Staffed Civilization Event Before", "civ_event_experience"],
      ["Working Microphone", "has_microphone"],
      ["Comfortable With Commands", "comfortable_commands"],
      ["Maturity Rating", "maturity_rating"],
      ["Anything Else", "extra_notes"]
    ];

    const fields = questions.map(([label, name]) => ({
      name: label,
      value: cut(formData.get(name), 500),
      inline: false
    }));

    const fieldChunks = chunkArray(fields, 8);
    return fieldChunks.map((chunk, index) => ({
      title: index === 0 ? "New Staff Application" : `New Staff Application (Part ${index + 1})`,
      description: index === 0 ? "Submission received from the website form." : undefined,
      color: 0x2de9ff,
      fields: chunk,
      footer: {
        text: "Liquid Events Staff Form"
      },
      timestamp: new Date().toISOString()
    }));
  }

  async function sendPayloadToWebhook(payload) {
    const multipartPayload = new FormData();
    multipartPayload.append("payload_json", JSON.stringify(payload));

    await fetch(APPLICATION_WEBHOOK_URL, {
      method: "POST",
      mode: "no-cors",
      body: multipartPayload
    });
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

      const payload = {
        username: "Liquid Events Applications",
        embeds: buildStaffEmbeds(new FormData(form))
      };

      submitButton.disabled = true;
      submitButton.textContent = "Sending...";
      submitMessage.textContent = "";

      try {
        await sendPayloadToWebhook(payload);
        setCooldown();
        submitMessage.textContent = "Staff application submitted successfully.";
        submitMessage.style.color = "#94ffc9";
        form.reset();
      } catch (_error) {
        submitMessage.textContent = "Could not send application. Please try again.";
        submitMessage.style.color = "#ffb5c3";
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Submit Staff Application";
      }
    });
  }

  function boot() {
    setYear();
    animatePageIn();
    setupPageTransitionLinks();
    setupEventsFilters();
    setupPlayerApplicationPage();
    setupStaffApplicationPage();
  }

  boot();
})();
