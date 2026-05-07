/**
 * Huckster → Google Sheets (логика как у Datagon: routes/exportsHuckster.js)
 *
 * ПУНКТЫ МЕНЮ (имена не менять): exportHucksterExport, exportHucksterExportRRC, runAllExports
 *
 * ─── Почему «пропало меню» (важно) ───
 * Все файлы .gs в одном проекте — ОДИН общий scope. Две функции с одним именем = ошибка компиляции
 * всего проекта → onOpen не запускается → меню не появляется. Это не из‑за «сложного» кода ниже.
 *
 * Если у вас УЖЕ был простой скрипт с теми же именами, что и в меню:
 *   function exportHucksterExport() { ... }
 *   function exportHucksterExportRRC() { ... }
 *   function runAllExports() { ... }
 * и вы добавили ЭТОТ файл, не удалив старый — получите дубликат. Решение: удалить из проекта
 * ВЕСЬ старый блок Huckster (от SHOPS_SET_1 / SHOPS_SET_2 до конца fetchAllProducts и runExport),
 * оставить только onOpen и остальные несвязанные функции. Наборы магазинов здесь — hck_SHOPS_SET_*.
 *
 * Проверка: Расширения → Apps Script → иконка «Выполнение» (жук) — красная строка часто пишет
 * «Identifier ... has already been declared» или дубликат function.
 *
 * 1) Ровно один onOpen в проекте.
 * 2) Ровно одна реализация exportHucksterExport / exportHucksterExportRRC / runAllExports — эта.
 *
 * Внутренние имена с префиксом hck_ — чтобы не биться об ваши runExport / fetchAllProducts / константы.
 */

// --- Учётные данные: свойства скрипта HUCKSTER_EMAIL / HUCKSTER_PASSWORD или глобальные константы ниже ---
// var HUCKSTER_EMAIL = "user@example.com";
// var HUCKSTER_PASSWORD = "…";

/** @returns {{email:string,password:string}} */
function hck_getCreds_() {
  var props = PropertiesService.getScriptProperties();
  var em = props.getProperty("HUCKSTER_EMAIL");
  var pw = props.getProperty("HUCKSTER_PASSWORD");
  if (typeof HUCKSTER_EMAIL !== "undefined" && HUCKSTER_EMAIL) em = HUCKSTER_EMAIL;
  if (typeof HUCKSTER_PASSWORD !== "undefined" && HUCKSTER_PASSWORD) pw = HUCKSTER_PASSWORD;
  if (!em || !pw) throw new Error("Задайте HUCKSTER_EMAIL и HUCKSTER_PASSWORD (константы или свойства скрипта).");
  return { email: String(em).trim(), password: String(pw) };
}

var hck_SHOPS_SET_1 = [
  { id: "ozon", name: "Ozon", marketplace: "ozon", shop_id: "139080" },
  { id: "wb", name: "WB FBS", marketplace: "wildberries", shop_id: "84250" },
  { id: "ym", name: "Альмамед (ЯМ FBS)", marketplace: "yandex", shop_id: "22155238" },
];

var hck_SHOPS_SET_2 = [
  { id: "ozon_fbo", name: "Ozon FBO", marketplace: "ozon", shop_id: "139080_FBO" },
  { id: "wb_fbs", name: "WB FBW/FBS", marketplace: "wildberries", shop_id: "84250_FBO" },
  { id: "ym_fbs", name: "Альмамед (ЯМ FBS) РРЦ", marketplace: "yandex", shop_id: "22155238_2" },
];

var hck_REPRICER_PAGE_LIMIT = 900;
var hck_UNIT_PAGE_LIMIT = 900;
var hck_DELAY_MS = 270;
var hck_DELAY_MS_MIN = 135;
var hck_MAX_OFFSET_PER_SHOP = 0;
/** Быстрый тестовый список UID/кодов: поменяйте под нужную проверку или используйте runAllExportsForUidList(). */
var hck_TEST_UIDS = ["12461"];

var hck_UPDATED_COL_WIDTH = 118;
var hck_UNIT_COL_WIDTH = 88;
var hck_UID_COL_WIDTH = 85;
var hck_NAME_COL_WIDTH = 450;
var hck_SEP_COL_WIDTH = 19;
var hck_SYNC_COL_WIDTH = 136;

var hck_MATRIX_SYNC_HEADER = "Актуально на";
var hck_MATRIX_UNIT_MODELS_HEADER = "Модели Unit";
/** Колонок перед первым UID: Обновлено, Юнит-модель, Модели Unit */
var hck_MATRIX_PREFIX_COLS = 3;

function hck_postJson_(url, payload, sessionId) {
  var headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (sessionId) headers.Cookie = "ss-id=" + sessionId;
  var res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify(payload),
    headers: headers,
  });
  var code = res.getResponseCode();
  var text = res.getContentText().trim();
  if (code < 200 || code >= 300) {
    throw new Error("HTTP " + code + " " + url + " → " + text.slice(0, 400));
  }
  return JSON.parse(text);
}

function hck_md5_(plainPassword) {
  var res = UrlFetchApp.fetch("https://wbs.e-teleport.ru/md5", {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify({ input: plainPassword }),
    headers: { Accept: "application/json" },
  });
  var code = res.getResponseCode();
  var text = res.getContentText().trim();
  if (code < 200 || code >= 300) {
    throw new Error("HTTP " + code + " md5 → " + text.slice(0, 200));
  }
  try {
    var j = JSON.parse(text);
    if (typeof j === "string") return j.replace(/^"|"$/g, "");
  } catch (e1) {}
  return text.replace(/^"|"$/g, "");
}

function hck_auth_(email, passwordPlain) {
  var md5 = hck_md5_(passwordPlain);
  var auth = hck_postJson_(
    "https://wbs.e-teleport.ru/auth/credentials",
    { userName: email, password: md5 },
    null
  );
  var sid = auth.SessionId ? String(auth.SessionId) : "";
  if (!sid) throw new Error("Не получен SessionId");
  return sid;
}

function hck_sleepDelay_() {
  var ms = Math.max(hck_DELAY_MS_MIN, Number(hck_DELAY_MS) || 270);
  Utilities.sleep(ms);
}

function hck_normalizeUidList_(uids) {
  var raw = [];
  if (Array.isArray(uids)) {
    raw = uids;
  } else if (uids != null && String(uids).trim() !== "") {
    raw = String(uids).split(/[,\s;]+/);
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var u = String(raw[i] == null ? "" : raw[i]).trim();
    if (!u || seen[u]) continue;
    seen[u] = true;
    out.push(u);
  }
  return out;
}

function hck_makeUidFilter_(uids) {
  var list = hck_normalizeUidList_(uids);
  if (!list.length) return null;
  var map = {};
  for (var i = 0; i < list.length; i++) map[list[i]] = true;
  return { list: list, map: map, total: list.length };
}

function hck_uidAllowed_(uidFilter, uid) {
  if (!uidFilter) return true;
  return uidFilter.map[String(uid || "").trim()] === true;
}

function hck_allFilteredUidsFound_(uidFilter, foundMap) {
  if (!uidFilter) return false;
  for (var i = 0; i < uidFilter.list.length; i++) {
    if (foundMap[uidFilter.list[i]] !== true) return false;
  }
  return true;
}

function hck_getField_(obj, camel, pascal) {
  if (obj == null || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, camel) && obj[camel] !== undefined) return obj[camel];
  if (Object.prototype.hasOwnProperty.call(obj, pascal) && obj[pascal] !== undefined) return obj[pascal];
  return undefined;
}

function hck_isExplicitlyOff_(v) {
  return v === false || v === 0 || v === "0" || String(v).toLowerCase() === "false";
}

function hck_isExplicitlyOn_(v) {
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

function hck_isIncludedRepricerItem_(p) {
  if (!p || typeof p !== "object") return false;
  var uid = String(hck_getField_(p, "uid", "Uid") || "").trim();
  if (!uid) return false;

  if (hck_isExplicitlyOff_(hck_getField_(p, "is_enabled", "IsEnabled"))) return false;
  if (hck_isExplicitlyOff_(hck_getField_(p, "enabled", "Enabled"))) return false;
  if (hck_isExplicitlyOff_(hck_getField_(p, "active", "Active"))) return false;
  if (hck_isExplicitlyOff_(hck_getField_(p, "visible", "Visible"))) return false;
  if (hck_isExplicitlyOff_(hck_getField_(p, "is_visible", "IsVisible"))) return false;
  if (hck_isExplicitlyOff_(hck_getField_(p, "is_available", "IsAvailable"))) return false;
  if (hck_isExplicitlyOff_(hck_getField_(p, "available", "Available"))) return false;

  if (hck_getField_(p, "deleted", "Deleted") === true) return false;
  if (hck_getField_(p, "is_deleted", "IsDeleted") === true) return false;

  var statusRaw = hck_getField_(p, "status", "Status");
  if (statusRaw == null || statusRaw === "") statusRaw = hck_getField_(p, "state", "State");
  var st = String(statusRaw == null ? "" : statusRaw).toLowerCase();
  if (
    ["disabled", "archived", "deleted", "removed", "inactive", "hidden", "blocked", "off"].indexOf(st) !== -1
  )
    return false;

  if (hck_isExplicitlyOn_(hck_getField_(p, "is_enabled", "IsEnabled"))) return true;
  if (hck_isExplicitlyOn_(hck_getField_(p, "enabled", "Enabled"))) return true;
  if (hck_isExplicitlyOn_(hck_getField_(p, "active", "Active"))) return true;
  if (["enabled", "active", "visible", "on", "ok"].indexOf(st) !== -1) return true;

  return true;
}

function hck_extractItemUpdatedAt_(x) {
  if (!x || typeof x !== "object") return "";
  var raw =
    hck_getField_(x, "updated_at", "UpdatedAt") ||
    hck_getField_(x, "modified_at", "ModifiedAt") ||
    hck_getField_(x, "last_update", "LastUpdate") ||
    hck_getField_(x, "changed_at", "ChangedAt") ||
    hck_getField_(x, "parsed_at", "ParsedAt");
  if (raw == null || raw === "") return "";
  if (typeof raw === "number" && isFinite(raw)) {
    var ms = raw > 1e12 ? raw : raw * 1000;
    var d = new Date(ms);
    return isNaN(d.getTime()) ? "" : d.toISOString();
  }
  var d2 = new Date(String(raw));
  return isNaN(d2.getTime()) ? String(raw) : d2.toISOString();
}

function hck_formatMatrixUpdatedCell_(isoOrText) {
  if (!isoOrText) return "";
  var d = new Date(String(isoOrText));
  if (isNaN(d.getTime())) return String(isoOrText);
  return Utilities.formatDate(d, "Europe/Moscow", "dd.MM.yyyy HH:mm");
}

function hck_unitSetRowMatchesShop_(st, shop) {
  var sm = String(st.marketplace || "").toLowerCase();
  var sid = String(st.shop_id || "").trim();
  var shopMp = String(shop.marketplace || "").toLowerCase();
  var shopId = String(shop.shop_id || "").trim();
  if (sm && shopMp && sm !== shopMp) return false;
  if (!sid || !shopId) return true;
  if (sid === shopId) return true;
  var a = sid.length <= shopId.length ? sid : shopId;
  var b = sid.length <= shopId.length ? shopId : sid;
  if (b.indexOf(a + "_") === 0) return true;
  return false;
}

function hck_extractUnitSetDisplayName_(st, setId) {
  var raw =
    hck_getField_(st, "name", "Name") ||
    hck_getField_(st, "title", "Title") ||
    hck_getField_(st, "set_name", "SetName") ||
    hck_getField_(st, "label", "Label") ||
    "";
  var n = String(raw || "").trim();
  if (n) return n;
  var id = String(setId || "").trim();
  return id ? "#" + id : "";
}

/** uid → true если в модели; uid → массив уникальных названий наборов Unit */
function hck_fetchAllUnitModelInfo_(shop, sessionId, uidFilter) {
  var uidSet = {};
  var uidToNames = {};
  var foundInUnit = {};
  function addUidSetName(uid, setLabel) {
    var u = String(uid || "").trim();
    if (!u) return;
    if (!hck_uidAllowed_(uidFilter, u)) return;
    uidSet[u] = true;
    foundInUnit[u] = true;
    var lbl = String(setLabel || "").trim() || "#";
    if (!uidToNames[u]) uidToNames[u] = [];
    var arr = uidToNames[u];
    if (arr.indexOf(lbl) === -1) arr.push(lbl);
  }

  var listPayload = hck_postJson_(
    "https://wbs.e-teleport.ru/markets/integrations/unit/set/list",
    { marketplace: shop.marketplace, shop_id: shop.shop_id },
    sessionId
  );
  if (listPayload.error) {
    throw new Error(listPayload.error.message || JSON.stringify(listPayload.error));
  }
  var res0 = listPayload.result || {};
  var setList = Array.isArray(res0.set_list) ? res0.set_list : [];

  for (var si = 0; si < setList.length; si++) {
    var st = setList[si];
    if (!hck_unitSetRowMatchesShop_(st, shop)) continue;

    var setId = String(
      st.id != null ? st.id : st.set_id != null ? st.set_id : ""
    ).trim();
    if (!setId) continue;
    var setName = hck_extractUnitSetDisplayName_(st, setId);

    var offset = 0;
    for (;;) {
      var gp = hck_postJson_(
        "https://wbs.e-teleport.ru/markets/integrations/unit/set/get",
        {
          marketplace: shop.marketplace,
          shop_id: shop.shop_id,
          set_id: setId,
          limit: hck_UNIT_PAGE_LIMIT,
          offset: offset,
        },
        sessionId
      );
      if (gp.error) {
        Logger.log(
          "unit/set/get set_id=" + setId + ": " + (gp.error.message || JSON.stringify(gp.error))
        );
        break;
      }
      var res = gp.result || {};
      var itemList = Array.isArray(res.item_list) ? res.item_list : [];
      var cur = res.cursor || {};
      var total = Number(cur.total);

      for (var ii = 0; ii < itemList.length; ii++) {
        var it = itemList[ii];
        var u = String(
          hck_getField_(it, "uid", "Uid") ||
            it.item_id ||
            hck_getField_(it, "item_id", "ItemId") ||
            ""
        ).trim();
        if (u) addUidSetName(u, setName);
      }

      if (hck_allFilteredUidsFound_(uidFilter, foundInUnit)) break;
      if (!itemList.length) break;
      offset += hck_UNIT_PAGE_LIMIT;
      if (itemList.length < hck_UNIT_PAGE_LIMIT) break;
      if (isFinite(total) && offset >= total) break;
      hck_sleepDelay_();
    }
    if (hck_allFilteredUidsFound_(uidFilter, foundInUnit)) break;
  }
  return { uidSet: uidSet, uidToNames: uidToNames };
}

function hck_fetchAllProducts_(shop, sessionId, uidFilter) {
  var products = [];
  var foundInRepricer = {};
  var offset = 0;
  var limit = hck_REPRICER_PAGE_LIMIT;
  var maxOff = Math.max(0, Number(hck_MAX_OFFSET_PER_SHOP) || 0);

  while (maxOff === 0 || offset < maxOff) {
    var payload = hck_postJson_(
      "https://wbs.e-teleport.ru/markets/integrations/repricer/items/list",
      { marketplace: shop.marketplace, shop_id: shop.shop_id, limit: limit, offset: offset },
      sessionId
    );
    if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    var rows = Array.isArray(payload.result) ? payload.result : [];

    for (var i = 0; i < rows.length; i++) {
      var p = rows[i];
      if (!hck_isIncludedRepricerItem_(p)) continue;
      var uid = String(hck_getField_(p, "uid", "Uid") || "").trim();
      if (!uid) continue;
      if (!hck_uidAllowed_(uidFilter, uid)) continue;
      foundInRepricer[uid] = true;
      products.push({
        uid: uid,
        name: String(hck_getField_(p, "name", "Name") || ""),
        updatedAt: hck_extractItemUpdatedAt_(p),
      });
    }

    if (hck_allFilteredUidsFound_(uidFilter, foundInRepricer)) break;
    offset += limit;
    if (rows.length < limit) break;
    hck_sleepDelay_();
  }

  var unitInfo = null;
  try {
    unitInfo = hck_fetchAllUnitModelInfo_(shop, sessionId, uidFilter);
  } catch (e) {
    Logger.log("Unit-экономика (пропуск): " + (e.message || e));
    unitInfo = null;
  }

  var out = [];
  for (var j = 0; j < products.length; j++) {
    var pr = products[j];
    var inUnit = null;
    var unitModelNames = "";
    if (unitInfo != null) {
      inUnit = unitInfo.uidSet[pr.uid] === true;
      var nmArr = unitInfo.uidToNames[pr.uid];
      if (nmArr && nmArr.length) {
        var sorted = nmArr.slice().sort(function (a, b) {
          return String(a).localeCompare(String(b), undefined, { numeric: true });
        });
        unitModelNames = sorted.join("; ");
      }
    }
    out.push({
      uid: pr.uid,
      name: pr.name,
      updatedAt: pr.updatedAt,
      inUnitModel: inUnit,
      unitModelNames: unitModelNames,
    });
  }
  return out;
}

function hck_buildMatrix_(shops, shopItems, syncedAtIso) {
  var shopMaps = {};
  for (var si = 0; si < shops.length; si++) {
    var s = shops[si];
    var list = shopItems[s.id] || [];
    var m = {};
    for (var li = 0; li < list.length; li++) {
      var r = list[li];
      var inU = null;
      if (r.inUnitModel === true) inU = true;
      else if (r.inUnitModel === false) inU = false;
      m[r.uid] = {
        name: String(r.name || ""),
        updatedAt: String(r.updatedAt || ""),
        inUnitModel: inU,
        unitModelNames: String(r.unitModelNames || ""),
      };
    }
    shopMaps[s.id] = m;
  }

  var primaryId = shops[0] && shops[0].id;
  var uidSeen = {};
  for (var sxi = 0; sxi < shops.length; sxi++) {
    var sid = shops[sxi].id;
    var pmap = shopMaps[sid] || {};
    var ks = Object.keys(pmap);
    for (var kzi = 0; kzi < ks.length; kzi++) {
      var u0 = String(ks[kzi] || "").trim();
      if (u0) uidSeen[u0] = true;
    }
  }
  var sortedUids = Object.keys(uidSeen);
  sortedUids.sort(function (a, b) {
    return a.localeCompare(b, undefined, { numeric: true });
  });

  var header = ["Обновлено", "Юнит-модель", hck_MATRIX_UNIT_MODELS_HEADER];
  for (var hi = 0; hi < shops.length; hi++) {
    var sh = shops[hi];
    if (hi > 0) header.push("");
    header.push("UID " + sh.name, "Наименование товаров " + sh.name);
  }
  var syncIso = syncedAtIso && String(syncedAtIso).trim() ? String(syncedAtIso).trim() : "";
  var syncCell = syncIso ? hck_formatMatrixUpdatedCell_(syncIso) : "";
  if (syncIso) header.push(hck_MATRIX_SYNC_HEADER);

  var rows = [header];
  var unitGapCell = [];
  unitGapCell.push(new Array(header.length));
  for (var ugi = 0; ugi < header.length; ugi++) {
    unitGapCell[0][ugi] = false;
  }
  for (var ui = 0; ui < sortedUids.length; ui++) {
    var uid = sortedUids[ui];
    var latestIso = "";
    for (var sj = 0; sj < shops.length; sj++) {
      var rec = shopMaps[shops[sj].id][uid];
      if (rec && rec.updatedAt) {
        if (!latestIso || rec.updatedAt > latestIso) latestIso = rec.updatedAt;
      }
    }
    var primaryRec = primaryId ? shopMaps[primaryId][uid] : null;
    var unitCell = "—";
    var unitModelsCell = "—";
    if (primaryRec) {
      if (primaryRec.inUnitModel === true) unitCell = "да";
      else if (primaryRec.inUnitModel === false) unitCell = "нет";
      unitModelsCell = String(primaryRec.unitModelNames || "").trim();
    }
    var row = [hck_formatMatrixUpdatedCell_(latestIso), unitCell, unitModelsCell];
    var gapRow = new Array(header.length);
    for (var gri = 0; gri < header.length; gri++) {
      gapRow[gri] = false;
    }
    for (var sk = 0; sk < shops.length; sk++) {
      if (sk > 0) row.push("");
      var rec2 = shopMaps[shops[sk].id][uid];
      var name = rec2 ? rec2.name : "";
      var nmTrim = String(name || "").trim();
      if (nmTrim && rec2.inUnitModel === false) {
        var base = hck_MATRIX_PREFIX_COLS + sk * 3;
        gapRow[base] = true;
        gapRow[base + 1] = true;
      }
      row.push(nmTrim ? uid : "", name || "");
    }
    if (syncIso) row.push(syncCell);
    rows.push(row);
    unitGapCell.push(gapRow);
  }
  return { rows: rows, unitGapCell: unitGapCell };
}

/** Число колонок префикса по шапке (2 — старые листы, 3 — с «Модели Unit»). */
function hck_matrixPrefixColsFromHeader_(headerRow) {
  if (!headerRow || headerRow.length < 2) return 0;
  var h0 = String(headerRow[0] != null ? headerRow[0] : "").trim();
  var h1 = String(headerRow[1] != null ? headerRow[1] : "").trim();
  if (h0 !== "Обновлено") return 0;
  if (h1 !== "Юнит-модель") return 1;
  var h2 = String(headerRow[2] != null ? headerRow[2] : "").trim();
  if (h2 === hck_MATRIX_UNIT_MODELS_HEADER) return hck_MATRIX_PREFIX_COLS;
  return 2;
}

/** Колонка «Юнит-модель» со значением «нет» (шапка: Обновлено + Юнит-модель). */
function hck_isUnitNoCell_(r, c, output) {
  if (r === 0) return false;
  if (!output || !output[0] || output[0].length < 2) return false;
  var h0 = String(output[0][0] != null ? output[0][0] : "").trim();
  var h1 = String(output[0][1] != null ? output[0][1] : "").trim();
  if (h0 !== "Обновлено" || h1 !== "Юнит-модель") return false;
  if (c !== 1) return false;
  return String(output[r][c] != null ? output[r][c] : "").trim() === "нет";
}

function hck_isMissingUidBlockCell_(r, c, output, hasSyncCol) {
  if (r === 0) return false;
  var prefix = hck_matrixPrefixColsFromHeader_(output[0]);
  if (c < prefix) return false;
  var last = output[0].length - 1;
  if (hasSyncCol && c === last) return false;
  var k = c - prefix;
  if (k % 3 === 2) return false;
  var uidCol = k % 3 === 0;
  var nameCol = k % 3 === 1;
  if (!uidCol && !nameCol) return false;
  if (output[r][c] !== "") return false;
  if (uidCol) return true;
  return output[r][c - 1] === "";
}

function hck_applyBackgrounds_(sheet, output, unitGapCell) {
  var lastRow = output.length;
  var totalCols = output[0].length;
  var hasSyncCol = output[0][totalCols - 1] === hck_MATRIX_SYNC_HEADER;
  /* Как в панели exports-huckster: пустые маркеты, «Юнит-модель: нет», и пары UID/имя при «не в Unit-моделях» */
  var emphasisBg = "#fce4ec";
  var bgColors = [];
  for (var r = 0; r < lastRow; r++) {
    var rowColors = [];
    for (var c = 0; c < totalCols; c++) {
      if (r === 0) {
        rowColors.push("#f1f3f4");
      } else if (hck_isUnitNoCell_(r, c, output)) {
        rowColors.push(emphasisBg);
      } else if (hck_isMissingUidBlockCell_(r, c, output, hasSyncCol)) {
        rowColors.push(emphasisBg);
      } else if (unitGapCell && unitGapCell[r] && unitGapCell[r][c]) {
        rowColors.push(emphasisBg);
      } else {
        rowColors.push(null);
      }
    }
    bgColors.push(rowColors);
  }
  sheet.getRange(1, 1, lastRow, totalCols).setBackgrounds(bgColors);
}

function hck_setColumnWidths_(sheet, shops, hasSyncCol) {
  var col = 1;
  sheet.setColumnWidth(col++, hck_UPDATED_COL_WIDTH);
  sheet.setColumnWidth(col++, hck_UNIT_COL_WIDTH);
  sheet.setColumnWidth(col++, 280);
  for (var i = 0; i < shops.length; i++) {
    sheet.setColumnWidth(col++, hck_UID_COL_WIDTH);
    sheet.setColumnWidth(col++, hck_NAME_COL_WIDTH);
    if (i < shops.length - 1) {
      sheet.setColumnWidth(col++, hck_SEP_COL_WIDTH);
    }
  }
  if (hasSyncCol) {
    sheet.setColumnWidth(col++, hck_SYNC_COL_WIDTH);
  }
}

function hck_setNameColumnsNoWrap_(sheet, shops, lastRow) {
  if (lastRow < 2) return;
  var headRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var prefix = hck_matrixPrefixColsFromHeader_(headRow);
  if (prefix < 2) return;
  for (var i = 0; i < shops.length; i++) {
    var nameCol = prefix + 1 + 3 * i;
    sheet.getRange(2, nameCol, lastRow, nameCol).setWrap(false);
  }
}

/** Оранжевый жирный текст для «нет» в колонке «Юнит-модель» (как в эталоне панели). */
function hck_styleUnitModelColumn_(sheet, lastRow) {
  if (lastRow < 2) return;
  var h0 = String(sheet.getRange(1, 1).getValue() || "").trim();
  var h1 = String(sheet.getRange(1, 2).getValue() || "").trim();
  if (h0 !== "Обновлено" || h1 !== "Юнит-модель") return;
  for (var r = 2; r <= lastRow; r++) {
    var cell = sheet.getRange(r, 2);
    var v = String(cell.getValue() || "").trim();
    if (v === "нет") {
      cell.setFontColor("#cc4d00");
      cell.setFontWeight("bold");
    } else {
      cell.setFontColor("#000000");
      cell.setFontWeight("normal");
    }
  }
}

function hck_runExport_(sheetName, shops, opts) {
  opts = opts || {};
  var uidFilter = hck_makeUidFilter_(opts.uids || opts.uidList || null);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  var creds = hck_getCreds_();
  Logger.log("🔐 [" + sheetName + "] Аутентификация...");
  if (uidFilter) {
    Logger.log("🧪 [" + sheetName + "] Тестовый UID-фильтр: " + uidFilter.list.join(", "));
  }
  var sessionId = hck_auth_(creds.email, creds.password);

  var shopItems = {};
  for (var i = 0; i < shops.length; i++) {
    var shop = shops[i];
    try {
      shopItems[shop.id] = hck_fetchAllProducts_(shop, sessionId, uidFilter);
      Logger.log("✅ [" + sheetName + "] " + shop.name + ": " + shopItems[shop.id].length + " поз.");
    } catch (e) {
      Logger.log("⚠️ [" + sheetName + "] " + shop.name + ": " + (e.message || e) + " — пустой список.");
      shopItems[shop.id] = [];
    }
  }

  var syncedAtIso = new Date().toISOString();
  var built = hck_buildMatrix_(shops, shopItems, syncedAtIso);
  var output = built.rows;
  var unitGapCell = built.unitGapCell;

  sheet.clearContents();
  if (output.length > 1) {
    var lastRow = output.length;
    var totalCols = output[0].length;
    sheet.getRange(1, 1, lastRow, totalCols).setValues(output);
    hck_applyBackgrounds_(sheet, output, unitGapCell);
    sheet.getRange(1, 1, 1, totalCols).setFontWeight("bold");
    hck_styleUnitModelColumn_(sheet, lastRow);
    sheet.setFrozenRows(1);

    var hasSync = output[0][totalCols - 1] === hck_MATRIX_SYNC_HEADER;
    hck_setColumnWidths_(sheet, shops, hasSync);
    hck_setNameColumnsNoWrap_(sheet, shops, lastRow);
  }
  Logger.log("🎉 [" + sheetName + "] Готово.");
}

// ========== Точки входа под ВАШЕ меню (имена не менять) ==========

function exportHucksterExport() {
  hck_runExport_("Huckster Export", hck_SHOPS_SET_1);
}

function exportHucksterExportRRC() {
  hck_runExport_("Huckster Export RRC", hck_SHOPS_SET_2);
}

function runAllExports() {
  exportHucksterExport();
  exportHucksterExportRRC();
  Logger.log("🎉 Оба листа обновлены.");
}

// ========== Быстрые тестовые запуски по списку UID ==========

function exportHucksterExportTest12461() {
  hck_runExport_("Huckster Export TEST", hck_SHOPS_SET_1, { uids: hck_TEST_UIDS });
}

function exportHucksterExportRRCTest12461() {
  hck_runExport_("Huckster Export RRC TEST", hck_SHOPS_SET_2, { uids: hck_TEST_UIDS });
}

function runAllExportsTest12461() {
  exportHucksterExportTest12461();
  exportHucksterExportRRCTest12461();
  Logger.log("🎉 Тестовые листы по UID готовы: " + hck_normalizeUidList_(hck_TEST_UIDS).join(", "));
}

function runAllExportsForUidList() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    "Huckster test UID",
    "Введите UID/коды через запятую, пробел или с новой строки (например: 12461):",
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var uids = hck_normalizeUidList_(res.getResponseText());
  if (!uids.length) {
    ui.alert("UID не указаны.");
    return;
  }
  hck_runExport_("Huckster Export TEST", hck_SHOPS_SET_1, { uids: uids });
  hck_runExport_("Huckster Export RRC TEST", hck_SHOPS_SET_2, { uids: uids });
  Logger.log("🎉 Тестовые листы по UID готовы: " + uids.join(", "));
}
