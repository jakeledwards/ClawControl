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
