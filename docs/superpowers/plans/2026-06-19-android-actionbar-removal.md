# Android ActionBar Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Android from creating the native “ClawControl” ActionBar while preserving the launch splash, edge-to-edge layout, safe-area handling, and Capacitor web UI.

**Architecture:** Declare the launch activity theme itself as titleless so AppCompat sees the no-ActionBar contract before `super.onCreate()` constructs the decor. Cover the behavior with an instrumentation test that launches the real `MainActivity`, then verify the installed app through Android’s live UI hierarchy.

**Tech Stack:** Android XML themes, AppCompat, Capacitor `BridgeActivity`, AndroidX Test/JUnit4, Gradle, ADB/UIAutomator

## Global Constraints

- Preserve `Theme.SplashScreen` as the parent of `AppTheme.NoActionBarLaunch`.
- Preserve the `postSplashScreenTheme` handoff to `AppTheme.NoActionBar`.
- Do not change `MainActivity`, the React/Capacitor UI, edge-to-edge handling, or safe-area handling for this fix.
- Preserve all pre-existing uncommitted worktree changes.
- The final live hierarchy must contain the Capacitor WebView and no native ActionBar.
- Run Gradle with `JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.11/libexec/openjdk.jdk/Contents/Home` because the project targets Java 21.

---

## File Structure

- Create `android/app/src/androidTest/java/com/claw/control/MainActivityActionBarTest.java` to provide focused regression coverage for the real activity theme/decor behavior.
- Modify `android/app/src/main/res/values/styles.xml` only within `AppTheme.NoActionBarLaunch` to declare that launch theme titleless.

### Task 1: Prevent ActionBar Creation During Activity Launch

**Files:**
- Create: `android/app/src/androidTest/java/com/claw/control/MainActivityActionBarTest.java`
- Modify: `android/app/src/main/res/values/styles.xml:39-48`

**Interfaces:**
- Consumes: `MainActivity extends BridgeActivity`, its activity decor, and the runtime framework resource named `android:id/action_bar`.
- Produces: `AppTheme.NoActionBarLaunch` with `android:windowActionBar=false` and `android:windowNoTitle=true`; no new runtime API.

- [ ] **Step 1: Write the failing instrumentation test**

Create `android/app/src/androidTest/java/com/claw/control/MainActivityActionBarTest.java`:

```java
package com.claw.control;

import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class MainActivityActionBarTest {

    @Test
    public void launchDoesNotInflateNativeActionBar() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                int actionBarId = activity.getResources()
                    .getIdentifier("action_bar", "id", "android");
                assertNotEquals(
                    "Framework action_bar resource must resolve",
                    0,
                    actionBarId
                );
                assertNull(
                    "MainActivity must not inflate a native ActionBar view",
                    activity.findViewById(actionBarId)
                );
            });
        }
    }
}
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run from the repository root:

```bash
cd android
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.claw.control.MainActivityActionBarTest
```

Expected: the framework resource resolves to a nonzero ID, then the test FAILS because `findViewById(actionBarId)` returns the currently-inflated native `android.widget.Toolbar`, not `null`.

- [ ] **Step 3: Make the launch theme explicitly titleless**

In `android/app/src/main/res/values/styles.xml`, add only the following two items immediately inside `AppTheme.NoActionBarLaunch`, before its existing splash attributes:

```xml
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:windowActionBar">false</item>
        <item name="android:windowNoTitle">true</item>
        <!-- Preserve every existing splash/background item below. -->
    </style>
```

Do not replace or reorder the existing `windowSplashScreenBackground`, `postSplashScreenTheme`, `android:windowBackground`, or `android:background` items.

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run:

```bash
cd android
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.claw.control.MainActivityActionBarTest
```

Expected: `BUILD SUCCESSFUL`; the framework `action_bar` resource resolves to a nonzero ID and the test passes with no native `android:id/action_bar` decor view.

- [ ] **Step 5: Build and install the debug app**

Run:

```bash
cd android
./gradlew assembleDebug installDebug
```

Expected: `BUILD SUCCESSFUL` and the debug APK is installed on `emulator-5554`.

- [ ] **Step 6: Cold-launch and verify the live Android hierarchy**

Run these commands from the repository root:

```bash
adb shell am force-stop com.claw.control
adb shell am start -W -n com.claw.control/.MainActivity
adb shell uiautomator dump /sdcard/clawcontrol-window.xml
adb exec-out cat /sdcard/clawcontrol-window.xml | rg 'android.webkit.WebView'
adb exec-out cat /sdcard/clawcontrol-window.xml | rg 'android:id/action_bar|android:id/action_bar_container|text="ClawControl"'
```

Expected:

- The WebView search returns `class="android.webkit.WebView"`.
- The ActionBar/title search returns no matches (exit status 1).
- The emulator visibly retains the Android launch splash and then shows the existing edge-to-edge Capacitor UI without a title bar or layout jump.

- [ ] **Step 7: Confirm the final diff contains only the intended additions**

Run:

```bash
git diff --check -- \
  android/app/src/androidTest/java/com/claw/control/MainActivityActionBarTest.java \
  android/app/src/main/res/values/styles.xml
git diff -- android/app/src/androidTest/java/com/claw/control/MainActivityActionBarTest.java
git diff -- android/app/src/main/res/values/styles.xml
```

Expected: no whitespace errors in the task-owned files; one new focused test; exactly two new theme attributes attributable to this fix. Pre-existing worktree changes remain present and unmodified. A whole-worktree `git diff --check` may still report unrelated pre-existing CRLF/trailing-whitespace changes and is intentionally not used as this task's gate.

- [ ] **Step 8: Commit only the test and the two theme attributes**

Stage the new test normally. Stage only the two new `AppTheme.NoActionBarLaunch` lines from `styles.xml` interactively because that file already contains unrelated user changes:

```bash
git add android/app/src/androidTest/java/com/claw/control/MainActivityActionBarTest.java
git add -p android/app/src/main/res/values/styles.xml
git diff --cached --check
git diff --cached
git commit -m "fix(android): remove native action bar"
```

Expected: the cached diff contains the new test plus only `android:windowActionBar=false` and `android:windowNoTitle=true` from `styles.xml`; the commit succeeds without including any pre-existing worktree edits.
