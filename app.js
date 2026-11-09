"use strict";

(function () {
  // 클릭재킹 방어: 다른 페이지 안(iframe)에서 열리면 화면을 비우고 멈춘다.
  if (window.top !== window.self) {
    document.documentElement.replaceChildren();
    return;
  }

  const CFG = window.CURATION_CONFIG;
  const params = new URLSearchParams(location.search);
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  // 테스트용 API 주소 바꾸기: 로컬에서만 받는다(배포 페이지에서 토큰이 다른 곳으로 새지 않게).
  const API = (isLocal && params.get("api")) || CFG.SUPABASE_URL + "/functions/v1/api";
  // 개발용 가짜 데이터: ?mock=1|closed|empty|sunday|html503|statusfail (로그인 없이 화면만 확인)
  const MOCK = params.get("mock");

  // /status 점검 이름 → 짧은 한국어 라벨(모르는 이름은 그대로 보여준다)
  const CHECK_LABELS = {
    list_not_ready: "오늘 목록 준비 안 됨",
    token_expiring: "Threads 토큰 만료 임박",
    job_failed: "예약 작업 실패",
    run_missing: "예정 실행 누락",
    config_invalid: "설정 검증 실패",
    post_uncertain: "게시 결과 불확실",
    items_short: "오늘 항목 10개 미만",
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    login: $("login"), loginForm: $("login-form"), loginError: $("login-error"), loginSubmit: $("login-submit"),
    connFail: $("conn-fail"), connDetail: $("conn-detail"), retry: $("retry"),
    view: $("view"), viewTitle: $("view-title"), viewSub: $("view-sub"),
    digestLink: $("digest-link"), todayLink: $("today-link"), closedBanner: $("closed-banner"),
    loading: $("loading"), viewError: $("view-error"), empty: $("empty"), cards: $("cards"),
    statusBanner: $("status-banner"), actionBar: $("action-bar"), draftBtn: $("draft-btn"), logout: $("logout"),
  };
  $("dashboard-link").href = CFG.DASHBOARD_URL;

  const sb = MOCK ? null : window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);

  // 선택 상태는 메모리에만 둔다(초안 만들기는 M3).
  const selected = new Set();
  let selectedDate = null;
  let loadSeq = 0;

  class ConnError extends Error {}
  class AuthError extends Error {}

  // ---------- 화면 전환 ----------
  function show(screen) {
    el.login.hidden = screen !== "login";
    el.connFail.hidden = screen !== "conn";
    el.view.hidden = screen !== "view";
    el.logout.hidden = screen === "login" || !!MOCK;
    if (screen !== "view") { el.actionBar.hidden = true; el.statusBanner.hidden = true; }
  }

  function showConnFail(detail) {
    el.connDetail.textContent = detail ? "원인: " + detail : "";
    show("conn");
  }

  function showLogin() {
    selected.clear();
    selectedDate = null;
    el.loginError.hidden = true;
    show("login");
  }

  // ---------- API ----------
  async function api(path) {
    if (MOCK) return parse(await mockFetch(path));
    const { data } = await sb.auth.getSession();
    const token = data.session && data.session.access_token;
    if (!token) throw new AuthError("no session");
    let res;
    try {
      res = await fetch(API + path, { headers: { Authorization: "Bearer " + token } });
    } catch (e) {
      throw new ConnError("네트워크 오류");
    }
    return parse(res);
  }

  async function parse(res) {
    if (res.status === 401) throw new AuthError("401");
    if (res.status >= 500) throw new ConnError("HTTP " + res.status);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new ConnError("JSON이 아닌 응답(HTTP " + res.status + ")"); }
    if (!res.ok) throw new Error("요청 실패(HTTP " + res.status + ")");
    return body;
  }

  async function handleError(e) {
    if (e instanceof AuthError) {
      if (sb) await sb.auth.signOut({ scope: "local" });
      showLogin();
    } else if (e instanceof ConnError) {
      showConnFail(e.message);
    } else {
      show("view");
      el.loading.hidden = true;
      el.viewError.textContent = e.message || "알 수 없는 오류";
      el.viewError.hidden = false;
    }
  }

  // ---------- 시간(KST) ----------
  function kstNow() {
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return { day: d.getUTCDay(), hour: d.getUTCHours() };
  }
  function isSundayDigestTime() {
    if (MOCK === "sunday") return true;
    const k = kstNow();
    return k.day === 0 && k.hour >= 7;
  }

  function formatDate(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
    if (!m) return "";
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const dow = days[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
    return Number(m[2]) + "월 " + Number(m[3]) + "일 (" + dow + ")";
  }

  // ---------- 라우팅 ----------
  function route() {
    const v = new URLSearchParams(location.hash.slice(1)).get("v");
    return v === "digest" ? "digest" : "today";
  }

  async function load() {
    const seq = ++loadSeq;
    const v = route();
    show("view");
    resetView(v);
    el.loading.hidden = false;
    try {
      const [data] = await Promise.all([api(v === "digest" ? "/digest" : "/today"), loadStatus()]);
      if (seq !== loadSeq) return;
      el.loading.hidden = true;
      if (v === "digest") renderDigest(data); else renderToday(data);
    } catch (e) {
      if (seq !== loadSeq) return;
      await handleError(e);
    }
  }

  function resetView(v) {
    el.viewTitle.textContent = v === "digest" ? "이번 주 못 본 것" : "오늘의 링크";
    el.viewSub.textContent = "";
    el.digestLink.hidden = true;
    el.todayLink.hidden = v !== "digest";
    el.closedBanner.hidden = true;
    el.viewError.hidden = true;
    el.empty.hidden = true;
    el.cards.replaceChildren();
    el.actionBar.hidden = true;
    document.body.classList.remove("has-bar");
  }

  // /status 실패는 목록 표시를 막지 않고 배너로만 알린다. 401만 위로 올려 로그인 화면으로 보낸다.
  async function loadStatus() {
    try {
      const s = await api("/status");
      const names = s && Array.isArray(s.failing) ? s.failing : [];
      if (!names.length) { el.statusBanner.hidden = true; return; }
      showBanner(names.map((n) => CHECK_LABELS[n] || String(n)).join(" · "));
    } catch (e) {
      if (e instanceof AuthError) throw e;
      showBanner("점검 상태를 불러오지 못했어요");
    }
  }

  function showBanner(text) {
    const strong = document.createElement("strong");
    strong.textContent = "점검 경고";
    const span = document.createElement("span");
    span.textContent = text;
    el.statusBanner.replaceChildren(strong, span);
    el.statusBanner.hidden = false;
  }

  // ---------- 오늘 ----------
  function renderToday(d) {
    const items = Array.isArray(d.items) ? d.items : [];
    if (d.date_kst !== selectedDate) { selected.clear(); selectedDate = d.date_kst; }
    el.viewSub.textContent = formatDate(d.date_kst);
    el.digestLink.hidden = !isSundayDigestTime();
    el.closedBanner.hidden = !d.closed;

    if (!items.length) {
      el.empty.textContent = emptyText(d.status, d.closed);
      el.empty.hidden = false;
      return;
    }
    const sorted = items.slice().sort((a, b) => a.rank - b.rank);
    el.cards.replaceChildren(...sorted.map((it) => card(it, { selectable: true, disabled: !!d.closed })));
    if (!d.closed) {
      el.actionBar.hidden = false;
      document.body.classList.add("has-bar");
      updateBar();
    }
  }

  function emptyText(status, closed) {
    if (closed) return "마감된 목록이 비어 있어요.";
    if (status === "collected") return "요약을 만드는 중이에요. 07:00 전에 준비돼요.";
    if (status === "ready") return "오늘은 고른 링크가 없어요.";
    return "07:00에 준비돼요.";
  }

  // ---------- 주간 묶음 ----------
  function renderDigest(d) {
    const items = Array.isArray(d.items) ? d.items : [];
    el.viewSub.textContent = d.week ? formatDate(d.week) + " 기준 주" : "";
    if (!items.length) {
      el.empty.textContent = "이번 주에 놓친 링크가 없어요.";
      el.empty.hidden = false;
      return;
    }
    el.cards.replaceChildren(...items.map((it) => card(it, { selectable: false })));
  }

  // ---------- 카드 ----------
  function card(it, opt) {
    const li = document.createElement("li");
    li.className = "card";

    const body = document.createElement("div");
    body.className = "card-body";

    const meta = document.createElement("p");
    meta.className = "meta";
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(it.rank);
    meta.append(rank, document.createTextNode(String(it.source_name || "")));
    if (it.topic) {
      const topic = document.createElement("span");
      topic.className = "topic";
      topic.textContent = String(it.topic);
      meta.append(topic);
    }

    const h = document.createElement("h2");
    const a = document.createElement("a");
    a.textContent = String(it.title || it.url || "");
    if (/^https?:\/\//i.test(String(it.url))) a.href = it.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    h.append(a);

    const sum = document.createElement("p");
    sum.className = "summary";
    if (it.summary_ko == null || it.summary_ko === "") {
      sum.classList.add("pending");
      sum.textContent = "요약 준비 중";
    } else {
      if (it.summary_fallback) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "발췌";
        sum.append(tag);
      }
      sum.append(document.createTextNode(String(it.summary_ko)));
    }

    body.append(meta, h, sum);
    li.append(body);

    if (opt.selectable) {
      const label = document.createElement("label");
      label.className = "pick";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(it.id);
      cb.disabled = !!opt.disabled;
      cb.setAttribute("aria-label", "선택: " + String(it.title || ""));
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(it.id); else selected.delete(it.id);
        li.classList.toggle("is-picked", cb.checked);
        updateBar();
      });
      li.classList.toggle("is-picked", cb.checked);
      label.append(cb);
      li.append(label);
    }
    return li;
  }

  function updateBar() {
    // M2: 서버 쪽 초안 생성(POST /drafts)이 M3이라 버튼은 항상 비활성.
    el.draftBtn.textContent = "선택 " + selected.size + "개 → 초안 만들기";
  }

  // ---------- 로그인 ----------
  el.loginForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("email").value.trim();
    const password = $("password").value;
    if (!email || !password) {
      el.loginError.textContent = "이메일과 비밀번호를 입력해 주세요.";
      el.loginError.hidden = false;
      return;
    }
    el.loginSubmit.disabled = true;
    el.loginError.hidden = true;
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (!error) { $("password").value = ""; load(); return; }
      if (error.name === "AuthRetryableFetchError" || (error.status && error.status >= 500)) {
        showConnFail(error.status ? "HTTP " + error.status : "네트워크 오류");
        return;
      }
      el.loginError.textContent = error.status === 429
        ? "시도가 너무 많아요. 잠시 뒤 다시 해 주세요."
        : "이메일 또는 비밀번호가 맞지 않아요.";
      el.loginError.hidden = false;
    } catch (e) {
      showConnFail("네트워크 오류");
    } finally {
      el.loginSubmit.disabled = false;
    }
  });

  el.logout.addEventListener("click", async () => {
    if (sb) await sb.auth.signOut({ scope: "local" });
    showLogin();
  });

  el.retry.addEventListener("click", () => start());
  window.addEventListener("hashchange", () => { if (el.login.hidden) load(); });

  async function start() {
    if (MOCK) { load(); return; }
    let session = null;
    try {
      const { data } = await sb.auth.getSession();
      session = data.session;
    } catch (e) {
      showConnFail("네트워크 오류");
      return;
    }
    if (session) load(); else showLogin();
  }

  // ---------- 개발용 가짜 응답(?mock=) ----------
  function mockFetch(path) {
    const json = (obj, status) => new Response(JSON.stringify(obj), {
      status: status || 200, headers: { "content-type": "application/json" },
    });
    if (MOCK === "html503") {
      return new Response("<html><body>Service Unavailable</body></html>", {
        status: 503, headers: { "content-type": "text/html" },
      });
    }
    if (path === "/status" && MOCK === "statusfail") {
      return new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    }
    if (path === "/status") return json({ ok: false, failing: ["job_failed", "items_short", "new_check_x"] });
    if (path === "/digest") return json({ week: "2026-11-08", items: [] });
    if (MOCK === "empty") return json({ date_kst: "2026-11-10", status: "collecting", closed: false, items: [] });
    return json({ date_kst: "2026-11-10", status: MOCK === "closed" ? "closed" : "ready", closed: MOCK === "closed", items: MOCK_ITEMS });
  }

  const MOCK_ITEMS = [
    ["오픈소스 에이전트 프레임워크, 도구 호출 표준 지원 발표", "Hacker News", "에이전트", "도구 호출 형식을 하나로 맞춰 여러 모델에서 같은 에이전트 코드를 쓸 수 있게 했다. 기존 플러그인과의 호환 범위와 성능 비교 수치가 함께 공개됐다.", false],
    ["Simon Willison: 긴 컨텍스트에서 실제로 무엇이 잊히는가", "Simon Willison", "LLM 신모델", "100만 토큰 컨텍스트에서 앞부분 정보를 찾는 실험을 반복해, 위치별 정답률이 어떻게 떨어지는지 정리했다.", false],
    ["Hugging Face, 소형 코드 모델 평가 세트 공개", "HF Blog", "AI 코딩 도구", "실제 저장소 이슈를 바탕으로 만든 평가 세트로, 7B 이하 모델의 수정 성공률을 비교한다.", false],
    ["A very long title that keeps going to check wrapping behaviour on narrow screens: https://example.com/a/really/long/path/without/spaces/that/should/not/overflow", "The Decoder", null, "Excerpt from the article body because the summary call failed earlier in the morning run.", true],
    ["Google DeepMind, 다중 모달 추론 벤치마크 결과 공유", "Google DeepMind", "LLM 신모델", null, false],
    ["Latent Space: AI 제품 가격 책정의 세 가지 패턴", "Latent Space", "AI 제품·비즈니스", "사용량 기반, 좌석 기반, 결과 기반 가격의 장단점을 실제 회사 사례로 비교했다.", false],
    ["Import AI 412호: 연산 비용 곡선과 규제 동향", "Import AI", null, "학습 비용 추정치 갱신과 함께 각국 규제 초안의 공통점을 짧게 정리했다.", false],
    ["인공지능신문: 국내 기업의 사내 코딩 도우미 도입 현황", "인공지능신문", "AI 코딩 도구", "설문에 응한 기업 절반이 시범 도입 단계이며, 보안 검토가 가장 큰 걸림돌로 꼽혔다.", false],
    ["OpenAI 블로그: 응답 API의 새 추론 설정 안내", "OpenAI", "LLM 신모델", "추론 강도 설정별 지연과 비용 차이를 표로 보여주고 권장 기본값을 제시했다.", false],
    ["HF Daily Papers: 작은 모델로 큰 모델 검증하기", "HF Daily Papers", "에이전트", "작은 검증 모델이 큰 모델의 답을 거르는 방식으로 정확도를 높인 실험을 소개한다.", false],
  ].map((r, i) => ({ id: 100 + i, rank: i + 1, title: r[0], url: "https://example.com/item/" + (i + 1), source_name: r[1], topic: r[2], summary_ko: r[3], summary_fallback: r[4] }));

  start();
})();
