# 撸城：谁是世一上

B 站 UP 主九夜听风《三年之期已到，恭迎世一上归位！》的同人互动游戏（序章）。左右滑卡，作死会死。

在线游玩：https://shiyishang-game.github.io/

## 声明

- 同人作品，经九夜听风授权使用剧集画面与原声；非官方、非商业。
- AI 生成内容，非真实事件，选手仅作为演员出场。
- 与 Riot Games、腾讯及各战队无关。
- 纯静态网页：没有服务器、账号、输入框和 Cookie，不收集任何个人信息。
- 匿名访问统计：用 Umami Cloud 计数（打开次数、选了谁、打出了哪些结局）。不加载第三方脚本，不用 Cookie，不发设备 ID；浏览器开了“请勿追踪”/ GPC 时不统计。代码见 `js/stats.js`。

## 许可

- 代码（`js/`、`css/`、`index.html`、`tools/`）：MIT，见 `LICENSE`。
- 剧本文字（`story/`、`data/story.json`）：CC BY-NC-SA 4.0（https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans）。
- 剧集截图与原声（`assets/img/d/`、`assets/sfx/`）版权归九夜听风，仅获授权在本作中使用，不在上述开源许可范围内。
- AI 生成图（`assets/img/ai/`、`assets/img/px/`、`assets/img/sel/`、`assets/img/ui/`）随剧本文字按 CC BY-NC-SA 4.0 提供。

## 本地运行

```
python3 tools/build_story.py      # story/*.txt → data/story.json
python3 -m http.server 8848       # 打开 http://127.0.0.1:8848/
node tools/test_engine.mjs        # 引擎测试
```
