//! 油猴脚本头里写的几条保证，照脚本的文字核一遍：只连本机、不读 cookie、不写页面的存储。
//! 交给 usuyo 的行为（握手、令牌什么时候发）在 `userscript/test/` 里对着一次性的守护进程测。

const SCRIPT: &str = include_str!("../userscript/usuyo-xhs-saved.user.js");

fn header(key: &str) -> Vec<&'static str> {
    SCRIPT
        .lines()
        .filter_map(|l| l.strip_prefix("// @"))
        .filter_map(|l| l.strip_prefix(key))
        .map(str::trim)
        .collect()
}

#[test]
fn userscript_connects_only_to_this_machine() {
    assert_eq!(header("connect"), ["127.0.0.1"]);
    assert_eq!(header("match"), ["https://www.xiaohongshu.com/*"]);
    let urls: Vec<&str> = SCRIPT
        .match_indices("http")
        .map(|(i, _)| &SCRIPT[i..])
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        .map(|s| {
            s.split(['\'', '"', '`', ' ', '\n', ')'])
                .next()
                .unwrap_or(s)
        })
        .collect();
    assert!(urls.iter().any(|u| u.starts_with("http://127.0.0.1")));
    for url in urls {
        assert!(
            url.starts_with("http://127.0.0.1")
                || url.starts_with("https://www.xiaohongshu.com/")
                || url.starts_with("https://github.com/"),
            "the userscript names another address: {url}"
        );
    }
}

#[test]
fn userscript_reads_no_cookies_and_writes_no_page_storage() {
    for script in [SCRIPT, WINDOW] {
        for needle in [
            "document.cookie",
            "localStorage.",
            "sessionStorage.",
            "indexedDB",
        ] {
            assert!(!script.contains(needle), "a script still has `{needle}`");
        }
    }
}

/// usuyo 站点窗口里的那一段：只经 `usuyo.submit` 交，自己不连任何地方、不碰 usuyo 的本机端口和令牌。
const WINDOW: &str = include_str!("../userscript/usuyo-xhs-window.js");

#[test]
fn the_window_script_hands_over_only_through_usuyo_submit() {
    for needle in [
        "GM_",
        "127.0.0.1",
        "47615",
        "XMLHttpRequest(",
        "new WebSocket",
        "sendBeacon",
        "__TAURI",
        "Bearer",
    ] {
        assert!(!WINDOW.contains(needle), "the window script has `{needle}`");
    }
    assert!(WINDOW.contains("usuyo.submit("));
    assert!(!WINDOW.contains("http://") && !WINDOW.contains("https://"));
}
