import { app } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export async function setStartAtLogin(enabled: boolean): Promise<void> {
  if (process.platform === 'linux') {
    await setLinuxAutostart(enabled)
    return
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: enabled ? ['--hidden'] : []
  })
}

async function setLinuxAutostart(enabled: boolean): Promise<void> {
  const directory = path.join(os.homedir(), '.config', 'autostart')
  const file = path.join(directory, 'sleep-relay.desktop')
  if (!enabled) {
    await fs.rm(file, { force: true })
    return
  }

  await fs.mkdir(directory, { recursive: true })
  const executable = process.execPath.replaceAll('"', '\\"')
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=SleepRelay',
    'Comment=Resume Codex work after usage limits reset',
    `Exec="${executable}" --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
  await fs.writeFile(file, entry, 'utf8')
}
