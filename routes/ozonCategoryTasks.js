'use strict';

/**
 * Задачи на смену категории Ozon:
 *  - публичный роутер `/public/ozon-category-tasks` (токен в ссылке + мини-пароль) — для бота;
 *  - админский `/api/exports/marketplaces/ozon-merge/category-tasks` — список и настройка доступа.
 */

const express = require('express');
const tasks = require('../lib/ozonCategoryTasks');

function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isSecure(req) {
    if (req.secure) return true;
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function wantsJson(req) {
    return String(req.query.format || '').toLowerCase() === 'json';
}

function setNoStore(res) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');
}

const PAGE_CSS = `
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#f1f4f6;color:#343a40;font-size:14px}
.wrap{max-width:1200px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}
.muted{color:#6c757d}
.card{background:#fff;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:16px;margin:16px 0}
.card h2{font-size:16px;margin:0 0 8px}
table{border-collapse:collapse;width:100%;margin:8px 0}
td,th{border:1px solid #e6e9ee;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f8f9fa}
code{background:#f1f3f5;padding:1px 4px;border-radius:3px}
.cat{margin:4px 0}
.sug li{margin:2px 0}
textarea{width:100%;min-height:60px;box-sizing:border-box;font:inherit;padding:6px;border:1px solid #ced4da;border-radius:4px}
input[type=password],input[type=text]{font:inherit;padding:6px 8px;border:1px solid #ced4da;border-radius:4px}
button{font:inherit;padding:6px 14px;border:0;border-radius:4px;background:#3f6ad8;color:#fff;cursor:pointer}
button:disabled{opacity:.6}
.msg{margin-left:8px}
.ok{color:#2e7d32}.err{color:#c62828}
.last{background:#f8f9fa;border-left:3px solid #3f6ad8;padding:6px 8px;margin:8px 0}
.check{background:#fff8e1;border-left:3px solid #f7b924;padding:6px 8px;margin:8px 0}
.check.ok{background:#e8f5e9;border-left-color:#3ac47d;color:inherit}
.task.done{opacity:.55}
.btn-grey{background:#6c757d}
.queue{background:#fff;border-radius:6px;padding:10px 16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
ol.how{margin:6px 0 0 18px;padding:0}
`;

function loginPage(error) {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход — задачи Ozon</title><style>${PAGE_CSS}</style></head>
<body><div class="wrap"><div class="card" style="max-width:420px;margin:60px auto">
<h1>Задачи на смену категории Ozon</h1>
<p class="muted">Введите пароль доступа.</p>
<form id="login-form">
<input type="password" id="pin" name="pin" autocomplete="current-password" required autofocus style="width:100%;box-sizing:border-box">
<div style="margin-top:12px"><button type="submit" id="login-btn">Войти</button><span class="msg err" id="login-msg">${esc(error || '')}</span></div>
</form></div></div>
<script>
document.getElementById('login-form').addEventListener('submit',function(e){
  e.preventDefault();
  var btn=document.getElementById('login-btn'),msg=document.getElementById('login-msg');
  btn.disabled=true;msg.textContent='';
  fetch('/public/ozon-category-tasks/login'+location.search,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
    body:JSON.stringify({pin:document.getElementById('pin').value})})
  .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
  .then(function(p){if(p.ok&&p.j.success){location.reload();}else{msg.textContent=(p.j&&p.j.error)||'Ошибка';btn.disabled=false;}})
  .catch(function(err){msg.textContent=String(err);btn.disabled=false;});
});
</script></body></html>`;
}

function tasksPage(data) {
    const rows = data.rows || [];
    const q = data.queue || {};
    const rf = data.refill || {};
    const refillText = rf.running
        ? 'Сейчас ищем новые группы в предложениях склейки — обновите страницу через минуту.'
        : rf.last_at
          ? `Последний поиск новых групп: ${rf.last_at}` +
            (rf.last_result ? `, добавлено ${rf.last_result.added} из ${rf.last_result.scanned} проверенных.` : '') +
            (rf.last_error ? ` Ошибка: ${rf.last_error}` : '')
          : 'Очередь пополняется автоматически, когда в пачке меньше 10 задач.';
    const cards = rows
        .map((g) => {
            const items = g.items
                .map(
                    (it) =>
                        `<tr><td><code>${esc(it.offer_id)}</code></td><td>${esc(it.name)}</td>` +
                        `<td>${it.product_id ? esc(it.product_id) : ''}</td>` +
                        `<td>${it.ozon_url ? `<a href="${esc(it.ozon_url)}" target="_blank" rel="noopener noreferrer">${esc(it.sku)}</a>` : ''}</td></tr>`
                )
                .join('');
            const cur = g.current_category || {};
            const sug = (g.suggested_categories || []).length
                ? `<ul class="sug">${g.suggested_categories
                      .map(
                          (c) =>
                              `<li><strong>${esc(c.path)}</strong> <span class="muted">(category_id=${esc(c.description_category_id)}, type_id=${esc(c.type_id)}; переключение: ${esc(c.aspects.join('; '))})</span></li>`
                      )
                      .join('')}</ul>`
                : '<div class="muted">Подходящих категорий автоматически не нашлось — подберите вручную.</div>';
            const last = g.category_comment
                ? `<div class="last" id="last-${esc(g.signature)}"><strong>${esc(g.category_comment_by)}</strong> · ${esc(g.category_comment_at)}<br>${esc(g.category_comment)}</div>`
                : `<div class="last" id="last-${esc(g.signature)}" style="display:none"></div>`;
            return `<div class="card task" data-signature="${esc(g.signature)}">
<h2>${esc(g.title)}</h2>
<div class="muted">Группа <code>${esc(g.signature)}</code> · главный товар <code>${esc(g.main_offer_id)}</code> · отказ Ozon ${esc(g.failed_at)}</div>
<div class="cat"><strong>Текущая категория:</strong> ${esc(cur.path || '—')} <span class="muted">(category_id=${esc(cur.description_category_id || '')}, type_id=${esc(cur.type_id || '')})</span>${g.items_same_category ? '' : ' <span class="err">— у товаров группы разные категории</span>'}</div>
<div class="cat"><strong>Подходящие категории (есть склейка):</strong>${sug}</div>
<table><thead><tr><th>Код</th><th>Название</th><th>product_id</th><th>SKU / витрина</th></tr></thead><tbody>${items}</tbody></table>
${last}
<label for="comment-${esc(g.signature)}"><strong>Комментарий: что сделано с категорией</strong></label>
<textarea id="comment-${esc(g.signature)}" name="comment-${esc(g.signature)}" maxlength="1000" placeholder="Например: сменил «Ректальная насадка» → «Катетер медицинский» у всех 4 карточек"></textarea>
<div style="margin-top:8px"><input type="text" id="author-${esc(g.signature)}" name="author-${esc(g.signature)}" maxlength="100" placeholder="Кто (например, Hermes)">
<button type="button" class="save-btn" id="save-${esc(g.signature)}" data-signature="${esc(g.signature)}">Сохранить комментарий</button><span class="msg" id="msg-${esc(g.signature)}"></span></div>
<div class="check" id="note-${esc(g.signature)}"${g.check_note ? '' : ' style="display:none"'}>${g.check_note ? `<strong>Последняя проверка ${esc(g.checked_at)}:</strong> ${esc(g.check_note)}` : ''}</div>
<div style="margin-top:8px">
<button type="button" class="check-btn" id="check-${esc(g.signature)}" data-signature="${esc(g.signature)}">Готово — проверить в Ozon</button>
<button type="button" class="skip-btn btn-grey" id="skip-${esc(g.signature)}" data-signature="${esc(g.signature)}">Не получилось — пропустить</button>
<span class="msg" id="cmsg-${esc(g.signature)}"></span></div>
</div>`;
        })
        .join('');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Задачи на смену категории Ozon</title><style>${PAGE_CSS}</style></head>
<body><div class="wrap">
<h1>Задачи на смену категории Ozon</h1>
<div class="muted">Группы, которые Ozon не может склеить: в текущей категории нет атрибута склейки 9048 и вариативных характеристик. JSON: добавьте к ссылке <code>&amp;format=json</code>.</div>
<ol class="how muted">
<li>Смените категорию у всех карточек группы в кабинете Ozon.</li>
<li>Сохраните комментарий: с какой категории на какую сменили.</li>
<li>Нажмите «Готово — проверить в Ozon». Datagon сам посмотрит категорию в Ozon: если склейка в ней есть, задача закрыта и вместо неё придёт следующая.</li>
<li>Если сменить нельзя — комментарий «почему» и «Не получилось — пропустить».</li>
</ol>
<div class="queue">В этой пачке: <strong id="tasks-total">${rows.length}</strong> · ждут в очереди: <strong>${esc(q.waiting || 0)}</strong> · проверено и закрыто: <strong>${esc(q.done || 0)}</strong> · пропущено: <strong>${esc(q.skipped || 0)}</strong>
<br><span class="muted">${esc(refillText)}</span>
<div style="margin-top:6px"><button type="button" id="reload-btn" onclick="location.reload()">Загрузить следующую пачку</button></div></div>
${cards || '<div class="card">Задач нет. Очередь пополняется автоматически из новых предложений склейки — загляните позже.</div>'}
</div>
<script>
function octAction(kind,btn){
  var sig=btn.getAttribute('data-signature');
  var au=document.getElementById('author-'+sig),msg=document.getElementById('cmsg-'+sig),note=document.getElementById('note-'+sig);
  msg.className='msg';msg.textContent=kind==='check'?'Проверяем в Ozon…':'Пропускаем…';
  var btns=document.querySelectorAll('[data-signature="'+sig+'"]');btns.forEach(function(b){b.disabled=true;});
  fetch('/public/ozon-category-tasks/'+kind+location.search,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
    body:JSON.stringify({signature:sig,author:au.value})})
  .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
  .then(function(p){
    if(!p.ok||!p.j.success){btns.forEach(function(b){b.disabled=false;});msg.className='msg err';msg.textContent=(p.j&&p.j.error)||'Ошибка';return;}
    var closed=kind==='skip'||p.j.verified;
    if(p.j.note){note.style.display='';note.textContent=p.j.note;note.className='check'+(p.j.verified?' ok':'');}
    msg.className='msg '+(closed?'ok':'err');
    msg.textContent=kind==='skip'?'Пропущено — задача закрыта':p.j.verified?'Проверено — задача закрыта':'Не подтверждено — см. причину выше';
    if(closed){document.querySelector('.task[data-signature="'+sig+'"]').classList.add('done');}
    else{btns.forEach(function(b){b.disabled=false;});}
  })
  .catch(function(err){btns.forEach(function(b){b.disabled=false;});msg.className='msg err';msg.textContent=String(err);});
}
document.querySelectorAll('.check-btn').forEach(function(b){b.addEventListener('click',function(){octAction('check',b);});});
document.querySelectorAll('.skip-btn').forEach(function(b){b.addEventListener('click',function(){octAction('skip',b);});});
document.querySelectorAll('.save-btn').forEach(function(btn){
  btn.addEventListener('click',function(){
    var sig=btn.getAttribute('data-signature');
    var ta=document.getElementById('comment-'+sig),au=document.getElementById('author-'+sig),msg=document.getElementById('msg-'+sig);
    msg.className='msg';msg.textContent='Сохраняем…';btn.disabled=true;
    fetch('/public/ozon-category-tasks/comment'+location.search,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
      body:JSON.stringify({signature:sig,comment:ta.value,author:au.value})})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
    .then(function(p){
      btn.disabled=false;
      if(!p.ok||!p.j.success){msg.className='msg err';msg.textContent=(p.j&&p.j.error)||'Ошибка';return;}
      msg.className='msg ok';msg.textContent='Сохранено';
      var last=document.getElementById('last-'+sig);
      last.style.display='';last.textContent='';
      var b=document.createElement('strong');b.textContent=p.j.category_comment_by;last.appendChild(b);
      last.appendChild(document.createTextNode(' · '+p.j.category_comment_at));
      last.appendChild(document.createElement('br'));
      last.appendChild(document.createTextNode(p.j.category_comment));
      ta.value='';
    })
    .catch(function(err){btn.disabled=false;msg.className='msg err';msg.textContent=String(err);});
  });
});
</script></body></html>`;
}

function denyHtml(res, access) {
    if (access.status === 404) return res.status(404).type('text/plain').send('Not found');
    if (access.status === 401) return res.status(401).type('html').send(loginPage(access.code === 'PIN_INVALID' ? access.error : ''));
    return res.status(access.status).type('html').send(loginPage(access.error));
}

function createPublicRouter(db) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        setNoStore(res);
        try {
            const access = await tasks.checkAccess(db, req);
            if (!access.ok) {
                if (wantsJson(req)) {
                    return res.status(access.status).json({ success: false, error: access.error, code: access.code });
                }
                return denyHtml(res, access);
            }
            if (access.pinAccepted && !wantsJson(req)) {
                res.append('Set-Cookie', tasks.buildSessionCookie(access.settings, isSecure(req)));
            }
            const data = await tasks.listCategoryTasks(db, { autoRefill: true });
            if (wantsJson(req)) return res.json(data);
            return res.type('html').send(tasksPage(data));
        } catch (e) {
            console.error('[ozon-category-tasks] list failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ success: false, error: e && e.message ? e.message : String(e) });
        }
    });

    router.post('/login', async (req, res) => {
        setNoStore(res);
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const access = await tasks.checkAccess(db, req, { pin: body.pin });
            if (!access.ok) {
                return res.status(access.status).json({ success: false, error: access.error, code: access.code });
            }
            res.append('Set-Cookie', tasks.buildSessionCookie(access.settings, isSecure(req)));
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ success: false, error: e && e.message ? e.message : String(e) });
        }
    });

    router.post('/comment', async (req, res) => {
        setNoStore(res);
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const access = await tasks.checkAccess(db, req, { pin: body.pin });
            if (!access.ok) {
                return res.status(access.status).json({ success: false, error: access.error, code: access.code });
            }
            const out = await tasks.saveCategoryComment(db, {
                signature: body.signature,
                comment: body.comment,
                author: body.author,
            });
            return res.json(out);
        } catch (e) {
            return sendTaskError(res, e, 'COMMENT_FAILED');
        }
    });

    const taskAction = (fn, fallbackCode) => async (req, res) => {
        setNoStore(res);
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const access = await tasks.checkAccess(db, req, { pin: body.pin });
            if (!access.ok) {
                return res.status(access.status).json({ success: false, error: access.error, code: access.code });
            }
            return res.json(await fn(db, { signature: body.signature, author: body.author }));
        } catch (e) {
            return sendTaskError(res, e, fallbackCode);
        }
    };
    router.post('/check', taskAction(tasks.verifyCategoryTask, 'CHECK_FAILED'));
    router.post('/skip', taskAction(tasks.skipCategoryTask, 'SKIP_FAILED'));

    return router;
}

function sendTaskError(res, e, fallbackCode) {
    const code = e && e.code ? e.code : fallbackCode;
    const status =
        code === 'TASK_NOT_FOUND' ? 404 : code === 'TASK_CLOSED' ? 409 : /REQUIRED|TOO_LONG|NO_OZON_CREDS/.test(code) ? 400 : 500;
    return res.status(status).json({ success: false, error: e && e.message ? e.message : String(e), code });
}

function createAdminRouter(db) {
    const router = express.Router();
    const isAdmin = (req) => String((req.datagonActor && req.datagonActor.username) || '').toLowerCase() === 'admin';

    router.get('/config', async (req, res) => {
        if (!isAdmin(req)) return res.status(403).json({ success: false, error: 'Только admin', code: 'ADMIN_ONLY' });
        try {
            return res.json({ success: true, ...(await tasks.getConfig(db)) });
        } catch (e) {
            return res.status(500).json({ success: false, error: e && e.message ? e.message : String(e) });
        }
    });

    router.post('/config', async (req, res) => {
        if (!isAdmin(req)) return res.status(403).json({ success: false, error: 'Только admin', code: 'ADMIN_ONLY' });
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const token = body.generate_token ? tasks.generateToken() : body.token;
            const out = await tasks.saveConfig(db, { token, pin: body.pin });
            return res.json({ success: true, ...out });
        } catch (e) {
            const status = e && /TOKEN_TOO_SHORT|PIN_INVALID/.test(String(e.code)) ? 400 : 500;
            return res.status(status).json({ success: false, error: e && e.message ? e.message : String(e), code: e && e.code });
        }
    });

    router.post('/refill', async (req, res) => {
        try {
            const started = tasks.startRefill(db, { force: true });
            return res.json({ success: true, started, refill: tasks.refillStatus(), queue: await tasks.countTasks(db) });
        } catch (e) {
            return res.status(500).json({ success: false, error: e && e.message ? e.message : String(e) });
        }
    });

    router.get('/refill', async (req, res) => {
        try {
            return res.json({ success: true, refill: tasks.refillStatus(), queue: await tasks.countTasks(db) });
        } catch (e) {
            return res.status(500).json({ success: false, error: e && e.message ? e.message : String(e) });
        }
    });

    router.get('/list', async (req, res) => {
        try {
            return res.json(await tasks.listCategoryTasks(db, { withSuggestions: String(req.query.suggest || '1') !== '0' }));
        } catch (e) {
            return res.status(500).json({ success: false, error: e && e.message ? e.message : String(e) });
        }
    });

    return router;
}

module.exports = { createPublicRouter, createAdminRouter, _tasksPage: tasksPage };
