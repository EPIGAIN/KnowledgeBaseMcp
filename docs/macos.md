# macOS 安装与验收

macOS 安装器和 LaunchAgent 已在 Mac 真机的本地模拟目录上通过隔离验证；真实 Claude Code 也已连接 MCP 并验证离线暂停。**实际 SMB 上传、Codex 模型会话以及本轮终端追踪优化的 Mac 回归仍待验收**。发布给 Mac 员工前应执行下面的真机检查。

## 安装

员工先安装 Node.js 22+，安装并登录客户端，克隆仓库；终端需要能找到 `node`、`npm` 以及 `claude`/`codex`。无需安装 PowerShell，不使用 sudo。

复制仓库内 `company-knowledge.example.md` 为私有的 `company-knowledge.local.md`，填写 MdRoot、FilesRoot 和 WorkRoot 的绝对路径。可以先选三个独立的本地目录测试。实际路径只放在私有配置，仓库不提供默认工作目录或 NAS 地址。

在仓库根目录执行：

```bash
bash ./scripts/install-macos.sh --config-file "<配置MD路径>" --clients auto
```

可选参数 `--state-dir "<本机状态根目录>"` 允许改变内部数据位置；默认由程序维护 `~/Library/Application Support/CompanyKnowledgeMcp`。状态不能放在 `/Volumes` 下。修改 MD 或状态位置后重跑同一命令，沿用员工 ID 和去重记录；旧归档及旧状态保留。Node 升级后也应重跑安装并重启客户端，以刷新绝对可执行文件路径。

重启客户端，在 WorkRoot 里打开新会话，按客户端流程信任 Hook。目标可访问后，Agent 提示询问姓名；如果停在输入框，发送“你好”触发回复。姓名不在安装时预填，Claude Code 和 Codex 共用配置。

## NAS 与工作开关

先在 Finder 中连接并认证 NAS，再填写挂载卷下的实际目录，通常在 `/Volumes` 下。MCP 不接受 `smb://` URL 或 Windows UNC 作为 Mac 文件路径，也不会自动挂载、存储账号密码或自动创建缺失的存储根目录。

`/Volumes` 下的目标会检查是否仍属于已挂载文件系统；仅剩同名本地空目录时暂停。共享盘重新挂载后若名称变化，需要恢复原挂载位置或修改 MD 并应用。目标访问失败、权限不足、尚未答姓名、手动暂停都会阻止采集。断网发现仍存在健康检查间隔。

NAS 文件系统必须支持本项目用于防覆盖提交的同目录硬链接；具体 SMB 服务器与 Mac 挂载组合仍需验证。若返回 `ATOMIC_COMMIT_UNSUPPORTED`，程序保留已登记快照并报告错误，不冒险覆盖或把文件误报为上传成功。

## 后台服务

安装会在当前用户 `~/Library/LaunchAgents` 下创建以配置入口哈希命名的独立 plist。ProgramArguments 使用绝对 Node/脚本路径，后台不依赖交互终端的 PATH。Hook 同样使用绝对 Node 路径并进行 Shell 引号处理。

服务登录时启动，由 launchd 在异常退出后重启；登出、休眠和关机期间不执行。系统如要求允许后台项目或访问工作文件夹/网络卷，需按实际提示授权。安装器会核对监听状态和服务 PID，不把写好 plist 当成启动成功。失败时配置保留，修复后可重复安装。

后台只监听新经手文件清单，每约 2 秒检查，不扫描历史。暂停或进程停止期间的修改在恢复后建立基线，不补采。Mac 终端适配 Bash/Zsh 中 Node/Python 的受支持写入；`echo > file`、原生应用等未适配写入不能推测为 Agent 产物。

可单独移除后台服务：

```bash
node ./bin/kb.mjs service-remove-macos --config "<安装输出中的配置入口>"
```

该操作只停止并移除对应 LaunchAgent，保留 MCP/Hook 配置、员工资料和归档。服务错误日志在固定配置入口旁的 `logs/watcher.stderr.log`，监听状态位于当前状态版本中的 `watcher-status.json`。

## Mac 真机检查

```bash
npm test
npm run test:macos
KB_TEST_SCHEDULE=1 npm run test:macos
```

第一条执行核心测试及 Bash 中的 Node/Python 终端观察器；需可用的 Python 3，可通过 `KB_TEST_PYTHON` 指定。Windows 专项会跳过。第二条使用隔离客户端目录和模拟客户端命令，仅测试安装检测/注册，实际执行 Node Hook，验证姓名提示、跨客户端去重、忽略历史、MD/StateDir 迁移；不运行真实模型。第三条还会在当前登录用户下注册临时 LaunchAgent，验证重复注册和后台人工修改归档，最后移除临时服务。测试若不能移除服务，会保留临时目录供排查。

非 Mac 执行 `test:macos` 会显示 skipped，不能视为通过。完成自动化后，还需从真实两个客户端各开一个工作会话，验证姓名引导和新文件归档，并在目标 SMB 挂载上检查断开/重连行为及硬链接提交；不要用实际工作资料做首次验收。

参考：[Apple 的 LaunchAgent 说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)。
