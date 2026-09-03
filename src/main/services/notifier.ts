import { app, Notification } from 'electron'

export interface Notice {
  title: string
  body: string
  onClick?: () => void
}

/** macOS notifications and the Dock badge. */
export class Notifier {
  muted = false

  post(notice: Notice): void {
    if (this.muted || !Notification.isSupported()) return
    const n = new Notification({ title: notice.title, body: notice.body, silent: false })
    if (notice.onClick) n.on('click', notice.onClick)
    n.show()
  }

  setBadge(count: number): void {
    app.dock?.setBadge(count > 0 ? String(count) : '')
  }
}
