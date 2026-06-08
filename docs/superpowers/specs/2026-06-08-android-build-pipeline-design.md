# Android Build Pipeline — Design Spec

**Status:** Draft for review
**Date:** 2026-06-08
**Author:** Jake Edwards (with Claude)
**Scope:** CI/CD pipeline for ClawControl Android builds (sideload APK + Play Store AAB)

## Goal

Extend ClawControl's release automation so that pushing a `v*` tag produces, in parallel with the existing Mac/Win/Linux desktop builds:

1. A **signed APK** attached to the GitHub Release (sideload distribution).
2. A **signed AAB** uploaded as a **draft** to the Play Console **production** track for `com.claw.control`. Manual "Submit for review" remains a human gate.

Plus a lightweight PR CI check that compiles the Android debug build so we catch breakage before tagging.

## Non-goals

- iOS CI pipeline (separate spec when needed).
- Automated screenshot/listing updates (Fastlane territory).
- Play Console release notes automation (manual for now).
- Crash reporting / Play vitals integration.
- Automated promotion from draft → submitted-for-review.

## Constraints & assumptions

- App is already published on Play Store as `com.claw.control` using **Play App Signing**. Google holds the app signing key; we hold an **upload key**.
- `versionName` is sourced from `package.json#version` (matching desktop builds today).
- Capacitor 8 + AGP 8.x → JDK 17 required.
- The post-`cap sync` patch script (`scripts/fix-android-edge-to-edge.js`) must run as part of every build that involves `cap sync`.
- Tag releases ship from `main`; PRs may originate from forks (signing secrets must not be exposed to PR runs).
- Single contributor today; designed to extend cleanly to more contributors without rework.

## Key consequence to call out

Because Play uses Play App Signing, the **GitHub Release APK is signed with a different fingerprint** than what Play delivers to end users. A user who installed from Play cannot sideload an updated APK over their existing install (signature mismatch). This is normal Android behavior and not a bug — it's documented here so it isn't a surprise in support.

## Architecture overview

```
v* tag push
    │
    ▼
.github/workflows/release.yml  (matrix: mac, win, linux, android)
    │
    ├─ mac job ───────► .dmg, *-mac.zip ─────► GitHub Release
    ├─ win job ───────► .exe, .exe.blockmap ─► GitHub Release
    ├─ linux job ─────► .AppImage, .deb ─────► GitHub Release
    └─ android job ──┬─► ClawControl-X.Y.Z.apk ─► GitHub Release
                     └─► app-release.aab ──────► Play Console
                                                  (production track, draft status)

Pull request (touching android-relevant paths)
    │
    ▼
.github/workflows/android-ci.yml
    │
    └─ debug job ────► app-debug.apk ────► CI artifact (7-day retention)
```

## Section 1 — Repo changes (foundation)

Land these as a single bootstrap PR **before** wiring up any release-side automation. The new PR CI workflow (Section 4) catches breakage on this PR.

### 1.1 Commit the `android/` directory

- Remove the `android/` line from `.gitignore`.
- Before committing, run on a clean tree: `npx cap sync android` followed by `node scripts/fix-android-edge-to-edge.js` so the committed state already reflects the post-patch state.
- `git add android/` and commit.
- Add these specific paths back to `.gitignore` (build artifacts, IDE state, local-only files):
  ```
  android/app/build/
  android/.gradle/
  android/build/
  android/local.properties
  android/app/release/
  android/app/upload-keystore.jks
  android/captures/
  ```

### 1.2 Add Gradle signing config

Modify `android/app/build.gradle` so signing is environment-variable driven, with a graceful no-op fallback for local dev:

```gradle
android {
    signingConfigs {
        release {
            if (System.getenv("ANDROID_KEYSTORE_BASE64")) {
                storeFile file("upload-keystore.jks")
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            // existing minify/proguard settings preserved
        }
    }
}
```

The keystore file itself is **never committed**; CI writes it at build time from the `ANDROID_KEYSTORE_BASE64` secret. Local `assembleDebug` is unaffected (debug build type uses the auto-generated debug keystore).

### 1.3 Version sourcing helper

Add `scripts/set-android-version.js`. The script:

- Reads `version` from `package.json` (e.g. `"1.8.0"`).
- Computes `versionCode = major*10000 + minor*100 + patch` → `10800`. Deterministic, monotonic for normal semver bumps, leaves space (99 patches per minor, 99 minors per major) for hotfixes.
- Patches `android/app/build.gradle` `defaultConfig { versionCode N; versionName "X.Y.Z" }` in place.
- Documents the formula in a comment beside the call site so future bumps don't surprise.

Wire the script into `npm run mobile:sync` and the CI workflow steps so the in-tree `build.gradle` always reflects `package.json` at build time. The committed `build.gradle` can carry stale values — the helper rewrites them before each build.

### 1.4 `.gitattributes` for gradlew

Ensure `android/gradlew` has executable bit preserved on checkout (Linux CI runners need it):
```
android/gradlew text eol=lf
```
And confirm `git update-index --chmod=+x android/gradlew` was applied before commit.

## Section 2 — Release workflow (`release.yml`) extension

### 2.1 Matrix entry

Add a fourth entry to the existing matrix in `.github/workflows/release.yml`:

```yaml
- os: ubuntu-latest
  platform: android
  artifacts: |
    android/app/build/outputs/apk/release/ClawControl-*.apk
```

The artifact glob picks up the renamed APK so `softprops/action-gh-release@v2` attaches it to the release without code changes to that step.

### 2.2 Android-specific steps (gated on `matrix.platform == 'android'`)

In order, conditional on the matrix entry:

1. **Setup JDK 17** — `actions/setup-java@v4` with `distribution: temurin`.
2. **Setup Android SDK** — `android-actions/setup-android@v3` (caches SDK across runs).
3. **Setup Gradle cache** — `gradle/actions/setup-gradle@v3` (Gradle build cache; cuts CI time ~50% after first run).
4. **Decode keystore** — write `${{ secrets.ANDROID_KEYSTORE_BASE64 }}` (base64-decoded) to `android/app/upload-keystore.jks`. Use `echo "$SECRET" | base64 -d > ...`.
5. **Sync versions into Gradle** — `node scripts/set-android-version.js`.
6. **Build web + cap sync + edge-to-edge patch** — `npm run mobile:sync` (existing script in `package.json`).
7. **Build APK** — `cd android && ./gradlew assembleRelease`. Output: `android/app/build/outputs/apk/release/app-release.apk`.
8. **Build AAB** — `cd android && ./gradlew bundleRelease`. Output: `android/app/build/outputs/bundle/release/app-release.aab`.
9. **Rename APK** — `mv app-release.apk ClawControl-${VERSION}.apk` for nicer GitHub Release display.
10. **Upload AAB to Play Console** — `r0adkll/upload-google-play@v1`:
    - `serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}`
    - `packageName: com.claw.control`
    - `releaseFiles: android/app/build/outputs/bundle/release/app-release.aab`
    - `track: production`
    - `status: draft`
    - `id: play_upload` (so later steps can reference its outcome)
11. **Fallback: AAB to workflow artifacts on Play upload failure** — `actions/upload-artifact@v4`, `if: failure() && steps.play_upload.outcome == 'failure'`, retention 14 days. Lets you manually upload the AAB if the Play API is having a bad day.
12. **GitHub Release attachment** — handled by the existing `softprops/action-gh-release@v2` step; the renamed APK matches the artifact glob.

### 2.3 Why these tool choices

- **`r0adkll/upload-google-play`** over Fastlane: single-purpose action, ~10 lines to configure. Fastlane pays off when you also manage screenshots/listings/in-app updates — out of scope here.
- **In-matrix Android job** over a dedicated workflow: same trigger semantics as desktop, single version source of truth (the tag), parallel execution, `fail-fast: false` already in place.
- **APK + AAB built separately** (not one bundle command): keeps the desktop pattern of "one artifact type per distribution channel" and lets the AAB upload fail without losing the APK.

## Section 3 — Signing & secrets

### 3.1 Key strategy: one key for both AAB and sideload APK

The upload key signs the AAB Google receives. The sideload APK is also signed with the same key. The decision: **don't generate a second key for sideload.** Reasoning:

- Play App Signing already creates a fingerprint asymmetry between Play installs and sideload installs. A second key wouldn't change that.
- Single keystore = single set of secrets = single signing config in `build.gradle` = less to maintain.
- The upload key is already a sensitive secret regardless of how many places use it.

If a sideload-specific key is ever wanted later, it's a straightforward additive change (separate `signingConfig` for a new `sideload` build flavor).

### 3.2 Required GitHub repo secrets

| Secret | Value | Source |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64` of the `upload-keystore.jks` file | Local: `base64 -i upload-keystore.jks \| pbcopy` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password | Set at `keytool -genkey` time |
| `ANDROID_KEY_ALIAS` | e.g. `clawcontrol-upload` | Set at `keytool -genkey` time |
| `ANDROID_KEY_PASSWORD` | Key password (often == keystore password) | Set at `keytool -genkey` time |
| `PLAY_SERVICE_ACCOUNT_JSON` | Full JSON key of a Play Console service account | Play Console → Setup → API access |

### 3.3 Keystore generation (one-time, if needed)

If you don't already have the upload key, or want to rotate (Play Console "App integrity" has the reset flow):

```bash
keytool -genkey -v -keystore upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias clawcontrol-upload
```

Then:
1. Encode to base64 and paste into `ANDROID_KEYSTORE_BASE64`.
2. Store an **encrypted backup** of `upload-keystore.jks` somewhere outside GitHub (1Password, etc.). **Losing this key locks you out of updating the Play listing**, full stop.
3. If rotating, register the new cert with Play Console before the first CI build.

### 3.4 Play Console service account setup (one-time)

1. Play Console → **Setup → API access** → link a GCP project → create a service account.
2. Grant the service account the **"Release manager"** role on `com.claw.control` (least-privileged role that can upload to tracks).
3. Download the JSON key. Paste the **entire JSON** (no base64 wrapping) into `PLAY_SERVICE_ACCOUNT_JSON`.

### 3.5 No GitHub Environment approval gate

The "draft" status on the Play upload is the human gate — nothing reaches users until you click "Submit for review" in Play Console. A separate Environment approval gate was considered and skipped to keep release friction low.

## Section 4 — PR CI workflow (`android-ci.yml`)

Purpose: catch Android build breakage before tagging, without ever exposing signing secrets to PR runs (PRs may come from forks).

### 4.1 Triggers

```yaml
on:
  pull_request:
    paths:
      - 'android/**'
      - 'capacitor.config.ts'
      - 'scripts/fix-android-edge-to-edge.js'
      - 'scripts/set-android-version.js'
      - 'package.json'
      - 'package-lock.json'
      - 'src/**'
      - 'plugins/capacitor-native-websocket/**'
      - '.github/workflows/android-ci.yml'
  workflow_dispatch:
```

Path filter is a pragmatic 80% solution. If a TypeScript change outside `src/**` later breaks the Android build, broaden the filter or drop it.

### 4.2 Steps

1. Checkout.
2. Setup Node 22 + npm cache.
3. Setup JDK 17 (temurin).
4. Setup Android SDK.
5. Setup Gradle cache.
6. `npm ci`.
7. `node scripts/set-android-version.js` (so version drift doesn't fail the build).
8. `npm run mobile:build` (web bundle).
9. `npx cap sync android && node scripts/fix-android-edge-to-edge.js`.
10. `cd android && ./gradlew assembleDebug` — debug build only.
11. `actions/upload-artifact@v4` → `android/app/build/outputs/apk/debug/app-debug.apk` with 7-day retention.

### 4.3 Why `assembleDebug`, not `assembleRelease`

- No keystore access needed → signing secrets stay out of PR runs (critical for fork safety).
- ~30-40% faster (no R8/ProGuard).
- We're verifying "the project compiles," not "the release artifact is valid." The release path is exercised on tag push.

### 4.4 Concurrency

```yaml
concurrency:
  group: android-ci-${{ github.ref }}
  cancel-in-progress: true
```

Force-pushes to a PR cancel the older run.

## Section 5 — Bootstrap order & rollout

Order matters — don't try to ship before the prerequisites exist.

1. **Bootstrap PR (Section 1 changes):**
   - Commit `android/`, update `.gitignore`, add signing config, add version helper, fix `gradlew` exec bit.
   - This PR has no CI yet (workflows land in step 4), so verify locally with `npm run mobile:android` + `./gradlew assembleDebug`.
2. **Generate keystore + populate 5 GitHub secrets** (Section 3.3).
3. **Set up Play service account + populate `PLAY_SERVICE_ACCOUNT_JSON`** (Section 3.4).
4. **Workflow PR:**
   - Extend `release.yml` with the Android matrix entry and steps (Section 2).
   - Add `android-ci.yml` (Section 4).
   - The new `android-ci.yml` runs on this PR and validates the debug build path.
5. **Dry-run release:** trigger `release.yml` via `workflow_dispatch` against the existing `v1.8.0` tag.
   - Verify APK builds, AAB uploads to Play as production-track draft, GitHub Release attaches the APK.
   - If Play upload fails (e.g. service account permissions), the AAB fallback uploads to the workflow run.
6. **First real release:** next `v*` tag push runs the full pipeline.
7. **Runbook:** write `docs/android-release.md` covering keystore backup location, secret rotation steps, dry-run procedure, and the "Submit for review" handoff.

## Section 6 — Acceptance criteria

The pipeline is considered "done" when:

- [ ] Pushing tag `v1.8.1` produces a successful workflow run with all four matrix jobs green.
- [ ] GitHub Release `v1.8.1` shows: `.dmg`, `.exe`, `.AppImage`/`.deb`, and `ClawControl-1.8.1.apk`.
- [ ] Play Console → `com.claw.control` → Production track shows a new draft release with `versionCode 10801` and `versionName 1.8.1`.
- [ ] Opening a PR that modifies `src/App.tsx` triggers `android-ci.yml`, which uploads a downloadable `app-debug.apk` artifact.
- [ ] Opening a PR that modifies an unrelated path (e.g. `README.md`) does NOT trigger `android-ci.yml`.
- [ ] Local `npm run mobile:android` continues to work unchanged (no keystore needed locally).
- [ ] A simulated Play upload failure (revoke service account temporarily) results in the AAB attached as a CI artifact, not silent loss.

## Section 7 — Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Upload keystore lost | Locked out of Play updates permanently | Encrypted offline backup outside GitHub; documented in runbook |
| Service account JSON leaks via logs | Anyone can publish to Play | GitHub auto-masks secrets; action accepts JSON via dedicated param; never `echo` it |
| AGP version drift from `cap sync` upstream | Post-sync patch script misaligns; release fails | `android/` is committed, so cap CLI upgrades become deliberate PRs; PR CI catches mismatch |
| Forgot to bump `package.json` before tagging | `versionCode` collides with a prior release; Play upload rejected | Tag push fails fast on Play upload step; fix is push a new tag with bumped version |
| Tag pushed against wrong commit | Wrong code shipped as draft | "Draft" status in Play prevents user-facing impact; manually delete draft + push corrected tag |
| Sideload user can't update over Play install (or vice versa) | Confused users | Documented in runbook + release notes; not a fix, just an expectation-setter |

## Section 8 — Out of scope (documented to prevent quiet expansion)

These were considered and explicitly deferred:

- **iOS CI pipeline** — separate spec when needed.
- **Fastlane** — overkill for current scope.
- **Automated screenshot/listing updates** — Fastlane territory.
- **Crash reporting / Play vitals** — orthogonal initiative.
- **Promotion automation** (draft → submitted-for-review, internal → production) — kept manual deliberately.
- **Separate signing keys for AAB vs sideload APK** — additive change if ever wanted.
- **Per-PR full release build** — debug builds suffice for CI; release path validated by tag pushes.
- **GitHub Environment approval gate on Play upload** — draft status is the gate.

## Open questions for implementation

None blocking. Two minor items to confirm during implementation:

1. **Existing AAB version code in Play Console** — implementer should check the highest `versionCode` already published. If `package.json` is at `1.8.0` (→ `versionCode 10800`) but Play already shows a higher code from a manual upload, the first automated release must bump `package.json` past it.
2. **`gradlew` exec bit** — verify on a fresh clone after the bootstrap PR that `git ls-files --stage android/gradlew` shows mode `100755`.
