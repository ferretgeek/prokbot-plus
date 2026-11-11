package dev.grokbot.local

import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Native functions for the workspace page, served on the app origin only. The page
 * reaches them with same-origin fetch; nothing is injected into frames, so the Bot
 * computer view and other embedded content cannot call them.
 */
class NativeEndpoints(private val app: GrokBotApp, private val gateway: LocalGateway) {
    private class PendingSave(val uri: Uri, val stream: OutputStream)
    private val saves = ConcurrentHashMap<String, PendingSave>()

    fun bootScript(): ByteArray {
        val boot = JSONObject()
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("systemLocale", Locale.getDefault().toLanguageTag())
            .put("locale", app.settings.resolvedLocale())
            .put("systemDark", systemDark())
            .put("deviceName", Pairing.deviceName(app))
            .put("appOrigin", gateway.appOrigin)
            .put("vncOrigin", gateway.vncOrigin)
            .put("connection", status())
            .put("settings", app.settings.snapshot())
            .put("persistence", app.settings.persistence())
            .put("pendingAgent", app.host?.pendingAgent ?: JSONObject.NULL)
        // `</` cannot appear inside the JSON literal of a script file served as JavaScript.
        return "window.__grokbotAndroidBoot = ${boot.toString().replace("</", "<\\/")};\n".toByteArray()
    }

    fun systemDark(): Boolean =
        (app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    fun status(): JSONObject {
        val connection = gateway.connection
        val error = when (app.connections.lastError) {
            "credential" -> Text.t(app, "无法读取设备凭证，请重新配对。", "Could not read device credentials. Pair again.")
            "unauthorized" -> Text.t(app, "连接已失效，请重新配对。", "Connection expired. Pair again.")
            else -> ""
        }
        return JSONObject()
            .put("paired", connection != null)
            .put("connected", connection != null)
            .put("server", connection?.server ?: JSONObject.NULL)
            .put("deviceId", connection?.deviceId ?: JSONObject.NULL)
            .put("tailcat", false)
            .put("transportPath", "direct")
            .put("error", error)
    }

    fun handle(head: HttpHead, input: InputStream, output: OutputStream, name: String): Boolean {
        if (head.method != "POST" && !(head.method == "GET" && name == "status")) throw HttpFailure(405, "Method not allowed")
        if (name == "save-chunk") {
            val id = Uri.parse("http://x${head.target}").getQueryParameter("id") ?: throw HttpFailure(400, "Missing id")
            val bytes = Http.readBody(input, head, 16L * 1024 * 1024)
            val pending = saves[id] ?: throw HttpFailure(404, "Unknown download")
            pending.stream.write(bytes)
            Http.json(output, 200, "{\"ok\":true}")
            return true
        }
        val raw = Http.readBody(input, head, 4L * 1024 * 1024)
        val body = if (raw.isEmpty()) JSONObject() else try { JSONObject(raw.decodeToString()) } catch (_: Exception) { throw HttpFailure(400, "Invalid JSON") }
        val result = try {
            call(name, body)
        } catch (failure: HttpFailure) {
            throw failure
        } catch (error: PairingException) {
            JSONObject().put("ok", false).put("error", error.message)
        } catch (error: IllegalArgumentException) {
            throw HttpFailure(400, error.message ?: "Invalid request")
        } catch (error: Exception) {
            Log.e(TAG, "native $name failed", error)
            JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName)
        }
        Http.json(output, 200, result.toString())
        return true
    }

    private fun call(name: String, body: JSONObject): JSONObject = when (name) {
        "status" -> status()
        "pair" -> pair(body)
        "disconnect" -> {
            app.connections.clear()
            app.connections.lastError = null
            gateway.connection = null
            NotificationService.sync(app)
            Notifications.cancelAll(app)
            app.host?.showConnection()
            JSONObject().put("ok", true)
        }
        "unauthorized" -> {
            app.connections.lastError = "unauthorized"
            app.host?.showConnection()
            JSONObject().put("ok", true)
        }
        "settings" -> {
            val key = body.getString("key")
            val snapshot = app.settings.update(key, body.opt("value"))
            if (key == "backgroundNotifications") NotificationService.sync(app)
            // Notification texts follow the language chosen in the app.
            if (key == "language") { Notifications.createChannels(app); NotificationService.sync(app) }
            JSONObject().put("ok", true).put("settings", snapshot)
        }
        "persistence" -> {
            app.settings.applyPersistence(body.optJSONArray("ops") ?: JSONArray())
            JSONObject().put("ok", true)
        }
        "theme" -> {
            val background = body.optString("background", "#111111")
            require(Regex("^#[0-9a-fA-F]{6}$").matches(background)) { "Invalid color" }
            app.host?.applyChrome(body.optBoolean("dark", true), background)
            JSONObject().put("ok", true).put("systemDark", systemDark())
        }
        "open-external" -> {
            val url = body.getString("url")
            val uri = Uri.parse(url)
            require(url.length <= 16384 && uri.scheme in listOf("http", "https", "mailto") && uri.userInfo == null) { "Invalid link" }
            app.openExternal(uri)
            JSONObject().put("ok", true)
        }
        "viewing-agent" -> {
            val id = body.optString("agentId", "").takeIf { AGENT_ID.matches(it) }
            app.viewingAgentId = id
            if (id != null) Notifications.cancelAgent(app, id)
            JSONObject().put("ok", true)
        }
        "ready" -> JSONObject().put("pendingAgent", app.host?.takePendingAgent() ?: JSONObject.NULL)
        "reload" -> {
            app.host?.reloadWorkspace()
            JSONObject().put("ok", true)
        }
        "notification-permission" -> JSONObject().put("granted", app.host?.requestNotificationPermission() ?: false)
        "save-begin" -> saveBegin(body)
        "save-end" -> saveEnd(body)
        "log" -> {
            Log.i("GrokBotWeb", body.optString("message").take(4000))
            JSONObject().put("ok", true)
        }
        else -> throw HttpFailure(404, "Unknown native call")
    }

    private fun pair(body: JSONObject): JSONObject {
        val server = body.optString("server")
        val next = if (body.optBoolean("edit")) {
            val current = gateway.connection ?: throw PairingException(Text.t(app, "尚未连接。", "Not connected."))
            Pairing.verify(app, server, current)
        } else {
            Pairing.pair(app, server, body.optString("key"))
        }
        app.connections.save(next)
        app.connections.lastError = null
        gateway.connection = next
        NotificationService.sync(app)
        app.host?.showWorkspaceSoon()
        // Bot replies arrive as notifications; Android 13+ asks once, after the first pairing.
        if (app.settings.backgroundNotifications) Thread({
            if (app.host?.requestNotificationPermission() == true) NotificationService.sync(app)
        }, "grokbot-permission").apply { isDaemon = true; start() }
        return JSONObject().put("ok", true)
    }

    private fun saveBegin(body: JSONObject): JSONObject {
        val name = body.getString("name").replace(Regex("[/\\\\\\u0000-\\u001f]"), "_").take(200).ifEmpty { "download" }
        val mime = body.optString("mime").takeIf { Regex("^[\\w.+-]+/[\\w.+-]+$").matches(it) } ?: "application/octet-stream"
        val host = app.host ?: return JSONObject().put("cancelled", true)
        val uri = host.createDocument(name, mime) ?: return JSONObject().put("cancelled", true)
        val stream = app.contentResolver.openOutputStream(uri, "w") ?: throw IllegalStateException("Cannot write the file")
        val id = UUID.randomUUID().toString()
        saves[id] = PendingSave(uri, stream)
        return JSONObject().put("id", id)
    }

    private fun saveEnd(body: JSONObject): JSONObject {
        val pending = saves.remove(body.getString("id")) ?: throw HttpFailure(404, "Unknown download")
        var complete = false
        try {
            pending.stream.close()
            complete = body.optBoolean("ok")
        } finally {
            if (!complete) try { DocumentsContract.deleteDocument(app.contentResolver, pending.uri) } catch (_: Exception) {}
        }
        return JSONObject().put("ok", true)
    }

    private companion object {
        const val TAG = "GrokBotNative"
        val AGENT_ID = Regex("^[A-Za-z0-9_-]{1,128}$")
    }
}
