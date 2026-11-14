/* ==========================================================================
   BA4UHI — QSL log interactions
   - normalises the log data
   - renders and filters the full QSL table
   - exports the current view as CSV
   ========================================================================== */

(function () {
  "use strict";

  const source = window.HAM_DATA;
  if (!source || !Array.isArray(source.records)) return;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  const escapeHTML = (value) =>
    String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  const cleanText = (value) => {
    const text = String(value == null ? "" : value).trim();
    return text === "" || text === "-" ? "" : text;
  };

  const formatAntenna = (value) => {
    const text = cleanText(value);
    if (!text) return "—";
    if (/^(ori|original|原装天线)$/i.test(text)) return "原装";
    return text;
  };

  const formatPower = (value) => {
    const text = cleanText(value);
    if (!text) return "—";
    if (/^\d+(\.\d+)?$/.test(text)) return `${text}W`;
    if (/^(h|high|高功)$/i.test(text)) return "高 (H)";
    if (/^(m|mid|middle)$/i.test(text)) return "中 (M)";
    if (/^(l|low)$/i.test(text)) return "低 (L)";
    return text;
  };

  const formatRig = (value) => cleanText(value) || "—";

  const classifyMyRig = (value) => {
    const text = cleanText(value);
    if (/^ht$/i.test(text)) return "HT";
    if (/k6/i.test(text)) return "UV-K6";
    if (/5r/i.test(text)) return "UV-5R";
    return "unrecorded";
  };

  const normalizeRecord = (record, index) => {
    const date = cleanText(record.date);
    const time = cleanText(record.time);
    const myRigKey = classifyMyRig(record.my_rig);
    const sent = cleanText(record.rst_sent);
    const received = cleanText(record.rst_rcvd);
    const report = cleanText(record.report);
    let rst = "—";

    if (sent || received) {
      rst = `${sent || "—"} / ${received || "—"}`;
    } else if (report) {
      rst = report;
    }

    return {
      index,
      callsign: cleanText(record.callsign) || "—",
      date,
      time,
      dateDisplay: date.replace(/-/g, "."),
      year: date.slice(0, 4),
      sortValue: `${date}T${time || "00:00"}:00`,
      freqRx: cleanText(record.freq_rx) || "—",
      freqTx: cleanText(record.freq_tx),
      mode: cleanText(record.mode) || "—",
      rst,
      qth: cleanText(record.qth) || "—",
      remoteRig: formatRig(record.rig),
      remoteAnt: formatAntenna(record.ant),
      remotePower: formatPower(record.pwr),
      myRigKey,
      myRig: myRigKey === "UV-K6"
        ? "泉盛 UV-K6"
        : myRigKey === "UV-5R"
          ? "宝锋 UV-5R"
          : myRigKey === "HT"
            ? "HT"
            : "未记录",
      myAnt: formatAntenna(record.my_ant),
      myPower: formatPower(record.my_pwr),
      remarks: cleanText(record.remarks) || "—",
      grid: cleanText(record.grid),
      name: cleanText(record.name),
      raw: record,
    };
  };

  const records = source.records
    .map((record, index) => normalizeRecord(record, index))
    .sort((a, b) => b.sortValue.localeCompare(a.sortValue) || b.index - a.index);

  const latest = records[0];
  const uniqueCalls = new Set(records.map((record) => record.callsign).filter((call) => call !== "—")).size;
  const years = Array.from(new Set(records.map((record) => record.year).filter(Boolean))).sort().reverse();

  const state = {
    query: "",
    year: "all",
  };

  const el = {
    body: $("#log-body"),
    table: $("#log-table"),
    empty: $("#empty-state"),
    search: $("#log-search"),
    year: $("#year-filter"),
    reset: $("#reset-filters"),
    emptyReset: $("#empty-reset"),
    export: $("#export-csv"),
    resultCount: $("#result-count"),
  };

  function updateSummary() {
    $$(".js-qso-count").forEach((node) => {
      node.textContent = String(records.length);
    });

    $$(".js-unique-count").forEach((node) => {
      node.textContent = String(uniqueCalls);
    });

    if (latest) {
      $$(".js-latest-date").forEach((node) => {
        node.textContent = latest.dateDisplay;
        node.setAttribute("datetime", latest.date);
      });
    }
  }

  function populateYears() {
    if (!el.year) return;
    el.year.innerHTML =
      '<option value="all">全部</option>' +
      years.map((year) => `<option value="${escapeHTML(year)}">${escapeHTML(year)}</option>`).join("");
  }

  function getFilteredRecords() {
    const query = state.query.trim().toLowerCase();

    return records.filter((record) => {
      if (state.year !== "all" && record.year !== state.year) return false;
      if (!query) return true;

      const haystack = [
        record.callsign,
        record.qth,
        record.remoteRig,
        record.myRig,
        record.remarks,
        record.name,
        record.freqRx,
        record.freqTx,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }

  function rowTemplate(record) {
    const qrzUrl = `https://www.qrz.com/db/${encodeURIComponent(record.callsign)}`;
    const metaParts = [
      record.qth !== "—" ? record.qth : "",
      record.mode !== "—" ? record.mode : "",
      record.myRig !== "未记录" ? record.myRig : "",
    ].filter(Boolean);
    const rigLine = record.myRig !== "未记录" ? `<small>我的 ${escapeHTML(record.myRig)}</small>` : "";
    const noteTitle = record.remarks !== "—" ? ` title="${escapeHTML(record.remarks)}"` : "";

    return `
      <tr>
        <td class="cell-date">
          <span>${escapeHTML(record.dateDisplay)}</span>
          <small>${escapeHTML(record.time || "—")} CST</small>
        </td>
        <td class="cell-call">
          <a href="${qrzUrl}" target="_blank" rel="noopener noreferrer" title="在 QRZ.com 查看 ${escapeHTML(record.callsign)}">${escapeHTML(record.callsign)}</a>
          <small class="mobile-meta">${escapeHTML(metaParts.join(" · "))}</small>
        </td>
        <td class="cell-freq">
          <strong>${escapeHTML(record.freqRx)}</strong>
          <small>${record.freqTx ? `TX ${escapeHTML(record.freqTx)}` : "—"}</small>
        </td>
        <td class="cell-mode"><span class="mode-pill">${escapeHTML(record.mode)}</span></td>
        <td class="cell-rst">${escapeHTML(record.rst)}</td>
        <td class="cell-qth">${escapeHTML(record.qth)}</td>
        <td class="cell-rig">
          <span>${escapeHTML(record.remoteRig)}</span>
          ${rigLine}
        </td>
        <td class="cell-note"${noteTitle}>${escapeHTML(record.remarks)}</td>
      </tr>`;
  }

  function render() {
    const filtered = getFilteredRecords();
    const hasFilters = state.query.trim() !== "" || state.year !== "all";

    if (el.body) {
      el.body.innerHTML = filtered.map(rowTemplate).join("");
    }

    if (el.table) {
      el.table.hidden = filtered.length === 0;
    }

    if (el.empty) {
      el.empty.hidden = filtered.length !== 0;
    }

    if (el.resultCount) {
      el.resultCount.textContent = hasFilters
        ? `显示 ${filtered.length} 条 / 共 ${records.length} 条`
        : `共 ${records.length} 条记录`;
    }
  }

  function resetFilters() {
    state.query = "";
    state.year = "all";

    if (el.search) el.search.value = "";
    if (el.year) el.year.value = "all";

    render();
    if (el.search) el.search.focus();
  }

  function csvCell(value) {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportCSV() {
    if (!el.export) return;

    const filtered = getFilteredRecords();
    if (filtered.length === 0) {
      const previous = el.export.innerHTML;
      el.export.textContent = "无记录可导出";
      window.setTimeout(() => {
        el.export.innerHTML = previous;
      }, 1500);
      return;
    }

    const headers = [
      "日期",
      "时间",
      "呼号",
      "频率(MHz)",
      "发射频率(MHz)",
      "模式",
      "信号报告",
      "QTH",
      "对方设备",
      "对方天线",
      "对方功率",
      "我的设备",
      "我的天线",
      "我的功率",
      "备注",
    ];

    const rows = filtered.map((record) => [
      record.date,
      record.time,
      record.callsign,
      record.freqRx,
      record.freqTx,
      record.mode,
      record.rst,
      record.qth,
      record.remoteRig,
      record.remoteAnt,
      record.remotePower,
      record.myRig,
      record.myAnt,
      record.myPower,
      record.remarks,
    ]);

    const csv = "\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `BA4UHI-QSL-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1200);

    const previous = el.export.innerHTML;
    el.export.textContent = `已导出 ${filtered.length} 条`;
    window.setTimeout(() => {
      el.export.innerHTML = previous;
    }, 1600);
  }

  if (el.search) {
    el.search.addEventListener("input", () => {
      state.query = el.search.value;
      render();
    });
  }

  if (el.year) {
    el.year.addEventListener("change", () => {
      state.year = el.year.value;
      render();
    });
  }

  if (el.reset) el.reset.addEventListener("click", resetFilters);
  if (el.emptyReset) el.emptyReset.addEventListener("click", resetFilters);
  if (el.export) el.export.addEventListener("click", exportCSV);

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.matches("input, select, textarea") || target.isContentEditable);

    if (event.key === "/" && !typing && el.search) {
      event.preventDefault();
      el.search.focus();
      return;
    }

    if (event.key === "Escape" && document.activeElement === el.search) {
      if (el.search.value) {
        el.search.value = "";
        state.query = "";
        render();
      } else {
        el.search.blur();
      }
    }
  });

  const stageImage = $("#card-stage-img");
  const stageLink = $("#card-stage-link");
  const stageLabel = $("#card-stage-label");
  const cardThumbs = $$(".card-thumb");

  if (stageImage && stageLink && cardThumbs.length) {
    cardThumbs.forEach((thumb) => {
      thumb.addEventListener("click", () => {
        const data = thumb.dataset;
        stageImage.src = data.src;
        stageImage.alt = data.alt;
        stageImage.width = data.width;
        stageImage.height = data.height;
        stageLink.href = data.full;
        stageLink.setAttribute("aria-label", `在新窗口查看 ${data.alt}`);

        if (stageLabel) {
          stageLabel.textContent = data.label;
        }

        cardThumbs.forEach((item) => {
          const active = item === thumb;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", String(active));
        });
      });
    });
  }

  populateYears();
  updateSummary();
  render();
})();
