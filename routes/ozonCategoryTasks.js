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
.btn-amber{background:#f7b924;color:#212529}
.thread{margin:6px 0 10px}
.msg-item{border-left:3px solid #3f6ad8;background:#f8f9fa;padding:6px 8px;margin:4px 0}
.msg-item.question{border-left-color:#f7b924;background:#fff8e1}
.msg-item.human{border-left-color:#3ac47d;background:#e8f5e9}
.msg-head{font-size:12px;color:#6c757d}
.msg-body{white-space:pre-wrap}
.badge{font-size:12px;font-weight:600;padding:2px 8px;border-radius:10px;vertical-align:middle}
.b-answer{background:#3ac47d;color:#fff}.b-wait{background:#f7b924;color:#212529}
.btn-red{background:#d92550}.btn-purple{background:#794c8a}.btn-green{background:#3ac47d}
.msg-item.ticket{border-left-color:#794c8a;background:#f3eef6}
.b-ticket{background:#794c8a;color:#fff}.b-skip{background:#6c757d;color:#fff}
.row-ctl{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ticket-in{width:170px}
.tabs{display:flex;gap:4px;margin:16px 0 0;border-bottom:2px solid #dee2e6}
.tab{background:transparent;color:#495057;border-radius:4px 4px 0 0;padding:8px 16px;font-weight:600;margin-bottom:-2px;border-bottom:2px solid transparent}
.tab.active{color:#3f6ad8;border-bottom-color:#3f6ad8;background:#fff}
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

const THREAD_LABELS = {
    'bot:comment': 'комментарий',
    'bot:question': 'нужно уточнение',
    'bot:ticket': 'тикет Ozon',
    'bot:status': 'смена статуса',
    'human:answer': 'ответ',
};

function threadHtml(thread) {
    if (!thread || !thread.length) return '<div class="muted">Комментариев пока нет.</div>';
    return thread
        .map(
            (m) =>
                `<div class="msg-item ${m.role === 'human' ? 'human' : m.kind === 'question' ? 'question' : m.kind === 'ticket' ? 'ticket' : 'bot'}">` +
                `<div class="msg-head"><strong>${esc(m.author || (m.role === 'human' ? 'сотрудник' : 'бот'))}</strong> · ${esc(THREAD_LABELS[`${m.role}:${m.kind}`] || m.kind)} · ${esc(m.at)}</div>` +
                `<div class="msg-body">${esc(m.body)}</div></div>`
        )
        .join('');
}

/** Кнопки действий по статусу задачи; {SIG} подставляется в taskCard. */
function cardButtons(state) {
    const b = (action, label, cls = '') => `<button type="button" class="act-btn ${cls}" data-action="${action}" data-signature="{SIG}">${label}</button>`;
    const reject = b('reject', 'Не объединять (окончательно)', 'btn-red');
    const ticket = b('ticket', state === 'ticket' ? 'Обновить тикет' : 'Создал тикет в Ozon', 'btn-purple');
    if (state === 'skipped') {
        return [b('reopen', 'Вернуть в работу', 'btn-green'), ticket, reject];
    }
    if (state === 'ticket') {
        return [b('check', 'Готово — проверить в Ozon'), b('reopen', 'Вернуть в работу', 'btn-green'), ticket, reject];
    }
    return [b('check', 'Готово — проверить в Ozon'), b('skip', 'Не получилось — пропустить', 'btn-grey'), ticket, reject];
}

function taskCard(g, { full }) {
    const sig = esc(g.signature);
    const items = g.items
        .map(
            (it) =>
                `<tr><td><code>${esc(it.offer_id)}</code></td><td>${esc(it.name)}</td>` +
                `<td>${it.product_id ? esc(it.product_id) : ''}</td>` +
                `<td>${it.ozon_url ? `<a href="${esc(it.ozon_url)}" target="_blank" rel="noopener noreferrer">${esc(it.sku)}</a>` : ''}</td></tr>`
        )
        .join('');
    const cur = g.current_category || {};
    const sug = !full
        ? ''
        : `<div class="cat"><strong>Подходящие категории (есть склейка):</strong>${
              (g.suggested_categories || []).length
                  ? `<ul class="sug">${g.suggested_categories
                        .map(
                            (c) =>
                                `<li><strong>${esc(c.path)}</strong> <span class="muted">(category_id=${esc(c.description_category_id)}, type_id=${esc(c.type_id)}; переключение: ${esc(c.aspects.join('; '))})</span></li>`
                        )
                        .join('')}</ul>`
                  : '<div class="muted">Подходящих категорий автоматически не нашлось — подберите вручную.</div>'
          }</div>`;
    const badge =
        g.state === 'answered'
            ? '<span class="badge b-answer">Есть ответ — прочитайте историю</span>'
            : g.state === 'needs_info'
              ? '<span class="badge b-wait">Ждёт ответа сотрудника</span>'
              : g.state === 'ticket'
                ? `<span class="badge b-ticket">Тикет Ozon № ${esc(g.ticket)}</span>`
                : g.state === 'skipped'
                  ? '<span class="badge b-skip">Пропущено</span>'
                  : '';
    const buttons = cardButtons(g.state).join('\n').replace(/\{SIG\}/g, sig);
    return `<div class="card task" data-signature="${sig}">
<h2>${esc(g.title)} ${badge}</h2>
<div class="muted">Группа <code>${sig}</code> · главный товар <code>${esc(g.main_offer_id)}</code> · отказ Ozon ${esc(g.failed_at)}</div>
<div class="cat"><strong>Текущая категория:</strong> ${esc(cur.path || '—')} <span class="muted">(category_id=${esc(cur.description_category_id || '')}, type_id=${esc(cur.type_id || '')})</span>${g.items_same_category ? '' : ' <span class="err">— у товаров группы разные категории</span>'}</div>
${sug}
<table><thead><tr><th>Код</th><th>Название</th><th>product_id</th><th>SKU / витрина</th></tr></thead><tbody>${items}</tbody></table>
<div><strong>История</strong></div>
<div class="thread" id="thread-${sig}">${threadHtml(g.thread)}</div>
<label for="comment-${sig}"><strong>Новый комментарий или вопрос</strong></label>
<textarea id="comment-${sig}" name="comment-${sig}" maxlength="1000" placeholder="Что сделано: «сменил Ректальная насадка → Катетер медицинский у всех 4 карточек». Для вопроса, тикета или смены статуса — что произошло"></textarea>
<div class="row-ctl"><input type="text" class="author" id="author-${sig}" name="author-${sig}" maxlength="100" placeholder="Кто (например, Hermes)">
<input type="text" class="ticket-in" id="ticket-${sig}" name="ticket-${sig}" maxlength="100" placeholder="№ обращения в Ozon" value="${esc(g.ticket || '')}">
<button type="button" class="act-btn" data-action="comment" data-signature="${sig}">Сохранить комментарий</button>
<button type="button" class="act-btn btn-amber" data-action="clarify" data-signature="${sig}">Требуется уточнение</button>
<span class="msg" id="msg-${sig}"></span></div>
<div class="check" id="note-${sig}"${g.check_note ? '' : ' style="display:none"'}>${g.check_note ? `<strong>Последняя проверка ${esc(g.checked_at)}:</strong> ${esc(g.check_note)}` : ''}</div>
<div class="row-ctl">
${buttons}
<span class="msg" id="cmsg-${sig}"></span></div>
</div>`;
}

const TABS = [
    ['work', 'В работе'],
    ['waiting', 'Ждут уточнения'],
    ['tickets', 'Тикеты Ozon'],
    ['skipped', 'Пропущенные'],
];

function tasksPage(data) {
    const rows = data.rows || [];
    const lists = {
        work: rows,
        waiting: data.waiting_answer || [],
        tickets: data.tickets || [],
        skipped: data.skipped || [],
    };
    const q = data.queue || {};
    const totals = { work: rows.length, waiting: q.needs_info || 0, tickets: q.ticket || 0, skipped: q.skipped || 0 };
    const rf = data.refill || {};
    const refillText = rf.running
        ? 'Сейчас ищем новые группы в предложениях склейки — обновите страницу через минуту.'
        : rf.last_at
          ? `Последний поиск новых групп: ${rf.last_at}` +
            (rf.last_result ? `, добавлено ${rf.last_result.added} из ${rf.last_result.scanned} проверенных.` : '') +
            (rf.last_error ? ` Ошибка: ${rf.last_error}` : '')
          : 'Очередь пополняется автоматически, когда в пачке меньше 10 задач.';
    const intro = {
        work: '',
        waiting: 'Вопрос отправлен сотруднику. Когда он ответит, группа вернётся во вкладку «В работе» первой, с пометкой «Есть ответ».',
        tickets: 'Обращения в поддержку Ozon. Когда поддержка ответит: сменили категорию — «Готово — проверить в Ozon»; можно доделать самим — «Вернуть в работу»; склеить нельзя — «Не объединять (окончательно)».',
        skipped: 'Группы, по которым не получилось сменить категорию. Можно доработать: «Вернуть в работу», завести тикет в Ozon или закрыть «Не объединять (окончательно)».',
    };
    const empty = {
        work: 'Задач нет. Очередь пополняется автоматически из новых предложений склейки — загляните позже.',
        waiting: 'Групп, ждущих уточнения, нет.',
        tickets: 'Открытых тикетов нет.',
        skipped: 'Пропущенных групп нет.',
    };
    const tabsHtml = TABS.map(
        ([key, label], i) =>
            `<button type="button" class="tab${i ? '' : ' active'}" id="tab-${key}" data-tab="${key}" role="tab">${label} (${esc(totals[key])})</button>`
    ).join('\n');
    const panes = TABS.map(([key], i) => {
        const list = lists[key];
        const more = totals[key] > list.length && key !== 'work' ? ` Показаны первые ${list.length}.` : '';
        return `<div class="tab-pane" id="pane-${key}"${i ? ' style="display:none"' : ''}>
${intro[key] || more ? `<div class="muted">${esc(intro[key])}${more}</div>` : ''}
${list.map((g) => taskCard(g, { full: key === 'work' })).join('') || `<div class="card">${esc(empty[key])}</div>`}
</div>`;
    }).join('\n');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Задачи на смену категории Ozon</title><style>${PAGE_CSS}</style></head>
<body><div class="wrap">
<h1>Задачи на смену категории Ozon</h1>
<div class="muted">Группы, которые Ozon не может склеить: в текущей категории нет атрибута склейки 9048 и вариативных характеристик. JSON: добавьте к ссылке <code>&amp;format=json</code>.</div>
<ol class="how muted">
<li>Смените категорию у всех карточек группы в кабинете Ozon.</li>
<li>Сохраните комментарий: с какой категории на какую сменили. Комментарии не затираются — копятся в «Истории».</li>
<li>Нажмите «Готово — проверить в Ozon». Datagon сам посмотрит категорию в Ozon: если склейка в ней есть, задача закрыта и вместо неё придёт следующая.</li>
<li>Непонятно — вопрос в поле комментария и «Требуется уточнение»: задача уйдёт сотруднику, ответ вернётся в «Историю».</li>
<li>Нужна поддержка Ozon — заведите обращение, впишите его номер в поле «№ обращения в Ozon», комментарий и «Создал тикет в Ozon». Задача во вкладке «Тикеты Ozon».</li>
<li>Сменить нельзя пока — комментарий «почему» и «Не получилось — пропустить». Склеить нельзя совсем (подтвердила поддержка) — «Не объединять (окончательно)»: группа уйдёт в скрытые.</li>
</ol>
<div class="queue">В этой пачке: <strong id="tasks-total">${rows.length}</strong>${q.answered ? ` (с ответом: <strong>${esc(q.answered)}</strong>)` : ''} · ждут в очереди: <strong>${esc(q.waiting || 0)}</strong> · ждут ответа сотрудника: <strong>${esc(q.needs_info || 0)}</strong> · тикеты Ozon: <strong>${esc(q.ticket || 0)}</strong> · проверено и закрыто: <strong>${esc(q.done || 0)}</strong> · пропущено: <strong>${esc(q.skipped || 0)}</strong> · не объединять: <strong>${esc(q.rejected || 0)}</strong>
<br><span class="muted">${esc(refillText)}</span>
<div style="margin-top:6px"><button type="button" id="reload-btn" onclick="location.reload()">Загрузить следующую пачку</button></div></div>
<div class="tabs" role="tablist">
${tabsHtml}
</div>
${panes}
</div>
<script>
var TAB_KEYS=${JSON.stringify(TABS.map((t) => t[0]))};
function showTab(name){
  if(TAB_KEYS.indexOf(name)<0)name='work';
  TAB_KEYS.forEach(function(t){
    document.getElementById('pane-'+t).style.display=t===name?'':'none';
    document.getElementById('tab-'+t).classList.toggle('active',t===name);
  });
  if(history.replaceState)history.replaceState(null,'',location.pathname+location.search+(name==='work'?'':'#'+name));
}
document.querySelectorAll('.tab').forEach(function(b){b.addEventListener('click',function(){showTab(b.getAttribute('data-tab'));});});
if(location.hash)showTab(location.hash.slice(1));
var LBL=${JSON.stringify(THREAD_LABELS)};
function renderThread(sig,thread){
  var box=document.getElementById('thread-'+sig);box.textContent='';
  (thread||[]).forEach(function(m){
    var d=document.createElement('div');d.className='msg-item '+(m.role==='human'?'human':m.kind==='question'?'question':m.kind==='ticket'?'ticket':'bot');
    var h=document.createElement('div');h.className='msg-head';var s=document.createElement('strong');s.textContent=m.author||'';h.appendChild(s);
    h.appendChild(document.createTextNode(' · '+(LBL[m.role+':'+m.kind]||m.kind)+' · '+m.at));
    var b=document.createElement('div');b.className='msg-body';b.textContent=m.body;d.appendChild(h);d.appendChild(b);box.appendChild(d);
  });
}
var savedAuthor='';try{savedAuthor=localStorage.getItem('oct_author')||'';}catch(_){}
document.querySelectorAll('.author').forEach(function(i){if(savedAuthor)i.value=savedAuthor;i.addEventListener('change',function(){try{localStorage.setItem('oct_author',i.value);}catch(_){}});});
function post(kind,body){
  return fetch('/public/ozon-category-tasks/'+kind+location.search,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});});
}
function lock(sig,on){document.querySelectorAll('button[data-signature="'+sig+'"]').forEach(function(b){b.disabled=on;});}
function closeCard(sig){document.querySelector('.task[data-signature="'+sig+'"]').classList.add('done');}
var BUSY={comment:'Сохраняем…',clarify:'Отправляем вопрос…',check:'Проверяем в Ozon…',skip:'Пропускаем…',ticket:'Сохраняем тикет…',reopen:'Возвращаем в работу…',reject:'Закрываем…'};
var DONE={clarify:'Вопрос отправлен — группа во вкладке «Ждут уточнения» после обновления страницы',skip:'Пропущено — группа во вкладке «Пропущенные»',ticket:'Тикет сохранён — группа во вкладке «Тикеты Ozon»',reopen:'Возвращено в работу — группа появится во вкладке «В работе»',reject:'Закрыто: группа в «Не объединять (скрытые)»'};
var rejectArmed={};
function octAction(kind,btn){
  var sig=btn.getAttribute('data-signature');
  if(kind==='reject'&&!rejectArmed[sig]){
    rejectArmed[sig]=btn.textContent;btn.textContent='Точно не объединять? Нажмите ещё раз';
    setTimeout(function(){if(rejectArmed[sig]){btn.textContent=rejectArmed[sig];delete rejectArmed[sig];}},6000);
    return;
  }
  if(kind==='reject'){btn.textContent=rejectArmed[sig];delete rejectArmed[sig];}
  var ta=document.getElementById('comment-'+sig),au=document.getElementById('author-'+sig),tk=document.getElementById('ticket-'+sig);
  var msg=document.getElementById(kind==='comment'||kind==='clarify'?'msg-'+sig:'cmsg-'+sig),note=document.getElementById('note-'+sig);
  var body={signature:sig,author:au.value};
  if(kind==='clarify')body.question=ta.value;else if(kind!=='check'&&kind!=='skip')body.comment=ta.value;
  if(kind==='ticket')body.ticket=tk.value;
  msg.className='msg';msg.textContent=BUSY[kind];
  lock(sig,true);
  post(kind,body).then(function(p){
    if(!p.ok||!p.j.success){lock(sig,false);msg.className='msg err';msg.textContent=(p.j&&p.j.error)||'Ошибка';return;}
    if(p.j.thread)renderThread(sig,p.j.thread);
    if(kind==='comment'){lock(sig,false);msg.className='msg ok';msg.textContent='Сохранено';ta.value='';return;}
    if(DONE[kind]){msg.className='msg ok';msg.textContent=DONE[kind];ta.value='';closeCard(sig);return;}
    if(p.j.note){note.style.display='';note.textContent=p.j.note;note.className='check'+(p.j.verified?' ok':'');}
    msg.className='msg '+(p.j.verified?'ok':'err');
    msg.textContent=p.j.verified?'Проверено — задача закрыта':'Не подтверждено — см. причину выше';
    if(p.j.verified)closeCard(sig);else lock(sig,false);
  }).catch(function(err){lock(sig,false);msg.className='msg err';msg.textContent=String(err);});
}
document.querySelectorAll('.act-btn').forEach(function(b){b.addEventListener('click',function(){octAction(b.getAttribute('data-action'),b);});});
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
    router.post('/clarify', async (req, res) => {
        setNoStore(res);
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const access = await tasks.checkAccess(db, req, { pin: body.pin });
            if (!access.ok) {
                return res.status(access.status).json({ success: false, error: access.error, code: access.code });
            }
            return res.json(
                await tasks.requestClarification(db, {
                    signature: body.signature,
                    question: body.question != null ? body.question : body.comment,
                    author: body.author,
                })
            );
        } catch (e) {
            return sendTaskError(res, e, 'CLARIFY_FAILED');
        }
    });
    for (const action of ['ticket', 'reopen', 'reject']) {
        router.post(`/${action}`, async (req, res) => {
            setNoStore(res);
            try {
                const body = req.body && typeof req.body === 'object' ? req.body : {};
                const access = await tasks.checkAccess(db, req, { pin: body.pin });
                if (!access.ok) {
                    return res.status(access.status).json({ success: false, error: access.error, code: access.code });
                }
                return res.json(
                    await tasks.changeTaskStatus(db, {
                        action,
                        signature: body.signature,
                        comment: body.comment,
                        ticket: body.ticket,
                        author: body.author,
                    })
                );
            } catch (e) {
                return sendTaskError(res, e, `${action.toUpperCase()}_FAILED`);
            }
        });
    }
    router.post('/check', taskAction(tasks.verifyCategoryTask, 'CHECK_FAILED'));
    router.post('/skip', taskAction(tasks.skipCategoryTask, 'SKIP_FAILED'));

    return router;
}

function sendTaskError(res, e, fallbackCode) {
    const code = e && e.code ? e.code : fallbackCode;
    const status =
        code === 'TASK_NOT_FOUND'
            ? 404
            : code === 'TASK_CLOSED' || code === 'BAD_STATE'
              ? 409
              : /REQUIRED|TOO_LONG|NO_OZON_CREDS|BAD_ACTION/.test(code)
                ? 400
                : 500;
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

    router.post('/answer', async (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const actor = req.datagonActor || {};
            return res.json(
                await tasks.answerClarification(db, {
                    signature: body.signature,
                    answer: body.answer,
                    author: actor.full_name || actor.username || 'сотрудник',
                    userId: actor.id || actor.user_id || null,
                })
            );
        } catch (e) {
            return sendTaskError(res, e, 'ANSWER_FAILED');
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
