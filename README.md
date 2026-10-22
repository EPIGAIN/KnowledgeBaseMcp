# 员工知识归档 MCP

**简体中文** | [English](README.en.md)

将员工新经手的工作文件和有价值的问题解决记录归档到 NAS 或指定的本地目录。Claude Code 与 Codex 在同一台电脑上共用员工身份、工作目录白名单、上传队列和去重记录。

程序运行在员工电脑。安装后由 Agent 主动询问姓名，在 Markdown 目标和其他文件目标中建立员工专属目录；后台只跟进已登记文件的后续修改，不扫描或补传历史文件。

> Windows 安装和后台任务已验证。macOS 安装器与 LaunchAgent 适配已加入，尚未完成 Mac 真机和实际 SMB 挂载验收。详见 [验证记录](docs/verification.md) 和 [Mac 验收步骤](docs/macos.md)。

## 安装前准备

需要 Git、Node.js 22+（含 npm），以及已经安装、登录的 Claude Code 或 Codex。当前终端应能找到 `node`、`npm` 和对应客户端命令 `claude` / `codex`。

使用发布者提供的仓库地址克隆，进入仓库根目录：

```text
git clone <repository-url>
cd <repository-directory>
```

准备两个互不包含的上传目标目录，以及一个或多个允许采集的工作目录。建议将工作目录、上传目标和状态目录分开放置；不要选择整个个人目录。工作目录必须已存在且可访问，不能位于目标或状态目录内。目标可以是本地模拟目录或 NAS 共享目录，程序不创建缺失的上传根目录。

- **Windows**：先用当前员工账号访问共享盘。可使用绝对本地路径或 UNC 共享路径；网络盘符必须对运行客户端和后台任务的同一用户可见。
- **macOS**：先在 Finder 中连接、认证并挂载 NAS，再填写挂载卷下的绝对路径，通常位于 `/Volumes` 下。不要填写 Windows UNC 路径或 `smb://` URL。程序不会自动挂载 NAS 或保存其密码。

公开仓库只提供占位模板。真实路径、填写好的配置和单独分发给员工的安装命令保留在本地，不提交到 GitHub。

## 1. 准备一份 MD 配置

如果管理员已发来填写好的配置，直接使用该文件，不要用模板覆盖它。首次自行配置时，复制 [配置模板](company-knowledge.example.md)：

**Windows / PowerShell**

```powershell
Copy-Item -LiteralPath .\company-knowledge.example.md -Destination .\company-knowledge.local.md
notepad .\company-knowledge.local.md
```

**macOS / Terminal**

```bash
cp ./company-knowledge.example.md ./company-knowledge.local.md
open -e ./company-knowledge.local.md
```

只修改表格里的路径，保留配置标记、表头和键名。每项填写实际绝对路径；Windows 反斜杠原样填写，不需要 JSON 转义。

| 配置项 | 用途 |
| --- | --- |
| `MdRoot` | Markdown 文件及问题解决记录的上传目录 |
| `FilesRoot` | 其他文件的上传目录 |
| `WorkRoot` | 允许采集的工作目录；多个目录就增加多行 |

姓名由 Agent 首次询问，不写进配置。状态目录无需填写，程序自动管理。真实配置使用 `*.local.md` 文件名，或放在仓库之外；前者已被 Git 忽略。

## 2. 一键安装

在仓库根目录运行对应命令。以下为**公开通用示例**；管理员单独分发的命令可以指向另一份私有配置 MD。

### Windows

```powershell
powershell.exe -NoProfile -File .\scripts\Install-OneClick.ps1 -ConfigFile .\company-knowledge.local.md -Clients auto
```

安装器检查依赖，配置客户端的用户级 MCP 和 Hook，注册并启动当前用户的 Windows 计划任务。无需为每个工作项目重复安装。

### macOS

```bash
bash ./scripts/install-macos.sh --config-file ./company-knowledge.local.md --clients auto
```

不需要 PowerShell，也不要使用 `sudo`。安装器配置用户级 MCP 和 Hook，在当前用户的 `~/Library/LaunchAgents` 下注册、启动后台服务。Mac 的服务和 Hook 使用绝对 Node 路径，不依赖交互终端的 PATH。

### 可选参数

| 用途 | Windows | macOS |
| --- | --- | --- |
| 选择客户端 | `-Clients auto` | `--clients auto` |
| 自定义本机状态目录 | `-StateDir "<本机状态根目录>"` | `--state-dir "<本机状态根目录>"` |
| 隔离测试用客户端目录 | `-ClientHome "<测试用户目录>"` | `--client-home "<测试用户目录>"` |
| 跳过后台注册，仅供测试 | `-SkipTask` | `--skip-service` |

客户端可选 `auto`、`claude`、`codex`、`both`。`auto` 配置当前终端检测到的客户端。Mac 使用隔离客户端目录时必须同时指定 `--skip-service`。

状态默认位于当前用户的系统应用数据目录：Windows 为 `%LOCALAPPDATA%\CompanyKnowledgeMcp`，Mac 为 `~/Library/Application Support/CompanyKnowledgeMcp`。它保存员工身份、不可变快照、队列、去重记录和配置备份，不需要人工编辑。可选状态目录必须位于本机，不能放在共享盘或 Mac 的 `/Volumes` 下；以后省略参数会沿用已有位置。

首次目标离线时仍可安装，但归档保持暂停。安装输出会显示日常维护的 MD 文件、固定配置入口和程序管理的状态目录。

## 3. 首次使用

1. 重启客户端，从配置的 `WorkRoot` 内打开新会话。
2. 按客户端正常流程信任项目、MCP 和 Hook；Codex 可用 `/hooks` 审阅 Hook。
3. 两个上传目标可访问时，Agent 主动询问姓名。若停在输入框，发送“你好”触发首次回复。
4. 回答后，Agent 调用 `kb_setup`，在两类目标中建立同名员工文件夹（姓名加随机短标识）。登记前不采集、不上传。

同一电脑上的两个客户端共用身份，不重复登记。相同源路径和内容版本复用原归档记录；同一员工在另一台电脑上的身份和队列不会自动合并。

## 修改配置与迁移

编辑同一份 MD，然后重跑对应系统的安装命令。更改状态目录时追加可选参数。Node 升级后也应重跑安装并重启客户端，以刷新可执行文件位置。

MD 变更尚未应用、格式错误或无法读取时，MCP 和后台都会暂停。应用时先校验路径，再暂停新操作，迁移已登记快照并校验，最后切换配置。员工 ID、归档 ID 和去重记录保留；目标已有相同文件时复用，内容冲突时停止，旧数据保留。不扫描工作目录，不搬动本地工作文件或 NAS 中手工加入的文件。

新版 MCP 和后台会加载已应用配置，恢复时重新建立监听基线。失败后修正原因并重跑同一命令即可继续。旧 JSON 安装自动升级仅支持 Windows。取消尚未提交的迁移等操作见 [迁移说明](docs/config-migration.md)。

## 工作开关与采集范围

MCP、Hook、终端观察器和后台监听共用工作开关。已配置工作范围、两个目标可访问、员工已登记且未手动暂停时才允许采集；会话必须位于工作范围内。暂停时仍可查询状态和切换开关，数据操作返回 `WORK_PAUSED`。这不改变客户端自身的沙箱、审批或信任设置。

- 已适配的 Read/Write/Edit、Codex `apply_patch`、`kb_read_work_file`、显式上传和受支持的终端写入会登记文件。
- 后台每约 2 秒检查**已登记文件清单**，内容稳定约 2 秒后归档新版本。相同内容不重复上传，旧版本保留。大文件或网络操作会延长间隔。
- 仅放入工作目录、但没有新经手证据的文件不会自动归档。旧文件在启用后被明确处理，也可以登记；“不扫历史”不等于拒绝旧文件。
- 暂停、离线或后台停止期间的新修改不补采；恢复时建立当前基线。暂停前已有的不可变快照可以重试。需要上传暂停期间的修改时，让 Agent 恢复后重新处理该文件。
- Agent 退出后，后台仍可跟进清单内的人工修改。Windows 计划任务有登录、周期和每日触发；Mac LaunchAgent 登录时启动并在异常退出后重启。登出、休眠、关机期间不执行。

通过 Agent 调用 `kb_profile`、`kb_status` 查看状态，调用 `kb_work_switch` 暂停或恢复。两个系统也都可在仓库根目录运行：

```text
node ./bin/kb.mjs pause --config "<安装输出中的配置入口>"
node ./bin/kb.mjs resume --config "<安装输出中的配置入口>"
```

## 停止后台服务

**Windows**

```powershell
powershell.exe -NoProfile -File .\scripts\Register-ArchiveTask.ps1 -ConfigPath "<安装输出中的配置入口>" -Remove
```

**macOS**

```bash
node ./bin/kb.mjs service-remove-macos --config "<安装输出中的配置入口>"
```

这些命令只移除本安装的后台任务，保留 MCP/Hook 配置、员工身份和归档。日常暂停请使用工作开关；重跑安装命令可以恢复服务。

## 限制

- 终端适配 Node 常见 `fs` 写入、Python `open`/`pathlib` 和 Windows 常见 PowerShell 文件 cmdlet。Mac Bash/Zsh 复用 Node/Python 观察器。纯 Shell 重定向、原生扩展、直接 .NET 写入、绕过预加载或脱离原命令的后台程序不保证捕获，不会用目录扫描猜测产物。
- 网络断开按健康检查周期发现，存在检测间隔。Mac `/Volumes` 目标还检查是否已挂载，避免把遗留空目录视为在线共享盘；重新挂载后路径需与配置一致。
- 工作白名单是路径边界，不能判断内容属于工作还是生活。个人文件应放在工作范围之外；员工目录隔离不代替 NAS 账号权限。
- 目标文件系统须支持同目录硬链接以防覆盖既有文件。失败时保留快照并报告待处理，不标记为上传成功。具体 Mac/SMB 组合尚待验收。
- 这是单向版本归档，不同步本地删除、改名，不进行双向同步。网页文件管理器可能需要刷新。
- 运行时姓名引导和错误提示目前主要为中文；英文 README 不代表运行时已经完整英文化。

## 开发验证与 GitHub 发布准备

```text
npm ci
npm test
npm run check:release
npm pack --dry-run
```

Windows 安装验证使用 `npm run test:installation`；Mac 使用 `npm run test:macos`。默认使用隔离客户端目录。设置 `KB_TEST_SCHEDULE=1` 可启用对应系统的真实临时后台任务测试，结束后移除任务；Mac 测试在非 Mac 系统上明确跳过。Python 专项可通过 `KB_TEST_PYTHON` 指定解释器。

发布时只加入公开源码、测试、脱敏文档和占位模板。以下内容保留在仓库之外或已忽略的本地目录：

- 真实配置 `*.local.md`、`.local-private/` 中的员工安装命令和部署资料。
- `workspace/`、`.test-output/`、状态目录、上传队列、个人工作文件和对话。
- 客户端配置、`.env`、日志、配置备份、Python 缓存和依赖。

`npm run check:release` 检查公开文件中的敏感信息，以及 Git 可加入文件、索引和历史中的发布范围。可用 `REDACT_TERMS`（以 `|` 分隔）追加组织专有名称。报告只显示文件与问题类别，不打印命中内容；新增二进制附件和外部资料仍需审阅。README 命令均为通用示例，不包含真实部署路径。
