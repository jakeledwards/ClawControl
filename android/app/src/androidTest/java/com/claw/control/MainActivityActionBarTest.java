package com.claw.control;

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
                assertNull(
                    "MainActivity must not inflate a native ActionBar view",
                    activity.findViewById(actionBarId)
                );
            });
        }
    }
}
