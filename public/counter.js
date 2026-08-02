// public/counter.js
(() => {
  const script = document.currentScript;
  if (!script || !script.src) return;

  const serverOrigin = new URL(script.src).origin;

  const domain = (script.dataset.domain || location.hostname || "").toLowerCase();

  // ✅ 新增：项目（同域不同项目）
  // 用法：
  // - data-project="readygodule"：固定项目 key
  // - data-project="auto"：自动取 pathname 第一段，比如 /ReadyGoDuel/ -> readygodule
  const projectRaw = (script.dataset.project || "").trim();
  const deriveProjectFromPath = () => {
    try {
      const seg = (location.pathname || "/").split("/").filter(Boolean)[0] || "";
      return seg ? String(seg).toLowerCase() : "";
    } catch {
      return "";
    }
  };

  let project = "";
  if (projectRaw) {
    if (projectRaw.toLowerCase() === "auto") project = deriveProjectFromPath();
    else project = projectRaw.toLowerCase();
  }

  const targetSelector = script.dataset.target || "";
  const prefix = script.dataset.prefix || "";
  const pollMs = parseInt(script.dataset.poll || "0", 10);

  const state = {
    domain,
    project, // ✅ 新增
    serverOrigin,
    data: null,
    listeners: new Set(),
    requestId: 0,
    appliedRequestId: 0,
  };

  const emit = (data) => {
    state.listeners.forEach((fn) => {
      try { fn(data); } catch {}
    });
    try {
      window.dispatchEvent(new CustomEvent("bftcounter:update", { detail: data }));
    } catch {}
  };

  const fillTarget = (json) => {
    if (!targetSelector) return;
    try {
      const el = document.querySelector(targetSelector);
      if (el) el.textContent = `${prefix}${(json && json.total != null) ? json.total : 0}`;
    } catch {}
  };

  const applyData = (json) => {
    const current = state.data;
    const currentTotal = current && Number(current.total);
    const nextTotal = json && Number(json.total);
    const currentLast = current && Number(current.last);
    const nextLast = json && Number(json.last);

    // GitHub/Vercel reads may briefly come from an older cache entry. Counter
    // values are monotonic, so never let a stale response roll the UI backward.
    if (
      current
      && Number.isFinite(currentTotal)
      && Number.isFinite(nextTotal)
      && (
        nextTotal < currentTotal
        || (
          nextTotal === currentTotal
          && Number.isFinite(currentLast)
          && Number.isFinite(nextLast)
          && nextLast <= currentLast
        )
      )
    ) {
      return current;
    }

    state.data = json;
    emit(json);
    fillTarget(json);
    return json;
  };

  const buildQuery = () => {
    // ✅ 保持旧接口 d 不变；新增可选 p
    const qs = new URLSearchParams();
    qs.set("d", state.domain);
    if (state.project) qs.set("p", state.project);
    return qs.toString();
  };

  const requestHit = async () => {
    const hitUrl = `${serverOrigin}/hit?${buildQuery()}&debug=1`;
    if (typeof fetch !== "function") {
      throw new Error("hit_async_requires_fetch");
    }

    const response = await fetch(hitUrl, {
      method: "POST",
      cache: "no-store",
      keepalive: true,
    });
    if (!response.ok) throw new Error(`hit_http_${response.status}`);

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("hit_bad_json");
    }
    if (!json || !json.ok) throw new Error("hit_failed");

    return json;
  };

  // Legacy contract: fire-and-forget, return undefined, and never leak an
  // unhandled rejection to pages that call BFTCounter.hit() without awaiting.
  const hit = () => {
    const hitUrl = `${serverOrigin}/hit?${buildQuery()}`;
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(hitUrl);
      } else if (typeof fetch === "function") {
        fetch(hitUrl, { cache: "no-store" }).catch(() => {});
      }
    } catch {}
  };

  // Additive API for callers that need the committed GitHub result.
  const hitAsync = async () => {
    const json = await requestHit();
    return json ? applyData(json) : null;
  };

  const statsPayloadFromHit = (json) => {
    const payload = {
      ok: true,
      domain: json.domain,
      total: json.total,
      last: json.last,
    };
    if (json.project) payload.project = json.project;
    return payload;
  };

  const get = async () => {
    const requestId = ++state.requestId;
    const statsUrl = `${serverOrigin}/stats?${buildQuery()}`;
    const r = await fetch(statsUrl, { cache: "no-store" });

    if (!r.ok) {
      throw new Error(`stats_http_${r.status}`);
    }

    const text = await r.text();
    if (!text) throw new Error("stats_empty");

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("stats_bad_json");
    }

    if (!json || !json.ok) {
      throw new Error(json && json.msg ? String(json.msg) : "stats_failed");
    }

    if (requestId < state.appliedRequestId) return state.data || json;
    state.appliedRequestId = requestId;
    return applyData(json);
  };

  const on = (fn) => {
    state.listeners.add(fn);
    if (state.data) {
      try { fn(state.data); } catch {}
    }
    return () => state.listeners.delete(fn);
  };

  // ✅ 暴露全局 API（向下兼容）
  window.BFTCounter = {
    domain: state.domain,
    project: state.project, // ✅ 新增：方便外部显示/调试
    serverOrigin: state.serverOrigin,
    hit,
    hitAsync,
    get,
    on,
    peek: () => state.data,
  };

  const startPolling = () => {
    if (!(pollMs > 0 && Number.isFinite(pollMs))) return;
    let inflight = false;
    setInterval(() => {
      if (inflight) return;
      inflight = true;
      get().catch(() => {}).finally(() => {
        inflight = false;
      });
    }, pollMs);
  };

  // Preserve the original immediate read/poll behavior, then refresh once the
  // GitHub commit finishes so the eventually displayed value is authoritative.
  let initialHit;
  if (typeof fetch === "function") {
    initialHit = requestHit();
  } else {
    hit();
    initialHit = Promise.resolve(null);
  }
  get().catch(() => {});
  initialHit
    .then((json) => {
      if (json) applyData(statsPayloadFromHit(json));
    })
    .catch(() => {});
  startPolling();
})();
