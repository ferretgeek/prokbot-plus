package dev.grokbot.local

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

object Notifications {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_ATTENTION = "attention"
    const val CHANNEL_CONNECTION = "connection"
    const val ID_CONNECTION = 1
    private const val GROUP_CONNECTION = "dev.grokbot.local.connection"
    private const val ID_EXPIRED = 2

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(listOf(
            NotificationChannel(CHANNEL_MESSAGES, Text.string(context, R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_ATTENTION, Text.string(context, R.string.channel_attention), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_CONNECTION, Text.string(context, R.string.channel_connection), NotificationManager.IMPORTANCE_MIN)
                .apply { setShowBadge(false) },
        ))
    }

    private fun openApp(context: Context, agentId: String?, request: Int): PendingIntent {
        val intent = if (agentId == null) Intent(context, MainActivity::class.java)
        else Intent(Intent.ACTION_VIEW, Uri.parse("grokbot-local://agent/$agentId"), context, MainActivity::class.java)
        return PendingIntent.getActivity(context, request, intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun connection(context: Context, reconnecting: Boolean): Notification =
        Notification.Builder(context, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(Text.string(context, if (reconnecting) R.string.connection_lost else R.string.connection_title))
            .setContentText(Text.string(context, R.string.connection_text))
            .setContentIntent(openApp(context, null, 0))
            .setOngoing(true)
            // Its own group: otherwise Android bundles it with Bot messages, and the bundle
            // inherits "ongoing" and can no longer be cleared.
            .setGroup(GROUP_CONNECTION)
            .setShowWhen(false)
            .build()

    private fun idFor(agentId: String) = 1000 + (agentId.hashCode() and 0x7fffffff) % 1_000_000

    fun show(context: Context, item: JSONObject) {
        val agentId = item.optString("agentId")
        if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(agentId)) return
        val attention = item.optString("type") == "attention"
        val body = item.optString("body")
        val notification = Notification.Builder(context, if (attention) CHANNEL_ATTENTION else CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(item.optString("title").ifEmpty { "Grok Bot" })
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(openApp(context, agentId, idFor(agentId)))
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .build()
        try {
            context.getSystemService(NotificationManager::class.java).notify(idFor(agentId), notification)
        } catch (error: SecurityException) {
            Log.w("GrokBotNotify", "Notification permission missing")
        }
    }

    fun expired(context: Context) {
        val notification = Notification.Builder(context, CHANNEL_ATTENTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(Text.string(context, R.string.app_name))
            .setContentText(Text.string(context, R.string.pairing_expired))
            .setContentIntent(openApp(context, null, 1))
            .setAutoCancel(true)
            .build()
        try { context.getSystemService(NotificationManager::class.java).notify(ID_EXPIRED, notification) } catch (_: SecurityException) {}
    }

    fun cancelAgent(context: Context, agentId: String) =
        context.getSystemService(NotificationManager::class.java).cancel(idFor(agentId))

    fun cancelAll(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.id != ID_CONNECTION }.forEach { manager.cancel(it.id) }
    }
}

/**
 * Background delivery without a cloud push service: a foreground service follows the
 * Host notification stream (`/notifications/events`), the same feed the iOS client reads.
 */
class NotificationService : Service() {
    private val app get() = GrokBotApp.of(this)
    @Volatile private var stopped = false
    @Volatile private var current: HttpURLConnection? = null
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = Notifications.connection(this, reconnecting = false)
        if (Build.VERSION.SDK_INT >= 34) startForeground(Notifications.ID_CONNECTION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(Notifications.ID_CONNECTION, notification)
        if (app.gateway.connection == null || !app.settings.backgroundNotifications) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_RESTART) current?.disconnect()
        if (worker?.isAlive != true) {
            stopped = false
            worker = Thread(::run, "grokbot-notifications").apply { isDaemon = true; start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        current?.disconnect()
        worker?.interrupt()
        super.onDestroy()
    }

    private class Unauthorized : IOException()

    private fun run() {
        var failures = 0
        while (!stopped) {
            val connection = app.gateway.connection ?: break
            try {
                if (app.connections.notificationCursor == null) seed(connection)
                stream(connection) { failures = 0 }
            } catch (_: Unauthorized) {
                if (app.gateway.connection !== connection || stopped) continue
                app.connections.lastError = "unauthorized"
                Notifications.expired(this)
                break
            } catch (error: Exception) {
                if (stopped) break
                Log.i(TAG, "notification stream: ${error.javaClass.simpleName}")
            }
            if (stopped) break
            updateForeground(reconnecting = true)
            try { Thread.sleep(minOf(1000L shl minOf(failures++, 5), 30_000L)) } catch (_: InterruptedException) { if (stopped) break }
        }
        if (!stopped) stopSelf()
    }

    private fun open(connection: Connection, path: String, lastId: String?, accept: String): HttpURLConnection {
        val http = URL(connection.server + path).openConnection() as HttpURLConnection
        current = http
        http.instanceFollowRedirects = false
        http.connectTimeout = 15_000
        http.readTimeout = 60_000
        http.setRequestProperty("Authorization", "Bearer ${connection.token}")
        http.setRequestProperty("Accept", accept)
        if (!lastId.isNullOrEmpty()) http.setRequestProperty("Last-Event-ID", lastId)
        try {
            val status = http.responseCode
            if (status == 401) throw Unauthorized()
            if (status != 200) throw IOException("HTTP $status")
            return http
        } catch (error: Exception) {
            http.disconnect()
            throw error
        }
    }

    /** Starts after the newest existing item, so pairing does not replay old notifications. */
    private fun seed(connection: Connection) {
        val http = open(connection, "/notifications", null, "application/json")
        val items = try { JSONObject(http.inputStream.use { it.readBytes().decodeToString() }).optJSONArray("items") } finally { http.disconnect() }
        app.connections.seedNotifications(connection.deviceId, items ?: org.json.JSONArray())
    }

    private fun stream(connection: Connection, onConnected: () -> Unit) {
        val http = open(connection, "/notifications/events", app.connections.notificationCursor, "text/event-stream")
        onConnected()
        updateForeground(reconnecting = false)
        try {
            val reader = BufferedReader(InputStreamReader(http.inputStream, Charsets.UTF_8))
            var id: String? = null
            var event: String? = null
            val data = StringBuilder()
            while (!stopped) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) {
                    if (data.isNotEmpty()) deliver(connection, id, event, data.toString())
                    id = null; event = null; data.setLength(0)
                    continue
                }
                if (line.startsWith(':')) continue
                val field = line.substringBefore(':')
                val value = line.substringAfter(':', "").removePrefix(" ")
                when (field) {
                    "id" -> id = value
                    "event" -> event = value
                    "data" -> { if (data.isNotEmpty()) data.append('\n'); data.append(value) }
                }
            }
        } finally {
            http.disconnect()
        }
    }

    private fun deliver(connection: Connection, id: String?, event: String?, data: String) {
        if (event != "notification") return
        val item = try { JSONObject(data) } catch (_: Exception) { return }
        // A pruned cursor makes the Host replay its whole history; never show an item twice.
        val createdAt = item.optString("createdAt")
        if (app.connections.acceptNotification(connection.deviceId, id ?: item.optString("id"), createdAt)) {
            val viewing = app.inForeground && app.viewingAgentId == item.optString("agentId")
            if (!viewing) Notifications.show(this, item)
        }
    }

    private fun updateForeground(reconnecting: Boolean) {
        try {
            getSystemService(android.app.NotificationManager::class.java)
                .notify(Notifications.ID_CONNECTION, Notifications.connection(this, reconnecting))
        } catch (_: SecurityException) {}
    }

    companion object {
        private const val TAG = "GrokBotNotify"
        private const val ACTION_RESTART = "dev.grokbot.local.RESTART_NOTIFICATIONS"

        /** Starts, restarts or stops the service to match the pairing and the user setting. */
        fun sync(context: Context) {
            val app = GrokBotApp.of(context)
            val intent = Intent(context, NotificationService::class.java)
            if (app.gateway.connection != null && app.settings.backgroundNotifications) {
                try { context.startForegroundService(intent.setAction(ACTION_RESTART)) }
                catch (error: Exception) { Log.w(TAG, "Cannot start background notifications: ${error.javaClass.simpleName}") }
            } else {
                context.stopService(intent)
            }
        }
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED)
            NotificationService.sync(context)
    }
}
