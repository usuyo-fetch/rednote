# usuyo-fetch/rednote

小红书（rednote）的获取插件，供 [usuyo](https://github.com/usuyo/usuyo) 调用：按笔记链接取回正文、图片和视频。

| 功能 | 实现方式（方法 id） | 账号 | 风险层级 | 状态 |
|---|---|---|---|---|
| 按链接取单条笔记（正文、图片、视频） | `note-page` | 访客身份 | `public-web`，默认开 | 已实现 |
| 列出我的收藏 | `in-usuyo` | 登录进 usuyo（站点窗口自己一份网页数据，cookie 不拷出来） | `browser-session`，默认开 | 已实现，只对本机假站点测过 |
| 列出我的收藏 | `userscript` | 只在使用者的浏览器内 | `browser-session`，默认开 | 已实现 |
| 列出我的收藏 | `iphone` | 只在手机的 App 内 | `vision-ui`，默认开 | 未实现 |
| 列出我的收藏 | `android` | 只在手机的 App 内 | `vision-ui`，默认开 | 未实现 |
| 列出赞过的笔记 | `in-usuyo` | 登录进 usuyo（同上） | `browser-session`，默认开 | 已实现，只对本机假站点测过 |
| 列出赞过的笔记 | `userscript` | 只在使用者的浏览器内 | `browser-session`，默认开 | 已实现 |
| 列出赞过的笔记 | `iphone` | 只在手机的 App 内 | `vision-ui`，默认开 | 未实现 |
| 列出赞过的笔记 | `android` | 只在手机的 App 内 | `vision-ui`，默认开 | 未实现 |

## 方法

### note-page

取单条笔记：正文、作者、发布时间、互动数、标签、图片、视频。请求公开笔记页，读页面里的 `window.__INITIAL_STATE__`；不登录、不签名，带访客身份（usuyo 打开一次首页、不登录，存下页面自己生成的 cookie）。认 `xhslink.com`、`xhslink.cn` 短链。空 cookie 的长链会被送回首页；不填 cookie 批量取约 108 条后，复制链接的账号被下线（见 XHS-Downloader 的 issue 305）。

### in-usuyo

在 usuyo 给小红书单开的窗口里登录，脚本 `userscript/usuyo-xhs-window.js` 打开个人页，先读「收藏」再读「赞过」，默认隔几秒往下翻一屏，翻到底停下。只记页面自己请求回来的列表里的笔记 id、`xsec_token` 和标题，交给 usuyo；内容由 `note-page` 取。自动往下翻是用使用者的账号做的自动操作。

### userscript

浏览器脚本 `userscript/usuyo-xhs-saved.user.js`，在使用者自己浏览器的脚本管理器里运行，读「收藏」「赞过」的链接，只截获页面自己的请求，不另发请求。网页对采集类扩展会弹「有害插件」提示。

### iphone

通过 iPhone 镜像在手机的小红书 App 内读收藏和赞过，需要登录。未实现。

### android

通过安卓手机在手机的小红书 App 内读收藏和赞过，需要登录。未实现。

`userscript` 改写自 [xhs-vault](https://github.com/wkwunju/xhs-vault) 的浏览器脚本（MIT，许可声明见 `userscript/LICENSE.xhs-vault`）。笔记页状态对象的字段名参照了 [ParseHub](https://github.com/z-mio/ParseHub)（MIT）和 [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader)（GPL-3.0）的源码，没有用它们的代码，见 `src/state.rs`。

测试：`cargo test`，只连本机假服务；页面改版时改 `src/state.rs`。两个脚本由 `userscript/src/` 的一个核心和两个壳拼成：改了以后跑 `node userscript/build.mjs`，`node --test userscript/test/*.test.mjs` 核对拼好的文件没过时。依赖同级目录下 usuyo 仓库的 `usuyo-plugin-kit`。许可证：MIT。

## 开发

`Cargo.toml` 里的 `usuyo-plugin`、`usuyo-plugin-kit` 是对 `https://github.com/usuyo/usuyo` 的 git 依赖，钉在固定的 `rev`。

本地开发时用旁边 `usuyo/` 的工作区代替它们：`usuyo-fetch/.cargo/config.toml`（不进任何插件仓库）写了下面的覆盖，cargo 从当前目录往上找这个文件，在插件文件夹里跑 cargo 就生效；从别处跑要加 `--config <这个文件>`。

```toml
[patch."https://github.com/usuyo/usuyo"]
usuyo-plugin = { path = "../usuyo/crates/usuyo-plugin" }
usuyo-plugin-kit = { path = "../usuyo/crates/usuyo-plugin-kit" }
```

`Cargo.lock` 记的是覆盖后的路径形式，所以 CI 不加 `--locked` 构建，cargo 只重新锁这两个 usuyo crate。
