const base = 'https://github.com/ChoneyChen/Hrrrwork/releases/download/v2.0.2/'
const code = document.getElementById('download-command'), hint = document.getElementById('command-hint')
const tabs = [...document.querySelectorAll('[data-os]')], architecture = document.getElementById('mac-architecture')
let selected = /win/i.test(navigator.userAgent) ? 'win' : /linux/i.test(navigator.userAgent) ? 'linux' : 'mac'
function select(os) {
  selected = os
  const command = {
    mac: [`curl -fL '${base}Hrrrwork-2.0.2-mac-${architecture.value}.dmg' -o Hrrrwork.dmg`, '打开 DMG，将 Hrrrwork 拖入应用程序。'],
    win: [`Invoke-WebRequest -Uri '${base}Hrrrwork-2.0.2-win-x64.exe' -OutFile Hrrrwork-Setup.exe`, '在 PowerShell 中下载，打开安装程序完成安装。'],
    linux: [`curl -fL '${base}Hrrrwork-2.0.2-linux-amd64.deb' -o Hrrrwork.deb\nsudo apt install ./Hrrrwork.deb`, '适用于 Ubuntu / Debian；其他发行版可选择上方 AppImage。']
  }[os]
  if (!command) return
  code.textContent = command[0]; hint.textContent = command[1]
  document.getElementById('architecture-label').hidden = os !== 'mac'
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
architecture.addEventListener('change', () => select(selected))
select(selected)
document.getElementById('copy-command').addEventListener('click', async event => {
  const button = event.currentTarget
  try { await navigator.clipboard.writeText(code.textContent); button.textContent = '已复制 ✓'; document.getElementById('copy-status').textContent = '下载命令已复制' }
  catch { const range = document.createRange(); range.selectNodeContents(code); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.getElementById('copy-status').textContent = '请按 Ctrl+C 或 Command+C 复制' }
})
for (const button of document.querySelectorAll('[data-preview]')) button.addEventListener('click', () => {
  const wake = button.dataset.preview === 'wake'
  const image = document.getElementById('preview-image')
  image.src = wake ? 'wake.png' : 'dashboard.png'
  image.alt = wake ? '唤醒页面：每日四次计划、首个时间约束与轻量模型选择' : '巡夜页面：剩余额度、任务星标与接力队列'
  for (const item of document.querySelectorAll('[data-preview]')) item.setAttribute('aria-pressed', String(item === button))
})
