/*
 * Copyright © SilentSuite contributors.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.webapp

import android.accounts.Account
import android.accounts.AccountManager
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.ServiceWorkerClient
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.ui.BaseActivity
import java.io.ByteArrayInputStream

/**
 * Debug builds only: shows the web app's login and calendar pages from files
 * packaged into the app.
 *
 * The pages are answered locally under the hosted web app's address, because
 * the sync server accepts browser requests from that address only; nothing is
 * ever fetched from that address. The view has no bridge to the app: it signs
 * in separately, and native sync, reminders and widgets do not depend on it.
 * Its stored data lives in a web storage profile of its own, one per Android
 * account (see [WebAppAccountBinding]). Hosted accounts only.
 *
 * Start it with:
 * `adb shell am start -n io.silentsuite.android/io.silentsuite.sync.ui.webapp.WebAppActivity`
 * (add `--es account <name>` when the device has several accounts).
 */
class WebAppActivity : BaseActivity() {
    private var webView: WebView? = null
    private var boundAccount: Account? = null
    private var boundProfile: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val bundle = WebAppBundle.load(assets) ?: return showMessage("This build carries no web bundle.")
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            return showMessage("This screen needs a newer Android System WebView.")
        }
        val account = selectedAccount()
        val profile = account?.let { profileFor(it, bundle) }
        deleteStaleProfiles(profile)
        if (account == null || profile == null) {
            return showMessage("This screen needs one SilentSuite account on the hosted service.")
        }
        boundAccount = account
        boundProfile = profile
        showWebView(bundle, account, profile, savedInstanceState)
    }

    override fun onResume() {
        super.onResume()
        // The account may have been removed, or removed and added again, while this screen was away.
        val account = boundAccount ?: return
        val bundle = WebAppBundle.load(assets)
        val stillBound = bundle != null && accountExists(account) && profileFor(account, bundle) == boundProfile
        if (!stillBound) {
            destroyWebView()
            deleteStaleProfiles(null)
            finish()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onDestroy() {
        destroyWebView()
        super.onDestroy()
    }

    private fun selectedAccount(): Account? {
        val accounts = AccountManager.get(this).getAccountsByType(App.accountType)
        val requested = intent.getStringExtra(EXTRA_ACCOUNT)
        return if (requested != null) accounts.firstOrNull { it.name == requested } else accounts.singleOrNull()
    }

    private fun accountExists(account: Account) =
        AccountManager.get(this).getAccountsByType(App.accountType).contains(account)

    /** The account's profile name, or null when it is not a hosted account or has no creation ID. */
    private fun profileFor(account: Account, bundle: WebAppBundle): String? {
        val manager = AccountManager.get(this)
        val server = manager.getUserData(account, AccountSettings.KEY_URI)
        if (!WebAppAccountBinding.isHostedAccount(server, Constants.etebaseServiceUrl, bundle.syncServerOrigin)) return null
        return WebAppAccountBinding.profileName(account.type, account.name, manager.getUserData(account, AccountSettings.KEY_CREATION_ID))
    }

    private fun deleteStaleProfiles(current: String?) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
        val store = ProfileStore.getInstance()
        for (name in WebAppAccountBinding.staleProfiles(store.allProfileNames, current)) {
            try {
                store.deleteProfile(name)
            } catch (_: IllegalStateException) {
                // Still in use by another instance of this screen; the next start deletes it.
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebView(bundle: WebAppBundle, account: Account, profile: String, savedInstanceState: Bundle?) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
        val policy = WebAppRequestPolicy(bundle.origin, bundle.connectOrigins, bundle.paths)
        val view = WebView(this)
        // Must happen before the view does anything else.
        ProfileStore.getInstance().getOrCreateProfile(profile)
        WebViewCompat.setProfile(view, profile)
        WebViewCompat.getProfile(view).serviceWorkerController.setServiceWorkerClient(object : ServiceWorkerClient() {
            // The bundle registers no service worker; one that appears anyway gets nothing.
            override fun shouldInterceptRequest(request: WebResourceRequest) = blocked()
        })

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            setGeolocationEnabled(false)
            // The person signs in with the web app's own form; the view offers to save nothing.
            saveFormData = false
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                when (val decision = policy.request(request.url.toString(), request.method, request.isForMainFrame)) {
                    is WebAppRequestPolicy.Request.Bundled -> bundled(bundle, decision.path, 200, "OK")
                    WebAppRequestPolicy.Request.NotFound -> bundled(bundle, bundle.notFoundPath, 404, "Not Found")
                    WebAppRequestPolicy.Request.MethodNotAllowed -> empty(405, "Method Not Allowed")
                    WebAppRequestPolicy.Request.Network -> null
                    WebAppRequestPolicy.Request.Blocked -> blocked()
                }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return true
                when (policy.navigation(request.url.toString(), request.hasGesture(), request.isRedirect)) {
                    WebAppRequestPolicy.Navigation.IN_APP -> return false
                    WebAppRequestPolicy.Navigation.EXTERNAL_BROWSER -> openInBrowser(request.url)
                    WebAppRequestPolicy.Navigation.BLOCKED -> Unit
                }
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The view cannot be used again; close the screen instead of crashing the app.
                destroyWebView()
                finish()
                return true
            }
        }
        // The default client denies every permission request, file chooser and new window.
        view.webChromeClient = WebChromeClient()

        val container = FrameLayout(this)
        container.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            // BaseActivity pads the content for the system bars; the keyboard is left to this view.
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom
            v.setPadding(0, 0, 0, (keyboard - bars).coerceAtLeast(0))
            insets
        }
        setContentView(container)
        webView = view

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (view.canGoBack()) {
                    view.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (savedInstanceState == null || view.restoreState(savedInstanceState) == null) {
            // The fragment tells the login page which account this view belongs to.
            view.loadUrl(bundle.originUrl + bundle.startPath + "#android-account=" + Uri.encode(account.name))
        }
    }

    private fun bundled(bundle: WebAppBundle, path: String, status: Int, reason: String): WebResourceResponse {
        val file = bundle.file(path) ?: return empty(404, "Not Found")
        val headers = HashMap<String, String>()
        headers["X-Content-Type-Options"] = "nosniff"
        headers["Referrer-Policy"] = "no-referrer"
        headers["Cache-Control"] = "no-store"
        file.contentSecurityPolicy?.let { headers["Content-Security-Policy"] = it }
        val stream = try { bundle.open(file) } catch (_: Exception) { return empty(404, "Not Found") }
        return WebResourceResponse(file.contentType, if (isText(file.contentType)) "utf-8" else null, status, reason, headers, stream)
    }

    private fun isText(contentType: String) =
        contentType.startsWith("text/") || contentType == "application/json" || contentType == "image/svg+xml"

    private fun blocked() = empty(403, "Forbidden")

    private fun empty(status: Int, reason: String) = WebResourceResponse(
        "text/plain", "utf-8", status, reason,
        mapOf("Content-Security-Policy" to "default-src 'none'", "Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0)),
    )

    private fun openInBrowser(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            // No browser: the link simply does not open.
        }
    }

    private fun destroyWebView() {
        val view = webView ?: return
        webView = null
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    private fun showMessage(message: String) {
        val text = TextView(this)
        text.text = message
        text.gravity = Gravity.CENTER
        val padding = (24 * resources.displayMetrics.density).toInt()
        text.setPadding(padding, padding, padding, padding)
        setContentView(text)
    }

    companion object {
        /** Name of the account to open; without it the device's only account is used. */
        const val EXTRA_ACCOUNT = "account"
    }
}
