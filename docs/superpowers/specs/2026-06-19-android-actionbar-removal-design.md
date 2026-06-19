# Android ActionBar Removal Design

## Problem

The Android app displays a persistent native title bar containing “ClawControl” above the Capacitor WebView. The running emulator hierarchy identifies it as an AppCompat ActionBar, not web content. On a cold launch, AppCompat creates the activity decor from `AppTheme.NoActionBarLaunch` before Capacitor switches to `AppTheme.NoActionBar`, so changing the theme afterward does not remove the already-created bar.

## Goal

Prevent the native ActionBar from being created while preserving the existing Android launch splash, edge-to-edge system bars, safe-area handling, and web UI.

## Design

Make `AppTheme.NoActionBarLaunch` explicitly titleless by setting both AppCompat theme attributes:

- `windowActionBar` to `false`
- `windowNoTitle` to `true`

The launch theme remains based on `Theme.SplashScreen` and continues handing off to `AppTheme.NoActionBar` through `postSplashScreenTheme`. No Java lifecycle changes and no web-layer changes are required.

This is preferable to calling `setTheme()` before `super.onCreate()` because the requirement belongs in the theme that creates the activity decor. It is preferable to hiding the ActionBar after launch because post-creation hiding can produce a visible flash or layout shift.

## Verification

Add an Android instrumentation regression test that launches `MainActivity` and asserts that no support ActionBar exists. Run it before the theme change to confirm it fails for the current behavior, then run it after the change to confirm it passes.

Build and install the debug app on the active emulator, cold-launch it, and verify through the live UI hierarchy that:

- `android:id/action_bar` and `android:id/action_bar_container` are absent.
- No native `TextView` contains the activity title “ClawControl.”
- The WebView remains present and fills the activity.
- The Android launch splash and edge-to-edge layout still appear normally.

## Scope

Only the Android launch theme and its regression coverage are in scope. Existing uncommitted worktree changes are preserved, and the React/Capacitor UI is unchanged.
