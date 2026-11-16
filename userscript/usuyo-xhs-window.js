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
// 两个壳共用的核心：只看页面自己请求回来的「收藏」「赞过」列表，认出笔记 id、xsec_token 和标题，
// 一条条交给壳（`host.noted`）；记下回答的形状给「复制诊断」。不发请求、不读 cookie、不写页面的存储。
// build.mjs 把这一段原样放进 usuyo-xhs-saved.user.js（脚本管理器）和 usuyo-xhs-window.js（usuyo 的站点窗口）。
//
// host：page（页面的 window）；noted(action, id, token, title)；listed(action, hasMore)；
// stopped(word, detail)：页面拿到的回答叫停（errorCode、notYours、noAccount）；
// seen(path, outcome)：看过一个回答（认没认出都叫）。
(function (host) {
  'use strict';

  const page = host.page;
  // 收藏页、赞过页自己请求的列表（OpenCLI 的 collection-helpers.js 记的接口名）
  const ENDPOINT = /\/api\/sns\/web\/v\d+\/note\/(collect|like)\/page(?:[?#]|$)/;
  // 名字像收藏、赞过的接口（改了名也能进诊断）；认得的只有上面那两个
  const LIKELY = /\/api\/sns\/web\/[^?#]*(?:collect|like|fav)[^?#]*$/i;
  // 脚本跑起来时页面的载入状态；注入得晚的话这里不是 loading
  const STARTED_AS = typeof document === 'undefined' ? 'unknown' : String(document.readyState || 'unknown');

  // ---------- 诊断：只记回答的形状，不记任何值 ----------
  // 下面这一段（到「诊断结束」）在三个 usuyo-fetch 油猴脚本里逐字相同，形状归约照
  // usuyo-fetch/wechat-channels 的 userscript/usuyo-sph-probe.user.js；改一处要三处一起改。

  const LIMITS = {
    depth: 24,
    nodes: 8000,
    arrayItems: 4,
    keys: 80,
    union: 4,
    textBytes: 4000000,
    // 诊断里最多留几种不同的回答
    answers: 20,
  };

  function safeKey(key) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,39}$/.test(key)) return false;
    if ((key.match(/[0-9]/g) || []).length > 3) return false;
    return !/^[0-9a-f]{12,}$/i.test(key);
  }

  function tryJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (_) {
      return { ok: false };
    }
  }

  function looksJson(text) {
    if (text.length < 2 || text.length > LIMITS.textBytes) return false;
    const c = text.trimStart()[0];
    return c === '{' || c === '[';
  }

  function binaryShape(v) {
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return 'binary:' + v.byteLength;
    if (ArrayBuffer.isView(v)) return 'binary:' + v.byteLength;
    if (tag === '[object Blob]' || tag === '[object File]') return 'blob:' + v.size;
    return null;
  }

  // Reduces a value to its structure: key paths, value types and lengths. Strings become their
  // length, numbers their type. A string holding JSON is opened `jsonLeft` more levels.
  function shapeOf(v, depth, budget, jsonLeft) {
    depth = depth || 0;
    budget = budget || { n: 0 };
    jsonLeft = jsonLeft === undefined ? 1 : jsonLeft;
    if (++budget.n > LIMITS.nodes) return '…';
    if (v === null) return 'null';
    switch (typeof v) {
      case 'undefined':
      case 'boolean':
      case 'number':
      case 'bigint':
      case 'function':
      case 'symbol':
        return typeof v;
      case 'string':
        if (jsonLeft > 0 && looksJson(v)) {
          const parsed = tryJson(v);
          if (parsed.ok) return { $json: v.length, $value: shapeOf(parsed.value, depth + 1, budget, jsonLeft - 1) };
        }
        return 'string:' + v.length;
      default:
        break;
    }
    if (depth >= LIMITS.depth) return '…';
    const bin = binaryShape(v);
    if (bin) return bin;
    if (Array.isArray(v)) {
      if (v.length === 0) return { $array: 0 };
      let items;
      const n = Math.min(v.length, LIMITS.arrayItems);
      for (let i = 0; i < n; i++) {
        const s = shapeOf(v[i], depth + 1, budget, jsonLeft);
        items = i === 0 ? s : mergeShapes(items, s);
      }
      return { $array: v.length, $items: items };
    }
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object Date]') return 'date';
    if (tag === '[object Map]' || tag === '[object Set]') return tag.slice(8, -1).toLowerCase() + ':' + v.size;
    const out = {};
    let other = null;
    let otherCount = 0;
    let keys;
    try {
      keys = Object.keys(v);
    } catch (_) {
      return 'object';
    }
    let taken = 0;
    for (const k of keys) {
      let child;
      try {
        child = shapeOf(v[k], depth + 1, budget, jsonLeft);
      } catch (_) {
        child = 'unreadable';
      }
      if (safeKey(k) && taken < LIMITS.keys) {
        out[k] = child;
        taken++;
      } else {
        otherCount++;
        other = other === null ? child : mergeShapes(other, child);
      }
    }
    if (otherCount) out.$otherKeys = { $count: otherCount, $value: other };
    return out;
  }

  function isRecord(s) {
    return s !== null && typeof s === 'object' && !Array.isArray(s);
  }

  function mergeRange(a, b) {
    const lo = Math.min(Array.isArray(a) ? a[0] : a, Array.isArray(b) ? b[0] : b);
    const hi = Math.max(Array.isArray(a) ? a[1] : a, Array.isArray(b) ? b[1] : b);
    return lo === hi ? lo : [lo, hi];
  }

  // Merges two shapes produced by shapeOf, so repeated answers collapse into one schema.
  function mergeShapes(a, b) {
    if (a === undefined || a === '…') return b;
    if (b === undefined || b === '…') return a;
    if (JSON.stringify(a) === JSON.stringify(b)) return a;
    if (typeof a === 'string' && typeof b === 'string') {
      const ma = /^(string|binary|blob):(\d+)(?:\.\.(\d+))?$/.exec(a);
      const mb = /^(string|binary|blob):(\d+)(?:\.\.(\d+))?$/.exec(b);
      if (ma && mb && ma[1] === mb[1]) {
        const lo = Math.min(+ma[2], +mb[2]);
        const hi = Math.max(+(ma[3] || ma[2]), +(mb[3] || mb[2]));
        return lo === hi ? ma[1] + ':' + lo : ma[1] + ':' + lo + '..' + hi;
      }
    }
    if (isRecord(a) && isRecord(b) && !('$oneOf' in a) && !('$oneOf' in b)) {
      if ('$array' in a && '$array' in b) {
        const out = { $array: mergeRange(a.$array, b.$array) };
        const items = mergeShapes(a.$items, b.$items);
        if (items !== undefined) out.$items = items;
        return out;
      }
      if ('$json' in a && '$json' in b) {
        return { $json: mergeRange(a.$json, b.$json), $value: mergeShapes(a.$value, b.$value) };
      }
      if (!('$array' in a) && !('$array' in b) && !('$json' in a) && !('$json' in b)) {
        const out = {};
        for (const k of Object.keys(a)) out[k] = k in b ? mergeShapes(a[k], b[k]) : a[k];
        for (const k of Object.keys(b)) if (!(k in a)) out[k] = b[k];
        if (a.$otherKeys && b.$otherKeys) {
          out.$otherKeys = {
            $count: Math.max(a.$otherKeys.$count, b.$otherKeys.$count),
            $value: mergeShapes(a.$otherKeys.$value, b.$otherKeys.$value),
          };
        }
        return out;
      }
    }
    const options = [];
    for (const s of [].concat(isRecord(a) && a.$oneOf ? a.$oneOf : [a], isRecord(b) && b.$oneOf ? b.$oneOf : [b])) {
      if (!options.some((o) => JSON.stringify(o) === JSON.stringify(s))) options.push(s);
    }
    return { $oneOf: options.length > LIMITS.union ? options.slice(0, LIMITS.union).concat('…') : options };
  }

  // ---------- paths ----------

  function safeSegment(seg) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(seg)) return ':x';
    if ((seg.match(/[0-9]/g) || []).length > 6) return ':x';
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ':x';
    return seg;
  }

  // Pathname only, with id-like segments replaced; query and hash are dropped.
  function safePath(pathname) {
    return pathname
      .split('/')
      .map((seg, i) => (i === 0 || seg === '' ? seg : safeSegment(seg)))
      .join('/');
  }

  // 请求地址的路径：去掉协议、主机、查询和片段
  function pathOf(rawUrl) {
    const path = String(rawUrl).replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*/i, '').split(/[?#]/)[0];
    return path.charAt(0) === '/' ? path : '/' + path;
  }

  // 诊断里的路径：像 id 的段（带数字、或长得不像一个词）换成 :x
  function diagPath(rawUrl) {
    return safePath(pathOf(rawUrl))
      .split('/')
      .map((seg) => (seg.length > 30 || (/[0-9]/.test(seg) && !/^v[0-9]{1,2}$/.test(seg)) ? ':x' : seg))
      .join('/')
      .slice(0, 120);
  }

  // 脚本数过的东西只用几个固定的词；别的词一律记成 other
  function safeWord(word) {
    return typeof word === 'string' && /^[a-z][A-Za-z]{0,24}$/.test(word) ? word : 'other';
  }

  function whole(n) {
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  /** 一个回答的文本：能解析成 JSON 就带上它的形状，否则只记长度。 */
  function readAnswer(text) {
    const parsed = tryJson(text);
    if (parsed.ok) return { json: true, value: parsed.value, shape: shapeOf(parsed.value) };
    return { json: false, value: undefined, shape: 'string:' + String(text).length };
  }

  /** 没认出是列表回答时的结果；认出时 `recognised` 为 true，`skipped` 是按固定的词分的跳过数。 */
  const NOT_RECOGNISED = Object.freeze({ recognised: false, took: 0, skipped: Object.freeze({}), stopped: '' });

  const answerLog = new Map();
  // requests：经过脚本的 fetch、XHR 一共多少个（只是个数），用来分清「没看到请求」和「看到了但不认得」
  const answerStats = { requests: 0, looked: 0, recognised: 0, dropped: 0 };

  /** 记一个看过的回答；同一路径、状态、是否 JSON、是否认出的重复合并，只留最近 LIMITS.answers 种。 */
  function logAnswer(path, httpStatus, json, shape, outcome) {
    answerStats.looked++;
    if (outcome.recognised) answerStats.recognised++;
    const code = whole(httpStatus);
    const key = [path, code, json, outcome.recognised].join(' ');
    const entry = answerLog.get(key) || { path, status: code, json, recognised: outcome.recognised, answers: 0, took: 0, skipped: {}, stopped: [], shape: undefined };
    answerLog.delete(key);
    entry.answers++;
    entry.took += whole(outcome.took);
    for (const kind of Object.keys(outcome.skipped)) {
      const word = safeWord(kind);
      entry.skipped[word] = (entry.skipped[word] || 0) + whole(outcome.skipped[kind]);
    }
    if (outcome.stopped) {
      const word = safeWord(outcome.stopped);
      if (!entry.stopped.includes(word)) entry.stopped.push(word);
    }
    entry.shape = mergeShapes(entry.shape, shape);
    answerLog.set(key, entry);
    if (answerLog.size > LIMITS.answers) {
      answerLog.delete(answerLog.keys().next().value);
      answerStats.dropped++;
    }
  }

  function answerReport() {
    return {
      requests: answerStats.requests,
      looked: answerStats.looked,
      recognised: answerStats.recognised,
      dropped: answerStats.dropped,
      answers: Array.from(answerLog.values(), (e) => ({
        path: e.path,
        status: e.status,
        json: e.json,
        recognised: e.recognised,
        answers: e.answers,
        took: e.took,
        skipped: Object.assign({}, e.skipped),
        stopped: e.stopped.slice(),
        shape: e.shape,
      })),
    };
  }

  // ---------- 诊断结束 ----------

  // ---------- 只看页面自己请求回来的列表 ----------

  function actionOf(url) {
    const m = ENDPOINT.exec(url);
    if (!m) return null;
    return m[1] === 'collect' ? 'favorite' : 'like';
  }

  /** 要看的回答：认得的两个接口，和名字像的。 */
  function looked(url) {
    return Boolean(actionOf(url)) || LIKELY.test(pathOf(url));
  }

  /** 登录的是谁：读页面已有的状态对象，不发请求。读不出来就是空字符串。 */
  function ownUserId() {
    try {
      const info = page.__INITIAL_STATE__ && page.__INITIAL_STATE__.user && page.__INITIAL_STATE__.user.userInfo;
      const value = info && (info._value || info._rawValue || info.value || info);
      return String((value && (value.user_id || value.userId)) || '');
    } catch (e) {
      return '';
    }
  }

  /** 认得就交给壳，回一份「认出了吗、收了几条、按什么跳过」给诊断。 */
  function absorb(rawUrl, json) {
    const action = actionOf(rawUrl);
    if (!action || !json || typeof json !== 'object') return NOT_RECOGNISED;
    if (json.code !== 0) {
      // 掉线或风控时页面自己拿到的就是这些码；照实说出来，让你停手
      host.stopped('errorCode', String(json.code).slice(0, 12));
      return { recognised: false, took: 0, skipped: {}, stopped: 'errorCode' };
    }
    const data = json.data || {};
    const notes = Array.isArray(data.notes) ? data.notes : Array.isArray(data.note_list) ? data.note_list : null;
    // 只收你自己的列表：请求里的 user_id 要等于页面里登录的那个人
    let listOwner = '';
    try {
      listOwner = new URL(rawUrl, page.location.href).searchParams.get('user_id') || '';
    } catch (e) {
      return { recognised: notes !== null, took: 0, skipped: {}, stopped: 'badUrl' };
    }
    const me = ownUserId();
    if (!me || listOwner !== me) {
      host.stopped(me ? 'notYours' : 'noAccount', '');
      return { recognised: notes !== null, took: 0, skipped: {}, stopped: me ? 'notYours' : 'noAccount' };
    }
    let took = 0;
    const skipped = { noId: 0, noToken: 0 };
    for (const n of notes || []) {
      const card = (n && (n.note_card || n.noteCard)) || n || {};
      const id = String(n.note_id || n.noteId || n.id || card.note_id || card.noteId || '');
      const token = String(n.xsec_token || n.xsecToken || card.xsec_token || card.xsecToken || '');
      if (!/^[0-9a-f]{24}$/i.test(id) || !token) {
        skipped[/^[0-9a-f]{24}$/i.test(id) ? 'noToken' : 'noId']++;
        continue;
      }
      const title = String(card.display_title || card.displayTitle || card.title || '').slice(0, 200);
      host.noted(action, id.toLowerCase(), token, title);
      took++;
    }
    host.listed(action, 'has_more' in data ? data.has_more : null);
    return { recognised: notes !== null, took, skipped, stopped: '' };
  }

  /** 看过的回答：认得的交给 absorb，认不得的也记下它的形状。 */
  function take(rawUrl, httpStatus, answer) {
    let outcome = NOT_RECOGNISED;
    if (answer.json) {
      try {
        outcome = absorb(rawUrl, answer.value);
      } catch (e) {
        outcome = { recognised: false, took: 0, skipped: {}, stopped: 'failed' };
      }
    }
    const path = diagPath(rawUrl);
    logAnswer(path, httpStatus, answer.json, answer.shape, outcome);
    host.seen(path, outcome);
  }

  // fetch：拿响应的副本读，原响应原样交回页面
  const originalFetch = page.fetch;
  page.fetch = function (input) {
    answerStats.requests++;
    const result = originalFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (looked(url)) {
        result
          .then((r) => r.clone().text().then((text) => take(url, r.status, readAnswer(text))))
          .catch(() => {});
      }
    } catch (e) {
      // 读不了就不记，页面照常
    }
    return result;
  };

  // XHR：请求地址记在脚本自己的 WeakMap 里，不往页面的对象上挂属性
  const xhrUrls = new WeakMap();
  const xhr = page.XMLHttpRequest.prototype;
  const originalOpen = xhr.open;
  const originalSend = xhr.send;
  xhr.open = function (_method, url) {
    try {
      xhrUrls.set(this, String(url));
    } catch (e) {
      // 同上
    }
    return originalOpen.apply(this, arguments);
  };
  xhr.send = function () {
    answerStats.requests++;
    const url = xhrUrls.get(this) || '';
    if (looked(url)) {
      this.addEventListener('load', () => {
        try {
          const answer =
            this.responseType === 'json'
              ? { json: this.response !== null, value: this.response, shape: shapeOf(this.response) }
              : readAnswer(this.responseText);
          take(url, this.status, answer);
        } catch (e) {
          // 同上
        }
      });
    }
    return originalSend.apply(this, arguments);
  };

  return Object.freeze({
    ownUserId,
    /** 一个值的形状（键、类型、长度），不含值。 */
    shapeOf: (v) => shapeOf(v),
    startedAs: STARTED_AS,
    /** 计数：经过脚本的请求、看过的、认出的回答。 */
    stats: () => ({ requests: answerStats.requests, looked: answerStats.looked, recognised: answerStats.recognised }),
    /** 只有形状的诊断（壳再加上自己的名字、版本、页面种类）。 */
    report: answerReport,
  });
})
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
