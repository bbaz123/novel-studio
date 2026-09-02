# Creates a desktop shortcut for Novel Studio.
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $project 'start-novel-studio.cmd'
$shortcutPath = Join-Path $desktop 'Novel Studio 小说创作工坊.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcutPath)
$sc.TargetPath = $target
$sc.WorkingDirectory = $project
$sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$sc.Description = 'Novel Studio 小说创作工坊'
$sc.Save()

Write-Host "Shortcut created: $shortcutPath"
