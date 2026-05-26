const DEBUG = import.meta.env.DEV

export const log = {
  info: (...args: unknown[]) => {
    if (DEBUG) console.info(...args)
  },
  warn: (...args: unknown[]) => {
    console.warn(...args)
  },
  error: (...args: unknown[]) => {
    console.error(...args)
  },
}
