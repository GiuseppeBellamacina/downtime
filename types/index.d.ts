/** Something the user wants at hand while Claude works: a page in its own browser window, or a document. */
export type Activity = {
  /** Short and stable: a-z, 0-9 and dashes. */
  id: string
  name: string
  kind: 'url' | 'file' | 'app'
  /** An http(s) address, the full path of a document, or the full path of an .exe (an application). */
  target: string
  /** For an application: its arguments, exactly as written, passed one by one. */
  args?: string[]
  /** For a file: text its window's title holds (default: the file's name). */
  match?: string
  /** For a web page: the browser to use (default: Edge, else Chrome). */
  browser?: 'edge' | 'chrome' | 'brave'
  /**
   * Where the window goes when it opens: a half of a monitor's work area (`full` is all of it), or an exact
   * rectangle in screen pixels. Without it the window opens where the system puts it.
   */
  position?: 'left' | 'right' | 'top' | 'bottom' | 'full' | { x: number; y: number; width: number; height: number }
  /** For a `position` that is a side: which monitor, 1 being the main one (default 1). */
  monitor?: number
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
  /** Nothing opens by itself before this time (milliseconds since the epoch); 0 for no snooze. */
  snoozeUntil: number
  /** The windows are up, as far as the plugin knows. */
  shown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    downtime: {
      activities: Activity[]
      settings: DowntimeSettings
      /** The applications the user confirmed: id to the exact command line seen (a changed path or argument cancels it). */
      confirmed: Record<string, string>
      /** Kept under a tag (see `busyA`): a version whose fields differ declines what an older one stored. The contract has no imports, so this is claude-code's `Shaped<Busy>` written out. */
      busy: { shape: string; value: Busy }
      /** The last thing the pane tells the user. */
      message: string | null
    }
  }
}
