// Bundle completeness checks: a re-signed app must carry everything the
// manual build carries, not just a valid signature.
//
// Nov 16 2026 incident: an incremental Debug build relinked only the app's
// stub executable (the code lives in HealthRelay.debug.dylib), so the linker
// dependency file no longer mentioned AppIntents.framework, the App Intents
// metadata extractor skipped ("no AppIntents.framework dependency found") and
// the installed app had no Metadata.appintents. Shortcuts then could not find
// "Log Money Notification" and six money notifications were lost.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/** True when any Swift source under `dir` imports AppIntents. */
export function sourcesUseAppIntents(dir: string): boolean {
  const walk = (d: string): boolean => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return false
    }
    for (const e of entries) {
      const full = join(d, e)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (walk(full)) return true
      } else if (e.endsWith('.swift')) {
        try {
          if (/^\s*import\s+AppIntents\b/m.test(readFileSync(full, 'utf8'))) return true
        } catch {
          // unreadable file: keep looking
        }
      }
    }
    return false
  }
  return walk(dir)
}

/** null when the bundle is complete, else why not. `appSources` is the app
 *  target's source dir (relayer-ios/HealthRelay). */
export function intentsGap(appSources: string, appBundle: string): string | null {
  if (!sourcesUseAppIntents(appSources)) return null
  const meta = join(appBundle, 'Metadata.appintents', 'extract.actionsdata')
  if (!existsSync(meta)) return 'the source uses AppIntents but the bundle has no Metadata.appintents (Shortcuts actions would vanish)'
  return null
}
