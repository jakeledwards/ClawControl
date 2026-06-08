import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

describe('set-android-version.js', () => {
  let projectRoot
  let buildGradlePath

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'set-version-test-'))
    mkdirSync(join(projectRoot, 'android', 'app'), { recursive: true })
    buildGradlePath = join(projectRoot, 'android', 'app', 'build.gradle')
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  function runScript() {
    const scriptPath = join(process.cwd(), 'scripts', 'set-android-version.js')
    return execSync(`node ${JSON.stringify(scriptPath)}`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }

  function withPackageVersion(version) {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ version }))
  }

  function withGradle(content) {
    writeFileSync(buildGradlePath, content)
  }

  const SAMPLE_GRADLE = `apply plugin: "com.android.application"

android {
    defaultConfig {
        applicationId "com.claw.control"
        versionCode 1
        versionName "0.0.0"
    }
}
`

  it('computes versionCode = major*10000 + minor*100 + patch for 1.8.0', () => {
    withPackageVersion('1.8.0')
    withGradle(SAMPLE_GRADLE)
    const stdout = runScript()
    const after = readFileSync(buildGradlePath, 'utf8')
    expect(after).toContain('versionCode 10800')
    expect(after).toContain('versionName "1.8.0"')
    expect(stdout).toContain('versionCode=10800')
    expect(stdout).toContain('versionName="1.8.0"')
  })

  it('handles patch versions: 1.8.7 → 10807', () => {
    withPackageVersion('1.8.7')
    withGradle(SAMPLE_GRADLE)
    runScript()
    const after = readFileSync(buildGradlePath, 'utf8')
    expect(after).toContain('versionCode 10807')
    expect(after).toContain('versionName "1.8.7"')
  })

  it('handles minor versions: 2.0.0 → 20000', () => {
    withPackageVersion('2.0.0')
    withGradle(SAMPLE_GRADLE)
    runScript()
    const after = readFileSync(buildGradlePath, 'utf8')
    expect(after).toContain('versionCode 20000')
    expect(after).toContain('versionName "2.0.0"')
  })

  it('strips pre-release tag from versionName for Gradle compatibility', () => {
    // package.json may carry "1.9.0-beta.1" during pre-release; Gradle accepts
    // it as versionName but we want versionCode based on the numeric part only.
    withPackageVersion('1.9.0-beta.1')
    withGradle(SAMPLE_GRADLE)
    runScript()
    const after = readFileSync(buildGradlePath, 'utf8')
    expect(after).toContain('versionCode 10900')
    expect(after).toContain('versionName "1.9.0-beta.1"')
  })

  it('rejects versions with major > 9 (would overflow the scheme)', () => {
    withPackageVersion('10.0.0')
    withGradle(SAMPLE_GRADLE)
    expect(() => runScript()).toThrow()
  })

  it('rejects minor > 99 or patch > 99', () => {
    withPackageVersion('1.100.0')
    withGradle(SAMPLE_GRADLE)
    expect(() => runScript()).toThrow()
  })

  it('fails loudly when build.gradle has no versionCode line to replace', () => {
    withPackageVersion('1.8.0')
    withGradle('android {\n    defaultConfig {\n        applicationId "com.claw.control"\n    }\n}\n')
    expect(() => runScript()).toThrow()
  })

  it('throws when package.json has no version field', () => {
    // Write package.json WITHOUT a version field
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'foo' }))
    withGradle(SAMPLE_GRADLE)
    expect(() => runScript()).toThrow()
  })

  it('is idempotent — running twice produces the same content', () => {
    withPackageVersion('1.8.0')
    withGradle(SAMPLE_GRADLE)
    runScript()
    const after1 = readFileSync(buildGradlePath, 'utf8')
    runScript()
    const after2 = readFileSync(buildGradlePath, 'utf8')
    expect(after2).toBe(after1)
  })
})
