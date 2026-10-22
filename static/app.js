/* 喜马拉雅插件 v0.8.0 — 设置页脚本
 * 优先用宿主注入的 SongloftPlugin（apiGet/apiPost/apiDelete 自动鉴权），独立打开回退 ?token=。 */
(function () {
  'use strict';

  // localStorage 在部分宿主环境（沙箱 iframe / 鸿蒙 webview 等）会直接抛
  // SecurityError —— 任何裸调用都会炸掉整个脚本，必须全部走安全封装。
  function sGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function sSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* */ } }

  // 全局错误可视化：任何未捕获异常都显示在页面上，避免「页面点了没反应」
  window.addEventListener('error', function (ev) {
    try {
      var d = document.createElement('div');
      d.className = 'err';
      d.style.cssText = 'position:fixed;left:10px;right:10px;bottom:70px;z-index:9999;background:var(--card);border:1px solid var(--err);border-radius:8px;padding:8px 10px;font-size:12px;';
      d.textContent = '脚本错误: ' + (ev.message || 'unknown');
      document.body.appendChild(d);
      setTimeout(function () { d.remove(); }, 8000);
    } catch (e) { /* */ }
  });

  var sp = window.SongloftPlugin || null;
  var qs = new URLSearchParams(location.search);
  // token 来源优先级：?token= > xm_token > 宿主注入的 songloft-auth（host 脚本会把 ?access_token 收进去）
  var token = qs.get('token') || sGet('xm_token') || '';
  if (!token) {
    try {
      var au = JSON.parse(sGet('songloft-auth') || 'null');
      if (au && au.accessToken) token = au.accessToken;
    } catch (e) { /* */ }
  }
  var API_BASE = (location.pathname.indexOf('/static/') > 0
    ? location.pathname.slice(0, location.pathname.indexOf('/static/'))
    : location.pathname.replace(/\/+$/, ''));

  function bare(p) {
    return p.replace(/^\/api\/v1\/jsplugin\/ximalaya/, '');
  }

  // 把前端发生的错误也交给后端统一记日志，排查时一处就能看全
  var uiErrAt = 0;
  function reportUiError(text) {
    try {
      if (!text) return;
      if (Date.now() - uiErrAt < 3000) return;   // 同一波错误只记一条
      uiErrAt = Date.now();
      var pr = api('POST', '/logs', { action: 'mark', level: 'error', msg: String(text).slice(0, 240) });
      if (pr && typeof pr.catch === 'function') pr.catch(function () { /* */ });
    } catch (e) { /* */ }
  }

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  var hasQsToken = !!qs.get('token');   // v0.21.7：URL 显式带 token 时不走宿主桥（桥在独立打开时可能没有凭据）
  // v0.22.4：统一请求层——超时可中断、GET 网络错误自动重试一次、并发相同 GET 只发一次。
  // 以前宿主桥没有超时，NAS 那边网络卡住时界面会一直转圈。
  var API_TIMEOUT = 25000;
  var apiInflight = {};
  function apiTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var tm = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('请求超时（网络较慢，已自动重试）'));
      }, ms);
      p.then(function (v) { if (done) return; done = true; clearTimeout(tm); resolve(v); },
        function (e) { if (done) return; done = true; clearTimeout(tm); reject(e); });
    });
  }
  function isNetError(e) {
    var m = String(e && e.message || e);
    if (/HTTP 4\d\d/.test(m)) return false;
    return /timeout|超时|Failed to fetch|NetworkError|network error|load failed|fetch failed|不可用|ECONN/i.test(m);
  }
  async function apiOnce(method, path, body) {
    if (sp && !hasQsToken) {
      if (method === 'GET' && sp.apiGet) return sp.apiGet(path);
      if (method === 'POST' && sp.apiPost) return sp.apiPost(path, body === undefined ? {} : body);
      if (method === 'DELETE' && sp.apiDelete) return sp.apiDelete(path);
      if (method === 'PUT' && sp.apiPut) return sp.apiPut(path, body === undefined ? {} : body);
    }
    var ctl = null;
    try { ctl = new AbortController(); } catch (e0) { ctl = null; }
    var opt = { method: method, headers: headers() };
    if (ctl) opt.signal = ctl.signal;
    if (body !== undefined) opt.body = JSON.stringify(body);
    var resp = await fetch(API_BASE + path, opt);
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok && data.error) throw new Error(data.error);
    return data;
  }
  async function api(method, path, body) {
    var key = method + ' ' + path;
    if (method === 'GET' && apiInflight[key]) return apiInflight[key];
    var run = (async function () {
      try {
        return await apiTimeout(apiOnce(method, path, body), API_TIMEOUT);
      } catch (e) {
        if (method === 'GET' && isNetError(e)) {
          await new Promise(function (r) { setTimeout(r, 600); });
          return await apiTimeout(apiOnce(method, path, body), API_TIMEOUT);
        }
        throw e;
      }
    })();
    if (method === 'GET') {
      apiInflight[key] = run;
      try { return await run; } finally { delete apiInflight[key]; }
    }
    return run;
  }

  var $ = function (id) { return document.getElementById(id); };
  function msg(text, cls) {
    var el = $('jobText');
    $('jobBar').classList.add('show');
    el.className = 'txt ' + (cls || '');
    el.textContent = text;
    if (!jobActive) {
      $('jobFill').style.width = '100%';
      setTimeout(function () { if (!jobActive) $('jobBar').classList.remove('show'); }, 4000);
    }
  }
  // v0.19.4：原来 esc 只是 null 保护，却被当成「转义」用在 innerHTML 拼接里 ——
  // 专辑名/集名/错误文案里带 <img onerror> 就会在 webview 里执行。统一按 HTML 转义。
  // 注意：textContent / msg() 这类纯文本出口不要过 esc，否则会看到 &amp; 之类实体。
  function esc(s) { return escHtml(s); }
  // v0.23.2：点「展开」看完整错误（事件委托，动态插入的节点也能点）
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.errclip') : null;
    if (!t) return;
    t.innerHTML = escHtml(t.getAttribute('data-full') || '');
    t.classList.remove('errclip');
  });
  // v0.23.2：长错误信息默认截断，点击展开全文（下载失败整条路径又长又刺眼）
  function errClip(err, cap) {
    var one = String(err || '').replace(/\s+/g, ' ').trim();
    var n = cap || 90;
    if (one.length <= n) return '<span class="err">' + escHtml(one) + '</span>';
    return '<span class="err errclip" data-full="' + escHtml(one) + '">' +
      escHtml(one.slice(0, n)) + '… <span class="link">展开</span></span>';
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtPlay(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }
  // v0.19.4：原来不取整，接口给 59.6 秒就会渲染成「0:59.6」
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // v0.19.4：「已听完」原来有三套阈值（列表 -20 / 续播条 -5 / 上报 -15），
  // 同一集在不同位置状态会自相矛盾。统一成一个判据。
  var DONE_GAP = 20;
  function posDone(p) { return !!(p && p.d && Number(p.t) >= Number(p.d) - DONE_GAP); }

  // ---------- 发现页（搜索 + 收听合并，v0.20.0） ----------
  // 原来「搜索」「收听」是两个 tab：想接着上次听要切 tab，想搜新书又要切回来，
  // 两边都各有一半是空的。现在合成一页——搜索框常驻，没在搜索时下面就是「继续听」，
  // 一搜就换成结果，返回/清空又回到继续听。
  var LSN_SEG_KEY = 'listen_seg';
  var listenSeg = 'recent';

  function showListen(on) {
    var w = $('listenWrap');
    if (w) w.classList.toggle('hide', !on);
  }

  // 当前是否处在「看结果 / 看详情」的状态（此时不该把继续听铺出来）
  function inSearchFlow() {
    if (!$('detailCard').classList.contains('hide')) return true;
    if ($('kw') && $('kw').value.trim()) return true;
    return !!(results && results.length) || !!(trackRows && trackRows.length);
  }

  function loadListenPane() {
    if (listenSeg === 'recent') { renderRecent(); pullRecent(); }
    else if (listenSeg === 'tl') renderTimeline();
    else if (listenSeg === 'dash') loadDashboard();
    else { loadOverview(); loadReport(rpPeriod); }
  }

  function setListenSeg(seg, silent) {
    var ok = ['recent', 'tl', 'dash', 'rp'];
    listenSeg = ok.indexOf(seg) >= 0 ? seg : 'recent';
    ok.forEach(function (t) {
      var pane = $('lsn-' + t);
      if (pane) pane.classList.toggle('hide', t !== listenSeg);
      var b = document.querySelector('.lsnSeg[data-seg="' + t + '"]');
      if (b) b.classList.toggle('on', t === listenSeg);
    });
    sSet(LSN_SEG_KEY, listenSeg);
    if (!silent) { showListen(true); loadListenPane(); }
  }

  // 回到「发现」的空闲态：搜索框空且没结果 → 铺开继续听
  function syncDiscover() {
    var idle = !inSearchFlow();
    showListen(idle);
    if (idle) loadListenPane();
  }

  // ---------- 标签页 ----------
  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      ['search', 'subs', 'lib', 'set'].forEach(function (t) {
        var sec = $('tab-' + t);
        if (sec) sec.classList.toggle('hide', t !== btn.dataset.tab);
      });
      if (btn.dataset.tab === 'search') syncDiscover();
      if (btn.dataset.tab === 'subs') {
        loadSubs();
        if (!meLoaded) loadMySubs(false);
        loadGroups();
        loadSubGroups();
      }
      if (btn.dataset.tab === 'lib') { loadImported(); poll(); }
      if (btn.dataset.tab === 'subs') { poll(); }
      if (btn.dataset.tab === 'set') { loadLogs(); runSelfCheck(false); loadCookieHealth(); }
    });
  });

  // 收听分段按钮
  document.querySelectorAll('.lsnSeg').forEach(function (b) {
    b.addEventListener('click', function () { setListenSeg(b.dataset.seg); });
  });

  // ---------- 登录 ----------
  function renderLogin(d) {
    var el = $('loginStatus');
    d = d || {};
    if (!d.loggedIn) {
      el.innerHTML = '<span class="muted">○ 未登录（仅免费内容可用）</span>';
      return;
    }
    var bits = ['<span class="ok">● 已登录</span>'];
    if (d.user && (d.user.nickname || d.user.uid)) {
      bits.push('<b>' + esc(d.user.nickname || d.user.uid) + '</b>');
      if (d.user.uid) bits.push('<span class="muted">uid ' + esc(d.user.uid) + '</span>');
    } else if (d.valid === false) {
      bits.push('<span class="err">登录态无效' + (d.error ? '：' + esc(d.error) : '') + '</span>');
    }
    bits.push('<span class="muted">保存于 ' + esc(d.savedAt || '') + ' · ' + esc(d.mask || '') + '</span>');
    if (d.cookieSane === false) bits.push('<span class="err">（' + esc(d.cookieHint || 'Cookie 格式可疑') + '）</span>');
    el.innerHTML = bits.join(' ');
  }

  async function loadLogin() {
    var el = $('loginStatus');
    try {
      // v0.23.11：/login 与 /me 并行发（原来已登录时要串行等两跳，/me 还带外网验证，
      // 登录卡要等两个 RT 才渲染完整）。未登录时 /me 直接 401，catch 掉即可。
      var pr = api('GET', '/login');
      var pm = api('GET', '/me').catch(function () { return null; });
      var r = await pr;
      var d = r.data || {};
      renderLogin(d);
      // /me 带用户信息（头像昵称）与实时有效性，回来后补渲染
      var m = await pm;
      var md = (m && m.data) || null;
      if (md && (md.valid || md.user)) {
        renderLogin({
          loggedIn: true, valid: md.valid, user: md.user, error: md.error,
          savedAt: d.savedAt, mask: d.mask, cookieSane: d.cookieSane, cookieHint: d.cookieHint
        });
      }
    } catch (e) {
      el.innerHTML = '<span class="err">状态加载失败: ' + esc(e.message) + '</span>';
    }
  }

  $('btnLogin').addEventListener('click', async function () {
    var ck = $('cookieInput').value.trim();
    if (!ck) { msg('请先粘贴 Cookie', 'err'); return; }
    if (/^U2FsdGVkX1/.test(ck)) {
      msg('❌ 这串看起来是加密数据（U2Fsd…），不是 Cookie。请按上面的方式重新复制', 'err');
      return;
    }
    $('btnLogin').disabled = true;
    msg('⏳ 已发送 Cookie，正在验证登录态…');
    try {
      var r = await api('POST', '/login', { cookie: ck });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      var d = r.data || {};
      if (d.valid) {
        $('cookieInput').value = '';
        msg('✅ ' + (d.message || '登录成功'), 'ok');
      } else {
        msg('⚠️ ' + (d.message || '已保存但验证未通过'), 'err');
      }
      loadLogin();
      loadMySubs(true);
    } catch (e) { msg('保存失败: ' + e.message, 'err'); }
    finally { $('btnLogin').disabled = false; }
  });

  $('btnVerify').addEventListener('click', async function () {
    var ck = $('cookieInput').value.trim();
    $('btnVerify').disabled = true;
    msg('⏳ 正在验证登录态…');
    try {
      var r = await api('POST', '/login/verify', ck ? { cookie: ck } : {});
      var d = (r && r.data) || {};
      if (d.valid) {
        msg('✅ 登录态有效：' + ((d.user && d.user.nickname) || (d.user && d.user.uid) || '已登录'), 'ok');
      } else {
        msg('❌ 登录态无效：' + (d.error || '未知原因'), 'err');
      }
    } catch (e) { msg('验证失败: ' + e.message, 'err'); }
    finally { $('btnVerify').disabled = false; loadLogin(); }
  });

  $('btnLogout').addEventListener('click', async function () {
    try { await api('POST', '/logout', {}); msg('已退出登录'); loadLogin(); }
    catch (e) { msg('退出失败: ' + e.message, 'err'); }
  });

  // ---------- 扫码登录 ----------
  var qrId = '', qrTimer = null, qrTries = 0;

  function qrStop() { if (qrTimer) { clearInterval(qrTimer); qrTimer = null; } }
  function qrSetState(html) { $('qrState').innerHTML = html || ''; }
  function qrMask(show, text) {
    var m = $('qrMask');
    if (show) { $('qrMaskTxt').textContent = text || '二维码已过期'; m.style.display = 'flex'; }
    else { m.style.display = 'none'; }
  }

  async function qrStart() {
    qrStop();
    qrId = '';
    qrTries = 0;
    qrMask(false);
    $('qrImg').style.display = 'none';
    $('qrPlaceholder').style.display = '';
    $('qrPlaceholder').innerHTML = '正在生成<br>二维码…';
    $('btnQr').disabled = true;
    qrSetState('<span class="muted">正在向喜马拉雅申请二维码…</span>');
    try {
      var r = await api('GET', '/qr/new');
      if (r && r.success === false) throw new Error(r.error || '生成失败');
      var d = (r && r.data) || {};
      if (!d.qrId || !d.image) throw new Error(d.imgError || '没有拿到二维码图片');
      qrId = d.qrId;
      $('qrImg').src = d.image;
      $('qrImg').style.display = '';
      $('qrPlaceholder').style.display = 'none';
      $('btnQr').textContent = '换一张';
      qrSetState('<span class="muted">等待扫码…（约 4 分钟内有效）</span>');
      qrTimer = setInterval(qrPoll, 2000);
    } catch (e) {
      $('qrPlaceholder').innerHTML = '生成失败';
      qrSetState('<span class="err">' + esc(e.message) + '</span>');
    } finally { $('btnQr').disabled = false; }
  }

  async function qrPoll() {
    if (!qrId) { qrStop(); return; }
    qrTries += 1;
    if (qrTries > 150) { qrStop(); qrMask(true); return; }
    try {
      var r = await api('GET', '/qr/check?qrId=' + encodeURIComponent(qrId));
      if (r && r.success === false) {
        qrSetState('<span class="err">检查失败：' + esc(r.error) + '</span>');
        return;
      }
      var d = (r && r.data) || {};
      if (d.state === 'ok') {
        qrStop();
        qrId = '';
        $('btnQr').textContent = '重新扫码';
        if (d.valid === false) {
          qrSetState('<span class="err">已拿到登录凭据，但验证未通过：' + esc(d.error || '') + '</span>');
        } else {
          qrSetState('<span class="ok">✅ 登录成功' + (d.user && d.user.nickname ? '：' + esc(d.user.nickname) : '') + '</span>');
          // msg() 走 textContent，不能再转义，否则昵称里的 & 会显示成 &amp;
          msg('✅ 扫码登录成功' + (d.user && d.user.nickname ? '：' + d.user.nickname : ''), 'ok');
        }
        loadLogin();
        loadMySubs(true);
      } else if (d.state === 'scanned') {
        qrSetState('<span style="color:#e6a23c;">已扫码，请在手机上点「确认登录」</span>');
      } else if (d.state === 'expired') {
        qrStop();
        qrMask(true, '二维码已过期');
        qrSetState('<span class="muted">二维码已过期，点「刷新二维码」重新获取</span>');
      } else if (d.state === 'error') {
        qrStop();
        qrSetState('<span class="err">状态查询异常（接口可能变了）：' + esc(String(d.raw || '').replace(/<[^>]+>/g, ' ').slice(0, 100)) + '</span>');
      }
    } catch (e) { /* 单次失败继续轮询 */ }
  }

  $('btnQr').addEventListener('click', qrStart);
  $('btnQrRefresh').addEventListener('click', qrStart);

  // ---------- 播放器（续播 / 连播 / 倍速 / 睡眠定时） ----------
  var queue = [];        // [{trackId, index, title, albumId, albumName}]
  var qi = -1;
  // v0.19.2：队列来源页。跨页连播要用「队列拉到哪一页」，不能读详情页当前翻到哪一页
  var queueMeta = { albumId: '', page: 1, hasMore: true };
  var pendingSeek = null;
  var RATE_KEY = 'xm_rate';
  function posKey(id) { return 'xm_pos_' + id; }
  function lastKey(aid) { return 'xm_last_' + aid; }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = (h && m < 10 ? '0' : '') + m;
    return (h ? h + ':' : '') + mm + ':' + (s < 10 ? '0' : '') + s;
  }

  function getPos(trackId) {
    try { return JSON.parse(sGet(posKey(trackId)) || 'null'); } catch (e) { return null; }
  }

  var curPlayingId = '';  // 已成功加载音频的集，避免切集瞬间把旧进度写到新集

  // v0.21.1：详情列表里标出「正在播」的集（轻量 toggle，不重绘列表、不动滚动位置）
  function markPlayingRow() {
    var box = $('dTracks');
    if (!box || !box.children) return;
    Array.prototype.forEach.call(box.children, function (el) {
      if (!el.classList || !el.classList.contains('trk')) return;
      el.classList.toggle('on', !!curPlayingId && el.getAttribute('data-tid') === String(curPlayingId));
    });
  }

  function savePos(trackId, time, dur) {
    if (!trackId || !dur || dur < 30) return;
    if (!curPlayingId || String(curPlayingId) !== String(trackId)) return;
    if (!(time > 3)) return;
    var o = { t: Math.round(time), d: Math.round(dur), at: Date.now() };
    sSet(posKey(trackId), JSON.stringify(o));
    var c = queue[qi];
    if (c && c.albumId) {
      sSet(lastKey(c.albumId), JSON.stringify({
        trackId: trackId, index: c.index, title: c.title, t: o.t, d: o.d, at: o.at
      }));
      pushRecent({
        albumId: c.albumId,
        albumName: c.albumName || '',
        cover: c.cover || '',
        trackId: trackId,
        index: c.index,
        title: c.title,
        t: o.t, d: o.d, at: o.at,
        finished: posDone(o)
      });
      // 跨设备：攒一条待上传的进度，8 秒合并上报一次
      queueProg({
        trackId: trackId, albumId: c.albumId, albumName: c.albumName || '',
        title: c.title, index: c.index, cover: c.cover || '',
        t: o.t, d: o.d, at: o.at, finished: posDone(o),
        listened: takeListened()
      });
    }
  }

  // ---------- 跨设备进度（存 NAS 端） ----------
  var progSyncEnabled = sGet('xm_prog_sync') !== '0';
  var progQueue = [], progTimer = null;

  // 实际收听时长：播放中每走 1 秒计 1 秒，切集/暂停时结算到待上报的 listened 字段
  var LISTEN_KEY = 'xm_listened_pending';
  // v0.19.4：LISTEN_KEY 原来只写不读 —— 每 60 秒辛苦落的盘，刷新页面就丢了，
  // 而它存在的意义正是「关页少丢一点」。开机接上没上报的秒数。
  var listenedAcc = Number(sGet(LISTEN_KEY)) || 0;
  var lastTickAt = 0;

  function takeListened() {
    var n = Math.round(listenedAcc);
    listenedAcc = 0;
    sSet(LISTEN_KEY, '0');
    return n > 0 ? n : 0;
  }

  $('audio').addEventListener('playing', function () { lastTickAt = Date.now(); });

  // v0.22.4：音频断流/地址过期自动重连一次。喜马拉雅 CDN 地址有有效期，
  // 以前地址一失效播放就静默停住，得手动再点一集。
  var mediaErrN = 0;
  $('audio').addEventListener('error', async function () {
    var t = queue[qi];
    if (!t) return;
    if (mediaErrN >= 1) { msg('音频加载失败，请稍后重试或换一集', 'err'); return; }
    mediaErrN++;
    var pos = this.currentTime || 0;
    var label = (t.index ? t.index + '. ' : '') + t.title;
    $('pTitle').textContent = '重连中… ' + label;
    try {
      // v0.22.5：必须 fresh=1 —— 服务端地址缓存 20 分钟，用旧地址会再失败一次
      var rr = await api('GET', '/track/' + t.trackId + '/url?fresh=1');
      if (!rr || rr.success === false || !rr.data || !rr.data.url) throw new Error((rr && rr.error) || '取不到地址');
      memoUrl(t.trackId, { url: rr.data.url, local: !!rr.data.local, localPath: rr.data.localPath || '' });
      this.src = rr.data.url;
      if (pos > 1) this.currentTime = Math.max(0, pos - 2);
      this.play().catch(function () { /* 需要用户手势 */ });
      msg('网络抖动，已自动重连', 'ok');
    } catch (e) {
      $('pTitle').textContent = '❌ ' + label;
      msg('重连失败：' + e.message, 'err');
    }
  });
  $('audio').addEventListener('playing', function () { mediaErrN = 0; });
  // v0.18.7：切集/换源时清掉计时基准，否则新旧源的间隔会被算进收听时长
  $('audio').addEventListener('loadedmetadata', function () { lastTickAt = 0; });
  $('audio').addEventListener('timeupdate', function () {
    if (this.paused) return;
    var now = Date.now();
    if (lastTickAt && now - lastTickAt > 0 && now - lastTickAt < 3000) {
      // v0.18.7：按音频实际推进时长计（1.5 倍速听 60 秒音频只算 60 秒，不是 90 秒）
      var rate = this.playbackRate || 1;
      listenedAcc += (now - lastTickAt) / 1000 * (rate > 0 ? rate : 1);
    }
    lastTickAt = now;
    // 每积累 60 秒落一次本地，防止页面被关掉丢太多
    if (listenedAcc >= 60) {
      sSet(LISTEN_KEY, String(Math.round(listenedAcc)));
    }
  });
  $('audio').addEventListener('pause', function () { lastTickAt = 0; });
  $('audio').addEventListener('ended', function () { lastTickAt = 0; });

  function queueProg(item) {
    if (!progSyncEnabled || !item || !item.trackId) return;
    // v0.19.2：同一集的待上报项要**累加收听秒数**，不能直接替换。
    // savePos 每 5 秒上报一次、flushProg 每 8 秒 flush，一个窗口里必然有一次替换，
    // 被替换掉的那段秒数就永久丢了（10 秒只记到 5 秒，收听报告稳定少算）。
    var old = null;
    progQueue = progQueue.filter(function (x) {
      if (String(x.trackId) === String(item.trackId)) { old = x; return false; }
      return true;
    });
    if (old) item.listened = (Number(old.listened) || 0) + (Number(item.listened) || 0);
    progQueue.push(item);
    if (progQueue.length > 40) progQueue = progQueue.slice(-40);
    if (progTimer) return;
    progTimer = setTimeout(function () { flushProg(); }, 8000);
  }

  // 收尾时把没上报的收听时长补进队列（防止暂停后丢掉最后一段）
  function flushListened() {
    var n = takeListened();
    if (n < 5 || qi < 0 || !queue[qi]) return;
    var c = queue[qi];
    var pos = getPos(c.trackId) || { t: Math.round($('audio').currentTime || 0), d: Math.round($('audio').duration || 0) };
    queueProg({
      trackId: c.trackId, albumId: c.albumId, albumName: c.albumName || '',
      title: c.title, index: c.index, cover: c.cover || '',
      t: pos.t || 0, d: pos.d || 0, at: Date.now(), finished: false, listened: n
    });
  }

  async function flushProg() {
    if (progTimer) { clearTimeout(progTimer); progTimer = null; }
    if (!progQueue.length) return;
    var items = progQueue.slice(0, 50);
    try {
      await api('POST', '/progress', { items: items });
      // v0.19.2：发送成功后才从队列移除；原来先清空再发，请求一失败这批进度就没了
      progQueue = progQueue.filter(function (x) { return items.indexOf(x) < 0; });
    } catch (e) { /* 离线时保留在队列里，下次 queueProg 再冲 */ }
  }

  // 打开专辑时把服务端进度合并进本机（服务端更新则覆盖本机）
  async function pullAlbumProgress(albumId) {
    if (!progSyncEnabled || !albumId) return;
    try {
      var r = await api('GET', '/progress?albumId=' + encodeURIComponent(albumId));
      var d = (r && r.data) || {};
      var list = d.tracks || [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var loc = getPos(p.trackId);
        if (!loc || (Number(p.at) || 0) > (Number(loc.at) || 0)) {
          sSet(posKey(p.trackId), JSON.stringify({ t: p.t, d: p.d, at: p.at }));
        }
      }
      if (d.album && d.album.trackId) {
        var ll = null;
        try { ll = JSON.parse(sGet(lastKey(albumId)) || 'null'); } catch (e) { ll = null; }
        if (!ll || (Number(d.album.at) || 0) > (Number(ll.at) || 0)) {
          sSet(lastKey(albumId), JSON.stringify({
            trackId: d.album.trackId, index: d.album.index, title: d.album.title,
            t: d.album.t, d: d.album.d, at: d.album.at
          }));
        }
      }
    } catch (e) { /* */ }
  }

  // 把服务端「最近收听」合并进本机列表
  async function pullRecent() {
    if (!progSyncEnabled) return;
    try {
      var r = await api('GET', '/progress/recent?limit=40');
      var list = (r && r.data) || [];
      if (!list.length) return;
      var local = readRecent();
      var map = {};
      local.forEach(function (x) { map[String(x.albumId)] = x; });
      list.forEach(function (x) {
        var k = String(x.albumId || '');
        if (!k) return;
        if (!map[k] || (Number(x.at) || 0) > (Number(map[k].at) || 0)) map[k] = x;
      });
      var out = Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); })
        .slice(0, 40);
      writeRecent(out);
      renderRecent();
    } catch (e) { /* */ }
  }

  // ---------- 最近收听（跨专辑聚合，存在本机） ----------
  var RECENT_KEY = 'xm_recent';
  var RECENT_MAX = 40;

  function readRecent() {
    try {
      var a = JSON.parse(sGet(RECENT_KEY) || '[]');
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }

  function writeRecent(list) {
    sSet(RECENT_KEY, JSON.stringify((list || []).slice(0, RECENT_MAX)));
  }

  function pushRecent(e) {
    if (!e || !e.albumId) return;
    var list = readRecent().filter(function (x) { return String(x.albumId) !== String(e.albumId); });
    list.unshift(e);
    writeRecent(list);
  }

  function agoText(at) {
    if (!at) return '';
    var d = Date.now() - at;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  // 「2026-05-12」→「2026年5月12日（5 个月前）」
  function dateHuman(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || ''));
    if (!m) return '';
    var y = Number(m[1]), mo = Number(m[2]), dd = Number(m[3]);
    var then = new Date(y, mo - 1, dd).getTime();
    var days = Math.floor((Date.now() - then) / 86400000);
    var rel = '';
    if (days < 0) rel = '';
    else if (days === 0) rel = '今天';
    else if (days === 1) rel = '昨天';
    else if (days < 30) rel = days + ' 天前';
    else if (days < 365) rel = Math.floor(days / 30) + ' 个月前';
    else rel = Math.floor(days / 365) + ' 年前';
    var label = y + '年' + mo + '月' + dd + '日';
    return rel ? label + '（' + rel + '）' : label;
  }

  // 详情页徽章：付费/已购/连载状态一眼可见
  function renderAlbumBadges(d) {
    var el = $('dBadges');
    if (!el) return;
    var out = [];
    if (d.isPaid) {
      if (d.hasBuy) out.push('<span class="dbadge bought" title="该账号已购买本专辑">已购买</span>');
      else out.push('<span class="dbadge pay" title="' + escHtml(d.payTip || '付费专辑') + '">🔒 ' +
        escHtml(d.payLabel || '付费专辑') + '</span>');
    } else if (d.payLabel) {
      out.push('<span class="dbadge serial">' + escHtml(d.payLabel) + '</span>');
    }
    var fin = Number(d.isFinished) || 0;
    if (fin === 0) out.push('<span class="dbadge serial" title="仍在更新，可订阅跟进">● 连载中</span>');
    else out.push('<span class="dbadge done">✓ 已完结</span>');
    el.innerHTML = out.join('');
  }

  // 详情页日期行：更新日期单独一行，超过 1 年没更新标红提示
  function renderAlbumDates(d) {
    var el = $('dDate');
    if (!el) return;
    var parts = [];
    var upd = String(d.updateDate || '').split(' ')[0];
    if (upd) {
      var h = dateHuman(upd);
      var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(upd);
      var days = m ? Math.floor((Date.now() - new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()) / 86400000) : -1;
      var cls = days > 365 ? ' class="stale"' : '';
      parts.push('🗓 更新于 <b' + cls + '>' + escHtml(h || upd) + '</b>' + (days > 365 ? ' 久未更新' : ''));
    }
    var cre = String(d.createDate || '').split(' ')[0];
    if (cre) parts.push('发布于 ' + escHtml(dateHuman(cre) || cre));
    el.innerHTML = parts.join('　·　');
  }

  function renderRecent() {
    var el = $('recentList');
    if (!el) return;
    var list = readRecent();
    el.innerHTML = '';
    if (!list.length) {
      $('recentStat').textContent = '还没有收听记录。在上面搜一张专辑点开，随便听一集就会出现在这里。';
      return;
    }
    var unfinished = list.filter(function (r) { return !r.finished; }).length;
    $('recentStat').textContent = '共 ' + list.length + ' 张专辑有收听记录' +
      (unfinished ? '，其中 ' + unfinished + ' 张没听完' : '，全部听完了');

    list.forEach(function (r) {
      var line = document.createElement('div');
      line.className = 'line';
      var img = document.createElement('img');
      img.src = r.cover || '';
      img.alt = '';
      var body = document.createElement('div');
      body.className = 'body';
      var n = document.createElement('div');
      n.className = 'n';
      n.textContent = r.albumName || ('专辑 ' + r.albumId);
      n.style.cursor = 'pointer';
      n.addEventListener('click', function () { openAlbumFromRecent(r.albumId); });
      var s = document.createElement('div');
      s.className = 's';
      var bits = ['第 ' + (r.index || '?') + ' 集'];
      if (r.finished) bits.push('✓ 已听完');
      else bits.push('听到 ' + fmtTime(r.t || 0) + (r.d ? ' / ' + fmtTime(r.d) : ''));
      if (r.at) bits.push(agoText(r.at));
      s.textContent = bits.join(' · ');
      body.appendChild(n); body.appendChild(s);

      var ops = document.createElement('div');
      ops.className = 'ops';
      var bOpen = document.createElement('button');
      bOpen.className = 'small plain';
      bOpen.textContent = '专辑';
      bOpen.addEventListener('click', function () { openAlbumFromRecent(r.albumId); });
      var bPlay = document.createElement('button');
      bPlay.className = 'small';
      bPlay.textContent = '▶ 继续听';
      bPlay.addEventListener('click', function () { resumeRecent(r); });
      // v0.20.0：搜索与收听融合——从收听记录直接发起「搜这张专辑的单集」
      var bFind = document.createElement('button');
      bFind.className = 'small plain';
      bFind.textContent = '🔍 集';
      bFind.title = '用这张专辑的名字去搜单集（想听某一集时用）';
      bFind.addEventListener('click', function () {
        var nm = r.albumName || '';
        if (!nm) { msg('这条记录没存专辑名，先去专辑页搜吧', 'warn'); return; }
        setSearchMode('track');
        $('kw').value = nm;
        doSearch(nm);
      });
      var bDel = document.createElement('button');
      bDel.className = 'small plain';
      bDel.textContent = '✕';
      bDel.title = '从最近收听里移除';
      bDel.addEventListener('click', function () {
        writeRecent(readRecent().filter(function (x) { return String(x.albumId) !== String(r.albumId); }));
        renderRecent();
      });
      ops.appendChild(bPlay); ops.appendChild(bFind); ops.appendChild(bOpen); ops.appendChild(bDel);
      line.appendChild(img); line.appendChild(body); line.appendChild(ops);
      el.appendChild(line);
    });
  }

  function openAlbumFromRecent(albumId) {
    document.querySelector('.tab[data-tab="search"]').click();
    $('searchCard').classList.add('hide');
    openDetail(albumId, true);
  }

  function resumeRecent(r) {
    if (r.finished) sSet(posKey(r.trackId), '');
    playQueue([{ trackId: r.trackId, index: r.index, title: r.title }], 0,
      { id: r.albumId, name: r.albumName, cover: r.cover });
  }

  $('btnRecentRefresh').addEventListener('click', renderRecent);
  $('btnRecentClear').addEventListener('click', function () {
    if (!confirm('清空最近收听记录？（各集的播放进度不受影响）')) return;
    writeRecent([]);
    renderRecent();
  });

  function updateProg() {
    var a = $('audio');
    var d = a.duration || 0, t = a.currentTime || 0;
    if (!d) { $('pProg').textContent = '—'; return; }
    $('pProg').textContent = fmtTime(t) + ' / ' + fmtTime(d) + ' · 剩 ' + fmtTime(d - t);
  }

  // 正序 / 倒序：倒序时按集数从大到小听（新书先听最新一集）
  var ORDER_KEY = 'xm_order';
  var playOrder = sGet(ORDER_KEY) === 'desc' ? 'desc' : 'asc';

  function orderIcon() { return playOrder === 'desc' ? '↓ 倒序' : '↑ 正序'; }

  function sortByOrder(list) {
    var arr = (list || []).slice();
    if (playOrder === 'desc') {
      arr.sort(function (a, b) { return (Number(b.index) || 0) - (Number(a.index) || 0); });
    } else {
      arr.sort(function (a, b) { return (Number(a.index) || 0) - (Number(b.index) || 0); });
    }
    return arr;
  }

  function syncOrderBtn() {
    var txt = orderIcon();
    var t1 = playOrder === 'desc' ? '按集数升序（旧→新）排列' : '按集数降序（新→旧）排列';
    ['btnOrder', 'pOrder'].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      b.textContent = txt;
      b.title = t1;
    });
  }

  function setOrder(v, silent) {
    playOrder = v === 'desc' ? 'desc' : 'asc';
    sSet(ORDER_KEY, playOrder);
    syncOrderBtn();
    // 队列同步重排，正在播的那集保持不动
    if (queue.length > 1) {
      var curId = qi >= 0 && queue[qi] ? String(queue[qi].trackId) : '';
      queue = sortByOrder(queue);
      if (curId) {
        var ni = indexOfTrack(queue, curId);
        if (ni >= 0) qi = ni;
      }
      updateProg();
    }
    if (curTracks.length) renderTracks(sortByOrder(curTracks));
    syncOrderBtn();
    if (typeof syncPageBtns === 'function') syncPageBtns();
    if (!silent) {
      // v0.19.0：手动切顺序只翻面、不搬页（停在第几页就翻第几页的面）
      if (cur.id && !$('detailCard').classList.contains('hide')) {
        msg(playOrder === 'desc'
          ? '第 ' + cur.page + ' 页已切为倒序（本页最新集在前）'
          : '第 ' + cur.page + ' 页已切为正序（本页最早集在前）');
        // 当前页有数据就只重排，别重新请求；没有才去补取
        if (!curTracks.length) gotoPage(cur.page);
      } else {
        renderResume();
        msg(playOrder === 'desc' ? '已切换为倒序（新集在前）' : '已切换为正序（旧集在前）');
      }
      return;
    }
    renderResume();
  }

  // v0.19.0：只在**刚打开专辑**时调用——倒序默认停在最后一页（最新集在前），正序停在第 1 页。
  // 用户手动切顺序走 setOrder，那里只翻面不搬页，所以这里带 toLast 才有意义。
  async function jumpToOrderPage(toLast) {
    try {
      await ensureLastPage();
      var p = toLast ? (cur.lastPage || 1) : 1;
      if (p && p !== cur.page) {
        await gotoPage(p);
        msg(playOrder === 'desc' ? '倒序：已跳到第 ' + p + ' 页（最新集在前）' : '正序：已回到第 1 页');
      } else {
        msg(playOrder === 'desc' ? '第 ' + cur.page + ' 页已切为倒序（本页最新集在前）' : '第 ' + cur.page + ' 页已切为正序（本页最早集在前）');
        syncPageBtns();
      }
    } catch (e) {
      msg(playOrder === 'desc' ? '已切换为倒序（新集在前）' : '已切换为正序（旧集在前）');
      syncPageBtns();
    }
    syncOrderBtn();
    renderResume();
  }

  // v0.19.2：请求序号。连点两集时网络返回顺序不定，谁后返回谁抢到 src，
  // 但 qi 已经被最后一次点击改掉 → 音频和 qi 错位，进度会写进别的集。
  var playSeq = 0;

  // v0.22.5：地址本（内存）——命中就直接设 src，跳过 150~400ms 的取流请求。
  // 配合服务端 20 分钟地址缓存 + 列表渲染后预取，目标是「点下去就出声」。
  var urlMemo = {}, urlFetching = {}, urlBad = {};
  // v0.23.4：限流闸 —— 服务端报 ratelimit 后本地也停 20 秒预取，
  // 避免「服务端刚冷却，前端又一口气打 3 个预取、再次触发限流」的来回拉锯
  var rlUntil = 0;
  function rlLeft() { var ms = rlUntil - Date.now(); return ms > 0 ? ms : 0; }
  function memoUrl(id, info) {
    if (id && info && info.url) urlMemo[String(id)] = info;
  }
  function prefetchTrack(id, hot) {
    id = String(id || '');
    if (rlLeft() > 0) return;                    // v0.23.4：限流冷却期内不预取
    if (!id || urlMemo[id] || urlFetching[id] || urlBad[id]) {
      if (hot && urlMemo[id] && urlMemo[id].url) warmAudio(urlMemo[id].url);
      return;
    }
    if (queue.length > 60) urlMemo = {};   // 地址本别无限长
    urlFetching[id] = 1;
    api('GET', '/track/' + id + '/url').then(function (r) {
      if (r && r.data && r.data.url) {
        memoUrl(id, { url: r.data.url, local: !!r.data.local, localPath: r.data.localPath || '' });
        if (hot) warmAudio(r.data.url);   // 最可能播的那一集，连首包一起预热
      } else if (r && r.success === false && (r.code === 'paid' || r.code === 'no_url')) {
        urlBad[id] = r.code;   // v0.23.3：付费/下架的集记住，列表渲染不再反复请求
      } else if (r && r.success === false && r.code === 'ratelimit') {
        rlUntil = Date.now() + 20000;   // v0.23.4：预取撞上限流，本地也停 20 秒
      }
    }).catch(function () { /* 预取失败不打扰用户 */ }).then(function () { delete urlFetching[id]; });
  }
  // 用隐藏的 audio 预缓冲首包：浏览器把开头几十 KB 拉下来，点下去立刻有声音
  var preBuf = $('preBuf');
  function warmAudio(url) {
    if (!preBuf || !url) return;
    if (preBuf.getAttribute('src') === url) return;
    try { preBuf.src = url; preBuf.load(); } catch (e) { /* 预缓冲失败无所谓 */ }
  }
  // 手指/鼠标按下就取地址：比 click 早约 100ms，弱网下差别很明显
  document.addEventListener('pointerdown', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-tid]') : null;
    if (el) prefetchTrack(el.getAttribute('data-tid'));
  }, true);

  async function playAt(idx, retry, seekT) {
    if (idx < 0 || idx >= queue.length) return;
    var my = ++playSeq;
    qi = idx;
    curPlayingId = '';
    markPlayingRow();
    var t = queue[idx];
    var label = (t.index ? t.index + '. ' : '') + t.title;
    var alb = [];
    if (t.albumName) alb.push(t.albumName);
    if (queue.length > 1) alb.push('第 ' + (idx + 1) + ' / ' + queue.length + ' 集');
    else if (t.index) alb.push('第 ' + t.index + ' 集');
    if (playOrder === 'desc') alb.push('倒序');
    $('pAlbum').textContent = alb.join(' · ');
    $('pAlbum').dataset.albumId = t.albumId || '';
    $('player').classList.add('show');
    if (document.body) document.body.classList.add('has-player');
    $('pTitle').textContent = '载入中… ' + label;
    try {
      // v0.22.5：地址本命中就直接用，不再等网络（预取一般在手指按下时就已回来）
      var memo = urlMemo[String(t.trackId)];
      var r = (memo && memo.url) ? { success: true, data: memo } : await api('GET', '/track/' + t.trackId + '/url');
      // v0.19.4：队列被清空（关播放器 / 清空队列）时也要作废，否则音频会在后台自己响起来，
      // 而且 curPlayingId 永远不会置上 —— 看不见、暂停不了、进度也不落盘。
      if (my !== playSeq || !queue[idx]) return;
      if (!r || r.success === false) {
        // v0.23.3：付费/下架是确定状态，重试没有意义，直接报错
        var knownBad = r && (r.code === 'paid' || r.code === 'no_url');
        // v0.23.4：限流是「等一会儿就好」，重试只会更糟 → 不重试，直接给友好提示
        if (r && r.code === 'ratelimit') {
          rlUntil = Date.now() + 20000;
          $('pTitle').textContent = '⏳ 请求过于频繁，约 20 秒后自动恢复，请稍后再点';
          return;
        }
        // 拿不到地址：自动再试一次（接口抖动很常见），还不行才报错
        if (!retry && !knownBad) {
          $('pTitle').textContent = '重试中… ' + label;
          await new Promise(function (res) { setTimeout(res, 800); });
          if (my !== playSeq) return;
          return playAt(idx, true, seekT);
        }
        $('pTitle').textContent = '❌ ' + ((r && r.error) || '取不到播放地址');
        reportUiError('播放地址获取失败 ' + t.trackId + '：' + ((r && r.error) || ''));
        return;
      }
      var a = $('audio');
      skipDone = {};
      a.src = r.data.url;
      memoUrl(t.trackId, { url: r.data.url, local: !!r.data.local, localPath: r.data.localPath || '' });
      // v0.22.5：顺手把队列后面两集的地址备好，连播几乎零等待
      if (queue[idx + 1]) prefetchTrack(queue[idx + 1].trackId, true);   // 下一集连首包一起预热
      if (queue[idx + 2]) prefetchTrack(queue[idx + 2].trackId);
      $('pTitle').textContent = label + (r.data.local ? ' · 📁 本地' : '');
      a.playbackRate = Number(sGet(RATE_KEY) || 1) || 1;
      // v0.19.2：书签/时间线点「从这里听」时必须用指定的时间点。
      // 原来无条件改成 getPos()，把调用方刚设好的 pendingSeek 冲掉，书签跳转从来没生效过。
      pendingSeek = (seekT != null) ? { t: Number(seekT) || 0 } : getPos(t.trackId);
      a.play().catch(function () { /* 浏览器要求先有用户交互 */ });
      mediaSync();
      driveSync();
      if (queue.length > 1) $('pProg').textContent = '第 ' + (idx + 1) + ' / ' + queue.length + ' 集';
      if ($('pQueue')) $('pQueue').textContent = '☰ ' + (idx + 1) + '/' + queue.length;
      if (typeof renderQueue === 'function' && qPanelOpen()) renderQueue();
    } catch (e) {
      if (my !== playSeq) return;
      if (!retry) { return playAt(idx, true, seekT); }
      $('pTitle').textContent = '试听失败: ' + e.message;
      reportUiError('播放失败 ' + t.trackId + '：' + e.message);
    }
  }

  function playQueue(list, idx, album, seekT) {
    queue = sortByOrder((list || []).map(function (t) {
      return {
        trackId: t.trackId, index: t.index, title: t.title,
        albumId: (album && album.id) || t.albumId || '',
        albumName: (album && album.name) || t.albumName || '',
        cover: (album && album.cover) || t.cover || ''
      };
    }));
    if (idx < 0) idx = 0;
    // v0.19.2：队列自己记住来源页，跨页连播不能看详情页当前翻到哪一页
    queueMeta = { albumId: (album && album.id) || '', page: (album && album.page) || cur.page || 1, hasMore: true };
    playAt(idx, false, seekT);
  }

  // ---------- 锁屏 / 通知栏 / 耳机线控 ----------
  // 通勤和睡前听书时页面基本在后台，没有这套控制就只能掏出手机解锁再点。
  // 只在宿主支持时挂，不支持就静默跳过。
  var msSupported = !!(typeof navigator !== 'undefined' && navigator.mediaSession);
  function mediaSync(meta) {
    if (!msSupported) return;
    try {
      var a = $('audio');
      var t = (qi >= 0 && queue[qi]) ? queue[qi] : null;
      var title = (t && t.title) || ($('pTitle') && $('pTitle').textContent) || '喜马拉雅';
      var album = (t && t.albumName) || '';
      var artwork = [];
      if (t && t.cover) artwork = [{ src: t.cover, sizes: '512x512', type: 'image/jpeg' }];
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: String(title).slice(0, 120),
        artist: album || '喜马拉雅',
        album: album || '',
        artwork: artwork
      });
      navigator.mediaSession.playbackState = a.paused ? 'paused' : 'playing';
      if (Number(a.duration) > 0 && navigator.mediaSession.setPositionState) {
        var d = Number(a.duration), p = Number(a.currentTime) || 0;
        if (p > d) p = d;
        navigator.mediaSession.setPositionState({ duration: d, position: p, playbackRate: a.playbackRate || 1 });
      }
    } catch (e) { /* 某些内核不支持全部字段，忽略 */ }
  }

  function mediaHandlers() {
    if (!msSupported) return;
    function set(action, fn) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* 不支持的动作会抛 */ }
    }
    var a0 = function () { return $('audio'); };
    set('play', function () { a0().play().catch(function () { /* */ }); });
    set('pause', function () { a0().pause(); });
    set('seekbackward', function (ev) { var a = a0(); a.currentTime = Math.max(0, a.currentTime - ((ev && ev.seekOffset) || 15)); });
    set('seekforward', function (ev) { var a = a0(); a.currentTime = Math.min(Number(a.duration) || 1e9, a.currentTime + ((ev && ev.seekOffset) || 30)); });
    set('seekto', function (ev) {
      if (ev && typeof ev.seekTime === 'number') {
        var a = a0(); a.currentTime = ev.seekTime;
        if (ev.fastSeek && a.fastSeek) { try { a.fastSeek(ev.seekTime); } catch (e) { /* */ } }
      }
    });
    set('previoustrack', function () { var a = a0(); if (a.currentTime > 3) { a.currentTime = 0; } else { jumpQ(-1); } });
    set('nexttrack', function () { jumpQ(1); });
    set('stop', function () { var a = a0(); a.pause(); a.currentTime = 0; });
  }
  mediaHandlers();

  // 切上一集 / 下一集（不越界、不循环），供锁屏与车载按钮复用
  function jumpQ(delta) {
    if (!queue.length) return;
    var n = qi + delta;
    if (n < 0) { msg('已经是第一集'); return; }
    if (n >= queue.length) { msg('已经是最后一集'); return; }
    playAt(n);
  }

  // ---------- 车载模式 ----------
  // 开车时看不了小字，所以只留三件事：现在播什么、播到哪、三个大按钮。
  // 另外整屏可左右滑切集、双击中间暂停，手不用离开方向盘太久。
  var DRIVE_KEY = 'xm_drive';
  var driveOpen = false;

  function driveSync() {
    if (!driveOpen) return;
    var a = $('audio');
    var t = (qi >= 0 && queue[qi]) ? queue[qi] : null;
    if ($('driveCover')) {
      if (t && t.cover) { $('driveCover').src = t.cover; $('driveCover').style.visibility = ''; }
      else { $('driveCover').style.visibility = 'hidden'; }
    }
    $('driveTitle').textContent = t ? ((t.index ? t.index + '. ' : '') + t.title) : '还没有在播的内容';
    var meta = [];
    if (t && t.albumName) meta.push(t.albumName);
    if (queue.length > 1 && qi >= 0) meta.push('第 ' + (qi + 1) + ' / ' + queue.length + ' 集');
    $('driveMeta').textContent = meta.join(' · ');
    $('drivePlay').textContent = a.paused ? '▶' : '⏸';
    var d = Number(a.duration) || 0, p = Number(a.currentTime) || 0;
    $('driveFill').style.width = d ? (Math.min(100, (p / d) * 100)) + '%' : '0%';
    $('driveTime').textContent = fmtTime(p) + ' / ' + (d ? fmtTime(d) : '0:00');
  }

  function driveShow(on) {
    driveOpen = !!on;
    $('drive').classList.toggle('show', driveOpen);
    if (document.body) document.body.classList.toggle('drive-mode', driveOpen);
    sSet(DRIVE_KEY, driveOpen ? '1' : '0');
    if (driveOpen) { driveSync(); mediaHandlers(); }
  }

  if ($('pDrive')) $('pDrive').addEventListener('click', function () { driveShow(true); });

  if ($('driveExit')) $('driveExit').addEventListener('click', function () { driveShow(false); });
  if ($('drivePlay')) $('drivePlay').addEventListener('click', function () {
    var a = $('audio');
    if (a.paused) a.play().catch(function () { /* */ }); else a.pause();
  });
  if ($('drivePrev')) $('drivePrev').addEventListener('click', function () { jumpQ(-1); });
  if ($('driveNext')) $('driveNext').addEventListener('click', function () { jumpQ(1); });

  // 滑块：横滑超过 60px 判为切集，双击中间区域暂停
  var dTouch = { x: 0, y: 0, t: 0, moved: false };
  if ($('drive')) {
    $('drive').addEventListener('touchstart', function (ev) {
      var p0 = (ev.touches && ev.touches[0]) || {};
      dTouch = { x: p0.clientX || 0, y: p0.clientY || 0, t: Date.now(), moved: false };
    }, { passive: true });
    $('drive').addEventListener('touchend', function (ev) {
      var p0 = (ev.changedTouches && ev.changedTouches[0]) || {};
      var dx = (p0.clientX || 0) - dTouch.x;
      var dy = (p0.clientY || 0) - dTouch.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        dTouch.moved = true;
        jumpQ(dx < 0 ? 1 : -1);   // 左滑 = 下一集
      }
    }, { passive: true });
    $('drive').addEventListener('dblclick', function (ev) {
      if (dTouch.moved) { dTouch.moved = false; return; }
      if (ev && ev.target && ev.target.tagName === 'BUTTON') return;
      var a = $('audio');
      if (a.paused) a.play().catch(function () { /* */ }); else a.pause();
    });
  }

  $('audio').addEventListener('loadedmetadata', function () {    var a = this;
    if (pendingSeek && pendingSeek.t > 10 && pendingSeek.t < (a.duration || 1e9) - 15) {
      a.currentTime = pendingSeek.t;
      msg('⏱ 从 ' + fmtTime(pendingSeek.t) + ' 续播');
    } else {
      // 没有可续播的进度才跳片头（续播时位置由用户上次决定）
      applySkip(queue[qi] && queue[qi].trackId);
    }
    pendingSeek = null;
    if (qi >= 0 && queue[qi]) curPlayingId = queue[qi].trackId;
    markPlayingRow();
    updateProg();
    abRestore();
    if (fpOpen) syncFull(true);
  });

  var lastSaveAt = 0;
  var lastMediaAt = 0;
  $('audio').addEventListener('timeupdate', function () {
    updateProg();
    abCheck();
    if (fpOpen) syncFull(false);
    // 锁屏进度条：每 4 秒推一次即可，太频繁反而被内核节流
    if (Date.now() - lastMediaAt > 4000) { lastMediaAt = Date.now(); mediaSync(); driveSync(); }
    // 跳过片尾：剩不到 N 秒就当作播完，直接走 ended 的逻辑
    var a = this;
    if (skipCfg.tail > 0 && a.duration && !a.paused) {
      var tid = (qi >= 0 && queue[qi]) ? String(queue[qi].trackId) : '';
      if (tid && a.duration - a.currentTime <= skipCfg.tail && a.duration - a.currentTime > 0.4 && !skipDone['t' + tid]) {
        skipDone['t' + tid] = 1;
        a.currentTime = Math.max(0, a.duration - 0.2);
      }
    }
    var now = Date.now();
    if (now - lastSaveAt < 5000 || qi < 0) return;
    lastSaveAt = now;
    savePos(queue[qi].trackId, this.currentTime, this.duration);
  });

  // 暂停 / 播放器关闭时立刻把攒着的进度推给 NAS，不等防抖
  $('audio').addEventListener('pause', function () {
    if (qi >= 0) savePos(queue[qi].trackId, this.currentTime, this.duration);
    flushListened();
    flushProg();
    if (qPanelOpen()) renderQueue();
    if (fpOpen) syncFull(true);
    mediaSync();
    driveSync();
  });  $('audio').addEventListener('play', function () {
    if (qPanelOpen()) renderQueue();
    if (fpOpen) syncFull(true);
    mediaSync();
    driveSync();
    // 起播淡入：仅页面里第一次播放时淡入，同一队列内切集直接用记忆音量（否则每集开头都轻声）
    var a = this;
    if (fadeInDone) {
      try { a.volume = Math.max(0, Math.min(1, Number(sGet(VOL_KEY) === null ? 100 : Number(sGet(VOL_KEY))) / 100)); } catch (e) { /* */ }
      return;
    }
    fadeInDone = true;
    var target = Math.max(0, Math.min(1, Number(sGet(VOL_KEY) === null ? 100 : Number(sGet(VOL_KEY))) / 100));
    if (!isFinite(target)) target = 1;
    try {
      a.volume = 0;
      var t0 = Date.now();
      var tm = setInterval(function () {
        var k = Math.min(1, (Date.now() - t0) / 500);
        try { a.volume = target * k; } catch (e) { /* */ }
        if (k >= 1) clearInterval(tm);
      }, 50);
    } catch (e) { try { a.volume = target; } catch (e2) { /* */ } }
  });

  // 播到队列末尾时，先把当前页后面的集补齐，再翻下一页，长书可以一直听下去
  async function extendQueue() {
    var c = queue[qi];
    if (!c || !c.albumId) return false;
    // v0.19.4：不再要求「详情页开的正好是这张专辑」。从「收听」tab / 时间线播别的专辑的集时，
    // 原来直接 return false，自动连播彻底失效（只播 1 集就报「已播完本页共 1 集」）。
    var albumId = String(c.albumId);
    var my = playSeq;   // 记下发起时的播放序号：await 回来后用户可能已经点了别的集

    var seen = {};
    queue.forEach(function (x) { seen[String(x.trackId)] = 1; });
    var lastIdx = Number(c.index) || 0;
    // v0.19.2：用队列自己的页码。原来读 cur.page（详情页当前翻到哪页），
    // 边听边往后翻标题时，播完会直接跳到「下一页的下一页」，中间一整页被跳过。
    // v0.19.4：书签/最近收听/时间线这些单集入口没有 album.page，会退化成「详情页当前页」，
    // 而那一集可能在完全不同的页 → 跨页续播会倒着跳。先用集号反推真实页码。
    var page = 0;
    if (String(cur.id) === albumId && cur.outlinePages && cur.outlinePages.length && Number(c.index)) {
      page = pageOfIndex(Number(c.index)) || 0;
    }
    if (!page) page = Number(queueMeta.page) || (String(cur.id) === albumId ? cur.page : 1) || 1;
    var desc = playOrder === 'desc';

    try {
      // ① 当前页里排在后面的集还没进队列（例如从「最近收听」只带了一集过来）
      var r0 = await api('GET', '/album/' + albumId + '/tracks?page=' + page);
      if (my !== playSeq) return false;   // v0.19.4：用户已经切到别的集，别再往队列里塞东西
      if (r0 && r0.success !== false) {
        var list = (r0.data && r0.data.tracks) || [];
        var added = 0;
        list.forEach(function (t) {
          if (seen[String(t.trackId)]) return;
          var n = Number(t.index) || 0;
          if (desc ? n >= lastIdx : n <= lastIdx) return;
          queue.push({
            trackId: t.trackId, index: t.index, title: t.title,
            albumId: c.albumId, albumName: c.albumName, cover: c.cover
          });
          added += 1;
        });
        if (added) {
          if (desc) queue = sortByOrder(queue), qi = indexOfTrack(queue, c.trackId);
          msg('已接上本页' + (desc ? '前面 ' : '后面 ') + added + ' 集');
          return true;
        }
      }

      // ② 当前页听完了，翻下一页（倒序时翻上一页）
      if (desc ? page <= 1 : !queueMeta.hasMore) return false;
      var p = desc ? page - 1 : page + 1;
      var r = await api('GET', '/album/' + albumId + '/tracks?page=' + p);
      if (my !== playSeq) return false;   // v0.19.4：同上
      if (!r || r.success === false) return false;
      var more = (r.data && r.data.tracks) || [];
      if (!more.length) return false;
      var uiOnThisPage = (Number(cur.page) === p);   // 用户界面正好停在这一页才跟着刷新
      queueMeta.page = p;
      queueMeta.hasMore = !!r.data.hasMore;
      more.forEach(function (t) {
        queue.push({
          trackId: t.trackId, index: t.index, title: t.title,
          albumId: c.albumId, albumName: c.albumName, cover: c.cover
        });
      });
      if (desc) { queue = sortByOrder(queue); qi = indexOfTrack(queue, c.trackId); }
      // v0.19.2：只有界面本来就在这一页才重绘，否则会把用户正在看的那页顶掉
      if (uiOnThisPage && !$('detailCard').classList.contains('hide')) {
        cur.page = p;
        cur.hasMore = !!r.data.hasMore;
        renderTracks(more);
        // v0.19.0：别在这里手改按钮 disabled，统一交给 syncPageBtns 判（它知道总页数）
        syncPageBtns();
      }
      msg('已自动接入第 ' + p + ' 页');
      return true;
    } catch (e) { return false; }
  }

  function indexOfTrack(list, trackId) {
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].trackId) === String(trackId)) return i;
    }
    return -1;
  }

  $('audio').addEventListener('ended', async function () {
    var a = this;
    if (qi >= 0) savePos(queue[qi].trackId, a.duration, a.duration);
    // v0.19.2：「本集播完」要排在单集循环前面。
    // 原来 loopOne 先 return，开着 🔂 单集时睡眠定时整夜不生效（睡前场景正好会同时开这两个）。
    if (sleepMode === 'end') {
      sleepMode = 'off';
      sSet(SLEEP_KEY, '0');          // 停过就别再记忆，否则下次打开又停一次
      $('pSleep').value = '0';
      $('pSleepTip').textContent = '已按「本集播完」停止';
      a.pause();
      renderQueue();
      return;
    }
    // 单集循环：直接从头再放这一集
    if (loopOne && qi >= 0) {
      try { a.currentTime = 0; a.play(); } catch (e) { /* */ }
      skipDone = {};
      renderQueue();
      return;
    }
    if (qi >= 0 && qi + 1 < queue.length) { playAt(qi + 1); return; }
    var endSeq = playSeq;
    if (await extendQueue()) {
      // v0.19.4：extendQueue 里有网络请求（几百 ms ~ 2s）。这期间用户可能已经点了别的集，
      // 无条件 playAt(qi+1) 会把他刚选的集顶掉，而且 qi 已是新位置，看起来像「自己乱跳」。
      if (playSeq !== endSeq) return;
      playAt(qi + 1);
      return;
    }
    msg('已播完' + (queue[qi] && queue[qi].albumName ? '《' + queue[qi].albumName + '》' : '本页') + '共 ' + queue.length + ' 集' +
      (playOrder === 'desc' ? '（倒序已到头，可切回正序）' : ''));
  });

  // ---------- 播放队列面板 ----------
  function qPanelOpen() { return $('qPanel').classList.contains('show'); }

  function openQueue() {
    renderQueue();
    $('qPanel').classList.add('show');
  }

  function closeQueue() { $('qPanel').classList.remove('show'); }

  function renderQueue() {
    var el = $('qList');
    if (!el) return;
    var qs = $('qOrder');
    if (qs) qs.textContent = playOrder === 'desc' ? '↓ 倒序' : '↑ 正序';
    // v0.20.3：队列面板显示「还剩多久」，长专辑里比「还剩 200 集」更有概念
    var restSec = 0, noDur = 0;
    for (var ri = Math.max(0, qi); ri < queue.length; ri++) {
      var rd = Number(queue[ri] && queue[ri].duration) || 0;
      if (!rd) { noDur += 1; continue; }
      if (ri === qi) {
        var gp = getPos(queue[ri].trackId) || {};
        rd = Math.max(0, rd - (Number(gp.t) || 0));
      }
      restSec += rd;
    }
    var restTxt = restSec > 0 ? (' · 剩约 ' + fmtHM(restSec)) : '';
    $('qStat').textContent = queue.length
      ? ('共 ' + queue.length + ' 集 · 当前第 ' + (qi >= 0 ? qi + 1 : 0) + ' 集' + restTxt +
         (noDur ? ' · ' + noDur + ' 集时长未知' : ''))
      : '';
    el.innerHTML = '';
    if (!queue.length) {
      el.innerHTML = '<div class="qempty">队列是空的，去详情页点某一集开始听</div>';
      return;
    }
    queue.forEach(function (t, i) {
      var row = document.createElement('div');
      row.className = 'qrow' + (i === qi ? ' on' : '');

      var no = document.createElement('span');
      no.className = 'qno';
      no.textContent = i === qi ? '▶' : (t.index ? t.index : (i + 1));

      var tt = document.createElement('span');
      tt.className = 'qtt';
      tt.textContent = t.title;

      var mk = document.createElement('span');
      mk.className = 'qmk';
      var st = trackStat(t.trackId);
      if (i === qi && !$('audio').paused) mk.textContent = '播放中';
      else if (st === 'done') mk.textContent = '✓ 已听完';
      else if (st === 'part') mk.textContent = '⏱ ' + fmtTime((getPos(t.trackId) || {}).t || 0);

      var del = document.createElement('span');
      del.className = 'qdel';
      del.textContent = '×';
      del.title = '从队列移除';
      del.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        removeFromQueue(i);
      });

      row.appendChild(no); row.appendChild(tt); row.appendChild(mk); row.appendChild(del);
      row.addEventListener('click', function () {
        if (i === qi) { closeQueue(); return; }
        playAt(i);
        renderQueue();
      });
      el.appendChild(row);
    });
    // 高亮行滚到可视区
    var on = el.querySelector ? el.querySelector('.qrow.on') : null;
    if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: 'center' }); } catch (e2) {} }
  }

  function removeFromQueue(i) {
    if (i < 0 || i >= queue.length) return;
    var wasCur = i === qi;
    queue.splice(i, 1);
    if (!queue.length) {
      playSeq += 1;   // v0.19.4：队列空掉时同样作废在途 playAt
      qi = -1;
      $('audio').pause();
      renderQueue();
      msg('队列已空');
      return;
    }
    if (i < qi) qi -= 1;
    else if (wasCur) {
      // 删掉正在播的那集：直接播下一个位置（同号，或退到末尾）
      var nxt = Math.min(qi, queue.length - 1);
      qi = nxt;
      playAt(nxt);
    }
    renderQueue();
  }

  $('pQueue').addEventListener('click', function () {
    if (qPanelOpen()) closeQueue(); else openQueue();
  });
  $('qClose').addEventListener('click', closeQueue);  $('qOrder').addEventListener('click', function () {
    setOrder(playOrder === 'desc' ? 'asc' : 'desc');
    renderQueue();
  });
  $('qClear').addEventListener('click', function () {
    if (!queue.length) return;
    if (!confirm('清空播放队列？（不影响收听进度，详情页可以重新开播）')) return;
    playSeq += 1;   // v0.19.4：同 pClose，作废在途 playAt
    queue = [];
    qi = -1;
    $('audio').pause();
    renderQueue();
    msg('已清空队列');
  });
  $('qDropDone').addEventListener('click', function () {
    if (queue.length < 2) { msg('队列太短，不用清理', 'err'); return; }
    var keep = [];
    var newQi = -1;
    var curId = qi >= 0 ? String(queue[qi].trackId) : '';
    queue.forEach(function (t) {
      var done = trackStat(t.trackId) === 'done' && String(t.trackId) !== curId;
      if (done) return;
      keep.push(t);
    });
    var removed = queue.length - keep.length;
    if (!removed) { msg('队列里没有已听完的集'); return; }
    queue = keep;
    qi = curId ? indexOfTrack(queue, curId) : -1;
    renderQueue();
    msg('已移除 ' + removed + ' 集已听完的');
  });
  if ($('qPanel')) {
    $('qPanel').addEventListener('click', function (e) {
      if (e && e.target === this) closeQueue();
    });
  }

  $('pPrev').addEventListener('click', function () {
    if (qi > 0) playAt(qi - 1);
    else msg('已经是队列第 1 集');
  });
  $('pNext').addEventListener('click', function () {
    if (qi + 1 < queue.length) playAt(qi + 1);
    else msg('已经是队列最后一集');
  });
  $('pOrder').addEventListener('click', function () {
    setOrder(playOrder === 'desc' ? 'asc' : 'desc');
  });

  // 倍速（无级滑杆 0.5–3.0，跨会话记忆；两处滑杆互相同步）
  function setRate(v, quiet) {
    v = Math.min(3, Math.max(0.5, Math.round(v * 100) / 100)) || 1;
    $('audio').playbackRate = v;
    sSet(RATE_KEY, String(v));
    var sv = String(Math.round(v * 100));
    if ($('pRate').value !== sv) $('pRate').value = sv;
    if ($('fpRate').value !== sv) $('fpRate').value = sv;
    $('pRateNum').textContent = v.toFixed(2) + 'x';
    $('fpRateNum').textContent = v.toFixed(2) + 'x';
    if (!quiet) msg('倍速 ' + v.toFixed(2) + 'x');
  }
  $('pRate').addEventListener('input', function () { setRate(Number(this.value) / 100); });
  $('fpRate').addEventListener('input', function () { setRate(Number(this.value) / 100); });
  setRate(Number(sGet(RATE_KEY) || 1) || 1, true);

  // 睡眠定时
  // 记忆上次选择：多数人固定「本集播完」或「30 分钟」，每次重开都要重选很烦
  var SLEEP_KEY = 'xm_sleep';
  var sleepTimer = null, sleepAt = 0, sleepMode = 'off';

  function applySleep(v, silent) {
    if (sleepTimer) { clearInterval(sleepTimer); sleepTimer = null; }
    if (v === 'end') {
      sleepMode = 'end';
      sleepAt = 0;
      $('pSleepTip').textContent = '本集播完停止';
      if (!silent) sSet(SLEEP_KEY, 'end');   // 这个档位最常用，必须记住
      return;
    }
    sleepMode = 'off';
    var min = Number(v) || 0;
    sleepAt = min ? Date.now() + min * 60000 : 0;
    if (!min) {
      $('pSleepTip').textContent = '';
      // v0.19.2：关掉也要落盘，否则下次打开会读回上次的分钟数自动开始倒计时
      if (!silent) sSet(SLEEP_KEY, '0');
      return;
    }
    $('pSleepTip').textContent = '剩 ' + min + ':00';
    sleepTimer = setInterval(function () {
      var left = sleepAt - Date.now();
      if (left <= 0) {
        clearInterval(sleepTimer); sleepTimer = null;
        fadeOutAndPause();
        $('pSleep').value = '0';
        $('pSleepTip').textContent = '已定时停止';
        sleepAt = 0;
        // 定时停下后不记忆，下次打开默认不再定时（避免「怎么一开就停」）
        sSet(SLEEP_KEY, '0');
        return;
      }
      var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      $('pSleepTip').textContent = '剩 ' + m + ':' + (s < 10 ? '0' : '') + s;
    }, 1000);
    if (!silent) sSet(SLEEP_KEY, String(v));
  }

  $('pSleep').addEventListener('change', function () {
    // v0.18.0：自定义分钟档，睡前想睡 40 分钟这种不再迁就固定档位
    if (this.value === 'custom') {
      var inp = prompt('定时多少分钟后停止？（1-720）', '20');
      // v0.19.2：取消时也要落盘成 '0'。原来 silent=true 不写 localStorage，
      // 下次打开页面会读回上次的分钟数并自动开始倒计时。
      if (inp === null) { this.value = '0'; applySleep('0', false); return; }
      var min = Math.round(Number(inp));
      if (!min || min < 1) { msg('定时已取消'); this.value = '0'; applySleep('0', false); return; }
      min = Math.min(720, min);
      var copt = this.querySelector('option[value="custom"]');
      if (copt) copt.textContent = '自定义 ' + min + ' 分';
      this.value = 'custom';
      applySleep(String(min), false);
      return;
    }
    applySleep(this.value, false);
  });

  // ---------- 音量：记忆 + 播放时淡入 ----------
  var VOL_KEY = 'xm_vol';
  var fadeInDone = false;
  function applyVol(v, silent) {
    var a = $('audio');
    var n = Math.max(0, Math.min(100, Number(v)));
    if (!isFinite(n)) n = 100;
    a.volume = n / 100;
    if ($('pVol')) $('pVol').value = String(n);
    if (!silent) sSet(VOL_KEY, String(n));
  }
  // 定时/关闭时淡出，避免突然静音炸耳朵
  function fadeOutAndPause() {
    var a = $('audio');
    var start = a.volume, t0 = Date.now();
    var timer = setInterval(function () {
      var k = Math.min(1, (Date.now() - t0) / 800);
      try { a.volume = Math.max(0, start * (1 - k)); } catch (e) { /* */ }
      if (k >= 1) {
        clearInterval(timer);
        a.pause();
        try { a.volume = start; } catch (e) { /* */ }
      }
    }, 60);
  }
  if ($('pVol')) {
    $('pVol').addEventListener('input', function () { applyVol(this.value, false); });
  }

  // ---------- 单集循环 ----------
  var LOOP_KEY = 'xm_loopone';
  var loopOne = sGet(LOOP_KEY) === '1';
  function syncLoopBtn() {
    var b = $('pLoopOne');
    if (!b) return;
    b.textContent = loopOne ? '🔂 单集中' : '🔂 单集';
    b.style.color = loopOne ? 'var(--accent, #3b82f6)' : '';
  }
  if ($('pLoopOne')) {
    $('pLoopOne').addEventListener('click', function () {
      loopOne = !loopOne;
      sSet(LOOP_KEY, loopOne ? '1' : '0');
      syncLoopBtn();
      msg(loopOne ? '🔂 单集循环已开（这集播完从头再来）' : '单集循环已关');
    });
  }

  // ---------- 跳过片头片尾 ----------
  // 很多书每集开头有 20~40 秒台标、结尾有 30 秒预告，天天听很折磨。
  // 秒数存在设置里；按集只跳一次（同一集不重复跳，避免用户手动拖回去又被拽走）。
  var SKIP_KEY = 'xm_skip';   // {head: 秒, tail: 秒}
  var skipCfg = { head: 0, tail: 0 };
  try { var sk0 = JSON.parse(sGet(SKIP_KEY) || 'null'); if (sk0) skipCfg = { head: Number(sk0.head) || 0, tail: Number(sk0.tail) || 0 }; } catch (e) { /* */ }
  var skipDone = {};   // trackId -> true

  function syncSkipBtn() {
    var b = $('pSkip');
    if (!b) return;
    var on = skipCfg.head > 0 || skipCfg.tail > 0;
    b.textContent = on ? ('⏩ 跳过 ' + skipCfg.head + '/' + skipCfg.tail + 's') : '⏩ 跳片头';
    b.style.color = on ? 'var(--accent, #3b82f6)' : '';
    b.title = on
      ? ('每集开头跳 ' + skipCfg.head + ' 秒、结尾提前 ' + skipCfg.tail + ' 秒结束（点一下可改）')
      : '跳过片头片尾（点一下设置秒数）';
  }

  function applySkip(tag) {
    var a = $('audio');
    if (!skipCfg.head && !skipCfg.tail) return false;
    var tid = tag || (qi >= 0 && queue[qi] ? queue[qi].trackId : '');
    if (!tid) return false;
    var dur = Number(a.duration) || 0;
    if (!dur) return false;
    if (skipCfg.head > 0 && a.currentTime < skipCfg.head && !skipDone[tid]) {
      if (pendingSeek && pendingSeek.t > skipCfg.head) { skipDone[tid] = 1; return false; }  // 续播点在后头，别往回拽
      a.currentTime = skipCfg.head;
      skipDone[tid] = 1;
      msg('⏩ 跳过片头 ' + skipCfg.head + ' 秒');
      return true;
    }
    return false;
  }

  if ($('pSkip')) {
    $('pSkip').addEventListener('click', function () {
      var cur = (skipCfg.head || 0) + '/' + (skipCfg.tail || 0);
      var v = window.prompt('跳过片头/片尾秒数，用斜杠分隔（例如 30/20，填 0/0 关闭）：', cur);
      if (v === null) return;
      var m2 = String(v).split(/[\/,，\s]+/);
      var head = Math.max(0, Math.min(600, Number(m2[0]) || 0));
      var tail = Math.max(0, Math.min(600, Number(m2[1]) || 0));
      skipCfg = { head: head, tail: tail };
      sSet(SKIP_KEY, JSON.stringify(skipCfg));
      skipDone = {};
      syncSkipBtn();
      msg(head || tail ? ('已设置：每集跳过片头 ' + head + ' 秒、片尾 ' + tail + ' 秒') : '已关闭跳过片头片尾');
    });
  }
  syncSkipBtn();
  syncLoopBtn();
  applyVol(sGet(VOL_KEY) === null ? 100 : Number(sGet(VOL_KEY)) || 0, true);

  // 拖动进度条时显示预览时间（原生控件不显示，用户难定位）
  var seekViewEl = null;
  function seekViewShow(x, y, text) {
    if (!seekViewEl) seekViewEl = $('seekView');
    if (!seekViewEl) return;
    seekViewEl.textContent = text;
    seekViewEl.style.left = x + 'px';
    seekViewEl.style.top = y + 'px';
    seekViewEl.classList.remove('hide');
  }
  function seekViewHide() {
    if (!seekViewEl) seekViewEl = $('seekView');
    if (seekViewEl) seekViewEl.classList.add('hide');
  }
  var lastSeekT = 0;
  $('audio').addEventListener('seeking', function () {
    var a = this;
    var dur = Number(a.duration) || 0;
    if (!dur) return;
    var r = a.getBoundingClientRect();
    // 原生控件没有拖拽事件，这里按进度粗算气泡位置，够用
    var ratio = Math.max(0, Math.min(1, (Number(a.currentTime) || 0) / dur));
    lastSeekT = Number(a.currentTime) || 0;
    seekViewShow(r.left + Math.max(60, Math.min(r.width - 60, 40 + ratio * (r.width - 80))), r.top - 6,
      fmtTime(a.currentTime) + ' / ' + fmtTime(dur));
  });
  $('audio').addEventListener('seeked', function () { setTimeout(seekViewHide, 400); });

  // 点播放条上的专辑名，跳回该专辑详情页
  $('pAlbum').addEventListener('click', function () {
    var aid = this.dataset.albumId;
    if (aid) openAlbumFromRecent(aid);
  });

  $('pClose').addEventListener('click', function () {
    var a = $('audio');
    if (qi >= 0) savePos(queue[qi].trackId, a.currentTime, a.duration);
    a.pause();
    a.removeAttribute('src');
    $('player').classList.remove('show');
    if (document.body) document.body.classList.remove('has-player');
    playSeq += 1;   // v0.19.4：作废所有在途 playAt，否则 1 秒后音频会自己响起来且无法控制
    qi = -1;
    queue = [];
    curPlayingId = '';
    markPlayingRow();
    abReset(true);
    closeFull();
    closeBm();
  });

  // ================= 播放界面增强：书签 / A-B 复读 / 全屏页 / 时间线 =================
  var AB_KEY = 'xm_ab';
  var abA = 0, abB = 0, abLoop = 0, abEnabled = false;

  function curTrack() { return qi >= 0 ? queue[qi] : null; }

  function trackTag() {
    var t = curTrack();
    if (!t) return '';
    var bits = [];
    if (t.index) bits.push('第 ' + t.index + ' 集');
    if (t.albumName) bits.push(t.albumName);
    return bits.join(' · ');
  }

  // ---------- 书签 ----------
  var bmPanelOpenFlag = false;
  var bmFilterAlbum = false;
  var bmItems = [];

  function openBm() {
    if (!curTrack()) { msg('先播一集再打书签', 'err'); return; }
    bmPanelOpenFlag = true;
    $('bmPanel').classList.add('show');
    renderBm();
  }
  function closeBm() {
    bmPanelOpenFlag = false;
    $('bmPanel').classList.remove('show');
  }

  function bmTimeLabel(t) { return fmtTime(t); }

  async function renderBm() {
    var t = curTrack();
    $('bmStat').textContent = t ? ('当前：' + (t.title || '') + ' ' + fmtTime($('audio').currentTime || 0)) : '';
    $('bmOnlyAlbum').classList.toggle('active', bmFilterAlbum);
    $('bmOnlyAlbum').disabled = !t || !t.albumId;
    var q = bmFilterAlbum && t && t.albumId ? ('?albumId=' + encodeURIComponent(t.albumId)) : '';
    try {
      var r = await api('GET', '/bookmarks' + q);
      bmItems = (r && r.data && r.data.items) || [];
    } catch (e) { bmItems = []; }
    var box = $('bmList');
    box.innerHTML = '';
    if (!bmItems.length) {
      box.innerHTML = '<div class="bmempty">还没有书签。听到想记的地方，点「＋ 在当前位置打书签」。</div>';
      return;
    }
    $('bmStat').textContent = (t ? '当前 ' + fmtTime($('audio').currentTime || 0) + ' · ' : '') + '共 ' + bmItems.length + ' 条';
    var lastDay = '';
    bmItems.forEach(function (b) {
      var dk = dayKey(b.at);
      if (dk !== lastDay) {
        lastDay = dk;
        var hd = document.createElement('div');
        hd.className = 'bmday';
        hd.textContent = dayLabel(dk);
        box.appendChild(hd);
      }
      var row = document.createElement('div');
      row.className = 'bmrow';
      var tm = document.createElement('div');
      tm.className = 'bmt';
      tm.textContent = bmTimeLabel(b.t);
      tm.title = '从这个时间点开始听';
      tm.addEventListener('click', function () { playBookmark(b); });
      var mid = document.createElement('div');
      mid.className = 'bmm';
      var tt = document.createElement('div');
      tt.className = 'bmtitle';
      tt.textContent = b.title || ('第 ' + (b.index || '?') + ' 集');
      var sub = document.createElement('div');
      sub.className = 'bmsub';
      var bits = [];
      if (b.index) bits.push('第 ' + b.index + ' 集');
      if (b.albumName) bits.push(b.albumName);
      bits.push(agoText(b.at));
      sub.textContent = bits.join(' · ');
      mid.appendChild(tt);
      if (b.note) {
        var nn = document.createElement('div');
        nn.className = 'bmnote';
        nn.textContent = '📝 ' + b.note;
        mid.appendChild(nn);
      }
      mid.appendChild(sub);
      mid.addEventListener('click', function () { playBookmark(b); });
      var del = document.createElement('span');
      del.className = 'bmdel';
      del.textContent = '×';
      del.title = '删除书签';
      del.addEventListener('click', async function (e) {
        e.stopPropagation();
        try {
          await api('POST', '/bookmarks', { remove: b.id });
          msg('书签已删除');
          renderBm();
        } catch (err) { msg('删除失败: ' + err.message, 'err'); }
      });
      row.appendChild(tm); row.appendChild(mid); row.appendChild(del);
      box.appendChild(row);
    });
  }

  function playBookmark(b) {
    if (!b || !b.trackId) return;
    var same = curTrack() && String(curTrack().trackId) === String(b.trackId);
    if (same) {
      $('audio').currentTime = Number(b.t) || 0;
      msg('跳到 ' + fmtTime(b.t));
      return;
    }
    // v0.19.2：时间点要透传进 playQueue —— 直接设 pendingSeek 会被 playAt 里的 getPos() 冲掉
    playQueue([{ trackId: b.trackId, index: b.index, title: b.title, albumId: b.albumId, albumName: b.albumName, cover: b.cover }], 0,
      { id: b.albumId, name: b.albumName, cover: b.cover }, Number(b.t) || 0);
    closeBm();
  }

  async function addBmNow() {
    var t = curTrack();
    if (!t) { msg('先在下方播放器播一集', 'err'); return; }
    var a = $('audio');
    if (!a.duration) { msg('还没加载好，等一下再试', 'err'); return; }
    var note = ($('bmNote').value || '').trim();
    var body = {
      trackId: t.trackId, albumId: t.albumId || '', albumName: t.albumName || '',
      title: t.title || '', index: t.index || 0, cover: t.cover || '',
      t: Math.round(a.currentTime || 0), note: note
    };
    try {
      var r = await api('POST', '/bookmarks', body);
      if (!r.success) { msg('❌ ' + (r.error || '保存失败'), 'err'); return; }
      msg((r.data && r.data.dup ? '📍 这个时间点已有书签，已更新备注' : '📍 已加书签 ' + fmtTime(body.t)), 'ok');
      $('bmNote').value = '';
      renderBm();
    } catch (e) { msg('保存失败: ' + e.message, 'err'); }
  }

  function dayKey(ts) {
    var d = new Date(Number(ts) || Date.now());
    var m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
  }
  function dayLabel(k) {
    var today = dayKey(Date.now());
    var y = new Date(Date.now() - 86400000);
    var yk = dayKey(y.getTime());
    if (k === today) return '今天 ' + k;
    if (k === yk) return '昨天 ' + k;
    return k;
  }

  $('pBm').addEventListener('click', openBm);
  $('bmClose').addEventListener('click', closeBm);
  $('bmAddNow').addEventListener('click', addBmNow);
  // v0.18.0：书签导出 CSV（导的是当前过滤视角下的 bmItems）
  $('bmExport').addEventListener('click', function () {
    if (!bmItems || !bmItems.length) { msg('还没有书签可导出', 'err'); return; }
    var rows = [['时间', '集数', '集名', '专辑', '备注']];
    bmItems.forEach(function (b) {
      rows.push([
        fmtTime(b.t || 0),
        b.index || '',
        String(b.title || '').replace(/"/g, '""'),
        String(b.albumName || '').replace(/"/g, '""'),
        String(b.note || '').replace(/"/g, '""')
      ]);
    });
    var csv = '\ufeff' + rows.map(function (r) {
      return r.map(function (c) { return '"' + c + '"'; }).join(',');
    }).join('\r\n');
    downloadText('书签-' + dayKey(Date.now()) + '.csv', 'text/csv;charset=utf-8', csv);
    msg('已导出 ' + bmItems.length + ' 条书签', 'ok');
  });
  $('bmOnlyAlbum').addEventListener('click', function () {
    bmFilterAlbum = !bmFilterAlbum;
    renderBm();
  });
  $('bmPanel').addEventListener('click', function (e) {
    if (e.target === $('bmPanel')) closeBm();
  });
  $('bmNote').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addBmNow(); }
  });

  // ---------- A-B 复读 ----------
  function abTip() {
    var txt = '';
    if (abA && !abB) txt = 'A ' + fmtTime(abA) + ' → 再点设 B';
    else if (abA && abB) txt = 'A ' + fmtTime(abA) + ' - B ' + fmtTime(abB) + (abLoop ? ' ×' + abLoop : '');
    $('pAbTip').textContent = txt;
    if ($('fpAbTip')) $('fpAbTip').textContent = txt;
    $('pAb').classList.toggle('active', !!abEnabled);
    if ($('fpAb')) $('fpAb').classList.toggle('active', !!abEnabled);
    $('pAb').textContent = abEnabled ? '🔁 复读中' : '🔁 复读';
    if ($('fpAb')) $('fpAb').textContent = abEnabled ? '🔁 复读中' : '🔁';
  }

  function abReset(silent) {
    abA = 0; abB = 0; abEnabled = false;
    sSet(AB_KEY, '');
    abTip();
    if (!silent) msg('已取消 A-B 复读');
  }

  // 三态循环：无 A → 设 A；有 A 无 B → 设 B 并开播复读；已有 A/B → 取消
  function abToggle() {
    var a = $('audio');
    if (!curTrack() || !a.duration) { msg('先播一集再用复读', 'err'); return; }
    var t = Math.round(a.currentTime || 0);
    if (!abA) {
      abA = t; abB = 0; abEnabled = false;
      msg('🅰 起点 ' + fmtTime(t) + '，听到终点再点一次', 'ok');
      abTip();
      abPersist();   // v0.19.2：原来设完从不落盘，切集/重载后复读点就丢了
      return;
    }
    if (!abB) {
      if (t - abA < 2) { msg('终点要比起点晚 2 秒以上，再往后听一点', 'err'); return; }
      abB = t; abEnabled = true; abLoop = 0;
      msg('🔁 开始复读 ' + fmtTime(abA) + ' - ' + fmtTime(abB), 'ok');
      a.currentTime = abA;
      abTip();
      abPersist();
      return;
    }
    abReset(false);
  }

  // timeupdate 里检查是否越过 B 点
  function abCheck() {
    if (!abEnabled || !abA || !abB) return;
    var a = $('audio');
    var t = a.currentTime || 0;
    if (t >= abB - 0.15 || t < abA - 1.5) {
      abLoop += 1;
      a.currentTime = abA;
      abTip();
    }
  }

  // 记到 localStorage，切集后同一集还能继续复读
  function abPersist() {
    var c = curTrack();
    if (!c) return;
    sSet(AB_KEY, abA && abB ? JSON.stringify({ trackId: c.trackId, a: abA, b: abB }) : '');
  }

  function abRestore() {
    abA = 0; abB = 0; abEnabled = false; abLoop = 0;
    var c = curTrack();
    if (!c) { abTip(); return; }
    try {
      var o = JSON.parse(sGet(AB_KEY) || 'null');
      if (o && String(o.trackId) === String(c.trackId) && o.a < o.b) {
        abA = o.a; abB = o.b; abEnabled = true;
        msg('🔁 恢复复读 ' + fmtTime(abA) + ' - ' + fmtTime(abB));
      }
    } catch (e) { /* */ }
    abTip();
  }

  $('pAb').addEventListener('click', abToggle);
  if ($('fpAb')) $('fpAb').addEventListener('click', abToggle);

  // ---------- 全屏播放页 ----------
  var fpOpen = false;
  var fpDragging = false;

  function openFull(skipCheck) {
    if (!skipCheck && !curTrack()) { msg('先播一集', 'err'); return; }
    fpOpen = true;
    $('fullPlayer').classList.add('show');
    if (document.body) document.body.style.overflow = 'hidden';
    pMoreShow(false);
    syncFull(true);
  }
  function closeFull() {
    fpOpen = false;
    $('fullPlayer').classList.remove('show');
    if (document.body) document.body.style.overflow = '';
  }

  function syncFull(force) {
    if (!fpOpen && !force) return;
    var a = $('audio');
    var t = curTrack();
    $('fpAlbum').textContent = (t && t.albumName) || '—';
    $('fpTitle').textContent = (t && t.title) || '—';
    var fpc = (t && t.cover) || '';
    $('fpCover').src = fpc;
    // v0.23.10：封面同步为全屏页氛围背景（#fullPlayer::before 模糊放大显示）
    var fpEl = $('fullPlayer');
    if (fpEl) {
      if (fpc) fpEl.style.setProperty('--fpcov', 'url("' + String(fpc).replace(/"/g, '%22') + '")');
      else fpEl.style.removeProperty('--fpcov');
    }
    var meta = [];
    if (t && t.index) meta.push('第 ' + t.index + ' 集');
    if (qi >= 0 && queue.length > 1) meta.push('队列 ' + (qi + 1) + ' / ' + queue.length);
    if (playOrder === 'desc') meta.push('倒序');
    $('fpMeta').textContent = meta.join(' · ');
    var d = a.duration || 0, cur = a.currentTime || 0;
    $('fpDur').textContent = d ? fmtTime(d) : '0:00';
    $('fpCur').textContent = fmtTime(cur);
    if (!fpDragging) $('fpSeek').value = d ? Math.round(cur / d * 1000) : 0;
    $('fpPlay').textContent = a.paused ? '▶' : '⏸';
    var rsv = String(Math.round((a.playbackRate || 1) * 100));
    if ($('fpRate').value !== rsv) $('fpRate').value = rsv;
    if ($('pRate').value !== rsv) $('pRate').value = rsv;
    $('fpRateNum').textContent = (a.playbackRate || 1).toFixed(2) + 'x';
    $('pRateNum').textContent = (a.playbackRate || 1).toFixed(2) + 'x';
    if ($('fpQueue')) $('fpQueue').textContent = queue.length > 1 ? '☰ ' + (qi + 1) + '/' + queue.length : '☰';
  }

  $('pFull').addEventListener('click', function () { openFull(false); });

  // v0.22.0：播放条「⋯ 更多」抽屉（次要功能全收在这里，播放条只留最常用的几颗）
  function pMoreOpen() { var p = $('pMorePanel'); return !!p && !p.classList.contains('hide'); }
  function pMoreShow(on) {
    var p = $('pMorePanel'), b = $('pMore');
    if (!p) return;
    p.classList.toggle('hide', !on);
    if (b) { b.classList.toggle('on', !!on); b.setAttribute('aria-expanded', on ? 'true' : 'false'); }
  }
  if ($('pMore')) $('pMore').addEventListener('click', function (e) {
    e.stopPropagation();
    pMoreShow(!pMoreOpen());
  });
  document.addEventListener('click', function (e) {
    if (!pMoreOpen()) return;
    if (e.target && e.target.closest && e.target.closest('#pMorePanel, #pMore')) return;
    pMoreShow(false);
  });
  $('fpClose').addEventListener('click', closeFull);
  $('fpQueue').addEventListener('click', function () { openQueue(); });
  $('fpPlay').addEventListener('click', function () {
    var a = $('audio');
    if (a.paused) a.play().catch(function () { }); else a.pause();
  });
  $('fpPrev').addEventListener('click', function () { if (qi > 0) playAt(qi - 1); else msg('已经是队列第 1 集'); });
  $('fpNext').addEventListener('click', function () { if (qi + 1 < queue.length) playAt(qi + 1); else msg('已经是队列最后一集'); });
  $('fpBack15').addEventListener('click', function () {
    var a = $('audio'); a.currentTime = Math.max(0, (a.currentTime || 0) - 15);
  });
  $('fpFwd30').addEventListener('click', function () {
    var a = $('audio'); a.currentTime = Math.min(a.duration || 1e9, (a.currentTime || 0) + 30);
  });
  $('fpBm').addEventListener('click', function () { addBmNowQuick(); });
  // v0.21.2：全屏播放条倍速改为无级滑杆，input 事件统一走上面的 setRate
  $('fpSeek').addEventListener('input', function () {
    fpDragging = true;
    // v0.21.4：拖动进度时实时预览当前时间
    var a = $('audio'), d = a.duration || 0;
    if (d) $('fpCur').textContent = fmtTime(d * (Number(this.value) || 0) / 1000);
  });
  $('fpSeek').addEventListener('change', function () {
    var a = $('audio');
    var d = a.duration || 0;
    if (d) a.currentTime = d * (Number(this.value) || 0) / 1000;
    fpDragging = false;
    syncFull(true);
  });

  // v0.22.1：全屏页手势——左右滑切集、双击暂停（只在「本机」面板，避开滑杆/按钮/分段）
  (function () {
    var fp = $('fullPlayer');
    if (!fp) return;
    var g = { x: 0, y: 0, skip: true };
    function onCtl(t) { return !!(t && t.closest && t.closest('input, select, button, .fpseg')); }
    fp.addEventListener('touchstart', function (e) {
      if (onCtl(e.target)) { g = { x: 0, y: 0, skip: true }; return; }
      var p = (e.touches && e.touches[0]) || {};
      g = { x: p.clientX || 0, y: p.clientY || 0, skip: false };
    }, { passive: true });
    fp.addEventListener('touchend', function (e) {
      if (g.skip) return;
      var p = (e.changedTouches && e.changedTouches[0]) || {};
      var dx = (p.clientX || 0) - g.x, dy = (p.clientY || 0) - g.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        if (dx < 0) { if (qi + 1 < queue.length) playAt(qi + 1); else msg('已经是队列最后一集'); }
        else { if (qi > 0) playAt(qi - 1); else msg('已经是队列第 1 集'); }
      }
    }, { passive: true });
    fp.addEventListener('dblclick', function (e) {
      if (onCtl(e.target)) return;
      var a = $('audio');
      if (a.paused) a.play().catch(function () { }); else a.pause();
    });
  })();

  // 全屏页里打书签：不弹面板，直接记一条带时间点的
  async function addBmNowQuick() {
    var t = curTrack();
    if (!t) { msg('先播一集', 'err'); return; }
    var a = $('audio');
    if (!a.duration) { msg('还没加载好，等一下再试', 'err'); return; }
    var body = {
      trackId: t.trackId, albumId: t.albumId || '', albumName: t.albumName || '',
      title: t.title || '', index: t.index || 0, cover: t.cover || '',
      t: Math.round(a.currentTime || 0), note: ''
    };
    try {
      var r = await api('POST', '/bookmarks', body);
      msg(r.success ? '📍 已加书签 ' + fmtTime(body.t) : '❌ ' + (r.error || '失败'), r.success ? 'ok' : 'err');
    } catch (e) { msg('保存失败: ' + e.message, 'err'); }
  }

  // ---------- 播放历史时间线 ----------
  var tlDays = 1;

  function renderTimeline() {
    var box = $('tlBody');
    if (!box) return;
    var kw = ($('tlKw') && $('tlKw').value.trim()) || '';
    api('GET', '/history?days=' + tlDays + (kw ? '&kw=' + encodeURIComponent(kw) : '')).then(function (r) {
      var groups = (r && r.data && r.data.groups) || [];
      box.innerHTML = '';
      if (!groups.length) {
        $('tlStat').textContent = '这个时间段还没有收听记录。';
        return;
      }
      var totalSec = 0, totalCnt = 0;
      groups.forEach(function (g) { totalSec += Number(g.listSec) || 0; totalCnt += Number(g.count) || 0; });
      $('tlStat').textContent = '共 ' + totalCnt + ' 条记录，实际收听 ' + fmtHM(totalSec) + '（跨设备合并）';
      groups.forEach(function (g) {
        var hd = document.createElement('div');
        hd.className = 'bmday';
        hd.textContent = dayLabel(g.day) + (g.listSec ? ' · 听了 ' + fmtHM(g.listSec) : '') + ' · ' + g.items.length + ' 条';
        box.appendChild(hd);
        g.items.forEach(function (it) {
          var row = document.createElement('div');
          row.className = 'tlitem';
          var tm = document.createElement('div');
          tm.className = 'tlt';
          tm.textContent = fmtHMTime(it.at);
          var b = document.createElement('div');
          b.className = 'tlb';
          var n = document.createElement('div');
          n.className = 'tln';
          n.textContent = (it.index ? it.index + '. ' : '') + (it.title || '');
          var s = document.createElement('div');
          s.className = 'tls';
          var bits = [];
          if (it.albumName) bits.push(it.albumName);
          bits.push('听到 ' + fmtTime(it.t || 0));
          s.textContent = bits.join(' · ');
          b.appendChild(n); b.appendChild(s);
          b.addEventListener('click', function () {
            // v0.19.2：时间点透传，否则会被 playAt 里的 getPos() 覆盖
            playQueue([{ trackId: it.trackId, index: it.index, title: it.title, albumId: it.albumId, albumName: it.albumName, cover: it.cover }], 0,
              { id: it.albumId, name: it.albumName, cover: it.cover }, Number(it.t) || 0);
          });
          row.appendChild(tm); row.appendChild(b);
          box.appendChild(row);
        });
      });
    }).catch(function () { $('tlStat').textContent = '读取失败，稍后再试'; });
  }

  function fmtHMTime(ts) {
    var d = new Date(Number(ts) || Date.now());
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  document.querySelectorAll('.tlBtn').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.tlBtn').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      tlDays = Number(b.getAttribute('data-days')) || 1;
      renderTimeline();
    });
  });
  if ($('btnTlRefresh')) $('btnTlRefresh').addEventListener('click', renderTimeline);
  // v0.18.0：历史按书名/集名过滤，输入停 400ms 自动刷
  if ($('tlKw')) {
    var tlKwTimer = null;
    $('tlKw').addEventListener('input', function () {
      if (tlKwTimer) clearTimeout(tlKwTimer);
      tlKwTimer = setTimeout(renderTimeline, 400);
    });
  }


  // 快捷键：空格 播放/暂停，← → 前后 10 秒，B 打书签，A 复读，Esc 逐层收起
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (e.key === 'Escape') {
      if (fpOpen) { e.preventDefault(); closeFull(); return; }
      if (pMoreOpen()) { e.preventDefault(); pMoreShow(false); return; }
      if (bmPanelOpenFlag) { e.preventDefault(); closeBm(); return; }
      if (qPanelOpen()) { e.preventDefault(); closeQueue(); return; }
    }
    if (!$('player').classList.contains('show')) return;
    var a = $('audio');
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (a.paused) a.play().catch(function () { }); else a.pause();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      a.currentTime = Math.max(0, (a.currentTime || 0) - 10);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      a.currentTime = Math.min(a.duration || 1e9, (a.currentTime || 0) + 10);
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      addBmNowQuick();
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      abToggle();
    }
  });

  // ---------- 搜索 ----------
  var DEFAULT_KWS = ['郭德纲', '三国演义', '睡前故事', '财经', '历史', '英语听力'];
  var results = [];
  var selected = {};

  function loadHistory() {
    try { return JSON.parse(sGet('xm_kw_hist') || '[]'); } catch (e) { return []; }
  }
  function pushHistory(kw) {
    var h = loadHistory().filter(function (x) { return x !== kw; });
    h.unshift(kw);
    sSet('xm_kw_hist', JSON.stringify(h.slice(0, 6)));
    loadSearchHistory();
  }

  // 搜索历史：单独一行「最近搜过」，随搜随更新，可单条删、可清空
  var HS_KEY = 'xm_kw_recent';
  function loadRecentKw() {
    try {
      var a = JSON.parse(sGet(HS_KEY) || '[]');
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function pushRecentKw(kw) {
    kw = String(kw || '').trim();
    if (!kw) return;
    var a = loadRecentKw().filter(function (x) { return x && x.k !== kw; });
    a.unshift({ k: kw, at: Date.now() });
    sSet(HS_KEY, JSON.stringify(a.slice(0, 12)));
    loadSearchHistory();
  }
  function loadSearchHistory() {
    var row = $('hsRow'), box = $('hsChips');
    if (!row || !box) return;
    var a = loadRecentKw();
    box.innerHTML = '';
    if (!a.length) { row.classList.add('hide'); return; }
    row.classList.remove('hide');
    a.forEach(function (x) {
      var c = document.createElement('span');
      c.className = 'hschip';
      c.textContent = x.k;
      c.title = '再次搜索（右键删除）';
      c.addEventListener('click', function () { doSearch(x.k); });
      c.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        sSet(HS_KEY, JSON.stringify(loadRecentKw().filter(function (y) { return y.k !== x.k; })));
        loadSearchHistory();
        msg('已从最近搜索里移除「' + x.k + '」');
      });
      box.appendChild(c);
    });
  }
  if ($('btnHsClear')) {
    $('btnHsClear').addEventListener('click', function () {
      sSet(HS_KEY, '[]');
      sSet('xm_kw_hist', '[]');
      loadSearchHistory();
      renderIdleChips();
      msg('已清空搜索历史');
    });
  }

  // ---------- 专辑对比 ----------
  if ($('btnCompare')) {
    $('btnCompare').addEventListener('click', async function () {
      var box = $('cmpBox');
      if (!box.classList.contains('hide')) { box.classList.add('hide'); box.innerHTML = ''; return; }
      var a = window.prompt('第一张专辑（ID 或链接）：', '');
      if (!a) return;
      var b = window.prompt('第二张专辑（ID 或链接）：', '');
      if (!b) return;
      box.classList.remove('hide');
      box.innerHTML = '<div class="muted small-txt" style="margin-top:10px;">对比中…</div>';
      try {
        var r = await api('GET', '/compare?a=' + encodeURIComponent(a.trim()) + '&b=' + encodeURIComponent(b.trim()));
        if (!r || r.success === false) { box.innerHTML = '<div class="err" style="margin-top:10px;">' + esc((r && r.error) || '对比失败') + '</div>'; return; }
        renderCompare(r.data, box);
      } catch (e) {
        box.innerHTML = '<div class="err" style="margin-top:10px;">对比失败: ' + esc(e.message) + '</div>';
      }
    });
  }

  function renderCompare(d, box) {
    var A = d.albums[0], B = d.albums[1];
    box.innerHTML = '';
    var card = document.createElement('div');
    card.className = 'card';
    card.style.marginTop = '10px';

    var head = document.createElement('div');
    head.className = 'cmpgrid';
    head.innerHTML =
      '<div class="cell"><b>' + escHtml(A.name) + '</b><div class="muted" style="font-size:11px;">' + escHtml(A.author || '') +
      (A.isPaid ? ' · <span style="color:#dc2626;">🔒 ' + escHtml(A.payLabel || '付费') + '</span>' : '') + '</div></div>' +
      '<div class="lb">对比</div>' +
      '<div class="cell"><b>' + escHtml(B.name) + '</b><div class="muted" style="font-size:11px;">' + escHtml(B.author || '') +
      (B.isPaid ? ' · <span style="color:#dc2626;">🔒 ' + escHtml(B.payLabel || '付费') + '</span>' : '') + '</div></div>';
    card.appendChild(head);

    (d.rows || []).forEach(function (row) {
      var r = document.createElement('div');
      r.className = 'cmpgrid';
      var av = row.label === '播放量' ? fmtPlay(row.a) : String(row.a || 0);
      var bv = row.label === '播放量' ? fmtPlay(row.b) : String(row.b || 0);
      r.innerHTML =
        '<div class="cell' + (row.better === 'a' ? ' win' : '') + '">' + escHtml(av) + (row.hint ? ' ' + row.hint : '') + '</div>' +
        '<div class="lb">' + escHtml(row.label) + '</div>' +
        '<div class="cell' + (row.better === 'b' ? ' win' : '') + '">' + escHtml(bv) + (row.hint ? ' ' + row.hint : '') + '</div>';
      card.appendChild(r);
    });

    var r2 = document.createElement('div');
    r2.className = 'cmpgrid';
    r2.innerHTML =
      '<div class="cell">' + escHtml(A.finishedText || '') + ' · 更新 ' + escHtml(A.updateDate || '-') + '</div>' +
      '<div class="lb">状态</div>' +
      '<div class="cell">' + escHtml(B.finishedText || '') + ' · 更新 ' + escHtml(B.updateDate || '-') + '</div>';
    card.appendChild(r2);

    var foot = document.createElement('div');
    foot.className = 'btns';
    foot.style.marginTop = '10px';
    ['看 A 详情', '看 B 详情'].forEach(function (lb2, i) {
      var b2 = document.createElement('button');
      b2.className = 'small plain';
      b2.textContent = lb2;
      b2.addEventListener('click', function () { openDetail(i === 0 ? A.albumId : B.albumId); });
      foot.appendChild(b2);
    });
    card.appendChild(foot);
    box.appendChild(card);
  }
  function renderChips(kws, onPick) {
    var box = $('kwChips');
    box.innerHTML = '';
    (kws || []).slice(0, 10).forEach(function (k) {
      if (!k) return;
      var c = document.createElement('span');
      c.className = 'chip';
      c.textContent = k;
      c.addEventListener('click', function () { onPick(k); });
      box.appendChild(c);
    });
  }
  function renderIdleChips() {
    var h = loadHistory();
    renderChips(h.length ? h : DEFAULT_KWS, doSearch);
  }

  function updateSelBar() {
    var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
    $('selBar').classList.toggle('hide', results.length === 0);
    $('selCount').textContent = '已选 ' + ids.length;
    $('btnImportSel').disabled = ids.length === 0;
    $('ckAll').checked = results.length > 0 && ids.length === results.length;
    $('mergeName').classList.toggle('hide', $('selMode').value !== 'merge');
  }

  function renderResults(list) {
    var el = $('searchResults');
    el.innerHTML = '';
    results = list || [];
    selected = {};
    if (!results.length) {
      el.textContent = '没有找到相关专辑，换个关键词试试；或者清空搜索框，从下面的「继续听」接着上次的。';
      updateSelBar();
      return;
    }

    results.forEach(function (a) {
      var item = document.createElement('div');
      item.className = 'res-item';

      var ck = document.createElement('input');
      ck.type = 'checkbox';
      ck.className = 'ck';
      ck.addEventListener('change', function () { selected[a.id] = ck.checked; updateSelBar(); });

      var img = document.createElement('img');
      img.src = a.cover || '';
      img.alt = '';
      img.onerror = function () { img.style.visibility = 'hidden'; };

      var body = document.createElement('div');
      body.className = 'body';
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = a.title;
      var m = document.createElement('div');
      m.className = 'm';
      var bits = [];
      if (a.category) bits.push(a.category);
      if (a.author) bits.push(a.author);
      if (a.tracks) bits.push(a.tracks + '集');
      if (a.play) bits.push(fmtPlay(a.play) + '播放');
      if (a.isPaid) {
        m.innerHTML = '<span class="dbadge pay" style="margin-right:5px;font-size:10px;">🔒 付费</span>' + escHtml(bits.join(' · '));
      } else {
        m.textContent = bits.join(' · ');
      }
      body.appendChild(t); body.appendChild(m);
      body.addEventListener('click', function () { openDetail(a.id); });

      var acts = document.createElement('div');
      acts.className = 'acts';
      var bDetail = document.createElement('button');
      bDetail.className = 'small plain';
      bDetail.textContent = '详情';
      bDetail.addEventListener('click', function () { openDetail(a.id); });
      var bImport = document.createElement('button');
      bImport.className = 'small';
      bImport.textContent = '导入';
      bImport.addEventListener('click', function () { doImport(a.id, a.title, a.tracks); });
      acts.appendChild(bImport); acts.appendChild(bDetail);

      item.appendChild(ck); item.appendChild(img); item.appendChild(body); item.appendChild(acts);
      el.appendChild(item);
    });
    updateSelBar();
  }

  async function doSearch(kw) {
    if (!kw) return;
    $('kw').value = kw;
    $('searchMeta').textContent = '搜索中…';
    $('searchResults').innerHTML = '';
    $('kwChips').innerHTML = '';
    $('detailCard').classList.add('hide');
    $('searchCard').classList.remove('hide');
    $('trackMore').classList.add('hide');
    showListen(false);   // v0.20.0：一搜就换成结果，别把「继续听」留在下面
    if (searchMode === 'track') { doSearchTracks(kw, 1, true); return; }
    try {
      var r = await api('POST', '/search', { kw: kw });
      if (r.success === false) { $('searchMeta').innerHTML = '<span class="err">' + esc(r.error) + '</span>'; return; }
      pushHistory(kw);
      pushRecentKw(kw);
      renderChips(r.keywords, doSearch);
      $('searchMeta').textContent = '共 ' + (r.count || 0) + ' 个结果' + (r.source ? ' · 来源：' + r.source : '');
      renderResults(r.data || []);
    } catch (e) { $('searchMeta').innerHTML = '<span class="err">搜索失败: ' + esc(e.message) + '</span>'; }
  }

  $('btnSearch').addEventListener('click', function () { doSearch($('kw').value.trim()); });
  $('kw').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { doSearch($('kw').value.trim()); return; }
    if (e.key === 'Escape') { $('kw').value = ''; resetToDiscover(); }
  });
  // v0.20.0：把搜索框清空 = 回到「继续听」，不用再切 tab
  $('kw').addEventListener('input', function () {
    if ($('kw').value.trim()) return;
    resetToDiscover();
  });
  function resetToDiscover() {
    $('searchMeta').textContent = '';
    $('searchResults').innerHTML = '';
    $('kwChips').innerHTML = '';
    $('trackMore').classList.add('hide');
    $('detailCard').classList.add('hide');
    $('searchCard').classList.remove('hide');
    results = [];
    selected = {};
    trackRows = [];
    updateSelBar();
    renderIdleChips();
    syncDiscover();
  }
  $('ckAll').addEventListener('change', async function () {
    var on = $('ckAll').checked;
    document.querySelectorAll('#searchResults .ck').forEach(function (c, i) {
      c.checked = on;
      if (results[i]) selected[results[i].id] = on;
    });
    updateSelBar();
  });
  $('selMode').addEventListener('change', updateSelBar);

  // ---------- 单集（声音）搜索 ----------
  var searchMode = 'album';
  var trackRows = [], trackKw = '', trackPage = 1, trackHasMore = false;

  function todayStrCli() {
    var d = new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function setSearchMode(m) {
    searchMode = m === 'track' ? 'track' : 'album';
    $('modeAlbum').classList.toggle('on', searchMode === 'album');
    $('modeTrack').classList.toggle('on', searchMode === 'track');
    $('kw').placeholder = searchMode === 'track'
      ? '搜某一集，如：郭德纲 王二姐思夫'
      : '关键词，如：股票、三国演义、郭德纲';
    $('trackMore').classList.add('hide');
    $('searchResults').innerHTML = '';
    $('searchMeta').textContent = searchMode === 'track'
      ? '按单集标题搜索，可以单独试听或收藏某一集'
      : '';
    $('detailCard').classList.add('hide');
    $('searchCard').classList.remove('hide');
    // v0.20.0：切模式会清空结果，记得把 results 也清掉，否则「继续听」判定会用到旧值
    results = [];
    selected = {};
    updateSelBar();
    renderIdleChips();
    syncDiscover();
  }
  $('modeAlbum').addEventListener('click', function () { setSearchMode('album'); });
  $('modeTrack').addEventListener('click', function () { setSearchMode('track'); });

  async function doSearchTracks(kw, page, reset) {
    trackKw = kw || trackKw;
    $('searchMeta').textContent = '搜索中…';
    if (reset) { $('searchResults').innerHTML = ''; $('kwChips').innerHTML = ''; trackRows = []; }
    $('detailCard').classList.add('hide');
    $('searchCard').classList.remove('hide');
    showListen(false);   // v0.20.0：同上
    try {
      var r = await api('POST', '/search/tracks', { kw: trackKw, page: page || 1, rows: 20 });
      if (r.success === false) { $('searchMeta').innerHTML = '<span class="err">' + escHtml(r.error) + '</span>'; return; }
      if (r.risk) { $('searchMeta').innerHTML = '<span class="err">单集搜索被风控暂时限制了，换个词或过一会儿再试</span>'; return; }
      pushHistory(trackKw);
      pushRecentKw(trackKw);
      trackPage = Number(r.page) || page || 1;
      trackHasMore = !!r.hasMore;
      var list = r.data || [];
      if (page > 1) {
        var seen = {};
        trackRows.forEach(function (x) { seen[String(x.trackId)] = 1; });
        list = list.filter(function (t) { return !seen[String(t.trackId)]; });
      }
      trackRows = trackRows.concat(list);
      renderTrackResults(list, page > 1);
      $('searchMeta').textContent = '第 ' + trackPage + ' 页 · 共 ' + trackRows.length + ' 集' +
        (r.total ? '（约 ' + r.total + ' 集匹配）' : '');
      $('trackMore').classList.toggle('hide', !trackRows.length);
      $('btnMoreTracks').disabled = !trackHasMore;
      $('btnMoreTracks').textContent = trackHasMore ? '加载更多单集' : '没有更多了';
    } catch (e) {
      $('searchMeta').innerHTML = '<span class="err">搜索失败: ' + escHtml(e.message) + '</span>';
    }
  }

  function playTrackRow(t) {
    var album = { id: t.albumId || '', name: t.album || '', cover: t.cover || '' };
    playQueue([{ trackId: t.trackId, index: 0, title: t.title }], 0, album);
  }

  function renderTrackResults(list, append) {
    var el = $('searchResults');
    if (!append) el.innerHTML = '';
    if (!list.length && !append) {
      el.innerHTML = '<div class="muted small-txt" style="padding:10px 0">没有找到相关单集，试试换关键词，或切回「搜专辑」。</div>';
      return;
    }
    list.forEach(function (t) {
      var item = document.createElement('div');
      item.className = 'res-item';
      item.setAttribute('data-tid', String(t.trackId || ''));   // v0.22.5：按下即预取地址

      var img = document.createElement('img');
      img.src = t.cover || '';
      img.alt = '';
      img.onerror = function () { img.style.visibility = 'hidden'; };

      var body = document.createElement('div');
      body.className = 'body';
      var tt = document.createElement('div');
      tt.className = 't';
      tt.textContent = t.title;
      var m = document.createElement('div');
      m.className = 'm';
      var bits = [];
      if (t.author) bits.push(t.author);
      if (t.album) bits.push('《' + t.album + '》');
      if (t.duration) bits.push(fmtDur(t.duration));
      if (t.play) bits.push(fmtPlay(t.play) + '播放');
      if (t.isPaid) bits.push('VIP');
      m.textContent = bits.join(' · ');
      body.appendChild(tt); body.appendChild(m);
      body.addEventListener('click', function () { playTrackRow(t); });

      var acts = document.createElement('div');
      acts.className = 'acts';
      var bPlay = document.createElement('button');
      bPlay.className = 'small';
      bPlay.textContent = '▶';
      bPlay.addEventListener('click', function () { playTrackRow(t); });
      var bAdd = document.createElement('button');
      bAdd.className = 'small plain';
      bAdd.textContent = '＋歌单';
      bAdd.addEventListener('click', async function () {
        bAdd.disabled = true;
        try {
          var r = await api('POST', '/import-tracks', { tracks: [t], name: '喜马拉雅单集 ' + todayStrCli() });
          if (r.success === false) msg('❌ ' + r.error, 'err');
          else { msg('✅ 已加进歌单《' + r.data.name + '》', 'ok'); loadImported(); }
        } catch (e) { msg('加入失败: ' + e.message, 'err'); }
        bAdd.disabled = false;
      });
      var bAlbum = document.createElement('button');
      bAlbum.className = 'small plain';
      bAlbum.textContent = '专辑';
      bAlbum.disabled = !t.albumId;
      bAlbum.addEventListener('click', function () { if (t.albumId) openDetail(t.albumId); });
      acts.appendChild(bPlay); acts.appendChild(bAdd); acts.appendChild(bAlbum);

      item.appendChild(img); item.appendChild(body); item.appendChild(acts);
      el.appendChild(item);
    });
  }

  $('btnMoreTracks').addEventListener('click', function () {
    if (trackHasMore) doSearchTracks(trackKw, trackPage + 1, false);
  });

  $('btnImportAllTracks').addEventListener('click', async function () {
    if (!trackRows.length) return;
    if (trackRows.length > 50 && !confirm('将把这 ' + trackRows.length + ' 集加进一个新歌单，继续？')) return;
    try {
      var r = await api('POST', '/import-tracks', { tracks: trackRows, name: '喜马拉雅单集 ' + todayStrCli() });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      msg('✅ 已把 ' + r.data.added + ' 集加进歌单《' + r.data.name + '》', 'ok');
      loadImported();
    } catch (e) { msg('加入失败: ' + e.message, 'err'); }
  });

  $('btnImportSel').addEventListener('click', async function () {
    var albums = results.filter(function (a) { return selected[a.id]; });
    if (!albums.length) return;
    var mode = $('selMode').value;
    if (albums.length > 3 && !confirm('将导入 ' + albums.length + ' 张专辑，耗时可能较长，继续？')) return;
    try {
      var r = await api('POST', '/import-multi', {
        albums: albums.map(function (a) { return { id: String(a.id), name: a.title }; }),
        mode: mode,
        name: $('mergeName').value.trim()
      });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      msg('⏳ ' + r.data.message);
      startPolling();
    } catch (e) { msg('导入失败: ' + e.message, 'err'); }
  });

  // v0.23.8：导入方式选择弹窗 —— 导入全部，或只导最新 N 集（后端 /import 的 latest 参数）
  function pickImportMode(name, tracks) {
    return new Promise(function (resolve) {
      var panel = $('ipPanel');
      $('ipTitle').textContent = '导入《' + (name || '专辑') + '》';
      $('ipInfo').textContent = tracks > 0 ? '共 ' + tracks + ' 集，选择导入方式：' : '选择导入方式：';
      $('ipN').value = 30;
      panel.classList.add('show');
      function done(rs) {
        panel.classList.remove('show');
        $('ipAll').onclick = null; $('ipLatest').onclick = null;
        $('ipClose').onclick = null; panel.onclick = null; $('ipN').onkeydown = null;
        resolve(rs);
      }
      $('ipAll').onclick = function () { done({ mode: 'all' }); };
      $('ipLatest').onclick = function () {
        var n = Math.floor(Number($('ipN').value) || 0);
        if (n <= 0) { msg('请填写要导最新的多少集，如 30', 'err'); return; }
        done({ mode: 'latest', n: n });
      };
      $('ipClose').onclick = function () { done(null); };
      panel.onclick = function (e) { if (e.target === panel) done(null); };
      $('ipN').onkeydown = function (e) { if (e.key === 'Enter') $('ipLatest').click(); };
      setTimeout(function () { try { $('ipN').focus(); $('ipN').select(); } catch (e2) {} }, 60);
    });
  }

  async function doImport(albumId, name, tracks, fromEp, toEp) {
    var ranged = Number(fromEp) > 0;
    // v0.23.8：整本导入先选方式（导入全部 / 只导最新 N 集）；按区间导入保持原行为
    var pick = null;
    if (!ranged) {
      pick = await pickImportMode(name, tracks);
      if (!pick) return;
    }
    try {
      var payload = { album_id: String(albumId), name: name || '' };
      if (ranged) {
        payload.start = Number(fromEp) || 0;
        payload.end = Number(toEp) || 0;
      } else if (pick.mode === 'latest') {
        payload.latest = pick.n;
      }
      var r = await api('POST', '/import', payload);
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      msg('⏳ 已开始导入' + (ranged ? '第 ' + fromEp + '-' + toEp + ' 集' : (pick.mode === 'latest' ? '最新 ' + pick.n + ' 集' : '全部')) + '《' + name + '》');
      startPolling();
    } catch (e) { msg('导入失败: ' + e.message, 'err'); }
  }

  // ---------- 详情 ----------
  var cur = { id: '', page: 1, hasMore: false, detail: null };
  // v0.19.0：跳页输入框是否被用户改过（改过就不自动回填页码，免得打字被覆盖）
  var jumpDirty = false;
  // v0.19.3：跳转方式 'page' 按页码 / 'index' 按集号
  var jumpMode = 'page';

  var detailSeq = 0;   // v0.19.4：连点两张专辑时，慢的旧请求不能覆盖后点开的那张
  cur.fromListen = false;   // v0.20.0：详情是不是从「继续听」点进来的
  async function openDetail(albumId, fromListen) {
    var my = ++detailSeq;
    // v0.20.0：从「继续听」点进来的，返回时要回到继续听，而不是回到上次的搜索结果
    cur.fromListen = !!fromListen;
    var aid = String(albumId);
    // 详情卡片在「发现」页内，从其它 tab 点进来要先切过去，并记住来源以便返回
    var activeTab = document.querySelector('.tab.active');
    if (!activeTab || activeTab.getAttribute('data-tab') !== 'search') {
      cur.fromTab = activeTab ? activeTab.getAttribute('data-tab') : 'search';
      document.querySelector('.tab[data-tab="search"]').click();
    }
    var TAB_NAME = { search: '发现', subs: '订阅', lib: '已导入', set: '设置' };
    $('btnBack').textContent = '← 返回' + (TAB_NAME[cur.fromTab || 'search'] || '发现');
    cur.id = String(albumId);
    cur.page = 1;
    // v0.20.3：换专辑要清掉上一本的集名筛选，否则新专辑可能一进来就「筛出 0 集」
    nameFilter = '';
    if ($('dFilter')) $('dFilter').value = '';
    $('searchCard').classList.add('hide');
    showListen(false);   // v0.20.0：详情页也不能露出「继续听」
    $('detailCard').classList.remove('hide');
    $('dName').textContent = '载入中…';
    $('dBadges').innerHTML = '';
    $('dDate').innerHTML = '';
    $('dMeta').textContent = '';
    $('dSubState').textContent = '';
    $('dIntro').textContent = '';
    $('dTracks').innerHTML = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // v0.19.4：上一张专辑的分页/统计状态必须先清掉。原来只在成功分支里重置，
    // 打开失败的专辑会残留「第 1 页 / 3」「共 9 集」，按集号跳转还会拿旧 outlinePages 算页码。
    cur.lastPage = 0;
    cur.outlinePages = [];
    cur.lastIndex = 0;
    cur.firstIndex = 1;
    cur.pageStatText = '';
    cur.hasMore = false;
    jumpDirty = false;
    if ($('dPage')) $('dPage').textContent = '第 1 页';
    if ($('dJumpTot')) $('dJumpTot').textContent = '/ —';
    if ($('dProgStat')) $('dProgStat').textContent = '';
    if ($('dJump')) $('dJump').value = '1';
    syncPageBtns();
    try {
      var r = await api('GET', '/album/' + aid);
      if (my !== detailSeq) return;   // 已经点了别的专辑，这次结果作废
      if (r.success === false) { $('dName').textContent = '❌ ' + r.error; return; }
      var d = r.data;
      cur.detail = d;
      cur.hasMore = d.hasMore;
      $('dCover').src = d.cover || '';
      $('dName').textContent = d.name || ('专辑 ' + cur.id);
      var bits = [];
      if (d.author) bits.push(d.author);
      if (d.category) bits.push(d.category);
      if (d.playCount) bits.push(fmtPlay(d.playCount) + '播放');
      if (d.subscribeCount) bits.push(fmtPlay(d.subscribeCount) + '订阅');
      $('dMeta').textContent = bits.join(' · ');
      renderAlbumBadges(d);
      renderAlbumDates(d);
      $('dIntro').textContent = d.introFull || d.intro || '（无简介）';
      $('dIntroToggle').textContent = '展开简介';
      $('dIntro').classList.remove('open');
      renderSubState(d.subscription, d.subscribed);
      await pullAlbumProgress(aid);
      if (my !== detailSeq) return;
      renderTracks(d.tracks || []);
      renderResume();
      loadLibMarks(aid);
      cur.page = 1;
      syncPageBtns();
      // v0.19.0：先把总页数取回来，页码「第 1 页 / N」和跳页范围才有意义
      await ensureLastPage();
      if (my !== detailSeq) return;
      syncPageBtns();
      // 倒序时直接翻到最后一页，最新一集在最前
      if (playOrder === 'desc' && d.hasMore) await jumpToOrderPage(true);
      else syncPageBtns();
    } catch (e) { $('dName').textContent = '加载失败: ' + e.message; }
  }

  // ---------- 本机音乐库标记 ----------
  var libAlbumCache = {};

  async function loadLibMarks(albumId) {
    try {
      var r = await api('GET', '/lib/album?albumId=' + encodeURIComponent(albumId));
      if (!r || r.success === false) return;
      libAlbumCache[String(albumId)] = r.data || {};
      var d = r.data || {};
      var tip = $('dDlTip');
      if (tip && d.total) {
        var bits = [];
        if (d.downloaded) bits.push('已下载 ' + d.downloaded + ' 集（可离线播放）');
        if (d.missing) bits.push('还差 ' + d.missing + ' 集');
        tip.innerHTML = bits.length ? ('📁 ' + escHtml(bits.join('，'))) +
          (d.missing ? ' <span class="link" id="btnFillMissing">补下缺的 ' + d.missing + ' 集</span>' : '') : '';
        var bf = $('btnFillMissing');
        if (bf) bf.addEventListener('click', fillMissing);
      }
      // 给分集列表打「已下载」标
      var items = d.items || {};
      document.querySelectorAll('#dTracks .trk').forEach(function (row) {
        var tid = row.getAttribute('data-tid');
        if (!tid) return;
        var tt = row.querySelector('.tt');
        if (!tt) return;
        var old = row.querySelector('.libmark');
        if (items[tid]) {
          if (!old) {
            var sp = document.createElement('span');
            sp.className = 'libmark';
            sp.textContent = '本地';
            sp.title = '已下载到本地：' + (items[tid].path || '');
            tt.appendChild(sp);
          }
        } else if (old) { old.remove(); }
      });
    } catch (e) { /* 静默：本地库探测失败不影响使用 */ }
  }

  async function fillMissing() {
    var d = libAlbumCache[String(cur.id)] || {};
    if (!d.missing) { msg('没有缺的集'); return; }
    if (!confirm('要补下缺的 ' + d.missing + ' 集吗？会跑到本地音乐目录，已下过的自动跳过。')) return;
    try {
      var r = await api('POST', '/lib/fill', { albumId: cur.id });
      msg(r.success ? ('⬇ ' + ((r.data && r.data.message) || '已启动')) : ('❌ ' + (r.error || '失败')), r.success ? 'ok' : 'err');
      poll();
    } catch (e) { msg('启动失败: ' + e.message, 'err'); }
  }

  // v0.20.4：「拆已听/未听」界面下线（后端 /split-heard 路由保留）

  // ---------- 听书习惯仪表盘 ----------
  async function loadDashboard() {
    var box = $('dashBody');
    if (!box) return;
    try {
      var r = await api('GET', '/dashboard');
      if (!r || r.success === false) { box.innerHTML = '<span class="err">读取失败</span>'; return; }
      var d = r.data || {};
      var st = d.streak || {};
      var ht = d.heat || {};
      var html = '<div class="dashrow">';
      html += '<div class="dash"><div class="dv">' + (st.now || 0) + '</div><div class="dl">连续天数</div></div>';
      html += '<div class="dash"><div class="dv">' + (st.best || 0) + '</div><div class="dl">最长连续</div></div>';
      html += '<div class="dash"><div class="dv">' + escHtml(d.totalText || '0 秒') + '</div><div class="dl">累计收听</div></div>';
      html += '<div class="dash"><div class="dv">' + escHtml(d.avgText || '0 秒') + '</div><div class="dl">日均（' + (d.activeDays || 0) + ' 天）</div></div>';
      html += '</div>';

      // 时段热力
      var hours = ht.hours || [];
      var maxH = 1;
      hours.forEach(function (v) { if (v > maxH) maxH = v; });
      if (hours.length) {
        html += '<div class="muted small-txt">🕐 一天里什么时候听得多' +
          (ht.peakHour >= 0 ? '（高峰 ' + ht.peakHour + ' 点）' : '') + '</div>';
        html += '<div class="heat">';
        hours.forEach(function (v, i) {
          var h = Math.max(2, Math.round((v / maxH) * 52));
          html += '<div class="hb' + (v > 0 && v >= maxH * 0.6 ? ' on' : '') + '" style="height:' + h + 'px" title="' +
            i + ' 点 · ' + fmtHM(v) + '"></div>';
        });
        html += '</div><div class="heatx"><span>0 点</span><span>6 点</span><span>12 点</span><span>18 点</span><span>23 点</span></div>';
      }

      // 听完率
      var rates = d.rates || [];
      if (rates.length) {
        html += '<div class="muted small-txt" style="margin-top:12px;">✅ 听完率</div>';
        rates.forEach(function (x) {
          html += '<div class="rate"><span class="rn">' + escHtml(x.name) + '</span>' +
            '<span class="rbar2"><span style="width:' + (x.rate || 0) + '%"></span></span>' +
            '<span class="rv">' + (x.rate || 0) + '%</span></div>';
        });
      }

      // 剩余时长
      var rm = d.remain || {};
      if (rm.items && rm.items.length) {
        html += '<div class="muted small-txt" style="margin-top:12px;">⏳ 手头的书听完还要约 ' + escHtml(rm.totalText || '') + '</div>';
        rm.items.slice(0, 5).forEach(function (x) {
          html += '<div class="rate"><span class="rn">' + escHtml(x.name) + '（还剩 ' + x.left + ' / ' + x.total + ' 集）</span>' +
            '<span class="rv" style="width:auto">' + escHtml(x.remainText) + '</span></div>';
        });
      }
      if (!rates.length && !(rm.items || []).length && !hours.length) {
        html += '<div class="muted small-txt" style="margin-top:10px;">多听几集，这里就会出现你的收听习惯。</div>';
      }
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = '<span class="err">读取失败: ' + escHtml(e.message) + '</span>';
    }
  }

  if ($('btnDashRefresh')) $('btnDashRefresh').addEventListener('click', loadDashboard);

  function renderSubState(sub, subscribed) {
    if (!subscribed || !sub) {
      $('dSubState').innerHTML = '<span class="muted">未订阅（订阅后可一键追加新集）</span>';
      $('btnSub').textContent = '订阅并跟进更新';
      return;
    }
    var txt = '已订阅，收录到第 ' + (sub.lastIndex || 0) + ' 集';
    if (sub.newCount) txt += ' · <span class="badge new">有 ' + sub.newCount + ' 集更新</span>';
    if (sub.group) txt += ' · 📁 ' + esc(sub.group);
    if (sub.lastCheckAt) txt += ' · 上次检查 ' + esc(sub.lastCheckAt);
    $('dSubState').innerHTML = '<span class="ok">●</span> ' + txt;
    $('btnSub').textContent = '取消订阅';
  }

  var curTracks = [];
  // v0.19.3：当前页真正显示出来的集（应用「只看未听」过滤之后）
  var curVisible = [];
  var nameFilter = '';   // v0.20.3：本页集名关键词筛选（长专辑里靠标题找某一集）
  var curLast = null;
  var filterUnheard = false;

  // 「共 N 集 · 本页 30 集 · 已听完 x …」——总集数来自目录，先渲染页面稍后再补
  function renderStatLine() {
    if (!$('dProgStat')) return;
    var total = cur.lastIndex ? '共 ' + cur.lastIndex + ' 集 · ' : '';
    $('dProgStat').textContent = total + (cur.pageStatText || '');
  }

  function renderTracks(tracks) {
    var el = $('dTracks');
    el.innerHTML = '';
    curTracks = sortByOrder(tracks || []);
    tracks = curTracks;
    // v0.20.3：按集名筛当前页。只在已加载的这一页里筛，翻页不清空关键词。
    if (nameFilter) {
      var kwLow = nameFilter.toLowerCase();
      tracks = tracks.filter(function (t) {
        return String(t.title || '').toLowerCase().indexOf(kwLow) >= 0;
      });
    }
    if (!tracks.length) {
      curVisible = [];
      cur.pageStatText = nameFilter ? ('筛「' + nameFilter + '」· 本页 0 集') : '本页 0 集';
      renderStatLine();
      el.innerHTML = '<span class="muted">' + (nameFilter
        ? ('本页没有集名含「' + escHtml(nameFilter) + '」的集，翻页看看')
        : '没有曲目') + '</span>';
      return;
    }
    var album = {
      id: cur.id,
      name: (cur.detail && cur.detail.name) || '',
      cover: (cur.detail && cur.detail.cover) || ''
    };

    var doneN = 0, partN = 0;
    tracks.forEach(function (t) {
      var s = trackStat(t.trackId);
      if (s === 'done') doneN += 1;
      else if (s === 'part') partN += 1;
    });
    // v0.19.3：文案拆开存，总集数要等 outline 回来才知道（syncPageBtns 里再拼一次）
    cur.pageStatText = (nameFilter ? '筛「' + nameFilter + '」· ' : '') + '本页 ' + tracks.length + ' 集 · 已听完 ' + doneN +
      (partN ? ' · 听了一半 ' + partN : '') + ' · 未听 ' + (tracks.length - doneN - partN);
    renderStatLine();

    var shown = 0;
    curVisible = [];   // v0.19.3：记录当前真正显示出来的集，「本页连播」要用它，不能播被过滤掉的已听集
    // v0.23.11：先在数组里拼好整页再一次挂载（同步 append 本就不触发中间 reflow，等价于 DocumentFragment 且兼容旧环境）
    var frag = [];
    tracks.forEach(function (t, i) {
      var state = trackStat(t.trackId);
      if (filterUnheard && state === 'done') return;
      shown += 1;
      curVisible.push(t);
      var d = document.createElement('div');
      d.className = 'trk';
      d.setAttribute('data-tid', String(t.trackId || ''));
      d.setAttribute('data-idx', String(t.index || ''));
      if (String(t.trackId) === String(curPlayingId)) d.classList.add('on');   // v0.21.1：正在播的集高亮
      // v0.18.4：仿喜马拉雅 App——封面缩略图 + 标题/元信息 + 右侧播放
      var cv = document.createElement('img');
      cv.className = 'cv';
      cv.loading = 'lazy';
      cv.src = t.cover || (cur.detail && cur.detail.cover) || '';
      cv.onerror = function () { cv.style.visibility = 'hidden'; };
      d.appendChild(cv);
      var tb = document.createElement('div');
      tb.className = 'tb';
      var tt = document.createElement('div');
      tt.className = 'tt';
      tt.textContent = t.title;
      tt.title = t.title;   // 悬停 / 长按可看完整标题
      tb.appendChild(tt);
      var tm = document.createElement('div');
      tm.className = 'tm';
      var mNo = document.createElement('span');
      mNo.textContent = '第 ' + t.index + ' 集';
      tm.appendChild(mNo);
      tm.appendChild(document.createTextNode(fmtDur(t.duration)));
      if (t.updatedAt) tm.appendChild(document.createTextNode('更新 ' + t.updatedAt));
      var pos = getPos(t.trackId);
      if (pos && pos.t) {
        var done = posDone(pos);
        var mk = document.createElement('span');
        mk.className = done ? 'ok' : '';
        mk.textContent = done ? '✓ 听完' : '⏱ 听到 ' + fmtTime(pos.t);
        if (done) mk.style.color = 'var(--ok)';
        tm.appendChild(mk);
      }
      tb.appendChild(tm);
      d.appendChild(tb);
      var du = document.createElement('span');
      du.className = 'du';
      du.style.display = 'none';   // 时长已并入元信息行，占位保留以免样式回退
      var pl = document.createElement('button');
      pl.className = 'small plain';
      pl.textContent = '▶';
      d.appendChild(du);
      d.appendChild(pl);
      // v0.19.4：和「本页连播」同一个问题 —— 过滤模式下队列里不能塞进被隐藏的已听集
      d.addEventListener('click', function () {
        var lst = (filterUnheard || nameFilter) ? curVisible : curTracks;
        var j = indexOfTrack(lst, t.trackId);
        playQueue(lst, j < 0 ? 0 : j, album);
      });
      frag.push(d);
    });
    if (shown) frag.forEach(function (d) { el.appendChild(d); });
    else {
      el.innerHTML = '<span class="muted">本页都听完了。取消勾选「只看未听」可以看到全部。</span>';
    }
    // v0.22.5：本页出来后就把最可能被点的前 3 集地址备好（打开专辑第一集基本即点即播）
    curVisible.slice(0, 3).forEach(function (t, i) { prefetchTrack(t.trackId, i === 0); });
  }

  // 单集收听状态：none 未听 / part 听了没听完 / done 已听完
  function trackStat(trackId) {
    var pos = getPos(trackId);
    if (!pos || !pos.t) return 'none';
    if (posDone(pos)) return 'done';
    return 'part';
  }

  function renderResume() {
    var bar = $('dResumeBar');
    try { curLast = JSON.parse(sGet(lastKey(cur.id)) || 'null'); } catch (e) { curLast = null; }

    if (!curLast || !curLast.trackId) {
      if (!curTracks.length) { bar.style.display = 'none'; return; }
      bar.style.display = '';
      $('btnResume').textContent = '▶ 从第 1 集开始听';
      curLast = null;
      $('btnFromStart').style.display = 'none';
      $('btnClearPos').style.display = 'none';
      return;
    }

    bar.style.display = '';
    $('btnFromStart').style.display = '';
    $('btnClearPos').style.display = '';

    var done = posDone(curLast);
    if (done) {
      // 按当前播放顺序找「下一集」：正序下一集 = 集数 +1，倒序下一集 = 集数 -1
      var step = playOrder === 'desc' ? -1 : 1;
      var nIdx = -1;
      for (var i = 0; i < curTracks.length; i++) {
        if (Number(curTracks[i].index) === Number(curLast.index) + step) { nIdx = i; break; }
      }
      // v0.19.2：存 trackId 而不是数组下标。
      // 下标绑定的是当时的 curTracks，翻页或切顺序后数组变了，点「接着听」会播成同下标的另一集。
      if (nIdx >= 0) {
        curLast._nextId = String(curTracks[nIdx].trackId);
        curLast._nextIdx = curTracks[nIdx].index;
        $('btnResume').textContent = '▶ 接着听 第 ' + curTracks[nIdx].index + ' 集';
      } else if (cur.lastIndex && Number(curLast.index) + step >= (cur.firstIndex || 1) &&
        Number(curLast.index) + step <= cur.lastIndex) {
        // v0.19.4：下一集在当前页之外（本页最后一集刚听完）。原来这里退化成「重听本集」，
        // 和 ended 的自动连播（会翻下一页）行为不一致。
        curLast._nextId = '';
        curLast._nextIdx = Number(curLast.index) + step;
        $('btnResume').textContent = '▶ 接着听 第 ' + curLast._nextIdx + ' 集';
      } else {
        curLast._nextId = '';
        curLast._nextIdx = 0;
        $('btnResume').textContent = '▶ 重听 第 ' + (curLast.index || '?') + ' 集（已听完）';
      }
    } else {
      curLast._nextId = '';
      curLast._nextIdx = 0;
      $('btnResume').textContent = '▶ 继续听 第 ' + (curLast.index || '?') + ' 集（' + fmtTime(curLast.t || 0) + '）';
    }
  }

  $('btnResume').addEventListener('click', async function () {
    var album = { id: cur.id, name: (cur.detail && cur.detail.name) || '', page: cur.page };
    if (!curLast || !curLast.trackId) {
      if (curTracks.length) playQueue(curTracks, 0, album);
      return;
    }
    // v0.19.4：下一集只在集号上（不在当前页）→ 先翻到它所在的页再定位
    if (!curLast._nextId && curLast._nextIdx) {
      var np = pageOfIndex(curLast._nextIdx);
      if (np && Number(np) !== Number(cur.page)) await gotoPage(np);
      var nj = -1;
      for (var k = 0; k < curTracks.length; k++) {
        if (Number(curTracks[k].index) === Number(curLast._nextIdx)) { nj = k; break; }
      }
      if (nj >= 0) {
        playQueue(curTracks, nj, { id: cur.id, name: (cur.detail && cur.detail.name) || '', page: cur.page });
        return;
      }
    }
    if (curLast._nextId) {
      var ni = indexOfTrack(curTracks, curLast._nextId);
      if (ni >= 0) { playQueue(curTracks, ni, album); return; }
      // 下一集不在当前页了（翻到别的页）：单独播它，进度照常续上
      playQueue([{ trackId: curLast._nextId, index: curLast._nextIdx, title: '第 ' + curLast._nextIdx + ' 集' }], 0, album);
      return;
    }
    for (var i = 0; i < curTracks.length; i++) {
      if (String(curTracks[i].trackId) === String(curLast.trackId)) { playQueue(curTracks, i, album); return; }
    }
    // 目标集不在当前页：单独播，进度照常续上
    playQueue([{ trackId: curLast.trackId, index: curLast.index, title: curLast.title }], 0, album);
  });

  $('btnFromStart').addEventListener('click', async function () {
    if (!curTracks.length) return;
    var clearAll = function (list) { (list || []).forEach(function (t) { sSet(posKey(t.trackId), ''); }); };
    clearAll(curTracks);
    sSet(lastKey(cur.id), '');
    renderTracks(curTracks);
    renderResume();
    playQueue(curTracks, 0, { id: cur.id, name: (cur.detail && cur.detail.name) || '', page: cur.page });
    msg('已清除本专辑播放进度，从第 1 集开始');
    // v0.19.4：原来只清当前页的 30 集。其它页的 xm_pos_* 还在，跨页连播到第 2 页会从中途续播，
    // 用户以为「从头听」已经清零了。这里把剩余分页也扫一遍（单页失败不影响已清的）。
    try {
      await ensureLastPage();
      var pgs = (cur.outlinePages || []).map(function (p) { return Number(p.page) || 0; })
        .filter(function (p) { return p && p !== Number(cur.page); });
      var cleared = 1;
      for (var i = 0; i < pgs.length; i++) {
        try {
          var rr = await api('GET', '/album/' + cur.id + '/tracks?page=' + pgs[i]);
          clearAll((rr && rr.data && rr.data.tracks) || []);
          cleared += 1;
        } catch (e) { /* 单页失败忽略 */ }
      }
      if (cleared > 1) msg('已清除本专辑 ' + cleared + ' 页的播放进度，从第 1 集开始');
    } catch (e) { /* */ }
  });

  $('btnClearPos').addEventListener('click', function () {
    curTracks.forEach(function (t) { sSet(posKey(t.trackId), ''); });
    sSet(lastKey(cur.id), '');
    renderTracks(curTracks);
    renderResume();
    msg('已清除播放进度');
  });

  // v0.19.0：页码状态统一出口。
  // 每页都能独立正序/倒序 —— 因为「第几页」始终是接口里的页码（按集数从小到大切好的固定分页），
  // 正序/倒序只影响**这一页内部哪一头朝上**，不会改变你停在哪一页。
  // 4 个按钮语义固定成「集数方向」：⏮ 最小集数页 / ‹ 更小的页 / › 更大的页 / ⏭ 最大集数页，
  // 文案再按当前顺序换成用户能听懂的话。
  function syncPageBtns() {
    var desc = playOrder === 'desc';
    var lastPage = cur.lastPage || 0;
    var hi = lastPage || 0;
    var atMin = cur.page <= 1;
    var atMax = hi ? cur.page >= hi : !cur.hasMore;

    if ($('dFirst')) { $('dFirst').disabled = atMin; $('dFirst').title = '第 1 页（集数最小）'; }
    if ($('dLast')) { $('dLast').disabled = hi ? atMax : !cur.hasMore; $('dLast').title = hi ? '第 ' + hi + ' 页（集数最大）' : '最后一页'; }

    if ($('dPrev')) {
      // dPrev 永远是「集数更小的那一页」
      $('dPrev').textContent = desc ? '◂ 更早' : '上一页';
      $('dPrev').title = '集数更小的那一页';
      $('dPrev').disabled = atMin;
    }
    if ($('dNext')) {
      // dNext 永远是「集数更大的那一页」
      $('dNext').textContent = desc ? '更新 ▸' : '下一页';
      $('dNext').title = '集数更大的那一页';
      $('dNext').disabled = atMax;
    }

    // 页码 + 跳页框
    var tot = hi ? hi : 0;
    if ($('dPage')) {
      $('dPage').textContent = '第 ' + cur.page + ' 页' + (tot ? ' / ' + tot : '');
    }
    // v0.19.3：右侧单位跟着跳转模式走（按集号时显示总集数）
    if ($('dJumpMode') && typeof syncJumpMode === 'function') syncJumpMode();
    else if ($('dJumpTot')) $('dJumpTot').textContent = '/ ' + (tot || '—');
    if ($('dJump')) {
      if (jumpMode === 'index') {
        if (cur.lastIndex) $('dJump').max = String(cur.lastIndex);
      } else {
        if (tot) $('dJump').max = String(tot);
        // 只有输入框没被用户动过时才回填，避免打字打到一半被覆盖
        if (!jumpDirty) $('dJump').value = String(cur.page);
      }
    }
    if ($('dJumpGo')) $('dJumpGo').disabled = !tot;
    // 目录到手后总集数才有值，这里补一次「共 N 集」
    if (typeof renderStatLine === 'function') renderStatLine();
  }

  // 取一次目录信息（总页数 + 每页集号区间）。已有就只做一次缓存。
  // v0.19.3：「跳到第 N 集」靠 pages[].min/max 精确换算出页码，不用用户自己算。
  async function ensureLastPage() {
    if (cur.lastPage) return cur.lastPage;
    try {
      var od = await api('GET', '/album/' + cur.id + '/outline');
      var data = (od && od.data) || {};
      cur.lastPage = Number(data.lastPage) || 0;
      cur.outlinePages = Array.isArray(data.pages) ? data.pages : [];
      cur.lastIndex = Number(data.lastIndex) || 0;
      cur.firstIndex = Number(data.firstIndex) || 1;
    } catch (e) { }
    return cur.lastPage || 0;
  }

  // 集号 → 页码。命中区间直接返回；集号有缺口时落到「第一个 max 大于它的页」。
  function pageOfIndex(n) {
    var pages = cur.outlinePages || [];
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      if (n >= Number(p.min) && n <= Number(p.max)) return Number(p.page) || 0;
    }
    for (var j = 0; j < pages.length; j++) {
      if (Number(pages[j].max) >= n) return Number(pages[j].page) || 0;
    }
    return cur.lastPage || 0;
  }

  // v0.19.2：翻页请求序号。连点两下按钮时 cur.page 还没变，
  // 第二次点击会算出同一个页码（等于没点）；两次请求乱序返回还会渲染错页。
  var pageSeq = 0;

  async function gotoPage(p, opts) {
    opts = opts || {};
    p = Math.floor(Number(p) || 0);
    if (!p || p < 1) return;
    var my = ++pageSeq;
    // 用户手输页码时先拿到总页数，越界就夹到边界并说明，而不是傻乎乎请求一个空页
    var clipped = false;
    if (opts.jump) {
      var tot = await ensureLastPage();
      if (my !== pageSeq) return;
      if (tot && p > tot) { p = tot; clipped = true; }
    }
    $('dTracks').innerHTML = '<span class="muted">载入中…</span>';
    try {
      var r = await api('GET', '/album/' + cur.id + '/tracks?page=' + p);
      if (my !== pageSeq) return;   // 又点了别的页，这次结果作废
      if (r.success === false) { $('dTracks').textContent = '加载失败: ' + r.error; return; }
      var list = (r.data && r.data.tracks) || [];
      // 空页兜底：接口页码比实际页数大时，回退到上一个有效页
      if (!list.length && opts.jump && p > 1) {
        msg('第 ' + p + ' 页没有内容，已回到第 ' + (p - 1) + ' 页');
        return gotoPage(p - 1);
      }
      cur.page = p;
      cur.hasMore = !!(r.data && r.data.hasMore);
      renderTracks(list);
      await ensureLastPage();
      if (my !== pageSeq) return;
      jumpDirty = false;
      syncPageBtns();
      renderResume();
      if (opts.jump) {
        if (clipped) msg('总共只有 ' + tot + ' 页，已跳到第 ' + p + ' 页');
        else msg('已跳到第 ' + p + ' 页' + (cur.lastPage ? ' / ' + cur.lastPage : ''));
      }
    } catch (e) { if (my === pageSeq) $('dTracks').textContent = '加载失败: ' + e.message; }
  }

  // v0.19.0：按钮语义 = 集数方向（与正序倒序无关）。
  // 倒序只是把「新的一头」放到列表顶上，页码本身不变，所以翻页就是单纯的 page±1。
  $('dPrev').addEventListener('click', function () { gotoPage(cur.page - 1); });
  $('dNext').addEventListener('click', function () { gotoPage(cur.page + 1); });
  if ($('dFirst')) $('dFirst').addEventListener('click', function () { gotoPage(1); });
  if ($('dLast')) $('dLast').addEventListener('click', async function () {
    var tot = await ensureLastPage();
    if (tot) gotoPage(tot);
  });
  // 跳转：支持「按页码」和「按集号」两种。
  // v0.19.3：495 集的专辑里知道「第 300 集」很正常，但没人知道它在第 10 页还是第 11 页。
  function syncJumpMode() {
    var byIdx = jumpMode === 'index';
    if ($('dJumpMode')) {
      $('dJumpMode').textContent = byIdx ? '集' : '页';
      $('dJumpMode').classList.toggle('on', byIdx);
      $('dJumpMode').title = byIdx ? '当前按集号跳转（点击切回按页码）' : '当前按页码跳转（点击切换为按集号）';
    }
    if ($('dJump')) $('dJump').placeholder = byIdx ? '集号' : '页码';
    if ($('dJumpTot')) {
      $('dJumpTot').textContent = byIdx
        ? '/ ' + (cur.lastIndex || '—')
        : '/ ' + (cur.lastPage || '—');
    }
  }
  if ($('dJumpMode')) $('dJumpMode').addEventListener('click', function () {
    jumpMode = jumpMode === 'page' ? 'index' : 'page';
    jumpDirty = true;              // 切模式后别用当前页码覆盖用户输入
    syncJumpMode();
    if ($('dJump')) $('dJump').value = '';
  });

  async function doJump() {
    var box = $('dJump');
    if (!box) return;
    var v = Math.floor(Number(String(box.value).trim()) || 0);
    if (!v || v < 1) {
      msg(jumpMode === 'index' ? '请输入要跳到的集号（从 1 开始）' : '请输入要跳到的页码（从 1 开始）', 'err');
      return;
    }
    jumpDirty = false;
    box.blur && box.blur();
    if (jumpMode === 'index') {
      await jumpToIndex(v);
      return;
    }
    await gotoPage(v, { jump: true });
  }

  // 跳到第 N 集：靠 outline 的 pages[].min/max 算出页码，落地后再滚动 + 高亮那一集
  async function jumpToIndex(n) {
    await ensureLastPage();
    var maxIdx = cur.lastIndex || 0;
    var clipped = (maxIdx && n > maxIdx);
    if (clipped) n = maxIdx;
    var p = pageOfIndex(n);
    if (!p) { msg('取不到目录，先翻一页再试', 'err'); return; }
    await gotoPage(p);
    // 目标集可能被「只看未听」过滤掉了，跳之前临时关掉，免得用户看到空落
    // v0.20.3：筛着集名时跳集，目标很可能被筛掉 → 先清筛选再定位
    if (filterUnheard || nameFilter) {
      var needRedraw = false;
      if (filterUnheard) { filterUnheard = false; if ($('ckUnheard')) $('ckUnheard').checked = false; needRedraw = true; }
      if (nameFilter) { nameFilter = ''; if ($('dFilter')) $('dFilter').value = ''; needRedraw = true; }
      if (needRedraw) renderTracks(sortByOrder(curTracks));
    }
    var el = null;
    var rows = ($('dTracks') && $('dTracks').children) || [];
    for (var i = 0; i < rows.length; i++) {
      var ds = rows[i].dataset || {};
      if (Number(ds['data-idx'] || ds.idx) === n) { el = rows[i]; break; }
    }
    // 越界提示并进最后一条 msg，否则会被「已跳到…」覆盖掉
    var prefix = clipped ? ('这本专辑只到第 ' + maxIdx + ' 集，') : '';
    if (el) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
      el.classList.add('hl');
      setTimeout(function () { el.classList.remove('hl'); }, 2600);
      msg(prefix + '已跳到第 ' + p + ' 页 · 第 ' + n + ' 集');
    } else {
      msg(prefix + '已跳到第 ' + p + ' 页（第 ' + n + ' 集不在这一页，可能已下架）', clipped ? 'err' : '');
    }
  }

  if ($('dJumpGo')) $('dJumpGo').addEventListener('click', doJump);
  if ($('dJump')) {
    $('dJump').addEventListener('input', function () { jumpDirty = true; });
    $('dJump').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.keyCode === 13) { ev.preventDefault(); doJump(); }
    });
  }
  $('ckUnheard').addEventListener('change', function () {
    filterUnheard = !!this.checked;
    renderTracks(sortByOrder(curTracks));
  });
  $('btnOrder').addEventListener('click', function () {
    setOrder(playOrder === 'desc' ? 'asc' : 'desc');
  });
  syncOrderBtn();
  // v0.20.3：详情页「筛集名」输入（本页实时过滤）
  if ($('dFilter')) {
    var dFilterTimer = null;
    $('dFilter').addEventListener('input', function () {
      var self = this;
      if (dFilterTimer) clearTimeout(dFilterTimer);
      dFilterTimer = setTimeout(function () {
        nameFilter = String(self.value || '').trim();
        if (curTracks.length) renderTracks(curTracks);
      }, 160);
    });
    $('dFilter').addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      this.value = '';
      nameFilter = '';
      if (curTracks.length) renderTracks(curTracks);
    });
  }

  $('btnPlayPage').addEventListener('click', function () {
    // v0.19.3：勾了「只看未听」时连播的应该只是看得见的那些集
    // v0.19.4：去掉 curVisible.length 兜底 —— 整页都听完时它正好是 0，
    // 兜底会让「本页连播」回落到 curTracks，把过滤掉的已听集全播一遍
    var list = (filterUnheard || nameFilter) ? curVisible : curTracks;
    if (!list.length) { msg(filterUnheard ? '本页没有未听的集' : '本页没有曲目', 'err'); return; }
    playQueue(list, 0, {
      id: cur.id, name: (cur.detail && cur.detail.name) || '',
      cover: (cur.detail && cur.detail.cover) || '', page: cur.page
    });
  });
  $('btnBack').addEventListener('click', function () {
    $('detailCard').classList.add('hide');
    // 从哪个 tab 进来就回哪个（默认搜索）；切 tab 会自动刷新该页数据
    var from = cur.fromTab || 'search';
    cur.fromTab = 'search';
    if (from === 'search') {
      if (cur.fromListen) {
        cur.fromListen = false;
        resetToDiscover();   // 从继续听进来的，原样退回继续听（别把旧搜索结果捡回来）
      } else {
        $('searchCard').classList.remove('hide');
        syncDiscover();      // 空着就回到继续听，搜过就还是结果
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    var btn = document.querySelector('.tab[data-tab="' + from + '"]');
    if (btn) btn.click(); else { $('searchCard').classList.remove('hide'); syncDiscover(); }
  });
  $('dIntroToggle').addEventListener('click', function () {
    var open = $('dIntro').classList.toggle('open');
    $('dIntroToggle').textContent = open ? '收起简介' : '展开简介';
  });

  $('btnImportDetail').addEventListener('click', function () {
    var d = cur.detail;
    doImport(cur.id, d && d.name, 0);
  });

  // v0.23.7：只导最新 N 集
  $('btnImportLatest').addEventListener('click', async function () {
    var n = Math.floor(Number($('dLatest').value) || 0);
    if (n <= 0) { msg('请填写要导最新的多少集，如 30', 'err'); return; }
    try {
      var r = await api('POST', '/import', { album_id: cur.id, latest: n, name: cur.detail && cur.detail.name });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      msg('⏳ 已开始导入最新 ' + n + ' 集《' + ((cur.detail && cur.detail.name) || '') + '》');
      startPolling();
    } catch (e) { msg('导入失败: ' + e.message, 'err'); }
  });

  $('btnImportRange').addEventListener('click', async function () {
    var s = Number($('dStart').value) || 0, e2 = Number($('dEnd').value) || 0;
    if (!s && !e2) { msg('请填写起始集或结束集', 'err'); return; }
    try {
      var r = await api('POST', '/import', { album_id: cur.id, start: s, end: e2, name: cur.detail && cur.detail.name });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      msg('⏳ 已开始按区间导入');
      startPolling();
    } catch (e) { msg('导入失败: ' + e.message, 'err'); }
  });

  $('btnSub').addEventListener('click', async function () {
    var d = cur.detail || {};
    var sub = d.subscription;
    try {
      if (d.subscribed) {
        if (!confirm('取消订阅《' + (d.name || cur.id) + '》？（歌单保留，不再自动跟进新集）')) return;
        await api('POST', '/subs/remove', { album_id: cur.id });
        d.subscribed = false;
        d.subscription = null;
        renderSubState(null, false);
        msg('已取消订阅');
        return;
      }
      if (!sub || !sub.playlistId) {
        if (!confirm('该专辑还没有对应歌单。订阅会先导入现有全部集数并建歌单，继续？')) return;
        await api('POST', '/import', { album_id: cur.id, name: d.name || '' });
        msg('⏳ 正在导入并订阅');
        startPolling();
        setTimeout(function () { openDetail(cur.id); }, 4000);
        return;
      }
      var r = await api('POST', '/subs', { album_id: cur.id, name: d.name || '' });
      d.subscribed = true;
      d.subscription = r.data;
      renderSubState(r.data, true);
      msg('✅ 已订阅', 'ok');
    } catch (e) { msg('操作失败: ' + e.message, 'err'); }
  });

  // 整本下载到本地音乐目录
  function startDownload(payload, label) {
    return api('POST', '/download', payload).then(function (r) {
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      msg('⏳ 已开始下载' + (label ? '《' + label + '》' : '') + '，进度见「已导入」页', 'ok');
      startPolling();
    }).catch(function (e) { msg('下载启动失败: ' + e.message, 'err'); });
  }

  $('btnDownload').addEventListener('click', function () {
    var d = cur.detail || {};
    var sub = d.subscription;
    if (!sub || !sub.playlistId) {
      $('dDlTip').innerHTML = '<span class="err">还没有歌单，先点「导入全部」建歌单，再下载。</span>';
      return;
    }
    if (!confirm('把《' + (d.name || cur.id) + '》整本下载到 Songloft 本地音乐目录？已下载过的集会跳过。')) return;
    startDownload({ album_id: cur.id, playlist_id: sub.playlistId, name: d.name || '' }, d.name);
  });

  // ---------- 订阅 ----------
  var subsCache = [];
  // v0.23.15：订阅分组
  var groupsCache = null;      // [{name, mode, n}]，null = 还没加载
  var sgDraft = [];            // 分组卡的编辑草稿
  var sgrpFilter = 'all';      // 'all' | ''（未分组）| 分组名
  // v0.23.16：订阅多选（albumId -> true）→ 批量设分组 / 批量开关自动同步 / 批量取消订阅
  var subSel = {};
  var subShown = [];           // 最近一次渲染出来的订阅（当前筛选范围，「全选」只作用于这里）

  async function loadSubs() {
    var el = $('subsList');
    try {
      var r = await api('GET', '/subs');
      subsCache = r.data || [];
      await ensureGroups();          // v0.23.15：分组标签与筛选要用
      // 分组被删掉后，筛选停在该分组会看到空列表 —— 自动退回「全部」
      if (sgrpFilter !== 'all' && sgrpFilter !== '' && !(groupsCache || []).some(function (g) { return g.name === sgrpFilter; })) sgrpFilter = 'all';
      renderSubsFilter();
      if (sgDraft.length) renderSgCard();   // 分组卡里的「N 张」跟着订阅走
      el.innerHTML = '';
      if (!subsCache.length) {
        el.innerHTML = '<span class="muted">还没有订阅。搜索专辑后进入详情页点「订阅并跟进更新」。</span>';
        updateSubBadge();
        subShown = []; updateSubsSelBar();
        return;
      }
      var shownSubs = sgrpFilter === 'all' ? subsCache : subsCache.filter(function (s) { return (s.group || '') === sgrpFilter; });
      if (!shownSubs.length) {
        el.innerHTML = '<span class="muted">这个分组里还没有订阅。</span>';
        updateSubBadge();
        subShown = []; updateSubsSelBar();
        return;
      }
      // v0.23.16：勾选状态只保留仍然存在的订阅；当前筛选范围记下来给「全选」用
      var alive0 = {};
      subsCache.forEach(function (s0) { alive0[String(s0.albumId)] = true; });
      Object.keys(subSel).forEach(function (k0) { if (!alive0[k0]) delete subSel[k0]; });
      subShown = shownSubs;
      shownSubs.forEach(function (s) {
        var line = document.createElement('div');
        line.className = 'line' + (subSel[String(s.albumId)] ? ' sel' : '');
        // 行首勾选框：配合顶栏「全选」做批量操作
        var ck = document.createElement('input');
        ck.type = 'checkbox';
        ck.className = 'ck';
        ck.setAttribute('data-id', String(s.albumId));
        ck.checked = !!subSel[String(s.albumId)];
        ck.title = '勾选后可批量设分组 / 开关自动同步 / 取消订阅';
        ck.addEventListener('change', function () {
          if (ck.checked) subSel[String(s.albumId)] = true;
          else delete subSel[String(s.albumId)];
          line.classList.toggle('sel', !!ck.checked);
          updateSubsSelBar();
        });
        var img = document.createElement('img');
        img.src = s.cover || '';
        img.onerror = function () { img.style.visibility = 'hidden'; };
        var body = document.createElement('div');
        body.className = 'body';
        var n = document.createElement('div');
        n.className = 'n';
        n.textContent = s.name || ('专辑' + s.albumId);
        var sub2 = document.createElement('div');
        sub2.className = 's';
        var bits = [];
        if (s.newCount) bits.push('<span class="badge new">有 ' + s.newCount + ' 集更新</span>');
        bits.push('收录到第 ' + (s.lastIndex || 0) + ' 集');
        if (s.updateDate) bits.push('专辑更新 ' + s.updateDate);
        if (s.lastCheckAt) bits.push('检查 ' + s.lastCheckAt);
        if (!s.playlistId) bits.push('<span class="err">未绑定歌单</span>');
        sub2.innerHTML = bits.join(' · ');
        // v0.23.15：分组标签放信息行最前（不会被省略号截掉），点一下改分组
        var gtag = document.createElement('span');
        gtag.className = 'gtag' + (s.group ? '' : ' none');
        gtag.textContent = '📁 ' + (s.group || '未分组');
        gtag.title = '点击改分组';
        gtag.addEventListener('click', function (ev) { ev.stopPropagation(); openGrpPick(s); });
        sub2.insertBefore(gtag, sub2.firstChild);
        sub2.insertBefore(document.createTextNode(' '), gtag.nextSibling);
        body.appendChild(n); body.appendChild(sub2);

        var ops = document.createElement('div');
        ops.className = 'ops';

        var bSync = document.createElement('button');
        bSync.className = 'small';
        bSync.textContent = '同步';
        bSync.addEventListener('click', async function () {
          bSync.disabled = true;
          try {
            var r2 = await api('POST', '/subs/check', { album_id: s.albumId, import: true });
            if (r2.success === false) { msg('❌ ' + r2.error, 'err'); }
            else {
              var d2 = r2.data || {};
              msg(d2.added ? '✅ 《' + s.name + '》新增 ' + d2.added + ' 集' : '没有新内容', d2.added ? 'ok' : '');
            }
            loadSubs();
          } catch (e) { msg('同步失败: ' + e.message, 'err'); }
          bSync.disabled = false;
        });

        var bAuto = document.createElement('button');
        bAuto.className = 'small plain';
        bAuto.textContent = s.autoSync === false ? '自动:关' : '自动:开';
        bAuto.addEventListener('click', async function () {
          await api('POST', '/subs', { album_id: s.albumId, autoSync: s.autoSync === false });
          loadSubs();
        });

        var bDel = document.createElement('button');
        bDel.className = 'small plain';
        bDel.textContent = '×';
        bDel.title = '取消订阅';
        bDel.addEventListener('click', async function () {
          if (!confirm('取消订阅《' + s.name + '》？歌单保留。')) return;
          await api('POST', '/subs/remove', { album_id: s.albumId });
          loadSubs();
        });

        ops.appendChild(bSync); ops.appendChild(bAuto); ops.appendChild(bDel);
        line.appendChild(ck); line.appendChild(img); line.appendChild(body); line.appendChild(ops);
        el.appendChild(line);
      });
      updateSubBadge();
      updateSubsSelBar();
    } catch (e) {
      el.innerHTML = '<span class="err">加载失败: ' + e.message + '</span>';
    }
  }


  // ---------- v0.23.15：订阅分组 ----------
  async function ensureGroups(force) {
    if (groupsCache && !force) return groupsCache;
    try {
      var r = await api('GET', '/groups');
      groupsCache = ((r && r.data && r.data.groups) || []).slice();
    } catch (e) { groupsCache = groupsCache || []; }
    return groupsCache;
  }

  function renderSubsFilter() {
    var box = $('subsFilter');
    if (!box) return;
    var counts = { '': 0 };
    (groupsCache || []).forEach(function (g) { counts[g.name] = 0; });
    subsCache.forEach(function (s) {
      var k = (s.group && counts[s.group] !== undefined) ? s.group : '';
      counts[k] = (counts[k] || 0) + 1;
    });
    box.innerHTML = '';
    var items = [{ key: 'all', label: '全部', n: subsCache.length }, { key: '', label: '未分组', n: counts[''] || 0 }];
    (groupsCache || []).forEach(function (g) { items.push({ key: g.name, label: g.name, n: counts[g.name] || 0 }); });
    if (items.length <= 2 && !(groupsCache || []).length) { box.innerHTML = ''; return; }
    items.forEach(function (it) {
      var c = document.createElement('span');
      c.className = 'chip' + (sgrpFilter === it.key ? ' on' : '');
      c.textContent = it.label + ' ' + it.n;
      c.addEventListener('click', function () { sgrpFilter = it.key; subSel = {}; loadSubs(); });
      box.appendChild(c);
    });
  }

  // 分组卡：名字 + 同步范围（跟随全局 / 只同步最新 N 集 / 同步全集）
  async function loadSubGroups() {
    var box = $('sgList');
    if (!box) return;
    await ensureGroups(true);
    // v0.23.17：连同步方式一起带进草稿（开关 / 时间 / 内容 / 上次跑的时间）
    sgDraft = (groupsCache || []).map(function (g) {
      return {
        name: g.name, mode: g.mode, n: g.n,
        auto: g.auto || 'global', time: g.time || '', import: g.import || 'global',
        lastRunDate: g.lastRunDate || ''
      };
    });
    renderSgCard();
  }

  // v0.23.18：折叠态摘要，一眼看清这组怎么同步
  function sgSummary(g) {
    var bits = [];
    if (g.mode === 'all') bits.push('同步全集');
    else if (g.mode === 'latest') bits.push('最新 ' + (g.n || 20) + ' 集');
    else bits.push('范围随全局');
    if (g.auto === 'off') bits.push('仅手动');
    else bits.push('自动' + (g.time ? ' ' + g.time : '（全局时间）'));
    if (g.import === 'check') bits.push('只检查');
    return bits.join(' · ');
  }

  function renderSgCard() {
    var box = $('sgList');
    if (!box) return;
    var counts = {};
    subsCache.forEach(function (s) { var k = s.group || ''; counts[k] = (counts[k] || 0) + 1; });
    box.innerHTML = '';
    if (!sgDraft.length) {
      box.innerHTML = '<div class="muted small-txt">还没有分组。下面输入名字加一个，比如「英语听力」「睡前故事」。</div>';
      return;
    }
    sgDraft.forEach(function (g, i) {
      var row = document.createElement('div');
      row.className = 'sgrow';
      var nm = document.createElement('div');
      nm.className = 'sgn';
      nm.textContent = g.name;
      if (g.lastRunDate) nm.title = '上次自动同步：' + g.lastRunDate;
      var cnt = document.createElement('span');
      cnt.className = 'muted small-txt';
      cnt.textContent = ' ' + (counts[g.name] || 0) + ' 张';
      nm.appendChild(cnt);

      // v0.23.18：摘要 + 展开/收起
      var sum = document.createElement('span');
      sum.className = 'sgsum';
      sum.textContent = sgSummary(g);

      var bEdit = document.createElement('button');
      bEdit.className = 'small plain sgbtn';
      bEdit.textContent = g._open ? '收起' : '编辑';
      bEdit.title = '展开或收起这一组的同步设置';
      bEdit.addEventListener('click', function () {
        g._open = !g._open;
        renderSgCard();
      });

      // v0.23.17：立即同步这一组（按该组的「内容」决定导入还是只检查）
      var bRun = document.createElement('button');
      bRun.className = 'small plain sgbtn';
      bRun.textContent = '同步';
      bRun.title = '立即按这个分组自己的方式同步一次';
      bRun.addEventListener('click', async function () {
        bRun.disabled = true;
        try {
          var r = await api('POST', '/groups/sync', { name: g.name });
          if (r && r.success === false) msg('❌ ' + (r.error || '同步启动失败'), 'err');
          else { msg('⏳ 正在同步「' + g.name + '」' + (g.import === 'check' ? '（只检查）' : '')); startPolling(); }
        } catch (e) { msg('同步失败: ' + e.message, 'err'); }
        bRun.disabled = false;
      });

      var del = document.createElement('button');
      del.className = 'small plain sgbtn';
      del.textContent = '×';
      del.title = '删除分组（里面的订阅回到未分组）';
      del.addEventListener('click', function () {
        if (!confirm('删除分组「' + g.name + '」？组里的订阅会回到未分组，订阅本身不会删。\n（点「保存分组设置」后生效）')) return;
        sgDraft.splice(i, 1);
        renderSgCard();
      });

      // 第二行：同步范围 + 同步方式（自动同步开关 / 时间 / 内容）
      var opt = document.createElement('div');
      opt.className = 'sgopt';
      // v0.23.18：默认收起，点「编辑」展开，行首只留一行摘要
      opt.style.display = g._open ? '' : 'none';

      var lb1 = document.createElement('label');
      lb1.textContent = '范围';

      var sel = document.createElement('select');
      sel.className = 'sgs';
      [['global', '跟随全局'], ['latest', '只同步最新 N 集'], ['all', '同步全集']].forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        sel.appendChild(op);
      });
      sel.value = g.mode || 'global';

      var num = document.createElement('input');
      num.type = 'number'; num.min = '1'; num.max = '2000'; num.className = 'sgnum';
      num.value = g.n || 20;
      num.disabled = (g.mode || 'global') !== 'latest';
      num.title = g.mode === 'latest' ? '只同步最新多少集' : '选「只同步最新 N 集」时可填';

      sel.addEventListener('change', function () {
        g.mode = sel.value;
        num.disabled = g.mode !== 'latest';
        sum.textContent = sgSummary(g);
      });
      num.addEventListener('input', function () { g.n = Math.floor(Number(num.value) || 0); sum.textContent = sgSummary(g); });

      var lb2 = document.createElement('label');
      lb2.textContent = '自动同步';

      var autoSel = document.createElement('select');
      autoSel.className = 'sgs';
      [['global', '跟随全局'], ['on', '开'], ['off', '关']].forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        autoSel.appendChild(op);
      });
      autoSel.value = g.auto || 'global';
      autoSel.title = '「关」= 只在你手动点同步时才跑';

      var timeInp = document.createElement('input');
      timeInp.type = 'time';
      timeInp.className = 'sgtime';
      timeInp.value = g.time || '';
      timeInp.disabled = (g.auto || 'global') === 'off';
      timeInp.title = '这一组每天几点自动同步；留空 = 跟随上面「每天几点检查」';

      autoSel.addEventListener('change', function () {
        g.auto = autoSel.value;
        timeInp.disabled = g.auto === 'off';
        sum.textContent = sgSummary(g);
      });
      timeInp.addEventListener('change', function () { g.time = timeInp.value || ''; sum.textContent = sgSummary(g); });

      var lb3 = document.createElement('label');
      lb3.textContent = '新集';

      var impSel = document.createElement('select');
      impSel.className = 'sgs';
      [['global', '自动导入'], ['check', '只检查不导入']].forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        impSel.appendChild(op);
      });
      impSel.value = (g.import === 'check') ? 'check' : 'global';
      impSel.title = '「只检查」= 只标记有 N 集更新，不往歌单里加';
      impSel.addEventListener('change', function () { g.import = impSel.value; sum.textContent = sgSummary(g); });

      opt.appendChild(lb1); opt.appendChild(sel); opt.appendChild(num);
      opt.appendChild(lb2); opt.appendChild(autoSel); opt.appendChild(timeInp);
      opt.appendChild(lb3); opt.appendChild(impSel);

      row.appendChild(nm); row.appendChild(sum); row.appendChild(bRun); row.appendChild(bEdit); row.appendChild(del);
      row.appendChild(opt);
      box.appendChild(row);
    });
  }

  // ---------- v0.23.16：多选 / 全选 + 批量操作 ----------
  function subSelList() {
    var ids = [];
    Object.keys(subSel).forEach(function (k) {
      if (!subSel[k]) return;
      for (var i = 0; i < subsCache.length; i++) {
        if (String(subsCache[i].albumId) === String(k)) { ids.push(String(k)); return; }
      }
    });
    return ids;
  }

  function subSelObjects() {
    var out = [];
    subSelList().forEach(function (id) {
      for (var i = 0; i < subsCache.length; i++) {
        if (String(subsCache[i].albumId) === id) { out.push(subsCache[i]); return; }
      }
    });
    return out;
  }

  // 批量条：全选框只针对「当前筛选可见」的订阅；已选数量 / 按钮可用性跟着走
  function updateSubsSelBar() {
    var bar = $('subsSelBar');
    if (!bar) return;
    bar.classList.toggle('hide', !(subsCache || []).length);
    var ids = subSelList();
    if ($('subsSelCount')) $('subsSelCount').textContent = '已选 ' + ids.length + ' / ' + (subShown || []).length;
    var all = $('subsCkAll');
    if (all) {
      var nShown = 0, nOn = 0;
      (subShown || []).forEach(function (s) { nShown += 1; if (subSel[String(s.albumId)]) nOn += 1; });
      all.checked = nShown > 0 && nOn === nShown;
      // 部分选中显示半选框，避免「全选了却还有几张没动」的错觉
      all.indeterminate = nOn > 0 && nOn < nShown;
    }
    ['btnSubsGroup', 'subsBulkAuto', 'btnSubsUnsub'].forEach(function (id2) {
      var el = $(id2);
      if (el) el.disabled = ids.length === 0;
    });
  }

  function bindSubsMultiUI() {
    if (!$('subsCkAll')) return;
    $('subsCkAll').addEventListener('change', function () {
      var on = $('subsCkAll').checked;
      (subShown || []).forEach(function (s) {
        if (on) subSel[String(s.albumId)] = true;
        else delete subSel[String(s.albumId)];
      });
      loadSubs();   // 重渲染回填勾选态（全选范围 = 当前筛选看到的这些）
    });
    if ($('btnSubsGroup')) {
      $('btnSubsGroup').addEventListener('click', function () {
        var list = subSelObjects();
        if (!list.length) { msg('先勾选订阅', 'warn'); return; }
        openGrpPick(list);
      });
    }
    if ($('subsBulkAuto')) {
      $('subsBulkAuto').addEventListener('change', async function () {
        var v = $('subsBulkAuto').value;
        if (!v) return;
        var ids = subSelList();
        if (!ids.length) { msg('先勾选订阅', 'warn'); $('subsBulkAuto').value = ''; return; }
        var on = v === '1';
        try {
          var r = await api('POST', '/subs/bulk', { albumIds: ids, autoSync: on });
          if (r && r.success === false) { msg('❌ ' + (r.error || '设置失败'), 'err'); return; }
          msg('✅ ' + ((r.data && r.data.updated) || ids.length) + ' 张订阅已' + (on ? '开启' : '关闭') + '自动同步');
          $('subsBulkAuto').value = '';
          loadSubs();
        } catch (e) { msg('设置失败: ' + e.message, 'err'); $('subsBulkAuto').value = ''; }
      });
    }
    if ($('btnSubsUnsub')) {
      $('btnSubsUnsub').addEventListener('click', async function () {
        var ids = subSelList();
        if (!ids.length) { msg('先勾选订阅', 'warn'); return; }
        if (!confirm('取消订阅 ' + ids.length + ' 张专辑？\n（只是不再跟更，已导入的歌单不会删）')) return;
        try {
          var r = await api('POST', '/subs/unsub', { albumIds: ids });
          if (r && r.success === false) { msg(r.error || '操作失败', 'err'); return; }
          msg('✅ 已取消 ' + ((r.data && r.data.removed) || ids.length) + ' 张订阅');
          subSel = {};
          loadSubs();
          if ($('grpBody')) loadGroups();
        } catch (e) { msg('操作失败: ' + e.message, 'err'); }
      });
    }
  }

  // 改分组（底部选择面板）——支持单张订阅对象，也支持多选后的数组
  function openGrpPick(s) {
    var panel = $('gpPanel');
    if (!panel) return;
    if (!(groupsCache || []).length) { msg('还没有分组，先在「🗂 订阅分组」里建一个'); return; }
    var isBulk = Array.isArray(s);
    var list = (isBulk ? s : [s]).filter(Boolean);
    if (!list.length) { msg('先勾选订阅', 'warn'); return; }
    var ids = list.map(function (x) { return String(x.albumId); });
    // 多张时只有全部还在同一个组才高亮该组，否则不高亮（免得误以为已经属于别的组）
    var sameGroup = true;
    for (var gi = 1; gi < list.length; gi++) if ((list[gi].group || '') !== (list[0].group || '')) { sameGroup = false; break; }
    var curGroup = sameGroup ? (list[0].group || '') : null;
    $('gpTitle').textContent = list.length === 1
      ? ('《' + (list[0].name || list[0].albumId) + '》归到哪个分组')
      : ('把选中的 ' + list.length + ' 张订阅归到哪个分组');
    var box = $('gpBody');
    box.innerHTML = '';
    var opts = [{ name: '', label: '未分组（跟随全局设置）' }].concat((groupsCache || []).map(function (g) {
      var how = g.mode === 'all' ? '同步全集' : (g.mode === 'latest' ? '只同步最新 ' + g.n + ' 集' : '跟随全局');
      return { name: g.name, label: g.name + ' · ' + how };
    }));
    opts.forEach(function (o) {
      var b = document.createElement('button');
      b.className = 'small plain gpopt' + (curGroup !== null && curGroup === o.name ? ' on' : '');
      b.textContent = o.label;
      b.addEventListener('click', async function () {
        try {
          var payload = list.length === 1 ? { album_id: ids[0], group: o.name } : { albumIds: ids, group: o.name };
          var rr = await api('POST', '/subs/group', payload);
          if (rr && rr.success === false) { msg('❌ ' + (rr.error || '改分组失败'), 'err'); return; }
          panel.classList.remove('show');
          var nmv = (rr && rr.data && rr.data.moved) || list.length;
          msg(o.name ? ('✅ ' + nmv + ' 张已归到「' + o.name + '」') : ('✅ ' + nmv + ' 张已移出分组'));
          loadSubs();
          if ($('grpBody')) loadGroups();
        } catch (e) { msg('改分组失败: ' + e.message, 'err'); }
      });
      box.appendChild(b);
    });
    panel.classList.add('show');
    panel.onclick = function (e) { if (e.target === panel) panel.classList.remove('show'); };
    $('gpClose').onclick = function () { panel.classList.remove('show'); };
    $('gpCancel').onclick = function () { panel.classList.remove('show'); };
  }

  function bindSubGroupUI() {
    if ($('btnSgAdd')) {
      $('btnSgAdd').addEventListener('click', function () {
        var el = $('sgNewName');
        var nm = String(el.value || '').replace(/\s+/g, ' ').trim();
        if (!nm) { msg('请填写分组名', 'err'); return; }
        nm = nm.slice(0, 24);
        if (sgDraft.some(function (g) { return g.name === nm; })) { msg('已经有同名分组了', 'err'); return; }
        if (sgDraft.length >= 50) { msg('分组最多 50 个', 'err'); return; }
        sgDraft.push({ name: nm, mode: 'global', n: 20, auto: 'global', time: '', import: 'global', lastRunDate: '' });
        el.value = '';
        renderSgCard();
      });
      $('sgNewName').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnSgAdd').click(); });
    }
  }

  function updateSubBadge() {
    var n = 0;
    subsCache.forEach(function (s) { if (s.newCount) n += 1; });
    $('subBadge').innerHTML = n ? '<span class="badge new">' + n + '</span>' : '';
  }

  // ---------- 我的订阅（喜马拉雅账号里的订阅） ----------
  var meSubs = [], meSel = {}, meLoaded = false;
  var mePage = 1, meHasMore = false, meTotal = 0;

  function meUpdateSel() {
    var ids = Object.keys(meSel).filter(function (k) { return meSel[k]; });
    $('meSelBar').classList.toggle('hide', meSubs.length === 0);
    $('meSelCount').textContent = '已选 ' + ids.length;
    $('btnMeImport').disabled = ids.length === 0;
    $('btnMeSub').disabled = ids.length === 0;
    $('meCkAll').checked = meSubs.length > 0 && ids.length === meSubs.length;
  }

  function renderMeSubs(list, keepSel) {
    var el = $('meSubsList');
    el.innerHTML = '';
    meSubs = list || [];
    if (!keepSel) meSel = {};
    if (!meSubs.length) {
      el.innerHTML = '<span class="muted">没有读到订阅专辑。</span>';
      meUpdateSel();
      return;
    }
    meSubs.forEach(function (a) {
      var item = document.createElement('div');
      item.className = 'res-item';

      var ck = document.createElement('input');
      ck.type = 'checkbox';
      ck.className = 'ck';
      // v0.19.2：加载更多会整表重建，勾选状态必须回填。
      // 原来不回填 → 界面全空着但 meSel 还留着，「导入所选」作用到看不见的专辑。
      ck.checked = !!meSel[a.id];
      ck.addEventListener('change', function () { meSel[a.id] = ck.checked; meUpdateSel(); });

      var img = document.createElement('img');
      img.src = a.cover || '';
      img.onerror = function () { img.style.visibility = 'hidden'; };

      var body = document.createElement('div');
      body.className = 'body';
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = a.title;
      var m = document.createElement('div');
      m.className = 'm';
      var bits = [];
      if (a.subscribed) bits.push('<span class="badge">已跟进</span>');
      else if (a.playlistId) bits.push('<span class="badge gray">已导入</span>');
      if (a.isPaid) bits.push('VIP/付费');
      if (a.author) bits.push(escHtml(a.author));
      if (a.tracks) bits.push(a.tracks + '集');
      if (a.lastIndex) bits.push('已收录 ' + a.lastIndex);
      if (a.updateDate) bits.push('更新 ' + escHtml(a.updateDate));
      if (a.latest) bits.push('最新：' + escHtml(a.latest));
      m.innerHTML = bits.join(' · ');
      body.appendChild(t); body.appendChild(m);
      body.addEventListener('click', function () {
        document.querySelector('.tab[data-tab="search"]').click();
        openDetail(a.id);
      });

      var acts = document.createElement('div');
      acts.className = 'acts';
      var bImp = document.createElement('button');
      bImp.className = 'small';
      bImp.textContent = a.playlistId ? '已在库' : '导入';
      bImp.disabled = !!a.playlistId;
      bImp.addEventListener('click', function () { doImport(a.id, a.title, a.tracks); });
      var bSub = document.createElement('button');
      bSub.className = 'small plain';
      bSub.textContent = a.subscribed ? '已订阅' : '跟进';
      bSub.disabled = !!a.subscribed;
      bSub.addEventListener('click', async function () {
        bSub.disabled = true;
        try {
          var r = await api('POST', '/subs', { album_id: String(a.id), name: a.title });
          msg(r.success === false ? '❌ ' + r.error : '✅ 已订阅《' + a.title + '》', r.success === false ? 'err' : 'ok');
          a.subscribed = true;
          loadSubs();
        } catch (e) { msg('订阅失败: ' + e.message, 'err'); }
      });
      acts.appendChild(bImp); acts.appendChild(bSub);

      item.appendChild(ck); item.appendChild(img); item.appendChild(body); item.appendChild(acts);
      el.appendChild(item);
    });
    if (meHasMore) {
      var more = document.createElement('div');
      more.style.cssText = 'text-align:center;margin-top:10px;';
      var bMore = document.createElement('button');
      bMore.className = 'small plain';
      bMore.textContent = '加载更多（已显示 ' + meSubs.length + (meTotal ? ' / ' + meTotal : '') + '）';
      bMore.addEventListener('click', function () {
        bMore.disabled = true;
        loadMySubs(false, mePage + 1);
      });
      more.appendChild(bMore);
      el.appendChild(more);
    }
    meUpdateSel();
  }

  async function loadMySubs(force, page) {
    page = page || 1;
    var st = $('meStatus');
    st.innerHTML = '<span class="muted">读取中…</span>';
    try {
      var r = await api('GET', '/me/subs?page=' + page + (force ? '&refresh=1' : ''));
      var d = (r && r.data) || {};
      if (r && r.success === false) {
        if (r.needLogin) {
          st.innerHTML = '<span class="err">未登录或登录态已失效</span> <span class="muted">· 请到「设置」粘贴网页版 Cookie 后重试（' + escHtml(r.error || '') + '）</span>';
        } else {
          st.innerHTML = '<span class="err">读取失败：' + escHtml(r.error || '未知错误') + '</span>';
        }
        $('meSubsList').innerHTML = '';
        meSubs = []; meLoaded = false; meUpdateSel();
        return;
      }
      var u = d.user || {};
      var head = '<span class="ok">●</span> ' + escHtml(u.nickname || u.uid || '已登录');
      if (u.uid) head += ' <span class="muted">(uid ' + escHtml(u.uid) + ')</span>';
      head += ' <span class="muted">· ' + (d.total ? '共 ' + d.total + ' 张订阅专辑' : '读到 ' + (d.albums || []).length + ' 张') + '</span>';
      if (d.source) head += ' <span class="muted">· 接口：' + escHtml(d.source) + '</span>';
      st.innerHTML = head;
      meLoaded = true;
      mePage = Number(d.page) || page;
      meHasMore = !!d.hasMore;
      meTotal = Number(d.total) || 0;
      var merged = page > 1 ? meSubs.concat(d.albums || []) : (d.albums || []);
      // 追加时按 id 去重，避免接口重复分页
      var seen = {}, uniq = [];
      merged.forEach(function (a) {
        if (!a || !a.id || seen[a.id]) return;
        seen[a.id] = 1;
        uniq.push(a);
      });
      renderMeSubs(uniq, page > 1);
    } catch (e) {
      st.innerHTML = '<span class="err">读取失败: ' + escHtml(e.message) + '</span>';
    }
  }

  $('btnLoadMySubs').addEventListener('click', function () { loadMySubs(false); });
  $('btnRefreshMySubs').addEventListener('click', function () { loadMySubs(true); });
  $('btnGoSet').addEventListener('click', function () {
    document.querySelector('.tab[data-tab="set"]').click();
  });
  $('meCkAll').addEventListener('change', function () {
    var on = $('meCkAll').checked;
    document.querySelectorAll('#meSubsList .ck').forEach(function (c, i) {
      c.checked = on;
      if (meSubs[i]) meSel[meSubs[i].id] = on;
    });
    meUpdateSel();
  });

  $('btnMeImport').addEventListener('click', async function () {
    var albums = meSubs.filter(function (a) { return meSel[a.id]; });
    if (!albums.length) return;
    if (albums.length > 3 && !confirm('将导入 ' + albums.length + ' 张专辑，耗时可能较长，继续？')) return;
    try {
      var r = await api('POST', '/import-multi', {
        albums: albums.map(function (a) { return { id: String(a.id), name: a.title }; }),
        mode: $('meSelMode').value,
        name: ''
      });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      msg('⏳ ' + r.data.message);
      startPolling();
      setTimeout(function () { loadMySubs(true); }, 3000);
    } catch (e) { msg('导入失败: ' + e.message, 'err'); }
  });

  $('btnMeSub').addEventListener('click', async function () {
    var albums = meSubs.filter(function (a) { return meSel[a.id] && !a.subscribed; });
    if (!albums.length) { msg('所选专辑都已经在跟进列表里了'); return; }
    if (!confirm('把所选 ' + albums.length + ' 张专辑加入跟进列表（不导入现有集数）？')) return;
    var ok = 0, bad = 0;
    for (var i = 0; i < albums.length; i++) {
      try {
        var r = await api('POST', '/subs', { album_id: String(albums[i].id), name: albums[i].title });
        if (r && r.success !== false) ok += 1; else bad += 1;
      } catch (e) { bad += 1; }
    }
    msg('✅ 已订阅 ' + ok + ' 张' + (bad ? '，失败 ' + bad + ' 张' : ''), bad ? 'err' : 'ok');
    loadSubs();
    loadMySubs(true);
  });

  async function loadAuto() {
    try {
      var r = await api('GET', '/config');
      var a = (r.data && r.data.auto) || {};
      $('autoEnabled').value = a.enabled ? '1' : '0';
      $('autoTime').value = a.time || '08:30';
      // v0.23.7：自动导入范围
      var aLl = Number(a.latestLimit) || 0;
      $('autoLatest').value = aLl > 0 ? '1' : '0';
      $('autoLatestN').value = aLl > 0 ? aLl : 10;
      // v0.23.14：旧集自动清理
      var aKl = Number(a.keepLatest) || 0;
      $('autoKeep').value = aKl > 0 ? '1' : '0';
      $('autoKeepN').value = aKl > 0 ? aKl : 10;
    } catch (e) { /* */ }
  }

  // v0.23.18：默认设置与分组都在同一张卡里，「保存设置」一次全存，不再分两个按钮
  $('btnSaveAuto').addEventListener('click', async function () {
    var btn = $('btnSaveAuto');
    btn.disabled = true;
    try {
      var aLlOn = $('autoLatest').value === '1';
      var aLlN = Math.floor(Number($('autoLatestN').value) || 0);
      var aKlOn = $('autoKeep').value === '1';
      var aKlN = Math.floor(Number($('autoKeepN').value) || 0);
      await api('POST', '/config', {
        auto: {
          enabled: $('autoEnabled').value === '1',
          time: $('autoTime').value || '08:30',
          latestLimit: aLlOn ? Math.max(1, Math.min(aLlN, 500)) : 0,
          keepLatest: aKlOn ? Math.max(1, Math.min(aKlN, 2000)) : 0
        }
      });
      var gn = 0, mvTxt = '';
      if (Array.isArray(groupsCache)) {
        var payload = sgDraft.map(function (g) {
          var n = Math.floor(Number(g.n) || 0);
          return {
            name: g.name, mode: g.mode, n: n > 0 ? n : 20,
            auto: g.auto || 'global', time: g.time || '', import: g.import || 'global',
            lastRunDate: g.lastRunDate || ''
          };
        });
        var r2 = await api('POST', '/groups', { groups: payload });
        if (r2 && r2.success === false) {
          msg('❌ 分组没存上：' + (r2.error || '保存失败') + '（默认设置已保存）', 'err');
          btn.disabled = false;
          return;
        }
        gn = payload.length;
        var mv = (r2.data && r2.data.moved) || 0;
        if (mv) mvTxt = '，' + mv + ' 张订阅回到未分组';
        await loadSubGroups();
      }
      msg('✅ 设置已保存' + (gn ? '（' + gn + ' 个分组' + mvTxt + '）' : ''), 'ok');
      loadSubs();
    } catch (e) { msg('保存失败: ' + e.message, 'err'); }
    btn.disabled = false;
  });

  // v0.19.4：后端 /sync、/subs/check（全量）改成异步立即返回 —— 订阅一多就必然撞宿主 60s 上限，
  // 原来前端拿超时、用户重复点。这里轮询 /status 等它跑完，再读 lastSync 展示结果。
  async function waitSyncDone(before) {
    var sawOn = false;
    for (var i = 0; i < 150; i++) {
      await new Promise(function (res) { setTimeout(res, 2000); });
      var st = await api('GET', '/status');
      var d = (st && st.data) || {};
      if (d.syncing) { sawOn = true; continue; }
      var at = (d.lastSync || {}).at || '';
      if (sawOn || (at && at !== before)) return d;
      if (i >= 3) return d;   // 4 轮（8 秒）都没看到开始，多半是秒完成
    }
    return null;
  }

  $('btnSyncAll').addEventListener('click', async function () {
    msg('⏳ 正在同步全部订阅…');
    try {
      var s0 = await api('GET', '/status');
      var before = ((s0 && s0.data && s0.data.lastSync) || {}).at || '';
      var r = await api('POST', '/sync', { import: true });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      var d0 = await waitSyncDone(before);
      if (!d0) { msg('⏳ 同步还在跑，稍后回来看订阅列表', ''); return; }
      msg('✅ ' + (((d0.lastSync || {}).result) || '同步完成'), 'ok');
      if (d0.subs) subsCache = d0.subs;
      loadSubs();
    } catch (e) { msg('同步失败: ' + e.message, 'err'); }
  });

  $('btnCheckAll').addEventListener('click', async function () {
    msg('⏳ 正在检查更新（不导入）…');
    try {
      var sc0 = await api('GET', '/status');
      var cbefore = ((sc0 && sc0.data && sc0.data.lastSync) || {}).at || '';
      var r = await api('POST', '/subs/check', { import: false });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      var dc = await waitSyncDone(cbefore);
      if (!dc) { msg('⏳ 检查还在跑，稍后回来看订阅列表', ''); return; }
      msg('检查完成：' + (((dc.lastSync || {}).result) || '订阅列表已更新'), 'ok');
      if (dc.subs) subsCache = dc.subs;
      loadSubs();
    } catch (e) { msg('检查失败: ' + e.message, 'err'); }
  });

  // ---------- 收听报告 ----------
  var rpPeriod = 'week';
  var lastReport = null;   // v0.18.0：最近一次报告数据，供导出

  function fmtHM(sec) {
    var n = Math.round(Number(sec) || 0);
    var h = Math.floor(n / 3600), m = Math.round((n % 3600) / 60);
    if (h > 0) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
    if (m > 0) return m + ' 分钟';
    return n + ' 秒';
  }

  // v0.20.1：播放统计总览（今日 / 本周 / 累计 / 连续天数），一次请求
  async function loadOverview() {
    var el = $('rpOverview');
    if (!el) return;
    try {
      var r = await api('GET', '/report/overview');
      var d = (r && r.data) || {};
      el.style.display = 'flex';
      el.innerHTML =
        '<div class="stat"><div class="sv">' + esc(fmtHM(d.daySec)) + '</div><div class="sl">今日' + (d.dayFin ? ' · ' + d.dayFin + ' 集' : '') + '</div></div>' +
        '<div class="stat"><div class="sv">' + esc(fmtHM(d.weekSec)) + '</div><div class="sl">本周' + (d.weekFin ? ' · ' + d.weekFin + ' 集' : '') + '</div></div>' +
        '<div class="stat"><div class="sv">' + esc(fmtHM(d.allSec)) + '</div><div class="sl">累计' + (d.allFin ? ' · ' + d.allFin + ' 集' : '') + '</div></div>' +
        '<div class="stat"><div class="sv">' + (d.streakNow || 0) + ' 天</div><div class="sl">连续（最长 ' + (d.streakBest || 0) + ' 天）</div></div>';
    } catch (e) { el.style.display = 'flex'; el.innerHTML = '<span class="err">总览加载失败: ' + esc(e.message) + '</span>'; }
  }

  async function loadReport(period) {
    rpPeriod = period || rpPeriod;
    var el = $('rpBody');
    if (!el) return;
    document.querySelectorAll('.rpBtn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-period') === rpPeriod);
    });
    el.innerHTML = '<span class="muted">统计中…</span>';
    try {
      var r = await api('GET', '/report?period=' + rpPeriod);
      if (r.success === false) { el.innerHTML = '<span class="err">' + esc(r.error) + '</span>'; return; }
      var d = r.data || {};
      lastReport = d;   // 缓存给导出用
      var html = '';
      html += '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px;">';
      html += '<div class="stat"><div class="sv">' + esc(fmtHM(d.sec)) + '</div><div class="sl">' + esc(d.label) + '收听</div></div>';
      html += '<div class="stat"><div class="sv">' + (d.days || 0) + '</div><div class="sl">收听天数</div></div>';
      html += '<div class="stat"><div class="sv">' + (d.finished || 0) + '</div><div class="sl">听完集数</div></div>';
      html += '<div class="stat"><div class="sv">' + esc(fmtHM(d.avgSec)) + '</div><div class="sl">日均</div></div>';
      html += '</div>';
      html += '<div class="muted small-txt" style="margin-bottom:10px;">' + esc(d.text) + '</div>';

      // 每日柱状
      var daily = d.daily || [];
      if (daily.length) {
        var max = 1;
        daily.forEach(function (x) { if (x.sec > max) max = x.sec; });
        html += '<div class="bars">';
        var shown = daily.slice(-30);
        shown.forEach(function (x) {
          var h = Math.max(2, Math.round(x.sec * 100 / max));
          html += '<div class="bar" title="' + esc(x.day + ' · ' + fmtHM(x.sec)) + '">' +
            '<div class="bfill" style="height:' + h + '%"></div></div>';
        });
        html += '</div>';
        html += '<div class="bardates"><span>' + esc(shown[0].day) + '</span>' +
          '<span>最近 ' + shown.length + ' 天 · 柱高 = 当天时长</span>' +
          '<span>' + esc(shown[shown.length - 1].day) + '</span></div>';
      }

      // 专辑排行
      var top = d.top || [];
      if (top.length) {
        html += '<div style="margin-top:12px;"><b style="font-size:13px;">听得最多</b></div>';
        top.forEach(function (a, i) {
          var pct = d.sec ? Math.round(a.sec * 100 / d.sec) : 0;
          html += '<div class="rank">' +
            '<span class="rn">' + (i + 1) + '</span>' +
            '<span class="rt">' + esc(a.name) + '</span>' +
            '<span class="rp2">' + esc(fmtHM(a.sec)) + '</span>' +
            '<span class="rbar"><span style="width:' + pct + '%"></span></span>' +
            '</div>';
        });
      }
      el.innerHTML = html;
    } catch (e) { el.innerHTML = '<span class="err">加载失败: ' + esc(e.message) + '</span>'; }
  }

  if ($('rpBody')) {
    document.querySelectorAll('.rpBtn').forEach(function (b) {
      b.addEventListener('click', function () { loadReport(b.getAttribute('data-period')); });
    });
    $('btnRpReset').addEventListener('click', async function () {
      if (!confirm('清空所有收听统计？（不影响播放进度）')) return;
      await api('POST', '/report/reset', {});
      msg('统计已清空');
      loadOverview();
      loadReport(rpPeriod);
    });
    // v0.18.0：报告导出 Markdown
    $('btnRpExport').addEventListener('click', function () {
      if (!lastReport) { msg('先点「本周 / 本月 / 累计」出一份报告再导出', 'err'); return; }
      var d = lastReport;
      var md = '# 收听报告（' + (d.label || rpPeriod) + '）\n\n';
      md += '- 总收听：' + fmtHM(d.sec) + '\n';
      md += '- 收听天数：' + (d.days || 0) + '\n';
      md += '- 听完集数：' + (d.finished || 0) + '\n';
      md += '- 日均：' + fmtHM(d.avgSec) + '\n\n';
      md += d.text ? (d.text + '\n\n') : '';
      if (d.top && d.top.length) {
        md += '## 听得最多\n\n| 专辑 | 时长 |\n|---|---|\n';
        d.top.forEach(function (a) { md += '| ' + String(a.name || '').replace(/\|/g, '\\|') + ' | ' + fmtHM(a.sec) + ' |\n'; });
      }
      if (d.daily && d.daily.length) {
        md += '\n## 每日时长\n\n| 日期 | 时长 |\n|---|---|\n';
        d.daily.forEach(function (x) { md += '| ' + x.day + ' | ' + fmtHM(x.sec) + ' |\n'; });
      }
      downloadText('收听报告-' + rpPeriod + '-' + dayKey(Date.now()) + '.md', 'text/markdown;charset=utf-8', md);
      msg('报告已导出', 'ok');
    });
  }

  // ---------- 已导入 ----------
  async function loadImported() {
    var el = $('importedList');
    try {
      var r = await api('GET', '/imported');
      var list = (r.data && r.data.imported) || [];
      el.innerHTML = '';
      if (!list.length) { el.innerHTML = '<span class="muted">还没有导入专辑。</span>'; return; }
      list.forEach(function (a) {
        var line = document.createElement('div');
        line.className = 'line';
        // v0.23.2：已导入行加封面（订阅缓存里能匹配到就用真封面，否则用图标占位）
        var cover = '';
        for (var si = 0; si < subsCache.length; si++) {
          if (String(subsCache[si].albumId) === String(a.albumId)) { cover = subsCache[si].cover || ''; break; }
        }
        var icon = document.createElement('div');
        icon.className = 'impicon';
        icon.textContent = '📚';
        if (cover) {
          var ic = document.createElement('img');
          ic.referrerPolicy = 'no-referrer';
          ic.src = String(cover).replace(/^http:\/\//i, 'https://');
          ic.onerror = function () { ic.remove(); icon.textContent = '📚'; };
          icon.textContent = '';
          icon.appendChild(ic);
        }
        line.appendChild(icon);
        var body = document.createElement('div');
        body.className = 'body';
        var n = document.createElement('div');
        n.className = 'n';
        n.textContent = '《' + a.name + '》';
        var s = document.createElement('div');
        s.className = 's';
        s.textContent = a.count + ' 集 · ' + a.importedAt;
        body.appendChild(n); body.appendChild(s);

        var ops = document.createElement('div');
        ops.className = 'ops';
        var bOpen = document.createElement('button');
        bOpen.className = 'small plain';
        bOpen.textContent = '详情';
        bOpen.addEventListener('click', function () { openDetail(a.albumId); });
        var bDl = document.createElement('button');
        bDl.className = 'small plain';
        bDl.textContent = '下载';
        bDl.addEventListener('click', function () {
          if (!a.playlistId) { msg('该记录没有歌单', 'err'); return; }
          if (!confirm('把《' + a.name + '》整本下载到本地音乐目录？')) return;
          startDownload({ playlist_id: a.playlistId, name: a.name }, a.name);
        });
        var bDel = document.createElement('button');
        bDel.className = 'small plain';
        bDel.textContent = '删除';
        bDel.addEventListener('click', async function () {
          // v0.18.6：两步选择——第一步确认删歌单（说明下一步会问曲库），第二步选曲库条目删不删
          if (!confirm('删除歌单《' + a.name + '》及其导入记录？\n\n（下一步会问你是否连歌曲库条目一起删）')) return;
          var delSongs = confirm('歌曲库里的这 ' + (a.count || '') + ' 条歌曲要一起删吗？\n\n「确定」= 连歌曲库条目一起删（不可恢复）\n「取消」= 只删歌单，歌曲库条目保留');
          try {
            var r = await api('POST', '/imported/delete', { playlist_id: a.playlistId, delete_songs: delSongs });
            var dd = (r && r.data) || {};
            if (delSongs && dd.songFailed > 0) msg('歌单已删；歌曲库删除 ' + (dd.songDeleted || 0) + ' 条、失败 ' + dd.songFailed + ' 条', 'err');
            else if (delSongs) msg('歌单与 ' + (dd.songDeleted || 0) + ' 条歌曲库条目已删除', 'ok');
            else msg('歌单已删，歌曲库条目保留', 'ok');
          } catch (e) { msg('删除失败: ' + e.message, 'err'); }
          loadImported();
        });
        ops.appendChild(bDl); ops.appendChild(bOpen); ops.appendChild(bDel);
        line.appendChild(body); line.appendChild(ops);
        el.appendChild(line);
      });
    } catch (e) { el.innerHTML = '<span class="err">加载失败: ' + e.message + '</span>'; }
  }

  // ---------- 进度轮询 ----------
  var jobActive = false;
  var pollTimer = null;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, 2500);
    poll();
  }

  function renderJob(j) {
    if (j && j.running) {
      // v0.19.2：任务进行中必须确保轮询在跑。
      // 原来只在导入按钮里 startPolling，页面在导入途中被刷新时 boot() 只调一次 poll，
      // 看到 running 就显示进度条但定时器是空的 → 进度条永久卡住、msg() 也不再自动收起。
      if (!pollTimer) pollTimer = setInterval(poll, 2500);
      jobActive = true;
      $('jobBar').classList.add('show');
      var pct = j.total ? Math.round(j.done * 100 / j.total) : 0;
      $('jobFill').style.width = pct + '%';
      var txt = '⏳ 正在导入' + (j.mode === 'merge' ? '（合并）' : '') + '《' + (j.current || j.title) + '》：' + j.done + '/' + j.total;
      if (j.parts && j.parts.length > 1) {
        var okCount = j.parts.filter(function (p) { return !p.error; }).length;
        txt += ' · 已完成 ' + okCount + '/' + j.parts.length + ' 张';
      }
      $('jobText').className = 'txt';
      $('jobText').textContent = txt;
      return true;
    }
    if (jobActive) {
      jobActive = false;
      // v0.19.2：定时器的生命周期只在 poll() 末尾统一管（它还会看下载任务是否在跑）。
      // 这里原来无条件清掉，会把同时在进行的下载进度也停更。
      $('jobFill').style.width = '100%';
      $('jobText').className = 'txt ' + (j && j.error ? 'err' : 'ok');
      $('jobText').innerHTML = (j && j.error ? '❌ ' : '✅ ') +
        escHtml(((j && (j.title || j.current)) || '任务')) +
        (j && j.error ? '：' + errClip(j.error, 110) : ' 完成') +
        (j && j.total ? '（' + j.done + '/' + j.total + ' 集）' : '');
      // v0.18.0：有写入失败时直接给个重试按钮，不用重导整本
      var oldRetry = $('jobRetry'); if (oldRetry) oldRetry.remove();
      if (j && j.error && /写入失败/.test(j.error) && (j.failedTracks || []).length) {
        var rbtn = document.createElement('button');
        rbtn.className = 'small plain'; rbtn.id = 'jobRetry';
        rbtn.style.marginLeft = '8px'; rbtn.style.flexShrink = '0';
        rbtn.textContent = '↻ 重试 ' + j.failedTracks.length + ' 个失败集';
        rbtn.addEventListener('click', async function () {
          rbtn.disabled = true; rbtn.textContent = '重试中…';
          try {
            var rr = await api('POST', '/import/retry', {});
            var dd = (rr && rr.data) || {};
            if (rr.success === false) msg('❌ ' + rr.error, 'err');
            else if (!dd.added) msg('没有需要重试的集');
            else msg('已补上 ' + dd.added + ' 集' + (dd.left ? '，仍有 ' + dd.left + ' 集失败' : '，全部补齐 🎉'), dd.left ? 'err' : 'ok');
            loadImported();
          } catch (e) { msg('重试失败: ' + e.message, 'err'); }
          var me = $('jobRetry'); if (me) me.remove();
        });
        $('jobBar').appendChild(rbtn);
      }
      // v0.18.7：原来这里引用了未声明的 canRetry → 任务结束时抛 ReferenceError，
      // 导致下面的 loadImported/loadSubs 不执行、进度条不收起、重试按钮不消失。
      var canRetry = !!(j && j.error && /写入失败/.test(j.error) && (j.failedTracks || []).length);
      setTimeout(function () { if (!jobActive) { $('jobBar').classList.remove('show'); var jr = $('jobRetry'); if (jr) jr.remove(); } }, canRetry ? 20000 : 5000);
      loadImported();
      loadSubs();
    }
    return false;
  }

  // ---------- 下载 / 播报 / 跨设备进度 渲染 ----------
  function renderDl(j) {
    var el = $('dlStat');
    if (!el) return;
    if (!j || (!j.running && !j.finishedAt)) {
      el.className = 'muted small-txt';
      el.textContent = '还没有下载任务。在专辑行点「下载」，就会把整本存到 Songloft 的音乐目录。';
      return;
    }
    if (j.running) {
      el.className = 'small-txt';
      var pct = j.total ? Math.round(j.done * 100 / j.total) : 0;
      el.innerHTML = '⏳ 正在下载《' + escHtml(j.title || '') + '》' + j.done + '/' + j.total +
        '（' + pct + '%）· 成功 ' + j.ok + (j.fail ? ' · <span class="err">失败 ' + j.fail + '</span>' : '') +
        (j.current ? '<br><span class="muted">当前：' + escHtml(j.current) + '</span>' : '');
      return;
    }
    el.className = 'small-txt';
    var okAll = j.total && j.ok >= j.total;
    el.innerHTML = (okAll ? '<span class="ok">✅</span> ' : '<span class="err">⚠️</span> ') +
      '《' + escHtml(j.title || '') + '》下载结束：成功 ' + j.ok + '/' + (j.total || 0) +
      (j.fail ? '，失败 ' + j.fail : '') + (j.finishedAt ? '（' + escHtml(j.finishedAt) + '）' : '') +
      (j.error ? '<br>' + errClip(j.error, 100) : '') +
      (j.lastPath ? '<br><span class="muted">示例路径：' + escHtml(j.lastPath) + '</span>' : '');
  }

  function renderProgStat(ps) {
    var el = $('progStat');
    if (!el || !ps) return;
    el.textContent = 'NAS 上已存 ' + (ps.tracks || 0) + ' 集进度、' + (ps.albums || 0) + ' 张专辑的最后收听位置' +
      (ps.at ? ' · 最后更新 ' + ps.at : '');
  }

  async function loadProgCfg() {
    try {
      var r = await api('GET', '/config');
      var sy = (r.data && r.data.sync) || {};
      progSyncEnabled = sy.progress !== false && sGet('xm_prog_sync') !== '0';
      $('progSync').value = progSyncEnabled ? '1' : '0';
      var dlc = (r.data && r.data.dl) || {};
      $('dlDir').value = dlc.targetDir || '';
      if ($('dlFormat')) $('dlFormat').value = dlc.format === '' ? '' : 'mp3';
    } catch (e) { /* */ }
  }

  $('btnProgSave').addEventListener('click', async function () {
    var on = $('progSync').value === '1';
    try {
      await api('POST', '/config', { sync: { progress: on } });
      progSyncEnabled = on;
      sSet('xm_prog_sync', on ? '1' : '0');
      if (on) { await flushProg(); await pullRecent(); }
      msg(on ? '✅ 已开启跨设备进度' : '已关闭跨设备进度（只存本机）', 'ok');
    } catch (e) { msg('保存失败: ' + e.message, 'err'); }
  });

  $('btnProgPull').addEventListener('click', async function () {
    msg('⏳ 正在从 NAS 拉取进度…');
    try {
      await pullRecent();
      var r = await api('GET', '/status');
      renderProgStat(r.data && r.data.progressStat);
      if (cur.id && !$('detailCard').classList.contains('hide')) {
        await pullAlbumProgress(cur.id);
        renderTracks(curTracks);
        renderResume();
      }
      msg('✅ 已同步服务端进度', 'ok');
    } catch (e) { msg('拉取失败: ' + e.message, 'err'); }
  });

  $('btnProgClear').addEventListener('click', async function () {
    if (!confirm('清空 NAS 上保存的全部收听进度？（本机进度保留）')) return;
    try {
      await api('DELETE', '/progress?all=1');
      msg('已清空 NAS 上的进度', 'ok');
      var r = await api('GET', '/status');
      renderProgStat(r.data && r.data.progressStat);
    } catch (e) { msg('清空失败: ' + e.message, 'err'); }
  });

  $('btnDlSave').addEventListener('click', async function () {
    try {
      await api('POST', '/config', { dl: { targetDir: $('dlDir').value.trim(), format: $('dlFormat') ? $('dlFormat').value : 'mp3' } });
      msg('✅ 下载目录已保存' + ($('dlDir').value.trim() ? '：' + $('dlDir').value.trim() : '（音乐库根目录）'), 'ok');
    } catch (e) { msg('保存失败: ' + e.message, 'err'); }
  });

  $('btnDlStop').addEventListener('click', async function () {
    try {
      var r = await api('POST', '/download/stop', {});
      msg(r.success === false ? '❌ ' + r.error : (r.data.message || '已请求停止'), r.success === false ? 'err' : 'ok');
    } catch (e) { msg('操作失败: ' + e.message, 'err'); }
  });

  async function poll() {
    try {
      var r = await api('GET', '/status');
      var d = r.data || {};
      var running = renderJob(d.job);
      if (Array.isArray(d.subs)) { subsCache = d.subs; updateSubBadge(); }
      renderDl(d.dlJob);
      renderProgStat(d.progressStat);
      if (d.lastSync && d.lastSync.at) {
        $('lastSyncInfo').textContent = '最近同步：' + d.lastSync.at + '（' + d.lastSync.trigger + '）· ' + d.lastSync.result;
      }
      var dlBusy = d.dlJob && d.dlJob.running;
      if (!running && !dlBusy && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 启动 ----------
  if (!sp && !token) {
    var t = prompt('独立打开本页面。请粘贴 songloft 的访问 Token（网页端登录后的 JWT）：', '');
    if (t) { token = t.replace(/^Bearer /, ''); sSet('xm_token', token); }
  }

  // ---------- 导出订阅清单 ----------
  function downloadText(filename, mime, content) {
    try {
      var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      var u = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = u;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 1000);
      msg('⬇ 已开始下载 ' + filename, 'ok');
    } catch (e) { msg('下载失败: ' + e.message, 'err'); }
  }

  async function exportSubs(fmt) {
    try {
      var r = await api('GET', '/subs/export?format=' + fmt);
      if (!r || r.success === false) { msg('❌ ' + ((r && r.error) || '导出失败'), 'err'); return; }
      var d = r.data || {};
      if (!d.count) { msg('还没有订阅，导出来是空表', 'err'); }
      downloadText(d.filename || ('ximalaya-subs.' + fmt), d.mime, d.content || '');
      if ($('expStat')) $('expStat').textContent = '上次导出：' + (d.count || 0) + ' 张 · ' + (d.filename || '');
    } catch (e) { msg('导出失败: ' + e.message, 'err'); }
  }
  if ($('btnExpJson')) $('btnExpJson').addEventListener('click', function () { exportSubs('json'); });
  if ($('btnExpCsv')) $('btnExpCsv').addEventListener('click', function () { exportSubs('csv'); });
  if ($('btnExpMd')) $('btnExpMd').addEventListener('click', function () { exportSubs('md'); });

  // ---------- 自检 ----------
  async function runSelfCheck(deep) {
    var sum = $('scSummary'), body = $('scBody');
    if (!body) return;
    if (sum) sum.textContent = deep ? '深度检查中（会真的取一次播放地址）…' : '检查中…';
    body.innerHTML = '';
    try {
      var r = await api('GET', '/selfcheck' + (deep ? '?deep=1' : ''));
      if (!r || r.success === false) { if (sum) sum.textContent = '❌ ' + ((r && r.error) || '检查失败'); return; }
      var d = r.data || {};
      if (sum) {
        sum.innerHTML = (d.ok ? '✅ ' : '⚠️ ') + escHtml(d.summary || '') +
          ' <span class="muted">· v' + escHtml(d.version || '') + ' · ' + escHtml(d.atText || '') + '</span>';
      }
      (d.items || []).forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'schk';
        row.innerHTML = '<span class="dot ' + escHtml(it.level) + '"></span>' +
          '<span class="nm">' + escHtml(it.name) + '</span>' +
          '<span class="dt">' + escHtml(it.detail) + '</span>';
        body.appendChild(row);
      });
    } catch (e) { if (sum) sum.textContent = '❌ ' + e.message; }
  }
  if ($('btnScRun')) $('btnScRun').addEventListener('click', function () { runSelfCheck(false); });
  if ($('btnScDeep')) $('btnScDeep').addEventListener('click', function () { runSelfCheck(true); });

  // ---------- 运行日志 ----------
  function fmtLogTime(ts) {
    var d = new Date(Number(ts) || Date.now());
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  async function loadLogs() {
    var box = $('logBody');
    if (!box) return;
    try {
      var lv = ($('logLevel') && $('logLevel').value) || 'all';
      var r = await api('GET', '/logs?limit=100&level=' + lv);
      if (!r || r.success === false) { box.innerHTML = '<div class="err">读取失败</div>'; return; }
      var d = r.data || {};
      if ($('logStat')) {
        $('logStat').textContent = '共 ' + (d.total || 0) + ' 条（最多保留 ' + (d.max || 100) + '）' +
          ' · 警告 ' + (d.warn || 0) + ' · 错误 ' + (d.error || 0);
      }
      box.innerHTML = '';
      var items = d.items || [];
      if (!items.length) { box.innerHTML = '<div class="muted small-txt">还没有记录。一切正常时这里是空的。</div>'; return; }
      items.forEach(function (e) {
        var row = document.createElement('div');
        row.className = 'logrow';
        row.innerHTML = '<span class="loglv ' + escHtml(e.lv) + '">' +
          (e.lv === 'error' ? '错误' : e.lv === 'warn' ? '警告' : '记录') + '</span>' +
          '<span class="logtime">' + fmtLogTime(e.t) + '</span>' +
          '<span class="logtag">' + escHtml(e.tag || '') + '</span>' +
          '<span class="logmsg">' + escHtml(e.msg || '') + '</span>';
        box.appendChild(row);
      });
    } catch (e) { box.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
  }
  if ($('btnLogRefresh')) $('btnLogRefresh').addEventListener('click', loadLogs);
  if ($('logLevel')) $('logLevel').addEventListener('change', loadLogs);
  if ($('btnLogClear')) {
    $('btnLogClear').addEventListener('click', async function () {
      if (!confirm('清空运行日志？')) return;
      try { await api('POST', '/logs', { action: 'clear' }); loadLogs(); msg('日志已清空'); }
      catch (e) { msg('清空失败: ' + e.message, 'err'); }
    });
  }

  // ---------- v0.22.4：网络诊断 ----------
  if ($('btnNetDiag')) {
    $('btnNetDiag').addEventListener('click', async function () {
      var btn = this, out = $('netDiagOut'), stat = $('netDiagStat');
      btn.disabled = true;
      stat.textContent = '正在检测（最多 8 秒/项）…';
      out.innerHTML = '';
      try {
        var r = await api('GET', '/net/health');
        if (!r || r.success === false) throw new Error((r && r.error) || '检测失败');
        var items = (r.data && r.data.items) || [];
        var bad = 0;
        out.innerHTML = '';
        var lim = 0;
        items.forEach(function (it) {
          if (!it.ok && !it.limited) bad++;
          if (it.limited) lim++;
          var row = document.createElement('div');
          row.className = 'diagrow';
          var ms = it.ms
            ? '<span class="' + (it.ms > 3000 ? 'err' : (it.ms > 1200 ? 'warn' : 'ok')) + '">' + it.ms + ' ms</span>'
            : '';
          // v0.23.4：506 是「被限流」不是「连不上」，黄点 + 说明，别吓人
          var dot = it.limited ? 'warn' : (it.ok ? 'ok' : 'err');
          row.innerHTML = '<span class="diagdot ' + dot + '">●</span>' +
            '<span class="diagname">' + escHtml(it.name) + '</span>' + ms +
            (it.error ? '<span class="diagerr">' + escHtml(it.error) + '</span>' : '') +
            (!it.error && it.status ? '<span class="diagmeta">HTTP ' + it.status + '</span>' : '') +
            (it.limited ? '<span class="diaglim">被限流，稍后自动恢复</span>' : '');
          out.appendChild(row);
        });
        var d = r.data || {};
        var coolLeft = Math.ceil((d.cool || 0) / 1000);
        if (lim && coolLeft) {
          stat.textContent = '网络可通，但取流接口被限流（还剩 ' + coolLeft + ' 秒自动恢复）· 这期间点播会提示「请求过于频繁」';
          stat.className = 'muted small-txt';
          stat.style.color = '#d19a2a';
        } else if (lim) {
          stat.textContent = '网络可通，但取流接口被临时限流 · 约 30 秒后自动恢复，已缓存的内容照常播放';
          stat.className = 'muted small-txt';
          stat.style.color = '#d19a2a';
        } else {
          stat.textContent = bad === 0
            ? '全部正常 · 在途请求 ' + (d.active || 0) + ' · 排队 ' + (d.queued || 0) + ' · 缓存 ' + (d.cache || 0) + ' 条 · 单飞省 ' + (d.dedup || 0) + ' 次'
            : (bad + ' 项异常，检查 NAS 的 DNS / 代理设置后重试');
          stat.className = 'muted small-txt' + (bad ? ' err' : '');
          stat.style.color = '';
        }
      } catch (e) {
        stat.textContent = '检测失败：' + e.message;
        stat.className = 'muted small-txt err';
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- 登录态健康（Cookie 是否过期） ----------
  async function loadCookieHealth() {
    var el = $('loginStatus');
    if (!el) return;
    try {
      var r = await api('GET', '/cookie/health');
      if (!r || r.success === false) return;
      var d = r.data || {};
      if (!d.loggedIn) return;
      if (d.valid) {
        el.innerHTML = '✅ 已登录' + (d.nickname ? '（' + escHtml(d.nickname) + '）' : '') +
          ' <span class="muted small-txt">· ' + escHtml(d.checkedAgo) + '验证过</span>';
      } else {
        el.innerHTML = '⚠️ <b style="color:#dc2626;">登录态已失效</b> <span class="muted small-txt">' +
          escHtml(d.error || '') + '　上次正常：' + escHtml(d.lastOkAgo) + '</span>' +
          ' <span class="link" id="btnReLogin">重新扫码</span>';
        var b = $('btnReLogin');
        if (b) b.addEventListener('click', function () { qrStart(); });
      }
    } catch (e) { /* 静默 */ }
  }

  // ---------- 订阅分组 ----------
  var grpBy = 'cat';
  var grpSel = {};

  function setGrpBy(by) {
    grpBy = (by === 'status' || by === 'anchor') ? by : 'cat';
    ['grpByCat', 'grpByStatus', 'grpByAnchor'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      var want = id === 'grpByCat' ? 'cat' : id === 'grpByStatus' ? 'status' : 'anchor';
      el.classList.toggle('on', grpBy === want);
    });
    loadGroups();
  }

  async function loadGroups() {
    var box = $('grpBody');
    if (!box) return;
    grpSel = {};
    box.innerHTML = '<div class="muted small-txt">读取中…</div>';
    try {
      var r = await api('GET', '/subs/groups?by=' + encodeURIComponent(grpBy));
      if (!r || r.success === false) { box.innerHTML = '<span class="err">' + escHtml((r && r.error) || '读取失败') + '</span>'; return; }
      renderGroups(r.data || {}, box);
    } catch (e) {
      box.innerHTML = '<span class="err">失败：' + escHtml(e.message) + '</span>';
    }
  }

  function renderGroups(d, box) {
    box.innerHTML = '';
    var groups = d.groups || [];
    if (!groups.length) { box.innerHTML = '<div class="muted small-txt">还没有订阅。</div>'; return; }
    groups.forEach(function (g) {
      var head = document.createElement('div');
      head.className = 'grphead';
      var ckAll = document.createElement('input');
      ckAll.type = 'checkbox';
      ckAll.style.accentColor = 'var(--accent)';
      ckAll.addEventListener('change', function () {
        box.querySelectorAll('.ck[data-g="' + cssEsc(g.key) + '"]').forEach(function (c) {
          c.checked = ckAll.checked;
          grpSel[c.getAttribute('data-id')] = ckAll.checked;
        });
      });
      var label = document.createElement('span');
      label.textContent = g.label;
      var cnt = document.createElement('span');
      cnt.className = 'muted small-txt';
      cnt.textContent = ' ' + g.count + ' 本';
      head.appendChild(ckAll); head.appendChild(label); head.appendChild(cnt);
      box.appendChild(head);

      g.items.forEach(function (x) {
        var row = document.createElement('div');
        row.className = 'grpitem';
        var ck = document.createElement('input');
        ck.type = 'checkbox';
        ck.className = 'ck';
        ck.setAttribute('data-id', x.albumId);
        ck.setAttribute('data-g', g.key);
        ck.addEventListener('change', function () { grpSel[x.albumId] = ck.checked; });
        var name = document.createElement('span');
        name.className = 'grpname';
        name.textContent = x.name || ('专辑 ' + x.albumId);
        name.title = x.name || '';
        name.addEventListener('click', function () { document.querySelector('.tab[data-tab="search"]').click(); openDetail(x.albumId); });
        row.appendChild(ck); row.appendChild(name);
        if (x.newCount) {
          var nb = document.createElement('span');
          nb.className = 'dbadge';
          nb.textContent = '+' + x.newCount;
          row.appendChild(nb);
        }
        if (x.updateDate) {
          var dt = document.createElement('span');
          dt.className = 'muted small-txt grpdate';
          dt.textContent = String(x.updateDate).slice(0, 10);
          row.appendChild(dt);
        }
        box.appendChild(row);
      });
    });
  }

  function cssEsc(s) { return String(s || '').replace(/["\\]/g, '\\$&'); }

  if ($('grpByCat')) $('grpByCat').addEventListener('click', function () { setGrpBy('cat'); });
  if ($('grpByStatus')) $('grpByStatus').addEventListener('click', function () { setGrpBy('status'); });
  if ($('grpByAnchor')) $('grpByAnchor').addEventListener('click', function () { setGrpBy('anchor'); });
  if ($('btnGrpLoad')) $('btnGrpLoad').addEventListener('click', loadGroups);
  // v0.23.16：分组视图里勾选后同样能批量设分组
  if ($('btnGrpGroup')) {
    $('btnGrpGroup').addEventListener('click', function () {
      var gids = Object.keys(grpSel).filter(function (k) { return grpSel[k]; });
      if (!gids.length) { msg('先勾选要设置分组的专辑', 'warn'); return; }
      ensureGroups().then(function () {
        var list = gids.map(function (id) {
          for (var i = 0; i < subsCache.length; i++) {
            if (String(subsCache[i].albumId) === String(id)) return subsCache[i];
          }
          return { albumId: String(id), name: '', group: '' };
        });
        openGrpPick(list);
      });
    });
  }
  if ($('btnGrpUnsub')) {
    $('btnGrpUnsub').addEventListener('click', async function () {
      var ids = Object.keys(grpSel).filter(function (k) { return grpSel[k]; });
      if (!ids.length) { msg('先勾选要取消的专辑', 'warn'); return; }
      if (!confirm('取消订阅 ' + ids.length + ' 张专辑？\n（只是不再跟更，已导入的歌单不会删）')) return;
      try {
        var r = await api('POST', '/subs/unsub', { albumIds: ids });
        if (r && r.success === false) { msg(r.error || '操作失败', 'err'); return; }
        msg('已取消 ' + ((r.data && r.data.removed) || 0) + ' 张订阅');
        loadGroups(); loadSubs();
      } catch (e) { msg('操作失败: ' + e.message, 'err'); }
    });
  }

  function boot() {
    loadLogin();
    loadAuto();
    loadProgCfg();
    bindSubGroupUI();
    bindSubsMultiUI();
    loadSubGroups();
    loadSubs();
    loadImported();
    renderIdleChips();
    // v0.20.0：恢复上次看的收听分段，并把「继续听」当作发现页首屏
    setListenSeg(sGet(LSN_SEG_KEY) || 'recent', true);
    syncDiscover();
    poll();
    pullRecent();
    renderTimeline();
    loadDashboard();
    abTip();
    // 恢复上次的睡眠定时档位（「本集播完」这类常用档不用每次重选）
    var slv = sGet(SLEEP_KEY);
    if (slv && slv !== '0') {
      var opt = $('pSleep').querySelector('option[value="' + slv + '"]');
      if (opt) { $('pSleep').value = slv; applySleep(slv, true); }
      else if (Number(slv) > 0) {
        // 自定义分钟档（v0.18.0）：不在固定选项里，回填到「自定义」
        var copt = $('pSleep').querySelector('option[value="custom"]');
        if (copt) {
          copt.textContent = '自定义 ' + slv + ' 分';
          $('pSleep').value = 'custom';
          applySleep(slv, true);
        }
      }
    }
    loadSearchHistory();
    loadLogs();
    runSelfCheck(false);
    loadCookieHealth();
    // 上次在车里用的，下次打开还在车里（回家后手动退出即可）
    if (sGet(DRIVE_KEY) === '1') driveShow(true);
    document.querySelectorAll('.tlBtn').forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-days')) === tlDays);
    });
  }
  // 任何初始化异常都不允许静默吞掉整个页面：把错误打到页面上
  try { boot(); } catch (e) {
    try {
      var __el = document.querySelector('.card') || document.body;
      var __d = document.createElement('div');
      __d.className = 'err';
      __d.style.margin = '10px 0';
      __d.textContent = '初始化失败: ' + (e && e.message ? e.message : e);
      __el.parentNode.insertBefore(__d, __el);
    } catch (_e) { /* */ }
  }
})();
