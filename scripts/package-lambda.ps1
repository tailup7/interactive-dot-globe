$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$staging = Join-Path $repository '.lambda-build'
$outputDirectory = Join-Path $repository 'artifacts\lambda'
$output = Join-Path $outputDirectory 'interactive-dot-globe-cloud-api.zip'

Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $staging 'lambda') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging 'scripts') -Force | Out-Null
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

Copy-Item (Join-Path $repository 'lambda\index.mjs') (Join-Path $staging 'lambda\index.mjs')
Copy-Item (Join-Path $repository 'lambda\package.json') (Join-Path $staging 'package.json')
Copy-Item (Join-Path $repository 'lambda\package-lock.json') (Join-Path $staging 'package-lock.json')
Copy-Item (Join-Path $repository 'scripts\fetch-clouds.mjs') (Join-Path $staging 'scripts\fetch-clouds.mjs')

Push-Location $staging
try {
  npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
} finally {
  Pop-Location
}

tar.exe -a -c -f $output -C $staging .
Remove-Item -LiteralPath $staging -Recurse -Force
Write-Output "Lambda deployment archive created: $output"
