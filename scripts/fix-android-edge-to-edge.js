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

const fs = require('fs');
const path = require('path');

// Use the current working directory as the project root so this script can be
// driven from tests against a temp project. In normal use (`node scripts/fix-android-edge-to-edge.js`
// from the repo root) cwd === repo root, matching prior behavior.
const PROJECT_ROOT = process.cwd();
const ANDROID_APP = path.join(PROJECT_ROOT, 'android', 'app');
const MAIN_SRC = path.join(ANDROID_APP, 'src', 'main');

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
  if (!patched.includes('import androidx.activity.EdgeToEdge;')) {
    const importMatches = [...patched.matchAll(/^import .+;\r?\n/gm)];
    if (importMatches.length === 0) {
      throw new Error('fix-android-edge-to-edge: could not locate import block in MainActivity.java');
    }
    const lastImport = importMatches[importMatches.length - 1];
    const insertAt = lastImport.index + lastImport[0].length;
    patched = patched.slice(0, insertAt) + 'import androidx.activity.EdgeToEdge;\n' + patched.slice(insertAt);
  }

  // Inject EdgeToEdge.enable(this); inside onCreate, immediately before super.onCreate(...)
  const superCallRegex = /^([ \t]*)super\.onCreate\(\s*\w+\s*\);/m;
  if (!superCallRegex.test(patched)) {
    throw new Error('fix-android-edge-to-edge: could not locate "super.onCreate(<arg>);" in MainActivity.java');
  }
  patched = patched.replace(superCallRegex, (_match, indent) =>
    `${indent}EdgeToEdge.enable(this);\n${indent}super.onCreate(savedInstanceState);`
  );

  fs.writeFileSync(filePath, patched);
  console.log('+  MainActivity.java patched: EdgeToEdge import + enable() injected');
  return true;
}

function fixBuildGradle() {
  const filePath = path.join(ANDROID_APP, 'build.gradle');

  if (!fs.existsSync(filePath)) {
    console.warn('!  build.gradle not found, skipping');
    return false;
  }

  let content = fs.readFileSync(filePath, 'utf8');

  // Already has the dependency
  if (content.includes('androidx.activity:activity')) {
    console.log('*  build.gradle already has androidx.activity dependency');
    return true;
  }

  // Insert before the appcompat line
  const anchor = 'implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"';
  if (!content.includes(anchor)) {
    console.warn('!  Could not find appcompat dependency line in build.gradle, skipping');
    return false;
  }

  content = content.replace(
    anchor,
    'implementation "androidx.activity:activity:$androidxActivityVersion"\n    ' + anchor
  );

  fs.writeFileSync(filePath, content);
  console.log('+  build.gradle patched with androidx.activity dependency');
  return true;
}

function fixStyles() {
  const filePath = path.join(MAIN_SRC, 'res', 'values', 'styles.xml');

  if (!fs.existsSync(filePath)) {
    console.warn('!  styles.xml not found, skipping');
    return false;
  }

  let content = fs.readFileSync(filePath, 'utf8');

  // Already patched
  if (content.includes('android:statusBarColor') && content.includes('@android:color/transparent')) {
    console.log('*  styles.xml already has transparent system bar colors');
    return true;
  }

  // Add transparent bar colors to the NoActionBar style
  const anchor = '<item name="android:background">@null</item>';
  if (!content.includes(anchor)) {
    console.warn('!  Could not find NoActionBar background item in styles.xml, skipping');
    return false;
  }

  content = content.replace(
    anchor,
    anchor + '\n        <item name="android:navigationBarColor">@android:color/transparent</item>\n        <item name="android:statusBarColor">@android:color/transparent</item>'
  );

  fs.writeFileSync(filePath, content);
  console.log('+  styles.xml patched with transparent system bar colors');
  return true;
}

// Main
console.log('--- Android edge-to-edge post-sync patch ---');

if (!fs.existsSync(path.join(PROJECT_ROOT, 'android', 'app'))) {
  console.log('skip  Android project not found, skipping');
  process.exit(0);
}

const results = [fixMainActivity(), fixBuildGradle(), fixStyles()];

if (results.every(Boolean)) {
  console.log('done  Android edge-to-edge patches applied');
} else {
  console.warn('warn  Some patches could not be applied — check output above');
}
