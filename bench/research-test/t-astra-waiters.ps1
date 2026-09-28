param([switch]$Stop, [ValidateSet('correctness','write')][string]$Kind = 'correctness')
$ErrorActionPreference = 'Stop'
$pattern = if ($Kind -eq 'write') { 'bench[\\/]research-test[\\/]t-astra-write\.ts' } else { 'bench[\\/]research-test[\\/]t-astra-(edge|plan)\.ts' }
$workers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $pattern })
$workers | Select-Object ProcessId, ParentProcessId, CommandLine | Format-List
if ($Stop) {
  $lockText = Get-Content -Raw -Encoding UTF8 .local/research/measure.lock
  if ($lockText -match '^ASTRA-TEST ') { throw 'Own measurement running; refuse stopping waiters' }
  foreach ($worker in $workers) { Stop-Process -Id $worker.ProcessId -ErrorAction SilentlyContinue }
}
