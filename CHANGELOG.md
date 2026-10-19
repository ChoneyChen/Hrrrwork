# Hrrrwork 更新日志

## v1.2.0 · 更新也会轻轻送达

### 三端更新

- macOS、Windows、Linux 自动检查 GitHub 正式版本：启动后首次检查，随后每 6 小时检查。
- 默认自动下载对应平台的安装包，可分别关闭自动检查与下载；也能手动检查、重试下载。
- 展示下载进度，按发布资产的 SHA-256 与文件大小校验，打开更新包前再次检查。
- 下载完成后在界面提示，从「设置 → 软件更新 → 查看更新包」安装；不会静默替换运行中的应用。
- Mac 提供 Universal DMG / ZIP，Windows x64 提供便携 EXE，Linux x64 提供 DEB / AppImage。

### Ubuntu Codex 发现修复

- 识别 `/usr/lib/chatgpt` 等 DEB 目录中的 Codex 内置 CLI，避免启动桌面 GUI 作为 App Server。
- 发现同用户运行中的 Codex，继承其 `CODEX_HOME` / `CODEX_SQLITE_HOME`，不复制其他环境信息。
- 补齐 nvm、fnm、asdf、npm global、独立 CLI 等路径；桌面 PATH 中没有 Node 也可启动 Node 入口。
- 设置页显示发现来源和数据目录；额度与任务分别读取，单个接口失败不会连带隐藏另一项。
- 已在 Ubuntu 原生 CI 校验官方 DEB、验证内置 CLI 握手及真实 `/proc` 进程发现。

官网、README、命令行下载与常见问题已同步更新。原有额度唤醒的默认关闭策略、接力防重复保护和用户设置保持不变。

升级提示：v1.1 及更早版本请先手动下载 v1.2。升级后，后续版本即可在应用内自动检查与下载。安装前请先从托盘退出旧版；无需删除原设置。
