# Employee Knowledge Archive MCP

[简体中文](README.md) | **English**

Archive newly handled work files and useful problem-solving notes to a NAS or explicitly configured local directories. Claude Code and Codex share one employee profile, work-directory allowlist, upload queue, and deduplication state on the same computer.

The program runs on the employee's computer. After installation, the Agent asks for the employee's name and creates an employee folder in each destination. The background worker follows subsequent edits to registered files without scanning or backfilling historical files.

> The Windows installer and scheduled worker have been tested. The macOS installer and LaunchAgent adapter are implemented, but have not yet been validated on a real Mac or a real Mac SMB mount. See the [verification record](docs/verification.md) and [Mac validation guide](docs/macos.md), both currently in Chinese.

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

Client options are `auto`, `claude`, `codex`, and `both`. Automatic detection configures clients found in the current terminal. On Mac, `--client-home` requires `--skip-service`.

State defaults to `%LOCALAPPDATA%\CompanyKnowledgeMcp` on Windows or `~/Library/Application Support/CompanyKnowledgeMcp` on Mac. It contains the employee profile, immutable snapshots, queue, deduplication records, and configuration backups. Do not edit these internal files. An overridden state directory must be local, not a network share or a Mac `/Volumes` mount. Later installs retain the chosen location if the parameter is omitted.

The first installation can complete while destinations are offline, but archiving stays paused. Installer output identifies the Markdown settings file, stable configuration entry point, and managed state directory.

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
