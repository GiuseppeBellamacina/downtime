/** Something the user wants at hand while Claude works: a page in its own browser window, or a document. */
export type Activity = {
  /** Short and stable: a-z, 0-9 and dashes. */
  id: string
  name: string
  kind: 'url' | 'file'
  /** An http(s) address, or the absolute path of a document. */
  target: string
  /** For a file: text its window's title holds (default: the file's name). */
  match?: string
}

export type DowntimeSettings = {
  /** The master switch: while off, nothing opens or minimizes by itself. */
  enabled: boolean
  /** The ids switched on: the only ones that open by themselves and that Claude may use. */
  selected: string[]
  /** Seconds Claude must have been busy before the windows open. */
  delaySec: number
  /** Minimize them when Claude needs the user or is done. */
  minimizeOnAsk: boolean
  /** Bring them back when Claude carries on after the user answered. */
  reopen: boolean
  /** A sound and a notification when Claude needs the user. */
  chime: boolean
}

export type Busy = {
  /** A turn of the main conversation is running. */
  turn: boolean
  /** Subagents still running. */
  agents: string[]
  /** Background tasks still running, with when they started (a lost end notice must not hold the windows forever). */
  tasks: { id: string; at: number }[]
  /** A permission or a question is waiting for the user. */
  needsUser: boolean
  /** The windows are up, as far as the plugin knows. */
  shown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    downtime: {
      activities: Activity[]
      settings: DowntimeSettings
      busy: Busy
      /** The last thing the pane tells the user. */
      message: string | null
    }
  }
}
