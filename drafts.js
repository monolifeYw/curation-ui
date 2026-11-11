"use strict";

// 초안·편집·게시 화면(#v=drafts). app.js가 ctx를 넘겨 만든다.
// 흐름: 초안 병렬 → (게시 누르면) 컨테이너 순차 → 30초 대기 1회 → 게시 순차(202면 10초 뒤 1회 재호출)
window.CurationDrafts = function (ctx) {
  const PF = window.PostFormat;
  const el = ctx.el;
  const CONTAINER_WAIT = 30;
  const REPUBLISH_WAIT = 10;

  let entries = [];
  let running = false;

  const MSG = {
    llm: "초안을 만들지 못했어요. 다시 시도해 주세요.",
    sendClosed: "전송 마감(00:00)이 지나 초안을 만들 수 없어요.",
    postClosed: "게시 마감(00:30)이 지나 게시할 수 없어요.",
    notFound: "항목을 찾을 수 없어요.",
    noServer: "서버 응답이 없어요. 다시 시도해 주세요.",
    uncertain: "Threads에 올라갔는지 확인 중이에요. 잠시 뒤 다시 게시를 눌러 주세요. 서버가 먼저 같은 글이 있는지 찾아 보고 없을 때만 올려요(중복 게시 없음).",
    stillProcessing: "Threads 처리가 아직 안 끝났어요. 잠시 뒤 다시 게시를 눌러 주세요.",
    noDraft: "서버에 초안이 없어요. 초안을 다시 만들어 주세요.",
    threads: "Threads에 글을 준비하지 못했어요. 다시 게시를 눌러 주세요.",
    failed: "게시에 실패했어요. 코멘트를 확인하고 다시 게시를 눌러 주세요.",
    noContainer: "게시 준비가 안 돼 있어요. 다시 게시를 눌러 주세요.",
    manual: "AI가 초안을 쓰지 못했어요 — 직접 써 주세요.",
  };

  function onBeforeUnload(ev) {
    ev.preventDefault();
    ev.returnValue = "";
  }

  function setRunning(v) {
    running = v;
    document.body.classList.toggle("is-busy", v);
    if (v) window.addEventListener("beforeunload", onBeforeUnload);
    else window.removeEventListener("beforeunload", onBeforeUnload);
    entries.forEach(refresh);
    updateBar();
  }

  const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000 * ctx.waitScale));

  async function countdown(sec, onTick) {
    for (let s = sec; s > 0; s--) { onTick(s); await sleep(1); }
  }

  // 서버 호출. 401은 로그인 화면으로, 네트워크·JSON 아님은 status 0으로 돌려준다.
  async function call(method, path, body) {
    try {
      return await ctx.call(method, path, body);
    } catch (e) {
      if (e instanceof ctx.AuthError) { setRunning(false); ctx.onAuthError(); throw e; }
      return { status: 0, body: null };
    }
  }

  // ---------- 화면 ----------
  function render(items) {
    entries = items.map(makeEntry);
    el.cards.replaceChildren(...entries.map((e) => e.node));
    el.publishBar.hidden = false;
    document.body.classList.add("has-bar");
    el.publishTest.checked = false;
    el.publishProgress.textContent = "";
    updateBar();
    entries.filter((e) => e.phase === "drafting").forEach(loadDraft);
  }

  function makeEntry(it) {
    // 새로고침 뒤 미리보기: 서버와 같은 규칙(summary_ko 첫 문장, 없으면 제목. 목록형은 요약 한 줄 없음)
    const e = {
      // final = 서버에 확정된 코멘트(컨테이너 생성 때 저장). 게시 텍스트는 formatPost로 조립한다.
      it, comment: it.final ?? it.draft ?? "", url: it.url, final: it.final ?? null, format: it.format || "comment",
      summaryLine: it.format === "list" ? ""
        : (it.summary_ko ? PF.summaryLine(it.summary_ko) : "") || String(it.title || ""),
      isTest: it.is_test, permalink: it.permalink || null, msg: "", phase: it.draft != null ? "ready" : "drafting",
    };
    // pending·failed는 다음 container 호출이 이어받으므로 편집 가능(ready)으로 둔다.
    if (it.post_state === "published") e.phase = "published";
    else if (it.post_state === "container_created") e.phase = "container";
    else if (it.post_state === "failed_uncertain") { e.phase = "uncertain"; e.msg = MSG.uncertain; }
    else if (it.post_state === "failed") e.msg = MSG.failed;
    else if (e.phase === "ready" && it.draft === "") e.msg = MSG.manual;

    const li = document.createElement("li");
    li.className = "card draft-card";
    const body = document.createElement("div");
    body.className = "card-body";
    body.append(...ctx.header(it));

    e.stateLine = document.createElement("p");
    e.stateLine.className = "draft-state";

    e.textarea = document.createElement("textarea");
    e.textarea.rows = e.format === "list" ? 9 : 4;
    e.textarea.setAttribute("aria-label", "코멘트: " + String(it.title || ""));
    e.textarea.addEventListener("input", () => { e.comment = e.textarea.value; refresh(e); updateBar(); });

    e.counter = document.createElement("p");
    e.counter.className = "counter";

    e.previewLabel = document.createElement("p");
    e.previewLabel.className = "preview-label";
    e.previewLabel.textContent = "게시될 글";
    e.preview = document.createElement("pre");
    e.preview.className = "preview";

    e.retryBtn = document.createElement("button");
    e.retryBtn.type = "button";
    e.retryBtn.className = "secondary";
    e.retryBtn.textContent = "초안 다시 시도";
    e.retryBtn.addEventListener("click", () => loadDraft(e));

    e.link = document.createElement("a");
    e.link.className = "text-link";
    e.link.target = "_blank";
    e.link.rel = "noopener noreferrer";
    e.link.textContent = "Threads에서 보기 →";

    // 확인한 것만 게시: 체크하면 이번 게시에서 뺀다(00:30 게시 마감 전까지 다시 넣을 수 있음)
    e.skip = false;
    e.skipBox = document.createElement("input");
    e.skipBox.type = "checkbox";
    e.skipBox.addEventListener("change", () => { e.skip = e.skipBox.checked; refresh(e); updateBar(); });
    e.skipToggle = document.createElement("label");
    e.skipToggle.className = "test-toggle skip-toggle";
    e.skipToggle.append(e.skipBox, document.createTextNode(" 이 항목은 게시 안 함"));

    body.append(e.stateLine, e.textarea, e.counter, e.previewLabel, e.preview, e.retryBtn, e.skipToggle, e.link);
    li.append(body);
    e.node = li;
    refresh(e);
    return e;
  }

  function postText(e) {
    if (e.phase === "ready" || e.phase === "drafting" || e.phase === "error") {
      return PF.formatPost(e.comment, e.summaryLine, e.url);
    }
    const c = e.final ?? e.comment;
    return c ? PF.formatPost(c, e.summaryLine, e.url) : "";
  }

  function overLimit(e) {
    return PF.countChars(postText(e)) > PF.MAX_CHARS;
  }

  function refresh(e) {
    const editable = e.phase === "ready";
    const hasText = e.phase !== "drafting" && e.phase !== "error";
    const labels = {
      drafting: "초안 만드는 중…",
      ready: "",
      error: "",
      container: "게시 대기",
      uncertain: "게시 확인 중",
      published: e.isTest ? "게시됨 · 테스트" : "게시됨",
      closed: "마감",
    };
    e.stateLine.replaceChildren();
    if (labels[e.phase]) {
      const pill = document.createElement("span");
      pill.className = "pill pill-" + e.phase;
      pill.textContent = labels[e.phase];
      e.stateLine.append(pill);
    }
    if (e.msg) e.stateLine.append(document.createTextNode(e.msg));
    e.stateLine.hidden = !labels[e.phase] && !e.msg;

    e.textarea.hidden = !editable;
    e.textarea.disabled = !editable || running;
    if (e.textarea.value !== e.comment) e.textarea.value = e.comment;

    const text = postText(e);
    const n = PF.countChars(text);
    e.counter.hidden = !hasText || !text || e.phase === "published";
    const empty = editable && !e.comment.trim();
    e.counter.textContent = n + " / " + PF.MAX_CHARS + "자"
      + (n > PF.MAX_CHARS ? " — 500자를 넘으면 게시할 수 없어요" : empty ? " — 코멘트가 비어 있어요" : "");
    e.counter.classList.toggle("over", n > PF.MAX_CHARS || empty);

    e.previewLabel.textContent = e.format === "list" ? "게시될 글 · 목록형" : "게시될 글";
    e.previewLabel.hidden = !hasText || !text;
    e.preview.hidden = !hasText || !text;
    e.preview.textContent = text;

    e.retryBtn.hidden = e.phase !== "error";
    e.retryBtn.disabled = running;

    // 결과 불확실(uncertain)은 이미 올라갔을 수 있어 빼지 않는다.
    e.skipToggle.hidden = !(e.phase === "ready" || e.phase === "container");
    e.skipBox.disabled = running;
    e.skipBox.checked = e.skip;
    e.node.classList.toggle("is-skipped", e.skip && !e.skipToggle.hidden);

    const safe = /^https:\/\//i.test(String(e.permalink || ""));
    e.link.hidden = !(e.phase === "published" && safe);
    if (safe) e.link.href = e.permalink;
    e.node.classList.toggle("is-done", e.phase === "published");
  }

  // ---------- 1. 초안 ----------
  async function loadDraft(e) {
    e.phase = "drafting";
    e.msg = "";
    refresh(e);
    updateBar();
    const r = await call("POST", "/items/" + e.it.id + "/draft");
    if (r.status === 200 && r.body) {
      e.comment = String(r.body.draft || "");
      e.summaryLine = String(r.body.summary_line || "");
      e.format = r.body.format === "list" ? "list" : "comment";
      e.textarea.rows = e.format === "list" ? 9 : 4;
      e.url = String(r.body.url || e.it.url);
      e.phase = "ready";
      if (r.body.manual) e.msg = MSG.manual;
    } else if (r.status === 409) {
      e.phase = "closed"; e.msg = MSG.sendClosed;
    } else if (r.status === 404) {
      e.phase = "closed"; e.msg = MSG.notFound;
    } else {
      e.phase = "error"; e.msg = r.status === 502 ? MSG.llm : MSG.noServer;
    }
    refresh(e);
    updateBar();
    // 직접 작성: 처음 비어 있는 카드에만 포커스(여러 개면 첫 번째)
    if (e.msg === MSG.manual && !document.querySelector(".draft-card textarea:focus")) e.textarea.focus();
  }

  // ---------- 게시 버튼 ----------
  function targets() {
    return entries.filter((e) =>
      (e.phase === "ready" || e.phase === "container" || e.phase === "uncertain") &&
      !(e.skip && e.phase !== "uncertain")
    );
  }

  function updateBar() {
    const t = targets();
    const blocked = t.some((e) => e.phase === "ready" && (overLimit(e) || !e.comment.trim()));
    const waiting = entries.some((e) => e.phase === "drafting");
    el.publishBtn.disabled = running || waiting || !t.length || blocked;
    el.publishTest.disabled = running;
    el.publishBtn.textContent = running ? "게시 중…"
      : t.length ? (el.publishTest.checked ? "테스트로 " : "") + t.length + "개 게시"
      : "게시할 항목 없음";
  }

  function progress(text) {
    el.publishProgress.textContent = text;
  }

  // ---------- 2–5. 컨테이너 → 대기 → 게시 ----------
  async function publishAll() {
    if (running) return;
    const test = el.publishTest.checked;
    setRunning(true);
    try {
      const fresh = targets().filter((e) => e.phase === "ready");
      let created = false;
      for (let i = 0; i < fresh.length; i++) {
        progress("게시 준비 중 " + (i + 1) + "/" + fresh.length);
        if (await createContainer(fresh[i], test)) created = true;
      }
      if (created) {
        await countdown(CONTAINER_WAIT, (s) => progress("Threads가 글을 처리하는 중 — " + s + "초 뒤 게시해요"));
      }
      const pub = targets().filter((e) => e.phase === "container" || e.phase === "uncertain");
      for (let i = 0; i < pub.length; i++) {
        progress("게시 중 " + (i + 1) + "/" + pub.length);
        await publishOne(pub[i]);
      }
      const done = entries.filter((e) => e.phase === "published").length;
      const skipped = entries.filter((e) => e.skip && (e.phase === "ready" || e.phase === "container")).length;
      const rest = entries.length - done - skipped;
      progress(done + "개 게시됨" + (rest ? " · " + rest + "개는 카드의 안내를 확인해 주세요." : " · 모두 끝났어요."));
    } catch (e) {
      if (!(e instanceof ctx.AuthError)) throw e;
      return;
    } finally {
      setRunning(false);
    }
  }

  async function createContainer(e, test) {
    e.msg = "";
    const comment = e.comment;
    const r = await call("POST", "/items/" + e.it.id + "/container", { comment, test });
    if (r.status === 200 && r.body) {
      e.isTest = !!r.body.is_test;
      e.final = comment.trim();
      if (r.body.state === "published") {
        e.phase = "published";
        e.permalink = r.body.permalink || null;
        refresh(e);
        return false;
      }
      e.phase = "container";
      refresh(e);
      return true;
    }
    if (r.status === 422) {
      const len = r.body && r.body.length;
      e.msg = "서버가 글자 수 초과로 거부했어요" + (len ? "(" + len + "자)" : "") + ". 코멘트를 줄여 주세요.";
    } else if (r.status === 409 && r.body && r.body.error === "no_draft") {
      e.phase = "error"; e.msg = MSG.noDraft;
    } else if (r.status === 409) {
      e.phase = "closed"; e.msg = MSG.postClosed;
    } else if (r.status === 404) {
      e.phase = "closed"; e.msg = MSG.notFound;
    } else {
      e.msg = MSG.threads;
    }
    refresh(e);
    return false;
  }

  async function publishOne(e) {
    e.msg = "";
    refresh(e);
    let r = await call("POST", "/items/" + e.it.id + "/publish");
    if (r.status === 202) {
      await countdown(REPUBLISH_WAIT, (s) => { e.msg = "Threads 처리 대기 — " + s + "초 뒤 다시 확인해요"; refresh(e); });
      e.msg = "";
      r = await call("POST", "/items/" + e.it.id + "/publish");
    }
    if (r.status === 200 && r.body && r.body.state === "published") {
      e.phase = "published";
      e.permalink = r.body.permalink || null;
    } else if (r.status === 202) {
      e.phase = "container"; e.msg = MSG.stillProcessing;
    } else if (r.status === 409 && r.body && r.body.error === "no_container") {
      e.phase = "ready"; e.msg = MSG.noContainer;
    } else if (r.status === 409) {
      e.phase = "closed"; e.msg = MSG.postClosed;
    } else if (r.status === 404) {
      e.phase = "closed"; e.msg = MSG.notFound;
    } else if (r.status === 502 && r.body && r.body.state === "failed") {
      // 확정 실패: 다음 container 호출이 새 컨테이너를 만든다(코멘트 수정 반영).
      e.phase = "ready"; e.msg = MSG.failed;
    } else {
      // failed_uncertain·5xx·네트워크 오류: 게시됐는지 알 수 없다. 자동으로 다시 부르지 않는다.
      e.phase = "uncertain"; e.msg = MSG.uncertain;
    }
    refresh(e);
  }

  el.publishBtn.addEventListener("click", publishAll);
  el.publishTest.addEventListener("change", updateBar);

  return {
    render,
    isRunning: () => running,
    hide() { el.publishBar.hidden = true; },
  };
};
