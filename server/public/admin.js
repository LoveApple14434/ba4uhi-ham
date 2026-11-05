"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    loginView: $("login-view"),
    appView: $("app-view"),
    loginForm: $("login-form"),
    password: $("password"),
    loginError: $("login-error"),
    logout: $("logout-button"),
    siteLink: $("site-link"),
    add: $("add-button"),
    total: $("total-count"),
    unique: $("unique-count"),
    latest: $("latest-date"),
    search: $("search-input"),
    listStatus: $("list-status"),
    recordList: $("record-list"),
    empty: $("empty-state"),
    dialog: $("record-dialog"),
    form: $("record-form"),
    dialogTitle: $("dialog-title"),
    closeDialog: $("close-dialog"),
    cancelDialog: $("cancel-dialog"),
    saveButton: $("save-button"),
    formError: $("form-error"),
    toast: $("toast"),
  };

  const state = {
    csrfToken: "",
    records: [],
    query: "",
    editingId: null,
    siteUrl: "/",
  };

  let toastTimer = 0;

  async function api(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };
    if (options.body) headers["Content-Type"] = "application/json";
    if (state.csrfToken && method !== "GET" && method !== "HEAD") {
      headers["X-CSRF-Token"] = state.csrfToken;
    }

    const response = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      if (response.status === 401 && path !== "api/login") {
        showLogin("登录已过期，请重新登录。");
      }
      throw new Error((data && data.error) || `请求失败（${response.status}）`);
    }
    return data;
  }

  function setSiteUrl(url) {
    state.siteUrl = url || "/";
    els.siteLink.href = state.siteUrl;
  }

  function showLogin(message = "") {
    state.csrfToken = "";
    state.records = [];
    state.query = "";
    state.editingId = null;
    closeDialog();
    els.loginView.hidden = false;
    els.appView.hidden = true;
    els.logout.hidden = true;
    els.password.value = "";
    setLoginError(message);
    window.setTimeout(() => els.password.focus(), 30);
  }

  function showApp() {
    els.loginView.hidden = true;
    els.appView.hidden = false;
    els.logout.hidden = false;
  }

  function setLoginError(message) {
    els.loginError.textContent = message || "";
    els.loginError.hidden = !message;
  }

  function setFormError(message) {
    els.formError.textContent = message || "";
    els.formError.hidden = !message;
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      els.toast.classList.remove("is-visible");
    }, 3200);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function localDateParts() {
    const now = new Date();
    return {
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    };
  }

  function formatRst(record) {
    if (record.rst_sent || record.rst_rcvd) {
      return `${record.rst_sent || "—"} / ${record.rst_rcvd || "—"}`;
    }
    if (record.report != null && record.report !== "") {
      return String(record.report);
    }
    return "—";
  }

  function formatDate(record) {
    const raw = String(record.date || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return {
        year: raw.slice(0, 4),
        short: raw.slice(5).replace("-", "."),
      };
    }
    return { year: "—", short: "—" };
  }

  function recordCard(record) {
    const date = formatDate(record);
    const callsign = escapeHtml(record.callsign || "未填写呼号");
    const freq = record.freq_rx ? `${escapeHtml(record.freq_rx)} MHz` : "频率未记录";
    const mode = record.mode ? escapeHtml(record.mode) : "—";
    const rst = escapeHtml(formatRst(record));
    const meta = [record.qth, record.rig, record.remarks]
      .filter((value) => value != null && String(value).trim() !== "")
      .map((value) => escapeHtml(value))
      .join(" · ");

    return `
      <article class="record-card">
        <div class="record-date">
          <strong>${escapeHtml(date.short)}</strong>
          <span>${escapeHtml(date.year)} · ${escapeHtml(record.time || "—")}</span>
        </div>
        <div class="record-main">
          <h3>${callsign}</h3>
          <p>${freq} · ${mode} · RST ${rst}</p>
          <p class="record-meta">${meta || "—"}</p>
        </div>
        <div class="record-actions">
          <button class="btn btn-small btn-quiet" type="button" data-action="edit" data-id="${Number(record.id)}">编辑</button>
          <button class="btn btn-small btn-quiet danger" type="button" data-action="delete" data-id="${Number(record.id)}">删除</button>
        </div>
      </article>
    `;
  }

  function renderRecords() {
    const query = state.query.trim().toLowerCase();
    const filtered = query
      ? state.records.filter((record) =>
          [
            record.callsign,
            record.qth,
            record.date,
            record.time,
            record.grid,
            record.rig,
            record.remarks,
            record.my_rig,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query)
        )
      : state.records;

    els.recordList.innerHTML = filtered.map(recordCard).join("");
    els.empty.hidden = filtered.length !== 0;
    els.recordList.hidden = filtered.length === 0;
    els.listStatus.textContent = query
      ? `${filtered.length} / ${state.records.length} 条匹配`
      : `共 ${state.records.length} 条记录`;
  }

  function updateStats(data) {
    els.total.textContent = String(data.total ?? state.records.length);
    els.unique.textContent = String(data.unique ?? "—");
    els.latest.textContent = data.latest || "—";
  }

  async function loadRecords() {
    els.listStatus.textContent = "正在加载…";
    try {
      const data = await api("api/records");
      state.records = data.records || [];
      updateStats(data);
      renderRecords();
    } catch (error) {
      if (els.appView.hidden) return;
      toast(error.message);
      els.listStatus.textContent = "加载失败";
    }
  }

  function setFormValue(name, value) {
    const field = els.form.elements.namedItem(name);
    if (field) field.value = value == null ? "" : String(value);
  }

  function resetFormForAdd() {
    els.form.reset();
    const now = localDateParts();
    setFormValue("date", now.date);
    setFormValue("time", now.time);
    setFormValue("freq_rx", "430.610");
    setFormValue("freq_tx", "439.610");
    setFormValue("mode", "FM");
    setFormValue("rst_sent", "59");
    setFormValue("rst_rcvd", "59");
    let lastRig = "UV-K6";
    try {
      lastRig = window.localStorage.getItem("ba4uhi-last-rig") || lastRig;
    } catch {
      // localStorage may be unavailable in privacy mode.
    }
    setFormValue("my_rig", lastRig);
    setFormValue("my_ant", "原装");
    setFormValue("my_pwr", "L");
    setFormError("");
    state.editingId = null;
    els.dialogTitle.textContent = "新增记录";
    els.saveButton.textContent = "保存记录";
  }

  function openAddDialog() {
    resetFormForAdd();
    if (typeof els.dialog.showModal === "function") {
      els.dialog.showModal();
    } else {
      els.dialog.setAttribute("open", "");
    }
    window.setTimeout(() => els.form.elements.namedItem("callsign").focus(), 40);
  }

  function fillForm(record) {
    els.form.reset();
    for (const name of [
      "date",
      "time",
      "callsign",
      "freq_rx",
      "freq_tx",
      "mode",
      "rst_sent",
      "rst_rcvd",
      "qth",
      "grid",
      "rig",
      "ant",
      "pwr",
      "name",
      "my_rig",
      "my_ant",
      "my_pwr",
      "remarks",
    ]) {
      setFormValue(name, record[name]);
    }
    setFormError("");
    state.editingId = Number(record.id);
    els.dialogTitle.textContent = "编辑记录";
    els.saveButton.textContent = "保存修改";
  }

  function openEditDialog(record) {
    fillForm(record);
    if (typeof els.dialog.showModal === "function") {
      els.dialog.showModal();
    } else {
      els.dialog.setAttribute("open", "");
    }
    window.setTimeout(() => els.form.elements.namedItem("callsign").focus(), 40);
  }

  function closeDialog() {
    if (els.dialog.open) {
      els.dialog.close();
    } else {
      els.dialog.removeAttribute("open");
    }
    state.editingId = null;
    setFormError("");
  }

  function formValues() {
    const values = Object.fromEntries(new FormData(els.form).entries());
    return values;
  }

  async function saveRecord(event) {
    event.preventDefault();
    if (!els.form.reportValidity()) return;

    const values = formValues();
    const isEdit = state.editingId !== null;
    const path = isEdit ? `api/records/${state.editingId}` : "api/records";

    els.saveButton.disabled = true;
    els.saveButton.textContent = "保存中…";
    setFormError("");

    try {
      const data = await api(path, {
        method: isEdit ? "PUT" : "POST",
        body: JSON.stringify(values),
      });
      state.records = data.records || [];
      updateStats(data);
      renderRecords();
      closeDialog();
      toast(isEdit ? "记录已更新" : "记录已添加");
      if (values.my_rig) {
        try {
          window.localStorage.setItem("ba4uhi-last-rig", values.my_rig);
        } catch {
          // Ignore storage failures.
        }
      }
    } catch (error) {
      setFormError(error.message);
    } finally {
      els.saveButton.disabled = false;
      els.saveButton.textContent = isEdit ? "保存修改" : "保存记录";
    }
  }

  async function deleteRecord(record) {
    const label = `${record.callsign || "未填写呼号"} · ${record.date || "未填写日期"}`;
    const confirmed = window.confirm(`确定删除这条记录吗？\n\n${label}\n\n保存时会自动备份 data.js。`);
    if (!confirmed) return;

    try {
      const data = await api(`api/records/${record.id}`, { method: "DELETE" });
      state.records = data.records || [];
      updateStats(data);
      renderRecords();
      toast("记录已删除");
    } catch (error) {
      toast(error.message);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginError("");

    const password = els.password.value;
    if (!password) {
      setLoginError("请输入管理密码。");
      return;
    }

    const button = els.loginForm.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "登录中…";

    try {
      const data = await api("api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      state.csrfToken = data.csrfToken;
      setSiteUrl(data.siteUrl);
      els.password.value = "";
      showApp();
      await loadRecords();
    } catch (error) {
      setLoginError(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "进入后台";
    }
  }

  async function logout() {
    try {
      await api("api/logout", { method: "POST" });
    } catch {
      // The local session is cleared even if the server session already expired.
    }
    showLogin("已退出登录。");
  }

  async function boot() {
    try {
      const session = await api("api/session");
      setSiteUrl(session.siteUrl);
      if (!session.authenticated) {
        showLogin();
        return;
      }
      state.csrfToken = session.csrfToken;
      showApp();
      await loadRecords();
    } catch (error) {
      showLogin("无法连接后台服务，请检查部署配置。");
    }
  }

  els.loginForm.addEventListener("submit", handleLogin);
  els.logout.addEventListener("click", logout);
  els.add.addEventListener("click", openAddDialog);
  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    renderRecords();
  });
  els.form.addEventListener("submit", saveRecord);
  els.closeDialog.addEventListener("click", closeDialog);
  els.cancelDialog.addEventListener("click", closeDialog);
  els.dialog.addEventListener("click", (event) => {
    if (event.target === els.dialog) closeDialog();
  });
  els.recordList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const id = Number(button.dataset.id);
    const record = state.records.find((item) => Number(item.id) === id);
    if (!record) return;
    if (button.dataset.action === "edit") openEditDialog(record);
    if (button.dataset.action === "delete") deleteRecord(record);
  });

  boot();
})();
