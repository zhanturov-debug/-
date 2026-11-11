/**
 * Разведка: можно ли через API ГЗ найти закупки, где победил наш поставщик, без договора.
 * Только ЧТЕНИЕ API. Пишет только в «Сверка ГЗ»!AD:AE, в свободные строки ниже уже заполненных.
 * gz_sinhron.gs не меняет и не вызывает. Запуск: gzrRazvedkaPobed.
 */
var GZR_URL = 'https://ows.goszakup.gov.kz/v3/graphql';
var GZR_PRIMER = 17930913;            // проверочная закупка (ЗЦП, ИП Канаева)
var GZR_LIST = 'Сверка ГЗ';
var GZR_TREF = 'kind name ofType{kind name ofType{kind name ofType{kind name}}}';
var GZR_SLOVA = /prot|itog|win|result|offer|app|bid|propos|comm|cancel|supplier|particip|score|decision|contract/i;
var GZR_PROPUSK = ['TrdBuy', 'Plans', 'Customer', 'Organizer', 'Lots_TrdBuy'];
var gzrTipy_ = {};

function gzrRazvedkaPobed() {
  var t0 = Date.now();
  var out = [['Разведка побед ' + Utilities.formatDate(new Date(), 'Asia/Almaty', 'dd.MM.yyyy HH:mm'), '']];

  // 1. Корневые запросы схемы с аргументами
  var r = gzrQ_('{__schema{queryType{fields{name args{name type{' + GZR_TREF + '}} type{' + GZR_TREF + '}}} types{name kind}}}');
  if (!r.data) { out.push(['ОШИБКА схемы', gzrS_(r)]); return gzrPishi_(out); }
  var koren = r.data.__schema.queryType.fields;
  var filtry = {};
  koren.forEach(function (f) {
    var args = f.args.map(function (a) { return a.name + ':' + gzrIm_(a.type); });
    f.args.forEach(function (a) { if (a.name === 'filter') filtry[f.name] = gzrIm_(a.type); });
    out.push(['корень: ' + f.name, '(' + args.join(', ') + ') → ' + gzrIm_(f.type)]);
  });

  // 2. Типы по ключевым словам (протоколы, итоги, победители, заявки, комиссия…) и фильтры корней
  var imena = r.data.__schema.types
    .filter(function (t) { return t.name.indexOf('__') !== 0 && GZR_SLOVA.test(t.name); })
    .map(function (t) { return t.name; });
  Object.keys(filtry).forEach(function (k) { if (imena.indexOf(filtry[k]) < 0) imena.push(filtry[k]); });
  imena.slice(0, 60).forEach(function (n) {
    var t = gzrTip_(n);
    if (!t) return;
    var polya = (t.fields || t.inputFields || []).map(function (f) { return f.name + ':' + gzrIm_(f.type); });
    out.push(['тип ' + n + ' (' + t.kind + ')', polya.join(' ')]);
  });

  // 3. Живые запросы по проверочной закупке
  var nomer = GZR_PRIMER + '-1';
  [['TrdBuy', {numberAnno: nomer, id: GZR_PRIMER}],
   ['Lots', {trdBuyNumberAnno: nomer, trdBuyId: GZR_PRIMER}],
   ['Contract', {trdBuyNumberAnno: nomer, trdBuyId: GZR_PRIMER}]].forEach(function (z) {
    var koren1 = z[0];
    if (!filtry[koren1]) { out.push([koren1 + ' ' + nomer, 'нет корня/фильтра в схеме']); return; }
    var ft = gzrTip_(filtry[koren1]);
    var sel = gzrSel_(gzrIm_(koren.filter(function (f) { return f.name === koren1; })[0].type), 1);
    Object.keys(z[1]).forEach(function (pole) {
      if (Date.now() - t0 > 270000) return;
      var vf = (ft.inputFields || []).filter(function (f) { return f.name === pole; })[0];
      if (!vf) { out.push([koren1 + ' по ' + pole, 'в фильтре нет поля ' + pole]); return; }
      var q = '{' + koren1 + '(filter:{' + pole + ':' + gzrLit_(vf.type, z[1][pole]) + '}){' + sel + '}}';
      gzrDobav_(out, koren1 + ' по ' + pole + '=' + z[1][pole], gzrS_(gzrQ_(q)));
    });
  });

  gzrPishi_(out);
}

// ---------- помощники ----------
function gzrQ_(q) {
  var tok = PropertiesService.getScriptProperties().getProperty('GZ_TOKEN');
  var resp = UrlFetchApp.fetch(GZR_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: {Authorization: 'Bearer ' + tok}, payload: JSON.stringify({query: q})
  });
  var txt = resp.getContentText();
  try { var j = JSON.parse(txt); } catch (e) { return {errors: ['HTTP ' + resp.getResponseCode() + ': ' + txt.slice(0, 500)]}; }
  return j;
}
function gzrS_(r) { return JSON.stringify(r.errors ? {data: r.data, errors: r.errors} : r.data); }
function gzrIm_(t) { while (t && !t.name) t = t.ofType; return t ? t.name : '?'; }
function gzrSpisok_(t) { while (t) { if (t.kind === 'LIST') return true; t = t.ofType; } return false; }
function gzrTip_(n) {
  if (gzrTipy_[n] !== undefined) return gzrTipy_[n];
  var r = gzrQ_('{__type(name:"' + n + '"){name kind fields{name args{name type{' + GZR_TREF + '}} type{' + GZR_TREF +
    '}} inputFields{name type{' + GZR_TREF + '}}}}');
  gzrTipy_[n] = (r.data && r.data.__type) || null;
  return gzrTipy_[n];
}
function gzrBazKind_(t) { while (t.ofType) t = t.ofType; return t.kind; }
function gzrSel_(tipN, glub) {
  var t = gzrTip_(tipN);
  if (!t || !t.fields) return '';
  var ch = [];
  t.fields.forEach(function (f) {
    if (f.args.some(function (a) { return a.type.kind === 'NON_NULL'; })) return;
    var k = gzrBazKind_(f.type);
    if (k === 'SCALAR' || k === 'ENUM') ch.push(f.name);
    else if (k === 'OBJECT' && glub > 0 && GZR_PROPUSK.indexOf(f.name) < 0) {
      var s = gzrSel_(gzrIm_(f.type), glub - 1);
      if (s) ch.push(f.name + '{' + s + '}');
    }
  });
  return ch.join(' ');
}
function gzrLit_(t, v) {
  var bn = gzrIm_(t), lit = (bn === 'String' || bn === 'ID') ? JSON.stringify(String(v)) : String(v);
  return gzrSpisok_(t) ? '[' + lit + ']' : lit;
}
function gzrDobav_(out, k, s) {
  for (var i = 0, n = 1; i < s.length; i += 45000, n++) out.push([k + (s.length > 45000 ? ' ч.' + n : ''), s.slice(i, i + 45000)]);
}
function gzrPishi_(out) {
  var sh = SpreadsheetApp.getActive().getSheetByName(GZR_LIST);
  var last = sh.getLastRow(), vals = last ? sh.getRange(1, 30, last, 2).getValues() : [];
  var start = 1;
  for (var i = vals.length - 1; i >= 0; i--) if (vals[i][0] !== '' || vals[i][1] !== '') { start = i + 3; break; }
  // перечитать перед записью: диапазон AD:AE должен быть пуст
  var tgt = sh.getRange(start, 30, out.length, 2);
  var busy = tgt.getValues().some(function (r) { return r[0] !== '' || r[1] !== ''; });
  if (busy) throw new Error('AD' + start + ':AE' + (start + out.length - 1) + ' не пуст — запись отменена');
  tgt.setValues(out);
  SpreadsheetApp.getActive().toast('Разведка: ' + out.length + ' строк с AD' + start, 'ГЗ', 10);
}
