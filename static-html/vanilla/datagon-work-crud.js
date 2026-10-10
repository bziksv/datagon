/**
 * Shared CRUD UI for WORK section pages (data-dg-work-entity on <body>).
 */
(function () {
  "use strict";

  var entitySlug = document.body.getAttribute("data-dg-work-entity") || "";
  if (!entitySlug) return;

  var state = {
    entity: null,
    rows: [],
    total: 0,
    page: 1,
    limit: 100,
    sortBy: "",
    sortDir: "asc",
    pending: { q: "", status: "1", specialist: "" },
    applied: { q: "", status: "1", specialist: "" },
    users: [],
    staff: [],
    editId: null,
    scope: "all",
  };

  function api(path, opts) {
    return fetch("/api/work" + path, Object.assign({ credentials: "same-origin" }, opts || {})).then(
      function (r) {
        return r.json().then(function (j) {
          if (!r.ok || (j && j.success === false)) {
            throw new Error((j && (j.error || j.message)) || "HTTP " + r.status);
          }
          return j;
        });
      }
    );
  }

  function toast(type, message) {
    if (window.DatagonNotify && window.DatagonNotify.toast) {
      window.DatagonNotify.toast({ type: type, message: message });
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function $(id) {
    return document.getElementById(id);
  }

  function syncDirty() {
    var btn = $("dg-work-apply");
    if (!btn) return;
    var dirty =
      state.pending.q !== state.applied.q ||
      state.pending.status !== state.applied.status ||
      state.pending.specialist !== state.applied.specialist;
    btn.classList.toggle("dg-flt-dirty", dirty);
  }

  function fillSpecialistSelect() {
    var sel = $("dg-work-specialist");
    var wrap = $("dg-work-specialist-wrap");
    if (!sel) return;
    var hide = entitySlug === "seo-staff";
    if (wrap) wrap.classList.toggle("d-none", hide);
    if (hide) return;
    var cur = state.pending.specialist || "";
    var html = '<option value="">Все</option>';
    (state.staff || []).forEach(function (s) {
      var id = String(s.legacy_user_id || "");
      if (!id) return;
      html +=
        '<option value="' +
        esc(id) +
        '"' +
        (id === cur ? " selected" : "") +
        ">" +
        esc(s.name || "user#" + id) +
        "</option>";
    });
    sel.innerHTML = html;
    sel.value = cur;
  }

  function fmtMoney(n) {
    if (window.DatagonFmt && window.DatagonFmt.formatMoney) {
      return window.DatagonFmt.formatMoney(n);
    }
    var x = Number(n);
    if (!Number.isFinite(x)) return "—";
    try {
      return (
        x.toLocaleString("ru-RU", { maximumFractionDigits: 2 }).replace(/\u00a0|\u202f/g, " ") +
        " ₽"
      );
    } catch (e) {
      return String(x) + " ₽";
    }
  }

  function fmtMoneyOrText(v) {
    if (v == null || v === "") return "";
    var s = String(v).trim();
    if (!s) return "";
    var cleaned = s.replace(/\s/g, "").replace(",", ".");
    if (/^-?\d+(\.\d+)?$/.test(cleaned)) return fmtMoney(Number(cleaned));
    return s;
  }

  function fmtNum(n) {
    if (window.DatagonFmt && window.DatagonFmt.formatNumber) {
      return window.DatagonFmt.formatNumber(n, { maxFractionDigits: 2 });
    }
    var x = Number(n) || 0;
    try {
      return x.toLocaleString("ru-RU", { maximumFractionDigits: 2 }).replace(/\u00a0|\u202f/g, " ");
    } catch (e) {
      return String(x);
    }
  }

  function domainOf(name) {
    var s = String(name || "").trim();
    if (!s) return "";
    s = s.replace(/^https?:\/\//i, "").split("/")[0].split(/\s/)[0];
    return s;
  }

  function hrefOf(url) {
    var text = String(url || "").trim();
    if (!text) return "";
    if (/^https?:\/\//i.test(text) || text.startsWith("//")) return text;
    return "https://" + text.replace(/^\/+/, "");
  }

  function daysBg(n) {
    var d = Number(n);
    if (!Number.isFinite(d)) return "";
    if (d === 0) return "#F5F5F5";
    if (d < 10) return "#ED1B24";
    if (d < 20) return "#EB3625";
    if (d < 30) return "#F04723";
    if (d < 40) return "#EF5924";
    if (d < 50) return "#F16523";
    if (d < 60) return "#F4711F";
    if (d < 70) return "#F37F1F";
    if (d < 80) return "#C8DA2A";
    if (d < 500) return "#7CC045";
    return "";
  }

  function renderCell(c, row) {
    if (c.type === "favicon") {
      var dom = domainOf(row.name_project);
      if (!dom) return '<td class="dg-work-td-favicon"></td>';
      return (
        '<td class="dg-work-td-favicon"><img class="dg-work-favicon" alt="" src="https://www.google.com/s2/favicons?domain=' +
        encodeURIComponent(dom) +
        '" loading="lazy" /></td>'
      );
    }
    if (c.type === "specialists") {
      var list = row.specialists_list || [];
      if (!list.length) {
        var plain = row.specialists ? String(row.specialists) : "";
        return "<td>" + esc(plain) + "</td>";
      }
      return (
        "<td>" +
        list
          .map(function (s) {
            var cls = s.is_head ? "dg-work-spec dg-work-spec--head" : "dg-work-spec dg-work-spec--member";
            return '<span class="' + cls + '">' + esc(s.name) + "</span><br>";
          })
          .join("") +
        "</td>"
      );
    }
    if (c.type === "arrow-link") {
      var raw = row[c.key];
      var href = hrefOf(raw);
      if (!href) return "<td></td>";
      return (
        '<td><a href="' +
        esc(href) +
        '" target="_blank" rel="noopener noreferrer"> >>>> </a></td>'
      );
    }
    if (c.type === "days") {
      var days = row.days_left;
      if (days === "" || days == null) days = 0;
      var bg = daysBg(days);
      return (
        '<td class="dg-work-days"' +
        (bg ? ' style="background-color:' + bg + '"' : "") +
        ">" +
        esc(String(days)) +
        "</td>"
      );
    }
    if (c.type === "match-status") {
      var code = String(row[c.key] || "none");
      var isPwdCol =
        c.key === "password_match" ||
        c.key === "dev_password_match" ||
        /_password_match$/.test(c.key);
      var labels = {
        active: isPwdCol ? "Есть пароль" : "Проект активен",
        archived: isPwdCol ? "Пароль в архиве" : "Проект в архиве",
        none: isPwdCol ? "Нет пароля" : "Нет проекта",
      };
      var cls =
        code === "active"
          ? "dg-work-match dg-work-match--ok"
          : code === "archived"
            ? "dg-work-match dg-work-match--archived"
            : "dg-work-match dg-work-match--none";
      var tip = "";
      if (c.key === "dev_password_match") tip = row.matched_dev_password_name || "";
      else if (isPwdCol) tip = row.matched_password_name || "";
      else tip = row.matched_project_name || "";
      return (
        '<td><span class="' +
        cls +
        '"' +
        (tip ? ' title="' + esc(tip) + '"' : "") +
        ">" +
        esc(labels[code] || code) +
        "</span></td>"
      );
    }
    var v = row[c.key];
    if (c.key === "datagon_user_name") {
      v =
        v ||
        row.name ||
        (row.datagon_user_id ? "#" + row.datagon_user_id : "— не сопоставлен");
    }
    if (c.type === "money") {
      if (v == null || v === "") return '<td class="dg-work-num text-end"></td>';
      return '<td class="dg-work-num text-end">' + esc(fmtMoney(v)) + "</td>";
    }
    if (c.type === "money-or-text") {
      return '<td class="dg-work-num text-end">' + esc(fmtMoneyOrText(v)) + "</td>";
    }
    var text = v == null ? "" : String(v);
    if (c.type === "copy") {
      return (
        '<td class="dg-work-td-copy"><textarea class="dg-work-copy" rows="1" readonly onclick="this.select()" title="Потяните за угол, чтобы растянуть">' +
        esc(text) +
        "</textarea></td>"
      );
    }
    if (text.length > 80) text = text.slice(0, 77) + "…";
    var tdClass = c.key === "datagon_user_name" ? ' class="dg-work-col-name"' : "";
    return "<td" + tdClass + ">" + esc(text) + "</td>";
  }

  function renderSummary(summary) {
    var card = $("dg-work-summary-card");
    var host = $("dg-work-summary");
    if (!card || !host) return;
    if (!summary || !summary.kind) {
      card.classList.add("d-none");
      host.innerHTML = "";
      return;
    }
    card.classList.remove("d-none");
    if (summary.kind === "seo") {
      host.innerHTML =
        "Всего активных: <b>" +
        esc(summary.active) +
        "</b> | Бюджет активных: <b>" +
        esc(fmtMoney(summary.budget)) +
        "</b> | Освоенный бюджет: <b>" +
        esc(fmtMoney(summary.osvoeno)) +
        "</b><br>" +
        "Клиентские кол-во: <b>" +
        esc(summary.client) +
        "</b> | Бюджет клиентские: <b>" +
        esc(fmtMoney(summary.budget_client)) +
        "</b> | Освоенный бюджет клиентские: <b>" +
        esc(fmtMoney(summary.osvoeno_client)) +
        "</b><br>" +
        "Наши проекты кол-во: <b>" +
        esc(summary.our) +
        "</b> | Бюджет наши проекты: <b>" +
        esc(fmtMoney(summary.budget_our)) +
        "</b> | Освоенный бюджет наши проекты: <b>" +
        esc(fmtMoney(summary.osvoeno_our)) +
        "</b><br>" +
        "Архив: <b>" +
        esc(summary.archive) +
        "</b>";
      return;
    }
    if (summary.kind === "context") {
      host.innerHTML =
        "Всего активных: <b>" +
        esc(summary.active) +
        "</b> | Бюджет активных: <b>" +
        esc(fmtMoney(summary.budget)) +
        "</b><br>" +
        "Клиентские кол-во: <b>" +
        esc(summary.client) +
        "</b> | Бюджет клиентские: <b>" +
        esc(fmtMoney(summary.budget_client)) +
        "</b><br>" +
        "Наши проекты кол-во: <b>" +
        esc(summary.our) +
        "</b> | Бюджет наши проекты: <b>" +
        esc(fmtMoney(summary.budget_our)) +
        "</b><br>" +
        "Архив: <b>" +
        esc(summary.archive) +
        "</b>";
      return;
    }
    if (summary.kind === "staff") {
      host.innerHTML =
        "Активных сотрудников: <b>" +
        esc(summary.active) +
        "</b> | Сумма на З.П.: <b>" +
        esc(fmtMoney(summary.itog_sum)) +
        "</b>";
      return;
    }
    card.classList.add("d-none");
  }

  function isColSortable(c) {
    return c && c.key && c.type !== "favicon";
  }

  function renderTable() {
    var host = $("dg-work-tbody");
    var thead = $("dg-work-thead");
    if (!host || !thead || !state.entity) return;
    var cols = state.entity.listCols || [];
    thead.innerHTML =
      "<tr>" +
      cols
        .map(function (c) {
          if (c.type === "favicon") {
            return '<th class="dg-work-th-favicon" aria-label="Иконка"></th>';
          }
          if (!isColSortable(c)) {
            return "<th>" + esc(c.label || "") + "</th>";
          }
          var mark =
            state.sortBy === c.key ? (state.sortDir === "asc" ? " ↑" : " ↓") : "";
          return (
            '<th class="dg-work-sortable" data-dg-work-sort="' +
            esc(c.key) +
            '" title="Сортировать">' +
            esc((c.label || "") + mark) +
            "</th>"
          );
        })
        .join("") +
      '<th style="width:140px">Действия</th></tr>';
    if (!state.rows.length) {
      host.innerHTML =
        '<tr><td colspan="' +
        (cols.length + 1) +
        '" class="text-muted p-3">Нет записей</td></tr>';
    } else {
      host.innerHTML = state.rows
        .map(function (row) {
          var tds = cols
            .map(function (c) {
              return renderCell(c, row);
            })
            .join("");
          var trCls = row.archive_candidate ? ' class="dg-work-row--archive-hint"' : "";
          var trTitle = row.archive_candidate
            ? ' title="Нет активного проекта — скорее всего пора в архив"'
            : "";
          return (
            "<tr" +
            trCls +
            trTitle +
            ">" +
            tds +
            '<td class="text-nowrap">' +
            '<button type="button" class="btn btn-sm btn-outline-primary me-1" data-dg-work-edit="' +
            row.id +
            '" data-dg-notify-start="Открываем…">Изменить</button>' +
            '<button type="button" class="btn btn-sm btn-outline-danger" data-dg-work-arch="' +
            row.id +
            '" data-dg-notify-start="В архив…">Архив</button>' +
            "</td></tr>"
          );
        })
        .join("");
    }
    var pages = Math.max(1, Math.ceil(state.total / state.limit));
    var shown = state.rows.length;
    var st = $("dg-work-page-status");
    if (st) {
      st.textContent =
        "Найдено: " +
        state.total +
        "; страница " +
        state.page +
        "/" +
        pages +
        "; показано: " +
        shown;
    }
    var prev = $("dg-work-prev");
    var next = $("dg-work-next");
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= pages;
  }

  function staffOptionsHtml(selectedId) {
    return (
      '<option value="">— не выбран —</option>' +
      state.staff
        .map(function (s) {
          var sel = String(selectedId || "") === String(s.legacy_user_id) ? " selected" : "";
          return (
            '<option value="' +
            esc(String(s.legacy_user_id)) +
            '"' +
            sel +
            ">" +
            esc(s.name) +
            "</option>"
          );
        })
        .join("")
    );
  }

  function fieldColClass(f) {
    var c = f && f.col ? String(f.col) : "";
    if (c === "3") return "col-md-3";
    if (c === "6") return "col-md-6";
    if (c === "12") return "col-md-12";
    if (f && (f.type === "textarea" || f.type === "staff-multi")) return "col-md-12";
    if (f && (f.type === "user" || f.type === "staff-head")) return "col-md-6";
    return "col-md-4";
  }

  function renderFormField(f, fullRow, assigneeIds, headId) {
    var val = fullRow && fullRow[f.key] != null ? fullRow[f.key] : f.type === "number" ? "0" : "";
    var col = fieldColClass(f);
    if (f.type === "staff-multi") {
      var boxes = state.staff
        .map(function (s) {
          var checked =
            assigneeIds.map(String).indexOf(String(s.legacy_user_id)) >= 0 ? " checked" : "";
          return (
            '<label class="dg-work-staff-item">' +
            '<input type="checkbox" class="form-check-input me-1" data-dg-work-assignee value="' +
            esc(String(s.legacy_user_id)) +
            '"' +
            checked +
            "> " +
            esc(s.name) +
            "</label>"
          );
        })
        .join("");
      return (
        '<div class="' +
        col +
        '"><label class="form-label">' +
        esc(f.label) +
        '</label><div class="dg-work-staff-multi border rounded p-2">' +
        (boxes ||
          '<span class="text-muted">Нет сотрудников — сначала сопоставьте на «Сотрудники SEO»</span>') +
        "</div></div>"
      );
    }
    if (f.type === "staff-head") {
      return (
        '<div class="' +
        col +
        '"><label class="form-label">' +
        esc(f.label) +
        '</label><select class="form-select" data-dg-work-field="' +
        esc(f.key) +
        '">' +
        staffOptionsHtml(headId) +
        "</select></div>"
      );
    }
    if (f.type === "select-status") {
      var st = Number(val) === 0 ? "0" : "1";
      return (
        '<div class="' +
        col +
        '"><label class="form-label">' +
        esc(f.label) +
        '</label><select class="form-select" data-dg-work-field="' +
        esc(f.key) +
        '">' +
        '<option value="1"' +
        (st === "1" ? " selected" : "") +
        ">Активный</option>" +
        '<option value="0"' +
        (st === "0" ? " selected" : "") +
        ">Архив</option>" +
        "</select></div>"
      );
    }
    if (f.type === "checkbox") {
      var on = Number(val) === 1;
      return (
        '<div class="' +
        col +
        ' d-flex align-items-end"><div class="form-check mb-2">' +
        '<input type="checkbox" class="form-check-input" data-dg-work-field="' +
        esc(f.key) +
        '" data-dg-work-checkbox="1" value="1"' +
        (on ? " checked" : "") +
        ">" +
        '<label class="form-check-label">' +
        esc(f.label) +
        "</label></div></div>"
      );
    }
    if (f.type === "user") {
      var opts =
        '<option value="">— не сопоставлен —</option>' +
        state.users
          .map(function (u) {
            var sel = String(val) === String(u.id) ? " selected" : "";
            return (
              '<option value="' +
              u.id +
              '"' +
              sel +
              ">" +
              esc(u.full_name || u.username) +
              " (" +
              esc(u.username) +
              ")</option>"
            );
          })
          .join("");
      return (
        '<div class="' +
        col +
        '"><label class="form-label">' +
        esc(f.label) +
        '</label><select class="form-select" data-dg-work-field="' +
        esc(f.key) +
        '">' +
        opts +
        "</select></div>"
      );
    }
    if (f.type === "textarea") {
      return (
        '<div class="' +
        col +
        '"><label class="form-label">' +
        esc(f.label) +
        '</label><textarea class="form-control" rows="2" data-dg-work-field="' +
        esc(f.key) +
        '">' +
        esc(val) +
        "</textarea></div>"
      );
    }
    if (f.type === "date") {
      return (
        '<div class="' +
        col +
        '"><label class="form-label">' +
        esc(f.label) +
        '</label><input type="date" class="form-control" data-dg-work-field="' +
        esc(f.key) +
        '" data-dg-work-date="1" value="' +
        esc(toIsoDate(val)) +
        '" /></div>'
      );
    }
    if (f.type === "phone") {
      return (
        '<div class="' +
        col +
        '"><label class="form-label">' +
        esc(f.label) +
        '</label><input type="tel" class="form-control" data-dg-work-field="' +
        esc(f.key) +
        '" data-dg-work-phone="1" inputmode="tel" autocomplete="tel" placeholder="+7 999 123-45-67" pattern="[\\d+\\s()\\-]{10,20}" value="' +
        esc(val) +
        '" />' +
        '<div class="form-text">Только цифры, пробелы, + ( ) -; минимум 10 цифр</div></div>'
      );
    }
    var inputType = f.type === "number" ? "number" : "text";
    var hint =
      f.hint
        ? '<div class="form-text">' + esc(f.hint) + "</div>"
        : "";
    return (
      '<div class="' +
      col +
      '"><label class="form-label">' +
      esc(f.label) +
      '</label><input type="' +
      inputType +
      '" class="form-control" data-dg-work-field="' +
      esc(f.key) +
      '" value="' +
      esc(val) +
      '" />' +
      hint +
      "</div>"
    );
  }

  function toIsoDate(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return "";
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + "-" + m[2] + "-" + m[3];
    m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (m) {
      var dd = String(m[1]).padStart(2, "0");
      var mm = String(m[2]).padStart(2, "0");
      return m[3] + "-" + mm + "-" + dd;
    }
    return "";
  }

  function fromIsoDate(v) {
    var m = String(v == null ? "" : v).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return v == null ? "" : String(v);
    return m[3] + "/" + m[2] + "/" + m[1];
  }

  function isPhoneOk(s) {
    if (s == null || String(s).trim() === "") return true;
    var digits = String(s).replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15;
  }

  function fieldMeta(key) {
    var fields = (state.entity && state.entity.formFields) || [];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].key === key) return fields[i];
    }
    return null;
  }

  function openForm(row) {
    state.editId = row ? row.id : null;
    var title = $("dg-work-form-title");
    if (title) title.textContent = row ? "Изменить #" + row.id : "Новая запись";
    var body = $("dg-work-form-fields");
    if (!body || !state.entity) return;

    function paint(fullRow) {
      var assigneeIds = (fullRow && fullRow.assignee_legacy_ids) || [];
      if (!assigneeIds.length && fullRow && fullRow.specialists_list) {
        assigneeIds = fullRow.specialists_list
          .map(function (s) {
            return s.legacy_user_id;
          })
          .filter(Boolean);
      }
      var headId = fullRow && fullRow.id_glavn_user != null ? fullRow.id_glavn_user : "";
      var fields = state.entity.formFields || [];
      var hasGroups = fields.some(function (f) {
        return f.group === "main" || f.group === "advanced";
      });
      var html = "";
      if (!hasGroups) {
        html = fields
          .map(function (f) {
            return renderFormField(f, fullRow, assigneeIds, headId);
          })
          .join("");
        body.innerHTML = html;
      } else {
        var main = fields.filter(function (f) {
          return (f.group || "main") !== "advanced";
        });
        var adv = fields.filter(function (f) {
          return f.group === "advanced";
        });
        html = main
          .map(function (f) {
            return renderFormField(f, fullRow, assigneeIds, headId);
          })
          .join("");
        if (adv.length) {
          html +=
            '<div class="col-12"><details class="dg-work-form-advanced mt-2">' +
            '<summary class="btn btn-sm btn-outline-secondary mb-2">Дополнительно</summary>' +
            '<div class="row g-2">' +
            adv
              .map(function (f) {
                return renderFormField(f, fullRow, assigneeIds, headId);
              })
              .join("") +
            "</div></details></div>";
        }
        body.innerHTML = html;
      }
      var card = $("dg-work-form-body");
      if (card) card.style.display = "";
      var wrap = $("dg-work-form-card");
      if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    if (row && row.id && state.entity && !state.entity.isStaff) {
      api("/" + entitySlug + "/" + row.id)
        .then(function (j) {
          paint(j.row || row);
        })
        .catch(function () {
          paint(row);
        });
    } else {
      paint(row);
    }
  }

  function collectForm() {
    var data = {};
    document.querySelectorAll("[data-dg-work-field]").forEach(function (el) {
      var key = el.getAttribute("data-dg-work-field");
      if (!key) return;
      if (el.getAttribute("data-dg-work-checkbox") === "1") {
        data[key] = el.checked ? "1" : "0";
        return;
      }
      var meta = fieldMeta(key);
      var v = el.value;
      if (el.getAttribute("data-dg-work-date") === "1" || (meta && meta.type === "date")) {
        data[key] = v ? fromIsoDate(v) : "";
        return;
      }
      data[key] = v;
    });
    var assigneeBoxes = document.querySelectorAll("[data-dg-work-assignee]");
    if (assigneeBoxes.length) {
      data.assignee_legacy_ids = Array.prototype.slice
        .call(assigneeBoxes)
        .filter(function (el) {
          return el.checked;
        })
        .map(function (el) {
          return Number(el.value);
        })
        .filter(Boolean);
    }
    return data;
  }

  function validateFormPhones() {
    var bad = [];
    document.querySelectorAll("[data-dg-work-phone]").forEach(function (el) {
      if (!isPhoneOk(el.value)) {
        el.classList.add("is-invalid");
        bad.push(el);
      } else {
        el.classList.remove("is-invalid");
      }
    });
    return bad;
  }

  function load() {
    var q =
      "/" +
      encodeURIComponent(entitySlug) +
      "?page=" +
      state.page +
      "&limit=" +
      state.limit +
      "&q=" +
      encodeURIComponent(state.applied.q);
    if (state.applied.status !== "") q += "&status=" + encodeURIComponent(state.applied.status);
    if (state.applied.specialist) {
      q += "&specialist=" + encodeURIComponent(state.applied.specialist);
    }
    if (state.sortBy) {
      q +=
        "&sort=" +
        encodeURIComponent(state.sortBy) +
        "&dir=" +
        encodeURIComponent(state.sortDir || "asc");
    }
    return api(q).then(function (j) {
      state.entity = j.entity;
      state.rows = j.rows || [];
      state.total = j.total || 0;
      state.scope = j.scope || "all";
      if (j.sort) {
        state.sortBy = j.sort;
        state.sortDir = j.dir === "desc" ? "desc" : "asc";
      }
      var h = $("dg-work-page-title");
      if (h && j.entity) h.textContent = j.entity.title || h.textContent;
      applyScopeUi(state.scope);
      renderSummary(j.summary);
      renderTable();
    });
  }

  /** Как в WORK: не-admin — без «Добавить» / выплат; rematch только на seo-staff + admin. */
  function applyScopeUi(scope) {
    var selfOnly = scope === "self";
    var add = $("dg-work-add");
    if (add) add.classList.toggle("d-none", selfOnly);
    var rematch = $("dg-work-rematch");
    if (rematch) {
      rematch.classList.toggle("d-none", selfOnly || entitySlug !== "seo-staff");
    }
    var payout = $("dg-work-payout-card");
    if (payout) {
      if (selfOnly || entitySlug !== "seo-projects") {
        payout.classList.add("d-none");
      } else {
        payout.classList.remove("d-none");
      }
    }
  }

  function commitFilters() {
    state.applied = {
      q: state.pending.q,
      status: state.pending.status,
      specialist: state.pending.specialist,
    };
    state.page = 1;
    syncDirty();
    return load();
  }

  function bind() {
    var search = $("dg-work-search");
    var status = $("dg-work-status");
    var specialist = $("dg-work-specialist");
    var mirror = $("dg-work-search-mirror");
    if (search) {
      search.addEventListener("input", function () {
        state.pending.q = search.value.trim();
        if (mirror) mirror.value = search.value;
        syncDirty();
      });
      search.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          commitFilters();
        }
        if (e.key === "Escape") {
          search.value = "";
          if (mirror) mirror.value = "";
          state.pending.q = "";
          commitFilters();
        }
      });
    }
    if (mirror) {
      mirror.addEventListener("input", function () {
        state.pending.q = mirror.value.trim();
        if (search) search.value = mirror.value;
        syncDirty();
      });
      mirror.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          commitFilters();
        }
      });
    }
    if (status) {
      status.addEventListener("change", function () {
        state.pending.status = status.value;
        syncDirty();
      });
    }
    if (specialist) {
      specialist.addEventListener("change", function () {
        state.pending.specialist = specialist.value || "";
        syncDirty();
      });
    }
    var apply = $("dg-work-apply");
    if (apply) {
      apply.addEventListener("click", function () {
        var run = function () {
          return commitFilters();
        };
        if (window.DatagonNotify && window.DatagonNotify.busyRun) {
          window.DatagonNotify.busyRun(apply, run);
        } else run();
      });
    }
    var reset = $("dg-work-reset");
    if (reset) {
      reset.addEventListener("click", function () {
        state.pending = { q: "", status: "1", specialist: "" };
        if (search) search.value = "";
        if (mirror) mirror.value = "";
        if (status) status.value = "1";
        if (specialist) specialist.value = "";
        commitFilters();
      });
    }
    var add = $("dg-work-add");
    if (add) add.addEventListener("click", function () {
      openForm(null);
    });
    var save = $("dg-work-save");
    if (save) {
      save.addEventListener("click", function () {
        var phoneBad = validateFormPhones();
        if (phoneBad.length) {
          toast("warning", "Проверьте телефон: нужно 10–15 цифр");
          phoneBad[0].focus();
          return;
        }
        var data = collectForm();
        var run = function () {
          var p = state.editId
            ? api("/" + entitySlug + "/" + state.editId, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
              })
            : api("/" + entitySlug, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
              });
          return p.then(function () {
            toast("success", "Сохранено");
            state.editId = null;
            var card = $("dg-work-form-body");
            if (card) card.style.display = "none";
            return load();
          });
        };
        if (window.DatagonNotify && window.DatagonNotify.busyRun) {
          window.DatagonNotify.busyRun(save, run).catch(function (e) {
            toast("danger", e.message);
          });
        } else {
          run().catch(function (e) {
            toast("danger", e.message);
          });
        }
      });
    }
    var cancel = $("dg-work-cancel");
    if (cancel) {
      cancel.addEventListener("click", function () {
        state.editId = null;
        var card = $("dg-work-form-body");
        if (card) card.style.display = "none";
      });
    }
    var rematch = $("dg-work-rematch");
    if (rematch) {
      rematch.addEventListener("click", function () {
        var run = function () {
          return api("/seo-staff/rematch", { method: "POST" }).then(function (j) {
            toast(
              "success",
              "Сопоставлено: " + (j.matched || 0) + "; неоднозначных: " + (j.ambiguous || 0)
            );
            return load();
          });
        };
        if (window.DatagonNotify && window.DatagonNotify.busyRun) {
          window.DatagonNotify.busyRun(rematch, run).catch(function (e) {
            toast("danger", e.message);
          });
        } else run().catch(function (e) {
          toast("danger", e.message);
        });
      });
    }
    document.addEventListener("click", function (e) {
      var sortTh = e.target.closest("[data-dg-work-sort]");
      if (sortTh) {
        try {
          var sel = window.getSelection ? window.getSelection() : null;
          if (sel && String(sel.toString() || "").trim().length > 0) return;
        } catch (err) {}
        var key = sortTh.getAttribute("data-dg-work-sort");
        if (!key) return;
        if (state.sortBy === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortBy = key;
          state.sortDir = "asc";
        }
        state.page = 1;
        load();
        return;
      }
      var ed = e.target.closest("[data-dg-work-edit]");
      if (ed) {
        var id = Number(ed.getAttribute("data-dg-work-edit"));
        var row = state.rows.find(function (r) {
          return Number(r.id) === id;
        });
        if (row) openForm(row);
        return;
      }
      var ar = e.target.closest("[data-dg-work-arch]");
      if (ar) {
        openConfirm({
          mode: "archive",
          archId: ar.getAttribute("data-dg-work-arch"),
          title: "В архив?",
          text: "Запись будет скрыта из активных (status=0). Удаление без возможности отмены не выполняется.",
          okLabel: "В архив",
          okClass: "btn btn-danger",
        });
      }
    });
    var confOk = $("dg-work-confirm-ok");
    var confCancel = $("dg-work-confirm-cancel");
    var overlay = $("dg-work-confirm-overlay");
    function hideConfirm() {
      if (overlay) {
        overlay.classList.add("d-none");
        delete overlay.dataset.mode;
        delete overlay.dataset.archId;
      }
    }
    function openConfirm(opts) {
      if (!overlay) return;
      overlay.dataset.mode = opts.mode || "";
      if (opts.archId) overlay.dataset.archId = opts.archId;
      var titleEl = $("dg-work-confirm-title");
      var textEl = $("dg-work-confirm-text");
      if (titleEl) titleEl.textContent = opts.title || "Подтвердите";
      if (textEl) textEl.textContent = opts.text || "";
      if (confOk) {
        confOk.textContent = opts.okLabel || "OK";
        confOk.className = opts.okClass || "btn btn-danger";
      }
      overlay.classList.remove("d-none");
    }
    if (confCancel) confCancel.addEventListener("click", hideConfirm);
    if (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay || e.target.classList.contains("dg-work-confirm-backdrop")) hideConfirm();
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay && !overlay.classList.contains("d-none")) hideConfirm();
    });
    if (confOk) {
      confOk.addEventListener("click", function () {
        var mode = overlay && overlay.dataset.mode;
        var id = overlay && overlay.dataset.archId;
        hideConfirm();
        if (mode === "recalc") {
          runPayoutRecalc();
          return;
        }
        if (!id) return;
        api("/" + entitySlug + "/" + id, { method: "DELETE" })
          .then(function () {
            toast("success", "В архиве");
            return load();
          })
          .catch(function (e) {
            toast("danger", e.message);
          });
      });
    }
    bindPayoutCard(openConfirm);
    var prev = $("dg-work-prev");
    var next = $("dg-work-next");
    if (prev) {
      prev.addEventListener("click", function () {
        if (state.page > 1) {
          state.page -= 1;
          load();
        }
      });
    }
    if (next) {
      next.addEventListener("click", function () {
        state.page += 1;
        load();
      });
    }
    var lim = $("dg-work-limit");
    if (lim) {
      lim.value = String(state.limit);
      lim.addEventListener("change", function () {
        state.limit = Number(lim.value) || 100;
        state.page = 1;
        load();
      });
    }
  }

  var PAYOUT_FIELDS = [
    { id: "dg-work-pay-procent-bonus", key: "procent_bonus" },
    { id: "dg-work-pay-count-day-fine", key: "count_day_fine" },
    { id: "dg-work-pay-procent-fine", key: "procent_fine" },
    { id: "dg-work-pay-procent-for-fine", key: "procent_for_fine" },
    { id: "dg-work-pay-bonus-add", key: "bonus_add" },
    { id: "dg-work-pay-procent-seo", key: "procent_seo" },
  ];

  function showPayoutSaveMsg(type, html) {
    var el = $("dg-work-payout-save-msg");
    if (!el) return;
    el.className = "alert mt-3 mb-0 alert-" + (type || "secondary");
    el.innerHTML = html;
    el.classList.remove("d-none");
  }

  function showActionLog(type, html) {
    var el = $("dg-work-action-log");
    if (!el) return;
    el.className = "alert mt-3 mb-0 small alert-" + (type || "secondary");
    el.innerHTML = html;
    el.classList.remove("d-none");
  }

  function applyPayoutSettingsToForm(s) {
    PAYOUT_FIELDS.forEach(function (f) {
      var el = $(f.id);
      if (el) el.value = s && s[f.key] != null ? String(s[f.key]) : "";
    });
  }

  function collectPayoutSettings() {
    var out = {};
    PAYOUT_FIELDS.forEach(function (f) {
      var el = $(f.id);
      out[f.key] = el ? Number(el.value) || 0 : 0;
    });
    return out;
  }

  function loadPayoutSettings() {
    return api("/seo-payout-settings").then(function (j) {
      applyPayoutSettingsToForm(j.settings || {});
      return j.settings;
    });
  }

  function runPayoutRecalc() {
    var btn = $("dg-work-payout-recalc");
    var t0 = Date.now();
    showActionLog(
      "warning",
      "Пересчитываем summa_zp по активным SEO-проектам…<br>Прошло: 0 с"
    );
    var tick = setInterval(function () {
      var sec = Math.round((Date.now() - t0) / 1000);
      showActionLog(
        "warning",
        "Пересчитываем summa_zp по активным SEO-проектам…<br>Прошло: " + sec + " с"
      );
    }, 1000);
    var run = function () {
      return api("/seo-payout-recalc", { method: "POST" }).then(function (j) {
        clearInterval(tick);
        var lines =
          "<b>Пересчёт з.п. завершён</b><br>" +
          "Всего активных: " +
          (j.total || 0) +
          "; обновлено: " +
          (j.updated || 0) +
          "; без изменений: " +
          (j.unchanged || 0) +
          "; пропущено (traffic): " +
          (j.skipped || 0) +
          "; длительность: " +
          (j.duration_sec != null ? j.duration_sec : "?") +
          " с";
        if (j.errors && j.errors.length) {
          lines +=
            "<br>Ошибки (" +
            j.errors.length +
            "): " +
            j.errors
              .slice(0, 10)
              .map(function (e) {
                return "#" + e.id + " " + esc(e.error);
              })
              .join("; ");
        }
        showActionLog(j.errors && j.errors.length ? "warning" : "success", lines);
        toast("success", "Обновлено: " + (j.updated || 0));
        return load();
      });
    };
    var p =
      window.DatagonNotify && window.DatagonNotify.busyRun
        ? window.DatagonNotify.busyRun(btn, run)
        : run();
    p.catch(function (e) {
      clearInterval(tick);
      showActionLog("danger", "Ошибка пересчёта: " + esc(e.message || e));
      toast("danger", e.message);
    });
  }

  function bindPayoutCard(openConfirm) {
    var card = $("dg-work-payout-card");
    if (!card || entitySlug !== "seo-projects") return;
    // Показ только после load() при scope=all (applyScopeUi).
    var body = $("dg-work-payout-body");
    var toggle = $("dg-work-payout-toggle");
    var KEY = "datagon_work_seo_payout_collapsed_v1";
    function applyCollapsed(on) {
      if (!body || !toggle) return;
      body.style.display = on ? "none" : "";
      toggle.textContent = on ? "Развернуть" : "Свернуть";
    }
    try {
      applyCollapsed(localStorage.getItem(KEY) === "1");
    } catch (e) {
      applyCollapsed(false);
    }
    if (toggle) {
      toggle.addEventListener("click", function () {
        var on = body && body.style.display !== "none";
        applyCollapsed(on);
        try {
          localStorage.setItem(KEY, on ? "1" : "0");
        } catch (err) {}
      });
    }
    loadPayoutSettings().catch(function (e) {
      showPayoutSaveMsg("danger", "Не удалось загрузить настройки: " + esc(e.message));
    });
    var saveBtn = $("dg-work-payout-save");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        var payload = collectPayoutSettings();
        showPayoutSaveMsg("warning", "Сохраняем…");
        var run = function () {
          return api("/seo-payout-settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }).then(function () {
            return api("/seo-payout-settings").then(function (j) {
              var s = j.settings || {};
              applyPayoutSettingsToForm(s);
              var mismatches = [];
              PAYOUT_FIELDS.forEach(function (f) {
                if (Number(payload[f.key]) !== Number(s[f.key])) {
                  mismatches.push(
                    f.key + ": отправили " + payload[f.key] + ", в БД " + s[f.key]
                  );
                }
              });
              if (mismatches.length) {
                showPayoutSaveMsg(
                  "warning",
                  "Сохранено, но проверка не совпала:<br>" + mismatches.join("<br>")
                );
              } else {
                showPayoutSaveMsg(
                  "success",
                  "Сохранено. % бонуса освоения=" +
                    s.procent_bonus +
                    ", дней штрафа=" +
                    s.count_day_fine +
                    ", % штрафа=" +
                    s.procent_fine +
                    ", % базы штрафа=" +
                    s.procent_for_fine +
                    ", % вывода=" +
                    s.bonus_add +
                    ", % проекта=" +
                    s.procent_seo
                );
              }
            });
          });
        };
        if (window.DatagonNotify && window.DatagonNotify.busyRun) {
          window.DatagonNotify.busyRun(saveBtn, run).catch(function (e) {
            showPayoutSaveMsg("danger", esc(e.message));
          });
        } else {
          run().catch(function (e) {
            showPayoutSaveMsg("danger", esc(e.message));
          });
        }
      });
    }
    var recalcBtn = $("dg-work-payout-recalc");
    if (recalcBtn && typeof openConfirm === "function") {
      recalcBtn.addEventListener("click", function () {
        openConfirm({
          mode: "recalc",
          title: "Пересчитать з.п.?",
          text:
            "Будут перезаписаны summa_zp у всех активных SEO-проектов (кроме traffic) по текущим порогам и budget/освоено/дате конца. Ручные правки summa_zp затрутся.",
          okLabel: "Пересчитать",
          okClass: "btn btn-warning",
        });
      });
    }
  }

  Promise.all([
    api("/meta/entities").then(function (j) {
      var ent = (j.entities || []).find(function (e) {
        return e.slug === entitySlug;
      });
      state.entity = ent || null;
    }),
    entitySlug === "seo-staff"
      ? api("/meta/users").then(function (j) {
          state.users = j.rows || [];
        })
      : Promise.resolve(),
    api("/meta/staff").then(function (j) {
      state.staff = j.rows || [];
    }),
  ])
    .then(function () {
      fillSpecialistSelect();
      bind();
      if (entitySlug !== "seo-staff") {
        var rematch = $("dg-work-rematch");
        if (rematch) rematch.classList.add("d-none");
      }
      return load();
    })
    .catch(function (e) {
      toast("danger", e.message || String(e));
    });
})();
