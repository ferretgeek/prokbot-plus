package dev.grokbot.local

import android.content.Context
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.text.Normalizer

class PairingException(message: String) : Exception(message)

/** Pairing with a Host, as the desktop client does (`mac/clients/desktop/connection.mjs`). */
object Pairing {
    /** Chinese input methods often produce full-width "：／" and the ideographic full stop. */
    fun halfWidth(input: String): String =
        Normalizer.normalize(input, Normalizer.Form.NFKC).replace('\u3002', '.').filterNot { it.isWhitespace() }

    fun normalizeServer(context: Context, input: String): String {
        val invalid = PairingException(Text.t(context, "请输入 Host 的 http:// 或 https:// 地址。", "Enter the Host http:// or https:// address."))
        val uri = try { URI(halfWidth(input)) } catch (_: Exception) { throw invalid }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") throw invalid
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) throw invalid
        if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") throw invalid
        val host = uri.host?.lowercase() ?: throw invalid
        if (uri.port != -1 && uri.port !in 1..65535) throw invalid
        val defaultPort = uri.port == -1 || (scheme == "http" && uri.port == 80) || (scheme == "https" && uri.port == 443)
        return if (defaultPort) "$scheme://$host" else "$scheme://$host:${uri.port}"
    }

    fun deviceName(context: Context): String {
        val named = try { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) } catch (_: Exception) { null }
        val name = named?.trim()?.takeIf { it.isNotEmpty() } ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        return name.take(80).ifEmpty { "Android" }
    }

    fun pair(context: Context, address: String, pairingKey: String): Connection {
        val server = normalizeServer(context, address)
        val key = halfWidth(pairingKey).uppercase()
        if (key.isEmpty()) throw PairingException(Text.t(context, "请输入配对码。", "Enter a pairing code."))
        val body = JSONObject().put("pairingKey", key).put("deviceName", deviceName(context)).put("platform", "desktop").put("clientKind", "android")
        val (status, reply) = try {
            request("$server/connect/pair", "POST", body.toString(), null)
        } catch (_: Exception) {
            throw PairingException(Text.t(context, "无法连接 Host，请检查地址和网络。", "Cannot reach the Host. Check the address and network."))
        }
        if (status !in 200..299) throw PairingException(
            if (status == 401) Text.t(context, "配对码无效或已过期。", "Pairing code is invalid or expired.")
            else Text.t(context, "连接失败（HTTP $status）。", "Connection failed (HTTP $status)."))
        val token = reply?.optString("token").orEmpty()
        val deviceId = reply?.optString("deviceId").orEmpty()
        if (token.length < 16 || deviceId.isEmpty())
            throw PairingException(Text.t(context, "Host 返回的设备凭证无效。", "Host returned invalid device credentials."))
        val gateway = try { normalizeServer(context, reply?.optString("gatewayUrl").orEmpty()) } catch (_: Exception) { "" }
        if (gateway != server)
            throw PairingException(Text.t(context, "Host 返回了不同的服务地址。", "Host returned a different server address."))
        return Connection(server, deviceId, token)
    }

    /** Moves an existing pairing to another address of the same Host. */
    fun verify(context: Context, address: String, current: Connection): Connection {
        val server = normalizeServer(context, address)
        val status = try { request("$server/connect/status", "GET", null, current.token).first } catch (_: Exception) { 0 }
        if (status !in 200..299)
            throw PairingException(Text.t(context, "无法验证此 Host 的设备凭据。", "Could not verify this device with the Host."))
        return current.copy(server = server)
    }

    private fun request(url: String, method: String, body: String?, token: String?): Pair<Int, JSONObject?> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 35_000
            connection.requestMethod = method
            connection.setRequestProperty("Accept", "application/json")
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray()) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val text = stream?.use { it.readBytes().decodeToString() }.orEmpty()
            return status to (try { JSONObject(text) } catch (_: Exception) { null })
        } finally {
            connection.disconnect()
        }
    }
}
