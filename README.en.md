# Employee Knowledge Archive MCP

[简体中文](README.md) | **English**

Archive newly handled work files and useful problem-solving notes to a NAS or explicitly configured local directories. Claude Code, Codex, and the Doubao desktop STDIO integration share one employee profile, work-directory allowlist, upload queue, and deduplication state on the same computer.

The program runs on the employee's computer. After installation, the Agent asks for the employee's name and creates an employee folder in each destination. The background worker follows subsequent edits to registered files without scanning or backfilling historical files.

> The Windows installer and scheduled worker have been tested. The macOS installer and LaunchAgent have passed native tests using local simulation directories; real SMB uploads still need validation. The terminal-tracing changes in this revision have not yet been regression-tested on Mac. See the [verification record](docs/verification.md) and [Mac validation guide](docs/macos.md), both currently in Chinese.

## Prerequisites

Install Git, Node.js 22+ with npm, and Claude Code or Codex. Sign in to the client. The current terminal must be able to find `node`, `npm`, and the relevant `claude` / `codex` command.

Clone the repository using the URL supplied by the publisher, then enter its root directory:

```text
git clone <repository-url>
cd <repository-directory>
```

Prepare two upload destinations that do not contain one another, and one or more work directories. Keep work, destination, and state directories separate where possible. Do not select the entire user home directory. Work directories must already exist, be accessible, and not be located inside destination or state directories. Destinations may be local simulation folders or NAS shares; the program does not create missing destination roots.

- **Windows:** Access the share as the current employee first. Configuration accepts absolute local paths or UNC share paths. Mapped drives must be visible to the same user running the clients and background task.
- **macOS:** Connect, authenticate, and mount the NAS in Finder first. Configure absolute paths inside the mounted volume, typically under `/Volumes`. Do not use Windows UNC paths or `smb://` URLs. The program does not mount shares automatically or store NAS passwords.

The public repository contains placeholders only. Keep real paths, completed configurations, and separately distributed employee installation commands local; do not commit them to GitHub.

For Doubao-only use, a desktop version with a custom STDIO connector is required; Claude Code / Codex need not be installed. See the Doubao section below. Its collection capabilities differ from CLI Hooks.

## 1. Prepare one Markdown configuration

If an administrator supplied a completed configuration, use it directly; do not overwrite it with the template. To create a new configuration, copy the [template](company-knowledge.example.md):

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

Edit only the paths in the table. Keep the marker comments, table headers (including the Chinese header labels), and keys unchanged. Use actual absolute paths. Windows backslashes are literal and do not require JSON escaping.

| Key | Purpose |
| --- | --- |
| `MdRoot` | Destination for Markdown files and problem-solving notes |
| `FilesRoot` | Destination for other files |
| `WorkRoot` | Eligible work directory; add more rows for additional directories |

The Agent asks for the name later; do not add it to the configuration. Internal state is managed automatically. Name the private configuration `*.local.md`, which Git ignores, or keep it outside the repository.

## 2. Run the installer

Run the command for your operating system from the repository root. These are **generic public examples**; an administrator may distribute a separate command pointing to another private Markdown configuration.

### Windows

```powershell
powershell.exe -NoProfile -File .\scripts\Install-OneClick.ps1 -ConfigFile .\company-knowledge.local.md -Clients auto
```

The installer checks dependencies, configures user-level MCP connections and Hooks, and registers and starts a Windows scheduled task for the current user. You do not need to install again for each work project.

### macOS

```bash
bash ./scripts/install-macos.sh --config-file ./company-knowledge.local.md --clients auto
```

PowerShell is not required. Do not use `sudo`. The installer configures user-level MCP connections and Hooks, then registers and starts a service under `~/Library/LaunchAgents`. The Mac service and Hooks use an absolute Node path and do not depend on an interactive terminal's PATH.

### Optional parameters

| Purpose | Windows | macOS |
| --- | --- | --- |
| Select clients | `-Clients auto` | `--clients auto` |
| Override local state storage | `-StateDir "<local-state-root>"` | `--state-dir "<local-state-root>"` |
| Isolated client home for testing | `-ClientHome "<test-user-directory>"` | `--client-home "<test-user-directory>"` |
| Skip background registration for testing | `-SkipTask` | `--skip-service` |

Client options are `auto`, `claude`, `codex`, `both`, `doubao`, and `all`. Automatic detection covers only Claude Code / Codex; `both` retains its original meaning and `all` additionally exports a Doubao registration. On Mac, `--client-home` requires `--skip-service`.

State defaults to `%LOCALAPPDATA%\CompanyKnowledgeMcp` on Windows or `~/Library/Application Support/CompanyKnowledgeMcp` on Mac. It contains the employee profile, immutable snapshots, queue, deduplication records, and configuration backups. Do not edit these internal files. An overridden state directory must be local, not a network share or a Mac `/Volumes` mount. Later installs retain the chosen location if the parameter is omitted.

The first installation can complete while destinations are offline, but archiving stays paused. Installer output identifies the Markdown settings file, stable configuration entry point, and managed state directory.

### Doubao desktop (STDIO)

Windows:

```powershell
powershell.exe -NoProfile -File .\scripts\Install-OneClick.ps1 -ConfigFile .\company-knowledge.local.md -Clients doubao
```

macOS:

```bash
bash ./scripts/install-macos.sh --config-file ./company-knowledge.local.md --clients doubao
```

The installer prepares shared state and the background worker, exports a private `doubao-stdio.json`, and prints `commandField`, the argument array, and a full `commandLine`. Enter these fields in Doubao's custom STDIO connector and enable it through the normal client workflow. When the command path contains spaces, paste the quoted `commandField`; otherwise Doubao splits it at the space and reports `COMMAND_NOT_FOUND`. The installer does not edit Doubao's internal settings.

For an explicit work request, call `kb_profile`, then `kb_begin_work` with an allowlisted work directory. Include the returned `work_session` in subsequent data calls and `kb_setup` after the employee answers the name question. No desktop launch directory is treated as the current project. Each token is restricted to the selected directory, remains in that MCP process only, expires after four hours, and is invalidated by configuration migration. End it with `kb_end_work`; use `kb_work_switch` to pause the shared background worker as well.

The token makes tool scope explicit; it does not authenticate a Doubao chat or classify personal conversations. Enable the connector only for intended local work tasks and follow client permissions. Calls without a valid work context cannot read or upload files.

**Server-side integration and stdio protocol tests are implemented; actual Doubao-client validation is pending.** Read/upload/search and knowledge-note tools are available, and previously registered files can be followed by the shared worker. No Doubao Hook is installed: arbitrary Doubao file operations, cloud attachments, and chat history are not automatically captured. Files need a local path inside WorkRoot and an explicit MCP read/upload first. Source files are not modified; no historical scan is added.

After a Node upgrade, rerun installation and update the connector fields in Doubao. Keep the repository location fixed; moving it requires resolving the old registration's program-path conflict first. Keep the exported JSON local. Run `npm run test:doubao` for protocol tests. The detailed [Doubao guide](docs/doubao.md) is currently in Chinese. The following instructions about launching from WorkRoot and trusting Hooks apply to Claude Code and Codex.

## 3. First use

1. Restart the client and open a new session inside a configured `WorkRoot`.
2. Follow the client's normal trust process for the project, MCP connection, and Hooks. Codex provides `/hooks` for reviewing Hooks.
3. When both destinations are accessible, the Agent asks for your name. If the client is waiting at an input prompt, send a greeting to trigger the first response.
4. After your answer, the Agent calls `kb_setup` and creates matching employee folders in both destinations, using the name plus a random short identifier. No collection or upload occurs before registration.

Both clients on the same computer reuse this identity. The same source path and content version reuse the existing archive record. Profiles and queues on separate computers are not automatically merged, even when the employee name is the same.

## Configuration changes and migration

Edit the same Markdown file, then rerun the installer for your operating system. Append the optional state parameter to move internal state. After upgrading Node, rerun installation and restart the clients to refresh executable paths.

MCP and background collection pause when the Markdown table changes before application, becomes invalid, or cannot be read. Applying changes validates paths, pauses new operations, migrates and verifies registered snapshots, then switches configuration. Employee IDs, archive IDs, and deduplication records are preserved. Identical destination files are reused; conflicting content stops migration. Old data is retained. Migration does not scan work directories or move original work files or manually added NAS files.

Current MCP servers and workers reload the applied configuration and establish fresh monitoring baselines. If migration fails, fix the cause and rerun the same command. Automatic upgrades from legacy JSON installations are supported only on Windows. See the [migration guide](docs/config-migration.md), currently in Chinese, for cancelling an uncommitted migration and other recovery steps.

## Shared work switch and collection scope

MCP, Hooks, terminal observers, and the background worker share one work switch. Collection requires configured work directories, two accessible destinations, a registered employee, and no manual pause. Sessions must run within the work scope. Status and switch tools remain available while paused; data operations return `WORK_PAUSED`. This does not change the client's sandbox, approval, or trust settings.

- Supported Read/Write/Edit operations, Codex `apply_patch`, `kb_read_work_file`, explicit uploads, and supported terminal writes register files.
- The worker checks **registered files only**, approximately every two seconds, and archives a new version after content remains stable for about two seconds. Identical content is deduplicated and old versions are retained. Large files or network operations can extend these intervals.
- Merely placing a file in a work directory does not register it. An existing file can be registered when explicitly handled after activation; avoiding history scans does not mean rejecting all older files.
- Edits made while paused, offline, or while the worker is stopped are not backfilled. On recovery, the worker establishes a current baseline. Immutable snapshots captured before the pause can still be retried. To archive edits made during a pause, have the Agent explicitly handle the file again after recovery.
- The worker can follow manual edits to registered files after the Agent exits. Windows tasks have logon, periodic, and daily triggers; Mac LaunchAgents start at login and restart after unexpected exits. No processing runs during logout, sleep, or shutdown.
- Routine successful archives stay quiet. Hooks add guidance at session start, during onboarding, or when work state changes. Outside-work Hooks add no archiving guidance, and the Agent is not instructed to change its file tools for collection.

Ask the Agent to use `kb_profile` and `kb_status` for status, or `kb_work_switch` to pause or resume. These commands also work from the repository root on either platform:

```text
node ./bin/kb.mjs pause --config "<configuration-entry-from-installer-output>"
node ./bin/kb.mjs resume --config "<configuration-entry-from-installer-output>"
```

## Stop the background service

**Windows**

```powershell
powershell.exe -NoProfile -File .\scripts\Register-ArchiveTask.ps1 -ConfigPath "<configuration-entry-from-installer-output>" -Remove
```

**macOS**

```bash
node ./bin/kb.mjs service-remove-macos --config "<configuration-entry-from-installer-output>"
```

These commands remove only this installation's background task. MCP/Hook configuration, employee identity, and archives remain. Use the work switch for an ordinary pause. Rerun the installer to restore the service.

## Limitations

- Archiving reads source files and stores copies, but installation updates client settings, terminal observers create `.kb-terminal` inside work directories, and internal state consumes local disk space. Terminal commands still load tracing code, which adds overhead; compatibility with every third-party program cannot be guaranteed.
- Python tracing returns native file objects instead of proxy objects and does not force user streams to flush or close. It observes supported buffered writes and `os.open/write/close`; custom streams, `open(..., buffering=0)`, and unfinished output are not guaranteed to be captured.
- Node/Python consolidate repeated checks of each file, normally reading its initial contents and final contents at exit. Device, file identity, size, and high-resolution timestamps are checked before and after the final hash. Intervening writes or incomplete evidence cause a skip rather than attributing unknown exit-time contents to the command. This is not kernel-level file activity auditing.
- Terminal capture supports common Node `fs` writes, Python `open`/`pathlib`, and common Windows PowerShell file cmdlets. Mac Bash/Zsh commands reuse the Node/Python observers. Plain shell redirection, native extensions, direct .NET writes, preload bypasses, and detached background programs are not guaranteed to be captured. There is no directory-scan fallback to guess outputs.
- Network disconnects are detected through health checks, not instantaneously. Mac `/Volumes` destinations are also checked for a mounted filesystem so a leftover empty directory is not treated as an online share. Remounted paths must match the configuration.
- Work boundaries are path-based; the program cannot distinguish personal content from work content. Keep personal files outside the allowlist. Employee folders do not replace NAS account permissions.
- Destination filesystems must support same-directory hard links for commits that cannot overwrite existing files. Failed commits retain snapshots and report pending work rather than upload success. Real Mac/SMB combinations still require validation.
- This is a one-way version archive, not bidirectional synchronization. Local deletions and renames are not mirrored. Web file managers may need a refresh.
- Runtime onboarding and error messages are currently mainly in Chinese. This English README does not imply complete runtime localization.

## Development checks and GitHub preparation

```text
npm ci
npm test
npm run check:release
npm pack --dry-run
```

Use `npm run test:installation` on Windows and `npm run test:macos` on Mac. Both use isolated client directories by default. Set `KB_TEST_SCHEDULE=1` to enable a temporary real background task for the relevant platform, removed after testing. The Mac script explicitly skips execution on other platforms. Set `KB_TEST_PYTHON` to select the interpreter for Python tests.

Publish only public source, tests, sanitized documentation, and placeholder templates. Keep the following outside the repository or in ignored local directories:

- Real `*.local.md` configurations, employee installation commands, and deployment materials under `.local-private/`.
- `workspace/`, `.test-output/`, state directories, upload queues, personal work files, and conversations.
- Client settings, `.env` files, logs, configuration backups, Python caches, and dependencies.

`npm run check:release` checks public files for sensitive data and examines Git-add candidates, the index, and history for publication-scope problems. Use `REDACT_TERMS`, separated with `|`, to add organization-specific terms. Reports show filenames and issue categories without printing matched content. New binary attachments and external materials still need review. All README commands are generic examples and contain no real deployment paths.
