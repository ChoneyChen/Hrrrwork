const base = 'https://github.com/ChoneyChen/Hrrrwork/releases/download/v1.0.0/'
const downloads = {
  mac: { command: `curl -fL '${base}Hrrrwork-1.0.0-mac-universal.dmg' -o Hrrrwork.dmg`, hint: '下载到当前目录，打开 DMG 后将 Hrrrwork 拖入“应用程序”。' },
  win: { command: `Invoke-WebRequest -Uri '${base}Hrrrwork-1.0.0-win-x64.exe' -OutFile Hrrrwork.exe`, hint: '在 PowerShell 中运行，下载后双击 Hrrrwork.exe 即可。' },
  linux: { command: `curl -fL '${base}Hrrrwork-1.0.0-linux-x86_64.AppImage' -o Hrrrwork.AppImage\nchmod +x Hrrrwork.AppImage`, hint: '下载到当前目录，随后运行 ./Hrrrwork.AppImage。' }
}
const code = document.getElementById('download-command')
const hint = document.getElementById('command-hint')
const tabs = [...document.querySelectorAll('[data-os]')]
function select(os) {
  if (!downloads[os]) return
  code.textContent = downloads[os].command
  hint.textContent = downloads[os].hint
  for (const tab of tabs) { const active = tab.dataset.os === os; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1 }
  document.getElementById('command-panel').setAttribute('aria-labelledby', `tab-${os}`)
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => select(tab.dataset.os))
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    select(next.dataset.os); next.focus()
  })
}
select(/win/i.test(navigator.userAgent) ? 'win' : /linux/i.test(navigator.userAgent) ? 'linux' : 'mac')
document.getElementById('copy-command').addEventListener('click', async event => {
  const button = event.currentTarget
  try {
    await navigator.clipboard.writeText(code.textContent)
    button.textContent = '已复制 ✓'
    document.getElementById('copy-status').textContent = '下载命令已复制'
    setTimeout(() => { button.textContent = '复制命令' }, 1800)
  } catch {
    const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range)
    document.getElementById('copy-status').textContent = '已选中命令，请按 Ctrl+C 或 Command+C 复制'
    button.textContent = '请按快捷键复制'
  }
})
