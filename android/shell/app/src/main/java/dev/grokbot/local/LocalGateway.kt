package dev.grokbot.local

import android.util.Base64
import android.util.Log
import java.io.BufferedInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.security.SecureRandom
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** The paired Host as seen from this phone. */
class Upstream(val scheme: String, val host: String, val port: Int) {
    private val bracketed = if (host.contains(':')) "[$host]" else host
    private val defaultPort = (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
    val hostHeader = if (defaultPort) bracketed else "$bracketed:$port"
    val origin = "$scheme://$hostHeader"

    fun open(): Socket {
        val plain = Socket()
        try {
            plain.connect(InetSocketAddress(host, port), 10_000)
            plain.tcpNoDelay = true
            if (scheme == "http") return plain
            val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
            val secure = factory.createSocket(plain, host, port, true) as SSLSocket
            // Verify the certificate name; the default socket factory does not.
            secure.sslParameters = secure.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
            secure.soTimeout = 10_000
            secure.startHandshake()
            return secure
        } catch (error: Exception) {
            plain.close()
            throw error
        }
    }

    companion object {
        fun parse(server: String): Upstream {
            val uri = URI(server)
            val scheme = uri.scheme?.lowercase() ?: throw IOException("Invalid Host address")
            require(scheme == "http" || scheme == "https") { "Invalid Host address" }
            val host = uri.host?.removePrefix("[")?.removeSuffix("]") ?: throw IOException("Invalid Host address")
            val port = if (uri.port > 0) uri.port else if (scheme == "https") 443 else 80
            return Upstream(scheme, host, port)
        }
    }
}

/**
 * Loopback gateway between the WebView and the paired Host.
 *
 * - The app port serves the interface (`/app/`), native calls (`/__native/`) and proxies
 *   the device API to the Host, adding the device credential. The page never sees it.
 * - The desktop port proxies only `/vnc/` for the Bot computer view. It is a separate
 *   origin, so the remote desktop page cannot script the workspace or reach the API.
 *
 * `http://127.0.0.1` is a secure context, which the original interface requires.
 * Every request must carry the per-process secret cookie; other apps on the phone
 * cannot read it from this app's WebView.
 */
class LocalGateway(private val app: GrokBotApp) {
    @Volatile var connection: Connection? = null
    val secret: String = ByteArray(32).also { SecureRandom().nextBytes(it) }
        .let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
    var appPort = 0
        private set
    var vncPort = 0
        private set
    val appOrigin get() = "http://127.0.0.1:$appPort"
    val vncOrigin get() = "http://127.0.0.1:$vncPort"
    val cookie get() = "$COOKIE=$secret; Path=/; HttpOnly; SameSite=Strict"

    val assetTag: String = try {
        @Suppress("DEPRECATION")
        val info = app.packageManager.getPackageInfo(app.packageName, 0)
        "\"${info.lastUpdateTime}-${info.longVersionCode}\""
    } catch (_: Exception) {
        "\"${System.currentTimeMillis()}\""
    }
    private val pool = ThreadPoolExecutor(0, 64, 60L, TimeUnit.SECONDS, SynchronousQueue(), { task ->
        Thread(task, "grokbot-gateway").apply { isDaemon = true }
    })
    private val native = NativeEndpoints(app, this)

    fun start() {
        val appSocket = bind(APP_PORTS)
        val vncSocket = bind(VNC_PORTS)
        appPort = appSocket.localPort
        vncPort = vncSocket.localPort
        accept(appSocket, vnc = false)
        accept(vncSocket, vnc = true)
    }

    private fun bind(ports: IntRange): ServerSocket {
        for (port in ports) {
            try {
                return ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(LOOPBACK, port), 64) }
            } catch (_: IOException) {
                // Another app holds this port; the origin only changes when every preferred port is taken.
            }
        }
        return ServerSocket(0, 64, LOOPBACK)
    }

    private fun accept(server: ServerSocket, vnc: Boolean) {
        Thread({
            while (true) {
                val client = try { server.accept() } catch (error: IOException) { Log.e(TAG, "accept", error); continue }
                try { pool.execute { serve(client, vnc) } } catch (_: RejectedExecutionException) { client.close() }
            }
        }, if (vnc) "grokbot-vnc-accept" else "grokbot-app-accept").apply { isDaemon = true }.start()
    }

    private fun serve(client: Socket, vnc: Boolean) {
        try {
            client.use {
                client.tcpNoDelay = true
                val input = BufferedInputStream(client.getInputStream(), 16 * 1024)
                val output = client.getOutputStream()
                var first = true
                while (true) {
                    client.soTimeout = if (first) 30_000 else 15_000
                    first = false
                    val head = try { HttpHead.read(input) } catch (_: SocketTimeoutException) { return } ?: return
                    val keepAlive = try {
                        if (vnc) handleVnc(client, input, output, head) else handleApp(client, input, output, head)
                    } catch (failure: HttpFailure) {
                        Http.error(output, failure.status, failure.message ?: "Request failed")
                        false
                    }
                    if (!keepAlive) return
                }
            }
        } catch (error: IOException) {
            // Usually the WebView closing an idle or cancelled connection.
            Log.d(TAG, "connection ended: ${error.javaClass.simpleName}: ${error.message}")
        } catch (error: Exception) {
            Log.e(TAG, "request failed", error)
        }
    }

    private fun handleApp(client: Socket, input: InputStream, output: OutputStream, head: HttpHead): Boolean {
        if (head["Host"] != "127.0.0.1:$appPort") throw HttpFailure(421, "Unexpected host")
        if (head.cookie(COOKIE) != secret) throw HttpFailure(403, "Missing client credential")
        val origin = head["Origin"]
        if (origin != null && origin != appOrigin) throw HttpFailure(403, "Cross-origin request")
        val site = head["Sec-Fetch-Site"]
        if (site != null && site != "same-origin" && site != "none") throw HttpFailure(403, "Cross-site request")
        val path = head.path
        return when {
            path == "/app/client/boot-data.js" -> {
                val keep = drainBody(input, head)
                Http.respond(output, 200, "text/javascript; charset=utf-8", native.bootScript(), keep,
                    listOf("Cache-Control" to "no-store"), head.method == "HEAD")
                keep
            }
            path.startsWith("/app/") -> serveAsset(input, output, head, path.removePrefix("/app/"))
            // The desktop settings pages load the app icon from the program root, beside the interface.
            path == "/local-client/icon.png" -> serveAsset(input, output, head, "client/icon.png")
            path.startsWith("/__native/") -> native.handle(head, input, output, path.removePrefix("/__native/"))
            PROXIED.any { path == it || path.startsWith("$it/") || path.startsWith("$it?") } || path.startsWith("/api/") -> {
                proxy(client, input, output, head, vnc = false)
                false
            }
            else -> throw HttpFailure(404, "Not found")
        }
    }

    private fun handleVnc(client: Socket, input: InputStream, output: OutputStream, head: HttpHead): Boolean {
        if (head["Host"] != "127.0.0.1:$vncPort") throw HttpFailure(421, "Unexpected host")
        if (head.cookie(COOKIE) != secret) throw HttpFailure(403, "Missing client credential")
        val origin = head["Origin"]
        if (origin != null && origin != vncOrigin) throw HttpFailure(403, "Cross-origin request")
        // The bridge scripts sit next to the noVNC page: code that the original preload runs
        // through webFrame.executeJavaScript imports noVNC modules by page-relative paths.
        val bridgeScript = VNC_BRIDGE_SCRIPT.matchEntire(head.path)
        if (bridgeScript != null) {
            if (head.method != "GET" && head.method != "HEAD") throw HttpFailure(405, "Method not allowed")
            drainBody(input, head)
            val name = bridgeScript.groupValues[2] + ".js"
            val script = try { app.assets.open("web/client/$name").use { it.readBytes() } } catch (_: FileNotFoundException) { throw HttpFailure(404, "Not found") }
            val body = if (name == "vnc-bridge.js") "window.__grokbotAppOrigin = ${org.json.JSONObject.quote(appOrigin)};\n".toByteArray() + script else script
            Http.respond(output, 200, "text/javascript; charset=utf-8", body, true, listOf("Cache-Control" to "no-store"), head.method == "HEAD")
            return true
        }
        // The noVNC page joins its own origin and an absolute socket path with a slash.
        if (head.target.startsWith("//vnc/")) head.startLine = head.startLine.replaceFirst(" //vnc/", " /vnc/")
        if (!VNC_PATH.matches(head.path)) throw HttpFailure(404, "Not found")
        val upgrade = head["Upgrade"].equals("websocket", true)
        if (!upgrade && head.method != "GET" && head.method != "HEAD") throw HttpFailure(405, "Method not allowed")
        proxy(client, input, output, head, vnc = true)
        return false
    }

    private fun drainBody(input: InputStream, head: HttpHead): Boolean {
        Http.readBody(input, head, 1024 * 1024)
        return true
    }

    private fun serveAsset(input: InputStream, output: OutputStream, head: HttpHead, relative: String): Boolean {
        if (head.method != "GET" && head.method != "HEAD") throw HttpFailure(405, "Method not allowed")
        drainBody(input, head)
        val name = decodePath(relative) ?: throw HttpFailure(404, "Not found")
        // Interface files only change when the APK is replaced; the WebView revalidates each
        // load against the install time, so an upgrade never shows files from the old build.
        val cache = listOf("Cache-Control" to "no-cache", "ETag" to assetTag)
        if (head["If-None-Match"] == assetTag) {
            val reply = HttpHead("HTTP/1.1 304 Not Modified", cache.toMutableList())
            reply.headers += "Connection" to "keep-alive"
            output.write(reply.encode())
            output.flush()
            return true
        }
        val bytes = try {
            app.assets.open("web/$name").use { it.readBytes() }
        } catch (_: FileNotFoundException) {
            throw HttpFailure(404, "Not found")
        }
        Http.respond(output, 200, contentType(name), bytes, true, cache, head.method == "HEAD")
        return true
    }

    /** Proxies one request to the Host and streams the reply; the connection is not reused. */
    private fun proxy(client: Socket, input: InputStream, output: OutputStream, head: HttpHead, vnc: Boolean) {
        val current = connection ?: throw HttpFailure(503, Text.t(app, "尚未连接 Host。", "Not connected to a Host."))
        val upstream = Upstream.parse(current.server)
        val upgrade = head["Upgrade"].equals("websocket", true)
        val length = head.requestLength(MAX_PROXY_BODY)

        val forwarded = HttpHead("${head.method} ${head.target} HTTP/1.1", mutableListOf())
        for ((name, value) in head.headers) {
            val lower = name.lowercase()
            if (lower in DROPPED || lower.startsWith("sec-fetch-") || lower.startsWith("proxy-")) continue
            forwarded.headers += name to value
        }
        forwarded["Host"] = upstream.hostHeader
        // The Host checks Origin against its own address; the request did come from this client.
        if (head["Origin"] != null) forwarded["Origin"] = upstream.origin
        if (vnc) {
            val tickets = head.all("Cookie").flatMap { it.split(';') }.map { it.trim() }
                .filter { it.startsWith("grokbot_vnc_") }
            if (tickets.isNotEmpty()) forwarded["Cookie"] = tickets.joinToString("; ")
        } else {
            forwarded["Authorization"] = "Bearer ${current.token}"
        }
        if (upgrade) {
            forwarded["Connection"] = "Upgrade"
            forwarded["Upgrade"] = head["Upgrade"] ?: "websocket"
        } else {
            forwarded["Connection"] = "close"
        }
        // The computer view page gets the bridge that stands in for Electron's webview preload.
        val injectBridge = vnc && head.method == "GET" && VNC_PAGE.matches(head.path)
        if (injectBridge) forwarded["Accept-Encoding"] = "identity"

        val socket = try {
            upstream.open()
        } catch (error: Exception) {
            Log.w(TAG, "Host unreachable: ${error.javaClass.simpleName}")
            throw HttpFailure(502, Text.t(app, "无法连接 Host，请检查网络和地址。", "Cannot reach the Host. Check the network and address."))
        }
        socket.use {
            socket.soTimeout = if (upgrade) 15_000 else 130_000
            val upstreamOutput = socket.getOutputStream()
            val upstreamInput = BufferedInputStream(socket.getInputStream(), 16 * 1024)
            // Until the reply head arrives nothing has been sent to the WebView, so a failed
            // exchange can still be answered instead of leaving it an empty response.
            val reply = try {
                upstreamOutput.write(forwarded.encode())
                copyExactly(input, upstreamOutput, length)
                upstreamOutput.flush()
                HttpHead.read(upstreamInput)
            } catch (error: IOException) {
                Log.w(TAG, "Host exchange failed for ${head.path}: ${error.javaClass.simpleName}: ${error.message}")
                null
            } ?: throw HttpFailure(502, Text.t(app, "Host 没有响应，请稍后重试。", "The Host did not answer. Try again later."))
            val switching = upgrade && reply.status == 101
            if (!switching) {
                reply.remove("Keep-Alive")
                reply["Connection"] = "close"
            }
            if (vnc) {
                val cookies = reply.all("Set-Cookie").map { it.replace(SECURE_ATTRIBUTE, "") }
                reply.remove("Set-Cookie")
                cookies.forEach { reply.headers += "Set-Cookie" to it }
                // The Host forbids framing by other origins; only this app's workspace may frame the view.
                reply.remove("X-Frame-Options")
                reply.remove("Content-Security-Policy")
                reply["Content-Security-Policy"] = "frame-ancestors $appOrigin"
            } else reply.remove("Set-Cookie")
            if (injectBridge && reply.status == 200 && reply["Content-Type"].orEmpty().contains("html", true)) {
                val html = try {
                    readWholeBody(upstreamInput, reply).toString(Charsets.UTF_8)
                } catch (error: IOException) {
                    Log.w(TAG, "Computer view page incomplete: ${error.javaClass.simpleName}: ${error.message}")
                    throw HttpFailure(502, Text.t(app, "Host 没有响应，请稍后重试。", "The Host did not answer. Try again later."))
                }
                val directory = head.path.substringBeforeLast('/')
                val tags = "<script src=\"$directory/__grokbot-vnc-bridge.js\"></script><script src=\"$directory/__grokbot-vnc-preload.js\"></script>"
                val opening = HEAD_TAG.find(html)
                val patched = if (opening != null) html.substring(0, opening.range.last + 1) + tags + html.substring(opening.range.last + 1) else tags + html
                val bytes = patched.toByteArray(Charsets.UTF_8)
                reply.remove("Transfer-Encoding")
                reply.remove("Content-Encoding")
                reply["Content-Length"] = bytes.size.toString()
                output.write(reply.encode())
                output.write(bytes)
                output.flush()
                return
            }
            output.write(reply.encode())
            output.flush()
            if (switching) {
                socket.soTimeout = 0
                client.soTimeout = 0
                val upward = Thread({
                    try { pump(input, upstreamOutput) } catch (_: IOException) {}
                    try { socket.shutdownOutput() } catch (_: IOException) {}
                }, "grokbot-ws-up").apply { isDaemon = true; start() }
                try { pump(upstreamInput, output) } catch (_: IOException) {}
                try { client.shutdownOutput() } catch (_: IOException) {}
                upward.join(2_000)
            } else {
                try { pump(upstreamInput, output) } catch (_: SocketTimeoutException) {}
            }
        }
    }

    private fun readLine(input: InputStream): String? {
        val line = java.io.ByteArrayOutputStream()
        while (true) {
            val value = input.read()
            if (value < 0) return if (line.size() == 0) null else line.toString("ISO-8859-1")
            if (value == '\n'.code) return line.toString("ISO-8859-1").trimEnd('\r')
            line.write(value)
            if (line.size() > 4096) throw IOException("Line too long")
        }
    }

    /** Reads a complete small reply body: fixed length, chunked or until the Host closes. */
    private fun readWholeBody(input: InputStream, reply: HttpHead): ByteArray {
        val body = java.io.ByteArrayOutputStream()
        val limit = 4L * 1024 * 1024
        if (reply["Transfer-Encoding"]?.contains("chunked", true) == true) {
            while (true) {
                val size = readLine(input)?.substringBefore(';')?.trim()?.toLongOrNull(16) ?: throw IOException("Bad chunk")
                if (size == 0L) {
                    while (!readLine(input).isNullOrEmpty()) Unit
                    break
                }
                if (body.size() + size > limit) throw IOException("Page too large")
                copyExactly(input, body, size)
                readLine(input)
            }
        } else {
            val length = reply["Content-Length"]?.toLongOrNull()
            if (length != null) {
                if (length > limit) throw IOException("Page too large")
                copyExactly(input, body, length)
            } else {
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    body.write(buffer, 0, read)
                    if (body.size() > limit) throw IOException("Page too large")
                }
            }
        }
        return body.toByteArray()
    }

    /** Copies until EOF and flushes every read so event streams arrive immediately. */
    private fun pump(from: InputStream, to: OutputStream) {
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val read = from.read(buffer)
            if (read < 0) return
            to.write(buffer, 0, read)
            to.flush()
        }
    }

    private fun copyExactly(from: InputStream, to: OutputStream, length: Long) {
        val buffer = ByteArray(64 * 1024)
        var remaining = length
        while (remaining > 0) {
            val read = from.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
            if (read < 0) throw IOException("Request body ended early")
            to.write(buffer, 0, read)
            remaining -= read
        }
    }

    companion object {
        private const val TAG = "GrokBotGateway"
        const val COOKIE = "grokbot_app"
        private val LOOPBACK: InetAddress = InetAddress.getByAddress("localhost", byteArrayOf(127, 0, 0, 1))
        private val APP_PORTS = 39710..39719
        private val VNC_PORTS = 39720..39729
        private const val MAX_PROXY_BODY = 64L * 1024 * 1024
        private val PROXIED = listOf("/events", "/local", "/connect", "/notifications")
        private val DROPPED = setOf(
            "host", "connection", "keep-alive", "upgrade", "te", "trailer", "origin", "referer", "cookie",
            "authorization", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-grokbot-tailcat-ingress",
        )
        private val VNC_PATH = Regex("^/vnc/(desktop|fork)/[A-Za-z0-9_.@/-]*$")
        private val VNC_PAGE = Regex("^/vnc/(desktop|fork)/vnc(_lite|_auto)?\\.html$")
        private val VNC_BRIDGE_SCRIPT = Regex("^/vnc/(desktop|fork)/__grokbot-(vnc-bridge|vnc-preload)\\.js$")
        private val HEAD_TAG = Regex("<head(\\s[^>]*)?>", RegexOption.IGNORE_CASE)
        private val SECURE_ATTRIBUTE = Regex(";\\s*Secure\\b", RegexOption.IGNORE_CASE)

        fun decodePath(value: String): String? {
            val decoded = try { java.net.URLDecoder.decode(value.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { return null }
            if (decoded.isEmpty() || decoded.startsWith('/') || decoded.contains('\\') || decoded.contains('\u0000')) return null
            if (decoded.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
            return decoded
        }

        fun contentType(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html; charset=utf-8"
            "js", "mjs" -> "text/javascript; charset=utf-8"
            "css" -> "text/css; charset=utf-8"
            "json", "map" -> "application/json; charset=utf-8"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "ico" -> "image/x-icon"
            "woff2" -> "font/woff2"
            "woff" -> "font/woff"
            "ttf" -> "font/ttf"
            "otf" -> "font/otf"
            "wav" -> "audio/wav"
            "mp3" -> "audio/mpeg"
            "ogg" -> "audio/ogg"
            "mp4" -> "video/mp4"
            "webm" -> "video/webm"
            "wasm" -> "application/wasm"
            "txt", "md" -> "text/plain; charset=utf-8"
            else -> "application/octet-stream"
        }
    }
}
