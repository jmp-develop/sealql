param([ValidateSet('edge','plan')][string]$Phase)
$ErrorActionPreference = 'Stop'
$env:ASTRA_CORRECTNESS_NOLOCK = '1'
try { rtk proxy npx tsx "bench/research-test/t-astra-$Phase.ts"; exit $LASTEXITCODE }
finally { Remove-Item Env:ASTRA_CORRECTNESS_NOLOCK -ErrorAction SilentlyContinue }
