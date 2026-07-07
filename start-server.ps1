$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $scriptDir

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  & $node.Source server.mjs
} else {
  & 'D:\NodeJs\node.exe' server.mjs
}
