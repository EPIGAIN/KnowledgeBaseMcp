# 豆包桌面版：STDIO 接入

适用于提供“自定义连接器 → STDIO / 本地命令”入口的豆包桌面版。接入代码和真实 MCP STDIO 协议测试已提供；豆包客户端界面、模型调用和首次姓名询问仍需在你的具体版本上验收。此模式不会修改豆包内部数据库，不把 Claude Code 的 Hook 配置当作豆包配置写入。

## 安装准备

沿用同一份私有 MD 配置（MdRoot、FilesRoot、WorkRoot）。同机已有 Claude Code / Codex 安装时，也使用这份配置；安装器会发现已有固定入口、员工身份与去重记录。姓名仍由 Agent 询问，不在安装命令预填。

在仓库根目录运行：

Windows：

```powershell
powershell.exe -NoProfile -File .\scripts\Install-OneClick.ps1 -ConfigFile "<配置MD路径>" -Clients doubao
```

macOS：

```bash
bash ./scripts/install-macos.sh --config-file "<配置MD路径>" --clients doubao
```

这两条命令准备共享配置、依赖和后台监听，生成 `doubao-stdio.json`。安装结果会显示该文件的实际绝对路径和接入字段。仅豆包安装不要求本机装有 Claude Code / Codex，也不为它们写配置。

`both` 仍表示 Claude Code + Codex；`all` 表示这两个客户端再加豆包接入文件。`auto` 仍只检测命令行客户端，不能据旧缓存猜测豆包是否已安装。已有安装可以单独再运行 `doubao`，不会重复创建员工或监听任务。可选 StateDir / `--state-dir` 行为不变。

## 填入豆包连接器

从豆包的自定义连接器入口新建，填写：

| 字段 | 内容 |
| --- | --- |
| 名称 | 公司知识库（或 `company-knowledge`） |
| 传输方式 | STDIO / 本地命令 |
| 命令 | 安装输出中的 `commandField`；含空格时为带引号形式 |
| 参数 | 安装输出中的 `args`，保持原有顺序和每个参数边界 |
| 环境变量 | 无需额外填写 |

`doubao-stdio.json` 是本项目生成的接入资料，不是猜测的豆包内部设置路径。如果界面支持导入 `mcpServers` JSON，可以导入它；如果只有参数列表，就逐项填入，命令框使用安装输出的 `commandField`。不要把整个 JSON 当作启动命令。参数中包含空格的路径必须保持为同一个参数。

生成内容形如下面的占位示例；不要直接使用未替换的示例：

```json
{
  "mcpServers": {
    "company-knowledge": {
      "command": "<Node可执行文件绝对路径>",
      "args": [
        "<仓库绝对路径>/bin/kb.mjs",
        "serve",
        "--client",
        "doubao",
        "--config",
        "<安装输出中的固定配置入口>"
      ]
    }
  }
}
```

### 命令路径中的空格

豆包连接器的“命令”框可能按命令行解析：完整路径里的空格会被当成参数分隔符。Windows 的 Node 常见路径 `C:\Program Files\nodejs\node.exe`，以及豆包运行时位于 `...\Doubao\User Data\...` 的 Node 路径，都含有空格。直接粘贴时命令会在第一个空格处截断，客户端报：

```text
CONNECTOR_STDIO_EXECUTABLE_NOT_FOUND: COMMAND_NOT_FOUND
```

因此安装输出同时给出三种形式：

| 输出字段 | 用途 |
| --- | --- |
| `command` | `doubao-stdio.json` 中的结构化未加引号值，供支持 JSON 导入的版本使用 |
| `commandField` | 填入“命令”框的值：路径含空格时自动加英文双引号，不含空格时与原值相同 |
| `commandLine` | 界面只有一个整条命令输入框时，直接粘贴这一整行 |

例如命令路径含空格时，`commandField` 形如 `"C:\Users\<用户名>\AppData\Local\Doubao\User Data\...\node\node.exe"`。引号只用于界面按命令行解析的输入框，不要往 `doubao-stdio.json` 的 `command` 值里再加一层引号。如果这个豆包版本把“命令”当作纯可执行文件路径而不是命令行，先试未加引号的 `command`；出现 `COMMAND_NOT_FOUND` 或被截断的路径时再用 `commandField`。

NAS 路径和后台任务不需要为此错误重装；含空格的参数仍按数组逐项填写。

保存、启用并按豆包正常流程授权。在“本地电脑”的工作任务中选择这个连接器。接口无需公网端口、HTTP 转发、NAS 密码或单独 API Key。NAS 必须由当前操作系统用户正常访问；Mac 先挂载共享卷。

## 工作会话和姓名

桌面应用的进程启动目录不代表聊天正在处理哪个项目，所以此模式不会自动把安装目录或第一个 WorkRoot 当作当前工作目录。

1. 用户明确开始公司知识库工作后，Agent 调用 `kb_profile` 查看工作目录白名单，再用 `kb_begin_work` 选择其中的目录或子项目。
2. `kb_begin_work` 返回 `work_session`。后续数据操作都必须携带这一标识。不同工作任务各用自己的标识；同一个连接不保存会串到其他任务的“当前目录”。
3. 两个目标在线且尚未登记时，返回 `onboarding.nextAction = ask_user_name` 和问题内容，由 Agent 询问姓名。用户回答后再调用 `kb_setup`；已有身份就复用。
4. 完成后调用 `kb_end_work` 使本次标识失效。标识四小时过期、进程重启后失效，配置迁移后也需重新开始。

首次可以对豆包说：

> 请使用公司知识库连接器处理我的工作资料。先检查配置的工作目录，在我指定的项目里开始工作会话；如果还没有登记姓名，请先问我姓名。不要扫描或补传历史文件。

如配置里有多个工作目录或项目，应明确指出这次使用哪一个。客户端尚未触发模型回复时，MCP 不能自行弹出问答，需要先发送工作请求。

`work_session` 用于明确工具调用的范围、防止无上下文访问，不是豆包用户身份认证或对聊天内容的工作/生活分类器。仍依赖用户仅在工作任务中启用连接器并按客户端权限流程授权。不要把标识复制到其他对话。

## 支持范围

| 能力 | 当前方式 |
| --- | --- |
| 读取工作文件并归档 | `kb_read_work_file`；相同源路径和内容与其他客户端去重 |
| 上传本机工作文件 | `kb_upload_file`；限制在本次选定目录内 |
| 浏览、读取、搜索个人知识库 | `kb_list_files` / `kb_read_file` / `kb_search` |
| 保存 Markdown 或问题解决方法 | `kb_write_markdown` / `kb_save_knowledge` |
| 已登记文件后续人工修改 | 共用现有后台监听；稳定后归档新版 |
| 暂停、恢复、查询状态 | `kb_work_switch` / `kb_status`，与其他客户端共用开关 |
| 豆包自身工具经手的全部文件 | 未接入事件 Hook，不能保证自动识别 |
| 自动收集豆包对话记录 | 不支持；仅保存用户明确交给知识库工具的内容 |

拖进豆包的附件、豆包云端生成的文件、单纯下载到本机的文件，不会因为连接器已启用就自动归档。需要先落到 WorkRoot 中，再由本 MCP 读取或上传登记；无法提供本机路径的云端附件不能直接作为本地文件上传。

结束桌面工作会话只停止使用该标识，不改变全局后台。要停止后台继续跟进此前登记文件，明确调用 `kb_work_switch(enabled=false)`；恢复前需先选择工作范围。离线或暂停期间不采集新版本，恢复后不补扫历史。

## 验证

```text
npm run test:doubao
npm test
npm run check:release
```

专项测试使用真实 stdio 子进程和临时模拟目录，验证工具发现、工作范围、身份与跨客户端去重、知识保存、人工修改、离线/暂停、迁移后失效和会话隔离。它不等同于豆包模型已实际调用成功。导入后应在客户端使用新建测试文件做一次读写、重读去重和姓名引导验收，不使用历史工作资料作为测试输入。

更新 Node 后，应重新运行安装器，并把新接入字段更新到豆包连接器中。仓库安装位置应保持固定；移动后需要先处理旧注册来源冲突，安装器不会盲目覆盖另一份程序的注册。实际 MD、接入 JSON 和员工安装命令保留在本地，不提交到公开仓库。
