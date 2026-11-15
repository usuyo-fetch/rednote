// usuyo 的站点窗口里跑的那一段（usuyo 插件协议 §2.3.1「在 usuyo 的站点窗口里读」）。
// 这个文件由 build.mjs 照 src/window.js 和 src/core.js 生成，改那两个文件再跑 `node userscript/build.mjs`。
//
// usuyo 开一个只给小红书用的窗口（自己一份网页数据，和你日常的浏览器分开），你在里面登录。这一段在那一页里跑：
// 认出登录的是谁以后打开你自己的个人页，点「收藏」，usuyo 隔几秒叫它往下翻一屏（`usuyo.onStep`），
// 收藏翻到底再点「赞过」接着翻；记下的笔记链接（带 xsec_token）一页页交给 usuyo（`usuyo.submit`），
// 你在 usuyo 的导入页确认了才会去取。碰到验证页、登录墙、认不出的回答就停下，说为什么；
// 你在窗口上面点「继续」（`usuyo.onResume`）以后从停下的地方接着读，你自己点开的列表照你点的读。
// 不对小红书发额外请求、不读 cookie、不写页面的存储，页面上不放任何东西；面板在 usuyo 窗口上面那一条里。
(function (usuyo) {
  'use strict';

  const VERSION = '0.4.0';
  const page = window;
  // 一回最多交这么多条（usuyo 那边一份报告最多收 200 条）
  const REPORT_LINKS = 100;
  const TICK_MS = 1000;
  // 到了页底、这么多屏都没有新的列表回答：这一个列表算翻完了
  const QUIET_STEPS = 4;
  // 在个人页上这么久还读不出登录的是谁：当作要先登录
  const SIGNIN_WAIT_MS = 10000;
  // 点了标签这么久还没找到它：说找不到
  const TAB_WAIT_MS = 8000;
  const LABEL = { favorite: '收藏', like: '赞过' };
  const ORDER = ['favorite', 'like'];

  const pending = [];
  const seenIds = { favorite: Object.create(null), like: Object.create(null) };
  const lists = { favorite: { hasMore: null, answers: 0, done: false }, like: { hasMore: null, answers: 0, done: false } };
  const skipped = Object.create(null);
  let state = 'reading';
  let reason = '';
  let dirty = true;
  let quietSteps = 0;
  let navigated = false;
  let clicked = '';
  let clickedAt = 0;
  let profileSince = 0;
  let sentLooked = -1;
  let sentSignedIn = null;

  function stop(word) {
    if (state !== 'reading') return;
    state = 'stopped';
    reason = word;
    dirty = true;
  }

  const core = (
/*CORE*/
  )({
    page,
    noted(action, id, token, title) {
      if (seenIds[action][id]) return;
      seenIds[action][id] = true;
      const link = { action, url: location.origin + '/explore/' + id + '?xsec_token=' + encodeURIComponent(token) };
      if (title) link.title = title;
      pending.push(link);
      dirty = true;
    },
    listed(action, hasMore) {
      // 页面在读哪个列表就算点的是哪个（包括你自己点开的）
      clicked = action;
      lists[action].answers++;
      if (hasMore !== null) lists[action].hasMore = hasMore;
      quietSteps = 0;
      dirty = true;
    },
    stopped(word) {
      if (word === 'errorCode') stop('errorCode');
      else if (word === 'noAccount') stop('signin');
    },
    seen(path, outcome) {
      for (const k of Object.keys(outcome.skipped)) skipped[k] = (skipped[k] || 0) + outcome.skipped[k];
      // 列表接口的回答认不出：页面改了，停下来，别翻空的
      if (!outcome.recognised && !outcome.stopped && /\/note\/(?:collect|like)\/page$/.test(path)) stop('unknown');
      dirty = true;
    },
  });

  /** 登录的是谁：页面说没登录（`loggedIn: false`）时不算，读不出来是空的。 */
  function signedInAs() {
    try {
      const user = page.__INITIAL_STATE__ && page.__INITIAL_STATE__.user;
      const flag = user && (user.loggedIn && typeof user.loggedIn === 'object' ? user.loggedIn._value : user.loggedIn);
      if (flag === false) return '';
    } catch (e) {
      return '';
    }
    return core.ownUserId();
  }

  function ownProfile(me) {
    return Boolean(me) && location.pathname.indexOf('/user/profile/' + me) === 0;
  }

  /** 验证页：地址或标题像验证、安全检查。 */
  function verifying() {
    return /\/(?:captcha|verify|security)/i.test(location.pathname) || /验证|captcha/i.test(String(document.title || ''));
  }

  /** 还没翻完的第一个列表。 */
  function current() {
    return ORDER.find((a) => !lists[a].done && lists[a].hasMore !== false) || '';
  }

  /** 页面上写着这个名字的标签（「收藏」「赞过」）。 */
  function tabFor(action) {
    const want = LABEL[action];
    let found = null;
    for (const el of document.querySelectorAll('[role="tab"], [class*="tab"], span, div')) {
      if (el.children.length > 2 || String(el.textContent || '').trim() !== want) continue;
      found = el;
      if (el.getAttribute('role') === 'tab' || /tab/i.test(String(el.className || ''))) break;
    }
    return found;
  }

  function diagnosis() {
    const kind = ownProfile(signedInAs()) ? 'profile' : 'other';
    return Object.assign({ tool: 'usuyo-xhs-window', version: VERSION, page: kind, startedAs: core.startedAs }, core.report());
  }

  function report() {
    const stats = core.stats();
    const r = {
      links: pending.splice(0, REPORT_LINKS),
      counts: { requests: stats.requests, recognised: stats.recognised, skipped: Object.assign({}, skipped) },
      state,
      signedIn: Boolean(signedInAs()),
    };
    sentSignedIn = r.signedIn;
    if (reason) r.reason = reason;
    if (stats.looked !== sentLooked) {
      r.diagnosis = JSON.stringify(diagnosis(), null, 2);
      sentLooked = stats.looked;
    }
    dirty = pending.length > 0;
    usuyo.submit(r);
  }

  function tick() {
    const now = Date.now();
    const me = signedInAs();
    if (Boolean(me) !== sentSignedIn) dirty = true;
    if (state === 'reading' && verifying()) stop('verify');
    if (location.pathname.indexOf('/user/profile/') === 0) {
      if (!profileSince) profileSince = now;
      if (!me && now - profileSince > SIGNIN_WAIT_MS) stop('signin');
    }
    if (state === 'reading' && me && !ownProfile(me) && !navigated) {
      // 登录好了：去你自己的个人页
      navigated = true;
      report();
      location.assign('/user/profile/' + me);
      return;
    }
    if (state === 'reading' && ownProfile(me)) {
      const action = current();
      if (!action) {
        state = 'end';
        dirty = true;
      } else if (clicked !== action) {
        const tab = tabFor(action);
        if (tab) {
          clicked = action;
          clickedAt = now;
          quietSteps = 0;
          page.scrollTo(0, 0);
          tab.click();
        } else if (!clickedAt) {
          clickedAt = now;
        } else if (now - clickedAt > TAB_WAIT_MS) {
          stop('notab');
        }
      }
    }
    if (dirty || pending.length) report();
  }

  /** usuyo 叫往下翻一屏：到底了数几屏，几屏都没有新回答就算这个列表翻完了。 */
  function step() {
    const me = signedInAs();
    if (state !== 'reading' || !ownProfile(me) || clicked !== current()) return;
    const el = document.scrollingElement || document.documentElement;
    const bottom = page.innerHeight + page.scrollY >= el.scrollHeight - 4;
    if (bottom) {
      quietSteps++;
      if (quietSteps >= QUIET_STEPS) {
        const action = clicked;
        if (lists[action].answers === 0) stop('quiet');
        else lists[action].done = true;
        quietSteps = 0;
        dirty = true;
        return;
      }
    } else {
      quietSteps = 0;
    }
    page.scrollBy({ top: Math.round(page.innerHeight * 0.85), behavior: 'smooth' });
  }

  /** 停下以后点了「继续」：从停下的地方接着读，先告诉 usuyo 接着读了。 */
  function resume() {
    if (state !== 'stopped') return;
    state = 'reading';
    reason = '';
    quietSteps = 0;
    clickedAt = 0;
    profileSince = 0;
    report();
  }

  usuyo.onStep(step);
  usuyo.onResume(resume);
  setInterval(tick, TICK_MS);
})
