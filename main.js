'use strict';
// 喜马拉雅插件 for Songloft v0.8.0
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
// 数据源（公开接口，免登录）：
//   专辑详情: GET https://www.ximalaya.com/revision/album/v1/simple?albumId={id}
//   专辑曲目: GET https://www.ximalaya.com/revision/play/v1/show?id={id}&num={page}&size=30&ptype=0
//   单集直链: GET https://m.ximalaya.com/tracks/{trackId}.json → play_path_64/32
//   搜索:     GET /revision/search/main（WAF 风控）/revision/suggest（可用）
//   登录态:   GET /revision/main/getCurrentUser、/revision/my/getSubscriptionSynthesize 等（需 Cookie）
//   扫码登录: GET /passport/qrcode/gen?level=L → {qrId, img}；GET /passport/qrcode/check/{qrId}/{ts} → Set-Cookie 1&_token

var VERSION = '0.8.0';
var ENTRY = 'ximalaya';
var MIOT_ENTRY = 'miot';
var CFG_KEY = 'config:v1';
var LIB_KEY = 'imported:v1';
var JOB_KEY = 'import_job:v1';
var LOGIN_KEY = 'login:v1';
var SUB_KEY = 'subs:v1';

var UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
var UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
var PAGE_SIZE = 30;
var MAX_PAGES = 60;        // 单次导入最多拉 60 页（约 1800 集）
var BATCH = 200;           // 单批建歌上限
var SYNC_MAX_PAGES = 25;   // 增量同步最多回溯 25 页

var config = {
  device: { account_id: '', device_id: '', device_name: '' },
  auto: { enabled: false, time: '08:30', pushDevice: false, lastRunDate: '' }
};
var imported = [];   // [{albumId, name, playlistId, count, importedAt}]
var subs = [];       // [{albumId, name, playlistId, lastIndex, songCount, cover, author, updateDate, lastCheckAt, newCount, newTitles, autoSync}]
var job = { running: false, mode: '', title: '', done: 0, total: 0, playlistId: 0, error: '', finishedAt: '', current: '', parts: [] };
var login = { cookie: '', savedAt: '' };
var lastSync = { at: '', result: '', trigger: '' };

var syncing = false;
var importing = false;
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

function fetchT(url, init, timeoutSec) {
  return Promise.race([
    fetch(url, init || {}),
    new Promise(function (_r, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, (timeoutSec || 15) * 1000);
    })
  ]);
}

async function getJSON(url, headers) {
  var resp = await fetchT(url, { method: 'GET', headers: headers || {} }, 15);
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + url);
  return resp.json();
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
  var d = await getJSON(url, pcHeaders(albumId));
  if (d.ret !== 200) throw new Error('喜马拉雅接口异常 ret=' + d.ret + ' ' + (d.msg || ''));
  return (d.data && d.data.tracksAudioPlay) || [];
}

function mapTrack(t, albumName) {
  return {
    index: t.index,
    trackId: t.trackId,
    title: t.trackName || ('第' + t.index + '集'),
    album: t.albumName || albumName || '',
    duration: t.duration || 0,
    cover: t.trackCoverPath ? ('https://imagev2.xmcdn.com/' + t.trackCoverPath) : ''
  };
}

async function fetchAlbumDetail(albumId) {
  var url = 'https://www.ximalaya.com/revision/album/v1/simple?albumId=' + albumId;
  var d = await getJSON(url, pcHeaders(albumId));
  if (d.ret !== 200) throw new Error('专辑信息获取失败 ret=' + d.ret + ' ' + (d.msg || ''));
  var m = (d.data && d.data.albumPageMainInfo) || {};
  return {
    albumId: String(albumId),
    name: stripHtml(m.albumTitle || ''),
    author: m.anchorName || '',
    cover: normCover(m.cover || ''),
    intro: stripHtml(m.shortIntro || ''),
    introFull: stripHtml(m.richIntro || m.detailRichIntro || ''),
    playCount: m.playCount || 0,
    isPaid: !!m.isPaid,
    isFinished: !!m.isFinished,
    updateDate: m.updateDate || '',
    createDate: m.createDate || '',
    category: m.categoryTitle || '',
    subscribeCount: m.subscribeCount || 0
  };
}

async function fetchTrackUrl(trackId) {
  var url = 'https://m.ximalaya.com/tracks/' + trackId + '.json';
  var h = { 'User-Agent': UA_M, 'Referer': 'https://m.ximalaya.com/' };
  if (login.cookie) h['Cookie'] = login.cookie;
  var d = await getJSON(url, h);
  var link = d.play_path_64 || d.play_path_32 || d.play_path || '';
  if (!link) {
    if (d.is_paid) throw new Error('paid: 该集为付费/VIP内容（未登录或无权限）');
    throw new Error('未获取到音频地址（可能已下架）');
  }
  return link;
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

// ---------- 存储 ----------

async function loadAll() {
  try { var c = await songloft.storage.get(CFG_KEY); if (c) config = typeof c === 'string' ? JSON.parse(c) : c; } catch (e) { /* */ }
  try { var l = await songloft.storage.get(LIB_KEY); if (l) imported = typeof l === 'string' ? JSON.parse(l) : l; } catch (e) { /* */ }
  try { var j = await songloft.storage.get(JOB_KEY); if (j) job = typeof j === 'string' ? JSON.parse(j) : j; } catch (e) { /* */ }
  try { var g = await songloft.storage.get(LOGIN_KEY); if (g) login = typeof g === 'string' ? JSON.parse(g) : g; } catch (e) { /* */ }
  try { var s = await songloft.storage.get(SUB_KEY); if (s) subs = typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { /* */ }

  if (!config || typeof config !== 'object') config = {};
  if (!config.device) config.device = { account_id: '', device_id: '', device_name: '' };
  if (!config.auto) config.auto = { enabled: false, time: '08:30', pushDevice: false, lastRunDate: '' };
  if (!login || typeof login.cookie !== 'string') login = { cookie: '', savedAt: '' };
  if (!Array.isArray(subs)) subs = [];
  if (!Array.isArray(imported)) imported = [];
  if (!job || typeof job !== 'object') job = { running: false, mode: '', title: '', done: 0, total: 0, playlistId: 0, error: '', finishedAt: '', current: '', parts: [] };

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

// ---------- miot 调用 ----------

async function miotGet(path) {
  var host = (await songloft.plugin.getHostUrl() || '').replace(/\/+$/, '');
  var token = await songloft.plugin.getToken();
  var resp = await fetchT(host + '/api/v1/jsplugin/' + MIOT_ENTRY + path,
    { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } }, 15);
  var text = await resp.text();
  try { return { ok: resp.ok, data: JSON.parse(text) }; } catch (e) { return { ok: resp.ok, data: null }; }
}

async function miotPost(path, payload) {
  var host = (await songloft.plugin.getHostUrl() || '').replace(/\/+$/, '');
  var token = await songloft.plugin.getToken();
  var resp = await fetchT(host + '/api/v1/jsplugin/' + MIOT_ENTRY + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(payload || {})
  }, 15);
  var text = await resp.text();
  try { return { ok: resp.ok, data: JSON.parse(text) }; } catch (e) { return { ok: resp.ok, data: null }; }
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
  for (var i = 0; i < tracks.length; i += BATCH) {
    var slice = tracks.slice(i, i + BATCH);
    try {
      var created = await songloft.songs.create(slice.map(toSongInput));
      var ids = (created || []).map(function (s) { return s && s.id; }).filter(function (x) { return !!x; });
      if (ids.length) {
        var r = await songloft.playlists.addSongs(playlistId, ids);
        added += (r && typeof r.added === 'number') ? r.added : ids.length;
      }
    } catch (e) {
      failed += slice.length;
      songloft.log.warn('[喜马拉雅] 批量写入失败(' + i + '): ' + String(e));
    }
    if (onProgress) onProgress(slice.length);
  }
  return { added: added, failed: failed };
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

    imported.unshift({
      albumId: String(albumId),
      name: title,
      playlistId: playlist.id,
      count: res.added || job.done,
      importedAt: nowStr()
    });
    upsertSub({
      albumId: String(albumId),
      name: title,
      playlistId: playlist.id,
      lastIndex: lastIdx,
      songCount: res.added || job.done,
      cover: (detail && detail.cover) || '',
      author: (detail && detail.author) || '',
      updateDate: (detail && detail.updateDate) || '',
      lastCheckAt: nowStr(),
      newCount: 0,
      newTitles: []
    });

    job.running = false;
    job.finishedAt = nowStr();
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

        var lastIdx = 0;
        fetched.tracks.forEach(function (t) { if (t.index > lastIdx) lastIdx = t.index; });

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

async function syncOne(sub, opts) {
  opts = opts || {};
  var out = { albumId: sub.albumId, name: sub.name, newCount: 0, added: 0, error: '' };
  try {
    var detail = null;
    try { detail = await fetchAlbumDetail(sub.albumId); } catch (e) { detail = null; }
    if (detail) {
      if (detail.name) sub.name = detail.name;
      if (detail.cover) sub.cover = detail.cover;
      if (detail.author) sub.author = detail.author;
      sub.updateDate = detail.updateDate;
    }

    var r = await fetchNewTracks(sub.albumId, sub.lastIndex || 0);
    out.newCount = r.tracks.length;
    sub.newCount = r.tracks.length;
    sub.newTitles = r.tracks.slice(-3).map(function (t) { return t.index + '. ' + t.title; });
    sub.lastCheckAt = nowStr();

    if (r.tracks.length && opts.import && sub.playlistId) {
      stampAuthor(r.tracks, sub.author, sub.name);
      var res = await addTracksToPlaylist(sub.playlistId, r.tracks);
      out.added = res.added;
      sub.lastIndex = r.lastIndex;
      sub.songCount = (Number(sub.songCount) || 0) + res.added;
      sub.newCount = 0;
      sub.newTitles = [];
      sub.lastImportAt = nowStr();
    }
    await persist();
  } catch (e) {
    out.error = String(e);
    sub.lastCheckAt = nowStr();
    await persist();
  }
  return out;
}

async function runSyncAll(opts) {
  opts = opts || {};
  if (syncing) return { skipped: true, newCount: 0 };
  syncing = true;
  var totalNew = 0, totalAdded = 0, checked = 0, errors = [];
  var pushed = null;
  try {
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      if (!opts.force && s.autoSync === false) continue;
      var r = await syncOne(s, { import: opts.import !== false });
      checked += 1;
      totalNew += r.newCount || 0;
      totalAdded += r.added || 0;
      if (r.error) errors.push(r.name + ': ' + r.error);
      if (r.added && !pushed) pushed = s;
    }
    lastSync = {
      at: nowStr(),
      result: '检查 ' + checked + ' 张，新增 ' + totalAdded + ' 集' + (errors.length ? '，' + errors.length + ' 张出错' : ''),
      trigger: opts.trigger || '手动'
    };
    if (opts.markAuto) { config.auto.lastRunDate = todayStr(); }
    await persist();

    if (pushed && config.auto.pushDevice && config.device && config.device.device_id) {
      try {
        await miotPost('/player/play', {
          account_id: config.device.account_id,
          device_id: config.device.device_id,
          playlist_id: pushed.playlistId
        });
        songloft.log.info('[喜马拉雅] 已把《' + pushed.name + '》推送到音箱');
      } catch (e) { /* ignore */ }
    }
    songloft.log.info('[喜马拉雅] 同步完成：' + lastSync.result);
  } finally {
    syncing = false;
  }
  return { newCount: totalAdded, checked: checked, errors: errors };
}

async function tick() {
  if (!config.auto || !config.auto.enabled) return;
  if (syncing) return;
  if (config.auto.lastRunDate === todayStr()) return;
  if (hhmmNow() < String(config.auto.time || '08:30')) return;
  songloft.log.info('[喜马拉雅] 触发定时同步（设定 ' + config.auto.time + '）');
  await runSyncAll({ import: true, markAuto: true, trigger: '定时' });
}

// ---------- HTTP 路由 ----------

function normPath(p) {
  var prefix = '/api/v1/jsplugin/' + ENTRY;
  if (p && p.indexOf(prefix) === 0) p = p.slice(prefix.length) || '/';
  if (!p) p = '/';
  var qi = p.indexOf('?');
  if (qi >= 0) p = p.slice(0, qi);
  return p;
}

async function handleHTTPRequest(req) {
  var path = normPath(req.path || '');
  var method = (req.method || 'GET').toUpperCase();
  var q = parseQuery(req);

  if (path === '/config' && method === 'GET') return jsonResp({ success: true, data: config });

  if (path === '/config' && method === 'POST') {
    var body = readBodyJson(req);
    if (body.device) {
      config.device = {
        account_id: body.device.account_id || '',
        device_id: body.device.device_id || '',
        device_name: body.device.device_name || ''
      };
    }
    if (body.auto) {
      var a = body.auto;
      if (typeof a.enabled === 'boolean') config.auto.enabled = a.enabled;
      if (a.time && /^\d{1,2}:\d{2}$/.test(a.time)) config.auto.time = a.time;
      if (typeof a.pushDevice === 'boolean') config.auto.pushDevice = a.pushDevice;
      if (a.lastRunDate === '') config.auto.lastRunDate = '';
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
        loggedIn: !!login.cookie
      }
    });
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
      if (!sr.albums.length) return jsonResp({ code: 1, msg: '未找到', data: null });
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

  // 单集直链（前端试听）
  var mTrack = path.match(/^\/track\/(\d+)\/url$/);
  if (mTrack && method === 'GET') {
    try {
      var u = await fetchTrackUrl(mTrack[1]);
      return jsonResp({ success: true, data: { url: u } });
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
          isFinished: !!(detail && detail.isFinished),
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

  if (path === '/imported' && method === 'GET') {
    return jsonResp({ success: true, data: { imported: imported, job: job } });
  }

  if ((path === '/imported' && method === 'DELETE') || (path === '/imported/delete' && method === 'POST')) {
    var b4 = readBodyJson(req);
    var pid = Number(b4.playlist_id || b4.playlistId || q.playlist_id || q.pid) || 0;
    try { if (pid) await songloft.playlists.delete(pid); } catch (e) { /* 歌单可能已删 */ }
    imported = imported.filter(function (x) { return x.playlistId !== pid; });
    subs = subs.filter(function (s) { return s.playlistId !== pid; });
    await persist();
    return jsonResp({ success: true });
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
    var all = await runSyncAll({ import: !!bc.import, trigger: '手动' });
    return jsonResp({ success: true, data: all, subs: subs });
  }

  // 立即全量同步（含自动同步关闭的订阅）
  if (path === '/sync' && method === 'POST') {
    var by = readBodyJson(req);
    var rs = await runSyncAll({ import: by.import !== false, force: true, trigger: by.trigger || '手动' });
    return jsonResp({ success: true, data: rs, subs: subs, lastSync: lastSync });
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

  if (path === '/devices' && method === 'GET') {
    var devs = await miotGet('/mina/devices');
    return jsonResp({ success: devs.ok, data: devs.data });
  }

  if (path === '/play' && method === 'POST') {
    try {
      var b6 = readBodyJson(req);
      var acc = (b6.account_id || (config.device && config.device.account_id) || '');
      var dev = (b6.device_id || (config.device && config.device.device_id) || '');
      var pl = Number(b6.playlist_id) || 0;
      if (!acc || !dev || !pl) return jsonResp({ success: false, error: '缺少 account/device/playlist 参数' }, 400);
      var playBody = { account_id: acc, device_id: dev, playlist_id: pl };
      if (b6.mode === 'random') { playBody.play_mode = 'random'; playBody.start_position = 'random'; }
      var r = await miotPost('/player/play', playBody);
      if (!r.ok || (r.data && r.data.success === false)) {
        return jsonResp({ success: false, error: (r.data && r.data.error) || 'HTTP ' + r.status }, 500);
      }
      return jsonResp({ success: true, data: { message: '已在音箱开始播放' } });
    } catch (e) {
      return jsonResp({ success: false, error: String(e) }, 500);
    }
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
