# Android Build Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `release.yml` so a `v*` tag pushes a signed APK to the GitHub Release and a signed AAB to the Play Console production track (draft), plus add a PR CI workflow that compiles the Android debug build.

**Architecture:** Single repo, two new workflow files (`release.yml` extended; `android-ci.yml` new). `android/` committed to git as a normal Gradle project. Two new node scripts: `set-android-version.js` (versioning) and a refactored `fix-android-edge-to-edge.js` (post-`cap sync` patching, now surgical and version-free). Five GitHub secrets manage signing + Play upload.

**Tech Stack:** GitHub Actions, Capacitor 8, AGP 8.x + JDK 21 (`@capacitor/geolocation` requires `JavaVersion.VERSION_21`), Gradle, Node 22, Vitest (for script tests), `r0adkll/upload-google-play@v1` action, Play Console Developer API via service account.

**Source spec:** `docs/superpowers/specs/2026-06-08-android-build-pipeline-design.md`

---

## Phase overview

- **Phase 1 — Repo foundation (Bootstrap PR):** Tasks 1–8. Get the repo into a state where Gradle can build, scripts are correct, no CI yet.
- **Phase 2 — Credentials (manual):** Tasks 9–10. Out-of-band setup of secrets and Play Console service account.
- **Phase 3 — CI workflows (Workflow PR):** Tasks 11–12. Add the actual automation.
- **Phase 4 — Verify and ship:** Tasks 13–15. Dry-run, runbook, first real release.

---

## File Structure (what gets created or modified)

**New files:**
- `android/**` — full Capacitor Android Gradle project, scaffolded via `cap add android` then custom files restored. ~50 files.
- `scripts/set-android-version.js` — reads `package.json#version`, computes `versionCode`, patches `android/app/build.gradle`. ~50 lines.
- `scripts/set-android-version.test.js` — Vitest unit tests for the version helper.
- `scripts/fix-android-edge-to-edge.test.js` — Vitest unit tests for the refactored patch script.
- `.github/workflows/android-ci.yml` — PR CI workflow, debug build only.
- `.gitattributes` — preserves `gradlew` exec bit and LF line endings.
- `docs/android-release.md` — runbook for keystore backup, secret rotation, and the "Submit for review" handoff.

**Modified files:**
- `.gitignore` — remove `android/`, add specific build-artifact paths.
- `scripts/fix-android-edge-to-edge.js` — delete `fixVersionCode()`, make `fixMainActivity()` surgical.
- `android/app/build.gradle` — add signing config + hard-fail guard.
- `package.json` — add `scripts/set-android-version.js` invocation to `mobile:sync`, `mobile:android`, `mobile:dev`.
- `vite.config.ts` — extend vitest test `include` to pick up `scripts/**/*.test.js`.
- `.github/workflows/release.yml` — gate desktop build step + add Android matrix entry and steps.

---

# Phase 1 — Repo foundation (Bootstrap PR)

All Phase 1 tasks land on a single feature branch and ship as one PR.

### Task 1: Bootstrap full Android Gradle project

The local checkout has only `android/app/src/main/` (4 tracked Java/manifest files). `cap sync` won't bootstrap missing Gradle files; we need `cap add android` to scaffold, then restore the custom files.

**Files:**
- Create branch and stage: `android/**` (~50 new files after scaffold)
- Preserved: `android/app/src/main/java/com/claw/control/*.java`, `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/android-build-pipeline
```

- [ ] **Step 2: Back up the custom Android source files**

```bash
mkdir -p /tmp/claw-android-backup
cp -r android/app/src/main/java /tmp/claw-android-backup/java
cp android/app/src/main/AndroidManifest.xml /tmp/claw-android-backup/AndroidManifest.xml
ls -la /tmp/claw-android-backup/java/com/claw/control/
```
Expected: 3 files listed — `ConnectionService.java`, `ConnectionServicePlugin.java`, `MainActivity.java`.

- [ ] **Step 3: Delete the partial android/ directory**

```bash
rm -rf android
ls android 2>&1
```
Expected: `ls: android: No such file or directory`.

- [ ] **Step 4: Scaffold the full Android project**

```bash
npm ci
npx vite build --config vite.config.mobile.ts
npx cap add android
ls android/
```
Expected output includes: `app`, `build.gradle`, `gradle`, `gradle.properties`, `gradlew`, `gradlew.bat`, `settings.gradle`.

- [ ] **Step 5: Restore the custom Java files and manifest**

```bash
cp /tmp/claw-android-backup/java/com/claw/control/ConnectionService.java \
   android/app/src/main/java/com/claw/control/
cp /tmp/claw-android-backup/java/com/claw/control/ConnectionServicePlugin.java \
   android/app/src/main/java/com/claw/control/
cp /tmp/claw-android-backup/java/com/claw/control/MainActivity.java \
   android/app/src/main/java/com/claw/control/
cp /tmp/claw-android-backup/AndroidManifest.xml \
   android/app/src/main/AndroidManifest.xml
ls android/app/src/main/java/com/claw/control/
```
Expected: 3 `.java` files.

- [ ] **Step 6: Run the existing edge-to-edge patch script to align scaffold with current customizations**

```bash
node scripts/fix-android-edge-to-edge.js
```
Expected: messages like `*  MainActivity.java already has EdgeToEdge.enable()` (the file we restored), `+  build.gradle patched with androidx.activity dependency`, `+  styles.xml patched with transparent system bar colors`.

- [ ] **Step 6.5: Hand-patch Kotlin Gradle plugin support into the scaffolded root build files**

The in-tree plugin `plugins/capacitor-native-websocket/android/build.gradle` applies `kotlin-android` and contains Kotlin sources (`NativeWebSocketPlugin.kt`, `TLSCertificateStore.kt`). But `cap add android` only scaffolds a Java-only root Gradle config. Without the Kotlin Gradle plugin on the buildscript classpath, `./gradlew assembleDebug` fails with `Plugin with id 'kotlin-android' not found`.

This patching gets automated in Task 3 (it'll be added to the refactored `fix-android-edge-to-edge.js`). For now, hand-patch the two files.

**6.5a — Add `kotlinVersion` to `android/variables.gradle`:**

Edit `android/variables.gradle`, inside the `ext { ... }` block, add a line for `kotlinVersion`. The exact location doesn't matter as long as it's inside `ext`. Example:

```gradle
ext {
    minSdkVersion = 24
    compileSdkVersion = 36
    targetSdkVersion = 36
    kotlinVersion = '1.9.25'
    // ... existing variables unchanged ...
}
```

**6.5b — Add the Kotlin Gradle plugin classpath to `android/build.gradle`:**

Edit `android/build.gradle`. In the `buildscript { dependencies { ... } }` block, add the Kotlin Gradle plugin classpath line alongside the existing AGP classpath:

```gradle
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.13.0'
        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion"
        classpath 'com.google.gms:google-services:4.4.4'
    }
}
```

Note: `$kotlinVersion` resolves at evaluation time because `apply from: "variables.gradle"` brings it into scope. If the AGP version line in your scaffold differs, preserve that — only ADD the kotlin classpath line.

**6.5c — Verify the patches are in place:**

```bash
grep -n kotlinVersion android/variables.gradle android/build.gradle
```
Expected: at least 2 hits — one in `variables.gradle` (the def), one in `build.gradle` (the classpath reference).

- [ ] **Step 7: Verify a debug build succeeds before any further changes**

```bash
cd android && ./gradlew assembleDebug && cd -
ls android/app/build/outputs/apk/debug/
```
Expected: `app-debug.apk` exists. If Gradle fails on JDK version, install temurin-17 first (`brew install --cask temurin@17` on macOS).

- [ ] **Step 8: Commit the scaffolded project (do not yet remove from .gitignore — next task)**

The `android/` directory is still in `.gitignore`, so `git add android/` will be blocked. Use `git add -f` for this commit because we want it staged BEFORE the `.gitignore` change goes in (clean separation in `git log`).

```bash
git add -f android/
git status | head -30
```
Expected: dozens of new files under `android/` staged. **Inspect for accidentally-staged secrets** — confirm no `*.jks`, no `local.properties`, no `*.keystore` in the diff.

```bash
git diff --cached --name-only | grep -E '\.(jks|keystore)$|local\.properties' && echo "STOP: secret detected" || echo "no secrets staged"
```
Expected: `no secrets staged`.

```bash
git commit -m "Bootstrap full android/ Gradle project

Scaffolded via cap add android, then restored the custom Java sources
(MainActivity, ConnectionService, ConnectionServicePlugin) and
AndroidManifest. Edge-to-edge patch script run. Verified ./gradlew
assembleDebug succeeds locally."
```

---

### Task 2: Move android/ out of .gitignore and add targeted build-artifact ignores

The whole `android/` directory was gitignored, but now it's tracked. Replace the blanket ignore with targeted patterns for build artifacts, IDE state, and the keystore file (which is decoded fresh in CI).

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Read the current ignore patterns to know what to replace**

```bash
grep -n "android" .gitignore
```
Expected: a line like `android/` (and possibly `ios/`).

- [ ] **Step 2: Replace the `android/` line with targeted patterns**

Edit `.gitignore`, replace the single line `android/` with the following block (keep `ios/` if present — out of scope for this plan):

```
# Capacitor Android — committed; ignore build artifacts and local-only files only
android/app/build/
android/.gradle/
android/build/
android/local.properties
android/app/release/
android/app/upload-keystore.jks
android/captures/
```

- [ ] **Step 3: Verify the diff**

```bash
git diff .gitignore
```
Expected: `-android/` removed; 7 new lines added with the patterns above.

- [ ] **Step 4: Confirm git now considers `android/` tracked, not ignored**

```bash
git check-ignore android/ android/app/build.gradle android/app/build/ android/app/upload-keystore.jks 2>&1
```
Expected output: only `android/app/build/` and `android/app/upload-keystore.jks` listed as ignored. The other two should produce no output (= not ignored).

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "Replace blanket android/ ignore with targeted build-artifact patterns

android/ is now committed (per build pipeline spec); only build outputs,
IDE state, the decoded keystore, and local.properties stay ignored."
```

---

### Task 3: Refactor `fix-android-edge-to-edge.js` (TDD)

Remove version patching (so `set-android-version.js` can own it) and make `fixMainActivity()` surgical (inject, not replace). This is the script change called out in spec Sections 1.4 and 1.5.

**Files:**
- Create: `scripts/fix-android-edge-to-edge.test.js`
- Modify: `vite.config.ts` (extend vitest include)
- Modify: `scripts/fix-android-edge-to-edge.js`

- [ ] **Step 1: Extend vitest include to pick up scripts tests**

Edit `vite.config.ts`. Find the existing test block:
```ts
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}']
  }
```
Change the `include` line to add scripts:
```ts
    include: [
      'src/**/*.{test,spec}.{js,ts,jsx,tsx}',
      'scripts/**/*.test.{js,ts}'
    ]
```

- [ ] **Step 2: Write the failing tests**

Create `scripts/fix-android-edge-to-edge.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

describe('fix-android-edge-to-edge.js', () => {
  let projectRoot
  let mainActivityPath
  let buildGradlePath
  let stylesPath

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'fix-e2e-test-'))
    mkdirSync(join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'claw', 'control'), { recursive: true })
    mkdirSync(join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'values'), { recursive: true })
    mainActivityPath = join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'claw', 'control', 'MainActivity.java')
    buildGradlePath = join(projectRoot, 'android', 'app', 'build.gradle')
    stylesPath = join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'values', 'styles.xml')
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ version: '2.3.4' }))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  function runScript() {
    const scriptPath = join(process.cwd(), 'scripts', 'fix-android-edge-to-edge.js')
    return execSync(`node ${scriptPath}`, { cwd: projectRoot, encoding: 'utf8' })
  }

  describe('fixMainActivity (surgical injection)', () => {
    it('preserves custom registerPlugin and setupInsetsHandling lines when injecting EdgeToEdge', () => {
      writeFileSync(mainActivityPath, `package com.claw.control;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ConnectionServicePlugin.class);
        super.onCreate(savedInstanceState);
        setupInsetsHandling();
    }

    private void setupInsetsHandling() {
        // ... existing custom code
    }
}
`)
      writeFileSync(buildGradlePath, 'apply plugin: "com.android.application"\ndependencies {\n  implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"\n}\n')
      writeFileSync(stylesPath, '<resources><style name="AppTheme.NoActionBar"><item name="android:background">@null</item></style></resources>')

      runScript()

      const patched = readFileSync(mainActivityPath, 'utf8')
      expect(patched).toContain('EdgeToEdge.enable(this)')
      expect(patched).toContain('import androidx.activity.EdgeToEdge;')
      expect(patched).toContain('registerPlugin(ConnectionServicePlugin.class)')
      expect(patched).toContain('setupInsetsHandling()')
      expect(patched).toContain('private void setupInsetsHandling()')
    })

    it('is idempotent when EdgeToEdge.enable is already present', () => {
      const existing = `package com.claw.control;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ConnectionServicePlugin.class);
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
`
      writeFileSync(mainActivityPath, existing)
      writeFileSync(buildGradlePath, 'dependencies {\n  implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"\n}\n')
      writeFileSync(stylesPath, '<resources><style name="AppTheme.NoActionBar"><item name="android:background">@null</item></style></resources>')

      runScript()

      const after = readFileSync(mainActivityPath, 'utf8')
      expect(after).toBe(existing)
    })

    it('fails loudly when MainActivity.java has no BridgeActivity anchor', () => {
      writeFileSync(mainActivityPath, 'package com.claw.control;\n\npublic class Unrelated {}\n')
      writeFileSync(buildGradlePath, 'dependencies {\n  implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"\n}\n')
      writeFileSync(stylesPath, '<resources><style name="AppTheme.NoActionBar"><item name="android:background">@null</item></style></resources>')

      expect(() => runScript()).toThrow()
    })
  })

  describe('no version patching', () => {
    it('does not modify versionCode or versionName in build.gradle', () => {
      writeFileSync(mainActivityPath, `package com.claw.control;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
`)
      const gradleBefore = `apply plugin: "com.android.application"
android {
    defaultConfig {
        applicationId "com.claw.control"
        versionCode 42
        versionName "9.9.9"
    }
}
dependencies {
  implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"
}
`
      writeFileSync(buildGradlePath, gradleBefore)
      writeFileSync(stylesPath, '<resources><style name="AppTheme.NoActionBar"><item name="android:background">@null</item></style></resources>')

      runScript()

      const gradleAfter = readFileSync(buildGradlePath, 'utf8')
      expect(gradleAfter).toContain('versionCode 42')
      expect(gradleAfter).toContain('versionName "9.9.9"')
      // The androidx.activity injection is still expected:
      expect(gradleAfter).toContain('androidx.activity:activity')
    })
  })
})
```

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
npx vitest run scripts/fix-android-edge-to-edge.test.js
```
Expected: at least one failure in each of the three `describe` blocks (the script still has `fixVersionCode` and still replaces MainActivity wholesale). Note the specific failures so the next step's diff is targeted.

- [ ] **Step 4: Refactor the script**

Edit `scripts/fix-android-edge-to-edge.js`:

**4a.** Replace the entire `fixMainActivity()` function (lines 22–56 currently) with a surgical version:

```js
function fixMainActivity() {
  const filePath = path.join(MAIN_SRC, 'java', 'com', 'claw', 'control', 'MainActivity.java');

  if (!fs.existsSync(filePath)) {
    console.warn('!  MainActivity.java not found, skipping');
    return false;
  }

  const content = fs.readFileSync(filePath, 'utf8');

  if (content.includes('EdgeToEdge.enable')) {
    console.log('*  MainActivity.java already has EdgeToEdge.enable()');
    return true;
  }

  const anchor = 'public class MainActivity extends BridgeActivity';
  if (!content.includes(anchor)) {
    throw new Error(
      'fix-android-edge-to-edge: MainActivity.java does not contain the expected ' +
      '"public class MainActivity extends BridgeActivity" anchor. Refusing to overwrite. ' +
      'Inspect the file and patch manually.'
    );
  }

  // Inject the import (after the last existing import line)
  let patched = content;
  const importBlockMatch = patched.match(/((?:^import .+;\n)+)/m);
  if (importBlockMatch) {
    if (!patched.includes('import androidx.activity.EdgeToEdge;')) {
      patched = patched.replace(
        importBlockMatch[0],
        importBlockMatch[0] + 'import androidx.activity.EdgeToEdge;\n'
      );
    }
  } else {
    throw new Error('fix-android-edge-to-edge: could not locate import block in MainActivity.java');
  }

  // Inject EdgeToEdge.enable(this); inside onCreate, immediately before super.onCreate(...)
  const superCallRegex = /^([ \t]*)super\.onCreate\(savedInstanceState\);/m;
  if (!superCallRegex.test(patched)) {
    throw new Error('fix-android-edge-to-edge: could not locate "super.onCreate(savedInstanceState);" in MainActivity.java');
  }
  patched = patched.replace(superCallRegex, (_match, indent) =>
    `${indent}EdgeToEdge.enable(this);\n${indent}super.onCreate(savedInstanceState);`
  );

  fs.writeFileSync(filePath, patched);
  console.log('+  MainActivity.java patched: EdgeToEdge import + enable() injected');
  return true;
}
```

**4b.** Delete the entire `fixVersionCode()` function (currently lines ~58–81: from the `// Android versionCode` comment through the end of the function and the closing `}`).

**4c.** Update the `results = [...]` array at the bottom — remove `fixVersionCode()`:

```js
const results = [fixMainActivity(), fixBuildGradle(), fixStyles()];
```

**4d.** Update the JSDoc at the top of the file to reflect the new behavior:

```js
/**
 * fix-android-edge-to-edge.js
 *
 * Patches the Android native project after `cap sync` to enable edge-to-edge
 * display and remove deprecated StatusBar APIs that trigger Play Store warnings.
 *
 * What it does:
 * 1. MainActivity.java — Injects EdgeToEdge import and EdgeToEdge.enable(this)
 *    surgically (never replaces the whole file). Fails loudly if anchors missing.
 * 2. build.gradle — Adds androidx.activity dependency for EdgeToEdge class.
 * 3. styles.xml — Sets transparent statusBarColor and navigationBarColor.
 *
 * Versioning is owned by scripts/set-android-version.js; this script no
 * longer touches versionCode or versionName.
 *
 * Run after `cap sync android`.
 */
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npx vitest run scripts/fix-android-edge-to-edge.test.js
```
Expected: all green.

- [ ] **Step 6: Run the script against the real `android/` dir to confirm no regression**

```bash
node scripts/fix-android-edge-to-edge.js
git diff android/
```
Expected: no diff (the real `MainActivity.java` already has `EdgeToEdge.enable`, so the script's idempotent branch fires).

- [ ] **Step 7: Commit**

```bash
git add scripts/fix-android-edge-to-edge.js scripts/fix-android-edge-to-edge.test.js vite.config.ts
git commit -m "Refactor fix-android-edge-to-edge: surgical MainActivity patch, drop versioning

- fixMainActivity now injects EdgeToEdge import + enable() via regex
  instead of replacing the whole file. Preserves registerPlugin and
  setupInsetsHandling custom code if cap regenerates MainActivity.
- Removed fixVersionCode entirely; versioning now belongs to
  scripts/set-android-version.js (next commit).
- Added vitest coverage for the surgical patch and the no-version-patch
  contract."
```

---

### Task 4: Create `scripts/set-android-version.js` (TDD)

This script reads `package.json#version`, computes the Android `versionCode`, and rewrites both `versionCode` and `versionName` in `android/app/build.gradle`.

**Files:**
- Create: `scripts/set-android-version.js`
- Create: `scripts/set-android-version.test.js`

- [ ] **Step 1: Write the failing tests**

Create `scripts/set-android-version.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

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
    return execSync(`node ${scriptPath}`, { cwd: projectRoot, encoding: 'utf8' })
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
    runScript()
    const after = readFileSync(buildGradlePath, 'utf8')
    expect(after).toContain('versionCode 10800')
    expect(after).toContain('versionName "1.8.0"')
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run scripts/set-android-version.test.js
```
Expected: all 8 tests fail with `MODULE_NOT_FOUND` for `scripts/set-android-version.js`.

- [ ] **Step 3: Create the script**

Create `scripts/set-android-version.js`:

```js
#!/usr/bin/env node
/**
 * set-android-version.js
 *
 * Reads package.json#version and patches android/app/build.gradle so:
 *   - versionName matches package.json verbatim (e.g. "1.8.0" or "1.9.0-beta.1")
 *   - versionCode is computed as major*10000 + minor*100 + patch
 *     (e.g. "1.8.0" -> 10800, "2.3.4" -> 20304)
 *
 * The scheme allows 9 major versions, 99 minor per major, 99 patch per minor.
 * Bump the constants below if you ever need to grow past that.
 *
 * Run before `cap sync android` so the post-sync patch script doesn't see
 * stale values.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.cwd();
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');
const BUILD_GRADLE = path.join(PROJECT_ROOT, 'android', 'app', 'build.gradle');

const MAJOR_MAX = 9;   // versionCode formula = major*10000 + minor*100 + patch
const MINOR_MAX = 99;
const PATCH_MAX = 99;

function computeVersionCode(versionName) {
  // Strip pre-release suffix (e.g. "1.9.0-beta.1" -> "1.9.0") for numeric computation.
  const numeric = versionName.split('-')[0];
  const parts = numeric.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`set-android-version: cannot parse semver from "${versionName}"`);
  }
  const [major, minor, patch] = parts;
  if (major > MAJOR_MAX) {
    throw new Error(`set-android-version: major version ${major} exceeds max ${MAJOR_MAX}; widen the scheme in this script`);
  }
  if (minor > MINOR_MAX) {
    throw new Error(`set-android-version: minor version ${minor} exceeds max ${MINOR_MAX}; widen the scheme in this script`);
  }
  if (patch > PATCH_MAX) {
    throw new Error(`set-android-version: patch version ${patch} exceeds max ${PATCH_MAX}; widen the scheme in this script`);
  }
  return major * 10000 + minor * 100 + patch;
}

function main() {
  if (!fs.existsSync(PACKAGE_JSON)) {
    throw new Error(`set-android-version: package.json not found at ${PACKAGE_JSON}`);
  }
  if (!fs.existsSync(BUILD_GRADLE)) {
    throw new Error(`set-android-version: build.gradle not found at ${BUILD_GRADLE}`);
  }

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const versionName = pkg.version;
  const versionCode = computeVersionCode(versionName);

  let content = fs.readFileSync(BUILD_GRADLE, 'utf8');

  // Both replacements must hit; if either anchor is missing, fail loudly.
  if (!/versionCode\s+\d+/.test(content)) {
    throw new Error('set-android-version: could not find "versionCode <N>" in android/app/build.gradle');
  }
  if (!/versionName\s+"[^"]*"/.test(content)) {
    throw new Error('set-android-version: could not find "versionName \\"...\\"" in android/app/build.gradle');
  }

  content = content.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
  content = content.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);

  fs.writeFileSync(BUILD_GRADLE, content);
  console.log(`set-android-version: versionCode=${versionCode}, versionName="${versionName}"`);
}

main();
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run scripts/set-android-version.test.js
```
Expected: all 8 tests green.

- [ ] **Step 5: Run the script against the real repo and check the diff**

```bash
node scripts/set-android-version.js
git diff android/app/build.gradle
```
Expected: the existing `versionCode 7` (left over from `fix-android-edge-to-edge.js`'s old behavior) becomes `versionCode 10800`; `versionName` is set to whatever `package.json` carries (`1.8.0` at time of writing).

- [ ] **Step 6: Commit**

```bash
git add scripts/set-android-version.js scripts/set-android-version.test.js android/app/build.gradle
git commit -m "Add scripts/set-android-version.js with vitest coverage

Computes Android versionCode from package.json#version as
major*10000 + minor*100 + patch (1.8.0 -> 10800). Fails loudly on
out-of-range versions, missing files, or missing build.gradle anchors.

Runs before cap sync; fix-android-edge-to-edge no longer touches version."
```

---

### Task 5: Wire `set-android-version.js` into npm mobile scripts

The CI workflow will invoke the script as a standalone step, but the local `npm run mobile:sync`/`mobile:android` flows should also pick up version drift so the committed `build.gradle` stays in sync with `package.json`.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Read current mobile scripts in package.json**

```bash
grep -n '"mobile:' package.json
```
Note the exact strings for `mobile:sync`, `mobile:android`, `mobile:ios`.

- [ ] **Step 2: Prepend the version script to each mobile sync/build flow**

Edit `package.json`. For each of `mobile:sync`, `mobile:android` (NOT `mobile:dev` — that's a pure web preview), prepend `node scripts/set-android-version.js && `:

Before:
```json
"mobile:sync": "npx vite build --config vite.config.mobile.ts && npx cap sync && npx @capacitor/assets generate --android --splashBackgroundColor \"#06080a\" --iconBackgroundColor \"#06080a\" && node scripts/fix-android-edge-to-edge.js",
"mobile:android": "npx vite build --config vite.config.mobile.ts && npx cap sync android && npx @capacitor/assets generate --android --splashBackgroundColor \"#06080a\" --iconBackgroundColor \"#06080a\" && node scripts/fix-android-edge-to-edge.js && npx cap open android",
```

After:
```json
"mobile:sync": "node scripts/set-android-version.js && npx vite build --config vite.config.mobile.ts && npx cap sync && npx @capacitor/assets generate --android --splashBackgroundColor \"#06080a\" --iconBackgroundColor \"#06080a\" && node scripts/fix-android-edge-to-edge.js",
"mobile:android": "node scripts/set-android-version.js && npx vite build --config vite.config.mobile.ts && npx cap sync android && npx @capacitor/assets generate --android --splashBackgroundColor \"#06080a\" --iconBackgroundColor \"#06080a\" && node scripts/fix-android-edge-to-edge.js && npx cap open android",
```

(Leave `mobile:ios` alone — different sync flow, doesn't need Android versioning.)

- [ ] **Step 3: Verify the diff is minimal and correct**

```bash
git diff package.json
```
Expected: two lines changed, each gaining `node scripts/set-android-version.js && ` at the front of the script value.

- [ ] **Step 4: Smoke-test by running mobile:sync**

```bash
npm run mobile:sync
```
Expected: the first command in the chain is the version script (`set-android-version: versionCode=10800, versionName="1.8.0"`), followed by vite build, cap sync, asset generation, and the edge-to-edge patch. Should exit 0.

- [ ] **Step 5: Confirm no `build.gradle` drift after the run**

```bash
git diff android/app/build.gradle
```
Expected: no diff (or only whitespace from the script setting the values it already set).

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "Wire set-android-version.js into mobile:sync and mobile:android

Ensures local dev flows pick up package.json version drift before
running cap sync (so the committed build.gradle stays consistent)."
```

---

### Task 6: Add Gradle signing config to `android/app/build.gradle`

Add the signing block from spec Section 1.2 — keystore-file-existence-driven, with a hard-fail task graph check.

**Files:**
- Modify: `android/app/build.gradle`

- [ ] **Step 1: Open `android/app/build.gradle` and locate the existing `android { ... }` block**

```bash
grep -n "android {" android/app/build.gradle
grep -n "signingConfigs\|buildTypes" android/app/build.gradle
```
Note line numbers. Capacitor's scaffold typically has a `buildTypes { release { ... } }` block but no `signingConfigs`.

- [ ] **Step 2: Add the `releaseKeystore` def at the top of the file (above `apply plugin:`)**

Insert at line 1:
```gradle
def releaseKeystore = file("upload-keystore.jks")

```

- [ ] **Step 3: Add the `signingConfigs` block inside the existing `android { ... }` block**

Inside the `android { ... }` block (after `compileSdk`/`defaultConfig`, before `buildTypes`), add:

```gradle
    signingConfigs {
        release {
            if (releaseKeystore.exists()) {
                storeFile releaseKeystore
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
                keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: ""
                keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: ""
            }
        }
    }
```

- [ ] **Step 4: Update the existing `buildTypes.release` block to use the signing config conditionally**

Find:
```gradle
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
```
(The exact existing body may vary; preserve whatever Capacitor scaffolded.)

Modify to:
```gradle
    buildTypes {
        release {
            if (releaseKeystore.exists()) {
                signingConfig signingConfigs.release
            }
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
```

- [ ] **Step 5: Add the task-graph hard-fail check at the end of the file**

Append to `android/app/build.gradle`:

```gradle

// Hard-fail if a release build is requested without the keystore present.
// Prevents CI silently producing unsigned APKs/AABs when the decode step is missing.
gradle.taskGraph.whenReady { graph ->
    def needsRelease = graph.allTasks.any { t ->
        t.name in ["assembleRelease", "bundleRelease", "packageRelease"]
    }
    if (needsRelease && !releaseKeystore.exists()) {
        throw new GradleException(
            "Release build requested but android/app/upload-keystore.jks is missing. " +
            "CI must decode ANDROID_KEYSTORE_BASE64 before invoking Gradle."
        )
    }
}
```

- [ ] **Step 6: Verify `assembleDebug` still works (no keystore needed)**

```bash
cd android && ./gradlew assembleDebug && cd -
```
Expected: build succeeds; produces `android/app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 7: Verify the hard-fail fires when `assembleRelease` runs without a keystore**

```bash
cd android && ./gradlew assembleRelease 2>&1 | tail -20; cd -
```
Expected: build fails with `GradleException` mentioning `upload-keystore.jks is missing`. **Exit code is non-zero.**

- [ ] **Step 8: Verify `assembleRelease` succeeds with a throwaway test keystore**

```bash
keytool -genkey -v \
  -keystore android/app/upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 365 \
  -alias test-only \
  -storepass testpass -keypass testpass \
  -dname "CN=Test, OU=Test, O=Test, L=Test, S=Test, C=US"
ANDROID_KEYSTORE_PASSWORD=testpass ANDROID_KEY_ALIAS=test-only ANDROID_KEY_PASSWORD=testpass \
  bash -c 'cd android && ./gradlew assembleRelease' 2>&1 | tail -10
```
Expected: BUILD SUCCESSFUL. APK at `android/app/build/outputs/apk/release/app-release.apk`.

- [ ] **Step 9: DELETE the throwaway keystore before committing — confirm it's gitignored**

```bash
rm android/app/upload-keystore.jks
git status android/app/upload-keystore.jks
```
Expected: no output (file ignored AND removed; `git status` shouldn't mention it).

- [ ] **Step 10: Commit**

```bash
git add android/app/build.gradle
git diff --cached --name-only | grep -E '\.(jks|keystore)$' && echo "STOP: keystore staged" || echo "no keystore staged"
git commit -m "Add Gradle signing config + task-graph hard-fail guard

build.gradle now keys signing off keystore file existence (so Gradle
subprocess doesn't depend on env-var inheritance). gradle.taskGraph
hard-fails if assembleRelease/bundleRelease/packageRelease is invoked
without android/app/upload-keystore.jks present, preventing silent
unsigned-build accidents in CI."
```

---

### Task 7: Add `.gitattributes` and verify `gradlew` executable bit

CI runs on Linux; `gradlew` needs the exec bit preserved across checkout.

**Files:**
- Create: `.gitattributes`

- [ ] **Step 1: Create `.gitattributes`**

```
android/gradlew text eol=lf
```

- [ ] **Step 2: Verify gradlew is currently executable in git's index**

```bash
git ls-files --stage android/gradlew
```
Expected: mode `100755` in the first column. If it shows `100644`, run:

```bash
git update-index --chmod=+x android/gradlew
git ls-files --stage android/gradlew
```
Re-check: now `100755`.

- [ ] **Step 3: Commit**

```bash
git add .gitattributes android/gradlew
git commit -m "Add .gitattributes for gradlew exec bit and LF line endings"
```

---

### Task 8: Open the bootstrap PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/android-build-pipeline
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "Bootstrap Android build foundation" --body "$(cat <<'EOF'
## Summary

Phase 1 of the Android build pipeline (per [spec](docs/superpowers/specs/2026-06-08-android-build-pipeline-design.md)). No CI changes in this PR — just the repo state CI will eventually depend on.

- Commits the full `android/` Gradle project (was previously gitignored).
- Refactors `scripts/fix-android-edge-to-edge.js`: surgical MainActivity patch (preserves `registerPlugin` + `setupInsetsHandling`); drops version patching.
- Adds `scripts/set-android-version.js` (versionCode = major*10000 + minor*100 + patch) with vitest coverage.
- Adds Gradle signing config with a task-graph hard-fail if `assembleRelease`/`bundleRelease` is invoked without `upload-keystore.jks`.
- Wires `set-android-version.js` into `npm run mobile:sync` and `mobile:android`.
- Adds `.gitattributes` to preserve `gradlew` exec bit.

Workflow YAML lands in a follow-up PR.

## Test plan

- [ ] `npm test -- scripts/set-android-version.test.js scripts/fix-android-edge-to-edge.test.js` — both green
- [ ] `cd android && ./gradlew assembleDebug` succeeds locally
- [ ] `cd android && ./gradlew assembleRelease` fails with the expected `upload-keystore.jks is missing` GradleException
- [ ] `npm run mobile:sync` is a no-op on `build.gradle` (versionCode/Name already current)
- [ ] `git ls-files --stage android/gradlew` shows mode `100755`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Confirm Phase 1 acceptance before moving to Phase 2**

Re-run all verifications above. If anything fails, fix it on the branch before proceeding.

---

# Phase 2 — Credentials (manual)

These tasks have **no code changes**; they configure GitHub secrets and Play Console. Do them while the bootstrap PR is in review or after it merges.

### Task 9: Generate or locate the upload keystore + populate GitHub secrets

**Files:** none (out-of-band action)

- [ ] **Step 1: Check whether an upload keystore already exists**

If you have an existing `upload-keystore.jks` for Play uploads (from prior manual uploads), use it. Otherwise generate a new one — but **only do this if you have NOT already published with a different upload key**, since rotating the upload key requires Play Console "App integrity → Reset upload key" approval.

If generating new:
```bash
keytool -genkey -v -keystore ~/Documents/clawcontrol-upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias clawcontrol-upload
```
Pick a strong passphrase; record it in 1Password (or your password manager) under "ClawControl Android upload keystore."

- [ ] **Step 2: Back up the keystore to an encrypted location OUTSIDE this repo**

Copy `~/Documents/clawcontrol-upload-keystore.jks` to 1Password as a Document attachment (or equivalent). **Losing this file = locked out of Play updates permanently.**

- [ ] **Step 3: Encode the keystore to base64 and copy to clipboard**

```bash
base64 -i ~/Documents/clawcontrol-upload-keystore.jks | pbcopy
```
(On Linux: `base64 -w 0 ~/Documents/clawcontrol-upload-keystore.jks | xclip -selection clipboard`.)

- [ ] **Step 4: Populate the 4 keystore-related GitHub repo secrets**

In the GitHub UI: **Settings → Secrets and variables → Actions → New repository secret**. Or via CLI:

```bash
# Replace TEST values with your actual passphrases
gh secret set ANDROID_KEYSTORE_BASE64 < <(base64 -i ~/Documents/clawcontrol-upload-keystore.jks)
gh secret set ANDROID_KEYSTORE_PASSWORD --body "your-keystore-passphrase"
gh secret set ANDROID_KEY_ALIAS --body "clawcontrol-upload"
gh secret set ANDROID_KEY_PASSWORD --body "your-key-passphrase"
```

- [ ] **Step 5: Verify all 4 secrets exist**

```bash
gh secret list | grep ANDROID_
```
Expected: 4 lines — `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

---

### Task 10: Set up Play Console service account + populate `PLAY_SERVICE_ACCOUNT_JSON`

**Files:** none (out-of-band action)

- [ ] **Step 1: Create a Play Console service account**

1. Play Console → **Setup → API access**.
2. If no GCP project is linked, link or create one.
3. Click **"Create new service account"** → walk through to GCP IAM → create a service account named `clawcontrol-ci-uploader`.
4. In GCP IAM, on the new service account → **Keys → Add key → JSON**. Download.

- [ ] **Step 2: Grant the service account "Release manager" on `com.claw.control`**

Back in Play Console → API access → find the new service account → **Grant access** → select app `com.claw.control` → set role to **"Release manager"** → save.

- [ ] **Step 3: Add the JSON as a GitHub secret**

```bash
gh secret set PLAY_SERVICE_ACCOUNT_JSON < ~/Downloads/clawcontrol-ci-uploader-xxxxxx.json
```

- [ ] **Step 4: Verify**

```bash
gh secret list | grep PLAY_SERVICE_ACCOUNT_JSON
```
Expected: one line.

- [ ] **Step 5: Delete the downloaded JSON from disk**

```bash
rm ~/Downloads/clawcontrol-ci-uploader-*.json
```

---

# Phase 3 — CI workflows (Workflow PR)

After Phase 1 has merged AND Phase 2 secrets are populated. Start a new branch.

### Task 11: Extend `release.yml` with Android matrix + steps

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflow branch off updated main**

```bash
git checkout main && git pull origin main
git checkout -b feat/android-ci-workflows
```

- [ ] **Step 2: Read the current `release.yml`**

```bash
cat .github/workflows/release.yml
```

- [ ] **Step 3: Edit `release.yml` — full updated file**

Replace the entire contents of `.github/workflows/release.yml` with:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      tag:
        description: 'Existing release tag to build for (e.g. v1.8.0)'
        required: true
        type: string

permissions:
  contents: write

jobs:
  build:
    name: Build ${{ matrix.platform }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            platform: mac
            artifacts: |
              release/*.dmg
              release/*-mac.zip
          - os: windows-latest
            platform: win
            artifacts: |
              release/*.exe
              release/*.exe.blockmap
          - os: ubuntu-latest
            platform: linux
            artifacts: |
              release/*.AppImage
              release/*.deb
          - os: ubuntu-latest
            platform: android
            artifacts: |
              android/app/build/outputs/apk/release/ClawControl-*.apk

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ inputs.tag || github.ref }}

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      # ---------- Desktop build (mac / win / linux only) ----------
      - name: Build (${{ matrix.platform }})
        if: matrix.platform != 'android'
        run: npm run build:${{ matrix.platform }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      # ---------- Android build (android only) ----------
      - name: Setup JDK 21
        if: matrix.platform == 'android'
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'

      - name: Setup Android SDK
        if: matrix.platform == 'android'
        uses: android-actions/setup-android@v3

      - name: Setup Gradle
        if: matrix.platform == 'android'
        uses: gradle/actions/setup-gradle@v3

      - name: Decode keystore
        if: matrix.platform == 'android'
        env:
          KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
        run: |
          echo "$KEYSTORE_BASE64" | base64 -d > android/app/upload-keystore.jks
          test -s android/app/upload-keystore.jks || { echo "Keystore decode produced empty file"; exit 1; }

      - name: Sync Android version from package.json
        if: matrix.platform == 'android'
        run: node scripts/set-android-version.js

      - name: Build web + cap sync + edge-to-edge patch
        if: matrix.platform == 'android'
        run: npm run mobile:sync

      - name: Build release APK
        if: matrix.platform == 'android'
        env:
          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: cd android && ./gradlew assembleRelease

      - name: Build release AAB
        if: matrix.platform == 'android'
        env:
          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: cd android && ./gradlew bundleRelease

      - name: Rename APK to include version
        if: matrix.platform == 'android'
        run: |
          VERSION=$(node -p "require('./package.json').version")
          mv android/app/build/outputs/apk/release/app-release.apk \
             android/app/build/outputs/apk/release/ClawControl-${VERSION}.apk
          ls -la android/app/build/outputs/apk/release/

      # ---------- Attach artifacts to GitHub Release (all platforms) ----------
      - name: Upload to release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ inputs.tag || github.ref_name }}
          files: ${{ matrix.artifacts }}
          fail_on_unmatched_files: false

      # ---------- Play Console upload (android only, after GitHub Release attach) ----------
      - name: Upload AAB to Play Console
        id: play_upload
        if: matrix.platform == 'android'
        continue-on-error: true
        uses: r0adkll/upload-google-play@v1
        with:
          serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
          packageName: com.claw.control
          releaseFiles: android/app/build/outputs/bundle/release/app-release.aab
          track: production
          status: draft

      - name: AAB fallback artifact (on Play upload failure)
        if: matrix.platform == 'android' && steps.play_upload.outcome == 'failure'
        uses: actions/upload-artifact@v4
        with:
          name: aab-fallback-${{ github.ref_name }}
          path: android/app/build/outputs/bundle/release/app-release.aab
          retention-days: 14

      - name: Fail job if Play upload failed
        if: matrix.platform == 'android' && steps.play_upload.outcome == 'failure'
        run: |
          echo "::error::Play Console upload failed. AAB attached as workflow artifact 'aab-fallback-${{ github.ref_name }}' for manual upload."
          exit 1
```

- [ ] **Step 4: Verify the YAML parses**

```bash
npx yaml --version 2>/dev/null || npm install -g yaml-cli  # optional; use any YAML linter
# Or use python:
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo OK
```
Expected: `OK` (or no error from your linter of choice).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "Extend release.yml: Android matrix entry + APK/AAB build + Play upload

- Adds android matrix entry alongside mac/win/linux.
- Gates the existing desktop build step with if: matrix.platform != 'android'.
- Adds JDK 21 + Android SDK + Gradle cache setup.
- Decodes the keystore from ANDROID_KEYSTORE_BASE64 secret.
- Runs set-android-version.js before mobile:sync so versionCode is correct.
- Builds release APK + AAB.
- Renames APK to ClawControl-X.Y.Z.apk before the existing
  softprops/action-gh-release@v2 step picks it up.
- Uploads AAB to Play Console production track as draft via
  r0adkll/upload-google-play@v1. continue-on-error so a Play hiccup
  doesn't strand the APK; explicit fail-job step keeps run status
  honest; AAB attached to workflow run as fallback artifact."
```

---

### Task 12: Create `.github/workflows/android-ci.yml` (PR check)

**Files:**
- Create: `.github/workflows/android-ci.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: Android CI

on:
  pull_request:
    paths:
      - 'android/**'
      - 'capacitor.config.ts'
      - 'vite.config.mobile.ts'
      - 'scripts/fix-android-edge-to-edge.js'
      - 'scripts/set-android-version.js'
      - 'package.json'
      - 'package-lock.json'
      - 'src/**'
      - 'plugins/capacitor-native-websocket/**'
      - '.github/workflows/android-ci.yml'
  workflow_dispatch:

concurrency:
  group: android-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  debug-build:
    name: Build debug APK
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Setup JDK 21
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3

      - name: Setup Gradle
        uses: gradle/actions/setup-gradle@v3

      - name: Install dependencies
        run: npm ci

      - name: Sync Android version from package.json
        run: node scripts/set-android-version.js

      - name: Build web + cap sync + edge-to-edge patch
        run: npm run mobile:sync

      - name: Build debug APK
        run: cd android && ./gradlew assembleDebug

      - name: Upload debug APK as artifact
        uses: actions/upload-artifact@v4
        with:
          name: app-debug-${{ github.event.pull_request.number || github.run_id }}.apk
          path: android/app/build/outputs/apk/debug/app-debug.apk
          retention-days: 7
```

- [ ] **Step 2: Verify the YAML parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/android-ci.yml'))" && echo OK
```
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/android-ci.yml
git commit -m "Add android-ci.yml: PR check that compiles assembleDebug

Triggers on PRs touching android-relevant paths. No secrets exposed
(debug build only, fork-safe). Uploads app-debug.apk as a 7-day
workflow artifact for manual smoke-testing from the PR."
```

- [ ] **Step 4: Push and open the workflow PR**

```bash
git push -u origin feat/android-ci-workflows
gh pr create --title "Add Android release matrix + PR CI workflow" --body "$(cat <<'EOF'
## Summary

Phase 3 of the Android build pipeline (per [spec](docs/superpowers/specs/2026-06-08-android-build-pipeline-design.md)).

- Extends `.github/workflows/release.yml` with an `android` matrix entry that builds a signed APK (attached to the GitHub Release) and a signed AAB (uploaded as a production-track draft to Play Console). Existing mac/win/linux jobs unchanged in behavior — only the build step gains an `if: matrix.platform != 'android'` guard.
- Adds `.github/workflows/android-ci.yml`: a fork-safe PR check that compiles `assembleDebug` and uploads the APK as a workflow artifact.

Requires Phase 2 secrets to be populated before tagging a release: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `PLAY_SERVICE_ACCOUNT_JSON`.

## Test plan

- [ ] `android-ci.yml` runs on this PR (it modifies `.github/workflows/android-ci.yml`, a triggering path)
- [ ] The PR's Android CI job builds `app-debug.apk` and uploads it as a workflow artifact
- [ ] After merge, trigger `release.yml` via `workflow_dispatch` against an existing tag (e.g. `v1.8.0`) for a dry-run — see Phase 4 of the implementation plan

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Confirm `android-ci.yml` runs on the workflow PR itself**

Wait for CI on the PR. The Android CI job should succeed and surface a downloadable `app-debug-<PR#>.apk` artifact. If it fails, fix on the branch before merging.

---

# Phase 4 — Verify and ship

### Task 13: Dry-run the release workflow against an existing tag

**Files:** none (operational verification)

- [ ] **Step 1: Wait for the workflow PR (Task 12) to merge to main**

- [ ] **Step 2: Trigger release.yml via workflow_dispatch against `v1.8.0`**

```bash
gh workflow run release.yml --ref main -f tag=v1.8.0
```

- [ ] **Step 3: Watch the run**

```bash
gh run list --workflow=release.yml --limit 1
gh run watch
```
Expected: 4 parallel matrix jobs (`mac`, `win`, `linux`, `android`). All four should reach the `Upload to release` step.

- [ ] **Step 4: Verify the GitHub Release got the APK attached**

```bash
gh release view v1.8.0 --json assets --jq '.assets[].name'
```
Expected: list includes `ClawControl-1.8.0.apk` (alongside the existing `.dmg`, `.exe`, `.AppImage`/`.deb`).

- [ ] **Step 5: Verify Play Console has a new production-track draft**

Go to Play Console → `com.claw.control` → **Production**. Expected: a new draft release with `versionCode 10800` and `versionName 1.8.0`, status "Draft". Do NOT click "Submit for review" — this is a dry-run.

- [ ] **Step 6: Delete the Play Console draft to clean up**

In Play Console → Production → the new draft → **Discard release**. Confirms our manual gate works.

- [ ] **Step 7: If the dry-run failed at the Play upload step, verify the AAB fallback artifact exists**

```bash
gh run view --log | tail -50
gh run download --name "aab-fallback-v1.8.0"
```
Diagnose and fix the Play side (service account permissions, package name typo, etc.) before any real tag push.

---

### Task 14: Write the release runbook

**Files:**
- Create: `docs/android-release.md`

- [ ] **Step 1: Create the runbook**

```markdown
# Android Release Runbook

## Cutting a release

1. Bump `package.json#version` to the new semver (e.g. `1.8.0` → `1.8.1`).
2. Commit: `git commit -am "Bump to vX.Y.Z"`.
3. Tag and push: `git tag vX.Y.Z && git push origin main --tags`.
4. `release.yml` runs automatically. ~10–15 min for all four matrix jobs.
5. GitHub Release auto-publishes with all desktop artifacts + `ClawControl-X.Y.Z.apk`.
6. Play Console → `com.claw.control` → **Production**: a new draft release will exist with `versionCode = major*10000 + minor*100 + patch` and `versionName = X.Y.Z`.
7. Review the draft. Add release notes. Click **"Submit for review"** when ready to ship.

## Re-running a release for an existing tag

```bash
gh workflow run release.yml --ref main -f tag=vX.Y.Z
```

## Secrets and where they live

| Secret | What it is | Where the source-of-truth lives |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of `upload-keystore.jks` | 1Password → "ClawControl Android upload keystore" (file attachment) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore passphrase | 1Password → same entry |
| `ANDROID_KEY_ALIAS` | `clawcontrol-upload` | This runbook |
| `ANDROID_KEY_PASSWORD` | Key passphrase | 1Password → same entry |
| `PLAY_SERVICE_ACCOUNT_JSON` | Service account JSON for Play Developer API | GCP → IAM → service account `clawcontrol-ci-uploader` (re-download from GCP if lost) |

## Rotating the upload key

**Only do this if you have to** — every rotation requires a Play Console "App integrity → Reset upload key" approval (Google reviews each request).

1. Generate new keystore: `keytool -genkey -v -keystore new-upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias clawcontrol-upload`.
2. Play Console → **App integrity → Upload key certificate → Request upload key reset**. Upload the PEM (`keytool -export -rfc -keystore new-upload-keystore.jks -alias clawcontrol-upload -file new-upload-cert.pem`).
3. Wait for Google approval (usually <48h).
4. Once approved, replace the secrets:
   ```bash
   base64 -i new-upload-keystore.jks | gh secret set ANDROID_KEYSTORE_BASE64
   gh secret set ANDROID_KEYSTORE_PASSWORD --body "new-passphrase"
   gh secret set ANDROID_KEY_PASSWORD --body "new-passphrase"
   ```
5. Back up `new-upload-keystore.jks` to 1Password.
6. Delete the old keystore from 1Password only AFTER the next release succeeds.

## Sideload-from-GitHub-Releases vs Play install

The GitHub Release APK is signed with our upload key. Play delivers installs signed with Google's app signing key (Play App Signing). These have **different fingerprints**, so:

- A user on Play cannot sideload an updated APK over their existing install (signature mismatch error).
- A user on sideload cannot get a Play update over their existing install — they must uninstall first.

This is normal Android behavior. Communicate it in release notes when sideload is relevant.

## What to do if the Play upload step fails

The workflow continues even if Play upload fails — the AAB is uploaded as a workflow artifact named `aab-fallback-<tag>`. To recover:

1. Download: `gh run download --name aab-fallback-vX.Y.Z`
2. Diagnose: read the workflow log step `Upload AAB to Play Console`. Common causes:
   - Service account lost its "Release manager" grant on `com.claw.control` (re-grant in Play Console).
   - `versionCode` collision with an existing Play Console release (bump `package.json` and re-tag).
   - Play API outage (rare; check https://status.play.google).
3. Manual upload via Play Console UI as a workaround.

## Bootstrap order for a fresh clone

If `android/gradlew` is missing exec bit on a fresh clone (rare; should be preserved by `.gitattributes`), run:
```bash
chmod +x android/gradlew
```
Verify: `git ls-files --stage android/gradlew` shows mode `100755`.
```

- [ ] **Step 2: Commit on a small docs PR**

```bash
git checkout main && git pull
git checkout -b docs/android-release-runbook
git add docs/android-release.md
git commit -m "Add Android release runbook"
git push -u origin docs/android-release-runbook
gh pr create --title "Add Android release runbook" --body "Operational doc for cutting Android releases, rotating the upload key, and recovering from a failed Play upload."
```

---

### Task 15: First real release

**Files:** `package.json` (version bump)

- [ ] **Step 1: Confirm Phase 2 secrets are populated AND Tasks 11–13 are merged + verified**

```bash
gh secret list | grep -E "ANDROID_|PLAY_SERVICE"
```
Expected: 5 secrets listed.

- [ ] **Step 2: Bump `package.json#version`**

```bash
# E.g. for a patch release after 1.8.0:
npm version patch --no-git-tag-version
# Or set explicitly:
npm version 1.8.1 --no-git-tag-version
```

- [ ] **Step 3: Commit the version bump**

```bash
git add package.json package-lock.json
git commit -m "Bump to v1.8.1"
git push origin main
```

- [ ] **Step 4: Tag and push**

```bash
git tag v1.8.1
git push origin v1.8.1
```

- [ ] **Step 5: Watch the release run**

```bash
gh run list --workflow=release.yml --limit 1
gh run watch
```

- [ ] **Step 6: After all matrix jobs succeed, verify the artifacts**

```bash
gh release view v1.8.1 --json assets --jq '.assets[].name'
```
Expected: includes `ClawControl-1.8.1.apk` plus desktop artifacts.

- [ ] **Step 7: Play Console verification**

Play Console → `com.claw.control` → Production → confirm draft with `versionCode 10801` and `versionName 1.8.1`. Add release notes. Click **"Submit for review"** when ready.

---

## Acceptance criteria recap (from spec Section 6)

- [ ] Pushing tag `v1.8.1` produces a successful workflow run with all four matrix jobs green.
- [ ] GitHub Release `v1.8.1` shows: `.dmg`, `.exe`, `.AppImage`/`.deb`, and `ClawControl-1.8.1.apk`.
- [ ] Play Console → `com.claw.control` → Production track shows a new draft release with `versionCode 10801` and `versionName 1.8.1`.
- [ ] Opening a PR that modifies `src/App.tsx` triggers `android-ci.yml`, which uploads a downloadable `app-debug.apk` artifact.
- [ ] Opening a PR that modifies an unrelated path (e.g. `README.md`) does NOT trigger `android-ci.yml`.
- [ ] Local `npm run mobile:android` continues to work unchanged (no keystore needed locally).
- [ ] A simulated Play upload failure (revoke service account temporarily) results in the AAB attached as a CI artifact, not silent loss.
