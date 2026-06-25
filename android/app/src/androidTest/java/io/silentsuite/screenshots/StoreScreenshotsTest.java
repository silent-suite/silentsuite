/*
 * SilentSuite store screenshot capture test.
 *
 * Drives the app through the 8 screens used for Google Play store screenshots
 * and saves raw screencaps to /sdcard/SilentSuiteScreenshots/. The CI workflow
 * pulls these and composites branded marketing frames.
 *
 * If test account credentials are provided via instrumentation arguments
 * (-e testEmail ... -e testPassword ...), the test logs in before capturing the
 * post-login screens (collections, fingerprint, sharing, invitations, etc.) so
 * those screens show real data instead of a login wall. If no credentials are
 * provided, it captures whatever is visible (login screen for gated screens).
 *
 * Uses UIAutomator to navigate without depending on app internals, so it
 * survives UI refactors better than Espresso. Each screen is captured with
 * device.takeScreenshot after navigation.
 *
 * Screens captured:
 *   1. welcome            - Welcome / encryption promise
 *   2. login              - Add account (custom server toggle for self-host)
 *   3. collections        - Accounts/collections overview (post-login)
 *   4. fingerprint        - Encryption fingerprint verification (post-login)
 *   5. sharing-members    - Collection members (encrypted sharing, post-login)
 *   6. invitations         - Invitations list (post-login)
 *   7. collection-detail   - Collection detail / recent activity (post-login)
 *   8. import              - Import flow (post-login)
 *
 * Copyright (c) SilentSuite. GPL-3.0.
 */

package io.silentsuite.screenshots;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;

import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.FixMethodOrder;
import org.junit.Test;
import org.junit.runners.MethodSorters;

import java.io.File;
import java.util.List;

import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;

@FixMethodOrder(MethodSorters.NAME_ASCENDING)
public class StoreScreenshotsTest {

    private static final String PACKAGE = "io.silentsuite.android";
    private static final long LAUNCH_TIMEOUT = 20000;
    private static final long NAV_TIMEOUT = 6000;
    private static final String DEFAULT_CAPTURE_DIR = "/sdcard/Download/SilentSuiteScreenshots";

    private static UiDevice device;
    private static File captureDir;
    private static String testEmail;
    private static String testPassword;
    private static boolean loggedIn = false;

    @BeforeClass
    public static void setUp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());

        // Read instrumentation arguments (passed by CI).
        Bundle args = InstrumentationRegistry.getArguments();
        String screenshotDir = args.getString("screenshotDir", DEFAULT_CAPTURE_DIR);
        captureDir = new File(screenshotDir);

        // Create the directory both through shell (works on scoped storage paths)
        // and File.mkdirs() (works for app-owned paths). UiDevice.takeScreenshot
        // fails with ENOENT if the parent directory is missing.
        try {
            InstrumentationRegistry.getInstrumentation()
                    .getUiAutomation()
                    .executeShellCommand("mkdir -p " + screenshotDir);
        } catch (Exception ignored) {
        }
        if (!captureDir.exists()) {
            captureDir.mkdirs();
        }

        testEmail = args.getString("testEmail", null);
        testPassword = args.getString("testPassword", null);

        launchApp();
    }

    @AfterClass
    public static void finish() {
        // Captures are pulled by the CI script via adb pull
    }

    private static void launchApp() {
        Context targetContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent intent = targetContext.getPackageManager().getLaunchIntentForPackage(PACKAGE);
        if (intent == null) {
            throw new AssertionError("No launch intent for " + PACKAGE);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        targetContext.startActivity(intent);
        device.wait(Until.hasObject(By.pkg(PACKAGE).depth(0)), LAUNCH_TIMEOUT);
        SystemClock.sleep(2000);
    }

    private void capture(String name) {
        String currentPackage = device.getCurrentPackageName();
        if (!PACKAGE.equals(currentPackage)) {
            launchApp();
            currentPackage = device.getCurrentPackageName();
        }
        if (!PACKAGE.equals(currentPackage)) {
            throw new AssertionError("Cannot capture " + name + ": current package is " + currentPackage);
        }
        if (!captureDir.exists()) {
            captureDir.mkdirs();
        }
        File out = new File(captureDir, name + ".png");
        boolean ok = device.takeScreenshot(out);
        if (!ok) {
            throw new AssertionError("Failed to save screenshot: " + out.getAbsolutePath());
        }
        SystemClock.sleep(400);
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

    private boolean tapDescContains(String text) {
        UiObject2 obj = device.wait(Until.findObject(By.descContains(text)), NAV_TIMEOUT);
        if (obj != null) {
            obj.click();
            sleep(1000);
            return true;
        }
        return false;
    }

    private boolean tapRes(String resId) {
        UiObject2 obj = device.wait(Until.findObject(By.res(PACKAGE, resId)), NAV_TIMEOUT);
        if (obj != null) {
            obj.click();
            sleep(1000);
            return true;
        }
        return false;
    }

    private void fillLoginFields() {
        UiObject2 emailField = device.wait(Until.findObject(By.res(PACKAGE, "user_name")), NAV_TIMEOUT);
        if (emailField != null) {
            emailField.click();
            sleep(300);
            emailField.setText(testEmail);
            sleep(300);
        }

        // The password input itself is the second EditText inside a TextInputLayout
        // (R.id.url_password belongs to the layout), so address EditText widgets.
        List<UiObject2> editTexts = device.findObjects(By.clazz("android.widget.EditText"));
        if (editTexts.size() >= 2) {
            UiObject2 passField = editTexts.get(1);
            passField.click();
            sleep(300);
            passField.setText(testPassword);
            sleep(300);
        }
    }

    private void requireLoggedIn(String screenName) {
        if (!loggedIn) {
            tryLogin();
        }
        UiObject2 emailField = device.wait(Until.findObject(By.res(PACKAGE, "user_name")), 1000);
        if (!loggedIn || emailField != null) {
            throw new AssertionError("Cannot capture " + screenName + ": login did not complete");
        }
    }

    /**
     * Attempt to log in with the test account credentials (if provided).
     * Types email + password into the login fields and taps Log In.
     * Sets loggedIn=true if the collections screen appears after login.
     */
    private void tryLogin() {
        if (testEmail == null || testPassword == null || testEmail.isEmpty() || testPassword.isEmpty()) {
            return; // no credentials, skip login
        }

        launchApp();

        UiObject2 emailField = device.wait(Until.findObject(By.res(PACKAGE, "user_name")), NAV_TIMEOUT);
        if (emailField == null) {
            tapText("Get Started");
            sleep(1000);
            tapText("Add account");
            sleep(1000);
            emailField = device.wait(Until.findObject(By.res(PACKAGE, "user_name")), NAV_TIMEOUT);
        }
        if (emailField == null) {
            return;
        }

        fillLoginFields();
        tapRes("login");

        // Wait for the server login/encryption flow to advance.
        sleep(5000);

        // Handle the encryption password prompt if it appears.
        UiObject2 encLabel = device.wait(Until.findObject(By.textContains("Encryption Password")), 2000);
        if (encLabel != null) {
            List<UiObject2> editTexts = device.findObjects(By.clazz("android.widget.EditText"));
            if (!editTexts.isEmpty()) {
                UiObject2 encPass = editTexts.get(editTexts.size() - 1);
                encPass.click();
                sleep(300);
                encPass.setText(testPassword);
                sleep(300);
            }
            tapText("Finish");
            tapText("FINISH");
            sleep(5000);
        }

        // Successful login leaves the LoginActivity and no longer shows the email field.
        UiObject2 stillLogin = device.wait(Until.findObject(By.res(PACKAGE, "user_name")), 1000);
        loggedIn = stillLogin == null && PACKAGE.equals(device.getCurrentPackageName());
    }

    /**
     * Screenshot 1: Welcome / encryption promise screen.
     * On a fresh emulator install the app has no data, so it naturally shows
     * the welcome screen. Do NOT call pm clear here: it kills the app process,
     * which also kills the instrumentation test running inside it.
     */
    @Test
    public void test01_welcome() {
        // The app was already launched in @BeforeClass. Just wait and capture.
        sleep(2500);
        capture("1-welcome");
    }

    /**
     * Screenshot 2: Login / add account with custom server toggle (self-host).
     * Shows the login screen with the Custom server toggle visible.
     */
    @Test
    public void test02_login_selfhost() {
        // From welcome, advance to login
        tapText("Get Started");
        sleep(1000);
        // If not on login, try Add account
        UiObject2 emailField = device.wait(Until.findObject(By.res(PACKAGE, "user_name")), NAV_TIMEOUT);
        if (emailField == null) {
            tapText("Add account");
            sleep(1500);
        }

        // Expand the Custom server toggle to show the self-host field
        UiObject2 advanced = device.wait(Until.findObject(By.res(PACKAGE, "show_advanced")), NAV_TIMEOUT);
        if (advanced != null) {
            advanced.click();
            sleep(800);
        }
        capture("2-login");

        // Now attempt login for the post-login screenshots
        // Collapse the advanced toggle first (use default hosted server)
        if (advanced != null) {
            advanced.click();
            sleep(500);
        }
        tryLogin();
    }

    /**
     * Screenshot 3: Collections overview (post-login).
     * Shows the list of calendars/contacts/task lists with shared/read-only indicators.
     */
    @Test
    public void test03_collections() {
        requireLoggedIn("collections");
        launchApp(); // relaunch to land on accounts/collections
        sleep(2000);
        capture("3-collections");
    }

    /**
     * Screenshot 4: Encryption fingerprint verification (post-login).
     */
    @Test
    public void test04_fingerprint() {
        requireLoggedIn("fingerprint");
        // Open the account overflow menu and tap "Verify encryption fingerprint"
        tapDescContains("More");
        sleep(800);
        tapTextContains("Verify encryption fingerprint");
        sleep(2000);
        capture("4-fingerprint");
        device.pressBack();
        sleep(800);
    }

    /**
     * Screenshot 5: Collection members / encrypted sharing (post-login).
     */
    @Test
    public void test05_sharing_members() {
        requireLoggedIn("sharing members");
        // Tap the first collection to open its detail, then Manage Members
        UiObject2 collection = device.wait(Until.findObject(By.textContains("Calendar")), NAV_TIMEOUT);
        if (collection == null) {
            collection = device.wait(Until.findObject(By.textContains("Contacts")), NAV_TIMEOUT);
        }
        if (collection != null) {
            collection.click();
            sleep(1500);
        }
        tapDescContains("More");
        sleep(800);
        tapTextContains("Manage Members");
        sleep(2000);
        capture("5-sharing-members");
        device.pressBack();
        sleep(800);
    }

    /**
     * Screenshot 6: Invitations list (post-login).
     */
    @Test
    public void test06_invitations() {
        requireLoggedIn("invitations");
        // Open navigation drawer
        device.pressBack();
        sleep(500);
        UiObject2 drawer = device.wait(Until.findObject(By.descContains("Navigate")), NAV_TIMEOUT);
        if (drawer == null) {
            // Try pressing the up/home button
            UiObject2 upBtn = device.wait(Until.findObject(By.descContains("up")), NAV_TIMEOUT);
            if (upBtn != null) upBtn.click();
            sleep(1000);
        } else {
            drawer.click();
            sleep(1000);
        }
        tapTextContains("Invitations");
        sleep(2000);
        capture("6-invitations");
        device.pressBack();
        sleep(500);
    }

    /**
     * Screenshot 7: Collection detail / recent sync activity (post-login).
     */
    @Test
    public void test07_collection_detail() {
        requireLoggedIn("collection detail");
        launchApp();
        sleep(2000);
        UiObject2 collection = device.wait(Until.findObject(By.textContains("Calendar")), NAV_TIMEOUT);
        if (collection == null) {
            collection = device.wait(Until.findObject(By.textContains("Contacts")), NAV_TIMEOUT);
        }
        if (collection != null) {
            collection.click();
            sleep(2000);
        }
        capture("7-collection-detail");
        device.pressBack();
        sleep(500);
    }

    /**
     * Screenshot 8: Import flow (post-login).
     */
    @Test
    public void test08_import() {
        requireLoggedIn("import");
        tapDescContains("More");
        sleep(800);
        tapText("Import");
        sleep(2000);
        capture("8-import");
    }
}
