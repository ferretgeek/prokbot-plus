package dev.grokbot.local

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Hosts the workspace page and supplies the window functions it needs. */
class MainActivity : Activity() {
    private val app get() = GrokBotApp.of(this)
    private lateinit var container: FrameLayout
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingDocument: CompletableFuture<Uri?>? = null
    private var pendingNotificationPermission: CompletableFuture<Boolean>? = null
    private var pendingMediaRequest: PermissionRequest? = null
    @Volatile var pendingAgent: String? = null
        private set
    private var debugging = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app.host = this
        debugging = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 || debugRequested(intent)
        if (debugging) WebView.setWebContentsDebuggingEnabled(true)
        layoutEdgeToEdge()
        container = FrameLayout(this)
        container.setOnApplyWindowInsetsListener { view, insets -> applyInsets(view, insets) }
        web = createWebView()
        container.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(container)
        // A replaced APK brings new interface files under the same names; start from an empty cache.
        val prefs = getSharedPreferences("webview", MODE_PRIVATE)
        if (prefs.getString("assetTag", null) != app.gateway.assetTag) {
            web.clearCache(true)
            prefs.edit().putString("assetTag", app.gateway.assetTag).apply()
        }
        val dark = systemDark()
        applyChrome(dark, if (dark) "#111111" else "#ffffff")
        pendingAgent = agentFrom(intent?.data)
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        }
        load(if (app.gateway.connection != null) Page.WORKSPACE else Page.CONNECTION)
        NotificationService.sync(app)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!debugging && debugRequested(intent)) {
            debugging = true
            WebView.setWebContentsDebuggingEnabled(true)
        }
        agentFrom(intent.data)?.let(::focusAgent)
    }

    override fun onResume() {
        super.onResume()
        app.inForeground = true
        emit("focus", JSONObject().put("focused", true))
    }

    override fun onPause() {
        app.inForeground = false
        emit("focus", JSONObject().put("focused", false))
        super.onPause()
    }

    override fun onDestroy() {
        if (app.host === this) app.host = null
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        pendingMediaRequest?.deny()
        pendingMediaRequest = null
        pendingDocument?.complete(null)
        pendingNotificationPermission?.complete(false)
        web.destroy()
        super.onDestroy()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        emit("system-theme", JSONObject().put("dark", systemDark()))
    }

    @Deprecated("Used below Android 13")
    override fun onBackPressed() = handleBack()

    // ---- pages ----------------------------------------------------------------------------

    private enum class Page(val path: String) {
        WORKSPACE("/app/renderer/index.html"),
        CONNECTION("/app/client/connect.html"),
    }

    private var page = Page.CONNECTION

    private fun load(next: Page) {
        val hasInterface = try { assets.list("web/renderer")?.contains("index.html") == true } catch (_: Exception) { false }
        if (!hasInterface) {
            val message = getString(R.string.missing_interface)
            web.loadDataWithBaseURL(null, "<!doctype html><meta name=viewport content='width=device-width'>" +
                "<body style='font:16px sans-serif;padding:32px;background:#111;color:#eee'>${android.text.Html.escapeHtml(message)}</body>",
                "text/html", "utf-8", null)
            return
        }
        page = next
        val gateway = app.gateway
        CookieManager.getInstance().setCookie(gateway.appOrigin, gateway.cookie) {
            CookieManager.getInstance().flush()
            web.loadUrl(gateway.appOrigin + next.path)
        }
    }

    fun showConnection() = runOnUiThread { load(Page.CONNECTION) }

    fun showWorkspaceSoon() = runOnUiThread { web.postDelayed({ load(Page.WORKSPACE) }, 200) }

    fun reloadWorkspace() = runOnUiThread { load(if (app.gateway.connection != null) Page.WORKSPACE else Page.CONNECTION) }

    private fun handleBack() {
        web.evaluateJavascript("window.__grokbotAndroid ? window.__grokbotAndroid.back() : 'exit'") { result ->
            when (result?.trim('"')) {
                "handled" -> Unit
                "workspace" -> if (app.gateway.connection != null) load(Page.WORKSPACE) else moveTaskToBack(true)
                else -> moveTaskToBack(true)
            }
        }
    }

    // ---- WebView ----------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val view = WebView(this)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = false
            textZoom = 100
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString GrokBotLocal/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.overScrollMode = View.OVER_SCROLL_NEVER
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        view.setDownloadListener { url, _, _, _, _ ->
            val uri = Uri.parse(url)
            if (uri.scheme == "http" || uri.scheme == "https") app.openExternal(uri)
        }
        return view
    }

    private fun recreateWebView() {
        container.removeView(web)
        web.destroy()
        web = createWebView()
        container.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        load(page)
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val loopback = uri.scheme == "http" && uri.host == "127.0.0.1"
            if (loopback && uri.port == app.gateway.appPort) return false
            // The Bot computer view loads in a frame of its own origin, never as the page.
            if (loopback && uri.port == app.gateway.vncPort) return request.isForMainFrame
            if (uri.scheme == "grokbot-local") {
                agentFrom(uri)?.let(::focusAgent)
                return true
            }
            if (uri.scheme == "http" || uri.scheme == "https" || uri.scheme == "mailto") app.openExternal(uri)
            return true
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "WebView renderer gone; crashed=${detail.didCrash()}")
            if (view === web) recreateWebView()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            val types = params.acceptTypes.flatMap { it.split(',') }.map { it.trim() }.filter { it.isNotEmpty() }
                .map { if (it.startsWith('.')) MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.drop(1).lowercase()) ?: "*/*" else it }
                .distinct()
            val intent = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
            intent.type = if (types.size == 1) types.first() else "*/*"
            if (types.size > 1 && "*/*" !in types) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            return try {
                startActivityForResult(Intent.createChooser(intent, null), REQUEST_FILES)
                true
            } catch (_: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                val origin = request.origin
                val ours = origin.scheme == "http" && origin.host == "127.0.0.1" && origin.port == app.gateway.appPort
                if (!ours || PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) {
                    request.deny()
                    return@runOnUiThread
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    pendingMediaRequest?.deny()
                    pendingMediaRequest = request
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
                }
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingMediaRequest === request) pendingMediaRequest = null
        }

        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (debugging) Log.d("GrokBotWeb", "${message.messageLevel()} ${message.message()} @${message.sourceId()}:${message.lineNumber()}")
            return true
        }
    }

    // ---- results and permissions -------------------------------------------------------------

    @Deprecated("Framework activity results")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        when (requestCode) {
            REQUEST_FILES -> {
                val callback = fileCallback
                fileCallback = null
                callback?.onReceiveValue(if (resultCode == RESULT_OK) selectedUris(data) else null)
            }
            REQUEST_SAVE -> {
                pendingDocument?.complete(if (resultCode == RESULT_OK) data?.data else null)
                pendingDocument = null
            }
            else -> super.onActivityResult(requestCode, resultCode, data)
        }
    }

    private fun selectedUris(data: Intent?): Array<Uri>? {
        val clip = data?.clipData
        if (clip != null && clip.itemCount > 0) return Array(clip.itemCount) { clip.getItemAt(it).uri }
        return data?.data?.let { arrayOf(it) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        val granted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        when (requestCode) {
            REQUEST_AUDIO -> {
                pendingMediaRequest?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
                pendingMediaRequest = null
            }
            REQUEST_NOTIFICATIONS -> {
                pendingNotificationPermission?.complete(granted)
                pendingNotificationPermission = null
            }
        }
    }

    /** Called on a gateway thread; waits for the system save dialog. */
    fun createDocument(name: String, mime: String): Uri? {
        val future = CompletableFuture<Uri?>()
        runOnUiThread {
            if (pendingDocument != null) {
                future.complete(null)
                return@runOnUiThread
            }
            pendingDocument = future
            try {
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mime).putExtra(Intent.EXTRA_TITLE, name), REQUEST_SAVE)
            } catch (_: ActivityNotFoundException) {
                pendingDocument = null
                future.complete(null)
            }
        }
        return try { future.get(30, TimeUnit.MINUTES) } catch (_: Exception) { null }
    }

    /** Called on a gateway thread; asks once for notification permission on Android 13+. */
    fun requestNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < 33) return getSystemService(android.app.NotificationManager::class.java).areNotificationsEnabled()
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return true
        val future = CompletableFuture<Boolean>()
        runOnUiThread {
            pendingNotificationPermission?.complete(false)
            pendingNotificationPermission = future
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        }
        return try { future.get(5, TimeUnit.MINUTES) } catch (_: Exception) { false }
    }

    // ---- window chrome, insets and events ----------------------------------------------------

    fun systemDark() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    fun applyChrome(dark: Boolean, background: String) = runOnUiThread {
        val color = try { Color.parseColor(background) } catch (_: Exception) { if (dark) Color.BLACK else Color.WHITE }
        container.setBackgroundColor(color)
        web.setBackgroundColor(color)
        window.setBackgroundDrawable(ColorDrawable(color))
        if (Build.VERSION.SDK_INT >= 30) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)
        } else {
            @Suppress("DEPRECATION")
            val flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (dark) window.decorView.systemUiVisibility and flags.inv()
            else window.decorView.systemUiVisibility or flags
        }
    }

    private fun layoutEdgeToEdge() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
    }

    private fun applyInsets(view: View, insets: WindowInsets): WindowInsets {
        if (Build.VERSION.SDK_INT >= 30) {
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            return WindowInsets.CONSUMED
        }
        @Suppress("DEPRECATION")
        view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
        @Suppress("DEPRECATION")
        return insets.consumeSystemWindowInsets()
    }

    private fun emit(type: String, payload: JSONObject) {
        val event = JSONObject().put("type", type).put("payload", payload)
        runOnUiThread {
            if (::web.isInitialized) web.evaluateJavascript("window.__grokbotAndroid && window.__grokbotAndroid.event($event)", null)
        }
    }

    private fun focusAgent(id: String) {
        pendingAgent = id
        emit("focus-agent", JSONObject().put("id", id))
    }

    fun takePendingAgent(): String? {
        val value = pendingAgent
        pendingAgent = null
        return value
    }

    private fun agentFrom(uri: Uri?): String? {
        if (uri == null || uri.scheme != "grokbot-local" || uri.host != "agent") return null
        val id = uri.pathSegments.singleOrNull() ?: return null
        return id.takeIf { AGENT_ID.matches(it) }
    }

    /** WebView inspection for diagnostics: only when developer options and USB debugging are on. */
    private fun debugRequested(intent: Intent?): Boolean {
        if (intent?.getBooleanExtra("grokbot_webview_debug", false) != true) return false
        val developer = Settings.Global.getInt(contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1
        val adb = Settings.Global.getInt(contentResolver, Settings.Global.ADB_ENABLED, 0) == 1
        return developer && adb
    }

    private companion object {
        const val TAG = "GrokBot"
        const val REQUEST_FILES = 1
        const val REQUEST_SAVE = 2
        const val REQUEST_AUDIO = 3
        const val REQUEST_NOTIFICATIONS = 4
        val AGENT_ID = Regex("^[A-Za-z0-9_-]{1,128}$")
    }
}
