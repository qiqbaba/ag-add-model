# Deploy /lead-worker command plugin to DSH web profile
# Usage: .\deploy-lead-worker-command.ps1

$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'workflows\lead-worker-command'
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$dst = Join-Path $profile 'node_modules\@local\lead-worker-command'
$patch = Join-Path $profile 'cordis.patch.yml'

# 1) Copy plugin files
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Force (Join-Path $src 'index.js') (Join-Path $dst 'index.js')
Copy-Item -Force (Join-Path $src 'package.json') (Join-Path $dst 'package.json')
Write-Host "[OK] Copied plugin to $dst"

# 2) Patch cordis.patch.yml
if (-not (Test-Path $patch)) {
  throw "cordis.patch.yml not found at: $patch"
}

$content = [System.IO.File]::ReadAllText($patch)
$needUpdate = $false

if ($content -notmatch 'workflow-worker-thread') {
  $prefix = "- id: workflow-worker-thread`r`n  disabled: false`r`n`r`n"
  $content = $prefix + $content
  $needUpdate = $true
}

if ($content -notmatch 'lead-worker-command') {
  $append = "`r`n- insert:`r`n    - id: lead-worker-command`r`n      name: '@local/lead-worker-command'`r`n"
  $content = $content + $append
  $needUpdate = $true
}

if ($needUpdate) {
  [System.IO.File]::WriteAllText($patch, $content, [System.Text.Encoding]::UTF8)
  Write-Host "[OK] Updated $patch configuration"
} else {
  Write-Host "[OK] $patch is already properly configured"
}

Write-Host ''
Write-Host 'Deployment complete. Restart DSH web if it is running.'
