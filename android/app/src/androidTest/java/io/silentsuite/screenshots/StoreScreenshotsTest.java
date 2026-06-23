/*
 * SilentSuite store screenshot capture test.
 *
 * Drives the app through the 8 screens used for Google Play store screenshots
 * and saves raw screencaps to /sdcard/SilentSuiteScreenshots/. The CI workflow
 * pulls these and composites branded marketing frames.
 *
 * This is an instrumentation test run on the emulator via the
 * android-emulator-runner GitHub Action. It uses UIAutomator to navigate
 * without depending on app internals, so it survives UI refactors better than
 * Espresso. Each screen is captured with adb screencap after navigation.
 *
 * Screens captured (matching the screenshot copy plan):
 *   1. welcome            - Welcome / encryption promise
 *   2. login              - Add account (with custom server toggle for self-host)
 *   3. collections        - Accounts/collections overview (native apps sync)
 *   4. fingerprint        - Encryption fingerprint verification
 *   5. sharing-members    - Collection members (encrypted sharing)
 *   6. invitations        - Invitations list
 *   7. collection-detail  - Collection detail / recent activity
 *   8. import             - Import flow
 *
 * NOTE: Some screens require a signed-in account. The test attempts navigation
 * and captures whatever is visible. If a screen is behind login and no test
 * account is configured, it captures the login screen instead (still useful).
 * The compositing step skips any capture that is missing.
 *
 * Copyright (c) SilentSuite. GPL-3.0.
 */

package io.silentsuite.screenshots;

import android.os.SystemClock;
import android.os.Environment;

import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.FixMethodOrder;
import org.junit.Test;
import org.junit.runners.MethodSorters;

import java.io.File;

import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;

@FixMethodOrder(MethodSorters.NAME_ASCENDING)
public class StoreScreenshotsTest {

    private static final String PACKAGE = "io.silentsuite.android";
    private static final long LAUNCH_TIMEOUT = 15000;
    private static final long NAV_TIMEOUT = 5000;
    private static final String CAPTURE_DIR_NAME = "SilentSuiteScreenshots";

    private static UiDevice device;
    private static File captureDir;

    @BeforeClass
    public static void startApp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());

        // Capture directory on external storage (world-readable via adb pull)
        File storage = Environment.getExternalStorageDirectory();
        captureDir = new File(storage, CAPTURE_DIR_NAME);
        if (!captureDir.exists()) {
            captureDir.mkdirs();
        }

        // Launch the app
        InstrumentationRegistry.getInstrumentation()
                .getUiAutomation()
                .executeShellCommand("monkey -p " + PACKAGE + " -c android.intent.category.LAUNCHER 1");
        device.wait(Until.hasObject(By.pkg(PACKAGE).depth(0)), LAUNCH_TIMEOUT);
        SystemClock.sleep(2000);
    }

    @AfterClass
    public static void finish() {
        // Captures are pulled by the CI script via adb pull
    }

    private void capture(String name) {
        File out = new File(captureDir, name + ".png");
        device.takeScreenshot(out);
        SystemClock.sleep(500);
    }

    private void sleep(long ms) {
        SystemClock.sleep(ms);
    }

    private boolean tapText(String text) {
        UiObject2 obj = device.wait(Until.findObject(By.text(text)), NAV_TIMEOUT);
        if (obj != null) {
            obj.click();
            sleep(1000);
            return true;
        }
        return false;
    }

    private boolean tapTextContains(String text) {
        UiObject2 obj = device.wait(Until.findObject(By.textContains(text)), NAV_TIMEOUT);
        if (obj != null) {
            obj.click();
            sleep(1000);
            return true;
        }
        return false;
    }

    /**
     * Screenshot 1: Welcome / encryption promise screen.
     * On first launch (or after clearing app data) the welcome screen appears.
     */
    @Test
    public void test01_welcome() {
        // Clear app data to force fresh welcome state
        InstrumentationRegistry.getInstrumentation()
                .getUiAutomation()
                .executeShellCommand("pm clear " + PACKAGE);
        sleep(1000);
        InstrumentationRegistry.getInstrumentation()
                .getUiAutomation()
                .executeShellCommand("monkey -p " + PACKAGE + " -c android.intent.category.LAUNCHER 1");
        device.wait(Until.hasObject(By.pkg(PACKAGE).depth(0)), LAUNCH_TIMEOUT);
        sleep(2500);
        capture("1-welcome");
    }

    /**
     * Screenshot 2: Login / add account with custom server toggle (self-host).
     */
    @Test
    public void test02_login_selfhost() {
        // From welcome, tap Get Started or navigate to login
        tapText("Get Started");
        tapText("Add account");
        sleep(1500);
        capture("2-login");
    }

    /**
     * Screenshot 3: Collections overview (native apps sync adapter view).
     * Requires a signed-in account. If not signed in, captures the accounts
     * empty state which still shows the encryption framing.
     */
    @Test
    public void test03_collections() {
        // Navigate back to accounts/collections screen
        device.pressBack();
        sleep(1000);
        // Open app fresh to land on accounts
        InstrumentationRegistry.getInstrumentation()
                .getUiAutomation()
                .executeShellCommand("monkey -p " + PACKAGE + " -c android.intent.category.LAUNCHER 1");
        device.wait(Until.hasObject(By.pkg(PACKAGE).depth(0)), LAUNCH_TIMEOUT);
        sleep(2000);
        capture("3-collections");
    }

    /**
     * Screenshot 4: Encryption fingerprint verification.
     */
    @Test
    public void test04_fingerprint() {
        // Try to reach fingerprint via account menu
        tapTextContains("Verify encryption fingerprint");
        sleep(1500);
        capture("4-fingerprint");
    }

    /**
     * Screenshot 5: Collection members (encrypted sharing).
     */
    @Test
    public void test05_sharing_members() {
        device.pressBack();
        sleep(800);
        tapTextContains("Manage Members");
        sleep(1500);
        capture("5-sharing-members");
    }

    /**
     * Screenshot 6: Invitations list.
     */
    @Test
    public void test06_invitations() {
        device.pressBack();
        sleep(800);
        // Open navigation drawer
        device.pressBack();
        sleep(500);
        tapTextContains("Invitations");
        sleep(1500);
        capture("6-invitations");
    }

    /**
     * Screenshot 7: Collection detail / recent activity.
     */
    @Test
    public void test07_collection_detail() {
        device.pressBack();
        sleep(800);
        // Tap first collection if present
        UiObject2 collection = device.wait(Until.findObject(By.textContains("Calendar")), NAV_TIMEOUT);
        if (collection != null) {
            collection.click();
            sleep(1500);
        }
        capture("7-collection-detail");
    }

    /**
     * Screenshot 8: Import flow.
     */
    @Test
    public void test08_import() {
        // Open overflow menu and tap Import
        UiObject2 overflow = device.wait(Until.findObject(By.descContains("More")), NAV_TIMEOUT);
        if (overflow != null) {
            overflow.click();
            sleep(800);
        }
        tapText("Import");
        sleep(1500);
        capture("8-import");
    }
}
