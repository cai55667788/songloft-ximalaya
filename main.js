'use strict';
// 喜马拉雅插件 for Songloft v0.9.0
// 能力：
//   ① 关键词搜索专辑（多源：完整搜索 → 登录态移动搜索 → 联想词扩展聚合）
//   ② 专辑详情页（封面/作者/简介/分集列表）+ 单集在线试听
//   ③ 导入为歌单（支持区间、多专辑合并/分别导入）
//   ④ 订阅 + 增量更新（只拉新增集数追加到原歌单）
//   ⑤ 定时自动同步（每天到点检查订阅并追加新集，可推送到音箱）
//   ⑥ 登录后可读取「我订阅的专辑」并一键导入/订阅（v0.5.0）
//   ⑦ 扫码登录：手机喜马拉雅 APP 扫一扫直接登录，无需手动复制 Cookie（v0.6.0）
//   ⑧ 听书播放器：断点续播、整页连播、倍速、睡眠定时、已听标记（v0.7.0）
//   ⑨ 最近收听聚合、跨页自动连播、导入时写入主播名（v0.8.0）
//   ⑩ 跨设备收听进度：进度/最后收听存到 NAS 端，换设备接着听（v0.9.0）
//   ⑪ 定时语音播报：每天到点同步订阅，有新集就用音箱 TTS 播报（v0.9.0）
//   ⑫ 单集（声音）搜索：直接搜某一集，可单集试听或加进歌单（v0.9.0）
//   ⑬ 整本下载：把歌单里的集数下载到 Songloft 本地音乐目录（v0.9.0）
// 数据源（公开接口，免登录）：
//   专辑详情: GET https://www.ximalaya.com/revision/album/v1/simple?albumId={id}
//   专辑曲目: GET https://www.ximalaya.com/revision/play/v1/show?id={id}&num={page}&size=30&ptype=0
//   单集直链: GET https://m.ximalaya.com/tracks/{trackId}.json → play_path_64/32
//   搜索:     GET /revision/search/main（WAF 风控）/revision/suggest（可用）
//   搜索（单集）: GET https://www.ximalaya.com/revision/search?core=track&kw=&page=&rows=
//   登录态:   GET /revision/main/getCurrentUser、/revision/my/getSubscriptionSynthesize 等（需 Cookie）
//   扫码登录: GET /passport/qrcode/gen?level=L → {qrId, img}；GET /passport/qrcode/check/{qrId}/{ts} → Set-Cookie 1&_token

var VERSION = '0.23.2';
var ENTRY = 'ximalaya';
var MIOT_ENTRY = 'miot';
var CFG_KEY = 'config:v1';
var LIB_KEY = 'imported:v1';
var JOB_KEY = 'import_job:v1';
var WATCH_KEY = 'watch:v1';
var LOGIN_KEY = 'login:v1';
var SUB_KEY = 'subs:v1';
var PROG_KEY = 'progress:v1';
var STAT_KEY = 'stats:v1';
var DL_KEY = 'download_job:v1';
var COOKIE_CHK_KEY = 'cookie_check:v1';
var UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
var UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
var PAGE_SIZE = 30;
var MAX_PAGES = 60;        // 单次导入最多拉 60 页（约 1800 集）
var BATCH = 200;           // 单批建歌上限
var SYNC_MAX_PAGES = 25;   // 增量同步最多回溯 25 页

var config = {
  auto: { enabled: false, time: '08:30', lastRunDate: '' },
  sync: { progress: true },
  dl: { targetDir: '喜马拉雅', format: 'mp3' },
  // 每天检查一次登录态是否还有效，失效时界面上直接提醒
  cookieCheck: true
};
var imported = [];   // [{albumId, name, playlistId, count, importedAt}]
var subs = [];       // [{albumId, name, playlistId, lastIndex, songCount, cover, author, updateDate, lastCheckAt, newCount, newTitles, autoSync}]
var job = { running: false, mode: '', title: '', done: 0, total: 0, playlistId: 0, error: '', finishedAt: '', current: '', parts: [] };
var dlJob = { running: false, playlistId: 0, title: '', done: 0, total: 0, ok: 0, fail: 0, current: '', error: '', finishedAt: '', targetDir: '', cancel: false };
var watch = { items: [], job: { running: false, at: '', added: 0, msg: '' } };
var progress = { tracks: {}, albums: {}, at: '' };
var login = { cookie: '', savedAt: '' };
var lastSync = { at: '', result: '', trigger: '' };
var syncing = false;
var importing = false;
var downloading = false;
var tickTimer = null;

// ---------- 基础工具 ----------

function utf8Decode(bytes) {
  if (bytes == null) return '';
  if (typeof bytes === 'string') return bytes;
  var out = '', i = 0, n = bytes.length;
  while (i < n) {
    var b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
    else if (b < 0xE0) { out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2; }
    else if (b < 0xF0) {
      out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F));
      i += 3;
    } else {
      var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      cp -= 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      i += 4;
    }
  }
  return out;
}

function jsonResp(obj, code) {
  return { statusCode: code || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}

function readBodyJson(req) {
  try {
    var s = utf8Decode(req.body);
    return s ? JSON.parse(s) : {};
  } catch (e) { return {}; }
}

// 宿主不同版本 req.query 可能是字符串或对象，统一成对象
function parseQuery(req) {
  var q = req && req.query;
  if (!q) return {};
  if (typeof q === 'object') return q;
  var out = {};
  String(q).split('&').forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf('=');
    var k = i < 0 ? kv : kv.slice(0, i);
    var v = i < 0 ? '' : kv.slice(i + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { out[k] = v; }
  });
  return out;
}

// v0.22.4：超时要能真正中断请求（原来 Promise.race 只让调用方放弃，底层连接还挂着，
// 反复超时会堆积连接、拖慢后续请求）。有 AbortController 就 abort，没有就退回竞速。
function fetchT(url, init, timeoutSec) {
  var ms = Math.max(1000, (Number(timeoutSec) || 15) * 1000);
  var ctl = null;
  try { ctl = new AbortController(); } catch (e0) { ctl = null; }
  var opt = Object.assign({}, init || {});
  if (ctl) opt.signal = ctl.signal;
  return new Promise(function (resolve, reject) {
    var done = false;
    var tm = setTimeout(function () {
      if (done) return;
      done = true;
      try { if (ctl) ctl.abort(); } catch (e1) { /* */ }
      reject(new Error('timeout'));
    }, ms);
    fetch(url, opt).then(function (r) {
      if (done) return;
      done = true; clearTimeout(tm); resolve(r);
    }, function (e2) {
      if (done) return;
      done = true; clearTimeout(tm); reject(e2);
    });
  });
}

// ---------- 事件日志（环形缓冲，最近 100 条） ----------
// 目的：出问题时不用 SSH 翻宿主日志，界面上就能看到「什么时候、哪一步、什么错」。
var LOG_KEY = 'logs:v1';
var LOG_MAX = 100;
var logBuf = [];      // [{t, lv, tag, msg}]，新的在前

function logPush(level, tag, msg) {
  try {
    var e = { t: Date.now(), lv: level, tag: String(tag || ''), msg: String(msg || '').slice(0, 300) };
    logBuf.unshift(e);
    if (logBuf.length > LOG_MAX) logBuf.length = LOG_MAX;
    // 只把 warn/error 落盘，info 留在内存里，避免频繁写存储
    if (level !== 'info') persistLogs();
    if (level === 'error') { try { songloft.log.error('[喜马拉雅] ' + e.tag + ' ' + e.msg); } catch (e1) { /* */ } }
  } catch (e2) { /* */ }
}

function logInfo(tag, msg) { logPush('info', tag, msg); }
function logWarn(tag, msg) { logPush('warn', tag, msg); }
function logErr(tag, msg) { logPush('error', tag, msg); }

var logTimer = null;
function persistLogs() {
  if (logTimer) return;
  logTimer = setTimeout(function () {
    logTimer = null;
    // 只落盘 warn/error（最多 60 条），info 不落盘
    var keep = logBuf.filter(function (e) { return e.lv !== 'info'; }).slice(0, 60);
    try { songloft.storage.set(LOG_KEY, JSON.stringify(keep)); } catch (e) { /* */ }
  }, 1500);
}

function logList(limit, level) {
  var arr = logBuf;
  if (level && level !== 'all') arr = arr.filter(function (e) { return e.lv === level; });
  return arr.slice(0, Math.max(1, Math.min(Number(limit) || 100, LOG_MAX)));
}

function logClear() {
  logBuf = [];
  try { songloft.storage.set(LOG_KEY, '[]'); } catch (e) { /* */ }
}

// ---------- 带重试的请求 ----------
// 喜马拉雅接口偶发抖动（连接重置 / 502 / 超时），单次失败不该让整条流程挂掉。
// 只对可重试的情况重试：网络错误、timeout、5xx、429；4xx（尤其 403 风控）直接抛，重试只会更糟。
function isRetryableStatus(code) {
  return code === 429 || (code >= 500 && code <= 599);
}

// v0.22.4：并发闸门——同步/预取一次发几十个请求时，容易被 WAF 拦或把家用宽带的
// NAT 会话打满。这里全局最多 6 个在途，其余排队。
var NET_MAX = 6, netActive = 0, netWait = [];
function netAcquire() {
  if (netActive < NET_MAX) { netActive++; return Promise.resolve(); }
  return new Promise(function (res) { netWait.push(res); });
}
function netRelease() {
  netActive = Math.max(0, netActive - 1);
  if (netWait.length) { netActive++; var nxt = netWait.shift(); nxt(); }
}

// v0.22.4：熔断——同一主机连续失败 5 次就快速失败 20 秒。
// 以前断网时每个操作都要干等 2×15s，界面像卡死；现在 20 秒内直接报「网络暂时不可用」。
var netBreaker = {};
function netHost(url) {
  var m = String(url || '').match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1].toLowerCase() : 'unknown';
}
function netBreakerCheck(host) {
  var b = netBreaker[host];
  if (b && b.until > Date.now()) {
    throw new Error('网络暂时不可用，' + Math.ceil((b.until - Date.now()) / 1000) + ' 秒后自动重试');
  }
}
function netBreakerFail(host) {
  var b = netBreaker[host] || (netBreaker[host] = { fail: 0, until: 0 });
  if (b.until > Date.now()) return;
  b.fail++;
  if (b.fail >= 5) {
    b.fail = 0;
    b.until = Date.now() + 20000;
    logWarn('net', host + ' 连续失败 5 次，暂停请求 20 秒');
  }
}
function netBreakerOk(host) {
  var b = netBreaker[host];
  if (b && (b.fail || b.until)) { b.fail = 0; b.until = 0; }
}

async function fetchRetry(url, init, opts) {
  var o = opts || {};
  var tries = Math.max(1, Math.min(Number(o.retries) === undefined ? 3 : Number(o.retries), 4));
  var timeoutSec = Number(o.timeout) || 15;
  var base = Number(o.backoff) || 600;
  var host = netHost(url);
  var lastErr = null;
  if (!o.noGate) await netAcquire();   // noGate：本机回环调用可豁免闸门
  try {
    for (var i = 0; i < tries; i++) {
      netBreakerCheck(host);
      try {
        var resp = await fetchT(url, init, timeoutSec);
        if (resp && resp.ok) { netBreakerOk(host); return resp; }
        if (resp && isRetryableStatus(resp.status) && i < tries - 1) {
          lastErr = new Error('HTTP ' + resp.status);
          logWarn('net', 'HTTP ' + resp.status + '，第 ' + (i + 1) + ' 次重试：' + shortUrl(url));
        } else {
          netBreakerOk(host);   // 4xx 是接口层面的问题，不算网络故障
          return resp;
        }
      } catch (e) {
        lastErr = e;
        var m = String(e && e.message || e);
        if (m.indexOf('网络暂时不可用') >= 0) throw e;
        if (i < tries - 1) logWarn('net', m + '，第 ' + (i + 1) + ' 次重试：' + shortUrl(url));
        else { netBreakerFail(host); break; }
      }
      // 退避带抖动：多个请求同时重试时错开，避免又撞在一起
      await sleepMs(Math.round(base * Math.pow(2, i) * (0.7 + Math.random() * 0.6)));
    }
    throw lastErr || new Error('请求失败');
  } finally {
    if (!o.noGate) netRelease();
  }
}

function shortUrl(u) {
  var s = String(u || '');
  var i = s.indexOf('?');
  return (i > 0 ? s.slice(0, i) : s).slice(0, 90);
}

function sleepMs(ms) {
  return new Promise(function (r) { setTimeout(r, Math.max(0, Number(ms) || 0)); });
}

// v0.22.4：GET 结果短缓存（15 秒）。翻回上一页、重复点同一集、同一页面被轮询时
// 不再重复打网络 —— 既快也更抗抖动。
var NET_CACHE = {}, NET_CACHE_TTL = 15000, NET_CACHE_MAX = 80, netCacheN = 0;
function netCacheKey(url, headers) {
  return String(url) + '|' + ((headers && headers.Cookie) ? 'L' : 'A');
}
function netCacheGet(k) {
  var c = NET_CACHE[k];
  if (!c) return null;
  if (Date.now() - c.at > NET_CACHE_TTL) { delete NET_CACHE[k]; netCacheN = Math.max(0, netCacheN - 1); return null; }
  return c.data;
}
function netCachePut(k, data) {
  if (!NET_CACHE[k]) netCacheN++;
  NET_CACHE[k] = { at: Date.now(), data: data };
  if (netCacheN > NET_CACHE_MAX) {
    var keys = Object.keys(NET_CACHE);
    for (var i = 0; i < keys.length && netCacheN > NET_CACHE_MAX; i++) {
      if (Date.now() - NET_CACHE[keys[i]].at > 3000) { delete NET_CACHE[keys[i]]; netCacheN--; }
    }
  }
}

async function getJSON(url, headers, opts) {
  var o = opts || {};
  var key = netCacheKey(url, headers);
  if (!o.noCache) {
    var hit = netCacheGet(key);
    if (hit) return hit;
  }
  var resp = await fetchRetry(url, { method: 'GET', headers: headers || {} },
    { retries: o.retries === undefined ? 2 : o.retries, timeout: o.timeout || 15 });
  if (!resp || !resp.ok) throw new Error('HTTP ' + (resp ? resp.status : '??') + ' ' + shortUrl(url));
  var data = await resp.json();
  if (!o.noCache) netCachePut(key, data);
  return data;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function normCover(u) {
  var s = String(u || '').split('!')[0].replace(/^http:/, 'https:');
  if (s.indexOf('//') === 0) s = 'https:' + s;
  // 私有接口常返回相对路径（storages/...），补上 CDN 前缀
  if (s && !/^https?:/i.test(s)) s = 'https://imagev2.xmcdn.com/' + s.replace(/^\/+/, '');
  return s;
}

function nowStr() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function todayStr() {
  return nowStr().slice(0, 10);
}

function hhmmNow() {
  return nowStr().slice(11, 16);
}

// v0.19.4：配置里的 "8:30" / "9:05" 与 hhmmNow() 的 "08:30" 做字符串比较会得到 false，
// 定时同步/播报/追更当天一次都不跑，而且没有任何日志。统一归一化 + 按分钟比较。
function normHHMM(v) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return '';
  var h = Number(m[1]), mi = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return '';
  return (h < 10 ? '0' + h : String(h)) + ':' + (mi < 10 ? '0' + mi : String(mi));
}

function hmMin(v) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

// ---------- 扫码登录（官方 passport 二维码） ----------
// 流程：GET /passport/qrcode/gen?level=L → {qrId, img}
//       轮询 GET /passport/qrcode/check/{qrId}/{ts} → ret/status，成功后响应头下发 1&_token
var QR_GEN = 'https://www.ximalaya.com/passport/qrcode/gen';
var QR_CHECK = 'https://www.ximalaya.com/passport/qrcode/check/';
var QR_TTL_MS = 5 * 60 * 1000;
var qrSessions = {};

function qrPrune() {
  var now = Date.now();
  Object.keys(qrSessions).forEach(function (k) {
    if (now - qrSessions[k].at > QR_TTL_MS) delete qrSessions[k];
  });
}

function bytesToBase64(bytes) {
  var CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '', i = 0, n = bytes.length;
  for (; i + 2 < n; i += 3) {
    var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += CH[(v >> 18) & 63] + CH[(v >> 12) & 63] + CH[(v >> 6) & 63] + CH[v & 63];
  }
  var rest = n - i;
  if (rest === 1) {
    var a = bytes[i] << 16;
    out += CH[(a >> 18) & 63] + CH[(a >> 12) & 63] + '==';
  } else if (rest === 2) {
    var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += CH[(b >> 18) & 63] + CH[(b >> 12) & 63] + CH[(b >> 6) & 63] + '=';
  }
  return out;
}

// 从响应头收集 Set-Cookie，返回 ["k=v", ...]（同名只取第一个）
function cookiesFromHeaders(resp) {
  var raw = [];
  try {
    if (resp && resp.headers && typeof resp.headers.getSetCookie === 'function') {
      raw = resp.headers.getSetCookie() || [];
    }
  } catch (e) { raw = []; }
  if (!raw.length) {
    try {
      var one = resp && resp.headers && resp.headers.get('set-cookie');
      if (one) raw = String(one).split(/,(?=\s*[^;,=\s]+=)/);
    } catch (e2) { /* ignore */ }
  }
  var out = [], seen = {};
  raw.forEach(function (line) {
    var first = String(line).split(';')[0];
    var i = first.indexOf('=');
    if (i <= 0) return;
    var k = first.slice(0, i).trim();
    var v = first.slice(i + 1).trim();
    if (!k || seen[k]) return;
    seen[k] = 1;
    out.push(k + '=' + v);
  });
  return out;
}

// 只保留真正的登录凭据（顺带保留 _xmLog 等辅助项），没有 token 视为未登录
function pickLoginCookie(pairs, json) {
  var map = {};
  pairs.forEach(function (p) {
    var i = p.indexOf('=');
    map[p.slice(0, i)] = p.slice(i + 1);
  });
  var token = map['1&_token'] || map['_token'] || '';
  var uid = map['1&_uid'] || map['_uid'] || '';
  if (!token && json && typeof json === 'object') {
    var dd = json.data && typeof json.data === 'object' ? json.data : {};
    var t = json.token || json.accessToken || dd.token || dd.accessToken || '';
    var u = json.uid || json.userId || dd.uid || dd.userId || '';
    if (t) { token = String(t); map['1&_token'] = token; }
    if (u && !uid) { uid = String(u); map['1&_uid'] = uid; }
  }
  if (!token) return '';
  var keep = ['1&_token', '1&_uid', '_xmLog', 'ximalaya_token', 'ximalaya_uid', '1&_device', '1&_device_id'];
  var out = [];
  keep.forEach(function (k) { if (map[k]) out.push(k + '=' + map[k]); });
  return out.join('; ');
}

async function qrCreate() {
  var url = QR_GEN + '?level=L&source=' + encodeURIComponent('喜马拉雅网页端');
  var r = await fetchT(url, {
    method: 'GET',
    headers: { 'User-Agent': UA_PC, 'Referer': 'https://www.ximalaya.com/' }
  }, 15);
  var txt = await r.text();
  var d = null;
  try { d = JSON.parse(txt); } catch (e) { d = null; }
  if (!d || !d.qrId) throw new Error('二维码生成失败：' + txt.slice(0, 120));
  var imgUrl = String(d.img || '');
  if (imgUrl.indexOf('//') === 0) imgUrl = 'https:' + imgUrl;
  var image = '';
  var imgError = '';
  if (imgUrl) {
    try {
      var ir = await fetchT(imgUrl, {
        method: 'GET',
        headers: { 'User-Agent': UA_PC, 'Referer': 'https://www.ximalaya.com/' }
      }, 15);
      var buf = await ir.arrayBuffer();
      image = 'data:image/png;base64,' + bytesToBase64(new Uint8Array(buf));
    } catch (e) { imgError = String(e); }
  }
  qrPrune();
  qrSessions[d.qrId] = { at: Date.now(), scanned: false };
  return { qrId: d.qrId, image: image, imgUrl: imgUrl, imgError: imgError };
}

async function qrCheck(qrId) {
  // 注意：路径后面不要再跟时间戳（官方新版会 404），用 query 做缓存击穿
  var url = QR_CHECK + encodeURIComponent(qrId) + '?_t=' + Date.now();
  var r = await fetchT(url, {
    method: 'GET',
    headers: { 'User-Agent': UA_PC, 'Referer': 'https://www.ximalaya.com/' }
  }, 15);
  var txt = await r.text();
  var d = null;
  try { d = JSON.parse(txt); } catch (e) { d = null; }
  var pairs = cookiesFromHeaders(r);
  var ck = pickLoginCookie(pairs, d);
  var ret = d ? d.ret : null;
  var status = d ? d.status : null;

  if (ck) {
    login.cookie = ck;
    login.savedAt = nowStr();
    meCache = { at: 0, user: null, albums: [], source: '', error: '' };
    signCache = { at: 0, v: '' };
    await persist();
    songloft.log.info('[喜马拉雅] 扫码登录成功，已保存 Cookie（' + ck.length + ' 字符）');
    var uv = { ok: false, user: null, error: '' };
    try {
      var u = await fetchCurrentUser();
      uv = { ok: u.ok, user: u.user || null, error: u.error || '' };
    } catch (e) { uv.error = String(e); }
    return { state: 'ok', valid: uv.ok, user: uv.user, error: uv.error };
  }

  // 兼容两套状态语义：老接口用 ret(0/32000 未扫/32001 过期)，新接口用 status(1 未扫 / 2 已扫待确认 / 3 过期)
  var state = 'wait';
  if (!d) state = 'error';
  else if (ret === 32001 || status === 3) state = 'expired';
  else if (status === 2 || ret === 32002) state = 'scanned';

  if (qrSessions[qrId] && state === 'scanned') qrSessions[qrId].scanned = true;
  return { state: state, ret: ret, status: status, raw: txt.slice(0, 200), cookieNames: pairs.map(function (p) { return p.split('=')[0]; }) };
}

// ---------- 喜马拉雅接口 ----------

function pcHeaders(refererAlbum) {
  var h = {
    'User-Agent': UA_PC,
    'Referer': 'https://www.ximalaya.com/album/' + (refererAlbum || '')
  };
  if (login.cookie) h['Cookie'] = login.cookie;
  return h;
}

function extractAlbumId(input) {
  var s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  var m = s.match(/album\/(\d+)/);
  if (m) return m[1];
  m = s.match(/(\d{5,})/);
  return m ? m[1] : '';
}

async function fetchShowPage(albumId, page) {
  var url = 'https://www.ximalaya.com/revision/play/v1/show?id=' + albumId +
    '&num=' + page + '&size=' + PAGE_SIZE + '&ptype=0';
  // 兜底：单页失败重试一次；仍失败就当作空页（上层会停止翻页，不至于整本导入崩掉）
  var d = null;
  try {
    d = await getJSON(url, pcHeaders(albumId));
  } catch (e) {
    try {
      d = await getJSON(url, pcHeaders(albumId));
    } catch (e2) {
      logWarn('album', '取第 ' + page + ' 页失败：' + String(e2 && e2.message || e2));
      return [];
    }
  }
  if (d.ret !== 200) throw new Error('喜马拉雅接口异常 ret=' + d.ret + ' ' + (d.msg || ''));
  return (d.data && d.data.tracksAudioPlay) || [];
}

// 专辑目录：逐页扫一轮集数，得到「总页数 + 每页集数范围」，倒序播放靠它从最后一集起播。
// 有 10 分钟缓存——专辑更新后最多晚 10 分钟才反映到倒序起点。
var outlineCache = {};
async function fetchAlbumOutline(albumId) {
  var ck = String(albumId);
  var hit = outlineCache[ck];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;

  var pages = [];
  var page = 1;
  var lastIndex = 0;
  while (page <= 200) {
    var list = await fetchShowPage(albumId, page);
    if (!list.length) break;
    var idx = list.map(function (t) { return Number(t.index) || 0; });
    var min = Math.min.apply(null, idx);
    var max = Math.max.apply(null, idx);
    pages.push({ page: page, min: min, max: max, count: list.length });
    lastIndex = max;
    if (list.length < PAGE_SIZE) break;
    page += 1;
  }
  var data = {
    albumId: ck,
    pageSize: PAGE_SIZE,
    pageCount: pages.length,
    lastPage: pages.length ? pages[pages.length - 1].page : 1,
    lastIndex: lastIndex,
    firstIndex: pages.length ? pages[0].min : 0,
    pages: pages
  };
  outlineCache[ck] = { at: Date.now(), data: data };
  return data;
}

// updateTime 有两种格式：'2025-04' 或相对时间（'23天前' / '10小时前' / '3个月前' / '昨天'…）。
// 统一归一化成 'YYYY-MM'，分集列表才不会一会儿 2026-09 一会儿 23天前。
function normMonth(s) {
  s = String(s || '').trim();
  var m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return m[1] + '-' + (m[2].length < 2 ? '0' + m[2] : m[2]);
  var r = s.match(/^(\d+)\s*(小时|天|日|周|个?月|年)前/);
  var now = new Date();
  var mm = function (d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); };
  if (/今天/.test(s)) return mm(now);
  if (/昨天/.test(s)) return mm(new Date(Date.now() - 86400000));
  if (r) {
    var n = Number(r[1]), u = r[2];
    if (u === '小时') return mm(now);
    var days = u === '天' || u === '日' ? n : u === '周' ? n * 7 : u === '年' ? n * 365 : n * 30;
    return mm(new Date(Date.now() - days * 86400000));
  }
  return s;   // 认不出的格式原样返回，不硬造日期
}

function mapTrack(t, albumName) {
  return {
    index: t.index,
    trackId: t.trackId,
    title: t.trackName || ('第' + t.index + '集'),
    album: t.albumName || albumName || '',
    duration: t.duration || 0,
    updatedAt: normMonth(t.updateTime || t.createTime || ''),
    cover: t.trackCoverPath ? ('https://imagev2.xmcdn.com/' + t.trackCoverPath) : ''
  };
}

async function fetchAlbumDetail(albumId) {
  var url = 'https://www.ximalaya.com/revision/album/v1/simple?albumId=' + albumId;
  var d = await getJSON(url, pcHeaders(albumId));
  if (d.ret !== 200) throw new Error('专辑信息获取失败 ret=' + d.ret + ' ' + (d.msg || ''));
  var m = (d.data && d.data.albumPageMainInfo) || {};
  var pay = classifyPay(m);
  return {
    albumId: String(albumId),
    name: stripHtml(m.albumTitle || ''),
    author: m.anchorName || '',
    cover: normCover(m.cover || ''),
    intro: stripHtml(m.shortIntro || ''),
    introFull: stripHtml(m.richIntro || m.detailRichIntro || ''),
    playCount: m.playCount || 0,
    isPaid: pay.paid,
    payLabel: pay.label,
    payTip: pay.tip,
    hasBuy: !!m.hasBuy,
    vipType: Number(m.vipType) || 0,
    isFinished: Number(m.isFinished) || 0,
    finishedText: pay.finishedText,
    updateDate: String(m.updateDate || '').split(' ')[0],
    createDate: String(m.createDate || '').split(' ')[0],
    category: m.categoryTitle || '',
    subscribeCount: m.subscribeCount || 0
  };
}

// 付费类型判定。实测（2026-10）：免费专辑 isPaid=false & vipType=0；
// 付费/VIP 专辑 isPaid=true & vipType=2。字段可能缺失，故做多重兜底。
function classifyPay(m) {
  m = m || {};
  var isPaid = !!(m.isPaid || m.is_paid);
  var vipType = Number(m.vipType) || 0;
  var paid = isPaid || vipType > 0;
  var label = '', tip = '';
  if (paid) {
    tip = '这是付费 / VIP 专辑，未购买或未开通会员时无法收听完整内容';
    if (m.hasBuy) { label = '已购买'; tip = '这是付费专辑，当前账号已购买'; }
    else if (vipType === 2) label = 'VIP 会员';
    else label = '付费';
  } else if (Number(m.ximiVipFreeType) > 0) {
    label = '会员免费';
    tip = '喜马拉雅会员可免费收听';
  }
  var fin = Number(m.isFinished) || 0;
  // 实测：0=连载中，1=已完结（个别专辑为 2，按完结处理）
  var finishedText = fin === 0 ? '连载中' : '已完结';
  return { paid: paid, label: label, tip: tip, finishedText: finishedText };
}


async function fetchTrackUrl(trackId) {
  var url = 'https://m.ximalaya.com/tracks/' + trackId + '.json';
  var h = { 'User-Agent': UA_M, 'Referer': 'https://m.ximalaya.com/' };
  if (login.cookie) h['Cookie'] = login.cookie;
  // 换源重试：移动端接口偶尔抖动，失败后用 PC 端 UA 再试一次（两个接口容忍度不同）
  var d = null;
  try {
    d = await getJSON(url, h);
  } catch (e1) {
    logWarn('play', '单集地址失败（' + String(e1 && e1.message || e1) + '），换 UA 重试 ' + trackId);
    d = await getJSON(url, { 'User-Agent': UA_PC, 'Referer': 'https://www.ximalaya.com/' });
  }
  var link = d.play_path_64 || d.play_path_32 || d.play_path || '';
  if (!link) {
    if (d.is_paid) throw new Error('paid: 该集为付费/VIP内容（未登录或无权限）');
    throw new Error('未获取到音频地址（可能已下架）');
  }
  return link;
}

// v0.22.5：单集地址缓存 + 后台预取 —— 目标「即点即播」。
// 地址本身有效期通常数小时，这里缓存 20 分钟：覆盖连续收听，又不会用到过期地址。
var TURL = {}, TURL_TTL = 20 * 60 * 1000, TURL_MAX = 500, turlN = 0;
function turlGet(id) {
  var c = TURL[id];
  if (!c) return '';
  if (Date.now() - c.at > TURL_TTL) { delete TURL[id]; turlN = Math.max(0, turlN - 1); return ''; }
  return c.url;
}
function turlPut(id, url) {
  if (!url) return;
  if (!TURL[id]) turlN++;
  TURL[id] = { url: url, at: Date.now() };
  if (turlN > TURL_MAX) {
    var keys = Object.keys(TURL);
    for (var i = 0; i < keys.length && turlN > TURL_MAX; i++) { delete TURL[keys[i]]; turlN--; }
  }
}
async function trackUrlFast(id, fresh) {
  if (!fresh) {
    var c = turlGet(id);
    if (c) return c;
  }
  var u = await fetchTrackUrl(id);
  turlPut(id, u);
  return u;
}
// 后台预取：不阻塞当前请求，失败静默（真正的报错留给用户点播时）
function prefetchUrls(ids) {
  var list = (ids || []).map(function (x) { return String(x || ''); }).filter(Boolean).slice(0, 12);
  if (!list.length) return 0;
  setTimeout(function () {
    list.forEach(function (id) {
      if (turlGet(id)) return;
      trackUrlFast(id).catch(function (e) {
        logWarn('net', '预取地址失败 ' + id + '：' + String(e && e.message || e));
      });
    });
  }, 50);
  return list.length;
}

// v0.22.3：封面统一转 https（手机 webview 拒载 http 图）
function httpsUrl(u) {
  var s = String(u || '');
  return s ? s.replace(/^http:\/\//i, 'https://') : '';
}

// v0.22.2：单集元数据（封面/时长/标题），音箱播放界面显示进度和封面用
async function fetchTrackMeta(trackId) {
  var url = 'https://m.ximalaya.com/tracks/' + trackId + '.json';
  var h = { 'User-Agent': UA_M, 'Referer': 'https://m.ximalaya.com/' };
  if (login.cookie) h['Cookie'] = login.cookie;
  var d = null;
  try {
    d = await getJSON(url, h);
  } catch (e1) {
    d = await getJSON(url, { 'User-Agent': UA_PC, 'Referer': 'https://www.ximalaya.com/' });
  }
  return d || {};
}

// ---------- 登录态私有接口：当前用户 / 我的订阅 ----------

var signCache = { at: 0, v: '' };
var subEpHit = '';          // 已确认可用的订阅接口 key（自适应记忆）
var meCache = { at: 0, user: null, albums: [], source: '', error: '' };
var ME_TTL = 2 * 60 * 1000;

// 私有接口带 xm-sign 更稳（缓存 60s，避免每次多打一次 /revision/time）
async function signHeaders(base) {
  var h = base || pcHeaders('');
  if (!signCache.v || Date.now() - signCache.at > 60000) {
    try { signCache.v = await buildXmSign() || ''; } catch (e) { signCache.v = ''; }
    signCache.at = Date.now();
  }
  if (signCache.v) h['xm-sign'] = signCache.v;
  return h;
}

function cookieLooksValid(ck) {
  var s = String(ck || '');
  if (!s) return { ok: false, reason: '空' };
  if (/^U2FsdGVkX1/.test(s)) return { ok: false, reason: '这是加密串，不是 Cookie' };
  if (s.length < 20 || s.indexOf('=') === -1) return { ok: false, reason: '长度/格式不像 Cookie' };
  return { ok: true, reason: '' };
}

var USER_EPS = [
  'https://www.ximalaya.com/revision/main/getCurrentUser',
  'https://www.ximalaya.com/revision/my/getCurrentUserInfo'
];

// 返回 { ok, user:{uid,nickname,avatar,vip}, error, ret }
async function fetchCurrentUser() {
  if (!login.cookie) return { ok: false, error: '未登录', ret: 401 };
  var last = { ok: false, error: '未知错误', ret: 0 };
  for (var i = 0; i < USER_EPS.length; i++) {
    try {
      var d = await getJSON(USER_EPS[i], await signHeaders(pcHeaders('')));
      if (d && d.ret === 200) {
        var u = (d.data && (d.data.userInfo || d.data.user || d.data)) || {};
        return {
          ok: true,
          ret: 200,
          user: {
            uid: String(u.uid || u.id || u.userId || u.passportUid || ''),
            nickname: stripHtml(u.nickname || u.nickName || u.name || u.userName || ''),
            avatar: normCover(u.avatar || u.avatarUrl || u.avatarPath || u.cover || ''),
            vip: !!(u.isVip || u.isVIP || u.vipLevel || u.vip)
          }
        };
      }
      last = { ok: false, ret: (d && d.ret) || 0, error: (d && (d.msg || d.message)) || 'ret=' + (d && d.ret) };
    } catch (e) {
      last = { ok: false, ret: 0, error: String(e) };
    }
  }
  return last;
}

// ---------- 登录态健康检查 ----------
// Cookie 过期是「静默失效」：付费集拿不到地址、我的订阅拉不到，用户只看到「怎么没反应」。
// 这里定期验一次登录态，失效就在界面上直接提醒（并把上次成功时间留在存储里）。
var cookieCheck = { at: 0, ok: false, uid: '', nickname: '', error: '', cookieLength: 0, lastOkAt: 0 };

// 从「最后成功验证」到现在过了多久，给一个体面的说法
function agoText(ts) {
  var t = Number(ts) || 0;
  if (!t) return '从未验证';
  var d = Math.max(0, Date.now() - t);
  var mi = Math.floor(d / 60000);
  if (mi < 1) return '刚刚';
  if (mi < 60) return mi + ' 分钟前';
  var h = Math.floor(mi / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

async function checkCookieHealth(force) {
  // v0.19.4：三个分支原来都是整体赋值新建对象，会把 tick 刚写的 lastCheckDay 和上次的 lastOkAt 一起丢掉
  // → 「每天一次」的巡检变成每 60 秒一次（一天 1440 次请求喜马拉雅，正是最招风控的模式），
  //   失败后 lastOkAt 也永远归零，自检里「上次正常」变成「从未验证」。
  var prevDay = cookieCheck.lastCheckDay || '';
  var prevOkAt = Number(cookieCheck.lastOkAt) || 0;
  var sane = cookieLooksValid(login.cookie);
  if (!login.cookie) {
    cookieCheck = { at: Date.now(), ok: false, uid: '', nickname: '', error: '未登录', cookieLength: 0, lastOkAt: prevOkAt, lastCheckDay: prevDay };
    return cookieHealthOut();
  }
  if (!sane.ok) {
    cookieCheck = { at: Date.now(), ok: false, uid: '', nickname: '', error: sane.reason, cookieLength: login.cookie.length, lastOkAt: prevOkAt, lastCheckDay: prevDay };
    logWarn('login', 'Cookie 格式异常：' + sane.reason);
    return cookieHealthOut();
  }
  // 5 分钟内不重复验，避免每次打开面板都打一次接口
  if (!force && cookieCheck.at && Date.now() - cookieCheck.at < 5 * 60 * 1000) return cookieHealthOut();
  try {
    var u = await fetchCurrentUser();
    cookieCheck = {
      at: Date.now(),
      ok: !!u.ok,
      uid: (u.user && u.user.uid) || '',
      nickname: (u.user && u.user.nickname) || '',
      error: u.ok ? '' : (u.error || '登录态无效，请重新扫码'),
      cookieLength: login.cookie.length,
      lastOkAt: u.ok ? Date.now() : prevOkAt,   // v0.19.4：失败时保留上次成功时间
      lastCheckDay: prevDay                     // v0.19.4：别把 tick 记的「今天已巡检」擦掉
    };
    if (!u.ok) logWarn('login', '登录态失效：' + cookieCheck.error);
  } catch (e) {
    cookieCheck = { at: Date.now(), ok: false, uid: '', nickname: '', error: String(e), cookieLength: login.cookie.length, lastOkAt: prevOkAt, lastCheckDay: prevDay };
  }
  return cookieHealthOut();
}

function cookieHealthOut() {
  var o = {
    loggedIn: !!login.cookie,
    valid: !!cookieCheck.ok,
    uid: cookieCheck.uid || '',
    nickname: cookieCheck.nickname || '',
    error: cookieCheck.error || '',
    checkedAt: cookieCheck.at || 0,
    checkedAgo: agoText(cookieCheck.at),
    lastOkAgo: agoText(cookieCheck.lastOkAt || 0),
    savedAt: login.savedAt || '',
    cookieLength: cookieCheck.cookieLength || (login.cookie ? login.cookie.length : 0)
  };
  // 顺手落盘，重启后还能知道「上次什么时候还是好的」
  try {
    songloft.storage.set(COOKIE_CHK_KEY, JSON.stringify({
      ok: cookieCheck.ok, uid: cookieCheck.uid, nickname: cookieCheck.nickname,
      error: cookieCheck.error, at: cookieCheck.at, lastOkAt: cookieCheck.lastOkAt || 0,
      lastCheckDay: cookieCheck.lastCheckDay || ''
    }));
  } catch (e) { /* */ }
  return o;
}

function normMyAlbum(o) {
  var anchor = o.anchor || o.anchorInfo || {};
  var id = o.albumId || o.album_id || o.albumID || o.id;
  var cover = o.coverPath || o.cover || o.coverUrl || o.albumCover || o.imgPath || o.pic || '';
  var up = o.lastUptrackAtStr || o.updateDate || o.updatedAt || o.lastUpdateTime || o.updateTime || '';
  return {
    id: String(id || ''),
    title: stripHtml(o.title || o.albumTitle || o.albumName || o.name || ('专辑' + id)),
    author: stripHtml(o.nickname || o.albumUserNickName || o.author || o.anchorName || o.announcer ||
      anchor.anchorNickName || anchor.nickname || ''),
    cover: normCover(cover),
    tracks: Number(o.trackCount || o.tracks || o.tracksCount || o.tracks_count || 0) || 0,
    updateDate: String(up).split(' ')[0],
    latest: stripHtml(o.lastUptrackTitle || ''),
    isPaid: !!(o.isPaid || o.is_paid || o.vip || o.isVip || o.vipType),
    playCount: Number(o.playCount || o.play_count || 0) || 0,
    category: stripHtml(o.categoryTitle || '')
  };
}

// 像专辑而不是单集（接口结构不稳定，只能按特征判断）
function looksAlbum(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.trackId || o.track_id) return false;
  var id = o.albumId || o.album_id || o.albumID || o.id;
  var title = o.title || o.albumTitle || o.albumName || o.name;
  if (!id || !title) return false;
  return !!(
    o.coverPath || o.cover || o.coverUrl || o.albumCover ||
    o.trackCount || o.tracksCount || o.tracks_count ||
    o.albumUrl || o.anchor || o.anchorNickName ||
    o.albumSubscript !== undefined || o.isFinished !== undefined ||
    o.lastUptrackAt !== undefined || o.lastUptrackAtStr !== undefined ||
    o.categoryTitle || o.playCount !== undefined
  );
}

// 接口结构不稳定，递归找出所有「像专辑」的对象（排除单集）
function pickAlbums(node) {
  var out = [], seen = {};
  (function walk(n, depth) {
    if (!n || depth > 7) return;
    if (Array.isArray(n)) {
      for (var i = 0; i < n.length; i++) walk(n[i], depth + 1);
      return;
    }
    if (typeof n !== 'object') return;
    if (looksAlbum(n)) {
      var a = normMyAlbum(n);
      if (a.id && !seen[a.id]) { seen[a.id] = 1; out.push(a); }
    }
    for (var k in n) {
      if (!Object.prototype.hasOwnProperty.call(n, k)) continue;
      var v = n[k];
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  })(node, 0);
  return out;
}

var SUB_EPS = [
  // 官网「我的订阅」页实际使用的接口（参数已按官方前端核对：pageNum / pageSize）
  { key: 'synthesize', name: '订阅聚合', url: 'https://www.ximalaya.com/revision/my/getSubscriptionSynthesize?pageNum={p}&pageSize={s}' },
  { key: 'bySubAt', name: '按订阅时间', url: 'https://www.ximalaya.com/revision/my/getSubscriptionBySubAt?pageNum={p}&pageSize={s}' },
  { key: 'comprehensive', name: '订阅综合', url: 'https://www.ximalaya.com/revision/album/v1/sub/comprehensive?subType=2&pageNum={p}&pageSize={s}' },
  { key: 'subAlbumList', name: '专辑订阅列表', url: 'https://www.ximalaya.com/revision/album/v1/getSubAlbumList?pageNum={p}&pageSize={s}' }
];

function subEpUrl(key, page, size) {
  for (var i = 0; i < SUB_EPS.length; i++) {
    if (SUB_EPS[i].key === key) {
      return SUB_EPS[i].url.replace('{p}', page).replace('{s}', size);
    }
  }
  return '';
}

function subEpName(key) {
  for (var i = 0; i < SUB_EPS.length; i++) if (SUB_EPS[i].key === key) return SUB_EPS[i].name;
  return key;
}

// 拉一页「我订阅的专辑」；命中过的接口优先，失败再轮询其它
async function fetchMySubsPage(page, size) {
  if (!login.cookie) return { ok: false, needLogin: true, error: '未登录', albums: [] };
  var order = [];
  if (subEpHit) order.push(subEpHit);
  for (var i = 0; i < SUB_EPS.length; i++) if (SUB_EPS[i].key !== subEpHit) order.push(SUB_EPS[i].key);

  var lastErr = '', needLogin = false;
  for (var j = 0; j < order.length; j++) {
    var key = order[j];
    var url = subEpUrl(key, page, size);
    if (!url) continue;
    try {
      var d = await getJSON(url, await signHeaders(pcHeaders('')));
      if (!d) { lastErr = '空响应'; continue; }
      if (d.ret && d.ret !== 200) {
        lastErr = (d.msg || d.message || '') + '（ret=' + d.ret + '）';
        if (d.ret === 401 || d.isNeedLogin) needLogin = true;
        continue;
      }
      var albums = pickAlbums(d.data || d);
      if (!albums.length && page === 1) {
        // 该接口没返回专辑（可能参数不对），继续试下一个
        lastErr = '接口无专辑数据';
        continue;
      }
      var raw = d.data || {};
      var total = Number(raw.totalCount || raw.total || raw.numFound || 0) || 0;
      var realSize = Number(raw.pageSize) || size;
      subEpHit = key;
      return {
        ok: true, albums: albums, source: key, needLogin: false, total: total, pageSize: realSize,
        hasMore: total ? page * realSize < total : albums.length >= realSize
      };
    } catch (e) {
      lastErr = String(e);
    }
  }
  return { ok: false, albums: [], error: lastErr || '接口不可用', needLogin: needLogin, allFailed: true };
}

async function loadMySubs(opts) {
  opts = opts || {};
  var page = Number(opts.page) || 1;
  var size = Math.min(Math.max(Number(opts.size) || 60, 10), 100);
  if (!login.cookie) return { ok: false, needLogin: true, error: '未登录', albums: [], page: page };

  var cached = page === 1 && !opts.refresh && meCache.at && Date.now() - meCache.at < ME_TTL;
  var user = cached && meCache.user ? meCache.user : null;
  if (!user) {
    var ur = await fetchCurrentUser();
    if (!ur.ok) {
      return { ok: false, needLogin: (ur.ret === 401), error: ur.error || '登录态无效', albums: [], page: page };
    }
    user = ur.user;
  }

  var r;
  if (cached) {
    r = { ok: true, albums: meCache.albums, source: meCache.source };
  } else {
    r = await fetchMySubsPage(page, size);
  }

  // 标注本地已收录/已订阅状态
  var albums = (r.albums || []).map(function (a) {
    var s = findSub(a.id);
    var l = null;
    for (var i = 0; i < imported.length; i++) if (String(imported[i].albumId) === a.id) { l = imported[i]; break; }
    return {
      id: a.id, title: a.title, author: a.author, cover: a.cover, tracks: a.tracks,
      updateDate: a.updateDate, latest: a.latest || '', category: a.category || '',
      isPaid: a.isPaid, playCount: a.playCount,
      subscribed: !!s, playlistId: (s && s.playlistId) || (l && l.playlistId) || 0,
      lastIndex: (s && s.lastIndex) || (l && l.count) || 0
    };
  });

  if (page === 1 && r.ok) {
    meCache = { at: Date.now(), user: user, albums: albums, source: r.source || '', error: '' };
  }

  return {
    ok: r.ok, error: r.error || '', needLogin: !!r.needLogin,
    user: user, albums: albums, page: page, size: r.pageSize || size, total: r.total || 0,
    source: subEpName(r.source || subEpHit),
    hasMore: r.hasMore === undefined ? (r.albums || []).length >= size : !!r.hasMore
  };
}

async function buildXmSign() {
  // xm-sign = md5("ximalaya-"+serverTs) + "(rand)" + serverTs + "(rand)" + localTs
  try {
    var timeResp = await fetchT('https://www.ximalaya.com/revision/time', { method: 'GET', headers: pcHeaders('') }, 8);
    var serverTs = Number((await timeResp.text()).trim()) || Date.now();
    var md5 = songloft.crypto.md5('ximalaya-' + serverTs);
    return md5 + '(' + Math.floor(Math.random() * 100) + ')' + serverTs +
      '(' + Math.floor(Math.random() * 100) + ')' + Date.now();
  } catch (e) {
    return '';
  }
}

async function searchAlbums(kw) {
  var h = pcHeaders('');
  var sign = await buildXmSign();
  if (sign) h['xm-sign'] = sign;
  var url = 'https://www.ximalaya.com/revision/search/main?kw=' + encodeURIComponent(kw) +
    '&core=album&page=1&rows=12&spellchecker=true';
  var d = await getJSON(url, h);
  var data = d.data || {};
  if (data.reason === 'risk invalid') return { risk: true, albums: [] };
  var docs = (data.album && (data.album.docs || data.album.result)) || [];
  var albums = docs.map(function (a) {
    return {
      id: a.id,
      title: stripTags(a.title || ''),
      author: a.nickname || '',
      tracks: a.tracksCount || a.tracks_count || 0,
      isPaid: !!a.isPaid,
      cover: normCover(a.coverUrl || (a.cover ? ('https://imagev2.xmcdn.com/' + a.cover) : ''))
    };
  });
  return { risk: false, albums: albums };
}

function normAlbum(a) {
  return {
    id: a.id,
    title: stripTags(a.title || a.keyword || a.albumTitle || ('专辑' + a.id)),
    author: a.nickname || a.author || a.announcer || '',
    category: a.category || '',
    tracks: a.tracks || a.tracksCount || a.tracks_count || 0,
    play: a.play || a.playCount || 0,
    isPaid: !!(a.isPaid || a.is_paid),
    cover: normCover(a.imgPath || a.coverUrl || a.cover_path || (a.cover ? 'https://imagev2.xmcdn.com/' + a.cover : ''))
  };
}

async function suggestOnce(kw) {
  var url = 'https://www.ximalaya.com/revision/suggest?kw=' + encodeURIComponent(kw);
  var d = await getJSON(url, pcHeaders(''));
  var r = (d.data && d.data.result) || {};
  var albums = (r.albumResultList || []).map(normAlbum);
  var keywords = (r.queryResultList || []).map(function (x) { return x.keyword; }).filter(Boolean);
  return { albums: albums, keywords: keywords };
}

async function searchBySuggest(kw) {
  var seed = await suggestOnce(kw);
  var map = {}, order = [];
  function push(list) {
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a.id) continue;
      if (!map[a.id]) { map[a.id] = a; order.push(a.id); }
    }
  }
  push(seed.albums);
  var kws = seed.keywords.filter(function (k) { return stripTags(k) !== kw; }).slice(0, 8);
  for (var i = 0; i < kws.length; i += 4) {
    var batch = kws.slice(i, i + 4);
    var res = await Promise.all(batch.map(function (k) {
      return suggestOnce(k).catch(function () { return { albums: [], keywords: [] }; });
    }));
    for (var j = 0; j < res.length; j++) push(res[j].albums);
  }
  return { albums: order.map(function (id) { return map[id]; }), keywords: seed.keywords, source: '联想聚合' };
}

async function searchByMobile(kw) {
  if (!login.cookie) return null;
  var url = 'https://m.ximalaya.com/m-revision/page/search?kw=' + encodeURIComponent(kw) +
    '&core=album&page=1&rows=20&spellchecker=true';
  var d = await getJSON(url, {
    'User-Agent': UA_M, 'Referer': 'https://m.ximalaya.com/', 'Cookie': login.cookie
  });
  if (!d || d.ret !== 200) return null;
  // 结构不稳定，递归找「带 id/title 的对象数组」
  var found = [];
  (function walk(node, depth) {
    if (!node || depth > 6 || found.length) return;
    if (Array.isArray(node)) {
      var looks = node.filter(function (x) { return x && typeof x === 'object' && x.id && (x.title || x.albumTitle || x.keyword); });
      if (looks.length) { found = looks; return; }
      for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k], depth + 1);
  })(d.data, 0);
  if (!found.length) return null;
  return { albums: found.map(normAlbum), keywords: [], source: '登录完整搜索' };
}

var searchCache = {};
var SEARCH_TTL = 10 * 60 * 1000;

async function searchAlbumsSmart(kw) {
  var key = String(kw).trim();
  var hit = searchCache[key];
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.data;

  var result = null;
  try {
    var r0 = await searchAlbums(key);
    if (!r0.risk && r0.albums.length) result = { albums: r0.albums, keywords: [], source: '完整搜索' };
  } catch (e) { /* 忽略，走兜底 */ }

  if (!result) {
    try { var rm = await searchByMobile(key); if (rm && rm.albums.length) result = rm; } catch (e) { /* */ }
  }
  if (!result) result = await searchBySuggest(key);

  result.kw = key;
  result.at = Date.now();
  if (result.albums.length) searchCache[key] = { at: Date.now(), data: result };
  return result;
}

// ---------- 单集（声音）搜索 ----------
// 老版 web 检索接口（不受 WAF 风控）：/revision/search?core=track&kw=&page=&rows=
// 返回 docs[] 里带 play_path_32/64，可直接拿地址；这里只取元数据，播放仍走 /track/{id}/url

function normTrackDoc(d) {
  if (!d) return null;
  var id = String(d.id || d.track_id || d.trackId || '');
  if (!id) return null;
  return {
    trackId: id,
    title: stripTags(d.title || d.track_title || ''),
    author: stripTags(d.nickname || d.anchor_name || d.user_name || ''),
    album: stripTags(d.album_title || d.albumTitle || ''),
    albumId: String(d.album_id || d.albumId || ''),
    cover: normCover(d.album_cover_path || d.cover_path || d.cover || ''),
    duration: progNum(d.duration),
    playUrl: d.play_path_64 || d.play_path_32 || d.play_path || '',
    isPaid: !!(d.is_paid || d.isPaid),
    play: progNum(d.count_play || d.play_count),
    category: d.category_title || '',
    createdAt: Number(d.created_at) || 0
  };
}

var trackSearchCache = {};

async function searchTracks(kw, page, rows) {
  var key = String(kw).trim() + '|' + (page || 1) + '|' + (rows || 20);
  var hit = trackSearchCache[key];
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.data;

  var url = 'https://www.ximalaya.com/revision/search?core=track&kw=' + encodeURIComponent(String(kw).trim()) +
    '&page=' + (page || 1) + '&rows=' + (rows || 20);
  var d = await getJSON(url, pcHeaders(''));
  var risk = !d || (d.ret !== 200 && d.ret !== 0);
  if (risk) {
    return { tracks: [], total: 0, risk: true, source: '声音检索（受限）' };
  }
  var docs = (d.data && d.data.result && d.data.result.response && d.data.result.response.docs) ||
    (d.data && d.data.docs) || [];
  var tracks = [];
  for (var i = 0; i < docs.length; i++) {
    var t = normTrackDoc(docs[i]);
    if (t && t.trackId) tracks.push(t);
  }
  var out = { tracks: tracks, total: progNum(d.data && d.data.result && d.data.result.response && d.data.result.response.numFound), risk: false, source: '声音检索' };
  if (tracks.length) trackSearchCache[key] = { at: Date.now(), data: out };
  return out;
}

// ---------- 存储 ----------

async function loadAll() {
  try { var c = await songloft.storage.get(CFG_KEY); if (c) config = typeof c === 'string' ? JSON.parse(c) : c; } catch (e) { /* */ }
  try { var l = await songloft.storage.get(LIB_KEY); if (l) imported = typeof l === 'string' ? JSON.parse(l) : l; } catch (e) { /* */ }
  try { var j = await songloft.storage.get(JOB_KEY); if (j) job = typeof j === 'string' ? JSON.parse(j) : j; } catch (e) { /* */ }
  try { var g = await songloft.storage.get(LOGIN_KEY); if (g) login = typeof g === 'string' ? JSON.parse(g) : g; } catch (e) { /* */ }
  try { var s = await songloft.storage.get(SUB_KEY); if (s) subs = typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { /* */ }
  try { var pg = await songloft.storage.get(PROG_KEY); if (pg) progress = typeof pg === 'string' ? JSON.parse(pg) : pg; } catch (e) { /* */ }
  try { var stt = await songloft.storage.get(STAT_KEY); if (stt) stats = typeof stt === 'string' ? JSON.parse(stt) : stt; } catch (e) { /* */ }
  try { var dj = await songloft.storage.get(DL_KEY); if (dj) dlJob = typeof dj === 'string' ? JSON.parse(dj) : dj; } catch (e) { /* */ }
  try { var w = await songloft.storage.get(WATCH_KEY); if (w) watch = typeof w === 'string' ? JSON.parse(w) : w; } catch (e) { /* */ }
  try { var bmk = await songloft.storage.get(BM_KEY); if (bmk) bookmarks = typeof bmk === 'string' ? JSON.parse(bmk) : bmk; } catch (e) { /* */ }
  try { var hst = await songloft.storage.get(HIST_KEY); if (hst) history = typeof hst === 'string' ? JSON.parse(hst) : hst; } catch (e) { /* */ }
  // v0.17.0 起移除 AI 功能，旧版本留下的 AI 缓存顺手清掉，别占着存储
  try { await songloft.storage.delete('ai_cache:v1'); } catch (e) { /* */ }
  try {
    var lgs = await songloft.storage.get(LOG_KEY);
    var larr = typeof lgs === 'string' ? JSON.parse(lgs) : lgs;
    if (Array.isArray(larr)) logBuf = larr.slice(0, LOG_MAX);
  } catch (e) { /* */ }
  if (!Array.isArray(logBuf)) logBuf = [];
  try {
    var cch = await songloft.storage.get(COOKIE_CHK_KEY);
    var cobj = typeof cch === 'string' ? JSON.parse(cch) : cch;
    if (cobj && typeof cobj === 'object') {
      cookieCheck.ok = !!cobj.ok;
      cookieCheck.uid = String(cobj.uid || '');
      cookieCheck.nickname = String(cobj.nickname || '');
      cookieCheck.error = String(cobj.error || '');
      cookieCheck.at = Number(cobj.at) || 0;
      cookieCheck.lastOkAt = Number(cobj.lastOkAt) || 0;
      cookieCheck.lastCheckDay = String(cobj.lastCheckDay || '');
    }
  } catch (e) { /* */ }
  // v0.19.4：老配置里可能存着 "8:30" 这种没补零的时间，加载时统一归一化
  try {
    if (config && config.auto) config.auto.time = normHHMM(config.auto.time) || '08:30';
    if (config && config.watch && config.watch.time) config.watch.time = normHHMM(config.watch.time) || '';
  } catch (e) { /* */ }
  if (!Array.isArray(bookmarks)) bookmarks = [];
  if (!Array.isArray(history)) history = [];
  try {
    var td = await songloft.storage.get(TODO_KEY);
    var tarr = typeof td === 'string' ? JSON.parse(td) : td;
    if (Array.isArray(tarr)) todoItems = tarr.filter(function (x) { return x && x.albumId; }).slice(0, 200);
  } catch (e) { /* */ }
  if (!Array.isArray(todoItems)) todoItems = [];

  if (!config || typeof config !== 'object') config = {};
  if (!config.auto) config.auto = { enabled: false, time: '08:30', lastRunDate: '' };
  if (!config.sync || typeof config.sync !== 'object') config.sync = { progress: true };
  if (typeof config.sync.progress !== 'boolean') config.sync.progress = true;
  if (!config.dl || typeof config.dl !== 'object') config.dl = { targetDir: '喜马拉雅', format: 'mp3' };
  if (typeof config.dl.targetDir !== 'string') config.dl.targetDir = '';
  if (config.dl.format !== '' && config.dl.format !== 'mp3') config.dl.format = 'mp3';

  // v0.17.0 起不再有 AI，旧配置里的 ai 段直接丢掉
  if (config.ai) delete config.ai;

  // v0.20.3：关键词追更 / 定时语音播报的界面已经下线，但旧配置里可能还开着。
  // 留着的话后台仍会到点自动导入、往音箱推声音，而用户已经找不到开关——
  // 等于「悄悄替你做事」。这里一次性强制关掉，并写一条日志说明。
  var mutedJobs = [];
  if (config.watch && config.watch.enabled) {
    config.watch.enabled = false;
    mutedJobs.push('关键词追更');
  }
  if (mutedJobs.length) {
    // 只写 config 这一个 key：此时 loadAll 还没读完，调 persist() 会把尚未加载的
    // 书签/历史等空数组覆盖回存储，等于清空数据。
    try { await songloft.storage.set(CFG_KEY, JSON.stringify(config)); } catch (e) { /* */ }
    // 两处都记：插件日志（设置页能看）与宿主日志（排查用）
    logInfo('config', '以下定时任务已随界面下线自动关闭：' + mutedJobs.join('、'));
    songloft.log.info('[喜马拉雅] 以下定时任务已随界面下线自动关闭：' + mutedJobs.join('、'));
  }

  if (!login || typeof login.cookie !== 'string') login = { cookie: '', savedAt: '' };
  if (!Array.isArray(subs)) subs = [];
  if (!Array.isArray(imported)) imported = [];
  if (!job || typeof job !== 'object') job = { running: false, mode: '', title: '', done: 0, total: 0, playlistId: 0, error: '', finishedAt: '', current: '', parts: [] };

  if (!watch || typeof watch !== 'object') watch = { items: [], job: { running: false, at: '', added: 0, msg: '' } };
  if (!Array.isArray(watch.items)) watch.items = [];
  if (!watch.job || typeof watch.job !== 'object') watch.job = { running: false, at: '', added: 0, msg: '' };
  if (watch.job.running) watch.job.running = false;
  if (!config.watch || typeof config.watch !== 'object') config.watch = { enabled: false, maxNew: 10, maxAlbums: 3 };
  if (config.watch.maxNew === undefined) config.watch.maxNew = 10;
  if (config.watch.maxAlbums === undefined) config.watch.maxAlbums = 3;

  if (!stats || typeof stats !== 'object') stats = { days: {}, albums: {}, at: '' };
  if (!stats.hours || typeof stats.hours !== 'object') stats.hours = {};
  if (!stats.days || typeof stats.days !== 'object') stats.days = {};
  if (!stats.albums || typeof stats.albums !== 'object') stats.albums = {};

  if (!progress || typeof progress !== 'object') progress = { tracks: {}, albums: {}, at: '' };
  if (!progress.tracks || typeof progress.tracks !== 'object') progress.tracks = {};
  if (!progress.albums || typeof progress.albums !== 'object') progress.albums = {};
  var dftDl = { running: false, playlistId: 0, title: '', done: 0, total: 0, ok: 0, fail: 0, current: '', error: '', finishedAt: '', targetDir: '', cancel: false };
  if (!dlJob || typeof dlJob !== 'object') dlJob = dftDl;
  for (var dk in dftDl) {
    if (Object.prototype.hasOwnProperty.call(dftDl, dk) && dlJob[dk] === undefined) dlJob[dk] = dftDl[dk];
  }
  // 进程重启后不可能还有在跑的任务，把残留的 running 归位
  if (dlJob.running) { dlJob.running = false; dlJob.error = dlJob.error || '任务被中断'; }
  // v0.19.2：导入任务同样要归零。原来漏了这里，插件在导入中重启后 /status 永远返回
  // running:true，前端进度条卡死、刷新也结束不了，只能重启宿主。
  if (job.running) {
    job.running = false;
    job.error = job.error || '任务被中断（插件已重启）';
    job.finishedAt = nowStr();
  }

  // v0.3 及更早版本没有 subscriptions，用导入记录反向补一份
  if (!subs.length && imported.length) {
    imported.forEach(function (a) {
      subs.push({
        albumId: String(a.albumId || ''),
        name: a.name || '',
        playlistId: a.playlistId || 0,
        lastIndex: Number(a.count) || 0,
        songCount: Number(a.count) || 0,
        cover: '',
        author: '',
        updateDate: '',
        lastCheckAt: '',
        newCount: 0,
        newTitles: [],
        autoSync: true
      });
    });
  }
}

async function persist() {
  await songloft.storage.set(CFG_KEY, JSON.stringify(config));
  await songloft.storage.set(LIB_KEY, JSON.stringify(imported));
  await songloft.storage.set(JOB_KEY, JSON.stringify(job));
  await songloft.storage.set(LOGIN_KEY, JSON.stringify(login));
  await songloft.storage.set(SUB_KEY, JSON.stringify(subs));
}

async function persistProg() {
  try { await songloft.storage.set(PROG_KEY, JSON.stringify(progress)); } catch (e) { songloft.log.warn('[喜马拉雅] 进度落盘失败: ' + String(e)); }
}

async function persistStat() {
  try { await songloft.storage.set(STAT_KEY, JSON.stringify(stats)); } catch (e) { songloft.log.warn('[喜马拉雅] 统计落盘失败: ' + String(e)); }
}

async function persistWatch() {
  try { await songloft.storage.set(WATCH_KEY, JSON.stringify(watch)); } catch (e) { songloft.log.warn('[喜马拉雅] 追更落盘失败: ' + String(e)); }
}

async function persistDl() {
  try { await songloft.storage.set(DL_KEY, JSON.stringify(dlJob)); } catch (e) { /* */ }
}

function findSub(albumId) {
  var id = String(albumId || '');
  for (var i = 0; i < subs.length; i++) if (String(subs[i].albumId) === id) return subs[i];
  return null;
}

function upsertSub(patch) {
  var s = findSub(patch.albumId);
  if (!s) {
    s = {
      albumId: String(patch.albumId || ''), name: '', playlistId: 0, lastIndex: 0, songCount: 0,
      cover: '', author: '', updateDate: '', lastCheckAt: '', newCount: 0, newTitles: [], autoSync: true
    };
    subs.push(s);
  }
  for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
  return s;
}

// ---------- 跨设备收听进度 ----------

var PROG_MAX_TRACKS = 4000;   // 最多记 4000 集单集进度
// 收听统计：按天累计秒数 + 每张专辑的秒数，只保留最近 STAT_DAYS 天
var STAT_DAYS = 400;
var stats = { days: {}, albums: {}, hours: {}, at: '' };
var PROG_MAX_ALBUMS = 800;

function progNum(x) { var n = Number(x); return isFinite(n) && n > 0 ? Math.round(n) : 0; }

// 归一化一条进度记录（前端/服务端字段可能略不同）
function normProg(o) {
  if (!o) return null;
  var trackId = String(o.trackId || o.track_id || o.id || '');
  if (!trackId) return null;
  var t = progNum(o.t), d = progNum(o.d || o.dur || o.duration);
  if (!d) return null;
  return {
    trackId: trackId,
    albumId: String(o.albumId || o.album_id || ''),
    albumName: String(o.albumName || o.album_name || o.album || ''),
    title: String(o.title || ''),
    index: progNum(o.index),
    cover: String(o.cover || ''),
    author: String(o.author || ''),
    t: t, d: d,
    at: Number(o.at) || Date.now(),
    finished: !!(o.finished || (d > 0 && t >= d - 20))
  };
}

// 写入一条进度，返回是否真的更新
function progUpsert(raw) {
  var p = normProg(raw);
  if (!p) return false;
  var old = progress.tracks[p.trackId];
  if (old && Number(old.at) > p.at) return false;    // 旧数据更旧，忽略
  progress.tracks[p.trackId] = p;
  if (p.albumId) {
    var a = progress.albums[p.albumId];
    if (!a || Number(a.at) <= p.at) {
      progress.albums[p.albumId] = {
        trackId: p.trackId, index: p.index, title: p.title, t: p.t, d: p.d, at: p.at,
        albumName: p.albumName, cover: p.cover, author: p.author, finished: p.finished
      };
    }
  }
  progress.at = nowStr();
  return true;
}

// ---------- 收听统计 ----------
function dayKeyOf(ts) {  var d = new Date(Number(ts) || Date.now());
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

// 记录一段收听时长（秒）。albumId/albumName 用来做专辑排行
function statAdd(seconds, albumId, albumName, ts) {
  var sec = Math.round(Number(seconds) || 0);
  if (sec <= 0 || sec > 3600 * 6) return false;   // 单次超过 6 小时视为异常
  var dk = dayKeyOf(ts);
  stats.days[dk] = (Number(stats.days[dk]) || 0) + sec;
  // 时段分布（0-23 点），用来画「什么时候听得最多」的热力图
  if (!stats.hours || typeof stats.hours !== 'object') stats.hours = {};
  var hh = new Date(Number(ts) || Date.now()).getHours();
  stats.hours[hh] = (Number(stats.hours[hh]) || 0) + sec;
  if (albumId) {
    var k = String(albumId);
    var a = stats.albums[k] || { name: albumName || ('专辑' + k), sec: 0, lastAt: 0 };
    a.sec = (Number(a.sec) || 0) + sec;
    a.lastAt = Math.max(Number(a.lastAt) || 0, Number(ts) || Date.now());
    if (albumName) a.name = albumName;
    stats.albums[k] = a;
  }
  stats.at = nowStr();
  // 只保留最近 STAT_DAYS 天
  var keys = Object.keys(stats.days).sort();
  if (keys.length > STAT_DAYS) {
    keys.slice(0, keys.length - STAT_DAYS).forEach(function (k) { delete stats.days[k]; });
  }
  return true;
}

function secToHM(sec) {
  var s2 = Math.round(Number(sec) || 0);
  var h = Math.floor(s2 / 3600), m = Math.round((s2 % 3600) / 60);
  if (h > 0) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  if (m > 0) return m + ' 分钟';
  return s2 + ' 秒';
}


function statRange(fromTs, toTs) {
  var keys = Object.keys(stats.days).sort();
  var out = { sec: 0, days: 0, list: [] };
  keys.forEach(function (k) {
    // 用「当天 00:00 ~ 23:59」判断落在区间内。之前锚定 12:00，
    // 结果早上 8 点前的收听会被当成未来时间漏出报告。
    var t0 = new Date(k + 'T00:00:00').getTime();
    if (isNaN(t0)) return;
    if (t0 + 86400000 - 1 < fromTs || t0 > toTs) return;
    var sec = Number(stats.days[k]) || 0;
    if (!sec) return;
    out.sec += sec;
    out.days += 1;
    out.list.push({ day: k, sec: sec });
  });
  return out;
}

function statAlbums(fromTs, toTs, limit) {
  var out = [];
  for (var k in stats.albums) {
    if (!Object.prototype.hasOwnProperty.call(stats.albums, k)) continue;
    var a = stats.albums[k];
    if (Number(a.lastAt) < fromTs) continue;
    out.push({ albumId: k, name: a.name || ('专辑' + k), sec: Number(a.sec) || 0 });
  }
  out.sort(function (x, y) { return y.sec - x.sec; });
  return limit ? out.slice(0, limit) : out;
}

// 生成一段报告：period = week / month / all
function buildReport(period) {
  var now = Date.now();
  var from;
  if (period === 'month') {
    var d = new Date();
    from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  } else if (period === 'all') {
    from = 0;
  } else if (period === 'day') {
    var td = new Date();
    from = new Date(td.getFullYear(), td.getMonth(), td.getDate()).getTime();
  } else {
    var today = new Date();
    var dow = today.getDay() === 0 ? 7 : today.getDay();   // 周一为一周开始
    from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (dow - 1)).getTime();
  }
  var r = statRange(from, now);
  var albums = statAlbums(from, now, 5);
  var finishedN = 0;
  Object.keys(progress.tracks).forEach(function (k) {
    var p = progress.tracks[k];
    if (p.finished && Number(p.at) >= from) finishedN += 1;
  });
  var label = period === 'month' ? '本月' : (period === 'all' ? '累计' : (period === 'day' ? '今日' : '本周'));
  var text;
  if (!r.sec) {
    text = label + '还没有收听记录。';
  } else {
    text = label + '一共听了' + secToHM(r.sec) + '，' + r.days + '天有收听';
    if (r.days > 1) text += '，平均每天' + secToHM(r.sec / r.days);
    text += '。';
    if (finishedN) text += '听完' + finishedN + '集。';
    if (albums.length) text += '听得最多的是《' + albums[0].name + '》，' + secToHM(albums[0].sec) + '。';
  }
  return {
    period: period || 'week', label: label, from: from, to: now,
    sec: r.sec, hours: Math.round(r.sec / 360) / 10, days: r.days,
    avgSec: r.days ? Math.round(r.sec / r.days) : 0,
    finished: finishedN, top: albums, daily: r.list, text: text,
    albumCount: Object.keys(stats.albums).length
  };
}

// ---------- 听书习惯仪表盘 ----------
// 连续收听天数：从今天（或昨天）往前数，连续有收听记录的天数
function calcStreak() {
  var keys = Object.keys(stats.days || {});
  if (!keys.length) return { now: 0, best: 0, lastDay: '' };
  var set = {};
  keys.forEach(function (k) { if (Number(stats.days[k]) > 0) set[k] = 1; });
  var today = new Date();
  function dayAgo(n) {
    return dayKeyOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n).getTime());
  }
  // 今天没听但昨天听了，连续天数仍算（还没到晚上）
  var start = set[dayAgo(0)] ? 0 : (set[dayAgo(1)] ? 1 : -1);
  var now = 0;
  if (start >= 0) {
    for (var i = start; i < 400; i++) {
      if (!set[dayAgo(i)]) break;
      now += 1;
    }
  }
  // 历史最长连续
  var sorted = Object.keys(set).sort();
  var best = 0, run = 0, prev = '';
  sorted.forEach(function (k) {
    if (!prev) { run = 1; }
    else {
      var p = new Date(prev + 'T12:00:00').getTime();
      var c = new Date(k + 'T12:00:00').getTime();
      run = (c - p <= 86400000 * 1.5) ? run + 1 : 1;
    }
    if (run > best) best = run;
    prev = k;
  });
  var lastDay = sorted.length ? sorted[sorted.length - 1] : '';
  return { now: now, best: best, lastDay: lastDay };
}

// 时段热力：返回 24 个小时的秒数 + 峰值时段
function calcHourHeat() {
  var out = [];
  var peak = -1, peakSec = 0;
  for (var h = 0; h < 24; h++) {
    var s = Number((stats.hours || {})[h]) || 0;
    out.push(s);
    if (s > peakSec) { peakSec = s; peak = h; }
  }
  return { hours: out, peakHour: peak, peakSec: peakSec };
}

// 每张专辑的听完率：已听集数 / 总集数（总集数取订阅或进度里已知的最大集号）
function calcFinishRates(limit) {
  var perAlbum = {};
  Object.keys(progress.tracks || {}).forEach(function (k) {
    var p = progress.tracks[k];
    if (!p.albumId) return;
    var a = perAlbum[p.albumId] || { heard: 0, finished: 0, maxIndex: 0, name: p.albumName || '' };
    if (p.finished) a.finished += 1;
    if (Number(p.t) > 3) a.heard += 1;
    if (Number(p.index) > a.maxIndex) a.maxIndex = Number(p.index);
    if (!a.name && p.albumName) a.name = p.albumName;
    perAlbum[p.albumId] = a;
  });
  var subsById = {};
  (subs || []).forEach(function (s) { subsById[String(s.albumId)] = s; });
  var out = [];
  Object.keys(perAlbum).forEach(function (aid) {
    var a = perAlbum[aid];
    var sub = subsById[aid];
    var total = sub ? (Number(sub.lastIndex) || a.maxIndex) : a.maxIndex;
    if (!total) return;
    out.push({
      albumId: aid,
      name: a.name || (sub && sub.name) || ('专辑' + aid),
      finished: a.finished, heard: a.heard, total: total,
      rate: Math.min(100, Math.round(a.finished / total * 100))
    });
  });
  out.sort(function (x, y) { return y.rate - x.rate || y.finished - x.finished; });
  return limit ? out.slice(0, limit) : out;
}

// 剩余时长预估：把「在听但没听完」的书按已听平均集长推算还要多久
function calcRemain() {
  var perAlbum = {};
  Object.keys(progress.tracks || {}).forEach(function (k) {
    var p = progress.tracks[k];
    if (!p.albumId) return;
    var a = perAlbum[p.albumId] || { name: p.albumName || '', heard: 0, finished: 0, sec: 0, maxIndex: 0, avgDur: 0, dSum: 0, dCnt: 0 };
    if (p.finished) a.finished += 1;
    if (Number(p.t) > 3) a.heard += 1;
    a.sec += Number(p.t) || 0;
    a.dSum += Number(p.d) || 0;
    if (Number(p.d) > 0) a.dCnt += 1;
    if (Number(p.index) > a.maxIndex) a.maxIndex = Number(p.index);
    if (p.albumName) a.name = p.albumName;
    perAlbum[p.albumId] = a;
  });
  var subsById = {};
  (subs || []).forEach(function (s) { subsById[String(s.albumId)] = s; });
  var items = [], totalRemain = 0;
  Object.keys(perAlbum).forEach(function (aid) {
    var a = perAlbum[aid];
    var sub = subsById[aid];
    var total = sub ? (Number(sub.lastIndex) || a.maxIndex) : a.maxIndex;
    if (!total) return;
    var avgDur = a.dCnt ? Math.round(a.dSum / a.dCnt) : 0;
    if (!avgDur) avgDur = 1500;   // 默认按 25 分钟一集估
    var left = Math.max(0, total - a.finished);
    if (!left) return;
    var remainSec = left * avgDur;
    totalRemain += remainSec;
    items.push({
      albumId: aid, name: a.name || (sub && sub.name) || ('专辑' + aid),
      left: left, total: total, avgDur: avgDur, remainSec: remainSec,
      remainText: secToHM(remainSec)
    });
  });
  items.sort(function (x, y) { return y.remainSec - x.remainSec; });
  return { totalSec: totalRemain, totalText: secToHM(totalRemain), items: items.slice(0, 10) };
}

// ---------- 章节书签 ----------
var BM_KEY = 'bookmarks:v1';
var BM_MAX = 1000;
var bookmarks = [];

// 播放历史时间线：按天记录「听了哪本书的哪一集」，用于「收听」页的时间线视图
var HIST_KEY = 'history:v1';
var HIST_MAX = 2000;
var history = [];

function normBookmark(o) {
  if (!o) return null;
  var trackId = String(o.trackId || o.track_id || '');
  var t = progNum(o.t);
  if (!trackId) return null;
  return {
    id: String(o.id || ''),
    trackId: trackId,
    albumId: String(o.albumId || o.album_id || ''),
    albumName: String(o.albumName || ''),
    title: String(o.title || ''),
    index: progNum(o.index),
    cover: String(o.cover || ''),
    t: t,
    note: String(o.note || '').slice(0, 120),
    at: Number(o.at) || Date.now()
  };
}

function bmFind(id) {
  for (var i = 0; i < bookmarks.length; i++) if (String(bookmarks[i].id) === String(id)) return i;
  return -1;
}

// 同一集同一时间点（±3 秒）视为重复，避免连点产生多条
function bmAdd(raw) {
  var b = normBookmark(raw);
  if (!b) return { ok: false, error: '书签缺集号' };
  for (var i = 0; i < bookmarks.length; i++) {
    var x = bookmarks[i];
    // v0.18.7：同集 ±3 秒只合并「都没写备注」的重复点击；
    // 带了备注说明用户是刻意在附近再记一条，不能静默吞掉。
    if (String(x.trackId) === b.trackId && Math.abs((Number(x.t) || 0) - b.t) <= 3 && !(b.note && x.note)) {
      if (b.note) x.note = b.note;
      x.at = Date.now();
      persistBookmarks();
      return { ok: true, dup: true, item: x, total: bookmarks.length };
    }
  }
  if (!b.id) b.id = 'bm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  bookmarks.unshift(b);
  if (bookmarks.length > BM_MAX) bookmarks.length = BM_MAX;
  persistBookmarks();
  return { ok: true, item: b, total: bookmarks.length };
}

function bmRemove(id) {
  var i = bmFind(id);
  if (i < 0) return false;
  bookmarks.splice(i, 1);
  persistBookmarks();
  return true;
}

function bmList(albumId) {
  var out = bookmarks.filter(function (b) { return !albumId || String(b.albumId) === String(albumId); });
  out.sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); });
  return out;
}

async function persistBookmarks() {
  try { await songloft.storage.set(BM_KEY, JSON.stringify(bookmarks.slice(0, BM_MAX))); }
  catch (e) { songloft.log.warn('[喜马拉雅] 书签落盘失败: ' + String(e)); }
}

// 播放历史：同一集 10 分钟内只记一次，避免频繁刷
function histAdd(raw) {
  var h = normBookmark(raw);   // 字段与书签一致，复用归一化
  if (!h) return false;
  // v0.18.7：不只看 history[0]——多设备交替听时（A 听 5 集、B 听 6 集、A 又回 5 集）
  // 只在队头比较会插出重复条目，时间线把同一段收听展示两遍。
  // 改成在「同集且 10 分钟内」的最近一条上合并。
  var nowTs = Date.now();
  for (var i = 0; i < history.length && i < 20; i++) {
    var it = history[i];
    if (String(it.trackId) === h.trackId && nowTs - (Number(it.at) || 0) < 600 * 1000) {
      it.at = nowTs;
      it.t = Math.max(Number(it.t) || 0, h.t);
      // 挪回队头，保持「最近在前」
      if (i > 0) { history.splice(i, 1); history.unshift(it); }
      persistHistory();
      return true;
    }
  }
  h.id = 'h' + Date.now().toString(36);
  history.unshift(h);
  if (history.length > HIST_MAX) history.length = HIST_MAX;
  persistHistory();
  return true;
}

async function persistHistory() {
  try { await songloft.storage.set(HIST_KEY, JSON.stringify(history.slice(0, HIST_MAX))); }
  catch (e) { songloft.log.warn('[喜马拉雅] 历史落盘失败: ' + String(e)); }
}

// 按天分组，返回 [{day, items:[...], count}]，最近在前；kw 可按书名/集名过滤（v0.18.0）
function histTimeline(days, limit, kw) {
  var dayN = Math.max(1, Number(days) || 30);
  var cut = Date.now() - dayN * 86400000;
  var kwN = String(kw || '').trim().toLowerCase();
  var groups = {}, order = [];
  history.forEach(function (h) {
    if (Number(h.at) < cut) return;
    if (kwN) {
      var hay = ((h.title || '') + ' ' + (h.albumName || '')).toLowerCase();
      if (hay.indexOf(kwN) < 0) return;
    }
    var dk = dayKeyOf(h.at);
    if (!groups[dk]) { groups[dk] = { day: dk, items: [], count: 0, sec: 0 }; order.push(dk); }
    groups[dk].items.push(h);
    groups[dk].count += 1;
    groups[dk].sec += Number(h.t) || 0;
  });
  order.sort(function (a, b) { return a < b ? 1 : -1; });
  var out = order.map(function (k) {
    var g = groups[k];
    return {
      day: g.day,
      listSec: Number(stats.days[k]) || 0,     // 当天实际收听时长
      count: g.count,
      items: g.items.slice(0, limit && limit > 0 ? limit : 200)
    };
  });
  return out;
}

function progPrune() {
  var ids = Object.keys(progress.tracks);
  if (ids.length > PROG_MAX_TRACKS) {
    ids.sort(function (a, b) { return (Number(progress.tracks[a].at) || 0) - (Number(progress.tracks[b].at) || 0); });
    var drop = ids.length - PROG_MAX_TRACKS;
    for (var i = 0; i < drop; i++) delete progress.tracks[ids[i]];
  }
  var aids = Object.keys(progress.albums);
  if (aids.length > PROG_MAX_ALBUMS) {
    aids.sort(function (a, b) { return (Number(progress.albums[a].at) || 0) - (Number(progress.albums[b].at) || 0); });
    var drop2 = aids.length - PROG_MAX_ALBUMS;
    for (var j = 0; j < drop2; j++) delete progress.albums[aids[j]];
  }
}

function progList(albumId, limit) {
  var out = [];
  var ids = Object.keys(progress.tracks);
  for (var i = 0; i < ids.length; i++) {
    var p = progress.tracks[ids[i]];
    if (albumId && String(p.albumId) !== String(albumId)) continue;
    out.push(p);
  }
  out.sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); });
  // v0.19.4：Number('-1') 是 truthy，slice(0,-1) 会返回「除最后一条外的全部」，
  // 负 limit 反而比默认 200 返回得更多。非正数一律视为「不限」。
  var n = Math.floor(Number(limit));
  return (isFinite(n) && n > 0) ? out.slice(0, n) : out;
}

// ---------- 曲目获取 ----------

// 整专辑拉取（start/end 为集号区间，0/0 表示全部）
async function fetchAlbumTracks(albumId, start, end, maxPages) {
  var tracks = [], albumName = '', page = 1;
  var limit = maxPages || MAX_PAGES;
  while (page <= limit) {
    var batch = await fetchShowPage(albumId, page);
    if (batch.length && !albumName) albumName = batch[0].albumName || ('专辑' + albumId);
    for (var i = 0; i < batch.length; i++) {
      var t = mapTrack(batch[i], albumName);
      if (end && t.index > end) continue;
      tracks.push(t);
    }
    if (batch.length < PAGE_SIZE) break;
    if (end && batch[batch.length - 1].index >= end) break;
    page += 1;
  }
  if (!tracks.length) throw new Error('未取到曲目，专辑可能已下架或 ID 无效');
  if (start || end) {
    var lo = start || 1, hi = end || 999999;
    tracks = tracks.filter(function (t) { return t.index >= lo && t.index <= hi; });
  }
  return { albumName: albumName || ('专辑' + albumId), tracks: tracks };
}

// 增量拉取：只返回 index > afterIndex 的曲目
async function fetchNewTracks(albumId, afterIndex) {
  var after = Number(afterIndex) || 0;
  var startPage = after > 0 ? Math.max(1, Math.floor((after - 1) / PAGE_SIZE) + 1) : 1;
  var out = [], page = startPage, guard = 0, albumName = '', lastIndex = after;

  while (page <= MAX_PAGES && guard < SYNC_MAX_PAGES) {
    var batch = await fetchShowPage(albumId, page);
    guard += 1;
    if (!batch.length) break;
    if (!albumName) albumName = batch[0].albumName || '';
    for (var i = 0; i < batch.length; i++) {
      var t = mapTrack(batch[i], albumName);
      if (t.index > after) out.push(t);
      if (t.index > lastIndex) lastIndex = t.index;
    }
    if (batch.length < PAGE_SIZE) break;
    page += 1;
  }
  return { tracks: out, lastIndex: lastIndex, albumName: albumName };
}

// ---------- 写入歌单 ----------

function toSongInput(t) {
  return {
    title: t.index + '. ' + t.title,
    artist: t.author || '喜马拉雅',
    album: t.album || t.title,
    coverUrl: t.cover || '',
    duration: t.duration || 0,
    sourceData: JSON.stringify({ trackId: t.trackId, title: t.title, album: t.album, cover: t.cover, duration: t.duration }),
    dedupKey: 'xm:' + t.trackId
  };
}

// 把主播名/专辑名带到每一集上：导入后歌曲库的「艺术家」是主播，专辑名也不会是「专辑111」
function stampAuthor(tracks, author, albumName) {
  if (!tracks) return tracks;
  for (var i = 0; i < tracks.length; i++) {
    var t = tracks[i];
    if (author && !t.author) t.author = author;
    if (albumName && (!t.album || /^专辑\d+$/.test(t.album))) t.album = albumName;
  }
  return tracks;
}

async function addTracksToPlaylist(playlistId, tracks, onProgress) {
  var added = 0, failed = 0;
  var failedTracks = [];   // v0.18.0：记下写入失败的具体集，支持一键重试
  var maxOkIndex = 0;      // v0.18.7：成功写入的最大集号，用来算增量同步该从哪补
  for (var i = 0; i < tracks.length; i += BATCH) {
    var slice = tracks.slice(i, i + BATCH);
    try {
      var created = await songloft.songs.create(slice.map(toSongInput));
      var ids = (created || []).map(function (s) { return s && s.id; }).filter(function (x) { return !!x; });
      if (ids.length) {
        var r = await songloft.playlists.addSongs(playlistId, ids);
        added += (r && typeof r.added === 'number') ? r.added : ids.length;
        var sliceMax = 0;
        slice.forEach(function (t) { var ix = Number(t.index) || 0; if (ix > sliceMax) sliceMax = ix; });
        if (sliceMax > maxOkIndex) maxOkIndex = sliceMax;
      }
    } catch (e) {
      failed += slice.length;
      slice.forEach(function (t) { failedTracks.push(t); });
      songloft.log.warn('[喜马拉雅] 批量写入失败(' + i + '): ' + String(e));
    }
    if (onProgress) onProgress(slice.length);
  }
  return { added: added, failed: failed, failedTracks: failedTracks, lastIndex: maxOkIndex };
}

// ---------- 导入 ----------

async function runImport(albumId, name, start, end) {
  job = { running: true, mode: 'single', title: '', done: 0, total: 0, playlistId: 0, error: '', finishedAt: '', current: '', parts: [] };
  await persist();
  try {
    var detail = null;
    try { detail = await fetchAlbumDetail(albumId); } catch (e) { detail = null; }

    var fetched = await fetchAlbumTracks(albumId, start, end);
    stampAuthor(fetched.tracks, detail && detail.author, detail && detail.name);
    var title = name || (detail && detail.name) || fetched.albumName;
    job.title = title;
    job.current = title;
    job.total = fetched.tracks.length;
    job.parts = [{ albumId: String(albumId), name: title, count: fetched.tracks.length }];
    songloft.log.info('[喜马拉雅] 开始导入: ' + title + '，共 ' + job.total + ' 集');
    await persist();

    var playlist = await songloft.playlists.create({
      name: title,
      description: '来自喜马拉雅 · 专辑 ' + albumId + (detail && detail.author ? ' · ' + detail.author : ''),
      coverUrl: (detail && detail.cover) || (fetched.tracks[0] && fetched.tracks[0].cover) || ''
    });
    job.playlistId = playlist.id;
    await persist();

    var res = await addTracksToPlaylist(playlist.id, fetched.tracks, function (n) {
      job.done += n;
      persist().catch(function () { });
    });

    var lastIdx = 0;
    fetched.tracks.forEach(function (t) { if (t.index > lastIdx) lastIdx = t.index; });

    // v0.19.4：写入失败的集必须挂到订阅的待补列表上。水位仍推到末集（避免下次同步重拉到重复集），
    // 但失败集的集号 ≤ 水位、fetchNewTracks 永远不会再拉到它们，待补列表是唯一记录。
    // 原来这里既不挂 pendingTracks，也不看 res.failed —— 一次批量失败就是永久丢集。
    var pendFail = (res.failedTracks || []).slice(0, 300);
    if (pendFail.length) {
      songloft.log.warn('[喜马拉雅]《' + title + '》导入有 ' + pendFail.length + ' 集写入失败，已挂待补，下次同步自动重试');
    }

    imported.unshift({
      albumId: String(albumId),
      name: title,
      playlistId: playlist.id,
      count: res.added,
      importedAt: nowStr()
    });
    upsertSub({
      albumId: String(albumId),
      name: title,
      playlistId: playlist.id,
      lastIndex: lastIdx,
      pendingTracks: pendFail,
      songCount: res.added,
      cover: (detail && detail.cover) || '',
      author: (detail && detail.author) || '',
      updateDate: (detail && detail.updateDate) || '',
      lastCheckAt: nowStr(),
      newCount: 0,
      newTitles: []
    });

    job.running = false;
    job.finishedAt = nowStr();
    job.failedTracks = (res.failedTracks || []).slice(0, 200);   // 上限 200，免得 job 落盘膨胀
    if (res.failed) job.error = '有 ' + res.failed + ' 集写入失败';
    await persist();
    songloft.log.info('[喜马拉雅] 导入完成: ' + title + ' → 歌单 ' + playlist.id + '（' + job.done + '/' + job.total + '）');
  } catch (e) {
    job.running = false;
    job.error = String(e);
    job.finishedAt = nowStr();
    await persist();
    songloft.log.error('[喜马拉雅] 导入失败: ' + String(e));
  }
}

// 多专辑：mode=merge 合并到一个歌单；mode=separate 每张一个歌单
async function runImportMulti(items, mode, mergedName) {
  job = {
    running: true, mode: mode || 'separate', title: '', done: 0, total: 0, playlistId: 0,
    error: '', finishedAt: '', current: '', parts: []
  };
  await persist();
  var merged = null;
  try {
    if (mode === 'merge') {
      merged = await songloft.playlists.create({
        name: mergedName || ('喜马拉雅合集 ' + todayStr()),
        description: '来自喜马拉雅 · 合并导入 ' + items.length + ' 张专辑'
      });
      job.playlistId = merged.id;
      job.title = merged.name;
    }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var part = { albumId: String(it.id), name: it.name || ('专辑' + it.id), count: 0, error: '' };
      job.parts.push(part);
      job.current = part.name;
      await persist();
      try {
        var detail = null;
        try { detail = await fetchAlbumDetail(it.id); } catch (e) { detail = null; }
        var fetched = await fetchAlbumTracks(it.id, 0, 0);
        stampAuthor(fetched.tracks, detail && detail.author, detail && detail.name);
        part.count = fetched.tracks.length;
        job.total += fetched.tracks.length;
        await persist();

        var pl = merged;
        if (!pl) {
          pl = await songloft.playlists.create({
            name: (detail && detail.name) || part.name,
            description: '来自喜马拉雅 · 专辑 ' + it.id + (detail && detail.author ? ' · ' + detail.author : ''),
            coverUrl: (detail && detail.cover) || ''
          });
        }
        var res = await addTracksToPlaylist(pl.id, fetched.tracks, function (n) {
          job.done += n;
          persist().catch(function () { });
        });
        // v0.18.7：记下本专辑实际写入成功数，供「待听清单是否划掉」判断
        part.added = res.added;
        part.count = fetched.tracks.length;
        if (res.failedTracks && res.failedTracks.length) {
          // v0.19.4：失败集按 part 分组存。原来统一 concat 到 job.failedTracks 而 retryPlaylistId
          // 只记最后一张歌单，separate 模式下会把 A 专辑的失败集写进 B 专辑的歌单（真写进去，极难发现）
          part.failedTracks = (part.failedTracks || []).concat(res.failedTracks).slice(0, 200);
          part.retryPlaylistId = pl.id;
          // v0.18.7：写入有失败时标记到 part.error，避免待听清单把这本「划掉」却其实没导进去
          part.error = res.added
            ? (res.failedTracks.length + ' 集写入失败')
            : ('全部 ' + res.failedTracks.length + ' 集写入失败');
        }

        // v0.18.7：lastIndex 只在「全部写入成功」时才推进到最大集号；
        // 否则取本批成功写入的最大集号，保证下次增量同步能把漏掉的集补回来。
        var maxIdx = 0;
        fetched.tracks.forEach(function (t) { if (t.index > maxIdx) maxIdx = t.index; });
        var lastIdx = (res.added && res.added === fetched.tracks.length) ? maxIdx : (res.lastIndex || 0);

        imported.unshift({
          albumId: String(it.id),
          name: (detail && detail.name) || part.name,
          playlistId: pl.id,
          count: res.added,
          importedAt: nowStr()
        });
        upsertSub({
          albumId: String(it.id),
          name: (detail && detail.name) || part.name,
          playlistId: pl.id,
          lastIndex: lastIdx,
          songCount: res.added,
          cover: (detail && detail.cover) || '',
          author: (detail && detail.author) || '',
          updateDate: (detail && detail.updateDate) || '',
          lastCheckAt: nowStr(),
          newCount: 0,
          newTitles: []
        });
      } catch (e) {
        part.error = String(e);
        songloft.log.warn('[喜马拉雅] 专辑 ' + part.name + ' 导入失败: ' + String(e));
      }
      await persist();
    }
    job.running = false;
    job.finishedAt = nowStr();
    await persist();
    // 从待听清单来的：导完就出清单，成功的才清
    try {
      var okIds = [];
      (job.parts || []).forEach(function (p) {
        // v0.18.7：必须真导进去了才划掉——原来只看 p.error，写入失败不抛异常，
        // 会导致「清单划掉了但书没导进去」，用户以为已经处理过。
        var cnt = Number(p.count) || 0;
        var got = Number(p.added !== undefined ? p.added : cnt) || 0;
        if (!p.error && got > 0 && got >= cnt) okIds.push(String(p.albumId));
      });
      var dropped = todoDrop(okIds);
      if (dropped) songloft.log.info('[喜马拉雅] 待听清单已划掉 ' + dropped + ' 张专辑');
    } catch (e) { /* */ }
    songloft.log.info('[喜马拉雅] 批量导入完成: ' + job.done + '/' + job.total);

  } catch (e) {
    job.running = false;
    job.error = String(e);
    job.finishedAt = nowStr();
    await persist();
    songloft.log.error('[喜马拉雅] 批量导入失败: ' + String(e));
  }
}

// ---------- 订阅 / 增量更新 ----------

// 一段错误信息像不像「登录失效」导致的（用来给出针对性提示，而不是让用户猜）
function dataLooksLikeLoginError(msg) {
  var s = String(msg || '');
  return /ret=(4|5)\d\d|401|403|未登录|登录|鉴权|auth/i.test(s) && !/timeout|ETIMEDOUT|ECONNRESET/i.test(s);
}

async function syncOne(sub, opts) {
  opts = opts || {};
  var out = { albumId: sub.albumId, name: sub.name, newCount: 0, added: 0, error: '', titles: [] };
  try {
    var detail = null;
    try { detail = await fetchAlbumDetail(sub.albumId); } catch (e) { detail = null; }
    if (detail) {
      if (detail.name) sub.name = detail.name;
      if (detail.cover) sub.cover = detail.cover;
      if (detail.author) sub.author = detail.author;
      sub.updateDate = detail.updateDate;
    }

    // v0.18.7：先补上次写入失败的集，再拉新集
    if (opts.import && sub.playlistId && (sub.pendingTracks || []).length) {
      var pend = sub.pendingTracks.slice();
      stampAuthor(pend, sub.author, sub.name);
      var pr2 = await addTracksToPlaylist(sub.playlistId, pend);
      var pr2Added = Number(pr2.added) || 0;   // v0.19.4：下面算 songCount 也要用
      out.added += pr2Added;
      sub.pendingTracks = pr2.failedTracks || [];
      if (pr2.added) songloft.log.info('[喜马拉雅] 补上上次失败的 ' + pr2.added + ' 集：《' + (sub.name || sub.albumId) + '》');
    }

    var r = await fetchNewTracks(sub.albumId, sub.lastIndex || 0);
    out.newCount = r.tracks.length;
    out.titles = r.tracks.map(function (t) { return t.index + '. ' + t.title; });
    sub.newCount = r.tracks.length;
    sub.newTitles = r.tracks.slice(-3).map(function (t) { return t.index + '. ' + t.title; });
    sub.lastCheckAt = nowStr();

    if (r.tracks.length && opts.import && sub.playlistId) {
      stampAuthor(r.tracks, sub.author, sub.name);
      var res = await addTracksToPlaylist(sub.playlistId, r.tracks);
      // v0.19.4：这里必须是 +=。原写成 = 把上面「补上次失败集」的数量吞掉，
      // 导致 totalAdded / 播报文本 / songCount 全部少算。
      out.added += (Number(res.added) || 0);
      sub.lastIndex = r.lastIndex;
      sub.songCount = (Number(sub.songCount) || 0) + pr2Added + (Number(res.added) || 0);
      // v0.18.7：写入失败的集挂到 sub 上，下次同步会先补这批（不能只靠 lastIndex 推进）
      // v0.19.2：这批失败就追加；这批全成功也不能清空 —— 上面重试后仍失败的 pendingTracks
      // 已经是「唯一记录」，一清就永久丢集（它们的集号 ≤ lastIndex，不会再被拉到）。
      if (res.failedTracks && res.failedTracks.length) {
        // v0.19.4：原来 slice(-300) 保留最新 300、丢掉最早的 —— 而这些集号已经 ≤ 水位，
        // 被丢掉就是永久缺失且无任何痕迹。改成保留最早 300（用户先听到的），并留日志。
        var pendAll = (sub.pendingTracks || []).concat(res.failedTracks);
        pendAll.sort(function (a, b) { return (Number(a.index) || 0) - (Number(b.index) || 0); });
        if (pendAll.length > 300) {
          songloft.log.warn('[喜马拉雅]《' + (sub.name || sub.albumId) + '》待补集超过 300，只保留最早的 300 集，丢掉 ' + (pendAll.length - 300) + ' 集');
          pendAll = pendAll.slice(0, 300);
        }
        sub.pendingTracks = pendAll;
        out.error = res.failedTracks.length + ' 集写入失败，下次同步自动补';
        songloft.log.warn('[喜马拉雅]《' + (sub.name || sub.albumId) + '》' + out.error);
      }
      sub.newCount = 0;
      sub.newTitles = [];
      sub.lastImportAt = nowStr();
    }
    await persist();
  } catch (e) {
    out.error = String(e);
    sub.lastCheckAt = nowStr();
    await persist();
    if (dataLooksLikeLoginError(out.error)) logWarn('sync', '《' + (sub.name || sub.albumId) + '》同步失败，疑似登录态失效：' + out.error);
  }
  return out;
}

async function runSyncAll(opts) {
  opts = opts || {};
  if (syncing) return { skipped: true, newCount: 0, checked: 0, errors: [], updates: [] };
  syncing = true;
  var totalNew = 0, totalAdded = 0, checked = 0, errors = [], updates = [];
  var pushed = null;
  try {
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      if (!opts.force && s.autoSync === false) continue;
      var r = await syncOne(s, { import: opts.import !== false });
      checked += 1;
      totalNew += r.newCount || 0;
      totalAdded += r.added || 0;
      if (r.added) updates.push({ albumId: s.albumId, name: s.name, added: r.added, titles: r.titles || [] });
      if (r.error) errors.push(r.name + ': ' + r.error);
      if (r.added && !pushed) pushed = s;
    }
    lastSync = {
      at: nowStr(),
      result: '检查 ' + checked + ' 张，新增 ' + totalAdded + ' 集' + (errors.length ? '，' + errors.length + ' 张出错' : ''),
      trigger: opts.trigger || '手动'
    };
    if (errors.length) logWarn('sync', '同步有 ' + errors.length + ' 张失败：' + errors.slice(0, 3).join('；'));
    if (opts.markAuto) { config.auto.lastRunDate = todayStr(); }
    await persist();

    songloft.log.info('[喜马拉雅] 同步完成：' + lastSync.result);
  } finally {
    syncing = false;
  }
  return { newCount: totalAdded, checked: checked, errors: errors, updates: updates };
}

// ---------- 关键词追更 ----------
// 每个关键词记一张「已见过的专辑」表，每次运行搜索该词，把排在前面的新专辑
// 自动建成歌单（只取最近 maxNew 集），这样不用逐张订阅也能跟上新节目。
// item: { id, kw, maxNew, lastRunAt, added, errors, seen: { albumId: name } }

function findWatch(id) {
  for (var i = 0; i < watch.items.length; i++) if (String(watch.items[i].id) === String(id)) return watch.items[i];
  return null;
}

function watchId() { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 找到某专辑已经导入过的歌单（追更时复用，避免每次追更都建新歌单）
function playlistForAlbum(albumId) {
  var sub = findSub(albumId);
  if (sub && sub.playlistId) return sub.playlistId;
  for (var i = 0; i < imported.length; i++) {
    if (String(imported[i].albumId) === String(albumId)) return imported[i].playlistId;
  }
  return 0;
}

async function createOrReusePlaylist(name, cover, desc) {
  try {
    var p = await songloft.playlists.create({ name: name, description: desc || '', coverUrl: cover || '' });
    return p.id;
  } catch (e) {
    if (!/same name|already exists/i.test(String(e))) throw e;
    // 同名歌单已存在 → 按名字找回来复用
    var list = await songloft.playlists.list();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].name) === String(name)) return list[i].id;
    }
    throw e;
  }
}

// 把一张专辑「最近 N 集」导成歌单（若已有同名歌单则复用并只补缺的集）
async function importLatest(albumId, albumName, maxNew, author) {
  var o = await fetchAlbumOutline(albumId);
  var total = Number(o.lastIndex) || 0;
  if (!total) return { added: 0, name: albumName, playlistId: 0 };
  var start = Math.max(1, total - Math.max(1, maxNew) + 1);
  if (maxNew >= 9999) start = 1;

  // 只扫需要的页：从 start 所在页开始往后拉（大专辑不必从头翻）
  var tracks = [], page = Math.max(1, Math.floor((start - 1) / PAGE_SIZE) + 1), an = albumName;
  for (; page <= Math.ceil(total / PAGE_SIZE) + 1; page++) {
    var batch = await fetchShowPage(albumId, page);
    if (!batch.length) break;
    if (!an) an = batch[0].albumName || albumName;
    var stop = false;
    for (var bi = 0; bi < batch.length; bi++) {
      var t = mapTrack(batch[bi], an);
      if (t.index >= start) tracks.push(t);
      if (t.index >= total) { stop = true; break; }
    }
    if (stop) break;
  }
  if (!tracks.length) return { added: 0, name: an, playlistId: 0 };
  stampAuthor(tracks, author, an);

  var plId = playlistForAlbum(albumId);
  if (!plId) {
    plId = await createOrReusePlaylist(an, (tracks[0] && tracks[0].cover) || '',
      '来自喜马拉雅 · 关键词追更 · 专辑 ' + albumId);
    imported.unshift({ albumId: String(albumId), name: an, playlistId: plId, count: 0, importedAt: nowStr() });
  }
  var res = await addTracksToPlaylist(plId, tracks);

  // v0.19.2：有集写失败就别把水位推到末尾。
  // 原来无条件 lastIndex=total，失败那几集既不进歌单、也永远 fetchNewTracks 不到（只看 > lastIndex）→ 永久缺集。
  var lastIdx = total;
  var pendFail = (res.failedTracks || []).slice();
  if (pendFail.length) {
    var minFail = Number.MAX_SAFE_INTEGER;
    for (var fi = 0; fi < pendFail.length; fi++) {
      var fidx = Number(pendFail[fi].index) || 0;
      if (fidx && fidx < minFail) minFail = fidx;
    }
    if (minFail !== Number.MAX_SAFE_INTEGER) lastIdx = Math.max(0, minFail - 1);
    songloft.log.warn('[喜马拉雅]《' + an + '》追更写入失败 ' + pendFail.length + ' 集，水位回退到 ' + lastIdx + '，下次同步重试');
  }
  var prevSub = findSub(albumId) || {};
  upsertSub({
    albumId: String(albumId), name: an, playlistId: plId,
    lastIndex: lastIdx, songCount: (Number(prevSub.songCount) || 0) + (res.added || 0),
    cover: (tracks[0] && tracks[0].cover) || '', author: author || '',
    lastCheckAt: nowStr(), autoSync: true,
    pendingTracks: ((prevSub.pendingTracks || []).concat(pendFail)).slice(-300)
  });
  var imp = null;
  for (var k = 0; k < imported.length; k++) if (String(imported[k].albumId) === String(albumId)) { imp = imported[k]; break; }
  if (imp) imp.count = (Number(imp.count) || 0) + (res.added || 0);
  await persist();
  return { added: res.added || 0, name: an, playlistId: plId };
}

async function runWatchOne(item) {
  var out = { id: item.id, kw: item.kw, added: 0, newAlbums: [], errors: [] };
  try {
    var sr = await searchAlbumsSmart(item.kw);
    var albums = (sr.albums || []).slice(0, Math.max(1, Number(config.watch.maxAlbums) || 3));
    if (!albums.length) { out.errors.push('没有搜到结果'); return out; }
    for (var i = 0; i < albums.length; i++) {
      var a = albums[i];
      var aid = String(a.id);
      if (item.seen && item.seen[aid]) continue;   // 已经处理过的专辑不再动
      try {
        var r = await importLatest(aid, a.title, Number(item.maxNew) || config.watch.maxNew || 10, a.author);
        // v0.19.2：只有真的落到歌单上才算「处理过」。
        // 原来只要没抛异常就记 seen，而 outline 取不到（total=0/tracks 空）时 playlistId=0、一集没导，
        // 这张专辑就被永久拉黑，关键词追更以后再也不碰它。
        if (r.playlistId) {
          item.seen[aid] = a.title;
          out.newAlbums.push({ albumId: aid, name: a.title, added: r.added, playlistId: r.playlistId });
        } else {
          // 取不到集数（可能临时失败/被限流）：不记 seen，下次追更再试
          out.errors.push(a.title + '：没取到集数，下次再试');
        }
        out.added += r.added;
      } catch (e) {
        out.errors.push(a.title + '：' + String(e).slice(0, 80));
      }
    }
  } catch (e) {
    out.errors.push(String(e).slice(0, 120));
  }
  item.seen = item.seen || {};
  item.lastRunAt = nowStr();
  item.lastAdded = out.added;
  item.lastNewAlbums = out.newAlbums.map(function (x) { return x.name; });
  item.lastError = out.errors.length ? out.errors.join('；') : '';
  return out;
}

async function runWatchAll(opts) {
  opts = opts || {};
  if (!watch.items.length) return { ok: true, added: 0, checked: 0, results: [], message: '还没有关键词' };
  if (watch.job.running) return { ok: false, added: 0, checked: 0, results: [], message: '追更任务进行中' };
  watch.job = { running: true, at: nowStr(), added: 0, msg: '开始' };
  await persistWatch();
  var results = [], total = 0;
  try {
    for (var i = 0; i < watch.items.length; i++) {
      var it = watch.items[i];
      watch.job.msg = '正在处理「' + it.kw + '」';
      await persistWatch();
      var r = await runWatchOne(it);
      results.push(r);
      total += r.added;
      watch.job.added = total;
      await persistWatch();
    }
    watch.job.msg = '完成，共新增 ' + total + ' 集';
  } catch (e) {
    watch.job.msg = '失败：' + String(e);
  } finally {
    watch.job.running = false;
    watch.job.at = nowStr();
    await persistWatch();
  }
  return { ok: true, added: total, checked: watch.items.length, results: results };
}

async function tick() {
  if (syncing) return;
  var now = hhmmNow();
  var today = todayStr();

  // ⓪ 登录态巡检：每天一次（登录失效会让同步与播放静默失败，早点发现早点提醒）
  if (login.cookie && config.cookieCheck !== false &&
    (!cookieCheck.lastCheckDay || cookieCheck.lastCheckDay !== today)) {
    cookieCheck.lastCheckDay = today;
    try { await checkCookieHealth(true); } catch (e) { /* 巡检失败不影响主流程 */ }
  }

  // 定时自动同步（播报刚同步过就不重复跑，避免一天两次全量抓取）
  if (config.auto && config.auto.enabled && config.auto.lastRunDate !== today && hmMin(now) >= hmMin(config.auto.time || '08:30')) {
    songloft.log.info('[喜马拉雅] 触发定时同步（设定 ' + config.auto.time + '）');
    await runSyncAll({ import: true, markAuto: true, trigger: '定时' });
  }

  // 关键词追更（跟着定时同步的开关与时间走，避免一天多次抓取）
  var wc = config.watch || {};
  if (wc.enabled && watch.items.length && wc.lastRunDate !== today) {
    var at = String(wc.time || (config.auto && config.auto.time) || '08:30');
    if (hmMin(now) < hmMin(at)) return;
    // v0.18.7：上次因任务占用没跑成时，等 1 小时再试，避免每分钟都去撞
    if (wc.lastTryAt && (Date.now() - (new Date(String(wc.lastTryAt).replace(' ', 'T')).getTime() || 0)) < 3600000) return;
    songloft.log.info('[喜马拉雅] 触发关键词追更，共 ' + watch.items.length + ' 个关键词');
    var wr = await runWatchAll({});
    // v0.18.7：任务被并发占用（返回 ok:false）时不能标记今天已跑，
    // 否则当天定时追更被吞掉，用户以为追过了其实一集没拉。
    if (wr && wr.ok === false) {
      songloft.log.warn('[喜马拉雅] 定时追更未执行（' + (wr.message || '任务占用中') + '），1 小时后再试');
      wc.lastTryAt = nowStr();
      await persist();
      return;
    }
    wc.lastRunDate = today;
    wc.lastResultAt = nowStr();
    wc.lastAdded = wr.added || 0;
    wc.lastMessage = wr.message || ('新增 ' + (wr.added || 0) + ' 集');
    await persist();
    songloft.log.info('[喜马拉雅] 关键词追更：' + wc.lastMessage);
  }
}

// ---------- 整本下载到本地音乐目录 ----------

// ---------- 本机音乐库联通：认出哪些集已经下载到本地 ----------
// 思路：本插件导入的歌曲 sourceData 里带 xm trackId，下载后歌曲类型变 local 且多出 filePath。
// 扫一遍所有歌单即可得到「已下载的 trackId → 本地文件路径」映射，用来做标记与离线播放。

var libMap = null;      // {trackId: {path, songId, playlistId, size, title}}
var libAt = 0;
var libScanning = false;
var LIB_TTL = 5 * 60 * 1000;

function songFilePath(s) {
  if (!s) return '';
  return String(s.filePath || s.file_path || s.path || '') || '';
}

function songIsLocal(s) {
  if (!s) return false;
  if (s.type === 'local') return true;
  var p = songFilePath(s);
  return !!p && !/^https?:/i.test(p);
}

async function scanLocalLibrary(force) {
  if (libScanning) return libMap || {};
  if (!force && libMap && Date.now() - libAt < LIB_TTL) return libMap;
  if (!songloft.playlists || typeof songloft.playlists.list !== 'function') return libMap || {};
  libScanning = true;
  var map = {};
  try {
    var pls = await songloft.playlists.list() || [];
    for (var i = 0; i < pls.length; i++) {
      var p = pls[i];
      var songs = [];
      try { songs = await collectPlaylistSongs(p.id); } catch (e) { songs = []; }
      for (var j = 0; j < songs.length; j++) {
        var s = songs[j];
        if (!songIsLocal(s)) continue;
        var tid = songTrackId(s);
        if (!tid) continue;
        // 同一集可能在多个歌单里，优先保留有文件路径的
        var prev = map[tid];
        var fp = songFilePath(s);
        if (!prev || (!prev.path && fp)) {
          map[tid] = {
            trackId: tid, path: fp, songId: s.id, playlistId: p.id,
            title: s.title || '', size: Number(s.fileSize || s.file_size || 0) || 0
          };
        }
      }
    }
    libMap = map;
    libAt = Date.now();
  } catch (e) {
    songloft.log.warn('[喜马拉雅] 扫描本地音乐库失败: ' + String(e));
    if (!libMap) libMap = {};
  } finally {
    libScanning = false;
  }
  return libMap || {};
}

// 某张专辑已下载/未下载的集数统计 + 未下载的 trackId 列表
function libStatFor(albumTracks, map) {
  var got = [], missing = [];
  (albumTracks || []).forEach(function (t) {
    var tid = String(t.trackId || '');
    if (!tid) return;
    if (map && map[tid]) got.push(tid); else missing.push(tid);
  });
  return { downloaded: got.length, missing: missing.length, missingIds: missing, downloadedIds: got };
}

async function collectPlaylistSongs(playlistId) {
  var out = [], offset = 0, pageSize = 200;
  for (var guard = 0; guard < 100; guard++) {
    var batch = await songloft.playlists.getSongs(playlistId, { limit: pageSize, offset: offset });
    if (!batch || !batch.length) break;
    out = out.concat(batch);
    if (batch.length < pageSize) break;
    offset += batch.length;
  }
  return out;
}

// 取歌曲里存的喜马拉雅 trackId
function songTrackId(s) {
  if (!s) return '';
  var sd = s.sourceData !== undefined ? s.sourceData : s.source_data;
  if (!sd) return '';
  if (typeof sd === 'object') return String(sd.trackId || sd.track_id || '');
  var str = String(sd);
  var m = str.match(/"track_?[iI]d"\s*:\s*"?([0-9]+)/);
  return m ? m[1] : '';
}

// 只下载「本插件导入的远程歌曲」，本地文件跳过
function isXmRemoteSong(s) {
  if (!s) return false;
  if (s.type === 'local') return false;
  var sd = s.sourceData !== undefined ? s.sourceData : s.source_data;
  if (!sd) return false;
  if (typeof sd === 'object') return !!(sd.trackId || sd.track_id);
  var str = String(sd);
  return str.indexOf('trackId') >= 0;
}

async function runDownload(playlistId, subDir, title) {
  // 落地目录用 path_template 的前缀表达：子目录/主播/专辑/集名
  var sub = String(subDir || '').replace(/^\/+|\/+$/g, '');
  var pathTpl = (sub ? sub + '/' : '') + '{artist}/{album}/{title}';
  if (downloading) return { ok: false, error: '已有下载任务进行中' };
  if (typeof songloft.songs.download !== 'function') {
    return { ok: false, error: '当前 Songloft 版本不支持下载到本地（songs.download 不可用），请先升级宿主' };
  }
  if (!playlistId) return { ok: false, error: '缺少歌单' };

  downloading = true;
  dlJob = {
    running: true, playlistId: Number(playlistId) || 0, title: title || '', done: 0, total: 0,
    ok: 0, fail: 0, current: '正在读取歌单…', error: '', finishedAt: '',
    targetDir: sub, cancel: false
  };
  await persistDl();

  try {
    var all = await collectPlaylistSongs(playlistId);
    var songs = all.filter(isXmRemoteSong);
    dlJob.total = songs.length;
    await persistDl();
    if (!songs.length) throw new Error('这个歌单里没有可下载的喜马拉雅集数（可能已经全部下载过了）');

    var lastErr = '';
    for (var i = 0; i < songs.length; i++) {
      if (dlJob.cancel) break;
      var s = songs[i];
      dlJob.current = s.title || ('第 ' + (i + 1) + ' 集');
      try {
        var dlOpt = { embed_metadata: true, path_template: pathTpl };
        // 喜马拉雅多为 m4a/48K 源，统一转 mp3 才能写标签、拖进别的播放器也不挑格式
        if (config.dl && config.dl.format === 'mp3') {
          dlOpt.format = 'mp3';
          dlOpt.quality = '128';
        }
        songloft.log.info('[喜马拉雅] 下载 ' + dlJob.current + ' trackId=' + songTrackId(s) + ' format=' + (dlOpt.format || '原格式'));
        var r = await songloft.songs.download(s.id, dlOpt);
        if (r && (r.status === 'ok' || r.path)) { dlJob.ok += 1; if (r.path) dlJob.lastPath = r.path; }
        else { dlJob.fail += 1; lastErr = (r && r.error) || '未知错误'; }
      } catch (e) {
        dlJob.fail += 1;
        lastErr = String(e && e.message || e);
        if (lastErr.indexOf('paid') >= 0) lastErr = '付费/VIP 内容，需要登录且账号已购买';
        songloft.log.warn('[喜马拉雅] 下载失败《' + dlJob.current + '》: ' + lastErr);
      }
      dlJob.done += 1;
      if (dlJob.done % 3 === 0 || dlJob.done === dlJob.total) await persistDl();
    }
    dlJob.running = false;
    dlJob.current = '';
    dlJob.finishedAt = nowStr();
    if (lastErr && !dlJob.ok) dlJob.error = '全部失败，最后一条错误：' + lastErr;
    else if (dlJob.fail) dlJob.error = dlJob.fail + ' 集下载失败' + (lastErr ? '：' + lastErr : '');
    await persistDl();
    if (dlJob.fail) logWarn('download', '《' + (dlJob.title || '') + '》失败 ' + dlJob.fail + ' 集：' + (lastErr || ''));
    songloft.log.info('[喜马拉雅] 下载完成：成功 ' + dlJob.ok + '，失败 ' + dlJob.fail + '，歌单 ' + playlistId);
    return { ok: true, ok_count: dlJob.ok, fail: dlJob.fail, total: dlJob.total };
  } catch (e) {
    dlJob.running = false;
    dlJob.error = String(e && e.message || e);
    dlJob.finishedAt = nowStr();
    await persistDl();
    songloft.log.error('[喜马拉雅] 下载任务失败: ' + dlJob.error);
    return { ok: false, error: dlJob.error };
  } finally {
    downloading = false;
  }
}

// ---------- 专辑对比 ----------
// 「这两本哪本更适合我」是选书时最真实的困惑。这里把两张专辑的关键指标摆在一起，
// 只给客观数字（集数/播放量/订阅数/付费/更新日期），不做主观判断。
function cmpMetric(a, b) {
  // 返回两边谁更「多」，用于界面上高亮
  var na = Number(a) || 0, nb = Number(b) || 0;
  if (na === nb) return 'tie';
  return na > nb ? 'a' : 'b';
}

async function compareAlbums(idA, idB) {
  var da = null, db = null;
  var errs = [];
  try { da = await fetchAlbumDetail(idA); } catch (e) { errs.push('第一张：' + String(e && e.message || e)); }
  try { db = await fetchAlbumDetail(idB); } catch (e) { errs.push('第二张：' + String(e && e.message || e)); }
  if (!da || !db) return { ok: false, error: errs.join('；') || '两张专辑都需要有效 ID' };

  // 集数取接口给的 trackCount，拿不到就数第一页的规模
  var cntA = Number(da.count) || 0, cntB = Number(db.count) || 0;
  if (!cntA || !cntB) {
    try {
      var oa = await fetchAlbumOutline(idA);
      cntA = oa.lastIndex || cntA;
      da.count = cntA;
    } catch (e) { /* 拿不到就空着 */ }
    try {
      var ob = await fetchAlbumOutline(idB);
      cntB = ob.lastIndex || cntB;
      db.count = cntB;
    } catch (e) { /* */ }
  }

  function row(label, a, b, hint) {
    return { label: label, a: a, b: b, better: cmpMetric(a, b), hint: hint || '' };
  }
  var rows = [
    row('集数', cntA, cntB, '集'),
    row('播放量', da.playCount, db.playCount, ''),
    row('订阅数', da.subscribeCount, db.subscribeCount, '')
  ];

  var cmp = {
    ok: true,
    albums: [da, db],
    rows: rows,
    sameAuthor: !!da.author && da.author === db.author,
    payDiff: (!!da.isPaid) !== (!!db.isPaid) ? (da.isPaid ? 'a' : 'b') : '',
    dateA: da.updateDate || '', dateB: db.updateDate || ''
  };

  return cmp;
}

// ---------- 导出订阅清单 ----------
// 换设备、迁移、留档都可能要一份「我订了什么」。三种格式：
// json 给程序用、csv 给表格用、md 给人看。
function exportSubs(fmt) {
  var list = (subs || []).map(function (s) {
    return {
      albumId: String(s.albumId || ''),
      name: s.name || '',
      author: s.author || '',
      playlistId: s.playlistId || 0,
      total: Number(s.lastIndex) || Number(s.songCount) || 0,
      newCount: Number(s.newCount) || 0,
      updateDate: s.updateDate || '',
      lastCheckAt: s.lastCheckAt || '',
      autoSync: s.autoSync !== false,
      url: 'https://www.ximalaya.com/album/' + String(s.albumId || '')
    };
  });

  if (fmt === 'json') {
    return {
      filename: 'ximalaya-subs-' + todayStr() + '.json',
      mime: 'application/json;charset=utf-8',
      content: JSON.stringify({ exportedAt: nowStr(), count: list.length, items: list }, null, 2)
    };
  }
  if (fmt === 'csv') {
    var head = ['专辑ID', '标题', '主播', '已导入集数', '待听新集', '更新日期', '最近检查', '自动同步', '链接'];
    var lines = [head.join(',')];
    list.forEach(function (x) {
      lines.push([
        x.albumId, csvCell(x.name), csvCell(x.author), x.total, x.newCount,
        x.updateDate, x.lastCheckAt, x.autoSync ? '是' : '否', x.url
      ].join(','));
    });
    // BOM：Excel 打开中文不乱码
    return {
      filename: 'ximalaya-subs-' + todayStr() + '.csv',
      mime: 'text/csv;charset=utf-8',
      content: '\ufeff' + lines.join('\r\n')
    };
  }
  // markdown
  var md = ['# 我的喜马拉雅订阅', '', '导出时间：' + nowStr() + '　共 ' + list.length + ' 张', ''];
  md.push('| 专辑 | 主播 | 集数 | 更新 | 链接 |');
  md.push('|---|---|---|---|---|');
  list.forEach(function (x) {
    md.push('| ' + mdCell(x.name) + ' | ' + mdCell(x.author) + ' | ' + x.total + ' | ' + (x.updateDate || '-') + ' | [打开](' + x.url + ') |');
  });
  return { filename: 'ximalaya-subs-' + todayStr() + '.md', mime: 'text/markdown;charset=utf-8', content: md.join('\n') };
}

function csvCell(s) {
  var v = String(s == null ? '' : s);
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ---------- 已听 / 未听分离成两个歌单 ----------
// 长书听到一半，混在一个列表里很难找「下一集该听哪个」。按收听进度分成两个歌单：
// 「已听」= 进度 ≥ 时长-20 秒；「未听」= 其余（含没听过的）。
async function splitPlaylistByHeard(albumId, opts) {
  opts = opts || {};
  var rec = null;
  for (var i = 0; i < imported.length; i++) if (String(imported[i].albumId) === String(albumId)) { rec = imported[i]; break; }
  if (!rec || !rec.playlistId) throw new Error('这张专辑还没导入成歌单，先在「已导入」里导入');

  var songs = await collectPlaylistSongs(rec.playlistId);
  if (!songs.length) throw new Error('歌单里没有歌曲');
  var heard = [], unheard = [];
  songs.forEach(function (s) {
    var tid = songTrackId(s);
    var p = tid ? (progress.tracks[tid] || null) : null;
    var done = false;
    if (p && p.d > 0) done = Number(p.t) >= Number(p.d) - 20;
    if (done) heard.push(s); else unheard.push(s);
  });
  if (!heard.length || !unheard.length) {
    return { ok: true, skipped: true, reason: (heard.length ? '所有集都听完了' : '还没有听完的集'), heard: heard.length, unheard: unheard.length };
  }

  async function makePlaylist(nameSuffix, list) {
    var name = (rec.name || ('专辑' + albumId)) + ' · ' + nameSuffix;
    var pid = await createOrReusePlaylist(name, '', '由喜马拉雅插件按收听进度自动生成');
    var ids = list.map(function (s) { return s.id; }).filter(function (x) { return !!x; });
    var added = 0;
    // 复用已有歌单时，先移除里面不该在这儿的歌（比如上次分离后又被听了）
    if (opts.replace && typeof songloft.playlists.setSongs === 'function') {
      try { await songloft.playlists.setSongs(pid, ids); added = ids.length; }
      catch (e3) { logWarn('split', '整表替换失败，改为追加：' + String(e3 && e3.message || e3)); added = -1; }
    }
    if (added < 0) {
      added = 0;
      for (var j = 0; j < ids.length; j += 200) {
        try {
          var r = await songloft.playlists.addSongs(pid, ids.slice(j, j + 200));
          added += (r && typeof r.added === 'number') ? r.added : Math.min(200, ids.length - j);
        } catch (e) { logWarn('split', '写入歌单失败：' + String(e && e.message || e)); }
      }
    }
    return { pid: pid, name: name, added: added, total: ids.length };
  }

  var a = await makePlaylist('已听', heard);
  var b = await makePlaylist('未听', unheard);
  logInfo('split', '《' + rec.name + '》已拆成「已听」' + a.added + ' 集 / 「未听」' + b.added + ' 集');
  return { ok: true, heard: a, unheard: b };
}

// ---------- 按主播追更 ----------
// 看到一位喜欢的主播，通常想的是「他还有什么书」。
// 用当前登录账号的订阅列表聚合成主播维度（免登录时退化为从已导入里聚合）。
async function anchorList() {
  var map = {};
  function put(a, from) {
    var key = String(a.author || a.anchorName || '未知主播');
    if (!map[key]) map[key] = { name: key, count: 0, albums: [], subs: 0, imported: 0 };
    if (map[key].albums.some(function (x) { return x.albumId === String(a.albumId || a.id); })) return;
    map[key].albums.push({
      albumId: String(a.albumId || a.id || ''),
      name: a.name || a.title || '',
      cover: a.cover || '',
      total: Number(a.total || a.tracks || 0) || 0,
      updateDate: a.updateDate || '',
      from: from
    });
    map[key].count += 1;
    if (from === 'sub') map[key].subs += 1; else map[key].imported += 1;
  }

  var out = { from: '', items: [], error: '' };
  if (login.cookie) {
    try {
      var ms = await loadMySubs({ page: 1, size: 60, refresh: false });
      if (ms.ok && ms.albums && ms.albums.length) {
        ms.albums.forEach(function (x) { put({ albumId: x.id, name: x.title, author: x.author, cover: x.cover, total: x.tracks, updateDate: x.updateDate }, 'sub'); });
        out.from = 'sub';
      }
    } catch (e) { out.error = String(e && e.message || e); }
  }
  if (!out.from) {
    // 退化为已导入 + 订阅记录
    subs.forEach(function (s) { put({ albumId: s.albumId, name: s.name, author: s.author, cover: s.cover, total: s.lastIndex }, 'sub'); });
    imported.forEach(function (x) { put({ albumId: x.albumId, name: x.name, author: x.author, total: x.count }, 'imp'); });
    out.from = 'local';
  }

  out.items = Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) { return b.count - a.count; });
  return out;
}

// 主播的作品很多只是「订阅了」，未必导入了。这里给一键批量订阅
async function bulkSubscribe(albumIds) {
  var added = 0, existed = 0, failed = [];
  for (var i = 0; i < albumIds.length; i++) {
    var id = String(albumIds[i] || '');
    if (!id) continue;
    if (findSub(id)) { existed += 1; continue; }
    try {
      var d = await fetchAlbumDetail(id);
      upsertSub({
        albumId: id,
        name: d.name || ('专辑' + id),
        playlistId: 0,
        lastIndex: 0,
        songCount: 0,
        cover: d.cover || '',
        author: d.author || '',
        updateDate: d.updateDate || '',
        lastCheckAt: '',
        newCount: 0,
        newTitles: [],
        autoSync: true
      });
      added += 1;
    } catch (e) {
      failed.push(id + ': ' + String(e && e.message || e));
    }
  }
  if (added) await persist();
  logInfo('anchor', '批量订阅 ' + added + ' 张' + (failed.length ? '，失败 ' + failed.length : ''));
  return { added: added, existed: existed, failed: failed };
}

// ---------- 追更日历：这些书大概什么时候更新 ----------
// 手上只有「最近一次更新日期」，所以只能做两件事：
//   1) 按周几归档，看出哪几天你最忙（更新扎堆）；
//   2) 按「距今多少天」分档，把久没更新的挑出来（可能完结了、可能该取关了）。
function parseDateSafe(s) {
  var t = String(s || '').trim();
  if (!t) return null;
  var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  // 明显不合理的（1970、未来的）都不要
  if (d.getFullYear() < 2000) return null;
  if (d.getTime() > Date.now() + 86400000 * 2) return null;
  return d;
}

function dayDiff(d) {
  var a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  var b = new Date();
  var n = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((n - a) / 86400000);
}

function updateCalendar() {
  var items = [];
  var noDate = 0;
  subs.forEach(function (s) {
    var d = parseDateSafe(s.updateDate);
    if (!d) { noDate += 1; return; }
    var dd = dayDiff(d);
    items.push({
      albumId: String(s.albumId),
      name: s.name || ('专辑' + s.albumId),
      author: s.author || '',
      cover: s.cover || '',
      date: s.updateDate,
      days: dd,
      dow: d.getDay(),              // 0=周日
      bucket: dd <= 1 ? 'today' : dd <= 7 ? 'week' : dd <= 30 ? 'month' : dd <= 90 ? 'quarter' : 'old'
    });
  });

  // 按周几聚合
  var dowName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var dow = [];
  for (var i = 0; i < 7; i++) dow.push({ dow: i, name: dowName[i], count: 0 });
  items.forEach(function (x) { dow[x.dow].count += 1; });

  // 分档聚合
  var buckets = [
    { key: 'today', name: '今天/昨天更新', count: 0 },
    { key: 'week', name: '一周内', count: 0 },
    { key: 'month', name: '一个月内', count: 0 },
    { key: 'quarter', name: '三个月内', count: 0 },
    { key: 'old', name: '三个月以上没动', count: 0 }
  ];
  var bmap = {};
  buckets.forEach(function (b) { bmap[b.key] = b; });
  items.forEach(function (x) { if (bmap[x.bucket]) bmap[x.bucket].count += 1; });

  // 找出「更得最勤的那天」和「该取关的」
  var busiest = null;
  dow.forEach(function (d) { if (!busiest || d.count > busiest.count) busiest = d; });
  var stale = items.filter(function (x) { return x.days > 90; })
    .sort(function (a, b) { return b.days - a.days; })
    .slice(0, 20);

  items.sort(function (a, b) { return a.days - b.days; });

  return {
    total: subs.length,
    dated: items.length,
    noDate: noDate,
    dow: dow,
    busiest: busiest && busiest.count > 0 ? busiest : null,
    buckets: buckets,
    stale: stale,
    items: items.slice(0, 200),
    tip: items.length
      ? (busiest && busiest.count > 0
        ? busiest.name + ' 更新最多（' + busiest.count + ' 本），那天可以顺手点一次「只检查不导入」。'
        : '还看不出规律，多同步几次就有了。')
      : '订阅里还没有可用的更新日期，先去「读取我的订阅」或者同步一次。'
  };
}

// 分组不落盘——它是视图，不是数据。每次按当前 subs 现算，避免和真实数据不一致。
function subsGroups(by) {
  by = by || 'cat';
  var map = {};
  function put(key, label, s) {
    if (!map[key]) map[key] = { key: key, label: label, count: 0, items: [] };
    map[key].count += 1;
    map[key].items.push({
      albumId: String(s.albumId), name: s.name || '', author: s.author || '',
      cover: s.cover || '', updateDate: s.updateDate || '', newCount: Number(s.newCount) || 0,
      total: Number(s.lastIndex) || 0, playlistId: Number(s.playlistId) || 0
    });
  }
  subs.forEach(function (s) {
    if (by === 'anchor') {
      var a = String(s.author || '').trim() || '未知主播';
      put('a:' + a, a, s);
    } else if (by === 'status') {
      var nc = Number(s.newCount) || 0;
      var lib = Number(s.playlistId) || 0;
      if (nc > 0) put('new', '有新集未处理', s);
      else if (lib) put('in', '已导入歌单', s);
      else put('wait', '只在订阅里，没导入', s);
    } else {
      var d = parseDateSafe(s.updateDate);
      if (!d) put('na', '没有更新日期', s);
      else {
        var dd = dayDiff(d);
        if (dd <= 7) put('hot', '一周内有更新', s);
        else if (dd <= 30) put('mid', '一个月内更新过', s);
        else if (dd <= 90) put('cold', '三个月内更新过', s);
        else put('dead', '三个月以上没更新', s);
      }
    }
  });
  var order = ['new', 'hot', 'in', 'mid', 'wait', 'cold', 'dead', 'na', 'a:'];
  var list = Object.keys(map).map(function (k) { return map[k]; });
  list.sort(function (a, b) {
    var ia = order.indexOf(a.key), ib = order.indexOf(b.key);
    if (by === 'anchor') return b.count - a.count || (a.label < b.label ? -1 : 1);
    if (ia < 0) ia = 99;
    if (ib < 0) ib = 99;
    return ia - ib || b.count - a.count;
  });
  list.forEach(function (g) {
    g.items.sort(function (a, b) {
      if (by === 'anchor') return String(b.updateDate).localeCompare(String(a.updateDate));
      return (b.newCount - a.newCount) || String(b.updateDate).localeCompare(String(a.updateDate));
    });
  });
  return { by: by, groups: list, total: subs.length };
}

// ---------- 批量：取消订阅 ----------
function unsubBatch(albumIds) {
  var set = {};
  (albumIds || []).forEach(function (x) { set[String(x)] = 1; });
  var before = subs.length;
  var hit = subs.filter(function (s) { return set[String(s.albumId)]; });
  subs = subs.filter(function (s) { return !set[String(s.albumId)]; });
  // 顺手把待听里的也保留（那是另一份清单，不动）
  return { removed: before - subs.length, names: hit.map(function (s) { return s.name; }) };
}

function normPath(p) {
  var prefix = '/api/v1/jsplugin/' + ENTRY;
  if (p && p.indexOf(prefix) === 0) p = p.slice(prefix.length) || '/';
  if (!p) p = '/';
  var qi = p.indexOf('?');
  if (qi >= 0) p = p.slice(0, qi);
  return p;
}

// ---------- 自检 ----------
// 把「出问题了该看什么」固化成一份清单：每项 {key, name, ok, level, detail}
// level: ok 正常 / warn 能跑但有隐患 / bad 直接不可用
async function runSelfCheck(deep) {
  var items = [];
  function add(key, name, level, detail) { items.push({ key: key, name: name, ok: level === 'ok', level: level, detail: String(detail || '') }); }

  // 1 宿主能力
  var canDownload = typeof songloft.songs.download === 'function';
  var canCreate = typeof songloft.songs.create === 'function';
  var canListPl = typeof songloft.playlists.list === 'function';
  var canGetSongs = typeof songloft.playlists.getSongs === 'function';
  var canStorage = typeof songloft.storage.get === 'function';
  if (!canCreate || !canListPl || !canStorage) {
    add('host', '宿主基础能力', 'bad', '缺少 songs.create / playlists.list / storage，插件无法工作，请升级 Songloft');
  } else if (!canDownload) {
    add('host', '宿主基础能力', 'warn', 'songs.download 缺失，下载到本地不可用（其余功能正常）');
  } else {
    add('host', '宿主基础能力', 'ok', '全部可用');
  }
  if (!canGetSongs) add('hostSongs', '读取歌单歌曲', 'warn', 'playlists.getSongs 缺失，增量同步与本地库扫描会失效');

  // 2 存储写入
  try {
    await songloft.storage.set('selfcheck:v1', String(Date.now()));
    add('storage', '存储读写', 'ok', '正常');
  } catch (e) {
    add('storage', '存储读写', 'bad', '写入失败：' + String(e));
  }

  // 3 喜马拉雅连通性
  try {
    var t0 = Date.now();
    await fetchShowPage('4156778', 1);
    add('xm', '喜马拉雅接口', 'ok', '正常（' + (Date.now() - t0) + 'ms）');
  } catch (e) {
    add('xm', '喜马拉雅接口', 'bad', String(e && e.message || e));
  }

  // 4 登录态
  var ch = await checkCookieHealth(deep);
  if (!ch.loggedIn) add('login', '登录态', 'warn', '未登录：付费/VIP 内容与「我的订阅」不可用，免费内容不受影响');
  else if (ch.valid) add('login', '登录态', 'ok', (ch.nickname ? ch.nickname + '（uid ' + ch.uid + '）' : 'uid ' + ch.uid) + '，' + ch.checkedAgo + ' 验证');
  else add('login', '登录态', 'bad', '已失效：' + (ch.error || '请重新扫码') + '（上次正常：' + ch.lastOkAgo + '）');

  // 5 单集播放地址
  if (deep) {
    try {
      var u1 = await fetchTrackUrl('529200192');
      add('play', '单集播放地址', u1 ? 'ok' : 'bad', u1 ? '可获取' : '未取到地址');
    } catch (e) {
      add('play', '单集播放地址', 'warn', String(e && e.message || e));
    }
  }

  // 7 定时任务状态
  var autoOk = !config.auto.enabled || (config.auto.time && /^\d{1,2}:\d{2}$/.test(config.auto.time));
  add('auto', '定时同步', config.auto.enabled ? (autoOk ? 'ok' : 'warn') : 'ok',
    config.auto.enabled ? '每天 ' + config.auto.time + '，上次 ' + (config.auto.lastRunDate || '未执行')
      : '未启用');

  // 8 数据量
  add('data', '本地数据', 'ok',
    '订阅 ' + subs.length + ' · 已导入 ' + imported.length + ' · 进度 ' + Object.keys(progress.tracks).length +
    ' 集 · 书签 ' + bookmarks.length);

  // 9 近期错误
  var errs = logBuf.filter(function (e) { return e.lv === 'error'; }).length;
  var warns = logBuf.filter(function (e) { return e.lv === 'warn'; }).length;
  add('logs', '近期异常', errs ? 'warn' : 'ok', errs || warns ? ('错误 ' + errs + ' 条 · 警告 ' + warns + ' 条（最近 ' + LOG_MAX + ' 条内）') : '无异常记录');

  var bad = items.filter(function (i) { return i.level === 'bad'; }).length;
  var warn = items.filter(function (i) { return i.level === 'warn'; }).length;
  return {
    version: VERSION,
    at: Date.now(),
    atText: nowStr(),
    ok: bad === 0,
    bad: bad,
    warn: warn,
    summary: bad ? (bad + ' 项需要处理') : (warn ? ('一切正常，' + warn + ' 项可选优化') : '全部正常'),
    items: items
  };
}


// ---------- 待听清单（想听但先存着，不占歌单） ----------
var TODO_KEY = 'todo:v1';
var todoItems = [];

function todoList() { return todoItems; }

function todoAdd(it) {
  if (!it || !it.albumId) return false;
  for (var i = 0; i < todoItems.length; i++) {
    if (String(todoItems[i].albumId) === String(it.albumId)) {
      todoItems[i].at = Date.now();
      if (!todoItems[i].cover && it.cover) todoItems[i].cover = it.cover;
      if (it.note) todoItems[i].note = it.note;
      persistTodo();
      return true;
    }
  }
  todoItems.unshift({
    albumId: String(it.albumId), name: it.name || '', author: it.author || '',
    cover: it.cover || '', note: it.note || '', at: Date.now()
  });
  if (todoItems.length > 200) todoItems.length = 200;
  persistTodo();
  return true;
}

// 待听 → 导入成功后自动出清单（免得同一本反复出现）
function todoDrop(albumIds) {
  var set = {};
  (albumIds || []).forEach(function (x) { set[String(x)] = 1; });
  var before = todoItems.length;
  todoItems = todoItems.filter(function (x) { return !set[String(x.albumId)]; });
  if (todoItems.length !== before) persistTodo();
  return before - todoItems.length;
}

function todoRemove(albumId) {
  var n = todoItems.length;
  todoItems = todoItems.filter(function (x) { return String(x.albumId) !== String(albumId); });
  persistTodo();
  return todoItems.length < n;
}

var todoSaveTimer = null;
function persistTodo() {
  if (todoSaveTimer) clearTimeout(todoSaveTimer);
  todoSaveTimer = setTimeout(function () {
    todoSaveTimer = null;
    try { songloft.storage.set(TODO_KEY, JSON.stringify(todoItems)); } catch (e) { /* */ }
  }, 300);
}

async function handleHTTPRequest(req) {
  var path = normPath(req.path || '');
  var method = (req.method || 'GET').toUpperCase();
  var q = parseQuery(req);

  if (path === '/config' && method === 'GET') return jsonResp({ success: true, data: config });

  if (path === '/config' && method === 'POST') {
    var body = readBodyJson(req);
    if (body.auto) {
      var a = body.auto;
      if (typeof a.enabled === 'boolean') config.auto.enabled = a.enabled;
      var aTv = normHHMM(a.time);
      if (aTv) config.auto.time = aTv;
      if (a.lastRunDate === '') config.auto.lastRunDate = '';
    }
    if (body.sync) {
      if (typeof body.sync.progress === 'boolean') config.sync.progress = body.sync.progress;
    }
    if (body.dl) {
      if (typeof body.dl.targetDir === 'string') config.dl.targetDir = body.dl.targetDir.trim();
      if (body.dl.format === 'mp3' || body.dl.format === '') config.dl.format = body.dl.format;
    }
    if (body.ai) {
      // 旧版前端可能还会传 ai 段，直接忽略，不再写进配置
    }
    await persist();
    return jsonResp({ success: true, data: config });
  }

  if (path === '/status' && method === 'GET') {
    return jsonResp({
      success: true,
      data: {
        job: job, imported: imported, subs: subs, auto: config.auto,
        lastSync: lastSync, syncing: syncing, version: VERSION,
        loggedIn: !!login.cookie,
        dlJob: dlJob,
        progressStat: { tracks: Object.keys(progress.tracks).length, albums: Object.keys(progress.albums).length, at: progress.at || '' },
        syncCfg: config.sync, dlCfg: config.dl,
        watch: { cfg: config.watch, items: watch.items, job: watch.job }
      }
    });
  }

  // ---------- 收听统计 / 报告 ----------
  if (path === '/report' && method === 'GET') {
    var period = String(q.period || 'week');
    if (['day', 'week', 'month', 'all'].indexOf(period) < 0) period = 'week';
    return jsonResp({ success: true, data: buildReport(period) });
  }

  // v0.20.1：播放统计总览（今日 / 本周 / 累计 + 连续天数），前端一次请求拿全
  if (path === '/report/overview' && method === 'GET') {
    var od = buildReport('day');
    var ow = buildReport('week');
    var oa = buildReport('all');
    var ost = calcStreak();
    return jsonResp({ success: true, data: {
      daySec: od.sec, dayFin: od.finished,
      weekSec: ow.sec, weekFin: ow.finished,
      allSec: oa.sec, allFin: oa.finished, albumCount: oa.albumCount,
      streakNow: ost.now || 0, streakBest: ost.best || 0
    } });
  }

  if (path === '/dashboard' && method === 'GET') {
    var streak = calcStreak();
    var heat = calcHourHeat();
    var rates = calcFinishRates(8);
    var remain = calcRemain();
    var totalSec = 0, dayN = 0;
    Object.keys(stats.days || {}).forEach(function (k) {
      var s = Number(stats.days[k]) || 0;
      if (s > 0) { totalSec += s; dayN += 1; }
    });
    return jsonResp({
      success: true,
      data: {
        streak: streak,
        heat: heat,
        rates: rates,
        remain: remain,
        totalSec: totalSec,
        totalText: secToHM(totalSec),
        activeDays: dayN,
        avgPerDay: dayN ? Math.round(totalSec / dayN) : 0,
        avgText: secToHM(dayN ? totalSec / dayN : 0)
      }
    });
  }

  if (path === '/report/reset' && method === 'POST') {
    stats = { days: {}, albums: {}, at: nowStr() };
    await persistStat();
    return jsonResp({ success: true, data: { message: '统计数据已清空' } });
  }

  if (path === '/bookmarks' && method === 'GET') {
    return jsonResp({ success: true, data: { items: bmList(q.albumId || ''), total: bookmarks.length } });
  }

  if (path === '/bookmarks' && method === 'POST') {
    var bmb = readBodyJson(req);
    if (bmb.remove) {
      if (!bmRemove(bmb.remove)) return jsonResp({ success: false, error: '书签不存在' }, 404);
      return jsonResp({ success: true, data: { removed: bmb.remove, total: bookmarks.length } });
    }
    if (bmb.clear) {
      bookmarks = [];
      await persistBookmarks();
      return jsonResp({ success: true, data: { message: '书签已清空', total: 0 } });
    }
    var r1 = bmAdd(bmb);
    if (!r1.ok) return jsonResp({ success: false, error: r1.error }, 400);
    return jsonResp({ success: true, data: r1 });
  }

  // ---------- 播放历史时间线 ----------
  if (path === '/history' && method === 'GET') {
    var hdays = Number(q.days) || 30;
    return jsonResp({
      success: true,
      data: { days: hdays, total: history.length, groups: histTimeline(hdays, Number(q.limit) || 0, q.kw) }
    });
  }

  if (path === '/history' && method === 'POST') {
    var hb = readBodyJson(req);
    if (hb.clear) {
      history = [];
      await persistHistory();
      return jsonResp({ success: true, data: { message: '历史已清空' } });
    }
    var items = Array.isArray(hb.items) ? hb.items : [hb];
    var hn = 0;
    items.forEach(function (x) { if (histAdd(x)) hn += 1; });
    if (hn) await persistHistory();
    return jsonResp({ success: true, data: { added: hn, total: history.length } });
  }

  // ---------- 关键词追更 ----------
  if (path === '/watch' && method === 'GET') {
    return jsonResp({ success: true, data: { cfg: config.watch, items: watch.items, job: watch.job } });
  }

  if (path === '/watch' && method === 'POST') {
    var wb = readBodyJson(req);
    if (wb.cfg && typeof wb.cfg === 'object') {
      config.watch = config.watch || {};
      for (var wk in wb.cfg) if (Object.prototype.hasOwnProperty.call(wb.cfg, wk)) config.watch[wk] = wb.cfg[wk];
      if (config.watch.maxNew !== undefined) config.watch.maxNew = Math.max(1, Number(config.watch.maxNew) || 10);
      if (config.watch.maxAlbums !== undefined) config.watch.maxAlbums = Math.max(1, Math.min(10, Number(config.watch.maxAlbums) || 3));
      await persist();
    }
    if (wb.add) {
      var kwNew = String(wb.add.kw || '').trim();
      if (!kwNew) return jsonResp({ success: false, error: '关键词不能为空' }, 400);
      var dup = null;
      for (var wi = 0; wi < watch.items.length; wi++) {
        if (String(watch.items[wi].kw) === kwNew) { dup = watch.items[wi]; break; }
      }
      if (dup) {
        if (wb.add.maxNew) dup.maxNew = Math.max(1, Number(wb.add.maxNew) || 10);
      } else {
        watch.items.push({
          id: watchId(), kw: kwNew,
          maxNew: Math.max(1, Number(wb.add.maxNew) || (config.watch && config.watch.maxNew) || 10),
          createdAt: nowStr(), lastRunAt: '', lastAdded: 0, lastNewAlbums: [], lastError: '', seen: {}
        });
      }
      await persistWatch();
    }
    if (wb.remove) {
      var rid = String(wb.remove);
      watch.items = watch.items.filter(function (x) { return String(x.id) !== rid; });
      await persistWatch();
    }
    if (wb.resetSeen) {
      var rit = findWatch(wb.resetSeen);
      if (rit) { rit.seen = {}; await persistWatch(); }
    }
    return jsonResp({ success: true, data: { cfg: config.watch, items: watch.items, job: watch.job } });
  }

  if (path === '/watch/run' && method === 'POST') {
    if (watch.job.running) return jsonResp({ success: false, error: '追更任务进行中，请稍候' }, 409);
    var wOpts = readBodyJson(req) || {};
    // 异步执行：宿主 HTTP 60 秒超时，长任务必须先返回
    runWatchAll({ speak: !!wOpts.speak }).catch(function (e) {
      songloft.log.warn('[喜马拉雅] 追更失败: ' + String(e));
      watch.job.running = false;
      watch.job.msg = '失败：' + String(e);
    });
    return jsonResp({ success: true, data: { message: '追更已开始，稍后刷新查看结果' } });
  }

  // 能力自检（排查宿主版本差异）
  if (path === '/diag' && method === 'GET') {
    var caps = {
      songsDownload: typeof songloft.songs.download,
      songsCreate: typeof songloft.songs.create,
      playlistsGetSongs: typeof songloft.playlists.getSongs,
      fs: typeof (songloft.fs && songloft.fs.writeFile),
      fsFileUrl: typeof (songloft.fs && songloft.fs.fileUrl),
      songsFileUrl: typeof (songloft.songs && songloft.songs.fileUrl),
      storage: typeof songloft.storage.get,
      version: VERSION,
      libCached: libMap ? Object.keys(libMap).length : 0
    };
    return jsonResp({ success: true, data: caps });
  }

  // ---------- 事件日志 ----------
  if (path === '/logs' && method === 'GET') {
    var lim2 = Number(q.limit) || 100;
    return jsonResp({
      success: true,
      data: {
        items: logList(lim2, q.level || 'all'),
        total: logBuf.length,
        warn: logBuf.filter(function (e) { return e.lv === 'warn'; }).length,
        error: logBuf.filter(function (e) { return e.lv === 'error'; }).length,
        max: LOG_MAX
      }
    });
  }

  if (path === '/logs' && method === 'POST') {
    var lbg = readBodyJson(req);
    if (lbg.action === 'clear') { logClear(); return jsonResp({ success: true, data: { cleared: true } }); }
    if (lbg.action === 'mark') {
      // 前端把浏览器端发生的错误也交给这里统一收口，便于一处排查
      logPush(String(lbg.level || 'error') === 'warn' ? 'warn' : 'error', 'ui', String(lbg.msg || ''));
      return jsonResp({ success: true, data: { total: logBuf.length } });
    }
    return jsonResp({ success: false, error: '未知操作' }, 400);
  }

  // ---------- 自检：一次把「能不能用」全查一遍 ----------
  if (path === '/selfcheck' && method === 'GET') {
    var sc = await runSelfCheck(q.deep === '1' || q.deep === 'true');
    return jsonResp({ success: true, data: sc });
  }

  // ---------- 跨设备收听进度 ----------
  if (path === '/progress' && method === 'POST') {
    var pb = readBodyJson(req);
    var items = Array.isArray(pb.items) ? pb.items : [pb];
    var saved = 0, statChanged = false, histChanged = false;
    for (var pi = 0; pi < items.length; pi++) {
      var one = items[pi];
      if (progUpsert(one)) saved += 1;
      // listened = 这一批里实际播放的秒数（同一集可能上报多次，只有带 listened 的才累加）
      var ls = Number(one && one.listened) || 0;
      if (ls > 0) {
        if (statAdd(ls, one.albumId, one.albumName, one.at)) statChanged = true;
        // 顺便记一条播放历史（同一集 10 分钟内去重）
        if (histAdd(one)) histChanged = true;
      }
    }
    if (saved) { progPrune(); await persistProg(); }
    if (statChanged) await persistStat();
    if (histChanged) await persistHistory();
    return jsonResp({ success: true, data: { saved: saved, tracks: Object.keys(progress.tracks).length } });
  }

  if (path === '/progress' && method === 'GET') {
    var pa = String(q.albumId || q.album_id || '');
    if (pa) {
      var lastA = progress.albums[pa] || null;
      var listA = progList(pa, 500);
      return jsonResp({ success: true, data: { album: lastA, tracks: listA, count: listA.length } });
    }
    var lim = Number(q.limit) || 200;
    return jsonResp({
      success: true,
      data: {
        album: null,
        tracks: progList('', lim),
        albums: progress.albums,
        at: progress.at || '',
        count: Object.keys(progress.tracks).length
      }
    });
  }

  if (path === '/progress/recent' && method === 'GET') {
    var rl = progList('', Number(q.limit) || 40);
    var recent = rl.map(function (p) {
      return {
        albumId: p.albumId, albumName: p.albumName, cover: p.cover, author: p.author,
        trackId: p.trackId, index: p.index, title: p.title,
        t: p.t, d: p.d, at: p.at, finished: !!p.finished
      };
    });
    return jsonResp({ success: true, data: recent });
  }

  if (path === '/progress' && method === 'DELETE') {
    var db = readBodyJson(req);
    var dt = String(db.trackId || q.trackId || '');
    var da = String(db.albumId || q.albumId || '');
    var all = String(db.all || q.all || '') === '1';
    var removed = 0;
    if (all) {
      removed = Object.keys(progress.tracks).length;
      progress.tracks = {}; progress.albums = {};
    } else if (da) {
      var idsA = Object.keys(progress.tracks);
      for (var i2 = 0; i2 < idsA.length; i2++) {
        if (String(progress.tracks[idsA[i2]].albumId) === da) { delete progress.tracks[idsA[i2]]; removed += 1; }
      }
      if (progress.albums[da]) { delete progress.albums[da]; removed += 1; }
    } else if (dt) {
      if (progress.tracks[dt]) { delete progress.tracks[dt]; removed += 1; }
    }
    progress.at = nowStr();
    await persistProg();
    return jsonResp({ success: true, data: { removed: removed } });
  }

  // 单集搜索
  if (path === '/search/tracks' && (method === 'GET' || method === 'POST')) {
    try {
      var tb = method === 'POST' ? readBodyJson(req) : {};
      var tkw = String(tb.kw || tb.keyword || q.kw || q.keyword || '').trim();
      if (!tkw) return jsonResp({ success: false, error: '缺少关键词' }, 400);
      var tpage = Number(tb.page || q.page) || 1;
      var trows = Math.max(1, Math.min(50, Number(tb.rows || q.rows) || 20));
      var tr = await searchTracks(tkw, tpage, trows);
      return jsonResp({
        success: true, data: tr.tracks, risk: !!tr.risk, source: tr.source,
        page: tpage, hasMore: tr.tracks.length >= trows, total: tr.total || 0, count: tr.tracks.length
      });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 500);
    }
  }

  // 单集导入（直接建成歌单 / 追加进已有歌单）
  if (path === '/import-tracks' && method === 'POST') {
    var ib = readBodyJson(req);
    var items2 = Array.isArray(ib.tracks) ? ib.tracks : [];
    if (!items2.length) return jsonResp({ success: false, error: '没有选择单集' }, 400);
    if (items2.length > 200) return jsonResp({ success: false, error: '一次最多导入 200 集' }, 400);
    try {
      var plId = Number(ib.playlist_id) || 0;
      var plName = String(ib.name || '').trim() || ('喜马拉雅单集 ' + todayStr());
      var plObj = null;
      if (plId) {
        try { plObj = await songloft.playlists.getById(plId); } catch (e) { plObj = null; }
      }
      if (!plObj) {
        try {
          plObj = await songloft.playlists.create({ name: plName, description: '来自喜马拉雅 · 单集收藏' });
        } catch (ce) {
          // 同名歌单已存在时复用，不报错（用户重复点「＋歌单」很常见）
          if (String(ce).indexOf('same name') < 0) throw ce;
          var allPl = [];
          try { allPl = await songloft.playlists.list() || []; } catch (e3) { allPl = []; }
          for (var k3 = 0; k3 < allPl.length; k3++) {
            if (allPl[k3] && String(allPl[k3].name) === plName) { plObj = allPl[k3]; break; }
          }
          if (!plObj) plObj = await songloft.playlists.create({ name: plName + ' ' + hhmmNow(), description: '来自喜马拉雅 · 单集收藏' });
        }
      }
      var songsIn = [];
      var seenT = {};
      for (var j2 = 0; j2 < items2.length; j2++) {
        var it2 = items2[j2];
        var tid = String(it2.trackId || it2.track_id || it2.id || '');
        if (!tid || seenT[tid]) continue;
        seenT[tid] = 1;
        songsIn.push({
          title: it2.title || ('单集 ' + tid),
          artist: it2.author || '喜马拉雅',
          album: it2.album || plName,
          coverUrl: it2.cover || '',
          duration: Number(it2.duration) || 0,
          sourceData: JSON.stringify({
            trackId: tid, title: it2.title || '', album: it2.album || '',
            cover: it2.cover || '', duration: Number(it2.duration) || 0
          }),
          dedupKey: 'xm:' + tid
        });
      }
      if (!songsIn.length) return jsonResp({ success: false, error: '没有有效的单集' }, 400);
      var created2 = await songloft.songs.create(songsIn);
      var ids2 = (created2 || []).map(function (s) { return s && s.id; }).filter(function (x) { return !!x; });
      var added2 = 0;
      if (ids2.length) {
        var r2 = await songloft.playlists.addSongs(plObj.id, ids2);
        added2 = (r2 && typeof r2.added === 'number') ? r2.added : ids2.length;
      }
      songloft.log.info('[喜马拉雅] 单集导入：' + added2 + ' 集 → 歌单 ' + plObj.id);
      return jsonResp({ success: true, data: { playlistId: plObj.id, name: plObj.name, added: added2, total: songsIn.length } });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 500);
    }
  }

  // ---------- 扫码登录 ----------
  if (path === '/qr/new' && method === 'GET') {
    try {
      var qq = await qrCreate();
      return jsonResp({ success: true, data: { qrId: qq.qrId, image: qq.image, imgUrl: qq.imgUrl, imgError: qq.imgError, ttl: 240 } });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) });
    }
  }

  if (path === '/qr/check' && method === 'GET') {
    var qid = String(q.qrId || '').trim();
    if (!qid) return jsonResp({ success: false, error: '缺少 qrId' }, 400);
    try {
      var qr = await qrCheck(qid);
      if (qr.state === 'ok') delete qrSessions[qid];
      return jsonResp({ success: true, data: qr });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) });
    }
  }

  // ---------- 登录（Cookie 方式） ----------
  if (path === '/login' && method === 'GET') {
    var mask = login.cookie
      ? (login.cookie.slice(0, 24) + '…' + login.cookie.slice(-16) + '（共 ' + login.cookie.length + ' 字符）')
      : '';
    var lc = cookieLooksValid(login.cookie);
    return jsonResp({
      success: true,
      data: {
        loggedIn: !!login.cookie, savedAt: login.savedAt || '', mask: mask,
        cookieSane: lc.ok, cookieHint: lc.reason
      }
    });
  }

  if (path === '/login' && method === 'POST') {
    var lb = readBodyJson(req);
    var ck = String(lb.cookie || '').trim();
    ck = ck.replace(/^Cookie:[ \t]*/i, '').replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!ck || ck.indexOf('=') === -1) {
      return jsonResp({ success: false, error: 'Cookie 格式不对：请粘贴网页版登录后的整段 Cookie（应包含 1&_token=... 或 _xmLog=...）' }, 400);
    }
    if (/^U2FsdGVkX1/.test(ck)) {
      return jsonResp({
        success: false,
        error: '这串是经过加密的数据（U2Fsd 开头），不是 Cookie。请在浏览器 F12 → 网络 → 任意 ximalaya.com 请求 → 请求头 Cookie 里复制'
      }, 400);
    }
    var looks = cookieLooksValid(ck);
    login.cookie = ck;
    login.savedAt = nowStr();
    await persist();
    meCache = { at: 0, user: null, albums: [], source: '', error: '' };
    signCache = { at: 0, v: '' };
    songloft.log.info('[喜马拉雅] 已保存登录 Cookie（' + ck.length + ' 字符）');

    // 立即验证一次登录态，把结果直接告诉前端
    var vr = { ok: false, needLogin: false, error: looks.ok ? '' : looks.reason, user: null };
    if (looks.ok) {
      try {
        var ur0 = await fetchCurrentUser();
        vr = { ok: ur0.ok, needLogin: ur0.ret === 401, error: ur0.error || '', user: ur0.user || null };
      } catch (e) { vr.error = String(e); }
    }
    return jsonResp({
      success: true,
      data: {
        loggedIn: true, savedAt: login.savedAt, valid: vr.ok,
        user: vr.user, error: vr.ok ? '' : (vr.error || '登录态无效'),
        message: vr.ok
          ? ('已验证：' + ((vr.user && vr.user.nickname) || '已登录'))
          : ('Cookie 已保存，但验证未通过：' + (vr.error || '登录态无效') + '（请确认复制的是 ximalaya.com 的完整 Cookie，且未过期）')
      }
    });
  }

  if (path === '/login' && method === 'DELETE') {
    login.cookie = '';
    login.savedAt = '';
    meCache = { at: 0, user: null, albums: [], source: '', error: '' };
    signCache = { at: 0, v: '' };
    await persist();
    return jsonResp({ success: true, data: { loggedIn: false } });
  }

  if (path === '/logout' && method === 'POST') {
    login.cookie = '';
    login.savedAt = '';
    meCache = { at: 0, user: null, albums: [], source: '', error: '' };
    signCache = { at: 0, v: '' };
    await persist();
    songloft.log.info('[喜马拉雅] 已清除登录 Cookie');
    return jsonResp({ success: true, data: { loggedIn: false } });
  }

  // 单独验证登录态：GET/POST /login/verify，可用 body.cookie 临时测试而不保存
  if (path === '/login/verify') {
    var vb = method === 'POST' ? readBodyJson(req) : {};
    var vck = String(vb.cookie || '').trim();
    var saved = login.cookie;
    if (vck) { login.cookie = vck.replace(/^Cookie:[ \t]*/i, '').trim(); signCache = { at: 0, v: '' }; }
    try {
      if (!login.cookie) return jsonResp({ success: true, data: { valid: false, error: '未登录' } });
      var uv = await fetchCurrentUser();
      return jsonResp({
        success: true,
        data: { valid: uv.ok, user: uv.user || null, error: uv.ok ? '' : (uv.error || '登录态无效') }
      });
    } finally {
      if (vck) { login.cookie = saved; signCache = { at: 0, v: '' }; }
    }
  }

  // ---------- 我的订阅（登录态） ----------
  if (path === '/me' && method === 'GET') {
    if (!login.cookie) return jsonResp({ success: true, data: { loggedIn: false, valid: false, error: '未登录' } });
    try {
      var um = await fetchCurrentUser();
      return jsonResp({
        success: true,
        data: { loggedIn: true, valid: um.ok, user: um.user || null, error: um.ok ? '' : (um.error || '登录态无效') }
      });
    } catch (e) {
      return jsonResp({ success: true, data: { loggedIn: true, valid: false, error: String(e) } });
    }
  }

  if (path === '/me/subs' && method === 'GET') {
    try {
      var ms = await loadMySubs({
        page: Number(q.page) || 1,
        size: Number(q.size) || 60,
        refresh: q.refresh === '1' || q.refresh === 'true'
      });
      return jsonResp({
        success: ms.ok,
        error: ms.ok ? '' : ms.error,
        needLogin: !!ms.needLogin,
        data: {
          user: ms.user, albums: ms.albums || [], page: ms.page, size: ms.size,
          total: ms.total || 0, hasMore: !!ms.hasMore, source: ms.source || ''
        }
      });
    } catch (e) {
      return jsonResp({ success: false, error: String(e) }, 500);
    }
  }

  // ---------- 登录态健康检查（供定时任务与界面提醒用） ----------
  if (path === '/cookie/health' && method === 'GET') {
    var hh = await checkCookieHealth(q.refresh === '1' || q.refresh === 'true');
    return jsonResp({ success: true, data: hh });
  }

  // 调试用：只允许转发到喜马拉雅域名（排查接口变更），不暴露任意 URL
  if (path === '/me/probe' && method === 'GET') {
    var target = String(q.url || '');
    if (!/^https?:\/\/([a-z0-9-]+\.)*ximalaya\.com\//i.test(target)) {
      return jsonResp({ success: false, error: '只允许 ximalaya.com 域名' }, 400);
    }
    try {
      var pr = await fetchT(target, { method: 'GET', headers: await signHeaders(pcHeaders('')) }, 15);
      var pt = await pr.text();
      return jsonResp({
        success: true,
        data: { status: pr.status, len: pt.length, body: pt.slice(0, Number(q.n) || 1500) }
      });
    } catch (e) {
      return jsonResp({ success: false, error: String(e) });
    }
  }

  // ---------- 本机音乐库 ----------
  if (path === '/lib/status' && method === 'GET') {
    var lm = await scanLocalLibrary(!!q.refresh);
    var keys = Object.keys(lm || {});
    var bytes = 0;
    keys.forEach(function (k) { bytes += Number(lm[k].size) || 0; });
    return jsonResp({
      success: true,
      data: {
        count: keys.length,
        bytes: bytes,
        scannedAt: libAt,
        playlists: typeof songloft.playlists.list === 'function'
      }
    });
  }

  // 某张专辑：哪些集已下载、缺哪些
  if (path === '/lib/album' && method === 'GET') {
    var laid = String(q.albumId || '');
    if (!laid) return jsonResp({ success: false, error: '缺少 albumId' }, 400);
    var lmap = await scanLocalLibrary(false);
    var lt = [];
    try {
      // v0.19.4：fetchAlbumTracks(albumId, start, end, maxPages) 第二个参数是**起始集号**不是页码，
      // 且返回值只有 {albumName, tracks}（没有 hasMore）→ 原来 `!lr.hasMore` 恒真，循环第一轮就 break，
      // 而第一轮实际是「从第 1 集拉到全部」，等于一次请求里串行打满所有分页，很容易超 60s。
      lt = (await fetchAlbumTracks(laid, 0, 0)).tracks || [];
    } catch (e) { /* 取不到就只报已知的 */ }
    var st = libStatFor(lt, lmap);
    var items = {};
    (lt || []).forEach(function (t) {
      var info = lmap[String(t.trackId)];
      if (info) items[String(t.trackId)] = { path: info.path, size: info.size };
    });
    return jsonResp({
      success: true,
      data: {
        albumId: laid, total: (lt || []).length,
        downloaded: st.downloaded, missing: st.missing,
        missingIds: st.missingIds.slice(0, 500),
        items: items,
        scannedAt: libAt
      }
    });
  }

  // 一键补下缺失的集：复用整本下载，但只挑没下过的
  if (path === '/lib/fill' && method === 'POST') {
    var fb = readBodyJson(req);
    var faid = String(fb.albumId || '');
    if (!faid) return jsonResp({ success: false, error: '缺少 albumId' }, 400);
    if (downloading) return jsonResp({ success: false, error: '已有下载任务在跑，等它结束' }, 409);
    var entry = null;
    for (var fi = 0; fi < imported.length; fi++) if (String(imported[fi].albumId) === faid) { entry = imported[fi]; break; }
    if (!entry || !entry.playlistId) return jsonResp({ success: false, error: '这张专辑还没导入成歌单，请先「导入全部」' }, 400);
    // 异步跑，避免宿主 60 秒超时
    runDownload(entry.playlistId, entry.name || faid, entry.name || '').catch(function () {});
    return jsonResp({ success: true, data: { message: '补下任务已启动（已下载过的会自动跳过）', playlistId: entry.playlistId } });
  }

  // ---------- 内容整理 ----------
  // 两张专辑对比
  if (path === '/compare' && method === 'GET') {
    var ca = extractAlbumId(q.a || '');
    var cb = extractAlbumId(q.b || '');
    if (!ca || !cb) return jsonResp({ success: false, error: '需要两张专辑的 ID 或链接（参数 a、b）' }, 400);
    if (ca === cb) return jsonResp({ success: false, error: '两张是同一张专辑' }, 400);
    try {
      var cmpRes = await compareAlbums(ca, cb);
      return jsonResp({ success: !!cmpRes.ok, error: cmpRes.ok ? '' : cmpRes.error, data: cmpRes });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 502);
    }
  }

  // 导出订阅清单：返回内容本身，由前端触发下载
  if (path === '/subs/export' && method === 'GET') {
    try {
      var fmt = String(q.format || 'json');
      var ex = exportSubs(fmt);
      return jsonResp({ success: true, data: { filename: ex.filename, mime: ex.mime, content: ex.content, count: subs.length } });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 500);
    }
  }

  // 按收听进度把一本书拆成「已听 / 未听」两个歌单
  if (path === '/split-heard' && method === 'POST') {
    var sb = readBodyJson(req);
    var said2 = String(sb.albumId || '');
    if (!said2) return jsonResp({ success: false, error: '缺少 albumId' }, 400);
    try {
      var sp = await splitPlaylistByHeard(said2);
      return jsonResp({ success: true, data: sp });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 400);
    }
  }

  // 主播聚合：某位主播有哪些书
  if (path === '/anchors' && method === 'GET') {
    try {
      var al = await anchorList();
      var only = String(q.name || '');
      if (only) al.items = al.items.filter(function (x) { return x.name === only; });
      return jsonResp({ success: true, data: al });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 500);
    }
  }

  // 批量订阅（前端勾选主播的作品后调用）
  if (path === '/anchors/subscribe' && method === 'POST') {
    var ab2 = readBodyJson(req);
    var ids = Array.isArray(ab2.albumIds) ? ab2.albumIds : [];
    if (!ids.length) return jsonResp({ success: false, error: '没有勾选专辑' }, 400);
    try {
      var bs = await bulkSubscribe(ids.slice(0, 50));
      return jsonResp({ success: true, data: bs });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 500);
    }
  }

  // ---------- 待听清单：想听但先存着，不占歌单 ----------
  if (path === '/todo' && method === 'GET') {
    try {
      var tl = todoList();
      return jsonResp({ success: true, data: { items: tl, total: tl.length } });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 500);
    }
  }

  if (path === '/todo' && method === 'POST') {
    try {
      var tb = readBodyJson(req);
      if (tb.clear) {
        var n0 = todoItems.length;
        todoItems = [];
        persistTodo();
        return jsonResp({ success: true, data: { cleared: n0 } });
      }
      if (tb.remove) {
        var ok = todoRemove(String(tb.remove));
        return jsonResp({ success: true, data: { removed: ok, total: todoItems.length } });
      }
      var aid = String(tb.albumId || '').trim();
      if (!aid) return jsonResp({ success: false, error: 'albumId required' }, 400);
      var added = todoAdd({
        albumId: aid,
        name: String(tb.name || '').trim(),
        author: String(tb.author || '').trim(),
        cover: String(tb.cover || ''),
        note: String(tb.note || '')
      });
      return jsonResp({ success: true, data: { added: added, total: todoItems.length } });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 500);
    }
  }

  // 待听清单 → 建歌单并批量导入（沿用已有的导入流水线）
  if (path === '/todo/import' && method === 'POST') {
    if (importing || job.running) return jsonResp({ success: false, error: '已有导入任务进行中' }, 409);
    var tb2 = readBodyJson(req);
    var picked = Array.isArray(tb2.albumIds) && tb2.albumIds.length
      ? tb2.albumIds.map(String)
      : todoItems.map(function (x) { return String(x.albumId); });
    picked = picked.slice(0, 20);
    if (!picked.length) return jsonResp({ success: false, error: '待听清单是空的' }, 400);
    var items2 = picked.map(function (id) {
      var hit = null;
      for (var k = 0; k < todoItems.length; k++) { if (String(todoItems[k].albumId) === id) { hit = todoItems[k]; break; } }
      return { id: id, name: (hit && hit.name) || '' };
    });
    var plName = String(tb2.playlistName || '').trim() ||
      ('待听 ' + new Date().toISOString().slice(5, 10).replace('-', '/'));
    importing = true;
    runImportMulti(items2, 'merge', plName).finally(function () { importing = false; });
    return jsonResp({ success: true, data: { message: '已开始导入 ' + items2.length + ' 张专辑到「' + plName + '」', count: items2.length, playlistName: plName } });
  }

  if (path === '/api/music/url' && method === 'POST') {
    try {
      var b = readBodyJson(req);
      var sd = b.source_data;
      if (typeof sd === 'string') { try { sd = JSON.parse(sd); } catch (e2) { sd = null; } }
      var trackId = sd && (sd.trackId || sd.track_id);
      if (!trackId) return jsonResp({ error: 'source_data.trackId required' }, 400);
      var link = await fetchTrackUrl(trackId);
      return jsonResp({ url: link });
    } catch (e) {
      return jsonResp({ error: String(e) }, 404);
    }
  }

  // 小爱语音搜索（外部搜索源契约）
  if (path === '/api/search/topone' && method === 'POST') {
    try {
      var b2 = readBodyJson(req);
      var kw = String(b2.keyword || '').trim();
      if (!kw) return jsonResp({ code: 1, msg: 'empty keyword', data: null });
      var sr = await searchAlbumsSmart(kw);
      if (!sr.albums.length) {
        // 没有匹配专辑时退回单集搜索：小爱直接播这一集
        try {
          var tr0 = await searchTracks(kw, 1, 5);
          if (tr0.tracks && tr0.tracks.length) {
            var ft = tr0.tracks[0];
            var linkF = await fetchTrackUrl(ft.trackId);
            return jsonResp({
              code: 0, msg: 'ok（单集）',
              data: {
                title: ft.title, artist: '喜马拉雅·' + (ft.album || ft.author || ''), url: linkF,
                duration: ft.duration,
                source_data: { trackId: ft.trackId, title: ft.title, album: ft.album, cover: ft.cover, duration: ft.duration }
              }
            });
          }
        } catch (e2) { /* 继续返回未找到 */ }
        return jsonResp({ code: 1, msg: '未找到', data: null });
      }
      var album = sr.albums[0];
      var page1 = await fetchAlbumTracks(album.id, 1, 3, 1);
      if (!page1.tracks.length) return jsonResp({ code: 1, msg: '专辑无可用曲目', data: null });
      var t0 = page1.tracks[0];
      var link0 = await fetchTrackUrl(t0.trackId);
      return jsonResp({
        code: 0, msg: 'ok',
        data: {
          title: t0.title, artist: '喜马拉雅·' + t0.album, url: link0, duration: t0.duration,
          source_data: { trackId: t0.trackId, title: t0.title, album: t0.album, cover: t0.cover, duration: t0.duration }
        }
      });
    } catch (e) {
      return jsonResp({ code: 1, msg: String(e), data: null });
    }
  }

  // 单集直链（前端试听）：如果这集已经下载到本地，优先给本地文件地址（宿主支持时）
  // v0.22.5：前端预取（列表渲染完 / 手指按下时提前取地址）
  if (path === '/prefetch' && method === 'POST') {
    var pfb = readBodyJson(req);
    var pids = Array.isArray(pfb.track_ids) ? pfb.track_ids : [];
    return jsonResp({ success: true, data: { queued: prefetchUrls(pids) } });
  }

  var mTrack = path.match(/^\/track\/(\d+)\/url$/);
  if (mTrack && method === 'GET') {
    try {
      var lm2 = libMap || {};
      var localInfo = lm2[mTrack[1]];
      if (localInfo && localInfo.path && !q.remote) {
        var localUrl = '';
        try {
          if (songloft.fs && typeof songloft.fs.fileUrl === 'function') localUrl = await songloft.fs.fileUrl(localInfo.path);
          else if (songloft.songs && typeof songloft.songs.fileUrl === 'function') localUrl = await songloft.songs.fileUrl(localInfo.songId);
        } catch (e2) { localUrl = ''; }
        if (localUrl) return jsonResp({ success: true, data: { url: localUrl, local: true, path: localInfo.path } });
        // 宿主没有 fileUrl 能力：只能拿到路径，前端仍走网络地址，但会提示「已有本地副本」
      }
      var u = await trackUrlFast(mTrack[1], q.fresh === '1' || q.fresh === 'true');
      return jsonResp({ success: true, data: { url: u, local: !!(localInfo && localInfo.path), localPath: (localInfo && localInfo.path) || '' } });
    } catch (e) {
      return jsonResp({ success: false, error: String(e) }, 404);
    }
  }

  // 专辑详情 + 第一页曲目
  var mAlbum = path.match(/^\/album\/(\d+)$/);
  if (mAlbum && method === 'GET') {
    try {
      var albumId = mAlbum[1];
      var detailP = fetchAlbumDetail(albumId).catch(function () { return null; });
      var batch = await fetchShowPage(albumId, 1);
      // v0.22.5：打开专辑就把前 3 集地址预热，点第一集基本零等待
      try { prefetchUrls(batch.slice(0, 3).map(function (x) { return x.trackId; })); } catch (eP0) { /* */ }
      var detail = await detailP;
      if (!batch.length) return jsonResp({ success: false, error: '专辑无曲目或已下架' }, 404);
      var albumName = batch[0].albumName || (detail && detail.name) || ('专辑' + albumId);
      var sub = findSub(albumId);
      return jsonResp({
        success: true,
        data: {
          albumId: albumId,
          name: (detail && detail.name) || albumName,
          author: (detail && detail.author) || '',
          cover: (detail && detail.cover) || '',
          intro: (detail && detail.intro) || '',
          introFull: (detail && detail.introFull) || '',
          playCount: (detail && detail.playCount) || 0,
          isPaid: !!(detail && detail.isPaid),
          payLabel: (detail && detail.payLabel) || '',
          payTip: (detail && detail.payTip) || '',
          hasBuy: !!(detail && detail.hasBuy),
          vipType: (detail && detail.vipType) || 0,
          isFinished: Number(detail && detail.isFinished) || 0,
          finishedText: (detail && detail.finishedText) || '',
          updateDate: (detail && detail.updateDate) || '',
          createDate: (detail && detail.createDate) || '',
          category: (detail && detail.category) || '',
          subscribeCount: (detail && detail.subscribeCount) || 0,
          page: 1,
          pageSize: PAGE_SIZE,
          hasMore: batch.length >= PAGE_SIZE,
          tracks: batch.map(function (t) { return mapTrack(t, albumName); }),
          subscribed: !!sub,
          subscription: sub || null
        }
      });
    } catch (e) {
      return jsonResp({ success: false, error: String(e) }, 500);
    }
  }

  // 专辑曲目分页
  var mTracks = path.match(/^\/album\/(\d+)\/tracks$/);
  if (mTracks && method === 'GET') {
    try {
      var pn = Math.max(1, Number(q.page || q.pageNum) || 1);
      var bt = await fetchShowPage(mTracks[1], pn);
      var an = bt.length ? (bt[0].albumName || '') : '';
      return jsonResp({
        success: true,
        data: {
          page: pn, pageSize: PAGE_SIZE, hasMore: bt.length >= PAGE_SIZE,
          tracks: bt.map(function (t) { return mapTrack(t, an); })
        }
      });
    } catch (e) {
      return jsonResp({ success: false, error: String(e) }, 500);
    }
  }

  // 专辑目录（每页的集数范围）：供前端「倒序」从最后一集开始听
  var mOutline = path.match(/^\/album\/(\d+)\/outline$/);
  if (mOutline && method === 'GET') {
    try {
      var oo = await fetchAlbumOutline(mOutline[1]);
      return jsonResp({ success: true, data: oo });
    } catch (e) {
      return jsonResp({ success: false, error: String(e) }, 500);
    }
  }

  // 单专辑导入（异步）
  if (path === '/import' && method === 'POST') {
    if (importing || job.running) return jsonResp({ success: false, error: '已有导入任务进行中' }, 409);
    var b3 = readBodyJson(req);
    var aid = extractAlbumId(b3.album_id || b3.url || '');
    if (!aid) return jsonResp({ success: false, error: '请提供专辑链接或数字 ID' }, 400);
    importing = true;
    runImport(aid, b3.name || '', Number(b3.start) || 0, Number(b3.end) || 0)
      .finally(function () { importing = false; });
    return jsonResp({ success: true, data: { message: '导入任务已开始，可在状态栏查看进度' } });
  }

  // 多专辑导入（异步）：{albums:[{id,name}], mode:'merge'|'separate', name}
  if (path === '/import-multi' && method === 'POST') {
    if (importing || job.running) return jsonResp({ success: false, error: '已有导入任务进行中' }, 409);
    var bm = readBodyJson(req);
    var list = Array.isArray(bm.albums) ? bm.albums : [];
    var items = [];
    for (var i = 0; i < list.length; i++) {
      var id0 = extractAlbumId(list[i].id || list[i].album_id || list[i].url || '');
      if (!id0) continue;
      items.push({ id: id0, name: list[i].name || '' });
    }
    if (!items.length) return jsonResp({ success: false, error: '请至少选择一个专辑' }, 400);
    if (items.length > 20) return jsonResp({ success: false, error: '一次最多合并 20 张专辑' }, 400);
    importing = true;
    runImportMulti(items, bm.mode === 'merge' ? 'merge' : 'separate', bm.name || '')
      .finally(function () { importing = false; });
    return jsonResp({ success: true, data: { message: '已开始导入 ' + items.length + ' 张专辑', count: items.length } });
  }

  // 重试上次导入写入失败的集（v0.18.0）
  if (path === '/import/retry' && method === 'POST') {
    if (importing || (job && job.running)) return jsonResp({ success: false, error: '已有导入任务进行中' }, 409);
    // v0.19.4：按歌单分组重试，每个歌单只补自己的失败集，避免多专辑串本
    var groups = (job && job.parts || []).filter(function (p) {
      return p.retryPlaylistId && p.failedTracks && p.failedTracks.length;
    });
    var singleMode = false;
    if (!groups.length && job && job.failedTracks && job.failedTracks.length) {
      // 单专辑导入：job.parts 里没有 failedTracks 字段，失败集只在 job 上
      singleMode = true;
      groups = [{ retryPlaylistId: Number(job.retryPlaylistId || job.playlistId) || 0, failedTracks: job.failedTracks }];
    }
    if (!groups.length) return jsonResp({ success: true, data: { added: 0, left: 0, message: '没有需要重试的集' } });
    var addedSum = 0, leftSum = 0, skipped = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      var gp = groups[gi];
      if (!gp.retryPlaylistId) { leftSum += gp.failedTracks.length; skipped += 1; continue; }
      var rrg = await addTracksToPlaylist(gp.retryPlaylistId, gp.failedTracks, null);
      // groups 里放的就是 job.parts 的元素引用，这里赋值等于直接更新对应 part
      gp.failedTracks = rrg.failedTracks || [];
      addedSum += rrg.added || 0;
      leftSum += gp.failedTracks.length;
    }
    // job.failedTracks 汇总成「剩余」，供前端显示重试按钮
    job.failedTracks = [];
    if (singleMode) {
      job.failedTracks = groups[0].failedTracks.slice();
    } else {
      (job.parts || []).forEach(function (p) {
        if (p.failedTracks && p.failedTracks.length) job.failedTracks = job.failedTracks.concat(p.failedTracks);
      });
    }
    if (job.failedTracks.length) job.error = '仍有 ' + job.failedTracks.length + ' 集写入失败' + (skipped ? '（' + skipped + ' 张歌单已不存在）' : '');
    else job.error = '';
    await persist();
    songloft.log.info('[喜马拉雅] 重试失败集: 补上 ' + addedSum + ' 集，剩 ' + job.failedTracks.length + ' 集');
    return jsonResp({ success: true, data: { added: addedSum, left: job.failedTracks.length } });
  }

  if (path === '/imported' && method === 'GET') {
    return jsonResp({ success: true, data: { imported: imported, job: job } });
  }

  if ((path === '/imported' && method === 'DELETE') || (path === '/imported/delete' && method === 'POST')) {
    var b4 = readBodyJson(req);
    var pid = Number(b4.playlist_id || b4.playlistId || q.playlist_id || q.pid) || 0;
    // v0.18.5：可选连歌曲库条目一起删（默认保留，由用户在前端选择）
    var delSongs = !!(b4.delete_songs || b4.deleteSongs);
    var songDeleted = 0, songFailed = 0, songTotal = 0;
    if (delSongs && pid) {
      try {
        var dhost = (await songloft.plugin.getHostUrl() || '').replace(/\/+$/, '');
        var dtok = await songloft.plugin.getToken();
        // v0.18.5：宿主默认只返回 20 条，必须翻页收全，否则几百首的歌单只删掉前 20 首。
        var plList = [], plOff = 0, plPage = 200;
        for (var pg = 0; pg < 200; pg++) {
          var plRaw = await songloft.playlists.getSongs(pid, { limit: plPage, offset: plOff });
          var plBatch = (plRaw && (plRaw.songs || plRaw.items)) || (Array.isArray(plRaw) ? plRaw : []);
          if (!plBatch.length) break;
          plList = plList.concat(plBatch);
          var plTotal = plRaw && plRaw.total;
          if (plBatch.length < plPage) break;
          if (plTotal && plList.length >= plTotal) break;
          plOff += plBatch.length;
        }
        songTotal = plList.length;
        // v0.18.7：先把歌单和本地记录删掉（很快），再清曲库——否则几百首串行 DELETE
        // 必然撞上宿主 ~60s 超时，歌单没删成、记录还在，用户以为删除失败，实际歌已被删了一部分。
        try { await songloft.playlists.delete(pid); } catch (e) { /* 歌单可能已删 */ }
        imported = imported.filter(function (x) { return x.playlistId !== pid; });
        subs = subs.filter(function (s) { return s.playlistId !== pid; });
        await persist();

        // 并发 6 条删除，控住总耗时也控住宿主压力
        var ids = [];
        plList.forEach(function (sg) {
          var sgid = sg && (sg.id || sg.songId);
          if (sgid) ids.push(sgid);
        });
        var CONC = 6;
        var delOne = async function (sgid) {
          try {
            var dresp = await fetchT(dhost + '/api/v1/songs/' + sgid,
              { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + dtok } }, 15);
            // v0.18.7：宿主对「歌曲不存在」会返回 500 record not found，这不算失败
            if (dresp.ok) songDeleted++;
            else {
              var ebody = '';
              try { ebody = await dresp.text(); } catch (e2) { ebody = ''; }
              if (/not found|不存在|record not found/i.test(ebody) || dresp.status === 404) songDeleted++;
              else songFailed++;
            }
          } catch (e) { songFailed++; }
        };
        for (var ci = 0; ci < ids.length; ci += CONC) {
          await Promise.all(ids.slice(ci, ci + CONC).map(delOne));
        }
        songloft.log.info('[喜马拉雅] 删除歌曲库条目: 成功 ' + songDeleted + '，失败 ' + songFailed + '（歌单共 ' + songTotal + ' 首）');
        if (songFailed > 0) songloft.log.warn('[喜马拉雅] 有 ' + songFailed + ' 首歌曲库条目删除失败，可在曲库中手动清理');
        return jsonResp({ success: true, data: { songDeleted: songDeleted, songFailed: songFailed, songTotal: songTotal } });
      } catch (e) {
        songloft.log.warn('[喜马拉雅] 清曲库出错: ' + String(e));
      }
    }
    // 不走 delSongs 的正常路径（或上面出错后兜底）：确保歌单和记录都清掉
    try { if (pid) await songloft.playlists.delete(pid); } catch (e) { /* 歌单可能已删 */ }
    imported = imported.filter(function (x) { return x.playlistId !== pid; });
    subs = subs.filter(function (s) { return s.playlistId !== pid; });
    await persist();
    return jsonResp({ success: true, data: { songDeleted: songDeleted, songFailed: songFailed } });
  }

  // ---------- 订阅 ----------
  if (path === '/subs' && method === 'GET') {
    return jsonResp({ success: true, data: subs });
  }

  if (path === '/subs' && method === 'POST') {
    var bs = readBodyJson(req);
    var sid = extractAlbumId(bs.album_id || bs.albumId || '');
    if (!sid) return jsonResp({ success: false, error: '缺少 album_id' }, 400);
    var detailS = null;
    try { detailS = await fetchAlbumDetail(sid); } catch (e) { detailS = null; }
    var existing = findSub(sid);
    var patch = {
      albumId: sid,
      name: bs.name || (detailS && detailS.name) || ('专辑' + sid),
      cover: (detailS && detailS.cover) || (existing && existing.cover) || '',
      author: (detailS && detailS.author) || (existing && existing.author) || '',
      updateDate: (detailS && detailS.updateDate) || ''
    };
    if (typeof bs.autoSync === 'boolean') patch.autoSync = bs.autoSync;
    if (bs.playlist_id) patch.playlistId = Number(bs.playlist_id);
    upsertSub(patch);
    await persist();
    return jsonResp({ success: true, data: findSub(sid) });
  }

  if ((path === '/subs' && method === 'DELETE') || (path === '/subs/remove' && method === 'POST')) {
    var dq = readBodyJson(req);
    var dAlbum = String(dq.album_id || dq.albumId || q.album_id || '');
    if (!dAlbum) return jsonResp({ success: false, error: '缺少 album_id' }, 400);
    subs = subs.filter(function (s) { return String(s.albumId) !== dAlbum; });
    await persist();
    return jsonResp({ success: true });
  }

  // ---------- 追更日历：按周几 / 按新旧看更新规律 ----------
  if (path === '/subs/calendar' && method === 'GET') {
    try {
      return jsonResp({ success: true, data: updateCalendar() });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 500);
    }
  }

  // ---------- 订阅分组（视图，不落盘） ----------
  if (path === '/subs/groups' && method === 'GET') {
    try {
      return jsonResp({ success: true, data: subsGroups(q.by || 'cat') });
    } catch (e) {
      return jsonResp({ success: false, error: String(e && e.message || e) }, 500);
    }
  }

  // ---------- 批量取消订阅 ----------
  if (path === '/subs/unsub' && method === 'POST') {
    var bu = readBodyJson(req);
    var uids = Array.isArray(bu.albumIds) ? bu.albumIds : [];
    if (!uids.length) return jsonResp({ success: false, error: '没有勾选专辑' }, 400);
    var ures = unsubBatch(uids);
    await persist();
    logInfo('subs', '批量取消订阅 ' + ures.removed + ' 张');
    return jsonResp({ success: true, data: ures, subs: subs });
  }

  // 单张检查/同步：/subs/check {album_id, import?}
  if (path === '/subs/check' && method === 'POST') {
    var bc = readBodyJson(req);
    var cid = String(bc.album_id || bc.albumId || '');
    if (cid) {
      var s1 = findSub(cid);
      if (!s1) return jsonResp({ success: false, error: '未订阅该专辑' }, 404);
      var r1 = await syncOne(s1, { import: !!bc.import });
      return jsonResp({ success: true, data: r1, sub: s1 });
    }
    // v0.19.4：全量分支同样异步化，理由见 /sync
    if (syncing) return jsonResp({ success: false, error: '已有同步任务在跑，请稍候' }, 409);
    var checkImport = !!bc.import;
    runSyncAll({ import: checkImport, trigger: '手动' })
      .catch(function (e) { songloft.log.warn('[喜马拉雅] 检查更新异常: ' + String(e)); });
    return jsonResp({ success: true, data: { message: '检查已开始', async: true } });
  }

  // 立即全量同步（含自动同步关闭的订阅）
  if (path === '/sync' && method === 'POST') {
    if (syncing) return jsonResp({ success: false, error: '已有同步任务在跑，请稍候' }, 409);
    // v0.19.4：原来在请求里等整轮同步返回。几十张订阅 = 上百次串行请求，必然撞宿主 60s 上限，
    // 前端拿到超时，用户重复点，后台其实已经在跑（还会被 syncing 挡掉反而报错）。
    // 改成立即返回 + 前端轮询 /status，和 /watch/run、/tts/run 一个模式。
    var by = readBodyJson(req);
    var wantImport = by.import !== false;
    runSyncAll({ import: wantImport, force: true, trigger: by.trigger || '手动' })
      .catch(function (e) { songloft.log.warn('[喜马拉雅] 同步异常: ' + String(e)); });
    return jsonResp({ success: true, data: { message: '同步已开始', async: true } });
  }

  if (path === '/search' && method === 'GET') {
    try {
      var kwG = String(q.kw || q.keyword || '').trim();
      if (!kwG) return jsonResp({ success: false, error: '缺少 kw 参数' }, 400);
      var sg = await searchAlbumsSmart(kwG);
      return jsonResp({ success: true, data: sg.albums, keywords: sg.keywords || [], source: sg.source || '', count: sg.albums.length });
    } catch (e) {
      return jsonResp({ success: false, error: String(e) }, 500);
    }
  }

  if (path === '/search' && method === 'POST') {
    try {
      var b5 = readBodyJson(req);
      var kw2 = String(b5.kw || b5.keyword || '').trim();
      if (!kw2) return jsonResp({ success: false, error: '关键词为空' }, 400);
      var sr2 = await searchAlbumsSmart(kw2);
      return jsonResp({
        success: true,
        data: sr2.albums,
        keywords: sr2.keywords || [],
        source: sr2.source || '',
        count: sr2.albums.length
      });
    } catch (e) {
      return jsonResp({ success: false, error: String(e) }, 500);
    }
  }

  // ---------- 整本下载到本地音乐目录 ----------
  if (path === '/download' && method === 'POST') {
    if (downloading) return jsonResp({ success: false, error: '已有下载任务进行中' }, 409);
    var dbb = readBodyJson(req);
    var plid = Number(dbb.playlist_id || dbb.playlistId) || 0;
    var dalbum = String(dbb.album_id || dbb.albumId || '');
    var dtitle = String(dbb.name || '');
    if (!plid && dalbum) {
      var sfound = findSub(dalbum);
      if (sfound && sfound.playlistId) { plid = Number(sfound.playlistId); dtitle = dtitle || sfound.name; }
      var ifound = null;
      for (var ii = 0; ii < imported.length; ii++) if (String(imported[ii].albumId) === dalbum) { ifound = imported[ii]; break; }
      if (!plid && ifound) { plid = Number(ifound.playlistId); dtitle = dtitle || ifound.name; }
    }
    if (!plid) return jsonResp({ success: false, error: '这个专辑还没有歌单，请先导入' }, 400);
    var tdir = String(dbb.target_dir || '').trim() || config.dl.targetDir || '';
    runDownload(plid, tdir, dtitle).catch(function (e) {
      songloft.log.error('[喜马拉雅] 下载异常: ' + String(e));
    });
    return jsonResp({ success: true, data: { message: '已开始下载' + (dtitle ? '《' + dtitle + '》' : ''), job: dlJob } });
  }

  if (path === '/download/status' && method === 'GET') {
    return jsonResp({ success: true, data: { job: dlJob, cfg: config.dl } });
  }

  if (path === '/download/stop' && method === 'POST') {
    if (!dlJob.running) return jsonResp({ success: true, data: { message: '当前没有下载任务' } });
    dlJob.cancel = true;
    await persistDl();
    return jsonResp({ success: true, data: { message: '已请求停止，当前这一集下载完就停' } });
  }

  // v0.22.4：网络诊断——设置页一键测「主站 / 取流接口 / 图片 CDN」的连通性与延迟
  if (path === '/net/health' && method === 'GET') {
    var hxh = { 'User-Agent': UA_PC, 'Referer': 'https://www.ximalaya.com/' };
    var probes = [
      { name: '喜马拉雅主站', url: 'https://www.ximalaya.com/revision/time', headers: hxh },
      { name: '单集接口（取流）', url: 'https://m.ximalaya.com/tracks/1022547850.json', headers: { 'User-Agent': UA_M, 'Referer': 'https://m.ximalaya.com/' } },
      { name: '图片 CDN', url: 'https://imagev2.xmcdn.com/', headers: hxh }
    ];
    var hitems = [];
    for (var hi = 0; hi < probes.length; hi++) {
      var prb = probes[hi], t0 = Date.now();
      try {
        var hresp = await fetchT(prb.url, { method: 'GET', headers: prb.headers }, 8);
        hitems.push({ name: prb.name, ok: hresp.status < 500, status: hresp.status, ms: Date.now() - t0 });
      } catch (eH) {
        hitems.push({ name: prb.name, ok: false, ms: Date.now() - t0, error: String(eH && eH.message || eH) });
      }
    }
    return jsonResp({
      success: true,
      data: { at: Date.now(), items: hitems, active: netActive, queued: netWait.length, cache: netCacheN }
    });
  }

  return jsonResp({ success: false, error: 'not found: ' + path }, 404);
}

// ---------- 生命周期 ----------

async function onInit() {
  songloft.log.info('[喜马拉雅] 插件初始化 v' + VERSION);
  await loadAll();
  try {
    var r = await songloft.comm.call(MIOT_ENTRY, 'register-search-provider', {
      name: '喜马拉雅',
      searchPath: '/api/search/topone'
    });
    songloft.log.info('[喜马拉雅] 已注册 miot 外部搜索源: ' + JSON.stringify(r));
  } catch (e) {
    songloft.log.warn('[喜马拉雅] 注册搜索源失败（不影响导入播放）: ' + String(e));
  }
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(function () {
    tick().catch(function (e) { songloft.log.warn('[喜马拉雅] tick 异常: ' + String(e)); });
  }, 60000);
  songloft.log.info('[喜马拉雅] 初始化完成：已导入 ' + imported.length + ' 张，订阅 ' + subs.length + ' 张，自动同步=' + (config.auto.enabled ? config.auto.time : '关闭'));
}

async function onDeinit() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  songloft.log.info('[喜马拉雅] 插件已停止');
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = handleHTTPRequest;
