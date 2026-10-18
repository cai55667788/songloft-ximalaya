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

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  async function api(method, path, body) {
    if (sp) {
      if (method === 'GET' && sp.apiGet) return sp.apiGet(path);
      if (method === 'POST' && sp.apiPost) return sp.apiPost(path, body === undefined ? {} : body);
      if (method === 'DELETE' && sp.apiDelete) return sp.apiDelete(path);
      if (method === 'PUT' && sp.apiPut) return sp.apiPut(path, body === undefined ? {} : body);
    }
    var resp = await fetch(API_BASE + path, {
      method: method, headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok && data.error) throw new Error(data.error);
    return data;
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
  function esc(s) { return String(s == null ? '' : s); }
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
  function fmtDur(sec) {
    sec = Number(sec) || 0;
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---------- 标签页 ----------
  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      ['search', 'recent', 'subs', 'lib', 'set'].forEach(function (t) {
        $('tab-' + t).classList.toggle('hide', t !== btn.dataset.tab);
      });
      if (btn.dataset.tab === 'subs') {
        loadSubs();
        if (!meLoaded) loadMySubs(false);
      }
      if (btn.dataset.tab === 'recent') { renderRecent(); pullRecent(); }
      if (btn.dataset.tab === 'lib') { loadImported(); poll(); }
      if (btn.dataset.tab === 'subs') { loadTts(); poll(); }
    });
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
      var r = await api('GET', '/login');
      var d = r.data || {};
      renderLogin(d);
      // 已登录则顺带验证一次（带 user 信息展示）
      if (d.loggedIn) {
        try {
          var m = await api('GET', '/me');
          var md = (m && m.data) || {};
          renderLogin({
            loggedIn: true, valid: md.valid, user: md.user, error: md.error,
            savedAt: d.savedAt, mask: d.mask, cookieSane: d.cookieSane, cookieHint: d.cookieHint
          });
        } catch (e2) { /* 忽略，保留基础展示 */ }
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
          msg('✅ 扫码登录成功' + (d.user && d.user.nickname ? '：' + esc(d.user.nickname) : ''), 'ok');
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

  // ---------- 设备 ----------
  var deviceSaved = '';
  var ttsDeviceSaved = '';
  async function loadDevices() {
    try {
      var c = await api('GET', '/config');
      var dv = (c && c.data && c.data.device) || {};
      deviceSaved = dv.account_id && dv.device_id ? (dv.account_id + '|' + dv.device_id + '|' + (dv.device_name || '')) : '';
      var tc = (c && c.data && c.data.tts) || {};
      ttsDeviceSaved = tc.account_id && tc.device_id ? (tc.account_id + '|' + tc.device_id + '|' + (tc.device_name || '')) : '';
    } catch (e) { /* */ }
    try {
      var d = await api('GET', '/devices');
      var sel = $('device');
      var tsel = $('ttsDevice');
      sel.innerHTML = '<option value="">（请选择音箱）</option>';
      if (tsel) tsel.innerHTML = '<option value="">跟随设置里的设备</option>';
      var accounts = (d && d.data && d.data.data) || (d && d.data) || [];
      if (Array.isArray(accounts)) {
        accounts.forEach(function (acc) {
          (acc.devices || []).forEach(function (dev) {
            var name = dev.device_name || dev.name || dev.alias || dev.deviceID || '音箱';
            var did = dev.deviceID || dev.device_id || dev.id || '';
            var opt = document.createElement('option');
            opt.value = acc.account_id + '|' + did + '|' + name;
            opt.textContent = name + '（' + (acc.account_name || acc.account_id) + '）';
            if (opt.value === deviceSaved) opt.selected = true;
            sel.appendChild(opt);
            if (tsel) {
              var o2 = opt.cloneNode(true);
              if (o2.value === ttsDeviceSaved) o2.selected = true;
              tsel.appendChild(o2);
            }
          });
        });
      }
    } catch (e) { /* */ }
  }
  $('device').addEventListener('change', async function () {
    var v = $('device').value;
    if (!v) return;
    var p = v.split('|');
    deviceSaved = v;
    try { await api('POST', '/config', { device: { account_id: p[0], device_id: p[1], device_name: p[2] } }); } catch (e) { /* */ }
  });

  async function playPlaylist(playlistId, name) {
    var dv = $('device').value || deviceSaved;
    if (!dv) { msg('请先在「设置」里选择音箱', 'err'); return; }
    $('device').value = dv;
    var p = dv.split('|');
    try {
      await api('POST', '/config', { device: { account_id: p[0], device_id: p[1], device_name: p[2] } });
      var r = await api('POST', '/play', {
        account_id: p[0], device_id: p[1], playlist_id: playlistId, mode: $('mode').value
      });
      msg(r.success ? '▶ 已在音箱播放《' + name + '》' : '❌ ' + r.error, r.success ? 'ok' : 'err');
    } catch (e) { msg('播放失败: ' + e.message, 'err'); }
  }

  // ---------- 播放器（续播 / 连播 / 倍速 / 睡眠定时） ----------
  var queue = [];        // [{trackId, index, title, albumId, albumName}]
  var qi = -1;
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
        finished: !!(o.t >= o.d - 15)
      });
      // 跨设备：攒一条待上传的进度，8 秒合并上报一次
      queueProg({
        trackId: trackId, albumId: c.albumId, albumName: c.albumName || '',
        title: c.title, index: c.index, cover: c.cover || '',
        t: o.t, d: o.d, at: o.at, finished: !!(o.t >= o.d - 15)
      });
    }
  }

  // ---------- 跨设备进度（存 NAS 端） ----------
  var progSyncEnabled = sGet('xm_prog_sync') !== '0';
  var progQueue = [], progTimer = null;

  function queueProg(item) {
    if (!progSyncEnabled || !item || !item.trackId) return;
    progQueue = progQueue.filter(function (x) { return String(x.trackId) !== String(item.trackId); });
    progQueue.push(item);
    if (progQueue.length > 40) progQueue = progQueue.slice(-40);
    if (progTimer) return;
    progTimer = setTimeout(function () { flushProg(); }, 8000);
  }

  async function flushProg() {
    if (progTimer) { clearTimeout(progTimer); progTimer = null; }
    if (!progQueue.length) return;
    var items = progQueue.slice(0, 50);
    progQueue = [];
    try { await api('POST', '/progress', { items: items }); } catch (e) { /* 离线时忽略，下次再传 */ }
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

  function renderRecent() {
    var el = $('recentList');
    if (!el) return;
    var list = readRecent();
    el.innerHTML = '';
    if (!list.length) {
      $('recentStat').textContent = '还没有收听记录。搜一张专辑点开，随便听一集就会出现在这里。';
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
      var bDel = document.createElement('button');
      bDel.className = 'small plain';
      bDel.textContent = '✕';
      bDel.title = '从最近收听里移除';
      bDel.addEventListener('click', function () {
        writeRecent(readRecent().filter(function (x) { return String(x.albumId) !== String(r.albumId); }));
        renderRecent();
      });
      ops.appendChild(bPlay); ops.appendChild(bOpen); ops.appendChild(bDel);
      line.appendChild(img); line.appendChild(body); line.appendChild(ops);
      el.appendChild(line);
    });
  }

  function openAlbumFromRecent(albumId) {
    document.querySelector('.tab[data-tab="search"]').click();
    $('searchCard').classList.add('hide');
    openDetail(albumId);
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
    if (!silent) {
      // 切倒序：列表翻到最后一页，跟「从最新一集起播」对齐；切正序：回第一页
      if (cur.id && !$('detailCard').classList.contains('hide')) {
        jumpToOrderPage(playOrder === 'desc');
      } else {
        renderResume();
        msg(playOrder === 'desc' ? '已切换为倒序（新集在前）' : '已切换为正序（旧集在前）');
      }
      return;
    }
    renderResume();
  }

  // 倒序 → 最后一页；正序 → 第一页。取不到目录就停在当前页。
  async function jumpToOrderPage(toLast) {
    try {
      var o = await api('GET', '/album/' + cur.id + '/outline');
      var p = toLast ? (o && o.data && o.data.lastPage) : 1;
      if (p && p !== cur.page) {
        await gotoPage(p);
        msg('倒序：已跳到第 ' + p + ' 页（最新集在前）');
      } else {
        msg(playOrder === 'desc' ? '已切换为倒序（新集在前）' : '已切换为正序（旧集在前）');
      }
    } catch (e) {
      msg(playOrder === 'desc' ? '已切换为倒序（新集在前）' : '已切换为正序（旧集在前）');
    }
    syncOrderBtn();
    renderResume();
  }

  async function playAt(idx) {
    if (idx < 0 || idx >= queue.length) return;
    qi = idx;
    curPlayingId = '';
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
      var r = await api('GET', '/track/' + t.trackId + '/url');
      if (!r || r.success === false) { $('pTitle').textContent = '❌ ' + ((r && r.error) || '取不到播放地址'); return; }
      var a = $('audio');
      a.src = r.data.url;
      $('pTitle').textContent = label;
      a.playbackRate = Number(sGet(RATE_KEY) || 1) || 1;
      pendingSeek = getPos(t.trackId);
      a.play().catch(function () { /* 浏览器要求先有用户交互 */ });
      if (queue.length > 1) $('pProg').textContent = '第 ' + (idx + 1) + ' / ' + queue.length + ' 集';
    } catch (e) { $('pTitle').textContent = '试听失败: ' + e.message; }
  }

  function playQueue(list, idx, album) {
    queue = sortByOrder((list || []).map(function (t) {
      return {
        trackId: t.trackId, index: t.index, title: t.title,
        albumId: (album && album.id) || t.albumId || '',
        albumName: (album && album.name) || t.albumName || '',
        cover: (album && album.cover) || t.cover || ''
      };
    }));
    if (idx < 0) idx = 0;
    playAt(idx);
  }

  $('audio').addEventListener('loadedmetadata', function () {    var a = this;
    if (pendingSeek && pendingSeek.t > 10 && pendingSeek.t < (a.duration || 1e9) - 15) {
      a.currentTime = pendingSeek.t;
      msg('⏱ 从 ' + fmtTime(pendingSeek.t) + ' 续播');
    }
    pendingSeek = null;
    if (qi >= 0 && queue[qi]) curPlayingId = queue[qi].trackId;
    updateProg();
  });

  var lastSaveAt = 0;
  $('audio').addEventListener('timeupdate', function () {
    updateProg();
    var now = Date.now();
    if (now - lastSaveAt < 5000 || qi < 0) return;
    lastSaveAt = now;
    savePos(queue[qi].trackId, this.currentTime, this.duration);
  });

  // 暂停 / 播放器关闭时立刻把攒着的进度推给 NAS，不等防抖
  $('audio').addEventListener('pause', function () {
    if (qi >= 0) savePos(queue[qi].trackId, this.currentTime, this.duration);
    flushProg();
  });

  // 播到队列末尾时，先把当前页后面的集补齐，再翻下一页，长书可以一直听下去
  async function extendQueue() {
    var c = queue[qi];
    if (!c || !c.albumId) return false;
    if (String(cur.id) !== String(c.albumId)) return false;

    var seen = {};
    queue.forEach(function (x) { seen[String(x.trackId)] = 1; });
    var lastIdx = Number(c.index) || 0;
    var page = cur.page || 1;
    var desc = playOrder === 'desc';

    try {
      // ① 当前页里排在后面的集还没进队列（例如从「最近收听」只带了一集过来）
      var r0 = await api('GET', '/album/' + cur.id + '/tracks?page=' + page);
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
      if (desc ? page <= 1 : !cur.hasMore) return false;
      var p = desc ? page - 1 : page + 1;
      var r = await api('GET', '/album/' + cur.id + '/tracks?page=' + p);
      if (!r || r.success === false) return false;
      var more = (r.data && r.data.tracks) || [];
      if (!more.length) return false;
      cur.page = p;
      cur.hasMore = !!r.data.hasMore;
      more.forEach(function (t) {
        queue.push({
          trackId: t.trackId, index: t.index, title: t.title,
          albumId: c.albumId, albumName: c.albumName, cover: c.cover
        });
      });
      if (desc) { queue = sortByOrder(queue); qi = indexOfTrack(queue, c.trackId); }
      if (!$('detailCard').classList.contains('hide')) {
        renderTracks(more);
        $('dPage').textContent = '第 ' + p + ' 页';
        $('dPrev').disabled = p <= 1;
        $('dNext').disabled = !cur.hasMore;
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
    if (sleepMode === 'end') {
      sleepMode = 'off';
      $('pSleep').value = '0';
      $('pSleepTip').textContent = '已按「本集播完」停止';
      a.pause();
      return;
    }
    if (qi >= 0 && qi + 1 < queue.length) { playAt(qi + 1); return; }
    if (await extendQueue()) { playAt(qi + 1); return; }
    msg('已播完' + (queue[qi] && queue[qi].albumName ? '《' + queue[qi].albumName + '》' : '本页') + '共 ' + queue.length + ' 集' +
      (playOrder === 'desc' ? '（倒序已到头，可切回正序）' : ''));
  });

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

  // 倍速（跨会话记忆）
  var rateSel = $('pRate');
  var savedRate = sGet(RATE_KEY);
  if (savedRate) rateSel.value = savedRate;
  rateSel.addEventListener('change', function () {
    var v = Number(this.value) || 1;
    $('audio').playbackRate = v;
    sSet(RATE_KEY, String(v));
    msg('倍速 ' + v + 'x');
  });

  // 睡眠定时
  var sleepTimer = null, sleepAt = 0, sleepMode = 'off';
  $('pSleep').addEventListener('change', function () {
    var v = this.value;
    if (sleepTimer) { clearInterval(sleepTimer); sleepTimer = null; }
    if (v === 'end') {
      sleepMode = 'end';
      sleepAt = 0;
      $('pSleepTip').textContent = '本集播完停止';
      return;
    }
    sleepMode = 'off';
    var min = Number(v) || 0;
    sleepAt = min ? Date.now() + min * 60000 : 0;
    if (!min) { $('pSleepTip').textContent = ''; return; }
    $('pSleepTip').textContent = '剩 ' + min + ':00';
    sleepTimer = setInterval(function () {
      var left = sleepAt - Date.now();
      if (left <= 0) {
        clearInterval(sleepTimer); sleepTimer = null;
        $('audio').pause();
        $('pSleep').value = '0';
        $('pSleepTip').textContent = '已定时停止';
        sleepAt = 0;
        return;
      }
      var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      $('pSleepTip').textContent = '剩 ' + m + ':' + (s < 10 ? '0' : '') + s;
    }, 1000);
  });

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
    qi = -1;
    queue = [];
    curPlayingId = '';
  });

  // 快捷键：空格 播放/暂停，← → 前后 10 秒
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
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
    if (!results.length) { el.textContent = '没有找到相关专辑，换个关键词试试'; updateSelBar(); return; }

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
      if (a.isPaid) bits.push('VIP/付费');
      if (a.category) bits.push(a.category);
      if (a.author) bits.push(a.author);
      if (a.tracks) bits.push(a.tracks + '集');
      if (a.play) bits.push(fmtPlay(a.play) + '播放');
      m.textContent = bits.join(' · ');
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
    if (searchMode === 'track') { doSearchTracks(kw, 1, true); return; }
    try {
      var r = await api('POST', '/search', { kw: kw });
      if (r.success === false) { $('searchMeta').innerHTML = '<span class="err">' + esc(r.error) + '</span>'; return; }
      pushHistory(kw);
      renderChips(r.keywords, doSearch);
      $('searchMeta').textContent = '共 ' + (r.count || 0) + ' 个结果' + (r.source ? ' · 来源：' + r.source : '');
      renderResults(r.data || []);
    } catch (e) { $('searchMeta').innerHTML = '<span class="err">搜索失败: ' + esc(e.message) + '</span>'; }
  }

  $('btnSearch').addEventListener('click', function () { doSearch($('kw').value.trim()); });
  $('kw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch($('kw').value.trim()); });
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
    renderIdleChips();
  }
  $('modeAlbum').addEventListener('click', function () { setSearchMode('album'); });
  $('modeTrack').addEventListener('click', function () { setSearchMode('track'); });

  async function doSearchTracks(kw, page, reset) {
    trackKw = kw || trackKw;
    $('searchMeta').textContent = '搜索中…';
    if (reset) { $('searchResults').innerHTML = ''; $('kwChips').innerHTML = ''; trackRows = []; }
    $('detailCard').classList.add('hide');
    $('searchCard').classList.remove('hide');
    try {
      var r = await api('POST', '/search/tracks', { kw: trackKw, page: page || 1, rows: 20 });
      if (r.success === false) { $('searchMeta').innerHTML = '<span class="err">' + escHtml(r.error) + '</span>'; return; }
      if (r.risk) { $('searchMeta').innerHTML = '<span class="err">单集搜索被风控暂时限制了，换个词或过一会儿再试</span>'; return; }
      pushHistory(trackKw);
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

  async function doImport(albumId, name, tracks) {
    if (tracks > 400 && !confirm('《' + name + '》共 ' + tracks + ' 集，导入需要一些时间，继续？')) return;
    try {
      var r = await api('POST', '/import', { album_id: String(albumId), name: name || '' });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      msg('⏳ 已开始导入《' + name + '》');
      startPolling();
    } catch (e) { msg('导入失败: ' + e.message, 'err'); }
  }

  // ---------- 详情 ----------
  var cur = { id: '', page: 1, hasMore: false, detail: null };

  async function openDetail(albumId) {
    // 详情卡片在「搜索」tab 内，从其它 tab 点进来要先切过去
    var activeTab = document.querySelector('.tab.active');
    if (!activeTab || activeTab.getAttribute('data-tab') !== 'search') {
      document.querySelector('.tab[data-tab="search"]').click();
    }
    cur.id = String(albumId);
    cur.page = 1;
    $('searchCard').classList.add('hide');
    $('detailCard').classList.remove('hide');
    $('dName').textContent = '载入中…';
    $('dMeta').textContent = '';
    $('dSubState').textContent = '';
    $('dIntro').textContent = '';
    $('dTracks').innerHTML = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      var r = await api('GET', '/album/' + cur.id);
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
      if (d.updateDate) bits.push('更新于 ' + d.updateDate);
      if (d.isPaid) bits.push('VIP/付费');
      if (d.isFinished) bits.push('已完结');
      $('dMeta').textContent = bits.join(' · ');
      $('dIntro').textContent = d.introFull || d.intro || '（无简介）';
      $('dIntroToggle').textContent = '展开简介';
      $('dIntro').classList.remove('open');
      renderSubState(d.subscription, d.subscribed);
      await pullAlbumProgress(cur.id);
      renderTracks(d.tracks || []);
      renderResume();
      $('dPage').textContent = '第 1 页';
      $('dPrev').disabled = true;
      $('dNext').disabled = !d.hasMore;
      // 倒序时直接翻到最后一页，最新一集在最前
      if (playOrder === 'desc' && d.hasMore) await jumpToOrderPage(true);
    } catch (e) { $('dName').textContent = '加载失败: ' + e.message; }
  }

  function renderSubState(sub, subscribed) {
    if (!subscribed || !sub) {
      $('dSubState').innerHTML = '<span class="muted">未订阅（订阅后可一键追加新集）</span>';
      $('btnSub').textContent = '订阅并跟进更新';
      return;
    }
    var txt = '已订阅，收录到第 ' + (sub.lastIndex || 0) + ' 集';
    if (sub.newCount) txt += ' · <span class="badge new">有 ' + sub.newCount + ' 集更新</span>';
    if (sub.lastCheckAt) txt += ' · 上次检查 ' + esc(sub.lastCheckAt);
    $('dSubState').innerHTML = '<span class="ok">●</span> ' + txt;
    $('btnSub').textContent = '取消订阅';
  }

  var curTracks = [];
  var curLast = null;
  var filterUnheard = false;

  function renderTracks(tracks) {
    var el = $('dTracks');
    el.innerHTML = '';
    curTracks = sortByOrder(tracks || []);
    tracks = curTracks;
    if (!tracks.length) { el.innerHTML = '<span class="muted">没有曲目</span>'; return; }
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
    if ($('dProgStat')) {
      $('dProgStat').textContent = '本页 ' + tracks.length + ' 集 · 已听完 ' + doneN +
        (partN ? ' · 听了一半 ' + partN : '') + ' · 未听 ' + (tracks.length - doneN - partN);
    }

    var shown = 0;
    tracks.forEach(function (t, i) {
      var state = trackStat(t.trackId);
      if (filterUnheard && state === 'done') return;
      shown += 1;
      var d = document.createElement('div');
      d.className = 'trk';
      var no = document.createElement('span');
      no.className = 'no';
      no.textContent = t.index;
      var tt = document.createElement('span');
      tt.className = 'tt';
      tt.textContent = t.title;
      var du = document.createElement('span');
      du.className = 'du';
      du.textContent = fmtDur(t.duration);
      d.appendChild(no); d.appendChild(tt);

      var pos = getPos(t.trackId);
      if (pos && pos.t) {
        var mk = document.createElement('span');
        mk.className = 'small-txt';
        mk.style.marginRight = '8px';
        var done = pos.d && pos.t >= pos.d - 20;
        mk.textContent = done ? '✓ 听完' : '⏱ ' + fmtTime(pos.t);
        mk.style.color = done ? 'var(--ok)' : 'var(--muted)';
        d.appendChild(mk);
      }

      var pl = document.createElement('button');
      pl.className = 'small plain';
      pl.textContent = '▶';
      d.appendChild(du);
      d.appendChild(pl);
      d.addEventListener('click', function () { playQueue(curTracks, i, album); });
      el.appendChild(d);
    });
    if (!shown) {
      el.innerHTML = '<span class="muted">本页都听完了。取消勾选「只看未听」可以看到全部。</span>';
    }
  }

  // 单集收听状态：none 未听 / part 听了没听完 / done 已听完
  function trackStat(trackId) {
    var pos = getPos(trackId);
    if (!pos || !pos.t) return 'none';
    if (pos.d && pos.t >= pos.d - 20) return 'done';
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

    var done = curLast.d && curLast.t >= curLast.d - 5;
    if (done) {
      // 按当前播放顺序找「下一集」：正序下一集 = 集数 +1，倒序下一集 = 集数 -1
      var step = playOrder === 'desc' ? -1 : 1;
      var nIdx = -1;
      for (var i = 0; i < curTracks.length; i++) {
        if (Number(curTracks[i].index) === Number(curLast.index) + step) { nIdx = i; break; }
      }
      curLast._next = nIdx;
      $('btnResume').textContent = nIdx >= 0
        ? '▶ 接着听 第 ' + curTracks[nIdx].index + ' 集'
        : '▶ 重听 第 ' + (curLast.index || '?') + ' 集（已听完）';
    } else {
      curLast._next = -1;
      $('btnResume').textContent = '▶ 继续听 第 ' + (curLast.index || '?') + ' 集（' + fmtTime(curLast.t || 0) + '）';
    }
  }

  $('btnResume').addEventListener('click', function () {
    var album = { id: cur.id, name: (cur.detail && cur.detail.name) || '' };
    if (!curLast || !curLast.trackId) {
      if (curTracks.length) playQueue(curTracks, 0, album);
      return;
    }
    if (curLast._next >= 0) { playQueue(curTracks, curLast._next, album); return; }
    for (var i = 0; i < curTracks.length; i++) {
      if (String(curTracks[i].trackId) === String(curLast.trackId)) { playQueue(curTracks, i, album); return; }
    }
    // 目标集不在当前页：单独播，进度照常续上
    playQueue([{ trackId: curLast.trackId, index: curLast.index, title: curLast.title }], 0, album);
  });

  $('btnFromStart').addEventListener('click', function () {
    if (!curTracks.length) return;
    curTracks.forEach(function (t) { sSet(posKey(t.trackId), ''); });
    sSet(lastKey(cur.id), '');
    renderTracks(curTracks);
    renderResume();
    playQueue(curTracks, 0, { id: cur.id, name: (cur.detail && cur.detail.name) || '' });
    msg('已清除本专辑播放进度，从第 1 集开始');
  });

  $('btnClearPos').addEventListener('click', function () {
    curTracks.forEach(function (t) { sSet(posKey(t.trackId), ''); });
    sSet(lastKey(cur.id), '');
    renderTracks(curTracks);
    renderResume();
    msg('已清除播放进度');
  });

  async function gotoPage(p) {
    if (p < 1) return;
    $('dTracks').innerHTML = '<span class="muted">载入中…</span>';
    try {
      var r = await api('GET', '/album/' + cur.id + '/tracks?page=' + p);
      if (r.success === false) { $('dTracks').textContent = '加载失败: ' + r.error; return; }
      cur.page = p;
      cur.hasMore = r.data.hasMore;
      renderTracks(r.data.tracks || []);
      $('dPage').textContent = '第 ' + p + ' 页';
      $('dPrev').disabled = p <= 1;
      $('dNext').disabled = !r.data.hasMore;
    } catch (e) { $('dTracks').textContent = '加载失败: ' + e.message; }
  }

  $('dPrev').addEventListener('click', function () { gotoPage(cur.page - 1); });
  $('dNext').addEventListener('click', function () { gotoPage(cur.page + 1); });
  $('ckUnheard').addEventListener('change', function () {
    filterUnheard = !!this.checked;
    renderTracks(sortByOrder(curTracks));
  });
  $('btnOrder').addEventListener('click', function () {
    setOrder(playOrder === 'desc' ? 'asc' : 'desc');
  });
  syncOrderBtn();
  $('btnPlayPage').addEventListener('click', function () {
    if (!curTracks.length) { msg('本页没有曲目', 'err'); return; }
    playQueue(curTracks, 0, { id: cur.id, name: (cur.detail && cur.detail.name) || '' });
  });
  $('btnBack').addEventListener('click', function () {
    $('detailCard').classList.add('hide');
    $('searchCard').classList.remove('hide');
  });
  $('dIntroToggle').addEventListener('click', function () {
    var open = $('dIntro').classList.toggle('open');
    $('dIntroToggle').textContent = open ? '收起简介' : '展开简介';
  });

  $('btnImportDetail').addEventListener('click', function () {
    var d = cur.detail;
    doImport(cur.id, d && d.name, 0);
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

  $('btnPlayAll').addEventListener('click', function () {
    var sub = cur.detail && cur.detail.subscription;
    if (!sub || !sub.playlistId) { msg('该专辑还没有歌单，先导入吧', 'err'); return; }
    playPlaylist(sub.playlistId, cur.detail.name);
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

  async function loadSubs() {
    var el = $('subsList');
    try {
      var r = await api('GET', '/subs');
      subsCache = r.data || [];
      el.innerHTML = '';
      if (!subsCache.length) {
        el.innerHTML = '<span class="muted">还没有订阅。搜索专辑后进入详情页点「订阅并跟进更新」。</span>';
        updateSubBadge();
        return;
      }
      subsCache.forEach(function (s) {
        var line = document.createElement('div');
        line.className = 'line';
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

        var bPlay = document.createElement('button');
        bPlay.className = 'small plain';
        bPlay.textContent = '▶';
        bPlay.addEventListener('click', function () {
          if (!s.playlistId) { msg('该订阅没有歌单', 'err'); return; }
          playPlaylist(s.playlistId, s.name);
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

        ops.appendChild(bSync); ops.appendChild(bAuto); ops.appendChild(bPlay); ops.appendChild(bDel);
        line.appendChild(img); line.appendChild(body); line.appendChild(ops);
        el.appendChild(line);
      });
      updateSubBadge();
    } catch (e) {
      el.innerHTML = '<span class="err">加载失败: ' + e.message + '</span>';
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
      $('autoPush').value = a.pushDevice ? '1' : '0';
    } catch (e) { /* */ }
  }

  $('btnSaveAuto').addEventListener('click', async function () {
    try {
      await api('POST', '/config', {
        auto: {
          enabled: $('autoEnabled').value === '1',
          time: $('autoTime').value || '08:30',
          pushDevice: $('autoPush').value === '1'
        }
      });
      msg('✅ 自动同步设置已保存', 'ok');
    } catch (e) { msg('保存失败: ' + e.message, 'err'); }
  });

  $('btnSyncAll').addEventListener('click', async function () {
    msg('⏳ 正在同步全部订阅…');
    try {
      var r = await api('POST', '/sync', { import: true });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      msg('✅ ' + (r.lastSync ? r.lastSync.result : '同步完成'), 'ok');
      subsCache = r.subs || subsCache;
      loadSubs();
    } catch (e) { msg('同步失败: ' + e.message, 'err'); }
  });

  $('btnCheckAll').addEventListener('click', async function () {
    msg('⏳ 正在检查更新（不导入）…');
    try {
      var r = await api('POST', '/subs/check', { import: false });
      if (r.success === false) { msg('❌ ' + r.error, 'err'); return; }
      var d = r.data || {};
      msg('检查完成：发现 ' + (d.newCount || 0) + ' 集更新', 'ok');
      subsCache = r.subs || subsCache;
      loadSubs();
    } catch (e) { msg('检查失败: ' + e.message, 'err'); }
  });

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
        var bPlay = document.createElement('button');
        bPlay.className = 'small';
        bPlay.textContent = '▶ 音箱';
        bPlay.addEventListener('click', function () { playPlaylist(a.playlistId, a.name); });
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
          if (!confirm('删除歌单《' + a.name + '》及其导入记录？歌曲库条目保留。')) return;
          await api('POST', '/imported/delete', { playlist_id: a.playlistId });
          loadImported();
        });
        ops.appendChild(bPlay); ops.appendChild(bDl); ops.appendChild(bOpen); ops.appendChild(bDel);
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
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      $('jobFill').style.width = '100%';
      $('jobText').className = 'txt ' + (j && j.error ? 'err' : 'ok');
      $('jobText').textContent = (j && j.error ? '❌ ' : '✅ ') +
        ((j && (j.title || j.current)) || '任务') + (j && j.error ? '：' + j.error : ' 完成') +
        (j && j.total ? '（' + j.done + '/' + j.total + ' 集）' : '');
      setTimeout(function () { if (!jobActive) $('jobBar').classList.remove('show'); }, 5000);
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
      (j.error ? '<br><span class="err">' + escHtml(j.error) + '</span>' : '') +
      (j.lastPath ? '<br><span class="muted">示例路径：' + escHtml(j.lastPath) + '</span>' : '');
  }

  function renderProgStat(ps) {
    var el = $('progStat');
    if (!el || !ps) return;
    el.textContent = 'NAS 上已存 ' + (ps.tracks || 0) + ' 集进度、' + (ps.albums || 0) + ' 张专辑的最后收听位置' +
      (ps.at ? ' · 最后更新 ' + ps.at : '');
  }

  function renderTtsState(t) {
    var el = $('ttsInfo');
    if (!el || !t) return;
    var c = t.cfg || {}, last = t.last || {}, dev = t.device || {};
    var bits = [];
    if (c.enabled) bits.push('已开启 · 每天 ' + (c.time || '07:30') + ' 播报');
    else bits.push('未开启');
    bits.push(dev.device_name ? ('音箱：' + dev.device_name) : '未选音箱（跟随设置）');
    if (last.at) bits.push('上次：' + last.at + ' ' + (last.result || ''));
    el.textContent = bits.join(' · ');
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

  async function loadTts() {
    try {
      var r = await api('GET', '/config');
      var t = (r.data && r.data.tts) || {};
      $('ttsTime').value = t.time || '07:30';
      $('ttsEnabled').value = t.enabled ? '1' : '0';
      $('ttsPrefix').value = t.prefix || '喜马拉雅更新提醒';
    } catch (e) { /* */ }
  }

  $('btnTtsSave').addEventListener('click', async function () {
    var v = $('ttsDevice').value;
    var body = {
      time: $('ttsTime').value || '07:30',
      enabled: $('ttsEnabled').value === '1',
      prefix: $('ttsPrefix').value.trim()
    };
    if (v) {
      var p = v.split('|');
      body.account_id = p[0]; body.device_id = p[1]; body.device_name = p[2];
    } else {
      // 选「跟随设置里的设备」：清空独立配置，运行时回落到 config.device
      body.account_id = ''; body.device_id = ''; body.device_name = '';
    }
    try {
      await api('POST', '/config', { tts: body });
      msg('✅ 播报设置已保存', 'ok');
      var st = await api('GET', '/status');
      renderTtsState(st.data && st.data.tts);
    } catch (e) { msg('保存失败: ' + e.message, 'err'); }
  });

  $('btnTtsPreview').addEventListener('click', async function () {
    try {
      var r = await api('GET', '/tts/preview');
      var d = (r && r.data) || {};
      $('ttsInfo').innerHTML = '<b>播报稿预览：</b><br>' + escHtml(d.text || '（空）') +
        (d.hint ? '<br><span class="muted">' + escHtml(d.hint) + '</span>' : '');
    } catch (e) { msg('预览失败: ' + e.message, 'err'); }
  });

  $('btnTtsPlay').addEventListener('click', async function () {
    try {
      var r = await api('POST', '/tts/run', {});
      msg(r.success === false ? '❌ ' + r.error : '🗣️ ' + (r.data.message || '已开始播报'), r.success === false ? 'err' : 'ok');
    } catch (e) { msg('播报失败: ' + e.message, 'err'); }
  });

  async function poll() {
    try {
      var r = await api('GET', '/status');
      var d = r.data || {};
      var running = renderJob(d.job);
      if (Array.isArray(d.subs)) { subsCache = d.subs; updateSubBadge(); }
      renderDl(d.dlJob);
      renderProgStat(d.progressStat);
      renderTtsState(d.tts);
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

  function boot() {
    loadLogin();
    loadDevices();
    loadAuto();
    loadProgCfg();
    loadTts();
    loadSubs();
    loadImported();
    renderIdleChips();
    poll();
    pullRecent();
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
