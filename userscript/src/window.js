// usuyo 的站点窗口里跑的那一段（usuyo 插件协议 §2.3.1「在 usuyo 的站点窗口里读」）。
// 这个文件由 build.mjs 照 src/window.js 和 src/core.js 生成，改那两个文件再跑 `node userscript/build.mjs`。
//
// usuyo 开一个只给小红书用的窗口（自己一份网页数据，和你日常的浏览器分开），你在里面登录。这一段在那一页里跑：
// 认出登录的是谁以后打开你自己的个人页，点「收藏」，usuyo 隔几秒叫它往下翻一屏（`usuyo.onStep`），
// 收藏翻到底再点「赞过」（页面上写「点赞」）接着翻；记下的笔记链接（带 xsec_token、xsec_source）一页页交给 usuyo
// （`usuyo.submit`），每读完一个列表就在报告的 `finished` 里说一声，usuyo 把这个列表交给导入页；你确认了才会去取。
// 一个列表找不到、翻到底也没有回答、回答认不出：跳过它，在 `finished` 里写原因，接着读下一个，都读过了就说到底了。
// 只有要你动手的才停下：验证页、登录墙、站点回了错误码；你在窗口上面点「继续」（`usuyo.onResume`）以后
// 从停下的地方接着读，你自己点开的列表照你点的读。
// 不对小红书发额外请求、不读 cookie、不写页面的存储，页面上不放任何东西；面板在 usuyo 窗口上面那一条里。
(function (usuyo) {
  'use strict';

  const VERSION = '0.5.0';
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
  // 个人页上「赞过」那一栏现在写的是「点赞」（2026-11-15 在真页面上看到的），旧名字留着
  const LABEL = { favorite: ['收藏'], like: ['点赞', '赞过'] };
  // 收藏、赞过页上笔记链接带的 xsec_source，取单条时和 xsec_token 一起带（照 xhs-vault 的 userscript/xhs-export.user.js:147）
  const XSEC_SOURCE = 'pc_user';
  const ORDER = ['favorite', 'like'];

  const pending = [];
  const seenIds = { favorite: Object.create(null), like: Object.create(null) };
  // `skipped`：没读这个列表的原因（`notab`、`quiet`、`unknown`），空的是没跳过
  const lists = {
    favorite: { hasMore: null, answers: 0, done: false, skipped: '' },
    like: { hasMore: null, answers: 0, done: false, skipped: '' },
  };
  const skipped = Object.create(null);
  let state = 'reading';
  let reason = '';
  let dirty = true;
  let quietSteps = 0;
  let navigated = false;
  let clicked = '';
  let clickedAt = 0;
  let profileSince = 0;
  let sentDiagnosis = '';
  let sentSignedIn = null;

  function stop(word) {
    if (state !== 'reading') return;
    state = 'stopped';
    reason = word;
    dirty = true;
  }

  /** 这个列表不读了，写下为什么；接着读下一个（下一个的标签重新等）。 */
  function skip(action, why) {
    if (!action || lists[action].done || lists[action].skipped) return;
    lists[action].skipped = why;
    if (clicked === action) clicked = '';
    clickedAt = 0;
    quietSteps = 0;
    dirty = true;
  }

  /** 读过了的列表：读到底的不带原因，跳过的带原因。 */
  function finished(a) {
    const l = lists[a];
    return l.done || l.hasMore === false || Boolean(l.skipped);
  }

  const core = (
/*CORE*/
  )({
    page,
    noted(action, id, token, title) {
      if (seenIds[action][id]) return;
      seenIds[action][id] = true;
      const link = {
        action,
        url: location.origin + '/explore/' + id + '?xsec_token=' + encodeURIComponent(token) + '&xsec_source=' + XSEC_SOURCE,
      };
      if (title) link.title = title;
      pending.push(link);
      dirty = true;
    },
    listed(action, hasMore) {
      // 页面在读哪个列表就算点的是哪个（包括你自己点开的）
      clicked = action;
      lists[action].answers++;
      if (hasMore !== null) lists[action].hasMore = hasMore;
      // 读到底了：下一个列表的标签从现在起等
      if (hasMore === false) clickedAt = 0;
      quietSteps = 0;
      dirty = true;
    },
    stopped(word) {
      if (word === 'errorCode') stop('errorCode');
      else if (word === 'noAccount') stop('signin');
    },
    seen(path, outcome) {
      for (const k of Object.keys(outcome.skipped)) skipped[k] = (skipped[k] || 0) + outcome.skipped[k];
      // 列表接口的回答认不出：页面改了，这个列表跳过，别翻空的
      const m = /\/note\/(collect|like)\/page$/.exec(path);
      if (!outcome.recognised && !outcome.stopped && m) skip(m[1] === 'collect' ? 'favorite' : 'like', 'unknown');
      dirty = true;
    },
  });

  /** 页面状态里的一个值：Vue 的 ref 读它的值（计算出来的 ref 要读 `value` 才有）。 */
  function unref(v) {
    if (!v || typeof v !== 'object') return v;
    if ('value' in v) return v.value;
    return '_value' in v ? v._value : v._rawValue;
  }

  /**
   * 登录的是谁；读不出来、没登录是空的。没登录的访客页面上 `userInfo` 里也有一个 id，所以有 id 不算数，
   * 还要有登录了才有的东西：页面说 `loggedIn` 是真，或者页面上有指向这个 id 的个人页的链接（侧栏的「我」；
   * MediaCrawler `media_platform/xhs/login.py:56-66` 照它认登录）。页面说 `loggedIn` 是假的一律不算。
   */
  function signedInAs() {
    const f = signinFacts();
    if (f.flag === false || !f.me) return '';
    return f.flag === true || f.link ? f.me : '';
  }

  /** 认登录用到的三样：页面说的 `loggedIn`、读出的 id、页面上有没有指向这个 id 的个人页链接。 */
  function signinFacts() {
    let flag;
    try {
      const user = page.__INITIAL_STATE__ && page.__INITIAL_STATE__.user;
      flag = user ? unref(user.loggedIn) : undefined;
    } catch (e) {
      flag = undefined;
    }
    const me = core.ownUserId();
    let link = false;
    try {
      link = Boolean(me) && Boolean(document.querySelector('a[href*="/user/profile/' + me + '"]'));
    } catch (e) {
      link = false;
    }
    return { flag, me, link };
  }

  function ownProfile(me) {
    return Boolean(me) && location.pathname.indexOf('/user/profile/' + me) === 0;
  }

  /** 验证页：地址或标题像验证、安全检查。 */
  function verifying() {
    return /\/(?:captcha|verify|security)/i.test(location.pathname) || /验证|captcha/i.test(String(document.title || ''));
  }

  /** 还没读过的第一个列表。 */
  function current() {
    return ORDER.find((a) => !finished(a)) || '';
  }

  /** 页面上写着这个名字的标签（「收藏」「赞过」）。 */
  function tabFor(action) {
    const want = LABEL[action];
    let found = null;
    for (const el of document.querySelectorAll('[role="tab"], [class*="tab"], span, div')) {
      if (el.children.length > 2 || !want.includes(String(el.textContent || '').trim())) continue;
      found = el;
      if (el.getAttribute('role') === 'tab' || /tab/i.test(String(el.className || ''))) break;
    }
    return found;
  }

  function diagnosis() {
    const kind = ownProfile(signedInAs()) ? 'profile' : 'other';
    // 页面状态里 `user` 的形状（键和类型）：认登录照它，页面改了一眼看得出
    let user = 'none';
    try {
      user = core.shapeOf(page.__INITIAL_STATE__ && page.__INITIAL_STATE__.user);
    } catch (e) {
      user = 'unreadable';
    }
    // 认登录的三样（不含 id 本身）：真跑时停在「登录」能看出缺的是哪一样
    const f = signinFacts();
    const signin = { loggedIn: f.flag === true || f.flag === false ? String(f.flag) : f.flag === undefined ? 'absent' : typeof f.flag, id: Boolean(f.me), profileLink: f.link };
    return Object.assign({ tool: 'usuyo-xhs-window', version: VERSION, page: kind, startedAs: core.startedAs, signin, user }, core.report());
  }

  function report() {
    const stats = core.stats();
    const r = {
      links: pending.splice(0, REPORT_LINKS),
      counts: { requests: stats.requests, recognised: stats.recognised, skipped: Object.assign({}, skipped) },
      state,
      signedIn: Boolean(signedInAs()),
    };
    // 读过了、记下的也都交出去了的列表
    r.finished = ORDER.filter((a) => finished(a) && !pending.some((l) => l.action === a)).map((a) =>
      lists[a].skipped ? { action: a, reason: lists[a].skipped } : { action: a },
    );
    sentSignedIn = r.signedIn;
    if (reason) r.reason = reason;
    const d = JSON.stringify(diagnosis(), null, 2);
    if (d !== sentDiagnosis) {
      r.diagnosis = d;
      sentDiagnosis = d;
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
          skip(action, 'notab');
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
        if (lists[action].answers === 0) {
          skip(action, 'quiet');
        } else {
          lists[action].done = true;
          clickedAt = 0;
          quietSteps = 0;
          dirty = true;
        }
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
