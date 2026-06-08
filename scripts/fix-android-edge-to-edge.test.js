import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

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
    return execSync(`node ${JSON.stringify(scriptPath)}`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
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

    it('throws when MainActivity has no import block', () => {
      // BridgeActivity anchor present, but no `import` lines whatsoever
      writeFileSync(mainActivityPath, `package com.claw.control;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }
}
`)
      writeFileSync(buildGradlePath, 'dependencies {\n  implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"\n}\n')
      writeFileSync(stylesPath, '<resources><style name="AppTheme.NoActionBar"><item name="android:background">@null</item></style></resources>')

      expect(() => runScript()).toThrow()
    })

    it('throws when MainActivity has no super.onCreate call', () => {
      // Anchor + import block present, but onCreate is missing the super call
      writeFileSync(mainActivityPath, `package com.claw.control;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // intentionally no onCreate override
}
`)
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
