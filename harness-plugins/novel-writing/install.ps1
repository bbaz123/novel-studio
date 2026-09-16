# Novel Writing 插件安装/升级脚本（novel-studio 内置版）
#
# 自 P0（专用运行时）起，本插件以 **dsh bundle** 形式安装，profile 侧不再做区块合并：
#   - bundle 包就是本目录（package.json 的 dsh.bundle.patch -> ./cordis.patch.yml）；
#   - profile 通过 node_modules 里的 junction 引用本目录——工坊仓库即唯一来源，
#     不再把 novel-tools.mjs 复制进 profile（消除复制后的版本漂移面）；
#   - profile 自身的 cordis.patch.yml 回归为干净用户层，安装脚本不再改写它；
#   - 旧版安装留下的「创作内核注入」区块与复制副本会被一次性清理（带备份）。
#   profile 侧的具体接线由同目录的 install-profile.mjs 完成（零依赖 node 脚本）。
#
# 两个安装点：
#   1) GUI agent preset  ~/.dsh/.agent-presets/novel-writing/（dsh 交互会话用）
#   2) dsh profile       ~/.dsh/profiles/<Profile>/（novel-studio 后台任务用）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1                  # 默认 headless profile
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile novel   # 专用 profile
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun          # 预演，不写文件
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile novel -Uninstall
param(
  [switch]$DryRun,
  [switch]$Uninstall,
  [string]$Profile = 'headless'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$presetDest = Join-Path $dshHome '.agent-presets\novel-writing'
$profileDir = Join-Path $dshHome "profiles\$Profile"

if ($Profile -notmatch '^[A-Za-z0-9._-]{1,64}$') {
  Write-Error "非法 -Profile：$Profile（仅允许字母/数字/点/下划线/连字符，1-64 字符）"
  exit 1
}

# 版本号随 plugin.json 的 version 字段（运行时读取，不再硬编码）。
$script:Version = ([System.IO.File]::ReadAllText((Join-Path $root 'plugin.json')) | ConvertFrom-Json).version

$srcTools = Join-Path $root 'novel-tools.mjs'
$srcAgent = Join-Path $root 'agent.cordis.yml'
$srcPreset = Join-Path $root 'preset.yml'
$wiring = Join-Path $root 'install-profile.mjs'

function Say($msg) { Write-Host $msg }

# 备份保留最近 N 个 .bak，每次备份后自动清理更早的备份，避免重复安装堆积。
$script:MaxBackups = 5
$script:backups = @()

function Cleanup-Backups($path) {
  $dir = Split-Path $path
  $name = [System.IO.Path]::GetFileName($path)
  $baks = @(Get-ChildItem -Path (Join-Path $dir "$name.bak-*") -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  if ($baks.Count -le $script:MaxBackups) { return }
  foreach ($old in $baks[$script:MaxBackups..($baks.Count - 1)]) {
    Remove-Item $old.FullName -Force -ErrorAction SilentlyContinue
    Say "    已清理旧备份 -> $($old.Name)"
  }
}

function Backup-File($path) {
  if (-not (Test-Path $path)) { return }
  $bak = "$path.bak-$(Get-Date -Format yyyyMMddHHmmssfff)"
  Copy-Item $path $bak
  Say "    已备份原文件 -> $bak"
  $script:backups += @{ Target = $path; Bak = $bak; IsDir = $false }
  Cleanup-Backups $path
}

function Backup-Directory($path) {
  if (-not (Test-Path $path)) { return }
  $bak = "$path.bak-$(Get-Date -Format yyyyMMddHHmmssfff)"
  Copy-Item $path $bak -Recurse
  Say "    已备份原目录 -> $bak"
  $script:backups += @{ Target = $path; Bak = $bak; IsDir = $true }
  $dir = Split-Path $path
  $name = [System.IO.Path]::GetFileName($path)
  $dirBaks = @(Get-ChildItem -Path (Join-Path $dir "$name.bak-*") -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  if ($dirBaks.Count -gt $script:MaxBackups) {
    foreach ($old in $dirBaks[$script:MaxBackups..($dirBaks.Count - 1)]) {
      Remove-Item $old.FullName -Recurse -Force -ErrorAction SilentlyContinue
      Say "    已清理旧目录备份 -> $($old.Name)"
    }
  }
}

function Restore-Backups() {
  $baks = @($script:backups)
  for ($i = $baks.Count - 1; $i -ge 0; $i--) {
    $b = $baks[$i]
    if (-not (Test-Path $b.Bak)) { continue }
    if ($b.IsDir) {
      if (Test-Path $b.Target) { Remove-Item $b.Target -Recurse -Force -ErrorAction SilentlyContinue }
      Copy-Item $b.Bak $b.Target -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Copy-Item $b.Bak $b.Target -Force -ErrorAction SilentlyContinue
    }
    Say "    已回滚 -> $($b.Target)"
  }
}

# profile 侧接线一律交给 install-profile.mjs（JSON/YAML 处理放在 node 里，避免 PowerShell 的编码陷阱）。
function Invoke-Wiring([string[]]$ExtraArgs) {
  $args = @($wiring, '--profile', $Profile) + $ExtraArgs
  if ($DryRun) { $args += '--dry-run' }
  & node @args
  if ($LASTEXITCODE -ne 0) { throw "install-profile.mjs 失败（exit $LASTEXITCODE）" }
}

if ($Uninstall) {
  Say "==> 卸载 novel-writing 插件 v$script:Version（profile=$Profile）"
  try {
    if (Test-Path $presetDest) {
      if ($DryRun) { Say "    [DryRun] 将删除 $presetDest" }
      else {
        Backup-Directory $presetDest
        Remove-Item $presetDest -Recurse -Force
        Say "    已删除 GUI preset"
      }
    } else {
      Say "    GUI preset 不存在，跳过"
    }
    Say '==> profile 侧撤销接线'
    Invoke-Wiring @('--uninstall')
    Say '✔ 卸载完成。'
    exit 0
  } catch {
    Restore-Backups
    Write-Error "卸载失败，已回滚已备份文件：$($_.Exception.Message)"
    exit 1
  }
}

Say "==> novel-writing 插件 v$script:Version 安装（内置 · 面向 novel-studio · profile=$Profile）"
if (-not (Test-Path $srcTools)) { Write-Error "缺少 $srcTools"; exit 1 }
if (-not (Test-Path $srcAgent)) { Write-Error "缺少 $srcAgent"; exit 1 }
if (-not (Test-Path $srcPreset)) { Write-Error "缺少 $srcPreset"; exit 1 }
if (-not (Test-Path $wiring)) { Write-Error "缺少 $wiring"; exit 1 }

try {
  Say '==> 1/2 GUI agent preset（dsh 交互会话用）'
  if (-not (Test-Path $presetDest)) {
    if ($DryRun) { Say "    [DryRun] 将创建 $presetDest" }
    else {
      New-Item -ItemType Directory -Path $presetDest -Force | Out-Null
      Say "    已创建 preset 目录"
    }
  } else {
    Say "    已存在旧 preset，将覆盖更新（preset 内容由本仓库统一维护）"
  }
  if (-not $DryRun) {
    if (Test-Path (Join-Path $presetDest 'agent.cordis.yml')) { Backup-File (Join-Path $presetDest 'agent.cordis.yml') }
    Copy-Item $srcAgent (Join-Path $presetDest 'agent.cordis.yml') -Force
    Copy-Item $srcPreset (Join-Path $presetDest 'preset.yml') -Force
    Copy-Item $srcTools (Join-Path $presetDest 'novel-tools.mjs') -Force
    # 清理旧版（v0.x 上游 preset）残留文件：本 preset 目录只应包含本仓库维护的文件。
    $legacyReadme = Join-Path $presetDest 'README.md'
    if (Test-Path $legacyReadme) { Remove-Item $legacyReadme -Force; Say '    已清理旧版 preset 残留 README.md' }
    Say "    preset 已安装：$presetDest"
  } else {
    Say "    [DryRun] preset 文件将复制到 $presetDest"
  }

  Say '==> 2/2 dsh profile 接线（novel-studio 后台任务）'
  Invoke-Wiring @()
} catch {
  Restore-Backups
  Write-Error "安装失败，已回滚已备份文件：$($_.Exception.Message)"
  exit 1
}

Say ''
Say '✔ 完成。'
Say '  1) 若升级了 novel-studio 服务端文件（db.js/server.js/harness.js），请重启：npm start'
Say '  2) 打开 novel-studio 使用 AI 创作即可，无需在 dsh 里手动选 preset。'
Say "  3) 验证：dsh --profile $Profile --dump-config   # 组合树应含 novel-tools 条目"
Say "     或实跑一次：dsh --profile $Profile `"只输出一行：你当前可用的全部工具名称，用逗号分隔`""
Say '     期望出现：novel_context, novel_works, novel_lookup, novel_scan, novel_style_contract, novel_event_add, novel_memory_update, novel_foreshadows, novel_foreshadow_update, novel_consistency, novel_blueprint, novel_review, novel_chapter_save'
