/*
 * SilentSuite store screenshot capture test.
 *
 * Drives the app through the 8 screens used for Google Play store screenshots
 * and saves raw screencaps to /sdcard/Download/SilentSuiteScreenshots/. The CI workflow
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
import android.widget.EditText;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;

import androidx.appcompat.app.AppCompatDelegate;
import androidx.test.core.app.ActivityScenario;
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

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.action.ViewActions.closeSoftKeyboard;
import static androidx.test.espresso.action.ViewActions.replaceText;
import static androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom;
import static androidx.test.espresso.matcher.ViewMatchers.withHint;
import static androidx.test.espresso.matcher.ViewMatchers.withId;
import static org.hamcrest.Matchers.allOf;

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

    private static String requireSafeScreenshotDir(String value) {
        if (DEFAULT_CAPTURE_DIR.equals(value)) {
            return value;
        }
        String parityPrefix = "/sdcard/Android/data/" + PACKAGE + "/files/color-parity-evidence/";
        if (!value.startsWith(parityPrefix)) {
            throw new IllegalArgumentException("Unsupported screenshot directory");
        }
        String nonce = value.substring(parityPrefix.length());
        if (!nonce.matches("[A-Za-z0-9._-]+") || ".".equals(nonce) || "..".equals(nonce)) {
            throw new IllegalArgumentException("Invalid screenshot evidence nonce");
        }
        return value;
    }

    @BeforeClass
    public static void setUp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());

        // Read instrumentation arguments (passed by CI).
        Bundle args = InstrumentationRegistry.getArguments();
        String screenshotDir = requireSafeScreenshotDir(
                args.getString("screenshotDir", DEFAULT_CAPTURE_DIR));
        captureDir = new File(screenshotDir);

        // Only the exact legacy shared directory reaches the shell. Parity evidence
        // uses its validated app-owned path and File.mkdirs().
        if (DEFAULT_CAPTURE_DIR.equals(screenshotDir)) {
            try {
                InstrumentationRegistry.getInstrumentation()
                        .getUiAutomation()
                        .executeShellCommand("mkdir -p " + DEFAULT_CAPTURE_DIR);
            } catch (Exception ignored) {
            }
        }
        if (!captureDir.exists() && !captureDir.mkdirs()) {
            throw new AssertionError("Failed to create screenshot directory");
        }

        testEmail = cleanArg(args.getString("testEmail", null));
        testPassword = cleanArg(args.getString("testPassword", null));

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

    private static void launchLogin() {
        Context targetContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent intent = new Intent(targetContext, io.silentsuite.sync.ui.setup.LoginActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        targetContext.startActivity(intent);
        device.wait(Until.hasObject(By.pkg(PACKAGE).depth(0)), LAUNCH_TIMEOUT);
        SystemClock.sleep(2000);
        UiObject2 signIn = device.findObject(By.res(PACKAGE, "account_choice_sign_in"));
        if (signIn == null) {
            throw new AssertionError("Account-choice Sign in action was not available");
        }
        signIn.click();
        device.wait(Until.hasObject(By.res(PACKAGE, "user_name")), LAUNCH_TIMEOUT);
        SystemClock.sleep(500);
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

    private static String cleanArg(String value) {
        if (value == null) {
            return null;
        }
        value = value.trim();
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            return value.substring(1, value.length() - 1);
        }
        if (value.length() >= 2 && value.startsWith("'") && value.endsWith("'")) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }

    private static String shellTextArg(String value) {
        // Android's input text command treats %s as a space. The screenshot
        // credentials do not contain spaces, but keep this safe and shell-quoted.
        String escaped = value.replace("'", "'\''").replace(" ", "%s");
        return "'" + escaped + "'";
    }

    private static void shellCommand(String command) {
        try {
            InstrumentationRegistry.getInstrumentation()
                    .getUiAutomation()
                    .executeShellCommand(command)
                    .close();
        } catch (Exception ignored) {
        }
    }

    private void espressoLoginFallback() {
        try {
            onView(allOf(isAssignableFrom(EditText.class), withHint("Email")))
                    .perform(replaceText(testEmail), closeSoftKeyboard());
            sleep(300);
            onView(withId(io.silentsuite.sync.R.id.login_password))
                    .perform(replaceText(testPassword), closeSoftKeyboard());
            sleep(300);
            onView(withId(io.silentsuite.sync.R.id.login)).perform(click());
            sleep(1000);
        } catch (Throwable ignored) {
            // Fall back to UIAutomator/coordinate automation below.
        }
    }

    private void coordinateLoginFallback() {
        // Last-resort automation for API 35 where Material TextInput nodes are
        // visible but not reliably exposed by resource id or text selector.
        int w = device.getDisplayWidth();
        int h = device.getDisplayHeight();
        int emailY = Math.round(h * 0.315f);
        int passwordY = Math.round(h * 0.395f);
        int loginY = h - 75;

        device.click(w / 2, emailY);
        sleep(300);
        shellCommand("input text " + shellTextArg(testEmail));
        sleep(300);

        device.click(w / 2, passwordY);
        sleep(300);
        shellCommand("input text " + shellTextArg(testPassword));
        sleep(300);

        device.pressBack();
        sleep(500);
        device.click(w / 2, loginY);
        sleep(1000);
    }


    private void sleep(long ms) {
        SystemClock.sleep(ms);
    }

    private static void waitForAbout(ActivityScenario<io.silentsuite.sync.ui.AboutActivity> scenario) {
        for (int attempt = 0; attempt < 40; attempt++) {
            final boolean[] ready = {false};
            scenario.onActivity(activity -> {
                androidx.viewpager.widget.ViewPager pager = activity.findViewById(io.silentsuite.sync.R.id.viewpager);
                ready[0] = pager != null && pager.isAttachedToWindow() && pager.isShown()
                        && pager.getAdapter() != null && pager.getAdapter().getCount() > 0;
            });
            if (ready[0]) return;
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            SystemClock.sleep(50);
        }
        throw new AssertionError("AboutActivity viewpager was not attached, shown, and populated");
    }

    private static void waitForGlobalSettings(ActivityScenario<io.silentsuite.sync.ui.AppSettingsActivity> scenario) {
        for (int attempt = 0; attempt < 40; attempt++) {
            final boolean[] ready = {false};
            scenario.onActivity(activity -> {
                View content = activity.findViewById(android.R.id.content);
                androidx.fragment.app.Fragment fragment = activity.getSupportFragmentManager()
                        .findFragmentById(android.R.id.content);
                ready[0] = content != null && content.isAttachedToWindow() && content.isShown()
                        && fragment instanceof io.silentsuite.sync.ui.AppSettingsActivity.HomeFragment
                        && ((io.silentsuite.sync.ui.AppSettingsActivity.HomeFragment) fragment)
                                .findPreference("settings_category_appearance") != null;
            });
            if (ready[0]) return;
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            SystemClock.sleep(50);
        }
        throw new AssertionError("global AppSettingsActivity HomeFragment was not ready");
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

    private boolean isLoginScreen() {
        return device.hasObject(By.textContains("Add account"))
                || device.hasObject(By.text("LOG IN"))
                || device.hasObject(By.text("Log In"))
                || (device.hasObject(By.textContains("Email")) && device.hasObject(By.textContains("Password")));
    }

    private void fillLoginFields() {
        // Prefer visible EditText widgets. Material TextInputLayout resource IDs are
        // not reliably exposed to UIAutomator on API 35, but the child EditTexts are.
        UiObject2 emailById = device.wait(Until.findObject(By.res(PACKAGE, "user_name")), 1500);
        if (emailById != null) {
            emailById.click();
            sleep(300);
            emailById.setText(testEmail);
            sleep(300);
        }

        UiObject2 passById = device.wait(Until.findObject(By.res(PACKAGE, "login_password")), 1500);
        if (passById != null) {
            passById.click();
            sleep(300);
            passById.setText(testPassword);
            sleep(300);
            return;
        }

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
        if (!loggedIn || isLoginScreen()) {
            throw new AssertionError("Cannot capture " + screenName + ": login did not complete (credentials present="
                    + (testEmail != null && !testEmail.isEmpty() && testPassword != null && !testPassword.isEmpty())
                    + ", currentPackage=" + device.getCurrentPackageName()
                    + ", loginScreen=" + isLoginScreen() + ")");
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

        launchLogin();
        fillLoginFields();
        if (!tapRes("login")) {
            espressoLoginFallback();
        }
        if (isLoginScreen()) {
            coordinateLoginFallback();
        }
        sleep(5000);
        loggedIn = !isLoginScreen();
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
        launchLogin();
        UiObject2 emailField = device.wait(Until.findObject(By.res(PACKAGE, "user_name")), NAV_TIMEOUT);
        if (emailField == null) throw new AssertionError("Focused sign-in form was not available");

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
        UiObject2 invitations = device.wait(
                Until.findObject(By.res(device.getCurrentPackageName(), "nav_invitations")), NAV_TIMEOUT);
        if (invitations == null) throw new AssertionError("Stable Invitations drawer row not found");
        invitations.click();
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

    /**
     * Credential-free parity evidence for the retained Material 3 and legacy
     * routes. This is intentionally separately selectable from store captures.
     */
    private static void setNightModeOnMainThread(int mode) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(
                () -> AppCompatDelegate.setDefaultNightMode(mode));
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }

    @Test
    public void testParityEvidence() {
        int prior = AppCompatDelegate.getDefaultNightMode();
        Context targetContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try {
            setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_NO);
            try (ActivityScenario<io.silentsuite.sync.ui.AboutActivity> scenario =
                         ActivityScenario.launch(io.silentsuite.sync.ui.AboutActivity.class)) {
                waitForAbout(scenario);
                capture("parity-m3-about-light");
                setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_YES);
                scenario.recreate();
                waitForAbout(scenario);
                capture("parity-m3-about-dark");
            }

            setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_NO);
            try (ActivityScenario<io.silentsuite.sync.ui.AppSettingsActivity> scenario =
                         ActivityScenario.launch(io.silentsuite.sync.ui.AppSettingsActivity.Companion.newIntent(targetContext))) {
                waitForGlobalSettings(scenario);
                capture("parity-legacy-app-settings-light");
                setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_YES);
                scenario.recreate();
                waitForGlobalSettings(scenario);
                capture("parity-legacy-app-settings-dark");
            }
        } finally {
            setNightModeOnMainThread(prior);
        }
    }
}
