// ===== КАЛЕНДАРЬ «ТЕНДЕРЫ» + УТРЕННЕЕ ПИСЬМО + TELEGRAM (v11) =====
// Читает лист «6. Сроки». В таблице ничего не меняет
// (кроме одного раза: если у таблицы не задан часовой пояс — ставит Алматы).
//   • календарь «Тендеры» обновляется каждый час;
//   • письмо приходит по рабочим дням около 08:45.
// v3: ключ события по акту больше не зависит от номера строки —
//     лист «Акты» можно сортировать, календарь не сломается.
// v4: добавлены блоки S9 «Подписание договора» и S10 «Проект договора от заказчика»;
//     S8 «Договор бухгалтеру» получил значок и напоминание (раньше шёл без них);
//     лист «Сроки» читается целиком (getMaxRows), иначе хвостовые блоки терялись.
// v5: добавлены блоки S11 «Торги на понижение» (с напоминанием) и S12 «Протокол допуска» (ждём заказчика).
// v6: добавлены блоки S13 «Действие по договору» и S14 «Действие по акту» —
//     произвольные задачи из колонок «Надо сделать / Сделать до» в Договорах (Y, Z) и Актах (O, P).
//     Оба — твои действия, идут с напоминанием.
// v7: «Обратить внимание» в письме — флаги всех трёх блоков дашборда (закупки, договоры, акты)
//     и состояние синхронизации с порталом ГЗ (ошибка, давно не обновлялась, «не разнесено»).
// v8: раздел «Просрочено» (до 15 строк, самые старые сверху), в теме — число просроченных.
// v10: в «Обратить внимание» — закупки, по которым итоги вышли, а статус всё ещё «Подана/Допущена».
// v11 (18.11.2026):
//   • календарь: акты (S4 утверждение, S5 оплата) больше не попадают; старые события по актам удаляются;
//   • письмо: сверху только МОИ действия (подать заявку, подписать договор, внести обеспечение, свои задачи;
//     «проект договора не пришёл» — когда срок уже прошёл). Ожидание от заказчиков — одной строкой внизу.
//     Флаги по актам из «Обратить внимание» убраны;
//   • Telegram: утром — список моих действий; в течение дня — пуш за 24 ч, за 3 ч и за 1 ч до срока со временем
//     (подача заявки и т.п.), проверка каждые 15 минут. Настройка — tgNastroit, затем один раз tgVklyuchit.

const KAL_NAZVANIE = 'Тендеры';
const LIST_SROKI = '6. Сроки';
const LIST_AKTY = '4. Акты и оплата';
const LIST_NASTR = '5. Настройки';
const LIST_DASH = '1. Дашборд';
const STROKA_1 = 5;
const PISMO_DNEY = 2;     // письмо: сегодня + столько рабочих дней
const ZAPAS_STROK = 30;   // предупредить, если свободных строк меньше
const PROSR_MAX = 15;     // v8: сколько просроченных сроков показывать в письме

const NASHI = { S1: '📤', S2: '📌', S3: '🛡', S6: '↩️', S7: '↩️', S8: '📂', S9: '🖊', S11: '🔻',
                S13: '📣', S14: '📣' };                                                           // делаешь ты — с напоминанием
const ZHDEM = { S4: '📝', S5: '💰', S10: '📨', S12: '📑' };                                        // ждём от заказчика — без напоминания
const NE_V_KALENDAR = ['S4', 'S5'];                                                                 // v11: акты — не в календарь
const SROK_METKA = { S1: 'Подать до', S2: 'Сделать до', S3: 'Внести до', S4: 'Утвердить до',
                     S5: 'Оплата до', S6: 'Вернуть до', S7: 'Вернуть до', S8: 'Отправить до',
                     S9: 'Подписать до', S10: 'Проект ждём до',
                     S11: 'Торги', S12: 'Протокол ждём до',
                     S13: 'Сделать до', S14: 'Сделать до' };
const DN = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// v11: моё действие = из NASHI, или «проекта договора нет» (S10), когда срок уже прошёл — тогда запросить
function moe_(s) { return !!NASHI[s.kod] || (s.kod === 'S10' && s.cherez < 0); }

function nastroit() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['sinhronKalendar', 'utrenneePismo'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sinhronKalendar').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('utrenneePismo').timeBased().everyDays(1).atHour(8).nearMinute(45).create();
  sinhronKalendar();
  utrenneePismo(true);
  Logger.log('Готово. Календарь «' + KAL_NAZVANIE + '» заполнен, тестовое письмо отправлено.');
  Logger.log('Часовой пояс скрипта: ' + Session.getScriptTimeZone());
  SpreadsheetApp.getActive().toast('Календарь заполнен, тестовое письмо отправлено', 'Тендеры', 10);
}

// ---------- КАЛЕНДАРЬ ----------
function sinhronKalendar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) return;
  let d;
  try {
    d = prochitatSroki_();
    const kal = kalendar_(d.tz);
    const url = d.ss.getUrl();
    const est = {};
    let udaleno = 0;
    kal.getEvents(new Date(Date.now() - 400 * 864e5), new Date(Date.now() + 800 * 864e5)).forEach(ev => {
      const k = ev.getTag('srok');
      if (!k) return;                       // свои события в этом календаре не трогаем
      // v11: события по актам (S4, S5) — удаляем, акты в календарь больше не идут
      // (сюда же попадают старые ключи актов по номеру строки, до v3)
      if (/^S[45]\|/.test(k)) { ev.deleteEvent(); udaleno++; return; }
      if (est[k]) ev.deleteEvent(); else est[k] = ev;
    });
    if (udaleno) Logger.log('Удалено событий по актам: ' + udaleno);

    const nado = {};
    d.sroki.filter(s => NE_V_KALENDAR.indexOf(s.kod) < 0).forEach(s => {
      nado[s.klyuch] = true;
      const title = nazvanie_(s);
      const color = cvet_(s.cherez);
      const desc = opisanie_(s, url);
      const napomnit = !!NASHI[s.kod] && s.cherez >= 0;
      const h = hesh_([title, s.den, s.vremya, color, desc, napomnit].join('¦'));
      let ev = est[s.klyuch];
      if (ev && ev.getTag('h') === h) return;              // ничего не поменялось
      if (ev && ev.isAllDayEvent() === !!s.vremya) { ev.deleteEvent(); ev = null; }
      if (!ev) {
        ev = s.vremya
          ? kal.createEvent(title, new Date(s.data.getTime() - 3600e3), s.data, { description: desc })
          : kal.createAllDayEvent(title, polden_(s.den, d.tz), { description: desc });
        ev.setTag('srok', s.klyuch);
      } else {
        ev.setTitle(title);
        ev.setDescription(desc);
        if (s.vremya) ev.setTime(new Date(s.data.getTime() - 3600e3), s.data);
        else ev.setAllDayDate(polden_(s.den, d.tz));
      }
      ev.setColor(color);
      ev.removeAllReminders();
      if (napomnit) {
        if (s.vremya) { ev.addPopupReminder(24 * 60); ev.addPopupReminder(120); ev.addPopupReminder(60); }
        else ev.addPopupReminder(15 * 60);                 // накануне в 09:00
      }
      ev.setTag('st', 'open');
      ev.setTag('h', h);
    });

    // Срок закрыт в таблице — событие остаётся, но зелёным
    Object.keys(est).forEach(k => {
      if (nado[k]) return;
      const ev = est[k];
      if (ev.getTag('st') === 'done') return;
      const t = ev.getTitle();
      ev.setTitle(t.indexOf('✅') === 0 ? t : '✅ ' + t);
      ev.setColor(CalendarApp.EventColor.GREEN);
      ev.removeAllReminders();
      ev.setTag('st', 'done');
      ev.setTag('h', 'x');
    });
  } finally {
    lock.releaseLock();
  }
}

function cvet_(cherez) {
  if (cherez <= 3) return CalendarApp.EventColor.RED;
  if (cherez <= 7) return CalendarApp.EventColor.YELLOW;
  return CalendarApp.EventColor.GRAY;
}

function nazvanie_(s) {
  const ikon = NASHI[s.kod] || ZHDEM[s.kod] || '•';
  const kto = s.postavshik + (s.zakazchik ? ' → ' + korotko_(s.zakazchik, 24) : '');
  return [ikon + ' ' + s.chto, kto, kratkoSumma_(s.summa)].filter(Boolean).join(' · ') +
    (s.vremya ? ' (до ' + s.vremya + ')' : '');
}

function opisanie_(s, url) {
  return [
    s.chto,
    (SROK_METKA[s.kod] || 'Срок') + ': ' + dm_(s.den) + '.' + s.den.slice(0, 4) + (s.vremya ? ' ' + s.vremya : ''),
    'Поставщик: ' + s.postavshik,
    'Заказчик: ' + s.zakazchik,
    nomerS_(s),
    'Сумма: ' + polnayaSumma_(s.summa) + ' ₸',
    '',
    'Таблица: ' + url
  ].join('\n');
}

function kalendar_(tz) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('KAL_ID');
  let kal = id ? CalendarApp.getCalendarById(id) : null;
  if (!kal) {
    try {
      kal = CalendarApp.createCalendar(KAL_NAZVANIE, {
        timeZone: tz, summary: 'Сроки по госзакупкам из планера. Заполняется автоматически.'
      });
    } catch (e) {
      kal = CalendarApp.createCalendar(KAL_NAZVANIE);
    }
    props.setProperty('KAL_ID', kal.getId());
  }
  return kal;
}

// ---------- ПИСЬМО ----------
function utrenneePismo(prinuditelno) {
  const d = prochitatSroki_();
  const prazd = prazdniki_(d.ss, d.tz);
  const rabochiy = s => { const w = denNedeli_(s); return w !== 0 && w !== 6 && !prazd[s]; };
  if (prinuditelno !== true && !rabochiy(d.segodnya)) return;

  let konec = d.segodnya, n = 0;
  while (n < PISMO_DNEY) { konec = sdvig_(konec, 1); if (rabochiy(konec)) n++; }
  const moi = d.sroki.filter(moe_);                         // v11: в письме сверху — только мои действия
  const zhdem = d.sroki.filter(s => !moe_(s));
  const okno = moi
    .filter(s => s.cherez >= 0 && s.den <= konec)          // без просрочки
    .sort((a, b) => (a.den + a.vremya).localeCompare(b.den + b.vremya));

  let html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">';
  let txt = '';
  if (!okno.length) { html += '<p>Горящих сроков нет.</p>'; txt += 'Горящих сроков нет.\n'; }
  okno.forEach(s => {
    const krasn = s.cherez <= 3;
    const metka = krasn ? '🔴' : '🟡';
    const kogda = (SROK_METKA[s.kod] || 'Срок') + ': ' + DN[denNedeli_(s.den)] + ' ' + dm_(s.den) +
      (s.vremya ? ' ' + s.vremya : '') + ' — ' + kogda_(s.cherez);
    const stroki = [
      'Поставщик: ' + s.postavshik,
      'Заказчик: ' + s.zakazchik,
      nomerS_(s),
      'Сумма: ' + polnayaSumma_(s.summa) + ' ₸'
    ];
    html += '<div style="margin:0 0 14px;padding:8px 12px;border-left:4px solid ' +
      (krasn ? '#d93025' : '#f2b600') + ';background:#f8f8f8">' +
      '<div style="font-weight:bold;font-size:15px">' + metka + ' ' + ekran_(s.chto) + '</div>' +
      '<div style="margin:3px 0 6px;font-weight:bold">' + ekran_(kogda) + '</div>' +
      stroki.map(x => '<div style="color:#444">' + ekran_(x) + '</div>').join('') +
      '</div>';
    txt += metka + ' ' + s.chto + '\n' + kogda + '\n' + stroki.join('\n') + '\n\n';
  });

  // v8: просроченные сроки — компактным списком, самые старые сверху (v11: только мои)
  const prosr = moi.filter(s => s.cherez < 0)
    .sort((a, b) => (a.den + a.vremya).localeCompare(b.den + b.vremya));
  if (prosr.length) {
    const pokaz = prosr.slice(0, PROSR_MAX);
    html += '<h3 style="margin:18px 0 6px;color:#b3261e">Просрочено: ' + prosr.length + '</h3>';
    txt += 'Просрочено: ' + prosr.length + '\n';
    pokaz.forEach(s => {
      const s1 = s.chto + ' — ' + prosrocheno_(-s.cherez) + ' (' + (SROK_METKA[s.kod] || 'Срок').toLowerCase() + ' ' + dm_(s.den) + ')';
      const s2 = [s.postavshik + (s.zakazchik ? ' → ' + s.zakazchik : ''), nomerS_(s),
                  typeof s.summa === 'number' ? polnayaSumma_(s.summa) + ' ₸' : ''].filter(Boolean).join(' · ');
      html += '<div style="margin:0 0 8px;padding:4px 10px;border-left:3px solid #d93025">' +
        '<div style="font-weight:bold">' + ekran_(s1) + '</div>' +
        '<div style="color:#555;font-size:13px">' + ekran_(s2) + '</div></div>';
      txt += '• ' + s1 + '\n  ' + s2 + '\n';
    });
    if (prosr.length > pokaz.length) {
      html += '<p style="color:#666;margin:4px 0 0">и ещё ' + (prosr.length - pokaz.length) + ' — в таблице, «Мои действия» на дашборде</p>';
      txt += 'и ещё ' + (prosr.length - pokaz.length) + ' — в таблице\n';
    }
    txt += '\n';
  }

  const flagi = flagi_(d.ss);
  if (flagi.length) {
    html += '<h3 style="margin:18px 0 6px">Обратить внимание</h3><ul style="padding-left:18px;margin:0">' +
      flagi.map(f => '<li>' + ekran_(f) + '</li>').join('') + '</ul>';
    txt += 'Обратить внимание\n' + flagi.map(f => '• ' + f).join('\n') + '\n';
  }

  // v11: ожидание от заказчиков — одной строкой внизу
  const zh = zhdemSvodka_(zhdem);
  if (zh) {
    html += '<p style="margin-top:18px;color:#777;font-size:13px">' + ekran_(zh) + '</p>';
    txt += '\n' + zh + '\n';
  }
  html += '<p style="margin-top:20px;color:#666">Все сроки — в календаре «' + KAL_NAZVANIE +
    '». <a href="' + d.ss.getUrl() + '">Открыть таблицу</a></p></div>';

  let tema;
  if (!okno.length) {
    tema = 'Тендеры: до ' + DN[denNedeli_(konec)] + ' ' + dm_(konec) + ' сроков нет';
  } else {
    const p = okno[0];
    tema = 'Тендеры, ' + kogda_(p.cherez) + ': ' + p.chto.toLowerCase() + ' · ' + p.postavshik +
      (kratkoSumma_(p.summa) ? ' · ' + kratkoSumma_(p.summa) : '') +
      (okno.length > 1 ? ' (+ ещё ' + (okno.length - 1) + ' до ' + DN[denNedeli_(konec)] + ' ' + dm_(konec) + ')' : '');
  }
  if (prosr.length) tema += ' · просрочено: ' + prosr.length;   // v8
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: tema, htmlBody: html, body: txt, name: 'Планер по тендерам'
  });
  try { tgUtro_(d, okno, prosr); } catch (e) { Logger.log('Telegram: ' + e); }   // v11
}

// v11: «Ждём от заказчиков: актов на утверждении 3 (просрочено 3), на оплате 11 (просрочено 4), …»
function zhdemSvodka_(zhdem) {
  const gr = [['S4', 'актов на утверждении'], ['S5', 'актов на оплате'], ['S10', 'проектов договора'], ['S12', 'протоколов допуска']];
  const chasti = [];
  gr.forEach(([kod, nazv]) => {
    const x = zhdem.filter(s => s.kod === kod);
    if (!x.length) return;
    const pr = x.filter(s => s.cherez < 0).length;
    chasti.push(nazv + ' ' + x.length + (pr ? ' (просрочено ' + pr + ')' : ''));
  });
  return chasti.length ? 'Ждём от заказчиков: ' + chasti.join(', ') + ' — подробно внизу дашборда.' : '';
}

function flagi_(ss) {
  const res = [];
  // v10: итоги опубликованы, а статус всё ещё «Подана/Допущена» — исход скрипт не знает, проверь протокол
  const zak = ss.getSheetByName('2. Закупки');
  if (zak && zak.getLastRow() >= STROKA_1) {
    const seichas = Date.now(), spisok = [];
    zak.getRange(STROKA_1, 1, zak.getLastRow() - STROKA_1 + 1, 14).getValues().forEach(r => {
      if (['Подана', 'Допущена'].indexOf(String(r[9]).trim()) < 0) return;
      let it = r[13];
      if (!(it instanceof Date)) {
        const m = String(it).match(/^(\d{2})\.(\d{2})\.(\d{4})/);
        it = m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
      }
      if (it && it.getTime() <= seichas) spisok.push(String(r[3]).trim() + ' (' + String(r[0]).trim() + ')');
    });
    if (spisok.length) res.push('Итоги вышли, а статус «Подана» — проверь протокол: ' + spisok.join(', '));
  }
  const dash = ss.getSheetByName(LIST_DASH);
  if (dash) {
    // v7: блоки дашборда — [колонка подписи, колонка числа, начало подписи, как назвать в письме]
    // v11: флаги по утверждению и оплате актов убраны (это ожидание от заказчиков, см. строку внизу письма)
    const ishchem = [
      [1, 2, 'Победа, а договора', 'Победа, а договора на листе «Договоры» нет'],
      [1, 2, 'Статус заявки не обновл', 'Статус заявки не обновлён'],
      [3, 6, 'Договор исполнен по актам', 'Договор исполнен по актам, а статус не «Исполнен»'],
      [3, 6, 'Обеспечение исполнения не внесено', 'Обеспечение исполнения не внесено, срок прошёл'],
      [7, 10, 'Обеспечений пора вернуть', 'Обеспечения пора вернуть']
    ];
    const v = dash.getRange(1, 1, 30, 10).getDisplayValues();
    ishchem.forEach(([kP, kZ, nachalo, podpis]) => {
      v.forEach(r => {
        if (String(r[kP - 1]).trim().indexOf(nachalo) === 0 && Number(String(r[kZ - 1]).replace(/\s/g, '')) > 0)
          res.push(podpis + ': ' + r[kZ - 1]);
      });
    });
  }
  sinhronGZ_(ss).forEach(x => res.push(x));
  // запас строк: [лист, колонка с номером, колонка с формулой до конца диапазона]
  [['2. Закупки', 4, 18], ['3. Договоры', 1, 21], ['4. Акты и оплата', 1, 14]].forEach(([nm, kCol, fCol]) => {
    const sh = ss.getSheetByName(nm);
    if (!sh) return;
    const lr = sh.getLastRow();
    if (lr < STROKA_1) return;
    const kl = sh.getRange(STROKA_1, kCol, lr - STROKA_1 + 1, 1).getValues();
    const fo = sh.getRange(STROKA_1, fCol, lr - STROKA_1 + 1, 1).getFormulas();
    let posledData = 0, posledF = 0;
    for (let i = 0; i < kl.length; i++) {
      if (kl[i][0] !== '') posledData = STROKA_1 + i;
      if (fo[i][0]) posledF = STROKA_1 + i;
    }
    if (posledData > posledF)
      res.push(nm + ': есть записи ниже строки ' + posledF + ' — они НЕ попадают в сроки и дашборд');
    else if (posledF - posledData < ZAPAS_STROK)
      res.push(nm + ': свободных строк осталось ' + (posledF - posledData) + ' — пора расширять');
  });
  return res;
}

// v7: состояние синхронизации с порталом ГЗ по журналу на листе «Сверка ГЗ» (колонки L:O, новые сверху)
function sinhronGZ_(ss) {
  const res = [];
  const sh = ss.getSheetByName('Сверка ГЗ');
  if (!sh || sh.getLastRow() < 2) return res;
  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  const v = sh.getRange(2, 12, Math.min(sh.getLastRow() - 1, 500), 4).getDisplayValues()
    .filter(r => r[0] && String(r[0]).indexOf('(проба)') < 0);
  const posl = v.filter(r => r[1] === 'Итог обновления' || String(r[1]).indexOf('⚠ Ошибка') === 0)[0];
  if (!posl) return ['Синхронизация ГЗ: в журнале нет ни одного завершённого обновления'];
  const kogda = String(posl[0]).slice(0, 16);
  if (String(posl[1]).indexOf('⚠ Ошибка') === 0) {
    res.push('Синхронизация ГЗ: ошибка ' + kogda + ' — ' + String(posl[3]).slice(0, 200));
    return res;
  }
  let data = null;
  try { data = Utilities.parseDate(kogda, tz, 'dd.MM.yyyy HH:mm'); } catch (e) {}
  if (data && Date.now() - data.getTime() > 20 * 3600e3)
    res.push('Синхронизация ГЗ не обновлялась с ' + kogda + ' — проверьте журнал «Сверка ГЗ»');
  const m = String(posl[3]).match(/не разнесено:\s*(\d+)/);
  if (m && Number(m[1]) > 0)
    res.push('Синхронизация ГЗ: не разнесено записей — ' + m[1] + ' (подробности на листе «Сверка ГЗ»)');
  return res;
}

// ---------- TELEGRAM (v11) ----------
// Настройка (один раз):
//  1. В Telegram откройте @BotFather → /newbot → придумайте имя → он пришлёт токен вида 123456:ABC...
//  2. Apps Script → ⚙ «Настройки проекта» → «Свойства скрипта» → добавить свойство TG_TOKEN = этот токен.
//     (Токен в чат с Claude не присылать.)
//  3. Откройте своего бота в Telegram и отправьте ему любое сообщение, например /start.
//  4. Запустите функцию tgNastroit — она найдёт ваш чат, запомнит его и пришлёт проверочное сообщение.
const TG_ZA_CHASOV = [24, 3, 1];   // пуш по срокам со временем: за 24 ч, за 3 ч и за 1 ч

function tgNastroit() {
  const pr = PropertiesService.getScriptProperties();
  const tok = pr.getProperty('TG_TOKEN');
  if (!tok) throw new Error('Нет свойства скрипта TG_TOKEN — см. шаги 1–2 в комментарии над tgNastroit');
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + tok + '/getUpdates', { muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText());
  if (!j.ok) throw new Error('Telegram ответил ошибкой: ' + r.getContentText().slice(0, 300));
  const s = (j.result || []).map(u => u.message || u.edited_message).filter(Boolean).pop();
  if (!s) throw new Error('Бот ещё не получил ни одного сообщения — напишите ему /start и запустите снова');
  pr.setProperty('TG_CHAT', String(s.chat.id));
  tgOtpravit_('✅ Планер по тендерам подключён. Сюда будут приходить: утром — мои действия, днём — напоминания за 24 ч, за 3 ч и за 1 ч до сроков.');
  Logger.log('Telegram подключён, чат ' + s.chat.id);
}

// v11: включить проверку напоминаний каждые 15 минут (запустить один раз после tgNastroit)
function tgVklyuchit() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'tgChasto') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tgChasto').timeBased().everyMinutes(15).create();
  Logger.log('Напоминания в Telegram: проверка каждые 15 минут включена');
}

function tgChasto() {
  if (!PropertiesService.getScriptProperties().getProperty('TG_CHAT')) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try { tgNapominaniya_(prochitatSroki_()); } finally { lock.releaseLock(); }
}

function tgOtpravit_(tekst) {
  const pr = PropertiesService.getScriptProperties();
  const tok = pr.getProperty('TG_TOKEN'), chat = pr.getProperty('TG_CHAT');
  if (!tok || !chat) return false;                       // Telegram не настроен — молча пропускаем
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + tok + '/sendMessage', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ chat_id: chat, text: tekst, disable_web_page_preview: true })
  });
  if (r.getResponseCode() !== 200) Logger.log('Telegram: ' + r.getContentText().slice(0, 300));
  return r.getResponseCode() === 200;
}

function tgStroka_(s) {
  return (NASHI[s.kod] || ZHDEM[s.kod] || '•') + ' ' + s.chto + ' — ' + s.postavshik +
    (s.zakazchik ? ' → ' + korotko_(s.zakazchik, 30) : '') + ', № ' + s.nomer +
    (kratkoSumma_(s.summa) ? ', ' + kratkoSumma_(s.summa) : '') +
    '\n   ' + (SROK_METKA[s.kod] || 'Срок').toLowerCase() + ' ' + DN[denNedeli_(s.den)] + ' ' + dm_(s.den) +
    (s.vremya ? ' ' + s.vremya : '');
}

// утром, вместе с письмом: мои действия на сегодня + 2 рабочих дня и число просроченных
function tgUtro_(d, okno, prosr) {
  if (!PropertiesService.getScriptProperties().getProperty('TG_CHAT')) return;
  let t = '☀️ Мои действия';
  t += okno.length ? ':\n\n' + okno.map(s => (s.cherez <= 1 ? '🔴 ' : '🟡 ') + kogda_(s.cherez) + '\n' + tgStroka_(s)).join('\n\n')
                   : ': горящих сроков нет.';
  if (prosr.length) t += '\n\n⚠️ Просрочено: ' + prosr.length + '\n' + prosr.slice(0, 5).map(tgStroka_).join('\n');
  tgOtpravit_(t);
}

// каждые 15 минут (tgChasto): пуш за 24 ч, за 3 ч и за 1 ч до сроков, у которых есть время (обычно подача заявки)
function tgNapominaniya_(d) {
  const pr = PropertiesService.getScriptProperties();
  if (!pr.getProperty('TG_CHAT')) return;
  const bylo = JSON.parse(pr.getProperty('TG_BYLO') || '{}'), seichas = Date.now();
  let izm = false;
  d.sroki.filter(s => moe_(s) && s.vremya).forEach(s => {
    const ost = (s.data.getTime() - seichas) / 3600e3;     // часов до срока
    if (ost <= 0) return;
    const blizh = Math.min.apply(null, TG_ZA_CHASOV.filter(h => ost <= h));   // самый близкий подходящий порог
    if (!isFinite(blizh)) return;
    TG_ZA_CHASOV.forEach(h => {
      const k = s.klyuch + '|' + s.den + ' ' + s.vremya + '|' + h;
      if (ost > h || bylo[k]) return;
      if (h !== blizh) { bylo[k] = seichas; izm = true; return; }       // более ранние пороги уже не нужны
      if (tgOtpravit_('⏰ Через ' + (ost < 1 ? Math.round(ost * 60) + ' мин' : Math.round(ost) + ' ч') + ':\n' + tgStroka_(s))) {
        bylo[k] = seichas; izm = true;
      }
    });
  });
  Object.keys(bylo).forEach(k => { if (seichas - bylo[k] > 14 * 864e5) { delete bylo[k]; izm = true; } });
  if (izm) pr.setProperty('TG_BYLO', JSON.stringify(bylo));
}

// ---------- ОБЩЕЕ ----------
function prochitatSroki_() {
  const ss = SpreadsheetApp.getActive();
  const tz = tzTablicy_(ss);
  const sh = ss.getSheetByName(LIST_SROKI);
  const lr = sh.getMaxRows();   // v4: читаем лист целиком, иначе хвостовые блоки теряются
  const v = sh.getRange(STROKA_1, 1, lr - STROKA_1 + 1, 9).getValues();
  const akty = ss.getSheetByName(LIST_AKTY).getDataRange().getValues();
  const segodnya = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const res = [], byl = {};
  v.forEach(r => {
    const dt = r[1];
    if (!(dt instanceof Date)) return;
    const kod = String(r[8]).split('|')[0];
    const nomer = String(r[3]);
    const den = Utilities.formatDate(dt, tz, 'yyyy-MM-dd');
    const vr = Utilities.formatDate(dt, tz, 'HH:mm');
    let klyuch = (kod === 'S4' || kod === 'S5') ? klyuchAkta_(kod, String(r[8]), akty, tz) : kod + '|' + nomer;
    if (byl[klyuch]) { byl[klyuch]++; klyuch += '#' + byl[klyuch]; } else byl[klyuch] = 1;
    res.push({
      klyuch, kod, den, data: dt, vremya: vr === '00:00' ? '' : vr,
      cherez: raznica_(segodnya, den),
      razdel: String(r[0]), postavshik: String(r[2]), nomer,
      zakazchik: String(r[4]), summa: r[5], chto: String(r[6])
    });
  });
  return { ss, tz, segodnya, sroki: res };
}

// Ключ акта: договор + сумма акта + дата (направления — для S4, утверждения — для S5).
// Не зависит от номера строки, поэтому сортировка листа «Акты» календарь не ломает.
function klyuchAkta_(kod, id, akty, tz) {
  const row = Number(String(id).split('|')[2]);
  const r = row ? akty[row - 1] : null;
  if (!r || !r[0]) return id + '|x';
  const d = x => (x instanceof Date ? Utilities.formatDate(x, tz, 'yyyy-MM-dd') : String(x));
  return kod + '|' + r[0] + '|' + r[4] + '|' + (kod === 'S4' ? d(r[5]) : d(r[7]));
}

function tzTablicy_(ss) {
  let tz = ss.getSpreadsheetTimeZone();
  if (tz) return tz;
  tz = Utilities.formatDate(new Date(), 'Asia/Almaty', 'Z') === '+0500' ? 'Asia/Almaty' : 'Etc/GMT-5';
  ss.setSpreadsheetTimeZone(tz);
  SpreadsheetApp.flush();
  Logger.log('У таблицы не был задан часовой пояс — поставил ' + tz);
  return tz;
}

function prazdniki_(ss, tz) {
  const res = {};
  const sh = ss.getSheetByName(LIST_NASTR);
  if (!sh) return res;
  sh.getRange('L5:L60').getValues().forEach(r => {
    if (r[0] instanceof Date) res[Utilities.formatDate(r[0], tz, 'yyyy-MM-dd')] = true;
  });
  return res;
}

function nomerS_(s) {
  return (['S1', 'S2', 'S6', 'S9', 'S10', 'S11', 'S12'].indexOf(s.kod) >= 0 ? 'Закупка № ' : 'Договор № ') + s.nomer;
}
function kogda_(n) {
  if (n === 0) return 'сегодня';
  if (n === 1) return 'завтра';
  const a = n % 10, b = n % 100;
  const sl = (a === 1 && b !== 11) ? 'день' : (a >= 2 && a <= 4 && (b < 12 || b > 14)) ? 'дня' : 'дней';
  return 'через ' + n + ' ' + sl;
}
function prosrocheno_(n) {
  const a = n % 10, b = n % 100;
  const sl = (a === 1 && b !== 11) ? 'день' : (a >= 2 && a <= 4 && (b < 12 || b > 14)) ? 'дня' : 'дней';
  return 'просрочено на ' + n + ' ' + sl;
}
function raznica_(a, b) {
  const p = s => { const x = s.split('-').map(Number); return Date.UTC(x[0], x[1] - 1, x[2]); };
  return Math.round((p(b) - p(a)) / 864e5);
}
function sdvig_(den, k) {
  const x = den.split('-').map(Number);
  const t = new Date(Date.UTC(x[0], x[1] - 1, x[2] + k));
  return t.getUTCFullYear() + '-' + ('0' + (t.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + t.getUTCDate()).slice(-2);
}
function denNedeli_(den) {
  const x = den.split('-').map(Number);
  return new Date(Date.UTC(x[0], x[1] - 1, x[2])).getUTCDay();
}
function polden_(den, tz) { return Utilities.parseDate(den + ' 12:00', tz, 'yyyy-MM-dd HH:mm'); }
function dm_(den) { return den.slice(8, 10) + '.' + den.slice(5, 7); }
function korotko_(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function kratkoSumma_(x) {
  if (typeof x !== 'number' || !x) return '';
  if (x >= 1e6) return (x / 1e6).toFixed(2).replace('.', ',') + ' млн';
  if (x >= 1e3) return Math.round(x / 1e3) + ' тыс';
  return String(Math.round(x));
}
function polnayaSumma_(x) {
  if (typeof x !== 'number') return '—';
  return String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function ekran_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function hesh_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
}
