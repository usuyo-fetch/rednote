//! 对着本机的假小红书跑 canonicalize 和 fetch：解析、第一个请求就带访客 cookie、visitor-required、
//! 错误映射、`xsec_source`、视频分档和备用地址、平台字幕、输出目录里有什么。

mod common;

use std::collections::BTreeSet;
use std::path::Path;

use common::{COOKIE, Fake, ID, JPEG, MP4, SRT, VTT, WEBP};
use tempfile::TempDir;
use usuyo_fetch_rednote::fetch::{self, Request};
use usuyo_fetch_rednote::{Error, Lang, link};
use usuyo_plugin::protocol::{
    Canonicalized, Completeness, ErrorCode, FetchOutput, Identity, ItemKind, MediaKind,
    NotFoundReason, OutputKind,
};
use usuyo_plugin_kit::http::Cookie;

struct Got {
    result: Result<FetchOutput, Error>,
    dir: TempDir,
}

fn run(fake: &Fake, input: &str, cookie: Option<&str>, want: Option<&[OutputKind]>) -> Got {
    run_as(fake, input, cookie, None, want)
}

/// `user_agent` 是宿主随访客身份交来的、取它的那个窗口的 UA。
fn run_as(
    fake: &Fake,
    input: &str,
    cookie: Option<&str>,
    user_agent: Option<&str>,
    want: Option<&[OutputKind]>,
) -> Got {
    let dir = tempfile::tempdir().unwrap();
    let host = url::Url::parse(&fake.web).unwrap();
    let cookie = cookie.map(|c| Cookie::new(c, [host.host_str().unwrap()]));
    let result = fetch::fetch(
        &fake.site(),
        Request {
            input,
            out: dir.path(),
            want: want.map(|w| w.iter().copied().collect()),
            visitor_cookie: cookie.as_ref(),
            user_agent,
        },
    );
    Got { result, dir }
}

fn ok(got: &Got) -> &FetchOutput {
    match &got.result {
        Ok(out) => out,
        Err(e) => panic!("expected success, got {e:?}"),
    }
}

fn failure(got: &Got) -> usuyo_plugin::protocol::CallFailure {
    match &got.result {
        Err(e) => e.to_failure(Lang::Zh),
        Ok(out) => panic!("expected a failure, got {out:?}"),
    }
}

/// 输出目录里的全部文件，相对路径，排好序；顺带确认没有符号链接。
fn files(dir: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            assert!(!kind.is_symlink(), "{:?}", entry.path());
            if kind.is_dir() {
                walk(root, &entry.path(), out);
            } else {
                let rel = entry
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.push(rel);
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

fn read_json(dir: &Path, name: &str) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.join(name)).unwrap()).unwrap()
}

#[test]
fn image_note_with_js_literal_quirks() {
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("ok"), Some(COOKIE), None);
    let out = ok(&got);

    assert_eq!(out.identity, Some(link::identity(ID)));
    assert_eq!(out.kind, ItemKind::Post);
    assert_eq!(out.title.as_deref(), Some("手冲咖啡的三段式注水"));
    let text = out.text.as_deref().unwrap();
    // 字符串里的 undefined 和 new Set([]) 原样留着
    assert!(
        text.contains("别把 undefined 和 new Set([]) 当成配方"),
        "{text}"
    );
    let author = out.author.as_ref().unwrap();
    assert_eq!(author.name, "咖啡日常");
    assert_eq!(
        author.platform_id.as_deref(),
        Some("5b56be0014de415b2db830a6")
    );
    assert_eq!(
        author.url.as_deref(),
        Some("https://www.xiaohongshu.com/user/profile/5b56be0014de415b2db830a6")
    );
    assert_eq!(
        out.published_at.as_ref().unwrap().as_str(),
        "2026-10-01T08:00:00Z"
    );
    assert_eq!(out.platform_tags, ["手冲咖啡", "咖啡日常"]);

    // 第三张图的主机不在名单里，不去取，如实写进原因
    assert_eq!(out.images.len(), 2);
    // 图文笔记没有视频，不算缺；三张图少了一张，图片算缺
    assert_eq!(out.completeness, Completeness::Partial);
    assert_eq!(out.missing, [OutputKind::Images]);
    let reason = out.missing_reason.as_deref().unwrap();
    assert!(reason.contains("有 1 张图片没有下载下来"), "{reason}");
    assert!(out.media.is_empty());
    assert_eq!(out.evidence.status, Some(200));

    let dir = got.dir.path();
    assert_eq!(
        files(dir),
        [
            "images/001.webp",
            "images/002.jpg",
            "meta.json",
            "note.json"
        ]
    );
    assert_eq!(std::fs::read(dir.join("images/001.webp")).unwrap(), WEBP);
    assert_eq!(std::fs::read(dir.join("images/002.jpg")).unwrap(), JPEG);
    let meta = read_json(dir, "meta.json");
    assert_eq!(meta["counts"]["liked"], "1.2万");
    assert_eq!(meta["ipLocation"], "上海");
    assert_eq!(meta["failed"][0]["url"], "https://evil.example/c.jpg");
    assert_eq!(meta["visitorCookieUsed"], true);
    assert_eq!(read_json(dir, "note.json")["noteId"], ID);

    // 一次笔记页请求，图片只请求名单内的两张，图片请求带源作 Referer、不带 cookie
    assert_eq!(fake.page_requests().len(), 1);
    let images: Vec<_> = fake
        .seen()
        .into_iter()
        .filter(|s| s.target.starts_with("/img/"))
        .collect();
    assert_eq!(images.len(), 2);
    assert!(images.iter().all(|s| s.cookie.is_none()));
    assert!(
        images
            .iter()
            .all(|s| s.referer.as_deref() == Some(&format!("{}/", fake.web)[..]))
    );
    // 输出的 JSON 能按协议的类型读回来
    let json = serde_json::to_string(out).unwrap();
    assert_eq!(&serde_json::from_str::<FetchOutput>(&json).unwrap(), out);
}

#[test]
fn video_note_uses_page_streams_only() {
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("video"), Some(COOKIE), None);
    let out = ok(&got);
    assert_eq!(out.kind, ItemKind::Video);
    assert_eq!(
        out.completeness,
        Completeness::Full,
        "{:?}",
        out.missing_reason
    );
    assert_eq!(out.author.as_ref().unwrap().name, "咖啡日常");
    assert_eq!(out.media.len(), 1);
    let video = &out.media[0];
    assert_eq!(
        (video.path.as_str(), video.kind),
        ("media/video.mp4", MediaKind::Video)
    );
    assert_eq!(video.mime.as_deref(), Some("video/mp4"));
    assert_eq!(video.duration_sec, Some(181.0));
    let dir = got.dir.path();
    assert_eq!(
        files(dir),
        [
            "images/001.jpg",
            "media/video.mp4",
            "meta.json",
            "note.json"
        ]
    );
    assert_eq!(std::fs::read(dir.join("media/video.mp4")).unwrap(), MP4);

    // h264 里最高的那一路：主地址 500，换备用地址；不拼 originVideoKey，不碰 h265
    let media: Vec<String> = fake
        .seen()
        .into_iter()
        .filter(|s| s.target.starts_with("/media/"))
        .map(|s| s.target)
        .collect();
    assert_eq!(media, ["/media/broken.mp4", "/media/v.mp4"]);
}

#[test]
fn live_photos_are_saved_as_video() {
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("live"), Some(COOKIE), None);
    let out = ok(&got);
    assert_eq!(
        out.completeness,
        Completeness::Full,
        "{:?}",
        out.missing_reason
    );
    assert_eq!(out.media.len(), 1);
    assert_eq!(out.media[0].path.as_str(), "media/live-002.mp4");
    assert_eq!(
        files(got.dir.path()),
        [
            "images/001.jpg",
            "images/002.webp",
            "media/live-002.mp4",
            "meta.json",
            "note.json"
        ]
    );
}

#[test]
fn a_part_the_note_never_had_is_not_missing() {
    // 没有正文、没有视频、图片有：全要也是 full，没有原因
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("bare"), Some(COOKIE), None);
    let out = ok(&got);
    assert_eq!(out.completeness, Completeness::Full);
    assert!(out.missing.is_empty() && out.missing_reason.is_none());
    assert!(out.text.is_none() && out.media.is_empty());
    assert_eq!(out.images.len(), 1);
}

#[test]
fn live_photo_video_that_fails_is_missing_with_a_reason() {
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("livefail"), Some(COOKIE), None);
    let out = ok(&got);
    assert_eq!(out.completeness, Completeness::Partial);
    assert_eq!(out.missing, [OutputKind::Video]);
    assert_eq!(
        out.missing_reason.as_deref(),
        Some("实况图的视频没有下载下来")
    );
}

#[test]
fn video_note_without_streams_is_partial() {
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("nostream"), Some(COOKIE), None);
    let out = ok(&got);
    assert_eq!(out.completeness, Completeness::Partial);
    assert_eq!(out.missing, [OutputKind::Video]);
    assert_eq!(out.missing_reason.as_deref(), Some("页面没有给出视频地址"));
    assert_eq!(out.images.len(), 1);
    assert!(fake.seen().iter().all(|s| !s.target.starts_with("/media/")));
}

#[test]
fn want_limits_what_is_downloaded() {
    let fake = Fake::start();
    let got = run(
        &fake,
        &fake.note_url("video"),
        Some(COOKIE),
        Some(&[OutputKind::Text]),
    );
    let out = ok(&got);
    assert_eq!(out.completeness, Completeness::Full);
    assert!(out.images.is_empty() && out.media.is_empty() && out.title.is_none());
    assert_eq!(files(got.dir.path()), ["note.json"]);
    assert_eq!(fake.seen().len(), 1, "{:?}", fake.seen());
}

#[test]
fn same_note_redirect_is_followed() {
    let fake = Fake::start();
    let input = format!(
        "{}/discovery/item/{ID}?xsec_token=hop&xsec_source=app_share",
        fake.web
    );
    let got = run(&fake, &input, Some(COOKIE), Some(&[OutputKind::Text]));
    assert!(ok(&got).text.is_some());
    // 去处没写 xsec_source：沿用原链接的
    let targets: Vec<String> = fake.page_requests().into_iter().map(|s| s.target).collect();
    assert_eq!(
        targets,
        [
            format!("/discovery/item/{ID}?xsec_token=hop&xsec_source=app_share"),
            format!("/explore/{ID}?xsec_token=ok&xsec_source=app_share"),
        ]
    );
}

#[test]
fn the_first_page_request_carries_the_visitor_cookie() {
    let fake = Fake::start();
    let got = run(
        &fake,
        &fake.note_url("ok"),
        Some(COOKIE),
        Some(&[OutputKind::Text, OutputKind::Meta]),
    );
    let out = ok(&got);
    assert!(out.text.is_some());
    // 只有一次笔记页请求，第一次就带着访客身份
    let pages = fake.page_requests();
    assert_eq!(pages.len(), 1, "{pages:?}");
    assert_eq!(pages[0].cookie.as_deref(), Some(COOKIE));
    assert_eq!(
        read_json(got.dir.path(), "meta.json")["visitorCookieUsed"],
        true
    );
    // cookie 不出现在输出和输出目录里
    assert!(
        !serde_json::to_string(out)
            .unwrap()
            .contains("visitor-session-secret")
    );
    for f in files(got.dir.path()) {
        let bytes = std::fs::read(got.dir.path().join(f)).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("visitor-session-secret"));
    }
}

/// 访客窗口是 WebKit（Safari 一类的 UA）：笔记页用同一个 UA 和 Safari 的 Accept 去要，不配 Chrome 的那一套
/// （ParseHub `provider_api/xhs.py:20-30`：UA 和 Accept 对不上会被送去验证页）；没有交来 UA 时照旧用插件自己的 Chrome UA。
#[test]
fn the_page_is_requested_with_the_visitor_windows_user_agent() {
    let webkit = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15";
    let fake = Fake::start();
    let got = run_as(
        &fake,
        &fake.note_url("ok"),
        Some(COOKIE),
        Some(webkit),
        Some(&[OutputKind::Text, OutputKind::Images]),
    );
    ok(&got);
    let seen = fake.seen();
    assert!(
        seen.iter().all(|s| s.user_agent.as_deref() == Some(webkit)),
        "{seen:?}"
    );
    let page = &fake.page_requests()[0];
    assert_eq!(
        page.accept.as_deref(),
        Some("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    );

    let fake = Fake::start();
    ok(&run(
        &fake,
        &fake.note_url("ok"),
        Some(COOKIE),
        Some(&[OutputKind::Text]),
    ));
    let page = &fake.page_requests()[0];
    assert!(
        page.user_agent.as_deref().unwrap().contains("Chrome/"),
        "{page:?}"
    );
    assert!(page.accept.as_deref().unwrap().contains("image/avif"));
}

/// 带着访客身份被送去登录页：失败的原因里写明这次用的是不是访客窗口的 UA，下次一眼看得出。
#[test]
fn a_refused_visitor_says_which_user_agent_went_with_it() {
    let fake = Fake::start();
    let f = failure(&run_as(
        &fake,
        &fake.note_url("login"),
        Some(COOKIE),
        Some(
            "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15",
        ),
        None,
    ));
    assert_eq!(f.code, ErrorCode::VisitorRequired);
    assert!(
        f.message
            .contains("user agent from the visitor window: true"),
        "{}",
        f.message
    );
}

/// 没有交来访客身份：只用手机版页面、不带任何 cookie 请求一次（ParseHub 的第三段「移动端」），
/// UA 是 iPhone Safari，Accept 配 Safari 的那一行。
#[test]
fn without_a_visitor_identity_only_the_mobile_page_is_asked_without_cookies() {
    let fake = Fake::start();
    let got = run(
        &fake,
        &fake.note_url("ok"),
        None,
        Some(&[OutputKind::Text, OutputKind::Meta]),
    );
    let out = ok(&got);
    assert_eq!(out.title.as_deref(), Some("手冲咖啡的三段式注水"));
    let pages = fake.page_requests();
    assert_eq!(pages.len(), 1, "{pages:?}");
    assert_eq!(pages[0].cookie, None);
    assert!(
        pages[0].user_agent.as_deref().unwrap().contains("iPhone"),
        "{pages:?}"
    );
    assert_eq!(
        pages[0].accept.as_deref(),
        Some("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    );
    let meta = read_json(got.dir.path(), "meta.json");
    assert_eq!(meta["stage"], "mobile-page");
    assert_eq!(meta["visitorCookieUsed"], false);
}

/// 带着访客身份被送去登录页：再用手机版页面、不带 cookie 请求一次，取到了就是手机版那一段取到的。
#[test]
fn a_refused_visitor_falls_back_to_the_mobile_page_once() {
    let fake = Fake::start();
    let got = run(
        &fake,
        &fake.note_url("refused"),
        Some(COOKIE),
        Some(&[OutputKind::Text, OutputKind::Meta]),
    );
    let out = ok(&got);
    assert_eq!(
        out.text.as_deref().map(str::trim),
        Some("第一段 40 克闷蒸 30 秒。")
    );
    let pages = fake.page_requests();
    assert_eq!(pages.len(), 2, "{pages:?}");
    assert_eq!(pages[0].cookie.as_deref(), Some(COOKIE));
    assert_eq!(
        pages[1].cookie, None,
        "the mobile page goes without any cookie"
    );
    assert_eq!(
        read_json(got.dir.path(), "meta.json")["stage"],
        "mobile-page"
    );
}

/// 两段都被送去登录页、首页，或页面里没有这篇：回 visitor-required 说这份访客身份不被收（宿主换一份），
/// 原因里写着两段各自去了哪；不去请求送去的地方。
#[test]
fn a_rejected_visitor_identity_is_reported_for_replacement() {
    for token in ["home", "login", "absent"] {
        let fake = Fake::start();
        let f = failure(&run(&fake, &fake.note_url(token), Some(COOKIE), None));
        assert_eq!(f.code, ErrorCode::VisitorRequired, "{token}");
        assert!(f.hint.as_deref().unwrap().contains("换一份"), "{f:?}");
        assert!(
            f.message.contains("visitor-page: ") && f.message.contains("; mobile-page: "),
            "{}",
            f.message
        );
        let pages = fake.page_requests();
        assert_eq!(pages.len(), 2, "{token}: {pages:?}");
        assert_eq!(pages[0].cookie.as_deref(), Some(COOKIE));
        assert_eq!(pages[1].cookie, None);
    }
}

/// 验证页、`/404/sec`：马上停，不再换手机版页面去试；原因里写着是哪一段。
#[test]
fn a_verification_page_stops_without_trying_the_mobile_page() {
    for token in ["captcha", "sec"] {
        let fake = Fake::start();
        let f = failure(&run(&fake, &fake.note_url(token), Some(COOKIE), None));
        assert_eq!(f.code, ErrorCode::Blocked, "{token}");
        assert!(f.message.starts_with("visitor-page: "), "{}", f.message);
        assert_eq!(fake.page_requests().len(), 1, "{token}");
    }
}

#[test]
fn error_mapping() {
    let cases: [(&str, ErrorCode, Option<NotFoundReason>); 13] = [
        (
            "expired",
            ErrorCode::NotFound,
            Some(NotFoundReason::LinkExpired),
        ),
        ("sec", ErrorCode::Blocked, None),
        ("captcha", ErrorCode::Blocked, None),
        ("risk", ErrorCode::Blocked, None),
        ("verify", ErrorCode::Blocked, None),
        ("gateway", ErrorCode::Blocked, None),
        ("gateway471", ErrorCode::Blocked, None),
        ("restricted", ErrorCode::Blocked, None),
        ("gone", ErrorCode::NotFound, None),
        ("limited", ErrorCode::RateLimited, None),
        ("changed", ErrorCode::UpstreamChanged, None),
        ("noscript", ErrorCode::UpstreamChanged, None),
        ("nonexistent-token", ErrorCode::NotFound, None),
    ];
    for (token, code, reason) in cases {
        let fake = Fake::start();
        // 一次请求就回，不重试；验证页、404 页这些送去的地方也不去请求
        let f = failure(&run(&fake, &fake.note_url(token), Some(COOKIE), None));
        assert_eq!((f.code, f.reason), (code, reason), "{token}: {f:?}");
        assert_eq!(fake.page_requests().len(), 1, "{token}");
        if token == "limited" {
            assert_eq!(f.retry_after, Some(600));
        }
        if code == ErrorCode::Blocked || code == ErrorCode::UpstreamChanged {
            assert!(f.hint.is_some(), "{token}");
        }
    }
}

#[test]
fn links_without_xsec_token_are_not_requested() {
    let fake = Fake::start();
    let f = failure(&run(
        &fake,
        &format!("{}/explore/{ID}", fake.web),
        Some(COOKIE),
        None,
    ));
    assert_eq!(
        (f.code, f.reason),
        (ErrorCode::NotFound, Some(NotFoundReason::LinkExpired))
    );
    assert!(fake.seen().is_empty());
}

#[test]
fn rejects_what_it_cannot_take() {
    let fake = Fake::start();
    let f = failure(&run(&fake, "https://example.com/explore/x", None, None));
    assert_eq!(f.code, ErrorCode::UnsupportedInput);
    let f = failure(&run(
        &fake,
        &fake.note_url("ok"),
        Some(COOKIE),
        Some(&[OutputKind::Html]),
    ));
    assert_eq!(f.code, ErrorCode::InvalidArgs);
    // 真站点的链接对着本机配置的 Site 不认
    let real = format!("https://www.xiaohongshu.com/explore/{ID}?xsec_token=ok");
    assert_eq!(
        failure(&run(&fake, &real, None, None)).code,
        ErrorCode::UnsupportedInput
    );
    assert!(fake.seen().is_empty());
}

#[test]
fn short_links_expand_without_touching_the_note_host() {
    let fake = Fake::start();
    let site = fake.site();
    for path in ["/abc", "/hop"] {
        let got = link::canonicalize(&site, &format!("{}{path}", fake.short)).unwrap();
        let Canonicalized::Match {
            identity,
            resolved_url: Some(resolved),
        } = got
        else {
            panic!("{got:?}");
        };
        assert_eq!(identity, link::identity(ID));
        assert!(
            matches!(&identity, Identity::Platform { url: Some(u), .. } if u == &format!("https://www.xiaohongshu.com/explore/{ID}"))
        );
        // 展开后的全部参数都留着，xsec_token 在里面
        assert_eq!(
            resolved,
            format!(
                "{}/discovery/item/{ID}?app_platform=ios&xsec_token=ok&xsec_source=app_share&shareRedId=xyz",
                fake.web
            )
        );
    }
    assert!(
        fake.seen()
            .iter()
            .all(|s| s.server == "short" && s.cookie.is_none())
    );

    assert_eq!(
        link::canonicalize(&site, &format!("{}/profile", fake.short)).unwrap(),
        Canonicalized::NoMatch
    );
    assert_eq!(
        link::canonicalize(&site, &format!("{}/elsewhere", fake.short)).unwrap(),
        Canonicalized::NoMatch
    );
    let code = |path: &str| {
        link::canonicalize(&site, &format!("{}{path}", fake.short))
            .unwrap_err()
            .to_failure(Lang::Zh)
            .code
    };
    assert_eq!(code("/gone"), ErrorCode::NotFound);
    assert_eq!(code("/captcha"), ErrorCode::Blocked);
    assert_eq!(code("/loop"), ErrorCode::UpstreamChanged);
    assert!(fake.page_requests().is_empty());
}

#[test]
fn fetch_takes_a_short_link_and_sends_the_cookie_only_to_the_note_page() {
    let fake = Fake::start();
    let got = run(
        &fake,
        &format!("{}/abc", fake.short),
        Some(COOKIE),
        Some(&[OutputKind::Text]),
    );
    assert!(ok(&got).text.is_some());
    let seen = fake.seen();
    assert_eq!(seen.len(), 2, "{seen:?}");
    for s in &seen {
        let want = (s.server == "web").then_some(COOKIE);
        assert_eq!(s.cookie.as_deref(), want, "{s:?}");
    }
    // 分享链接里指向分享人的参数不发给笔记页
    let page = &fake.page_requests()[0];
    assert_eq!(
        page.target,
        format!("/discovery/item/{ID}?xsec_token=ok&xsec_source=app_share")
    );
    let want: BTreeSet<_> = ["short", "web"].into();
    assert_eq!(seen.iter().map(|s| s.server).collect::<BTreeSet<_>>(), want);
}

#[test]
fn english_hints_follow_the_locale() {
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("login"), Some(COOKIE), None);
    let hint = got.result.unwrap_err().to_failure(Lang::En).hint.unwrap();
    assert!(hint.contains("visitor identity"), "{hint}");
}

/// 档名是 `EF*` 时照样挑出 h264 mp4 里短边不超过 720 的那一档；主地址 500 换备用地址；
/// 平台字幕（中文，SRT）原样存成 .srt，另存一份 WebVTT 作 `subtitle` 交出。
#[test]
fn video_buckets_by_any_name_with_backup_and_subtitle() {
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("ef"), Some(COOKIE), None);
    let out = ok(&got);
    assert_eq!(out.kind, ItemKind::Video);
    assert_eq!(
        out.completeness,
        Completeness::Full,
        "{:?}",
        out.missing_reason
    );
    let kinds: Vec<_> = out
        .media
        .iter()
        .map(|m| (m.path.as_str(), m.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            ("media/video.mp4", MediaKind::Video),
            ("media/subtitle.zh-CN.vtt", MediaKind::Subtitle)
        ]
    );
    let sub = &out.media[1];
    assert_eq!(sub.lang.as_deref(), Some("zh-CN"));
    assert_eq!(sub.mime.as_deref(), Some("text/vtt"));
    let dir = got.dir.path();
    assert_eq!(std::fs::read(dir.join("media/video.mp4")).unwrap(), MP4);
    assert_eq!(
        std::fs::read_to_string(dir.join("media/subtitle.zh-CN.srt")).unwrap(),
        SRT
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("media/subtitle.zh-CN.vtt")).unwrap(),
        "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\n先称 30 克豆子\n"
    );
    let meta = read_json(dir, "meta.json");
    assert_eq!(meta["video"]["codec"], "h264");
    assert_eq!(meta["subtitle"]["lang"], "zh-CN");

    let media: Vec<_> = fake
        .seen()
        .into_iter()
        .filter(|s| s.target.starts_with("/media/") || s.target.starts_with("/sub/"))
        .collect();
    let targets: Vec<&str> = media.iter().map(|s| s.target.as_str()).collect();
    assert_eq!(
        targets,
        ["/media/broken.mp4", "/media/v.mp4", "/sub/zh.srt"]
    );
    // 媒体和字幕带源作 Referer、不带 cookie
    for s in &media {
        assert_eq!(s.cookie, None, "{s:?}");
        assert_eq!(s.referer.as_deref(), Some(&format!("{}/", fake.web)[..]));
    }
}

#[test]
fn subtitles_keep_their_own_format_and_can_be_missing() {
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("efvtt"), Some(COOKIE), None);
    let out = ok(&got);
    let sub = out
        .media
        .iter()
        .find(|m| m.kind == MediaKind::Subtitle)
        .unwrap();
    assert_eq!(
        (sub.path.as_str(), sub.mime.as_deref()),
        ("media/subtitle.zh-CN.vtt", Some("text/vtt"))
    );
    assert_eq!(
        std::fs::read_to_string(got.dir.path().join(sub.path.as_str())).unwrap(),
        VTT
    );
    // WebVTT 来的不另存 .srt
    assert!(!got.dir.path().join("media/subtitle.zh-CN.srt").exists());

    // 页面给了字幕却没下到：算缺，写原因；视频照样交
    let fake = Fake::start();
    let got = run(&fake, &fake.note_url("efsubgone"), Some(COOKIE), None);
    let out = ok(&got);
    assert_eq!(out.completeness, Completeness::Partial);
    assert_eq!(out.missing, [OutputKind::Subtitle]);
    assert!(
        out.missing_reason
            .as_deref()
            .unwrap()
            .contains("字幕没有下载下来")
    );
    assert_eq!(out.media.len(), 1);

    // 不要字幕就不去取
    let fake = Fake::start();
    let got = run(
        &fake,
        &fake.note_url("ef"),
        Some(COOKIE),
        Some(&[OutputKind::Video]),
    );
    assert_eq!(ok(&got).completeness, Completeness::Full);
    assert!(fake.seen().iter().all(|s| !s.target.starts_with("/sub/")));
}

/// 旧脚本交来的链接没有 `xsec_source`：请求时补 `pc_user`；有的照原样带。
#[test]
fn xsec_source_is_kept_or_filled_in() {
    let fake = Fake::start();
    let old = format!(
        "{}/user/profile/5b56be0014de415b2db830a6/{ID}?xsec_token=ok",
        fake.web
    );
    // 假站点只认 explore、discovery/item 两种路径，user/profile 回 404；这里只看请求的地址
    let _ = run(&fake, &old, Some(COOKIE), Some(&[OutputKind::Text]));
    let explore = format!("{}/explore/{ID}?xsec_token=ok&xsec_source=", fake.web);
    let got = run(&fake, &explore, Some(COOKIE), Some(&[OutputKind::Text]));
    assert!(ok(&got).text.is_some());
    let got = run(
        &fake,
        &fake.note_url("ok"),
        Some(COOKIE),
        Some(&[OutputKind::Text]),
    );
    assert!(ok(&got).text.is_some());
    let targets: Vec<String> = fake.page_requests().into_iter().map(|s| s.target).collect();
    assert_eq!(
        targets,
        [
            format!(
                "/user/profile/5b56be0014de415b2db830a6/{ID}?xsec_token=ok&xsec_source=pc_user"
            ),
            format!("/explore/{ID}?xsec_token=ok&xsec_source=pc_user"),
            format!("/explore/{ID}?xsec_token=ok&xsec_source=pc_collect"),
        ]
    );
}
