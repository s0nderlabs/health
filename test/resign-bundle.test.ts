import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { intentsGap, sourcesUseAppIntents } from '../src/resign/bundle.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'health-bundle-'))
  dirs.push(d)
  return d
}

describe('bundle completeness', () => {
  test('sourcesUseAppIntents finds a nested import, ignores comments and other modules', () => {
    const src = tmp()
    mkdirSync(join(src, 'Money'), { recursive: true })
    writeFileSync(join(src, 'A.swift'), 'import SwiftUI\n// import AppIntents is mentioned here\n')
    expect(sourcesUseAppIntents(src)).toBe(false)
    writeFileSync(join(src, 'Money', 'M.swift'), 'import Foundation\nimport AppIntents\n')
    expect(sourcesUseAppIntents(src)).toBe(true)
  })

  test('intentsGap: required metadata missing is a gap; present or not needed is fine', () => {
    const src = tmp()
    const app = tmp()
    writeFileSync(join(src, 'M.swift'), 'import AppIntents\n')
    expect(intentsGap(src, app)).toContain('Metadata.appintents')
    mkdirSync(join(app, 'Metadata.appintents'))
    writeFileSync(join(app, 'Metadata.appintents', 'extract.actionsdata'), '{}')
    expect(intentsGap(src, app)).toBeNull()
    const plain = tmp()
    writeFileSync(join(plain, 'V.swift'), 'import SwiftUI\n')
    expect(intentsGap(plain, tmp())).toBeNull()
  })
})
