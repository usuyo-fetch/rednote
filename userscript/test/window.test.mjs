// node --test userscript/test/
// usuyo 站点窗口里的那一段（usuyo-xhs-window.js），对着一个假的小红书页面跑：页面自己按标签和滚动请求列表，
// 回答的形状照 harness.mjs 的 note()（note_id、xsec_token、display_title，data.has_more 翻页）。
// 全在进程里，不连任何地方；usuyo 那边换成一个记下报告的假对象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { note } from './harness.mjs';

const SOURCE = readFileSync(new URL('../usuyo-xhs-window.js', import.meta.url), 'utf8');
const ME = '5b56be0014de415b2db830a6';
const ORIGIN = 'https://www.xiaohongshu.com';

/** 一个标签：写着「收藏」或「赞过」，点了以后页面去要第一页。 */
class Tab {
  constructor(text, onClick) {
    this.textContent = text;
    this.children = [];
    this.className = 'reds-tab-item';
    this.onClick = onClick;
  }
  getAttribute() {
    return null;
  }
  click() {
    this.onClick();
  }
}

/**
 * 假的页面：`pages` 是每个列表的几页；`answer` 可以换掉某一页的回答（形状改了、回了 code）。
 * 页面自己请求，脚本只看。
 */
function site({ pages, answer, path = '/explore', title = '小红书', hideTabs = false } = {}) {
  const fetched = [];
  const listeners = {};
  let interval = null;
  const shown = { action: '', loaded: 0 };
  const win = {
    __INITIAL_STATE__: { user: { userInfo: { _value: {} } } },
    innerHeight: 800,
    scrollY: 0,
    location: {
      origin: ORIGIN,
      pathname: path,
      get href() {
        return ORIGIN + this.pathname;
      },
      assign(p) {
        win.location.pathname = p;
        win.assigned = p;
      },
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of listeners[type] || []) fn();
    },
    scrollTo(_x, y) {
      win.scrollY = y;
    },
    scrollBy(o) {
      win.scrollY = Math.min(win.scrollY + o.top, doc.scrollingElement.scrollHeight - win.innerHeight);
      // 到底了：页面自己要下一页
      if (win.scrollY + win.innerHeight >= doc.scrollingElement.scrollHeight - 4) more();
    },
    fetch: async (url) => {
      fetched.push(String(url));
      const u = new URL(url);
      const m = /note\/(collect|like)\/page$/.exec(u.pathname);
      const action = m && (m[1] === 'collect' ? 'favorite' : 'like');
      const i = Number(u.searchParams.get('cursor') || 0);
      const list = (action && pages[action]) || [];
      const body = (answer && answer(action, i)) || { code: 0, data: { has_more: i < list.length - 1, cursor: String(i + 1), notes: list[i] || [] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    XMLHttpRequest: class {
      open() {}
      send() {}
    },
  };
  function request(action, i) {
    const name = action === 'favorite' ? 'v2/note/collect' : 'v1/note/like';
    return win.fetch(ORIGIN + '/api/sns/web/' + name + '/page?num=30&cursor=' + i + '&user_id=' + ME);
  }
  function more() {
    const list = pages[shown.action] || [];
    if (shown.loaded < list.length) {
      void request(shown.action, shown.loaded);
      shown.loaded++;
      doc.scrollingElement.scrollHeight = 1000 * shown.loaded + 800;
    }
  }
  const show = (action) => () => {
    shown.action = action;
    shown.loaded = 0;
    doc.scrollingElement.scrollHeight = 800;
    more();
  };
  const tabs = [new Tab('笔记', () => {}), new Tab('收藏', show('favorite')), new Tab('点赞', show('like'))];
  const shownTabs = { on: !hideTabs, only: null };
  // 侧栏里指向你自己个人页的「我」：登录了才有（MediaCrawler 照它认登录）
  const sidebar = { on: false };
  const doc = {
    title,
    readyState: 'loading',
    scrollingElement: { scrollHeight: 800 },
    querySelectorAll: () => (shownTabs.on ? tabs.filter((t) => !shownTabs.only || shownTabs.only.includes(t.textContent)) : []),
    querySelector: (sel) => (sidebar.on && sel.includes('/user/profile/' + ME) ? {} : null),
  };
  const reports = [];
  const usuyo = {
    lang: 'zh-Hans',
    submit: (r) => {
      reports.push(JSON.parse(JSON.stringify(r)));
      return Promise.resolve();
    },
    onStep: (fn) => win.addEventListener('usuyo:step', fn),
    onResume: (fn) => win.addEventListener('usuyo:resume', fn),
  };
  // 脚本经 fetch 原样交回页面；这里换掉页面的 fetch 以后再载入，脚本包住的就是它
  const run = new Function('window', 'document', 'location', 'setInterval', 'return (' + SOURCE + '\n)');
  const start = run(win, doc, win.location, (fn) => {
    interval = fn;
    return 0;
  });
  start(usuyo);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return {
    win,
    doc,
    reports,
    fetched,
    signIn: () => {
      win.__INITIAL_STATE__.user.userInfo._value = { user_id: ME };
      sidebar.on = true;
    },
    /** 只显示这几个标签。 */
    onlyTabs: (names) => {
      shownTabs.only = names;
    },
    tick: async () => {
      interval();
      await settle();
    },
    step: async () => {
      win.dispatch('usuyo:step');
      await settle();
      interval();
      await settle();
    },
    links: () => reports.flatMap((r) => r.links),
    tabs,
    showTabs: () => {
      shownTabs.on = true;
    },
    resume: async () => {
      win.dispatch('usuyo:resume');
      await settle();
    },
    setTitle: (t) => {
      doc.title = t;
    },
    last: () => reports[reports.length - 1],
  };
}

const notes = (from, n) => Array.from({ length: n }, (_, i) => note(from + i));

test('waits for the sign-in, then opens your own profile', async () => {
  const s = site({ pages: {} });
  await s.tick();
  assert.equal(s.last().signedIn, false);
  assert.equal(s.win.assigned, undefined, 'stays put before you sign in');
  s.signIn();
  await s.tick();
  assert.equal(s.win.assigned, '/user/profile/' + ME);
  assert.ok(s.reports.some((r) => r.signedIn === true));
});

test('reads favorites then likes page by page and says when the list ends', async () => {
  const s = site({ path: '/user/profile/' + ME, pages: { favorite: [notes(1, 3), notes(4, 3)], like: [notes(10, 2)] } });
  s.signIn();
  await s.tick();
  for (let i = 0; i < 12 && s.last().state !== 'end'; i++) await s.step();
  assert.equal(s.last().state, 'end');
  const links = s.links();
  assert.deepEqual(
    links.map((l) => l.action),
    ['favorite', 'favorite', 'favorite', 'favorite', 'favorite', 'favorite', 'like', 'like'],
  );
  for (const l of links) assert.match(l.url, /^https:\/\/www\.xiaohongshu\.com\/explore\/[0-9a-f]{24}\?xsec_token=XT\d+%2B%2F%3D&xsec_source=pc_user$/);
  assert.equal(links[0].title, '笔记 1');
  // 只有页面自己的请求：两个列表、每页一次
  assert.ok(s.fetched.every((u) => /\/api\/sns\/web\/v\d\/note\/(collect|like)\/page\?/.test(u)), s.fetched.join('\n'));
  assert.equal(s.fetched.length, 3);
  const counts = s.last().counts;
  assert.equal(counts.recognised, 3);
});

test('a verification page stops the reading at once', async () => {
  const s = site({ path: '/website-login/captcha', pages: {} });
  s.signIn();
  await s.tick();
  assert.equal(s.last().state, 'stopped');
  assert.equal(s.last().reason, 'verify');
  assert.equal(s.win.assigned, undefined, 'does not go anywhere after a stop');
});

test('a list answer it does not recognise skips that list', async () => {
  const s = site({
    path: '/user/profile/' + ME,
    pages: { favorite: [notes(1, 2)], like: [notes(10, 1)] },
    answer: (action) => (action === 'favorite' ? { code: 0, data: { items: [{ id: 'x' }] } } : null),
  });
  s.signIn();
  await s.tick();
  await s.tick();
  assert.notEqual(s.last().state, 'stopped');
  assert.deepEqual(s.last().finished, [{ action: 'favorite', reason: 'unknown' }]);
  for (let i = 0; i < 8 && s.last().state !== 'end'; i++) await s.step();
  assert.equal(s.last().state, 'end');
  assert.deepEqual(s.links().map((l) => l.action), ['like']);
});

test('an error code from the site stops the reading', async () => {
  const s = site({ path: '/user/profile/' + ME, pages: { favorite: [notes(1, 2)] }, answer: () => ({ code: 300013, msg: 'x', data: {} }) });
  s.signIn();
  await s.tick();
  await s.tick();
  assert.equal(s.last().reason, 'errorCode');
});

test('a profile page with nobody signed in is a sign-in wall', async (t) => {
  const s = site({ path: '/user/profile/' + ME, pages: {} });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await s.tick();
  Date.now.mock.mockImplementation(() => now + 11000);
  await s.tick();
  assert.equal(s.last().state, 'stopped');
  assert.equal(s.last().reason, 'signin');
});

test('reports are bounded and the diagnosis holds only shapes', async () => {
  const s = site({ path: '/user/profile/' + ME, pages: { favorite: [notes(1, 250)], like: [] } });
  s.signIn();
  await s.tick();
  for (let i = 0; i < 6; i++) await s.tick();
  assert.ok(s.reports.every((r) => r.links.length <= 100));
  assert.equal(new Set(s.links().map((l) => l.url)).size, 250);
  const diag = s.reports.map((r) => r.diagnosis).filter(Boolean).pop();
  const d = JSON.parse(diag);
  assert.equal(d.tool, 'usuyo-xhs-window');
  assert.equal(d.page, 'profile');
  assert.ok(!/笔记 1|XT1|0{20}1|https?:/.test(diag), 'no titles, tokens, ids or links');
});

test('a guest page that says it is not signed in does not count as signed in', async () => {
  const s = site({ pages: {} });
  s.win.__INITIAL_STATE__ = { user: { loggedIn: false, userInfo: { _rawValue: {}, _value: { user_id: ME } } } };
  await s.tick();
  assert.equal(s.last().signedIn, false);
  assert.equal(s.win.assigned, undefined);
});

test('a list it cannot find is skipped with the reason and the reading ends by itself', async (t) => {
  const s = site({ path: '/user/profile/' + ME, pages: { favorite: [notes(1, 3)], like: [notes(10, 2)] } });
  // 页面上只有「收藏」：读完收藏，等一会儿找不到下一个，跳过它，自己说到底了
  s.onlyTabs(['笔记', '收藏']);
  s.signIn();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await s.tick();
  for (let i = 0; i < 4; i++) await s.step();
  assert.deepEqual(s.last().finished, [{ action: 'favorite' }], 'favorites are finished before likes');
  assert.notEqual(s.last().state, 'stopped');
  // 读完收藏以后才开始等下一个标签：刚读完时不跳
  assert.ok(!s.reports.some((r) => (r.finished || []).some((f) => f.action === 'like')));
  Date.now.mock.mockImplementation(() => now + 9000);
  await s.tick();
  await s.tick();
  assert.equal(s.last().state, 'end');
  assert.ok(!s.reports.some((r) => r.state === 'stopped'), 'never waits for you');
  assert.deepEqual(s.last().finished, [{ action: 'favorite' }, { action: 'like', reason: 'notab' }]);
  assert.equal(new Set(s.links().map((l) => l.url)).size, 3);
});

test('the likes tab is found under its current name', async () => {
  const s = site({ path: '/user/profile/' + ME, pages: { favorite: [notes(1, 1)], like: [notes(10, 2)] } });
  s.signIn();
  await s.tick();
  for (let i = 0; i < 12 && s.last().state !== 'end'; i++) await s.step();
  assert.equal(s.last().state, 'end');
  assert.deepEqual(s.last().finished, [{ action: 'favorite' }, { action: 'like' }]);
  assert.equal(s.links().filter((l) => l.action === 'like').length, 2);
});

test('with no list on the page both are skipped, and a list you open yourself is still read', async (t) => {
  const s = site({ path: '/user/profile/' + ME, pages: { favorite: [notes(1, 3)], like: [] }, hideTabs: true });
  s.signIn();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await s.tick();
  Date.now.mock.mockImplementation(() => now + 9000);
  await s.tick();
  // 「赞过」从这时起等，等满了也跳过
  await s.tick();
  Date.now.mock.mockImplementation(() => now + 18500);
  await s.tick();
  await s.tick();
  assert.equal(s.last().state, 'end');
  assert.deepEqual(s.last().finished, [
    { action: 'favorite', reason: 'notab' },
    { action: 'like', reason: 'notab' },
  ]);
  // 你自己点开「收藏」往下翻：照样记下、交出去
  s.tabs[1].click();
  await s.tick();
  await s.tick();
  assert.equal(new Set(s.links().map((l) => l.url)).size, 3);
});

test('a guest page with an id in its state but nothing only a signed-in page has is not signed in', async () => {
  const s = site({ pages: {} });
  // 访客也有一个 id；没有 loggedIn，也没有侧栏里指向自己的「我」
  s.win.__INITIAL_STATE__ = { user: { userInfo: { _value: { user_id: ME } } } };
  await s.tick();
  assert.equal(s.last().signedIn, false);
  assert.equal(s.win.assigned, undefined, 'stays put');
  // 诊断里有 `user` 的形状（键和类型），没有值
  const d = JSON.parse(s.reports.map((r) => r.diagnosis).filter(Boolean).pop());
  assert.equal(d.user.userInfo._value.user_id, 'string:24');
  // 认登录的三样：页面没说 loggedIn、读出了 id、没有个人页链接
  assert.deepEqual(d.signin, { loggedIn: 'absent', id: true, profileLink: false });
  // 计算出来的 loggedIn（只有读 value 才有值）说没登录：也不算
  s.win.__INITIAL_STATE__ = { user: { loggedIn: { get value() { return false; } }, userInfo: { _value: { user_id: ME } } } };
  await s.tick();
  assert.equal(s.last().signedIn, false);
  // 页面说登录了：算
  s.win.__INITIAL_STATE__ = { user: { loggedIn: { get value() { return true; } }, userInfo: { _value: { user_id: ME } } } };
  await s.tick();
  assert.equal(s.last().signedIn, true);
});

test('an error code from the site stops and does not move on to the next list', async () => {
  const s = site({ path: '/user/profile/' + ME, pages: { favorite: [notes(1, 2)], like: [notes(10, 1)] }, answer: (a) => (a === 'favorite' ? { code: 300013, msg: 'x', data: {} } : null) });
  s.signIn();
  await s.tick();
  for (let i = 0; i < 6; i++) await s.step();
  assert.equal(s.last().state, 'stopped');
  assert.equal(s.last().reason, 'errorCode');
  assert.ok(!s.fetched.some((u) => /note\/like\/page/.test(u)), 'likes were not opened');
});

test('after a stop it reads on from where it stopped', async () => {
  const s = site({ path: '/website-login/captcha', pages: { favorite: [notes(1, 3)], like: [] } });
  s.signIn();
  await s.tick();
  assert.equal(s.last().reason, 'verify');
  // 停着：叫它翻也不翻
  await s.step();
  assert.equal(s.last().state, 'stopped');
  s.win.location.pathname = '/user/profile/' + ME;
  await s.resume();
  assert.equal(s.last().state, 'reading', 'tells usuyo at once that it reads on');
  for (let i = 0; i < 10 && s.last().state !== 'end'; i++) await s.step();
  assert.equal(s.last().state, 'end');
  assert.equal(new Set(s.links().map((l) => l.url)).size, 3);
});

test('resuming on a page that still asks for verification stops again', async () => {
  const s = site({ path: '/website-login/captcha', pages: {} });
  s.signIn();
  await s.tick();
  assert.equal(s.last().reason, 'verify');
  await s.resume();
  assert.equal(s.last().state, 'reading');
  await s.tick();
  assert.equal(s.last().state, 'stopped');
  assert.equal(s.last().reason, 'verify');
});
