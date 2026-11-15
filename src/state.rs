//! 笔记页里 `window.__INITIAL_STATE__` 的形状。页面改版时只改这一个文件。
//!
//! 依据（2026-11 读的源码和 issue，没有对小红书发请求）：
//! - 笔记在 `note.noteDetailMap[<id>].note`，另有 `note.firstNoteId`
//!   （ParseHub `provider_api/xhs.py`、XHS-Downloader `expansion/converter.py`）；
//! - 字段名 `noteId`、`type`（`normal` / `video`）、`title`、`desc`、`time`（毫秒）、
//!   `user.{userId,nickname}`、`tagList[].name`、`interactInfo.*Count`、
//!   `imageList[].{urlDefault,url,infoList,livePhoto,stream}`、
//!   `video.media.stream.<档名>[].{masterUrl,backupUrls,width,height,format,videoCodec}`
//!   （xpzouying/xiaohongshu-mcp `types.go`、XHS-Downloader `image.py` `video.py`、
//!   yt-dlp `extractor/xiaohongshu.py`），`video.media.video.subtitles`（xhs-vault）；
//! - 状态对象不是 JSON：值的位置会出现 `undefined`，还有 `new Map([...])`、`new Set([...])`，
//!   后者 2026-10-15 前后出现（XHS-Downloader #497）。

use serde_json::Value;

/// 页面里的状态对象读不出来，或读出来缺了必须有的字段。都按 `upstream-changed` 报，
/// 只有 [`StateError::Absent`] 例外：页面结构在，但这篇笔记的内容没给出来。
#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("the page has no window.__INITIAL_STATE__")]
    NoState,
    #[error("window.__INITIAL_STATE__ is not a readable object: {0}")]
    Unreadable(String),
    #[error("the state object has no `{0}`")]
    Missing(String),
    #[error("the page carries note {found}, not {wanted}")]
    WrongNote { wanted: String, found: String },
    #[error("the page has no content for note {0}")]
    Absent(String),
}

const MARKER: &str = "window.__INITIAL_STATE__";

/// 只看有没有状态对象，不解析。
pub(crate) fn has_state(html: &str) -> bool {
    html.contains(MARKER)
}

/// 找出状态对象，换成 JSON 再解析。
pub fn extract(html: &str) -> Result<Value, StateError> {
    // 名字可能先在别处出现（例如判断它在不在），只认后面跟着 `= {` 的那一处
    let rest = html
        .match_indices(MARKER)
        .find_map(|(at, _)| {
            let rest = html[at + MARKER.len()..]
                .trim_start()
                .strip_prefix('=')?
                .trim_start();
            rest.starts_with('{').then_some(rest)
        })
        .ok_or(if has_state(html) {
            StateError::Unreadable("no `= {` after the name".into())
        } else {
            StateError::NoState
        })?;
    let json = js_object_to_json(rest)?;
    serde_json::from_str(&json).map_err(|e| StateError::Unreadable(e.to_string()))
}

/// 从 `{` 开始，按括号配对读到对象结束；字符串以外的 `undefined` 换成 `null`，
/// `new Map(...)`、`new Set(...)` 只留括号里的数组，空参数换成 `[]`。字符串原样保留。
fn js_object_to_json(src: &str) -> Result<String, StateError> {
    let bad = |m: &str| StateError::Unreadable(m.into());
    if !src.starts_with('{') {
        return Err(bad("the value is not an object"));
    }
    let mut out = String::with_capacity(src.len());
    let mut depth = 0usize;
    // 打开的 `new X(` 各自在哪一层括号里
    let mut constructors: Vec<usize> = Vec::new();
    let mut chars = src.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match c {
            '"' => {
                out.push(c);
                let mut escaped = false;
                loop {
                    let (_, s) = chars.next().ok_or_else(|| bad("unterminated string"))?;
                    out.push(s);
                    match s {
                        '\\' if !escaped => escaped = true,
                        '"' if !escaped => break,
                        _ => escaped = false,
                    }
                }
            }
            '{' | '[' => {
                depth += 1;
                out.push(c);
            }
            '}' | ']' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| bad("unbalanced brackets"))?;
                out.push(c);
                if depth == 0 {
                    if !constructors.is_empty() {
                        return Err(bad("unclosed `new` expression"));
                    }
                    return Ok(out);
                }
            }
            ')' => {
                let opened = constructors.pop().ok_or_else(|| bad("unexpected `)`"))?;
                if opened != depth {
                    return Err(bad("unbalanced `new` expression"));
                }
            }
            // 数字整个照抄，免得 `1e5` 里的 `e` 被当成标识符
            c if c.is_ascii_digit() || c == '-' => {
                out.push(c);
                while let Some((_, n)) = chars.next_if(|(_, n)| {
                    n.is_ascii_digit() || matches!(n, '.' | 'e' | 'E' | '+' | '-')
                }) {
                    out.push(n);
                }
            }
            c if c.is_ascii_alphabetic() || c == '_' || c == '$' => {
                let mut end = at + c.len_utf8();
                while let Some(&(i, n)) = chars.peek() {
                    if n.is_ascii_alphanumeric() || n == '_' || n == '$' {
                        chars.next();
                        end = i + n.len_utf8();
                    } else {
                        break;
                    }
                }
                match &src[at..end] {
                    "undefined" => out.push_str("null"),
                    word @ ("true" | "false" | "null") => out.push_str(word),
                    "new" => {
                        while chars.next_if(|(_, n)| n.is_whitespace()).is_some() {}
                        let mut name = String::new();
                        while let Some((_, n)) = chars.next_if(|(_, n)| n.is_ascii_alphabetic()) {
                            name.push(n);
                        }
                        if name != "Map" && name != "Set" {
                            return Err(bad(&format!("unsupported `new {name}`")));
                        }
                        while chars.next_if(|(_, n)| n.is_whitespace()).is_some() {}
                        if chars.next().map(|(_, n)| n) != Some('(') {
                            return Err(bad("`new` without `(`"));
                        }
                        while chars.next_if(|(_, n)| n.is_whitespace()).is_some() {}
                        if chars.next_if(|(_, n)| *n == ')').is_some() {
                            out.push_str("[]");
                        } else {
                            constructors.push(depth);
                        }
                    }
                    other => return Err(bad(&format!("unsupported literal `{other}`"))),
                }
            }
            _ => out.push(c),
        }
    }
    Err(bad("the object does not end"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteKind {
    /// 图文。
    Normal,
    Video,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Author {
    pub user_id: Option<String>,
    pub nickname: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Counts {
    pub liked: Option<String>,
    pub collected: Option<String>,
    pub comments: Option<String>,
    pub shared: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    /// 页面给的地址；一张图连地址都没有时是 `None`。
    pub url: Option<String>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    /// 实况图的动态部分。
    pub live: Option<Stream>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stream {
    pub url: String,
    /// 备用地址，主地址取不到时按顺序试。
    pub backup: Vec<String>,
    pub codec: String,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub duration_ms: Option<u64>,
}

/// 平台给的一份字幕；地址带 `sign`、`t`，要在取页面的同一次调用里下载。
#[derive(Debug, Clone, PartialEq)]
pub struct Subtitle {
    pub url: String,
    /// 语言，例如 `zh-CN`；原声那一份（`source`）或认不出时是 `None`。
    pub lang: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub id: String,
    pub kind: NoteKind,
    pub title: Option<String>,
    pub desc: Option<String>,
    pub published_ms: Option<i64>,
    pub updated_ms: Option<i64>,
    pub ip_location: Option<String>,
    pub author: Option<Author>,
    pub tags: Vec<String>,
    pub counts: Counts,
    pub images: Vec<Image>,
    /// 视频笔记的视频流；视频笔记却没有流时是 `None`。
    pub video: Option<Stream>,
    /// 视频笔记的平台字幕。
    pub subtitle: Option<Subtitle>,
    /// 页面里这篇笔记的原样对象，随快照存下，以后改进解析可以重算。
    pub raw: Value,
}

/// 从状态对象里取出 `id` 这篇笔记。
pub fn note(state: &Value, id: &str) -> Result<Note, StateError> {
    let missing = |path: &str| StateError::Missing(path.into());
    let section = state.get("note").ok_or_else(|| missing("note"))?;
    let map = section
        .get("noteDetailMap")
        .and_then(Value::as_object)
        .ok_or_else(|| missing("note.noteDetailMap"))?;
    let first = section.get("firstNoteId").and_then(Value::as_str);
    let entry = map
        .get(id)
        .or_else(|| first.and_then(|f| map.get(f)))
        .or_else(|| (map.len() == 1).then(|| map.values().next()).flatten());
    let raw = entry
        .and_then(|e| e.get("note"))
        .filter(|n| n.as_object().is_some_and(|o| !o.is_empty()))
        .ok_or_else(|| StateError::Absent(id.into()))?;

    let found = text(raw, "noteId").ok_or_else(|| missing("note.noteId"))?;
    if !found.eq_ignore_ascii_case(id) {
        return Err(StateError::WrongNote {
            wanted: id.into(),
            found,
        });
    }
    let kind = match text(raw, "type")
        .ok_or_else(|| missing("note.type"))?
        .as_str()
    {
        "normal" => NoteKind::Normal,
        "video" => NoteKind::Video,
        other => {
            return Err(StateError::Missing(format!(
                "a known note.type (got `{other}`)"
            )));
        }
    };
    let images = raw
        .get("imageList")
        .and_then(Value::as_array)
        .ok_or_else(|| missing("note.imageList"))?
        .iter()
        .map(image)
        .collect();
    let video = (kind == NoteKind::Video)
        .then(|| raw.pointer("/video/media/stream").and_then(best_stream))
        .flatten();
    let author = raw.get("user").map(|u| Author {
        user_id: text(u, "userId"),
        nickname: text(u, "nickname").or_else(|| text(u, "nickName")),
    });
    let tags = raw
        .get("tagList")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|t| text(t, "name")).collect())
        .unwrap_or_default();
    let counts = raw
        .get("interactInfo")
        .map_or_else(Counts::default, |i| Counts {
            liked: count(i, "likedCount"),
            collected: count(i, "collectedCount"),
            comments: count(i, "commentCount"),
            shared: count(i, "shareCount"),
        });

    Ok(Note {
        id: found.to_ascii_lowercase(),
        kind,
        title: text(raw, "title"),
        desc: text(raw, "desc"),
        published_ms: raw.get("time").and_then(Value::as_i64),
        updated_ms: raw.get("lastUpdateTime").and_then(Value::as_i64),
        ip_location: text(raw, "ipLocation"),
        author,
        tags,
        counts,
        images,
        video,
        subtitle: (kind == NoteKind::Video).then(|| subtitle(raw)).flatten(),
        raw: raw.clone(),
    })
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// 互动数有时是字符串（「1.2万」），有时是数字。
fn count(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn image(v: &Value) -> Image {
    let scene = |name: &str| {
        v.get("infoList")
            .and_then(Value::as_array)
            .and_then(|l| {
                l.iter()
                    .find(|i| text(i, "imageScene").as_deref() == Some(name))
            })
            .and_then(|i| text(i, "url"))
    };
    // 空字符串和没有这个字段一样，接着找下一个
    let filled = |u: Option<String>| u.filter(|u| !u.trim().is_empty());
    let url = filled(text(v, "urlDefault"))
        .or_else(|| filled(text(v, "url")))
        .or_else(|| filled(scene("WB_DFT")));
    let live = (v.get("livePhoto").and_then(Value::as_bool) == Some(true))
        .then(|| v.get("stream").and_then(best_stream))
        .flatten();
    Image {
        url,
        width: v.get("width").and_then(Value::as_u64),
        height: v.get("height").and_then(Value::as_u64),
        live,
    }
}

/// 每一路最多留几个备用地址：页面给上千个也不会变成上千个请求。
const MAX_BACKUPS: usize = 3;

/// 默认取的那一档短边不超过这么多像素（竖屏看宽、横屏看高）：先取到内容，不追最高画质。
/// 页面给的 1080p 及以上的档（`originVideoKey` 原片 2026-01 起不给了）算试验性，默认不挑；
/// 要放开时改这个数。
const PREFERRED_SHORT_SIDE: u64 = 720;

/// `stream` 下每一档都当候选，不认档名：档名从 `h264`、`h265`、`av1` 换成过 `EF4`–`EF7`
/// （照 MediaCrawler `media_platform/xhs/media.py:61-75` 的做法，非商用学习许可，没有用它的代码）。
/// 先挑能直接播放的：`format` 是 mp4（没写也算）、编码是 h264；再 mp4 的别的编码；最后别的。
/// 同一级里取短边不超过 [`PREFERRED_SHORT_SIDE`] 的最大那一档，都超过就取最小的。
fn best_stream(streams: &Value) -> Option<Stream> {
    let buckets = streams.as_object()?;
    buckets
        .iter()
        .filter_map(|(bucket, list)| Some((bucket, list.as_array()?)))
        .flat_map(|(bucket, list)| list.iter().filter_map(move |s| stream(bucket, s)))
        .max_by_key(|(s, format)| {
            let codec = s.codec.to_ascii_lowercase();
            let mp4 = format
                .as_deref()
                .is_none_or(|f| f.eq_ignore_ascii_case("mp4"));
            let playable = match (mp4, matches!(codec.as_str(), "h264" | "avc" | "avc1")) {
                (true, true) => 2,
                (true, false) => 1,
                (false, _) => 0,
            };
            let short = match (s.width, s.height) {
                (Some(w), Some(h)) => w.min(h),
                (w, h) => w.or(h).unwrap_or(0),
            };
            // 不超过的越大越好，都排在超过的前面；超过的越小越好
            let size = if short <= PREFERRED_SHORT_SIDE {
                (1, short)
            } else {
                (0, u64::MAX - short)
            };
            (playable, size)
        })
        .map(|(s, _)| s)
}

/// 一档；返回 `format` 一起用来挑。编码取 `videoCodec`，没写时用档名。
fn stream(bucket: &str, s: &Value) -> Option<(Stream, Option<String>)> {
    let backup: Vec<String> = s
        .get("backupUrls")
        .and_then(Value::as_array)
        .map(|b| {
            b.iter()
                .filter_map(|u| u.as_str().map(str::to_owned))
                .filter(|u| !u.is_empty())
                .take(MAX_BACKUPS)
                .collect()
        })
        .unwrap_or_default();
    let url = text(s, "masterUrl")
        .filter(|u| !u.is_empty())
        .or_else(|| backup.first().cloned())?;
    Some((
        Stream {
            url,
            backup,
            codec: text(s, "videoCodec")
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| bucket.to_owned()),
            width: s.get("width").and_then(Value::as_u64),
            height: s.get("height").and_then(Value::as_u64),
            duration_ms: s.get("duration").and_then(Value::as_u64),
        },
        text(s, "format"),
    ))
}

/// 平台自带的字幕：`video.media.video.subtitles`，按 `source`、`zh-CN`、`en-US` 的先后挑一份
/// （字段位置和先后照 xhs-vault `scraper/build_corpus.py:39-71`，MIT，没有用它的代码）。
/// 形状有两种：`{"zh-CN": [{"url": …}], …}`，或 `[{"url": …, "language": …}]`。
fn subtitle(raw: &Value) -> Option<Subtitle> {
    let subs = raw.pointer("/video/media/video/subtitles")?;
    let url_of = |v: &Value| {
        let first = v.as_array().and_then(|a| a.first()).unwrap_or(v);
        text(first, "url")
            .or_else(|| text(first, "subtitleUrl"))
            .filter(|u| !u.trim().is_empty())
    };
    let found: Vec<(String, String)> = match subs {
        Value::Object(map) => map
            .iter()
            .filter_map(|(k, v)| Some((k.clone(), url_of(v)?)))
            .collect(),
        Value::Array(list) => list
            .iter()
            .filter_map(|s| {
                let key = text(s, "language").or_else(|| text(s, "lang"))?;
                Some((key, url_of(s)?))
            })
            .collect(),
        _ => return None,
    };
    let (key, url) = ["source", "zh-CN", "en-US"]
        .iter()
        .find_map(|want| found.iter().find(|(k, _)| k == want))
        .or_else(|| found.first())?
        .clone();
    Some(Subtitle {
        url,
        // `source` 是原声那一份，不是语言名
        lang: (key != "source"
            && key.len() <= 16
            && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .then_some(key),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 页面给再多备用地址也只留前三个：一路视频最多连四次。
    #[test]
    fn backup_urls_are_capped() {
        let backups: Vec<String> = (0..1000)
            .map(|i| format!("https://b{i}.xhscdn.com/v.mp4"))
            .collect();
        let streams = serde_json::json!({"h264": [{"masterUrl": "https://a.xhscdn.com/v.mp4", "backupUrls": backups}]});
        let s = best_stream(&streams).unwrap();
        assert_eq!(s.backup, backups[..3]);
    }

    fn json(src: &str) -> Result<String, StateError> {
        js_object_to_json(src)
    }

    #[test]
    fn rewrites_js_literals_outside_strings() {
        assert_eq!(
            json(r#"{"a":undefined,"b":[undefined, 1e5],"c":new Set([]),"d":new Map([["k",-1.5E-3]]),"e":new Set()}"#).unwrap(),
            r#"{"a":null,"b":[null, 1e5],"c":[],"d":[["k",-1.5E-3]],"e":[]}"#
        );
    }

    #[test]
    fn keeps_strings_untouched() {
        let src = r#"{"desc":"undefined 和 new Set([]) 都是正文","q":"a\"undefined\"b","e":"\\"}"#;
        assert_eq!(json(src).unwrap(), src);
    }

    #[test]
    fn stops_at_the_end_of_the_object() {
        assert_eq!(
            json(r#"{"a":{"b":1}};window.x={"c":2}</script>"#).unwrap(),
            r#"{"a":{"b":1}}"#
        );
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        for bad in [
            r#"{"a":NaN}"#,
            r#"{"a":new Date(1)}"#,
            r#"{"a":"open"#,
            r#"{"a":1"#,
            r#"{"a":new Set([1]}"#,
            r#"{"a":1)}"#,
            r#"[1]"#,
        ] {
            assert!(json(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn extract_finds_the_marker() {
        let html = r#"<script>window.__INITIAL_STATE__ = {"note":{"x":undefined}}</script>"#;
        assert_eq!(extract(html).unwrap()["note"]["x"], Value::Null);
        assert!(matches!(extract("<html></html>"), Err(StateError::NoState)));
        let guarded = r#"<script>if(window.__INITIAL_STATE__){x()}</script>
            <script>window.__INITIAL_STATE__={"note":{"y":1}}</script>"#;
        assert_eq!(extract(guarded).unwrap()["note"]["y"], 1);
        assert!(matches!(
            extract("<script>window.__INITIAL_STATE__ = null</script>"),
            Err(StateError::Unreadable(_))
        ));
    }

    const ID: &str = "671234567890abcdef012345";

    fn state_with(note: Value) -> Value {
        serde_json::json!({"note": {"firstNoteId": ID, "noteDetailMap": {ID: {"note": note}}}})
    }

    fn minimal() -> Value {
        serde_json::json!({"noteId": ID, "type": "normal", "imageList": []})
    }

    #[test]
    fn missing_fields_are_upstream_changes() {
        let without = |key: &str| {
            let mut n = minimal();
            n.as_object_mut().unwrap().remove(key);
            state_with(n)
        };
        let unknown_type = {
            let mut n = minimal();
            n["type"] = "multi".into();
            state_with(n)
        };
        let cases = [
            (serde_json::json!({}), "note"),
            (serde_json::json!({"note": {}}), "note.noteDetailMap"),
            (without("noteId"), "note.noteId"),
            (without("type"), "note.type"),
            (without("imageList"), "note.imageList"),
            (unknown_type, "a known note.type (got `multi`)"),
        ];
        for (state, path) in cases {
            match note(&state, ID) {
                Err(StateError::Missing(p)) => assert_eq!(p, path),
                other => panic!("{path}: {other:?}"),
            }
        }
        // 只有 noteId，别的都可以没有
        let bare = note(&state_with(minimal()), ID).unwrap();
        assert_eq!((bare.title, bare.desc, bare.author), (None, None, None));
        assert!(bare.tags.is_empty() && bare.images.is_empty());
    }

    #[test]
    fn picks_the_requested_note() {
        // key 和 noteId 对不上时按 firstNoteId 找，再核对 noteId
        let other = "aaaaaaaaaaaaaaaaaaaaaaaa";
        let by_first = serde_json::json!({"note": {"firstNoteId": "k", "noteDetailMap": {"k": {"note": minimal()}}}});
        assert_eq!(note(&by_first, ID).unwrap().id, ID);
        let wrong = serde_json::json!({"note": {"noteDetailMap": {other: {"note": {"noteId": other, "type": "normal", "imageList": []}}}}});
        assert!(matches!(
            note(&wrong, ID),
            Err(StateError::WrongNote { .. })
        ));
        let empty = state_with(serde_json::json!({}));
        assert!(matches!(note(&empty, ID), Err(StateError::Absent(_))));
        let none = serde_json::json!({"note": {"noteDetailMap": {}}});
        assert!(matches!(note(&none, ID), Err(StateError::Absent(_))));
    }

    #[test]
    fn live_photos_and_video_without_streams() {
        let mut n = minimal();
        n["imageList"] = serde_json::json!([
            {"urlDefault": "a", "livePhoto": true, "stream": {"h264": [{"masterUrl": "live-a"}]}},
            {"urlDefault": "b", "livePhoto": false, "stream": {"h264": [{"masterUrl": "ignored"}]}}
        ]);
        let got = note(&state_with(n), ID).unwrap();
        assert_eq!(got.images[0].live.as_ref().unwrap().url, "live-a");
        assert!(got.images[1].live.is_none());
        let mut v = minimal();
        v["type"] = "video".into();
        v["video"] = serde_json::json!({"media": {"stream": {"h264": [], "h265": []}}});
        let got = note(&state_with(v), ID).unwrap();
        assert_eq!((got.kind, got.video), (NoteKind::Video, None));
    }

    #[test]
    fn prefers_h264_up_to_the_preferred_size() {
        let streams: Value = serde_json::from_str(
            r#"{"h265":[{"masterUrl":"h265","height":1080}],
                "h264":[{"masterUrl":"low","height":480},{"masterUrl":"","backupUrls":["high-b"],"height":720}]}"#,
        )
        .unwrap();
        let s = best_stream(&streams).unwrap();
        assert_eq!((s.url.as_str(), s.codec.as_str()), ("high-b", "h264"));
        let only_h265: Value =
            serde_json::from_str(r#"{"h264":[],"h265":[{"masterUrl":"h"}]}"#).unwrap();
        assert_eq!(best_stream(&only_h265).unwrap().codec, "h265");
        assert!(best_stream(&serde_json::json!({"h264": []})).is_none());
    }

    /// 档名不是编码名（`EF4`…）时照样挑：看 `format`、`videoCodec` 和短边。
    #[test]
    fn picks_from_any_bucket_name() {
        let streams: Value = serde_json::from_str(
            r#"{"EF4":[{"masterUrl":"ef4-h265","format":"mp4","videoCodec":"h265","width":720,"height":1280}],
                "EF5":[{"masterUrl":"ef5-1080","format":"mp4","videoCodec":"h264","width":1080,"height":1920},
                       {"masterUrl":"","backupUrls":["","ef5-720-b"],"format":"mp4","videoCodec":"h264","width":720,"height":1280}],
                "EF6":[{"masterUrl":"ef6-hls","format":"m3u8","videoCodec":"h264","width":480,"height":854}],
                "EF7":"not a list"}"#,
        )
        .unwrap();
        let s = best_stream(&streams).unwrap();
        // 能直接播的 h264 mp4 里短边不超过 720 的那一档；主地址空就用第一个不空的备用地址
        assert_eq!((s.url.as_str(), s.codec.as_str()), ("ef5-720-b", "h264"));
        assert_eq!(s.backup, ["ef5-720-b"]);

        // 上限两侧：只有短边超过的时取最小的
        let over: Value = serde_json::from_str(
            r#"{"EF5":[{"masterUrl":"2160","videoCodec":"h264","width":2160,"height":3840},
                       {"masterUrl":"1080","videoCodec":"h264","width":1080,"height":1920}]}"#,
        )
        .unwrap();
        assert_eq!(best_stream(&over).unwrap().url, "1080");
        let at: Value = serde_json::from_str(
            r#"{"EF5":[{"masterUrl":"721","videoCodec":"h264","width":721,"height":1280},
                       {"masterUrl":"720","videoCodec":"h264","width":720,"height":1280},
                       {"masterUrl":"480","videoCodec":"h264","width":480,"height":854}]}"#,
        )
        .unwrap();
        assert_eq!(best_stream(&at).unwrap().url, "720");

        // 不知道格式和编码的也是候选，排在 h264 mp4 后面
        let unknown: Value =
            serde_json::from_str(r#"{"EF9":[{"masterUrl":"bare","height":720}]}"#).unwrap();
        assert_eq!((best_stream(&unknown).unwrap().codec.as_str()), "EF9");
        let mixed: Value = serde_json::from_str(
            r#"{"EF9":[{"masterUrl":"bare","height":720}],"EF4":[{"masterUrl":"known","videoCodec":"h264","height":480}]}"#,
        )
        .unwrap();
        assert_eq!(best_stream(&mixed).unwrap().url, "known");
        // 不是 mp4 的排在最后
        let hls: Value = serde_json::from_str(
            r#"{"EF6":[{"masterUrl":"hls","format":"m3u8","videoCodec":"h264"}],"EF4":[{"masterUrl":"h265","format":"mp4","videoCodec":"h265"}]}"#,
        )
        .unwrap();
        assert_eq!(best_stream(&hls).unwrap().url, "h265");
    }

    #[test]
    fn platform_subtitles() {
        let with = |subs: Value| {
            let mut v = minimal();
            v["type"] = "video".into();
            v["video"] = serde_json::json!({"media": {"video": {"subtitles": subs}, "stream": {}}});
            note(&state_with(v), ID).unwrap().subtitle
        };
        let by_lang = with(serde_json::json!({
            "en-US": [{"url": "en"}],
            "zh-CN": [{"url": "zh"}]
        }))
        .unwrap();
        assert_eq!(
            (by_lang.url.as_str(), by_lang.lang.as_deref()),
            ("zh", Some("zh-CN"))
        );
        let source =
            with(serde_json::json!({"zh-CN": [{"url": "zh"}], "source": [{"url": "src"}]}))
                .unwrap();
        assert_eq!((source.url.as_str(), source.lang), ("src", None));
        let listed = with(serde_json::json!([{"language": "en-US", "url": "en"}])).unwrap();
        assert_eq!(listed.lang.as_deref(), Some("en-US"));
        let odd = with(serde_json::json!({"x/../y": [{"url": "u"}]})).unwrap();
        assert_eq!(odd.lang, None);
        assert!(with(serde_json::json!({"zh-CN": [{"url": ""}]})).is_none());
        assert!(with(serde_json::json!({})).is_none());
        // 图文笔记不看
        let mut n = minimal();
        n["video"] =
            serde_json::json!({"media": {"video": {"subtitles": {"zh-CN": [{"url": "zh"}]}}}});
        assert!(note(&state_with(n), ID).unwrap().subtitle.is_none());
    }
}
