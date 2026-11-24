# 0.2.1 桌面版与免费公网部署

沿用123项目：GitHub保存代码与发布备用网页，Render Free运行房间服务。桌面版连接Render后可以跨网络联机；深色平面界面、整套界面透明度以及桌面穿透由本地Windows客户端负责，不依赖服务器渲染。

当前已部署的房间服务为 https://glass-landlord.onrender.com ，服务版本0.2.0，协议为 `turn-skills-v2`；0.2.1桌面版与其兼容。新版客户端和GitHub Pages默认连接此地址。0.2.1只修复桌面跨屏拖动，不改变牌局或联机协议，无需为本次修复重启公网服务。以下步骤用于重新部署或迁移。

1. 在自己的GitHub账号创建本项目仓库，推送当前源码。不要上传node_modules、release或任何账号密钥。GitHub Free的Pages通常需公开仓库。
2. 在Render连接该仓库，使用New → Blueprint读取根目录render.yaml。确认实例套餐显示Free。构建会安装依赖、检查类型、打包网页与服务端。
3. 记录服务地址，例如https://glass-landlord-example.onrender.com。访问/health应显示健康状态和`protocol: "turn-skills-v2"`。兼容性按协议检查，不要求服务端与桌面客户端的补丁版本完全相同；当前`version: "0.2.0"`服务可供0.2.0、0.2.1客户端共同联机。仍使用0.1旧技能阶段的客户端需要更新，不能与新协议混用。
4. 每个人打开桌面版，在设置的“房间服务地址”中填入同一个HTTPS根地址。之后一人创建房间，其余人凭房间号和密码加入。
5. 如需备用网页，在GitHub仓库的Actions变量中配置ROOM_SERVER_URL为该Render地址，再启用Pages的GitHub Actions发布源并运行Publish web companion。桌面版不依赖Pages。
6. 若要把公网地址预置进新客户端，设置同一个仓库变量后运行Build Windows desktop，从运行产物下载免安装EXE。

本次Windows文件名为 `GlassLandlord-0.2.1-Windows.exe`。新版使用低调深色平面界面，不使用玻璃高光或磨砂效果。技能通过牌面选中、对手头像选目标及“使用”按钮操作，不再打开技能弹窗。按住左键拖过手牌批量选择，手牌区右键出牌；角落拖动缩放、顶部把手移动，支持将整套牌局从主屏拖到副屏等已连接显示器。点恢复位置、顶部百分比或双击缩放角落会回到主屏；`Ctrl+Shift+0`同时恢复可见度。设置中的整体透明度让牌面、文字、头像和按钮一起变淡。浏览器备用入口支持相同牌局与操作，真实桌面透明、置顶和穿透点击由Windows客户端提供。

涉及服务或协议的升级，部署顺序建议为：推送源码 → 等Render构建完成 → 检查 `/health` 的协议 → 发布新客户端及备用网页 → 三人创建新房。仅桌面显示修复可直接发布新EXE，无需同步部署服务。旧房间保存在旧进程内存里，服务升级会终止旧房间，建议等正在玩的朋友结束后再更新。

公网验收运行 `node scripts/remote-playtest.mjs`。脚本先检查新协议，再创建自己的随机密码测试房，验证桌面与GitHub来源、三人叫分发牌、出牌清桌抽技能、自己回合使用技能后继续出牌、私牌隔离和断线恢复，并主动离开清理。结果写入 `artifacts/remote-playtest-report.json`，不会加入或操作其他玩家已有房间。

Render免费服务空闲后可能休眠，首次连接可能需要约一分钟唤醒。免费额度由同一工作区服务共享；Render重启或休眠会清空内存房间。本方案不自动开通付费实例。

ALLOWED_ORIGINS默认包含123项目使用的GitHub账号来源https://yss907732349.github.io。如换账号，需要改成真实来源（不带仓库路径）。桌面内置localhost页面和服务同源访问均受支持。Render反向代理使用 `TRUST_PROXY=1`，以免所有玩家共享同一个连接限流地址。构建需要 `pnpm install --frozen-lockfile --prod=false` 安装TypeScript/Vite等构建依赖；`NODE_ENV=production`用于运行期，不能因此省略构建工具。不要把房间密码填入部署变量。

发布需要可用的GitHub和Render账号授权。工程配置齐全不代表已获得公网地址；以Render健康检查及三个远程客户端加入同一房间为发布验收。

官方说明：https://render.com/docs/free 、https://render.com/docs/websocket 、https://docs.github.com/en/pages
