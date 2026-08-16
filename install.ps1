$ErrorActionPreference = "Stop"
$repository = "bugthedebugger/ants-nest"
$marker = "Managed by Ants Nest CLI installer"

if ($PSVersionTable.PSVersion.Major -lt 5) {
  throw "Ants Nest requires PowerShell 5 or newer."
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCommand) { throw "Ants Nest CLI requires Node.js 22 or newer." }
$nodePath = $nodeCommand.Source
$nodeMajor = [int](& $nodePath -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { throw "Ants Nest CLI requires Node.js 22 or newer." }

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/latest" -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "ants-nest-installer" }
$asset = $release.assets | Where-Object { $_.name -eq "ants-nest-cli.cjs" } | Select-Object -First 1
if (-not $asset) { throw "Release $($release.tag_name) does not contain ants-nest-cli.cjs." }
if ($asset.digest -match '^sha256:([a-fA-F0-9]{64})$') {
  $expectedHash = $Matches[1].ToLowerInvariant()
} else {
  throw "GitHub did not provide a SHA-256 digest for ants-nest-cli.cjs."
}

$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
if (-not $localAppData) { $localAppData = $env:LOCALAPPDATA }
if (-not $localAppData) { throw "Could not locate LOCALAPPDATA." }
$installRoot = Join-Path $localAppData "Ants Nest"
$binDirectory = Join-Path $installRoot "bin"
$cliScript = Join-Path $installRoot "cli.cjs"
$launchers = @((Join-Path $binDirectory "ants.cmd"), (Join-Path $binDirectory "ants-nest.cmd"))

foreach ($launcher in $launchers) {
  if ((Test-Path $launcher) -and -not (Select-String -Path $launcher -SimpleMatch $marker -Quiet)) {
    throw "$launcher already exists and is not managed by Ants Nest. Move or remove it first."
  }
}

New-Item -ItemType Directory -Path $binDirectory -Force | Out-Null
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("ants-nest-cli-" + [Guid]::NewGuid().ToString("N") + ".cjs")
try {
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $temporary -UseBasicParsing
  $actualHash = (Get-FileHash -Path $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw "SHA-256 verification failed for ants-nest-cli.cjs." }
  Move-Item -Path $temporary -Destination $cliScript -Force
} finally {
  Remove-Item -Path $temporary -Force -ErrorAction SilentlyContinue
}

$version = $release.tag_name -replace '^v', ''
$escapedNode = $nodePath.Replace('%', '%%').Replace('"', '""')
$escapedScript = $cliScript.Replace('%', '%%').Replace('"', '""')
$launcherContent = "@echo off`r`nrem $marker`r`nrem ants-nest-cli mode=repository version=$version`r`n`"$escapedNode`" `"$escapedScript`" %*`r`n"
$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
foreach ($launcher in $launchers) {
  [IO.File]::WriteAllText($launcher, $launcherContent, $utf8WithoutBom)
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathEntries = @($userPath -split ';' | Where-Object { $_ })
if (-not ($pathEntries | Where-Object { $_.TrimEnd('\') -ieq $binDirectory.TrimEnd('\') })) {
  $newPath = (@($pathEntries) + $binDirectory) -join ';'
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}
if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $binDirectory.TrimEnd('\') })) {
  $env:Path = "$binDirectory;$env:Path"
}

Write-Host "Installed Ants Nest CLI $version."
Write-Host "Commands: $binDirectory\ants.cmd and $binDirectory\ants-nest.cmd"
Write-Host "Open a new terminal before using ants or ants-nest."
