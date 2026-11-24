# 免费公网部署

沿用123项目：GitHub保存代码与发布备用网页，Render Free运行房间服务。桌面版连接Render后可以跨网络联机；透明效果由本地Windows客户端负责。

1. 在自己的GitHub账号创建本项目仓库，推送当前源码。不要上传node_modules、release或任何账号密钥。GitHub Free的Pages通常需公开仓库。
2. 在Render连接该仓库，使用New → Blueprint读取根目录render.yaml。确认实例套餐显示Free。构建会安装依赖、检查类型、打包网页与服务端。
3. 记录服务地址，例如https://glass-landlord-example.onrender.com。访问/health应显示健康状态。
4. 每个人打开桌面版，在设置的“房间服务地址”中填入同一个HTTPS根地址。之后一人创建房间，其余人凭房间号和密码加入。
5. 如需备用网页，在GitHub仓库的Actions变量中配置ROOM_SERVER_URL为该Render地址，再启用Pages的GitHub Actions发布源并运行Publish web companion。桌面版不依赖Pages。
6. 若要把公网地址预置进新客户端，设置同一个仓库变量后运行Build Windows desktop，从运行产物下载免安装EXE。

Render免费服务空闲后可能休眠，首次连接可能需要约一分钟唤醒。免费额度由同一工作区服务共享；Render重启或休眠会清空内存房间。本方案不自动开通付费实例。

ALLOWED_ORIGINS默认包含123项目使用的GitHub账号来源https://yss907732349.github.io。如换账号，需要改成真实来源（不带仓库路径）。桌面内置localhost页面和服务同源访问均受支持。不要把房间密码填入部署变量。

发布需要可用的GitHub和Render账号授权。工程配置齐全不代表已获得公网地址；以Render健康检查及三个远程客户端加入同一房间为发布验收。

官方说明：https://render.com/docs/free 、https://render.com/docs/websocket 、https://docs.github.com/en/pages
