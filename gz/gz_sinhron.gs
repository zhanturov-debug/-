/**
 * gz_sinhron.gs — договоры, акты и оплаты с портала ГЗ (GraphQL v3) в листы планера.
 * Только ГЗ. СК не трогает. «Сроки», дашборд, календарь — не трогает (считаются формулами).
 *
 * gzsProverka()       — приёмка: прогон БЕЗ записи, список «было → стало» на лист «Сверка ГЗ» (колонки L:S)
 * gzsVklyuchitZapis() — после приёмки, один раз: включает запись и расписание ~7:00 и ~17:00
 * gzsObnovit()        — кнопка меню «Обновить из портала ГЗ»
 * gzsPoRaspisaniyu()  — вызывается расписанием
 * gzsProdolzhit()     — продолжение после лимита 5 минут (одноразовый триггер, удаляет себя сам)
 * gzsStop()           — аварийно: снять продолжение и сбросить состояние
 * gzsTestItogi()      — проба одного этапа «Итоги» без записи (07.11.2026)
 *
 * 07.11.2026: этап «Итоги» ставит исход и без договора — «Отменена», если закупка не состоялась / отменена,
 *   и «Победа/Проигрыш» для закупок из одного источника. «Состоялась» без договора — статус не трогает.
 * 13.11.2026: J «Статус» меняется при любом текущем значении, если портал даёт факт (договор / не состоялась /
 *   ОИ); P «Победитель» — только в пустую. Этап 2 сверяет и заполненные строки: пустые G/I/N заполняет,
 *   расхождения заполненных G/I — только заметка в журнал. Строки «Архив» (R) проверяются один раз.
 *   ОИ: наш поставщик — по id или по БИН/ИИН (GZS_CFG.post[].bin). «Не участвуем» в «Проигрыш» не меняется.
 * 16.11.2026: этап «Итоги» читает PDF «Протокол итогов», если закупка состоялась, а договора ещё нет:
 *   наш ИИН/БИН среди победителей → «Победа», среди участников, но не победитель → «Проигрыш»,
 *   нет в протоколе или победитель не найден → только заметка. ИИН/БИН поставщиков, если не вписаны в
 *   GZS_CFG.post, берутся из их договоров на портале (supplierBiin) и запоминаются (GZS_BIN_<id>).
 *   PDF читается через временный Google Документ (служба Drive API v3), документ сразу уходит в корзину.
 *   Разобранный протокол запоминается (GZS_P_<№ закупки>), повторно не скачивается.
 * 17.11.2026: этап 1 сверяет у записанных договоров сумму (по последней редакции, с допсоглашениями) и дату
 *   подписания (по редакции, чей номер стоит в планере) и приводит их к порталу; каждое изменение — в журнал.
 * 18.11.2026: ОИ — поставщик в объявлении (idSupplier) — это приглашённый, а не победитель: по нему статус
 *   больше не меняется (раньше «Готовим» становилось «Победа» и пропадало напоминание «Подать заявку»).
 *   «Изучаем»/«Готовим» не становятся «Победой» по неподписанному договору (нет signDate); дата проекта (T)
 *   при этом заполняется.
 * 19.11.2026: этап 2 — если в I «Срок подачи» стоит дата без времени, а на портале та же дата со временем,
 *   время дописывается (для напоминаний в Telegram за 24/3/1 ч). Другая дата — по-прежнему только заметка.
 */

var GZS_CFG = {
  url: 'https://ows.goszakup.gov.kz/v3/graphql',
  god0: 2026,        // с этого года планер ведёт данные; текущий год скрипт определяет сам (gzsGodTek_)
  post: [                // bin — БИН/ИИН поставщика (12 цифр), впишите вручную; пусто — сверка только по id
    {id: 763754, imya: 'ТОО Про авто', bin: ''},
    {id: 150486, imya: 'ИП Байжанов', bin: ''},
    {id: 150484, imya: 'ИП Шайн', bin: ''},
    {id: 150488, imya: 'ИП Канаева', bin: ''}
  ],
  ZAK: '2. Закупки', DOG: '3. Договоры', AKT: '4. Акты и оплата', ZH: 'Сверка ГЗ',
  dZak: [5, 303], dDog: [5, 202], dAkt: [5, 402],
  limitMs: 300000,   // 5 минут на запуск
  zapasMs: 80000,    // не начинать запрос, если до лимита меньше 80 с
  pachka: 5,         // закупок в одном запросе
  stranica: 200,     // записей на страницу
  zhKol: 12,         // журнал с колонки L
  zhStrok: 3000      // хранить последних строк журнала
};

/* ================= точки входа ================= */

// прогон без записи; заодно выключает запись по расписанию до новой приёмки (gzsVklyuchitZapis)
function gzsProverka() {
  PropertiesService.getScriptProperties().deleteProperty('GZS_PRINYATO');
  gzsStart_('proverka', true);
}

function gzsObnovit() {
  var prin = PropertiesService.getScriptProperties().getProperty('GZS_PRINYATO') === '1';
  if (!prin) gzsToast_('Запись ещё не включена — прогон без записи');
  gzsStart_(prin ? 'zapis' : 'proverka', false);
}

function gzsPoRaspisaniyu() {
  if (PropertiesService.getScriptProperties().getProperty('GZS_PRINYATO') === '1') gzsStart_('zapis', false);
}

function gzsProdolzhit() {
  gzsUdalitTriggery_('gzsProdolzhit');
  gzsRabota_();
}

function gzsVklyuchitZapis() {
  PropertiesService.getScriptProperties().setProperty('GZS_PRINYATO', '1');
  gzsUdalitTriggery_('gzsPoRaspisaniyu');
  ScriptApp.newTrigger('gzsPoRaspisaniyu').timeBased().everyDays(1).atHour(7).nearMinute(0).create();
  ScriptApp.newTrigger('gzsPoRaspisaniyu').timeBased().everyDays(1).atHour(17).nearMinute(0).create();
  gzsToast_('Запись включена, расписание 7:00 и 17:00');
}

function gzsStop() {
  gzsUdalitTriggery_('gzsProdolzhit');
  PropertiesService.getScriptProperties().deleteProperty('GZS_SOST');
  gzsToast_('Синхронизация ГЗ остановлена');
}

/* ================= движок ================= */

function gzsStart_(rezhim, sila) {
  var pr = PropertiesService.getScriptProperties();
  var st = JSON.parse(pr.getProperty('GZS_SOST') || 'null');
  if (st && !sila && Date.now() - st.start < 3 * 3600000) { gzsToast_('Обновление уже идёт, продолжится само'); return; }
  gzsUdalitTriggery_('gzsProdolzhit');
  st = {rezhim: rezhim, etap: 1, i: 0, start: Date.now(), sdelano: [],
        virt: {zak: [], dog: [], akt: [], zakN: []}, n: {pr: 0, nov: 0, ner: 0}};
  pr.setProperty('GZS_SOST', JSON.stringify(st));
  gzsRabota_();
}

function gzsRabota_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { gzsPostavitProdolzhenie_(); return; }
  var pr = PropertiesService.getScriptProperties();
  var ctx = {t0: Date.now(), log: [], unit: [], filtry: {}, st: null};
  try {
    ctx.st = JSON.parse(pr.getProperty('GZS_SOST') || 'null');
    if (!ctx.st) return;
    var st = ctx.st;
    try {
      if (st.etap === 1) gzsEtapDogovory_(ctx);
      if (st.etap === 2) gzsEtapZakupki_(ctx);
      if (st.etap === 3) gzsEtapItogi_(ctx);
      if (st.etap === 4) gzsEtapAkty_(ctx);
      if (st.etap === 5) gzsEtapAnalitika_(ctx);
      gzsZap_(ctx, 'итог', '', '', '', '', 'изменено ячеек: ' + st.n.pr + ', новых строк: ' + st.n.nov + ', не разнесено: ' + st.n.ner);
      gzsUnitOk_(ctx);
      pr.deleteProperty('GZS_SOST');
      gzsToast_('ГЗ: готово');
    } catch (e) {
      if (e && e.gzsTimeout) {
        if (st.rezhim === 'zapis') gzsUnitOk_(ctx); else ctx.unit = [];
        pr.setProperty('GZS_SOST', JSON.stringify(st));
        gzsPostavitProdolzhenie_();
        gzsZap_(ctx, 'пауза', '', '', '', '', 'лимит 5 минут, этап ' + st.etap + ' — продолжение через минуту');
        gzsUnitOk_(ctx);
      } else if (e && e.gzsSet && (st.sboi || 0) < 6) {
        if (st.rezhim === 'zapis') gzsUnitOk_(ctx); else ctx.unit = [];
        st.sboi = (st.sboi || 0) + 1;
        pr.setProperty('GZS_SOST', JSON.stringify(st));
        gzsPostavitProdolzhenie_(10);
        gzsZap_(ctx, 'пауза', '', '', '', '', e.message + ' — повтор через 10 минут (' + st.sboi + ' из 6)');
        gzsUnitOk_(ctx);
      } else {
        if (st.rezhim === 'zapis') gzsUnitOk_(ctx); else ctx.unit = [];
        gzsZap_(ctx, 'ошибка', '', '', '', '', String((e && e.message) || e).slice(0, 1000));
        gzsUnitOk_(ctx);
        pr.deleteProperty('GZS_SOST');
      }
    }
  } finally {
    gzsVernutFiltry_(ctx);
    try { gzsZhurnalDopisat_(ctx.log); } catch (e2) { Logger.log(e2); }
    lock.releaseLock();
  }
}

/* ================= этап 1: договоры ================= */

function gzsEtapDogovory_(ctx) {
  var st = ctx.st, C = GZS_CFG;
  while (st.i < C.post.length) {
    var p = C.post[st.i];
    var spisok = gzsDogovoryPost_(ctx, p.id,
      'id contractNumberSys trdBuyNumberAnno signDate contractSumWnds refContractStatusId crdate');
    var poBaze = {}, poNomeru = {};
    spisok.forEach(function (c) {
      var n = String(c.contractNumberSys || '').trim(); if (!n) return;
      var b = gzsBaza_(n);
      poNomeru[n] = c;
      if (!poBaze[b] || gzsHvost_(n) > gzsHvost_(poBaze[b].contractNumberSys)) poBaze[b] = c;
    });
    var dogStroki = gzsDogStroki_();
    var zakVals = gzsList_(C.ZAK).getRange(C.dZak[0], 1, C.dZak[1] - C.dZak[0] + 1, 4).getValues();
    var zakEst = {};
    zakVals.forEach(function (r) {
      var d = String(r[3]).trim(); if (d) (zakEst[d] = zakEst[d] || []).push(String(r[0]).trim());
    });
    st.virt.zakN.forEach(function (d) { if (!zakEst[d]) zakEst[d] = ['(новая)']; });

    Object.keys(poBaze).forEach(function (b) {
      var c = poBaze[b], nomer = String(c.contractNumberSys).trim(), status = gzsStatus_(c.refContractStatusId);
      if (dogStroki[b]) {                                       // существующий — только статус
        var s = dogStroki[b];
        if (status === null) {
          gzsZap_(ctx, 'не разнесено', C.DOG, 'I' + s.row, s.i, '', 'статус на портале: код ' + c.refContractStatusId + ' — не сопоставлен');
        } else if (GZS_RUCHNYE.indexOf(s.i) >= 0) {
          if (s.i !== status) gzsZap_(ctx, 'заметка', C.DOG, 'I' + s.row, s.i, status, 'статус «' + s.i + '» ставили вручную — не трогаю');
        } else {
          var izmS = []; gzsIzm_(izmS, 9, s.i, status, 't');
          gzsStroka_(ctx, C.DOG, s.row, 5, s.nomer, izmS, 'так на портале: ' + (status === 'Исполнен' ? 'договор исполнен' : 'договор действует'));
        }
        // 17.11.2026: сумма — по последней редакции договора (с допсоглашениями), дата — по той редакции,
        // номер которой стоит в планере (у допсоглашения своя дата подписания)
        var izmD = [], smP = gzsChislo_(c.contractSumWnds), red = poNomeru[s.nomer];
        if (smP != null) gzsIzm_(izmD, 7, s.g, smP, 'n');
        if (red) { var sdP = gzsData_(red.signDate, false); if (sdP) gzsIzm_(izmD, 6, s.f, sdP, 'd'); }
        if (izmD.length) gzsStroka_(ctx, C.DOG, s.row, 5, s.nomer, izmD,
          'так на портале' + (gzsHvost_(nomer) ? ' (сумма — по редакции ' + nomer + ')' : ''));
        return;
      }
      var data = gzsData_(c.signDate, false);
      if (!data) { gzsZap_(ctx, 'не разнесено', C.DOG, '', '', nomer, 'на портале нет даты подписания — договор не заведён'); return; }
      var nz = String(c.trdBuyNumberAnno || '').trim();
      if (!nz) {
        gzsZap_(ctx, 'не разнесено', C.DOG, '', '', nomer, 'у договора нет № закупки — колонка A будет пустой');
      } else if (!zakEst[nz]) {
        var lots = [].concat(gzsZapros_(ctx, '{Lots(filter:{trdBuyNumberAnno:"' + nz + '"}){customerNameRu}}').data.Lots || []);
        var zakazchik = lots.length ? String(lots[0].customerNameRu || '') : '';
        var r = gzsNovaya_(ctx, C.ZAK, C.dZak, [1, 4, 5, 7, 9, 10], 'zak',
          [[1, p.imya, 't'], [2, 'ГЗ', 't'], [4, nz, 't'], [5, zakazchik, 't'], [10, 'Победа', 't'],
           [16, p.imya, 't'], [20, gzsData_(c.crdate, false), 'd']],
          'на портале новый договор ' + nomer + ', закупки в планере не было');
        if (r) { zakEst[nz] = [p.imya]; if (st.rezhim !== 'zapis') st.virt.zakN.push(nz); }
      } else if (zakEst[nz].indexOf(p.imya) < 0 && zakEst[nz][0] !== '(новая)') {
        gzsZap_(ctx, 'заметка', C.ZAK, '', '', nz, 'закупка в планере есть, но у другого поставщика: ' + zakEst[nz].join(', '));
      }
      gzsNovaya_(ctx, C.DOG, C.dDog, [1, 5, 6, 7], 'dog',
        [[1, nz, 't'], [5, nomer, 't'], [6, data, 'd'], [7, gzsChislo_(c.contractSumWnds), 'n'], [9, status || 'Исполняется', 't']],
        'на портале новый договор');
    });
    gzsUnitOk_(ctx);
    gzsZakPoDogovoram_(ctx, p, spisok);
    gzsUnitOk_(ctx);
    st.i++;
  }
  st.etap = 2; st.i = 0;
}

/* ================= этап 2: закупки ================= */

function gzsEtapZakupki_(ctx) {
  var st = ctx.st, C = GZS_CFG, pr = PropertiesService.getScriptProperties();
  var kesh = pr.getProperties();
  var sh = gzsList_(C.ZAK), s0 = C.dZak[0], n = C.dZak[1] - s0 + 1;
  while (true) {
    var vals = sh.getRange(s0, 1, n, 18).getValues();
    var nado = [], seen = {};
    vals.forEach(function (r) {
      if (String(r[1]).trim() !== 'ГЗ') return;
      var d = String(r[3]).trim(); if (!d || seen[d]) return;
      if (String(r[17]).trim() === 'Архив' && kesh['GZS_Z_' + d]) return;   // архив — проверяется один раз
      var srokPod = gzsIzYach_(r[8]);
      if (srokPod && srokPod.getFullYear() < gzsGodMin_()) return;     // только закупки текущего и прошлого года
      if (st.sdelano.indexOf(d) >= 0) return;
      if (st.rezhim === 'zapis' && !gzsPora_(kesh['GZS_Z_' + d], r[8])) return;
      seen[d] = 1; nado.push(d);
    });
    if (!nado.length) break;

    var pachka = nado.slice(0, C.pachka);
    var q = '{' + pachka.map(function (d, j) {
      return 't' + j + ':TrdBuy(filter:{numberAnno:"' + d + '"}){endDate itogiDatePublic} ' +
             'l' + j + ':Lots(filter:{trdBuyNumberAnno:"' + d + '"}){amount}';
    }).join(' ') + '}';
    var otv = gzsZapros_(ctx, q), data = otv.data || {};
    if (otv.errors) gzsZap_(ctx, 'заметка', C.ZAK, '', '', pachka.join(', '), 'ошибка по части запроса: ' + JSON.stringify(otv.errors).slice(0, 300));

    vals = sh.getRange(s0, 1, n, 18).getValues();          // перечитать перед записью
    pachka.forEach(function (d, j) {
      var tb = [].concat(data['t' + j] || [])[0], lots = [].concat(data['l' + j] || []);
      var vseOk = true, rash = [];
      if (!tb && !lots.length) gzsZap_(ctx, 'не разнесено', C.ZAK, '', '', d, 'закупка не найдена на портале');
      var sm = null;
      lots.forEach(function (l) { var v = gzsChislo_(l && l.amount); if (v != null) sm = (sm || 0) + v; });
      var poLotam = lots.length > 1 ? ' (сумма — по ' + lots.length + ' лотам)' : '';
      vals.forEach(function (r, i) {
        if (String(r[3]).trim() !== d || String(r[1]).trim() !== 'ГЗ') return;
        var izm = [];
        if (tb) {
          var srok = gzsData_(tb.endDate, true);
          if (srok) {
            var yach = gzsIzYach_(r[8]);
            if (gzsKl_(r[8], 't') === '') gzsIzm_(izm, 9, r[8], srok, 'dt');              // пустой — заполнить
            else if (gzsKl_(r[8], 'd') !== gzsKl_(srok, 'd'))                          // заполнен — только заметка
              rash.push(['I' + (s0 + i), gzsPokaz_(r[8], 'd'), gzsPokaz_(srok, 'd'), 'на портале другой срок подачи — ячейку не меняю']);
            else if (yach && !yach.getHours() && !yach.getMinutes() && (srok.getHours() || srok.getMinutes()))
              gzsIzm_(izm, 9, r[8], srok, 'dt');                                       // 19.11.2026: та же дата без времени — дописать время
          }
          if (gzsKl_(r[13], 't') === '') { var it = gzsData_(tb.itogiDatePublic, false); if (it) gzsIzm_(izm, 14, r[13], it, 'd'); }
        }
        if (sm != null) {
          if (gzsKl_(r[6], 't') === '') gzsIzm_(izm, 7, r[6], sm, 'n');
          else if (gzsKl_(r[6], 'n') !== gzsKl_(sm, 'n'))
            rash.push(['G' + (s0 + i), gzsPokaz_(r[6], 'n'), gzsPokaz_(sm, 'n'), 'на портале другая сумма' + poLotam + ' — ячейку не меняю']);
        }
        if (!gzsStroka_(ctx, C.ZAK, s0 + i, 4, d, izm, 'данные объявления на портале' + poLotam)) vseOk = false;
      });
      // расхождения: в режиме записи одно и то же повторно не пишем, пока портал или планер не изменятся
      var klR = rash.map(function (x) { return x.join('|'); }).join('#');
      if (st.rezhim !== 'zapis' || (kesh['GZS_ZR_' + d] || '') !== klR) {
        rash.forEach(function (x) { gzsZap_(ctx, 'заметка', C.ZAK, x[0], x[1], x[2], x[3]); });
        if (st.rezhim === 'zapis') {
          if (klR) pr.setProperty('GZS_ZR_' + d, klR); else pr.deleteProperty('GZS_ZR_' + d);
          kesh['GZS_ZR_' + d] = klR;
        }
      }
      if (st.rezhim === 'zapis' && vseOk) {
        var t = String(Date.now());
        pr.setProperty('GZS_Z_' + d, t); kesh['GZS_Z_' + d] = t;
      }
    });
    st.sdelano = st.sdelano.concat(pachka);
    gzsUnitOk_(ctx);
  }
  st.etap = 3; st.i = 0; st.sdelano = [];
}

/* ================= этап 3: итоги поданных заявок (победа / проигрыш) ================= */

function gzsEtapItogi_(ctx) {
  var st = ctx.st, C = GZS_CFG, pr = PropertiesService.getScriptProperties(), kesh = pr.getProperties();
  var sh = gzsList_(C.ZAK), s0 = C.dZak[0], n = C.dZak[1] - s0 + 1;
  var idPo = {}, binPo = gzsBiny_(ctx);                     // 16.11.2026: БИН/ИИН — из настроек или из договоров на портале
  C.post.forEach(function (p) { idPo[p.imya] = p.id; });
  // 13.11.2026: J меняется при любом текущем значении (раньше — только «Подана»/«Допущена»)
  if (st.subj === undefined) st.subj = gzsSubjPole_(ctx);   // поле с названием поставщика у Subject
  var polya = 'supplierId supplierFio signDate' + (st.subj ? ' Supplier{' + st.subj + ' refKopfCode}' : '');
  while (true) {
    var vals = sh.getRange(s0, 1, n, 18).getValues(), nado = [], seen = {};
    vals.forEach(function (r) {
      if (String(r[1]).trim() !== 'ГЗ' || !idPo[String(r[0]).trim()]) return;
      var d = String(r[3]).trim(); if (!d || seen[d] || st.sdelano.indexOf(d) >= 0) return;
      if (String(r[17]).trim() === 'Архив' && kesh['GZS_I_' + d]) return;   // архив — проверяется один раз
      var srok = gzsIzYach_(r[8]), itogi = gzsIzYach_(r[13]);
      if (!srok || srok.getFullYear() < gzsGodMin_()) return;
      // подача ещё идёт — ждём; но если итоги уже опубликованы (ОИ подводят раньше срока), проверяем сразу
      if (srok.getTime() > Date.now() && !(itogi && itogi.getTime() <= Date.now())) return;
      if (st.rezhim === 'zapis' && !gzsPora_(kesh['GZS_I_' + d], r[8])) return;
      seen[d] = 1; nado.push([d, srok.getTime()]);
    });
    if (!nado.length) break;
    // 16.11.2026: сначала свежие закупки — при лимите 5 минут они не ждут старых
    nado = nado.sort(function (x, y) { return y[1] - x[1]; }).map(function (x) { return x[0]; });

    var pachka = nado.slice(0, C.pachka);
    // v2 (07.11.2026): кроме договоров — статус объявления и лотов (итоги до заключения договора)
    var otv = gzsZapros_(ctx, '{' + pachka.map(function (d, j) {
      return 'c' + j + ':Contract(filter:{trdBuyNumberAnno:"' + d + '"}){' + polya + '} ' +
             't' + j + ':TrdBuy(filter:{numberAnno:"' + d + '"}){itogiDatePublic idSupplier biinSupplier RefBuyStatus{nameRu} Files{id nameRu filePath}} ' +
             'l' + j + ':Lots(filter:{trdBuyNumberAnno:"' + d + '"}){RefLotsStatus{nameRu}}';
    }).join(' ') + '}');
    var data = otv.data || {};
    if (otv.errors) gzsZap_(ctx, 'заметка', C.ZAK, '', '', pachka.join(', '), 'ошибка по части запроса: ' + JSON.stringify(otv.errors).slice(0, 300));

    vals = sh.getRange(s0, 1, n, 18).getValues();             // перечитать перед записью
    pachka.forEach(function (d, j) {
      var dog = [].concat(data['c' + j] || []);
      var tb = [].concat(data['t' + j] || [])[0] || null, loty = [].concat(data['l' + j] || []);
      var ids = dog.map(function (x) { return Number(x.supplierId); }), imena = [];
      dog.forEach(function (x) {
        var nm = gzsImyaPob_(x, st.subj);
        if (nm && imena.indexOf(nm) < 0) imena.push(nm);
      });
      var ishod = (!dog.length && tb) ? gzsIshod_(tb, loty) : null;
      var prot = (!dog.length && tb && !ishod) ? gzsProtokol_(ctx, d, tb) : null;   // 16.11.2026: протокол итогов
      vals.forEach(function (r, i) {
        if (String(r[3]).trim() !== d || String(r[1]).trim() !== 'ГЗ') return;
        var a = String(r[0]).trim(), id = idPo[a]; if (!id) return;
        var izm = [], pochemu = '', pPust = gzsKl_(r[15], 't') === '';   // P «Победитель» — только в пустую
        var proigr = String(r[9]).trim() === 'Не участвуем' ? 'Не участвуем' : 'Проигрыш';   // «Не участвуем» → «Проигрыш» не меняем
        var jTek = String(r[9]).trim(), rano = jTek === 'Изучаем' || jTek === 'Готовим';   // 18.11.2026: заявка ещё не подана
        if (dog.length) {                                       // договор заключён — исход точный
          if (ids.indexOf(id) >= 0) {
            var podp = dog.some(function (x) { return Number(x.supplierId) === id && x.signDate; });
            if (!(rano && !podp)) {                              // 18.11.2026: неподписанный проект «Готовим» не снимает
              gzsIzm_(izm, 10, r[9], 'Победа', 't'); if (pPust) gzsIzm_(izm, 16, r[15], a, 't'); pochemu = 'на портале заключён договор с ' + a;
            }
          }
          else { gzsIzm_(izm, 10, r[9], proigr, 't'); if (pPust) gzsIzm_(izm, 16, r[15], imena.join('; '), 't'); pochemu = 'на портале договор заключён с другим поставщиком'; }
        } else if (ishod && ishod.vid === 'ne_sost') {           // закупка не состоялась / отменена
          gzsIzm_(izm, 10, r[9], 'Отменена', 't');
          if (gzsKl_(r[16], 't') === '') gzsIzm_(izm, 17, r[16], 'по порталу: ' + ishod.tekst, 't');
          pochemu = 'на портале: ' + ishod.tekst;
        } else if (ishod && ishod.vid === 'oi') {
          // 18.11.2026: из одного источника — в объявлении указан ПРИГЛАШЁННЫЙ поставщик, а не победитель.
          // Статус не трогаем: «Победа» появится по договору (этап 1), напоминание «Подать заявку» остаётся.
        } else if (prot && prot.oshibka) {                       // протокол есть, но прочитать не удалось
          gzsZap_(ctx, 'заметка', C.ZAK, 'J' + (s0 + i), '', '', 'протокол итогов не прочитан: ' + prot.oshibka + ' — статус не трогаю');
        } else if (prot) {                                       // 16.11.2026: победитель — по протоколу итогов
          var mojBin = binPo[a] || '';
          var pobTxt = prot.pob.map(function (x) { return x.bin + ' ' + x.imya; }).join('; ');
          if (!mojBin) {
            gzsZap_(ctx, 'заметка', C.ZAK, 'J' + (s0 + i), '', '', 'протокол итогов: у ' + a + ' не найден ИИН/БИН — не сравнить, статус не трогаю');
          } else if (!prot.pob.length) {
            gzsZap_(ctx, 'заметка', C.ZAK, 'J' + (s0 + i), '', '', 'в протоколе итогов не нашёл победителя — статус не трогаю');
          } else if (prot.pob.some(function (x) { return x.bin === mojBin; })) {
            gzsIzm_(izm, 10, r[9], 'Победа', 't'); if (pPust) gzsIzm_(izm, 16, r[15], a, 't');
            pochemu = 'протокол итогов: победитель ' + a + ' (ИИН/БИН ' + mojBin + ')';
          } else if (prot.vse.indexOf(mojBin) >= 0) {
            gzsIzm_(izm, 10, r[9], proigr, 't'); if (pPust) gzsIzm_(izm, 16, r[15], pobTxt, 't');
            pochemu = 'протокол итогов: победитель ' + pobTxt;
          } else {
            gzsZap_(ctx, 'заметка', C.ZAK, 'J' + (s0 + i), '', '', 'в протоколе итогов нет ИИН/БИН ' + mojBin + ' (' + a + ') — статус не трогаю');
          }
        }
        // «закупка состоялась», договора ещё нет — победитель неизвестен: статус не трогаем (флаг в утреннем письме)
        if (izm.length) gzsStroka_(ctx, C.ZAK, s0 + i, 4, d, izm, pochemu);
      });
      if (st.rezhim === 'zapis') { var tt = String(Date.now()); pr.setProperty('GZS_I_' + d, tt); kesh['GZS_I_' + d] = tt; }
    });
    st.sdelano = st.sdelano.concat(pachka);
    gzsUnitOk_(ctx);
  }
  st.etap = 4; st.i = 0; st.sdelano = [];
}

// исход по объявлению и лотам, пока договора нет: {vid:'ne_sost'|'oi', ...} или null
function gzsIshod_(tb, loty) {
  var imya = function (x, k) { return String((x && x[k] && x[k].nameRu) || '').trim(); };
  var buy = imya(tb, 'RefBuyStatus'), ls = loty.map(function (l) { return imya(l, 'RefLotsStatus'); });
  var ne = function (s) { return /не состоял|отмен/i.test(s); };
  if (/отмен/i.test(buy) || (ls.length && ls.every(ne))) {
    var tekst = (ls.length ? ls.filter(function (s, k) { return ls.indexOf(s) === k; }).join(', ') : buy).toLowerCase();
    var it = gzsData_(tb.itogiDatePublic, false);
    return {vid: 'ne_sost', tekst: tekst + (it ? ' (итоги ' + Utilities.formatDate(it, gzsTz_(), 'dd.MM.yyyy') + ')' : '')};
  }
  var sup = Number(tb.idSupplier || 0), bin = String(tb.biinSupplier || '').trim();
  if (sup > 0 || bin) return {vid: 'oi', id: sup, bin: bin};
  return null;
}

// 16.11.2026: ИИН/БИН поставщиков {имя: бин}. Порядок: GZS_CFG.post[].bin → запомненный GZS_BIN_<id> → договор на портале
function gzsBiny_(ctx) {
  if (ctx.biny) return ctx.biny;
  var pr = PropertiesService.getScriptProperties(), m = {};
  GZS_CFG.post.forEach(function (p) {
    var b = String(p.bin || '').trim() || pr.getProperty('GZS_BIN_' + p.id) || '';
    if (!b) {
      var c = [].concat(gzsZapros_(ctx, '{Contract(filter:{supplierId:' + p.id + '}, limit:1){supplierBiin}}').data.Contract || [])[0];
      b = String((c && c.supplierBiin) || '').trim();
      if (/^\d{12}$/.test(b)) pr.setProperty('GZS_BIN_' + p.id, b); else b = '';
    }
    m[p.imya] = b;
  });
  ctx.biny = m;
  return m;
}

// 16.11.2026: протокол итогов закупки → {pob:[{bin, imya}], vse:[все 12-значные номера]} | {oshibka} | null (протокола нет)
function gzsProtokol_(ctx, d, tb) {
  var f = [].concat(tb.Files || []).filter(function (x) { return x && /итог/i.test(String(x.nameRu || '')) && x.filePath; })
    .sort(function (x, y) { return Number(y.id) - Number(x.id); })[0];          // переразмещали — берём последний
  if (!f) return null;
  var pr = PropertiesService.getScriptProperties(), kl = 'GZS_P_' + d;
  var kesh = JSON.parse(pr.getProperty(kl) || 'null');
  if (kesh && String(kesh.id) === String(f.id)) return kesh;
  if (Date.now() - ctx.t0 > GZS_CFG.limitMs - GZS_CFG.zapasMs) throw {gzsTimeout: true};
  var tekst;
  try {
    var r = UrlFetchApp.fetch(f.filePath, {muteHttpExceptions: true});
    if (r.getResponseCode() !== 200) return {oshibka: 'файл не скачался (HTTP ' + r.getResponseCode() + ')'};
    tekst = gzsPdfTekst_(r.getBlob().setContentType('application/pdf').setName('protokol_' + d + '.pdf'));
  } catch (e) {
    return {oshibka: String((e && e.message) || e).slice(0, 200)};
  }
  var x = gzsProtRazbor_(tekst);
  x.id = f.id;
  pr.setProperty(kl, JSON.stringify(x));                         // прочитанный протокол больше не скачиваем
  return x;
}

// текст PDF: временный Google Документ → выгрузка текста → документ в корзину
function gzsPdfTekst_(blob) {
  var doc = Drive.Files.create({name: 'gzs_vremenno_' + blob.getName(), mimeType: 'application/vnd.google-apps.document'},
    blob, {ocrLanguage: 'ru', fields: 'id'});
  try {
    var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + doc.id + '/export?mimeType=text/plain',
      {headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()}, muteHttpExceptions: true});
    if (r.getResponseCode() !== 200) throw new Error('текст не выгрузился (HTTP ' + r.getResponseCode() + ')');
    return r.getContentText('UTF-8');
  } finally {
    try { Drive.Files.update({trashed: true}, doc.id); } catch (e) { Logger.log(e); }
  }
}

// победители: «Определить победителем по лоту № … : 870917401019 Канаева К.М. ,» (рус.) или «… жеңімпаз: 870917401019 …» (каз.)
function gzsProtRazbor_(tekst) {
  var t = String(tekst || '').replace(/\s+/g, ' '), pob = [], byl = {};
  var re = /(?:победител\S*\s+по\s+лоту[^:]{0,80}:|жеңімпаз\s*:)\s*(\d{12})\s+([^,]{1,120})/gi, m;
  while ((m = re.exec(t)) !== null) {
    if (byl[m[1]]) continue;
    byl[m[1]] = 1;
    var imya = m[2].split(/\s+(?:потенциальн|екінші)|\s+\.(?:\s|$)|\s+\d+\.\s/i)[0].trim().slice(0, 80);
    pob.push({bin: m[1], imya: imya});
  }
  var vse = (t.match(/\b\d{12}\b/g) || []).filter(function (x, k, a) { return a.indexOf(x) === k; });
  return {pob: pob, vse: vse};
}

// проба этапа «Итоги» без записи: результат — в журнале «Сверка ГЗ» с пометкой (проба)
function gzsTestItogi() {
  var ctx = {t0: Date.now(), log: [], unit: [], filtry: {},
    st: {rezhim: 'proverka', etap: 3, i: 0, start: Date.now(), sdelano: [], virt: {zak: [], dog: [], akt: [], zakN: []}, n: {pr: 0, nov: 0, ner: 0}}};
  try {
    gzsEtapItogi_(ctx);
    gzsZap_(ctx, 'итог', '', '', '', '', 'проба этапа «Итоги»: изменилось бы ячеек: ' + ctx.st.n.pr);
    gzsUnitOk_(ctx);
  } catch (e) {
    if (!(e && e.gzsTimeout)) throw e;                         // 16.11.2026: лимит 5 минут — не ошибка
    ctx.unit = [];
    gzsZap_(ctx, 'итог', '', '', '', '', 'проба этапа «Итоги» остановлена на лимите 5 минут (проверено закупок: ' +
      ctx.st.sdelano.length + ', изменилось бы ячеек: ' + ctx.st.n.pr + '). Прочитанные протоколы запомнены — запустите gzsTestItogi ещё раз');
    gzsUnitOk_(ctx);
  } finally {
    gzsVernutFiltry_(ctx);
    gzsZhurnalDopisat_(ctx.log);
  }
}

// свежие закупки (срок подачи не старше 45 дней) — не чаще раза в 10 ч, старые — раз в 30 дней
function gzsPora_(t, srok) {
  t = Number(t || 0); if (!t) return true;
  var d = gzsIzYach_(srok);
  var svezh = !d || Date.now() - d.getTime() < 45 * 86400000;
  return Date.now() - t > (svezh ? 10 * 3600000 : 30 * 86400000);
}

/* ================= этап 3: акты и оплаты ================= */

function gzsEtapAkty_(ctx) {
  var st = ctx.st, C = GZS_CFG;
  var sh = gzsList_(C.AKT), s0 = C.dAkt[0];
  if (st.i === 0 && gzsKl_(sh.getRange(4, 17).getValue(), 't') === '') {
    gzsStroka_(ctx, C.AKT, 4, 1, sh.getRange(4, 1).getValue(),
      [{kol: 17, bylo: '', stalo: 'ID акта ГЗ', tip: 't'}], 'заголовок ключевой колонки');
  }
  while (st.i < C.post.length) {
    var p = C.post[st.i];
    var dogs = gzsDogovoryPost_(ctx, p.id,
      'id contractNumberSys ContractPayment{actId paySum payDate}');
    var akty = gzsVse_(ctx, 'Acts', '{supplierId:' + p.id + '}',
      'id createDateGenInfo approveDate Place{amount} Contract{contractNumberSys}');

    var opl = {}, apiNomer = {};
    dogs.forEach(function (c) {
      if (c.contractNumberSys) apiNomer[gzsBaza_(c.contractNumberSys)] = String(c.contractNumberSys).trim();
      [].concat(c.ContractPayment || []).forEach(function (x) {
        if (!x || x.actId == null) return;
        var k = String(x.actId), o = opl[k] || (opl[k] = {sum: 0, data: null});
        o.sum += gzsChislo_(x.paySum) || 0;
        var d = gzsData_(x.payDate, false); if (d && (!o.data || d > o.data)) o.data = d;
      });
    });

    var planNomer = gzsDogovoryPlanera_();
    var poBaze = {};
    akty.forEach(function (a) {
      var nm = a.Contract && a.Contract.contractNumberSys; if (!nm) return;
      var ad = gzsData_(a.approveDate, false);
      if (!ad || ad.getFullYear() < gzsGodMin_()) return;                // только акты, утверждённые в текущем и прошлом году
      var b = gzsBaza_(nm);
      if (!planNomer[b] && !apiNomer[b]) return;
      var sum = null;
      [].concat(a.Place || []).forEach(function (m) { var v = m && gzsChislo_(m.amount); if (v != null) sum = (sum || 0) + v; });
      (poBaze[b] = poBaze[b] || []).push({id: String(a.id), nomer: String(nm).trim(), sum: sum,
        f: gzsData_(a.createDateGenInfo, false), h: gzsData_(a.approveDate, false), s: null});
    });

    var vals = sh.getRange(s0, 1, C.dAkt[1] - s0 + 1, 17).getValues();
    var stroki = [];
    vals.forEach(function (r, i) {
      var a = String(r[0]).trim(); if (!a) return;
      var dt = gzsIzYach_(r[7]) || gzsIzYach_(r[5]);
      if (dt && dt.getFullYear() < gzsGodMin_()) return;                 // строки прошлых лет не трогаем
      stroki.push({row: s0 + i, a: a, b: gzsBaza_(a), e: r[4], f: r[5], h: r[7], j: r[9], k: r[10],
                   q: String(r[16]).trim(), vzyat: false});
    });

    Object.keys(poBaze).forEach(function (b) {
      var A = poBaze[b], R = stroki.filter(function (s) { return s.b === b; }), pary = [];
      function para(a, s, kak) { a.s = s; s.vzyat = true; pary.push([a, s, kak]); }
      function ostA() { return A.filter(function (a) { return !a.s; }); }
      function ostR() { return R.filter(function (s) { return !s.vzyat && !s.q; }); }
      function poKl(fa, fs, kak) {
        var ga = {}, gs = {};
        ostA().forEach(function (a) { var k = fa(a); if (k !== '') (ga[k] = ga[k] || []).push(a); });
        ostR().forEach(function (s) { var k = fs(s); if (k !== '') (gs[k] = gs[k] || []).push(s); });
        Object.keys(ga).forEach(function (k) {
          if (ga[k].length === 1 && gs[k] && gs[k].length === 1) para(ga[k][0], gs[k][0], kak);
        });
      }
      // 1) по ID в Q  2) сумма  3) дата направления  4) дата утверждения  5) единственная пара
      A.forEach(function (a) {
        var s = R.filter(function (x) { return !x.vzyat && x.q === a.id; })[0]; if (s) para(a, s, '');
      });
      poKl(function (a) { return gzsKl_(a.sum, 'n'); }, function (s) { return gzsKl_(s.e, 'n'); }, 'по сумме');
      poKl(function (a) { return gzsKl_(a.f, 'd'); }, function (s) { return gzsKl_(s.f, 'd'); }, 'по дате направления');
      poKl(function (a) { return gzsKl_(a.h, 'd'); }, function (s) { return gzsKl_(s.h, 'd'); }, 'по дате утверждения');
      if (ostA().length === 1 && ostR().length === 1) para(ostA()[0], ostR()[0], 'как единственная неразобранная строка договора');

      pary.forEach(function (x) {
        var a = x[0], s = x[1], izm = [];
        if (a.sum != null) gzsIzm_(izm, 5, s.e, a.sum, 'n');
        if (a.f) gzsIzm_(izm, 6, s.f, a.f, 'd');
        if (a.h) gzsIzm_(izm, 8, s.h, a.h, 'd');
        gzsIzm_(izm, 17, s.q, a.id, 't');
        var o = opl[a.id];
        if (o) { if (o.data) gzsIzm_(izm, 10, s.j, o.data, 'd'); gzsIzm_(izm, 11, s.k, o.sum, 'n'); }
        gzsStroka_(ctx, C.AKT, s.row, 1, s.a, izm, 'так на портале (акт ID ' + a.id + (x[2] ? ', строка найдена ' + x[2] : '') + ')');
      });

      var ostatokR = ostR();
      ostA().forEach(function (a) {
        if (!a.h || a.h.getFullYear() < gzsGodMin_()) return;           // новые строки — только акты текущего и прошлого года
        if (ostatokR.length) {
          gzsZap_(ctx, 'не разнесено', C.AKT, '', '', a.nomer, 'акт ' + a.id + ' на ' + (a.sum == null ? '?' : a.sum) +
            ' от ' + gzsPokaz_(a.h, 'd') + ': по договору несколько неразобранных строк — не понял, какая его');
          return;
        }
        var znach = [[1, planNomer[b] || a.nomer, 't'], [5, a.sum, 'n'], [6, a.f, 'd'], [8, a.h, 'd'], [17, a.id, 't']];
        var o = opl[a.id]; if (o) znach.push([10, o.data, 'd'], [11, o.sum, 'n']);
        gzsNovaya_(ctx, C.AKT, C.dAkt, [1, 5, 6, 8, 10, 11, 17], 'akt', znach, 'заказчик утвердил акт на портале (ID ' + a.id + ')');
      });
    });
    gzsUnitOk_(ctx);
    st.i++;
  }
  st.etap = 5; st.i = 0; st.sdelano = [];
}

/* ================= этап 5: лист «Аналитика» ================= */
// Таблица 1 (A:J): договоры по закупкам текущего и прошлого года, где участвовали ваши поставщики (статус «Победа»/«Проигрыш»).
// Таблица 2 (L:P): сводка по победителям. Лист служит только для чтения, скрипт пересобирает его целиком.

var GZS_AN = {list: 'Аналитика', s0: 4,
  shap1: ['№ закупки', 'Ваш поставщик', 'Заказчик', 'Т/Р/У', 'Лотов', 'Сумма объявления, тг', 'Победитель', 'Сумма договора, тг', 'Снижение, %', 'Победил ваш?'],
  shap2: ['Победитель', 'Побед', 'Сумма договоров, тг', 'Среднее снижение, %', 'Заказчики']};

function gzsEtapAnalitika_(ctx) {
  var st = ctx.st, C = GZS_CFG, pr = PropertiesService.getScriptProperties(), kesh = pr.getProperties();
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(GZS_AN.list) || ss.insertSheet(GZS_AN.list);
  var idPo = {}, imyaPo = {};
  C.post.forEach(function (p) { idPo[p.imya] = p.id; imyaPo[p.id] = p.imya; });

  // закупки из планера: № → {ваши поставщики, заказчик, Т/Р/У, срок}
  var zak = {};
  gzsList_(C.ZAK).getRange(C.dZak[0], 1, C.dZak[1] - C.dZak[0] + 1, 10).getValues().forEach(function (r) {
    var d = String(r[3]).trim(), a = String(r[0]).trim(), j = String(r[9]).trim();
    if (!d || String(r[1]).trim() !== 'ГЗ' || !idPo[a] || (j !== 'Победа' && j !== 'Проигрыш')) return;
    var srok = gzsIzYach_(r[8]);
    if (!srok || srok.getFullYear() < gzsGodMin_()) return;
    var z = zak[d] || (zak[d] = {post: [], zakazchik: String(r[4]).trim(), tru: String(r[5]).trim(), srok: r[8]});
    if (z.post.indexOf(a) < 0) z.post.push(a);
  });

  // что уже лежит на листе (данные портала не перезапрашиваем)
  var est = {}, last = sh.getLastRow();
  if (last >= GZS_AN.s0) {
    sh.getRange(GZS_AN.s0, 1, last - GZS_AN.s0 + 1, 10).getValues().forEach(function (r) {
      var d = String(r[0]).trim(); if (!d) return;
      (est[d] = est[d] || []).push({loty: r[4], obyav: r[5], pob: String(r[6]), summa: r[7], nash: String(r[9])});
    });
  }
  if (st.subj === undefined) st.subj = gzsSubjPole_(ctx);
  var polya = 'id rootId supplierId supplierFio contractSumWnds' + (st.subj ? ' Supplier{' + st.subj + ' refKopfCode}' : '');
  var nado = Object.keys(zak).filter(function (d) {
    return !est[d] && st.sdelano.indexOf(d) < 0 && gzsPora_(kesh['GZS_A_' + d], zak[d].srok);
  });
  while (nado.length) {
    var pachka = nado.splice(0, C.pachka);
    var otv = gzsZapros_(ctx, '{' + pachka.map(function (d, j) {
      return 't' + j + ':TrdBuy(filter:{numberAnno:"' + d + '"}){totalSum countLots} ' +
             'c' + j + ':Contract(filter:{trdBuyNumberAnno:"' + d + '"}){' + polya + '}';
    }).join(' ') + '}');
    var data = otv.data || {};
    if (otv.errors) gzsZap_(ctx, 'заметка', GZS_AN.list, '', '', pachka.join(', '), 'ошибка по части запроса: ' + JSON.stringify(otv.errors).slice(0, 300));
    var nov = [];
    pachka.forEach(function (d, j) {
      var tb = [].concat(data['t' + j] || [])[0] || {}, poKornyu = {};
      [].concat(data['c' + j] || []).forEach(function (c) {          // допсоглашения: берём последнюю редакцию
        var k = String(c.rootId || c.id);
        if (!poKornyu[k] || Number(c.id) > Number(poKornyu[k].id)) poKornyu[k] = c;
      });
      var dog = Object.keys(poKornyu).map(function (k) { return poKornyu[k]; });
      dog.forEach(function (c) {
        var nash = imyaPo[Number(c.supplierId)];
        var imya = nash || gzsImyaPob_(c, st.subj);
        var x = {loty: tb.countLots || '', obyav: gzsChislo_(tb.totalSum), pob: imya,
                 summa: gzsChislo_(c.contractSumWnds), nash: nash ? 'да' : 'нет'};
        (est[d] = est[d] || []).push(x);
        nov.push([d, '', '', '', x.loty, x.obyav, x.pob, x.summa, '', x.nash]);
      });
      var t = String(Date.now()); pr.setProperty('GZS_A_' + d, t); kesh['GZS_A_' + d] = t;
    });
    if (nov.length) {                                        // сразу на лист: переживёт паузу на 5-минутном лимите
      var kuda = Math.max(sh.getLastRow(), GZS_AN.s0 - 1) + 1;
      sh.getRange(kuda, 1, nov.length, 1).setNumberFormat('@');
      sh.getRange(kuda, 1, nov.length, 10).setValues(nov);
    }
    st.sdelano = st.sdelano.concat(pachka);
  }

  // таблица 1
  var vse = est;
  var t1 = [];
  Object.keys(vse).filter(function (d) { return zak[d]; }).sort().reverse().forEach(function (d) {
    var z = zak[d], dog = vse[d];
    dog.forEach(function (x) {
      var sn = '';
      if (dog.length === 1 && x.obyav > 0 && x.summa > 0) sn = Math.round((1 - x.summa / x.obyav) * 1000) / 10;
      t1.push([d, z.post.join(', '), z.zakazchik, z.tru, x.loty, x.obyav, x.pob, x.summa, sn, x.nash]);
    });
  });

  // таблица 2
  var pob = {};
  t1.forEach(function (r) {
    var p = pob[r[6]] || (pob[r[6]] = {n: 0, sum: 0, sn: [], zak: []});
    p.n++; p.sum += Number(r[7]) || 0;
    if (r[8] !== '') p.sn.push(Number(r[8]));
    if (r[2] && p.zak.indexOf(r[2]) < 0) p.zak.push(r[2]);
  });
  var t2 = Object.keys(pob).map(function (k) {
    var p = pob[k];
    var sr = p.sn.length ? Math.round(p.sn.reduce(function (a, b) { return a + b; }, 0) / p.sn.length * 10) / 10 : '';
    return [k, p.n, p.sum, sr, p.zak.join(', ')];
  }).sort(function (a, b) { return b[1] - a[1] || b[2] - a[2]; });

  // запись листа
  sh.clearContents();
  sh.getRange(1, 1).setValue('Цены победителей — закупки ' + gzsGodyPodpis_() + ', где участвовали ваши поставщики. Обновлено: ' +
    Utilities.formatDate(new Date(), gzsTz_(), 'dd.MM.yyyy HH:mm'));
  sh.getRange(1, 12).setValue('Конкуренты — кто выигрывал эти закупки');
  sh.getRange(2, 1).setValue('Снижение считается, только если по закупке один договор (при нескольких победителях лоты не разделить).');
  sh.getRange(3, 1, 1, 10).setValues([GZS_AN.shap1]).setFontWeight('bold');
  sh.getRange(3, 12, 1, 5).setValues([GZS_AN.shap2]).setFontWeight('bold');
  if (t1.length) {
    sh.getRange(GZS_AN.s0, 1, t1.length, 10).setValues(t1);
    sh.getRange(GZS_AN.s0, 1, t1.length, 1).setNumberFormat('@');
    sh.getRange(GZS_AN.s0, 6, t1.length, 1).setNumberFormat('#,##0');
    sh.getRange(GZS_AN.s0, 8, t1.length, 1).setNumberFormat('#,##0');
  }
  if (t2.length) {
    sh.getRange(GZS_AN.s0, 12, t2.length, 5).setValues(t2);
    sh.getRange(GZS_AN.s0, 14, t2.length, 1).setNumberFormat('#,##0');
  }
  gzsAnOformit_(sh, t1.length, t2.length);
  sh.setFrozenRows(3);
  st.etap = 6;
}

// границы и чередование строк под текущий размер таблиц (остальное оформление листа постоянное)
function gzsAnOformit_(sh, n1, n2) {
  sh.getBandings().forEach(function (b) { b.remove(); });
  sh.getRange(3, 1, sh.getMaxRows() - 2, 16).setBorder(false, false, false, false, false, false);
  [[1, 10, n1], [12, 5, n2]].forEach(function (t) {
    var r = sh.getRange(3, t[0], t[2] + 1, t[1]);
    r.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false)
     .setHeaderRowColor('#37546f').setFirstRowColor('#ffffff').setSecondRowColor('#f1f4f7');
    r.setBorder(true, true, true, true, true, true, '#99a6b3', SpreadsheetApp.BorderStyle.SOLID);
  });
}

// 16.11.2026: имя победителя по договору. Если название на портале без единой заглавной буквы
// (у ИП ИИН 900101404165 оно записано как «образование») — берём ФИО: «ИП Турганбекова А.С.»
function gzsImyaPob_(c, subj) {
  var s = c.Supplier || {}, nm = String((subj && s[subj]) || '').trim(), fio = String(c.supplierFio || '').trim();
  if (nm && /[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ]/.test(nm)) return nm;
  if (!fio) return nm;
  var ch = fio.split(/\s+/), kor = ch[0] + (ch.length > 1 ? ' ' + ch.slice(1).map(function (x) { return x.charAt(0) + '.'; }).join('') : '');
  return (s.refKopfCode === 'ИНД' ? 'ИП ' : '') + kor;
}

function gzsSubjPole_(ctx) {
  var t = gzsZapros_(ctx, '{__type(name:"Subject"){fields{name}}}').data.__type;
  var f = t ? t.fields.map(function (x) { return x.name; }) : [];
  return ['nameRu', 'nameKz'].filter(function (x) { return f.indexOf(x) >= 0; })[0] || '';
}

/* ================= запросы к порталу ================= */

function gzsZapros_(ctx, q) {
  var t = PropertiesService.getScriptProperties().getProperty('GZ_TOKEN');
  if (!t) throw new Error('В свойствах скрипта нет GZ_TOKEN');
  var err = '';
  for (var popytka = 1; popytka <= 3; popytka++) {
    if (Date.now() - ctx.t0 > GZS_CFG.limitMs - GZS_CFG.zapasMs) throw {gzsTimeout: true};
    var r;
    try {
      r = UrlFetchApp.fetch(GZS_CFG.url, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: {Authorization: 'Bearer ' + t}, payload: JSON.stringify({query: q})
      });
    } catch (e) { err = String(e.message || e); Utilities.sleep(3000); continue; }
    var code = r.getResponseCode(), txt = r.getContentText();
    if (code >= 500 || code === 429) { err = 'HTTP ' + code; Utilities.sleep(3000); continue; }
    var j;
    try { j = JSON.parse(txt); } catch (e) { err = 'ответ не JSON: ' + txt.slice(0, 200); Utilities.sleep(3000); continue; }
    if (code !== 200 || !j.data) throw new Error('Портал отказал (HTTP ' + code + '): ' + JSON.stringify(j.errors || j).slice(0, 500) + ' | запрос: ' + q.slice(0, 200));
    if (ctx.st) ctx.st.sboi = 0;
    return j;
  }
  throw {gzsSet: true, message: 'Портал не ответил за 3 попытки: ' + err};
}

function gzsVse_(ctx, imya, filtr, polya) {
  var vse = [], after = null;
  for (var s = 0; s < 50; s++) {
    var q = '{' + imya + '(filter:' + filtr + ', limit:' + GZS_CFG.stranica +
            (after != null ? ', after:' + after : '') + '){' + polya + '}}';
    var j = gzsZapros_(ctx, q);
    if (j.errors) throw new Error(imya + ': ' + JSON.stringify(j.errors).slice(0, 500));
    var part = [].concat(j.data[imya] || []);
    vse = vse.concat(part);
    var pi = j.extensions && j.extensions.pageInfo;
    if (pi) { if (!pi.hasNextPage) break; after = pi.lastId; }
    else { if (part.length < GZS_CFG.stranica) break; after = part[part.length - 1].id; }
    if (after == null) break;
  }
  return vse;
}

/* ================= запись в листы ================= */

// правка существующей строки; перед записью проверяет, что строка не сдвинулась (ключевая колонка)
function gzsStroka_(ctx, list, row, klKol, klZnach, izm, komm) {
  if (!izm.length) return true;
  if (ctx.st.rezhim === 'zapis') {
    var sh = gzsList_(list);
    gzsSnyatFiltr_(ctx, sh);
    if (String(sh.getRange(row, klKol).getValue()).trim() !== String(klZnach).trim()) {
      gzsZap_(ctx, 'не разнесено', list, 'строка ' + row, '', '', 'строка сдвинулась (сортировка?) — пропущено, повторится в следующий запуск');
      return false;
    }
    var ok = true;
    izm.forEach(function (x) {
      try { sh.getRange(row, x.kol).setValue(x.stalo); }
      catch (e) { ok = false; gzsZap_(ctx, 'не разнесено', list, gzsBukva_(x.kol) + row, gzsPokaz_(x.bylo, x.tip), gzsPokaz_(x.stalo, x.tip), 'не записалось: ' + e.message); }
    });
    gzsZapStroka_(ctx, list, row, izm, komm);
    return ok;
  }
  gzsZapStroka_(ctx, list, row, izm, komm);
  return true;
}

// новая строка в первую свободную; лист перечитывается непосредственно перед записью
function gzsNovaya_(ctx, list, diap, pustye, vid, znach, komm) {
  var sh = gzsList_(list), st = ctx.st;
  var vals = sh.getRange(diap[0], 1, diap[1] - diap[0] + 1, 17).getValues();
  var est = function (v) { return v !== null && v !== undefined && v !== ''; };
  for (var i = 0; i < vals.length; i++) {
    var row = diap[0] + i;
    if (st.virt[vid].indexOf(row) >= 0) continue;
    if (!pustye.every(function (k) { return gzsKl_(vals[i][k - 1], 't') === ''; })) continue;
    if (st.rezhim === 'zapis') {
      gzsSnyatFiltr_(ctx, sh);
      znach.forEach(function (z) {
        if (!est(z[1])) return;
        try { sh.getRange(row, z[0]).setValue(z[1]); }
        catch (e) { gzsZap_(ctx, 'не разнесено', list, gzsBukva_(z[0]) + row, '', gzsPokaz_(z[1], z[2]), 'не записалось: ' + e.message); }
      });
    } else {
      st.virt[vid].push(row);
    }
    gzsZapNovaya_(ctx, list, row, znach.filter(function (z) { return est(z[1]); }), komm);
    st.n.nov++;
    return row;
  }
  gzsZap_(ctx, 'не разнесено', list, '', '', '', 'нет свободных строк ' + diap.join('–') + ': ' + komm);
  return 0;
}

function gzsIzm_(izm, kol, bylo, stalo, tip) {
  if (stalo === null || stalo === undefined || stalo === '') return;
  if (gzsKl_(bylo, tip) !== gzsKl_(stalo, tip)) izm.push({kol: kol, bylo: bylo, stalo: stalo, tip: tip});
}

var GZS_RUCHNYE = ['Расторгнут', 'Приостановлен', 'Спор'];   // эти статусы скрипт не перезаписывает

function gzsStatus_(k) {
  k = Number(k);
  if (k === 190) return 'Исполняется';
  if (k === 390 || k === 375 || k === 455) return 'Исполнен';
  return null;
}

function gzsDogStroki_() {
  var C = GZS_CFG, m = {};
  gzsList_(C.DOG).getRange(C.dDog[0], 1, C.dDog[1] - C.dDog[0] + 1, 9).getValues().forEach(function (r, i) {
    var e = String(r[4]).trim(); if (!e) return;
    var b = gzsBaza_(e);
    if (!m[b]) m[b] = {row: C.dDog[0] + i, nomer: e, i: String(r[8]).trim(), f: r[5], g: r[6]};
  });
  return m;
}

// по договорам поставщика: в «Закупках» T = дата проекта (если пусто), P = поставщик (если пусто), J = «Победа»
// 13.11.2026: J = «Победа» при любом текущем значении (раньше «Не участвуем/Отменена/Отклонена» не трогались)
// 18.11.2026: «Изучаем»/«Готовим» → «Победа» только по ПОДПИСАННОМУ договору (signDate); иначе ставится только T
function gzsZakPoDogovoram_(ctx, p, spisok) {
  var C = GZS_CFG, sh = gzsList_(C.ZAK), s0 = C.dZak[0];
  var vals = sh.getRange(s0, 1, C.dZak[1] - s0 + 1, 20).getValues();
  var poZak = {}, podp = {};
  spisok.forEach(function (c) {
    var nz = String(c.trdBuyNumberAnno || '').trim(); if (!nz) return;
    var d = gzsData_(c.crdate, false);
    if (!poZak.hasOwnProperty(nz) || (d && (!poZak[nz] || d < poZak[nz]))) poZak[nz] = d;
    if (c.signDate) podp[nz] = true;
  });
  vals.forEach(function (r, i) {
    var d = String(r[3]).trim();
    if (!poZak.hasOwnProperty(d) || String(r[0]).trim() !== p.imya || String(r[1]).trim() !== 'ГЗ') return;
    var izm = [], j = String(r[9]).trim(), rano = (j === 'Изучаем' || j === 'Готовим') && !podp[d];
    if (poZak[d] && gzsKl_(r[19], 't') === '') gzsIzm_(izm, 20, r[19], poZak[d], 'd');
    if (!rano) {
      if (gzsKl_(r[15], 't') === '') gzsIzm_(izm, 16, r[15], p.imya, 't');
      gzsIzm_(izm, 10, r[9], 'Победа', 't');
    }
    gzsStroka_(ctx, C.ZAK, s0 + i, 4, d, izm, rano
      ? 'на портале проект договора с ' + p.imya + ' (ещё не подписан) — статус «' + j + '» не меняю'
      : 'на портале есть договор с ' + p.imya);
  });
}

function gzsDogovoryPlanera_() {
  var C = GZS_CFG, m = {};
  gzsList_(C.DOG).getRange(C.dDog[0], 5, C.dDog[1] - C.dDog[0] + 1, 1).getValues().forEach(function (r) {
    var e = String(r[0]).trim(); if (e && !m[gzsBaza_(e)]) m[gzsBaza_(e)] = e;
  });
  return m;
}

/* ================= фильтры ================= */

function gzsSnyatFiltr_(ctx, sh) {
  var nm = sh.getName();
  if (ctx.filtry.hasOwnProperty(nm)) return;
  var f = sh.getFilter();
  if (!f) { ctx.filtry[nm] = null; return; }
  var rng = f.getRange(), c0 = rng.getColumn(), crit = [];
  for (var c = c0; c < c0 + rng.getNumColumns(); c++) {
    var k = f.getColumnFilterCriteria(c); if (k) crit.push([c, k]);
  }
  ctx.filtry[nm] = {sh: sh, a1: rng.getA1Notation(), crit: crit};
  f.remove();
}

function gzsVernutFiltry_(ctx) {
  Object.keys(ctx.filtry).forEach(function (nm) {
    var x = ctx.filtry[nm]; if (!x) return;
    try {
      if (x.sh.getFilter()) return;
      var f = x.sh.getRange(x.a1).createFilter();
      x.crit.forEach(function (p) { f.setColumnFilterCriteria(p[0], p[1]); });
    } catch (e) { gzsZap_(ctx, 'ошибка', nm, '', '', '', 'фильтр не вернулся: ' + e.message); gzsUnitOk_(ctx); }
  });
}

/* ================= журнал ================= */

// Журнал: 4 колонки «Когда | Что | Было → Стало | Почему», новые записи сверху.
// ⚠ — не смог разнести / ошибка (красный), ℹ — заметка (жёлтый), «Итог обновления» — голубой.

var GZS_KLYUCH = {                       // какие колонки строки описывают её в журнале: поставщик, номер, заказчик
  '2. Закупки': [1, 4, 5, ''],
  '3. Договоры': [2, 5, 3, ''],
  '4. Акты и оплата': [2, 1, 3, 'договор ']
};

function gzsKogda_(ctx) {
  return Utilities.formatDate(new Date(), gzsTz_(), 'dd.MM.yyyy HH:mm') +
         (ctx.st && ctx.st.rezhim !== 'zapis' ? ' (проба)' : '');
}

function gzsKorotko_(list) { return String(list || '').replace(/^\d+\.\s*/, ''); }

// шапка и строки листа — читаются один раз за запуск
function gzsListKesh_(ctx, list) {
  ctx.kk = ctx.kk || {};
  if (!ctx.kk[list]) {
    var sh = SpreadsheetApp.getActive().getSheetByName(list), n = 0;
    if (sh) n = Math.min(sh.getMaxRows(), 410);
    ctx.kk[list] = sh ? {hdr: sh.getRange(4, 1, 1, 21).getValues()[0], vals: sh.getRange(1, 1, n, 21).getValues()}
                      : {hdr: [], vals: []};
  }
  return ctx.kk[list];
}

function gzsKolImya_(ctx, list, kol) {
  var h = gzsListKesh_(ctx, list).hdr[kol - 1];
  return h ? String(h).replace(/\s+/g, ' ').trim() : 'колонка ' + gzsBukva_(kol);
}

// «Договоры, стр. 65 — ИП Байжанов, 080940004108/260629/00 (Алматы Су)»
function gzsChto_(ctx, list, row) {
  var t = gzsKorotko_(list) + (row ? ', стр. ' + row : '');
  var k = GZS_KLYUCH[list];
  if (!k || !row) return t;
  var r = gzsListKesh_(ctx, list).vals[row - 1] || [];
  var post = String(r[k[0] - 1] || '').trim(), nom = String(r[k[1] - 1] || '').trim(), zk = String(r[k[2] - 1] || '').trim();
  var d = [post, nom ? k[3] + nom : ''].filter(String).join(', ') + (zk ? ' (' + zk + ')' : '');
  return d ? t + ' — ' + d : t;
}

function gzsZap_(ctx, tip, list, yach, bylo, stalo, komm) {
  if (tip === 'пауза') return;                                   // технические паузы в журнал не пишем
  if (ctx.st && tip === 'не разнесено') ctx.st.n.ner++;
  var chto, bs = '';
  var m = String(yach || '').match(/^([A-Z]+)(\d+)$/), m2 = String(yach || '').match(/^строка (\d+)$/);
  if (m) {
    var kol = m[1].charCodeAt(0) - 64;
    chto = gzsChto_(ctx, list, Number(m[2])) + ', «' + gzsKolImya_(ctx, list, kol) + '»';
    if (bylo !== '' || stalo !== '') bs = (bylo === '' ? 'пусто' : bylo) + ' → ' + (stalo === '' ? 'пусто' : stalo);
  } else if (m2) {
    chto = gzsChto_(ctx, list, Number(m2[1]));
  } else {
    chto = gzsKorotko_(list) + (stalo !== '' && stalo != null ? (list ? ' — ' : '') + stalo : '');
  }
  if (tip === 'итог') chto = 'Итог обновления';
  if (tip === 'не разнесено' || tip === 'ошибка') chto = '⚠ ' + (tip === 'ошибка' ? 'Ошибка. ' : 'Не разнесено. ') + chto;
  if (tip === 'заметка') chto = 'ℹ ' + chto;
  ctx.unit.push([gzsKogda_(ctx), chto, bs, String(komm || '')]);
}

// одна запись на строку листа, все изменённые колонки — в «Было → Стало»
function gzsZapStroka_(ctx, list, row, izm, komm) {
  if (ctx.st) ctx.st.n.pr += izm.length;
  var bs = izm.map(function (x) {
    var b = gzsPokaz_(x.bylo, x.tip), s = gzsPokaz_(x.stalo, x.tip);
    return gzsKolImya_(ctx, list, x.kol) + ': ' + (b === '' ? 'пусто' : b) + ' → ' + s;
  }).join('\n');
  ctx.unit.push([gzsKogda_(ctx), gzsChto_(ctx, list, row), bs, String(komm || '')]);
}

function gzsZapNovaya_(ctx, list, row, znach, komm) {
  var bs = znach.map(function (z) { return gzsKolImya_(ctx, list, z[0]) + ': ' + gzsPokaz_(z[1], z[2]); }).join('\n');
  ctx.unit.push([gzsKogda_(ctx), gzsKorotko_(list) + ', стр. ' + row + ' — новая строка', bs, String(komm || '')]);
}

function gzsUnitOk_(ctx) { ctx.log = ctx.log.concat(ctx.unit); ctx.unit = []; }

function gzsZhurnalList_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(GZS_CFG.ZH) || ss.insertSheet(GZS_CFG.ZH);
  var need = GZS_CFG.zhKol + 7;
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  return sh;
}

function gzsZhurnalDopisat_(rows) {
  if (!rows.length) return;
  var C = GZS_CFG, sh = gzsZhurnalList_(), k = C.zhKol, max = sh.getMaxRows();
  var shap = sh.getRange(1, k, 1, 2).getValues()[0];
  if (shap[0] !== 'Когда' || shap[1] !== 'Что') {                // первый запуск нового формата: старый журнал убрать
    sh.getRange(1, k, max, 8).clear();
    sh.getRange(1, k, 1, 4).setValues([['Когда', 'Что', 'Было → Стало', 'Почему']])
      .setFontWeight('bold').setBackground('#37546f').setFontColor('#ffffff');
    [130, 430, 320, 320].forEach(function (w, i) { sh.setColumnWidth(k + i, w); });
  }
  var staroe = sh.getRange(2, k, max - 1, 4).getValues().filter(function (r) { return r[0] !== ''; });
  var vse = rows.slice().reverse().concat(staroe).slice(0, C.zhStrok);
  if (vse.length + 1 > max) { sh.insertRowsAfter(max, vse.length + 1 - max + 200); max = sh.getMaxRows(); }
  if (staroe.length) sh.getRange(2, k, staroe.length, 4).clearContent();
  var rng = sh.getRange(2, k, vse.length, 4);
  rng.setNumberFormat('@').setValues(vse).setWrap(true).setVerticalAlignment('top');
  rng.setBackgrounds(vse.map(function (r) {
    var c = String(r[1]).charAt(0) === '⚠' ? '#fde2e1' : String(r[1]).charAt(0) === 'ℹ' ? '#fff4d6'
          : r[1] === 'Итог обновления' ? '#e8eef5' : '#ffffff';
    return [c, c, c, c];
  }));
}

/* ================= мелочи ================= */

function gzsBaza_(n) { return String(n).trim().replace(/\/[^\/]*$/, ''); }
function gzsHvost_(n) { var m = String(n).trim().match(/\/(\d+)$/); return m ? Number(m[1]) : 0; }
function gzsTz_() { return Session.getScriptTimeZone(); }

// Годы. Текущий берётся из даты, обрабатываются текущий и прошлый год (но не раньше god0).
// Договоры дополнительно запрашиваются за следующий финансовый год: их подписывают в конце года.
var GZS_GOD_TEK_ = 0;
function gzsGodTek_() {
  if (!GZS_GOD_TEK_) GZS_GOD_TEK_ = Number(Utilities.formatDate(new Date(), gzsTz_(), 'yyyy'));
  return GZS_GOD_TEK_;
}
function gzsGodMin_() { return Math.max(GZS_CFG.god0, gzsGodTek_() - 1); }
function gzsGodyDog_() { var a = []; for (var y = gzsGodMin_(); y <= gzsGodTek_() + 1; y++) a.push(y); return a; }
function gzsGodyPodpis_() { var a = gzsGodMin_(), b = gzsGodTek_(); return a === b ? b + ' г.' : a + '–' + b + ' гг.'; }

// договоры поставщика за все нужные финансовые годы, без повторов (по id)
function gzsDogovoryPost_(ctx, id, polya) {
  var vse = [], byl = {};
  gzsGodyDog_().forEach(function (y) {
    gzsVse_(ctx, 'Contract', '{supplierId:' + id + ', finYear:' + y + '}', polya).forEach(function (c) {
      var k = String(c.id);
      if (!byl[k]) { byl[k] = 1; vse.push(c); }
    });
  });
  return vse;
}
function gzsBukva_(k) { return String.fromCharCode(64 + k); }
function gzsList_(nm) {
  var sh = SpreadsheetApp.getActive().getSheetByName(nm);
  if (!sh) throw new Error('Нет листа «' + nm + '»');
  return sh;
}

// дата из ответа портала: "2026-10-27", "2026-10-27 14:00:00", "2026-10-27T14:00:00+05:00"
function gzsData_(s, sVremenem) {
  if (!s) return null;
  var m = String(s).match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return sVremenem
    ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0))
    : new Date(+m[1], +m[2] - 1, +m[3]);
}

// дата из ячейки: Date или строка "ДД.ММ.ГГГГ[ ЧЧ:ММ]"
function gzsIzYach_(v) {
  if (v instanceof Date) return v;
  var m = String(v || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) : null;
}

function gzsChislo_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v).replace(/[\s ]/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// ключ для сравнения «было/стало»
function gzsKl_(v, tip) {
  if (v === null || v === undefined || v === '') return '';
  if (tip === 'n') { var n = gzsChislo_(v); return n == null ? '' : String(Math.round(n * 100)); }
  if (tip === 'd' || tip === 'dt') {
    var d = gzsIzYach_(v);
    return d ? Utilities.formatDate(d, gzsTz_(), tip === 'd' ? 'dd.MM.yyyy' : 'dd.MM.yyyy HH:mm') : String(v).trim();
  }
  return String(v).trim();
}

function gzsPokaz_(v, tip) {
  if (v === null || v === undefined || v === '') return '';
  if (tip === 'n') {
    var n = gzsChislo_(v); if (n == null) return String(v);
    var s = (Math.round(n * 100) / 100).toFixed(n % 1 ? 2 : 0).split('.');
    return s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (s[1] ? ',' + s[1] : '');
  }
  return gzsKl_(v, tip);
}

function gzsToast_(m) { try { SpreadsheetApp.getActive().toast(m, 'Планер · ГЗ', 5); } catch (e) {} }

function gzsUdalitTriggery_(fn) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
}

function gzsPostavitProdolzhenie_(minut) {
  gzsUdalitTriggery_('gzsProdolzhit');
  ScriptApp.newTrigger('gzsProdolzhit').timeBased().after((minut || 1) * 60 * 1000).create();
}
