package io.silentsuite.sync.ui

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.*
import android.widget.ProgressBar
import android.widget.Toast
import androidx.appcompat.app.ActionBar
import androidx.activity.OnBackPressedCallback
import androidx.annotation.VisibleForTesting
import io.silentsuite.sync.BuildConfig
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R

class WebViewActivity : BaseActivity() {

    private var mWebView: WebView? = null
    private var mProgressBar: ProgressBar? = null
    private var mToolbar: ActionBar? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_webview)

        mToolbar = supportActionBar
        mToolbar!!.setDisplayHomeAsUpEnabled(true)

        val initialUri = intent.getParcelableExtra<Uri>(EXTRA_URL)
        if (initialUri == null || !isAllowedUrl(initialUri)) {
            finish()
            return
        }
        // Only debug instrumentation can replace the first page. Release builds always load
        // the validated production URI below, even if an untrusted caller supplies this extra.
        val debugInitialHtml = if (BuildConfig.DEBUG) intent.getStringExtra(EXTRA_DEBUG_INITIAL_HTML) else null
        var uri = initialUri
        uri = addQueryParams(uri)
        mWebView = findViewById<View>(R.id.webView) as WebView
        mProgressBar = findViewById<View>(R.id.progressBar) as ProgressBar

        mWebView!!.settings.javaScriptEnabled = true
        mWebView!!.settings.allowFileAccess = false
        mWebView!!.settings.allowContentAccess = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            mWebView!!.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (mWebView!!.canGoBack()) {
                    mWebView!!.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
        mWebView!!.webViewClient = if (BuildConfig.DEBUG) {
            debugWebViewClientOverride ?: createWebViewClient()
        } else {
            createWebViewClient()
        }
        if (savedInstanceState == null) {
            if (debugInitialHtml != null) {
                mWebView!!.loadDataWithBaseURL(DEBUG_INITIAL_HTML_BASE_URL, debugInitialHtml, "text/html", "UTF-8", null)
            } else {
                mWebView!!.loadUrl(uri.toString())
            }
        }

        mWebView!!.webChromeClient = object : WebChromeClient() {

            override fun onProgressChanged(view: WebView, progress: Int) {
                if (progress == 100) {
                    mToolbar!!.title = view.title
                    mProgressBar!!.visibility = View.INVISIBLE
                } else {
                    mToolbar!!.setTitle(R.string.loading)
                    mProgressBar!!.visibility = View.VISIBLE
                    mProgressBar!!.progress = progress
                }
            }
        }
    }

    private fun createWebViewClient() = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
            title = view.title
        }

        override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
            return shouldOverrideUrl(Uri.parse(url))
        }

        @TargetApi(Build.VERSION_CODES.LOLLIPOP)
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            return shouldOverrideUrl(request.url)
        }

        override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) {
            loadErrorPage(failingUrl)
        }

        @TargetApi(Build.VERSION_CODES.LOLLIPOP)
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            loadErrorPage(request.url.toString())
        }
    }

    private fun addQueryParams(uri: Uri): Uri {
        return uri.buildUpon().appendQueryParameter(QUERY_KEY_EMBEDDED, "1").build()
    }

    private fun loadErrorPage(failingUrl: String) {
        val htmlData = "<html><title>" +
                getString(R.string.loading_error_title) +
                "</title>" +
                "<style>" +
                ".btn {" +
                "    display: inline-block;" +
                "    padding: 6px 12px;" +
                "    font-size: 20px;" +
                "    font-weight: 400;" +
                "    line-height: 1.42857143;" +
                "    text-align: center;" +
                "    white-space: nowrap;" +
                "    vertical-align: middle;" +
                "    touch-action: manipulation;" +
                "    cursor: pointer;" +
                "    user-select: none;" +
                "    border: 1px solid #ccc;" +
                "    border-radius: 4px;" +
                "    color: #333;" +
                "    text-decoration: none;" +
                "    margin-top: 50px;" +
                "}" +
                "</style>" +
                "<body>" +
                "<div align=\"center\">" +
                "<a class=\"btn\" href=\"" + android.text.TextUtils.htmlEncode(failingUrl) + "\">" + getString(R.string.loading_error_content) +
                "</a>" +
                "</form></body></html>"

        mWebView!!.loadDataWithBaseURL("about:blank", htmlData, "text/html", "UTF-8", null)
        mWebView!!.invalidate()
    }

    private fun shouldOverrideUrl(_uri: Uri): Boolean {
        var uri = _uri
        if (isAllowedUrl(uri)) {
            if (uri.getQueryParameter(QUERY_KEY_EMBEDDED) != null) {
                return false
            } else {
                uri = addQueryParams(uri)
                mWebView!!.loadUrl(uri.toString())
                return true
            }
        } else {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(this, getString(R.string.open_url_no_activity), Toast.LENGTH_LONG).show()
            }
            return true
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        mWebView!!.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        mWebView!!.restoreState(savedInstanceState)
    }

    companion object {

        @VisibleForTesting
        internal const val EXTRA_URL = "url"
        @VisibleForTesting
        internal const val EXTRA_DEBUG_INITIAL_HTML = "io.silentsuite.sync.ui.WebViewActivity.DEBUG_INITIAL_HTML"
        private const val DEBUG_INITIAL_HTML_BASE_URL = "https://silentsuite.invalid/runtime-page-one"
        private val QUERY_KEY_EMBEDDED = "embedded"

        /** Debug-only instrumentation seam; release builds never read this value. */
        @VisibleForTesting
        @Volatile
        internal var debugWebViewClientOverride: WebViewClient? = null

        fun openUrl(context: Context, uri: Uri) {
            if (isAllowedUrl(uri)) {
                val intent = Intent(context, WebViewActivity::class.java)
                intent.putExtra(EXTRA_URL, uri)
                context.startActivity(intent)
            } else {
                try {
                    context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (e: ActivityNotFoundException) {
                    Toast.makeText(context, context.getString(R.string.open_url_no_activity), Toast.LENGTH_LONG).show()
                }
            }
        }

        private fun uriEqual(uri1: Uri, uri2: Uri): Boolean {
            return uri1.host == uri2.host && uri1.path == uri2.path
        }

        private fun allowedUris(allowedUris: Array<Uri>, uri2: Uri): Boolean {
            for (uri in allowedUris) {
                if (uriEqual(uri, uri2)) {
                    return true
                }
            }
            return false
        }

        private fun isAllowedUrl(uri: Uri): Boolean {
            val allowedUris = arrayOf(
                    Constants.faqUri,
                    Constants.helpUri,
                    Constants.registrationUrl,
                    Constants.dashboard,
                    Constants.webUri.buildUpon().appendEncodedPath("tos/").build(),
                    Constants.webUri.buildUpon().appendEncodedPath("about/").build(),
                    Constants.pricing,
            )
            val accountsUri = Constants.webUri.buildUpon().appendEncodedPath("accounts/").build()

            return allowedUris(allowedUris, uri) || (
                    uri.host == accountsUri.host && uri.path!!.startsWith(accountsUri.path!!)
                    ) || (
                    uri.host == Constants.etebaseDashboardPrefix.host && uri.path!!.startsWith(Constants.etebaseDashboardPrefix.path!!)
                    )
        }
    }
}
