param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $repoRoot
try {
    if (-not $SkipBuild) {
        Push-Location ui
        try {
            & corepack.cmd pnpm build
            if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }
        } finally { Pop-Location }
        $linuxRoot = (& wsl.exe -- wslpath -a $repoRoot.Replace('\', '/')).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'WSL path conversion failed' }
        & wsl.exe -- bash "$linuxRoot/tools/mioty/docker/prepare.sh"
        if ($LASTEXITCODE -ne 0) { throw 'Backend/demo bundle build failed' }
    }
    & docker compose -f compose.mioty-demo.yml up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'Docker demo startup failed' }
    Write-Host 'Demo is starting. Initial integration checks take about two minutes.'
    Write-Host 'Inspect status: docker compose -f compose.mioty-demo.yml ps'
    Write-Host 'Inspect links: docker compose -f compose.mioty-demo.yml exec demo cat /data/current.json'
    Write-Host 'Local login: admin / admin. Stop: docker compose -f compose.mioty-demo.yml down'
} finally { Pop-Location }
