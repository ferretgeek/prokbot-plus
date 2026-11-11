package dev.grokbot.local

import android.content.Context
import android.content.res.Configuration
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Connection(val server: String, val deviceId: String, val token: String)

/** Pairing record. The device credential is sealed with a key that never leaves the Android keystore. */
class ConnectionStore(context: Context) {
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    @Volatile var lastError: String? = null

    @Synchronized
    fun loadOrNull(): Connection? = try {
        load()
    } catch (_: Exception) {
        lastError = "credential"
        null
    }

    @Synchronized
    fun load(): Connection? {
        val server = prefs.getString("server", null) ?: return null
        val deviceId = prefs.getString("deviceId", null) ?: return null
        val sealed = prefs.getString("token", null) ?: return null
        return Connection(server, deviceId, open(sealed))
    }

    @Synchronized
    fun save(connection: Connection) {
        check(prefs.edit()
            .putString("server", connection.server)
            .putString("deviceId", connection.deviceId)
            .putString("token", seal(connection.token))
            .remove("notificationCursor")
            .remove("notificationCursorTime")
            .remove("notificationCursorIds")
            .commit()) { "Could not save the connection" }
    }

    @Synchronized
    fun clear() {
        prefs.edit().clear().commit()
    }

    val notificationCursor: String?
        get() = prefs.getString("notificationCursor", null)

    @Synchronized
    fun seedNotifications(deviceId: String, items: JSONArray) {
        if (prefs.getString("deviceId", null) != deviceId) return
        val last = items.optJSONObject(items.length() - 1)
        val time = last?.optString("createdAt").orEmpty()
        val ids = (0 until items.length()).mapNotNull { items.optJSONObject(it) }
            .filter { it.optString("createdAt") == time }.map { it.optString("id") }.toSet()
        prefs.edit().putString("notificationCursorTime", time).putStringSet("notificationCursorIds", ids)
            .putString("notificationCursor", last?.optString("id").orEmpty()).apply()
    }

    @Synchronized
    fun acceptNotification(deviceId: String, id: String, time: String): Boolean {
        if (id.isEmpty() || time.isEmpty() || prefs.getString("deviceId", null) != deviceId) return false
        val seen = prefs.getString("notificationCursorTime", "").orEmpty()
        if (time < seen) return false
        val ids = if (time == seen) prefs.getStringSet("notificationCursorIds", setOf(notificationCursor.orEmpty())).orEmpty() else emptySet()
        if (id in ids) return false
        prefs.edit().putString("notificationCursorTime", time).putStringSet("notificationCursorIds", ids + id)
            .putString("notificationCursor", id).apply()
        return true
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build())
        return generator.generateKey()
    }

    private fun seal(text: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.doFinal(text.toByteArray())
        return encode(cipher.iv) + "." + encode(sealed)
    }

    private fun open(value: String): String {
        val (iv, sealed) = value.split('.', limit = 2).map { Base64.decode(it, Base64.NO_WRAP) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(sealed))
    }

    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private companion object {
        const val ALIAS = "grokbot-device-credential"
    }
}

/** Client settings and the original interface's persistence store. */
class ClientSettings(private val context: Context) {
    private val prefs = context.getSharedPreferences("client-settings", Context.MODE_PRIVATE)
    private val persistenceFile = File(context.filesDir, "client-persistence.json")
    private var persistence: JSONObject? = null

    @Synchronized
    fun snapshot(): JSONObject = JSONObject()
        .put("theme", prefs.getString("theme", "system"))
        .put("language", prefs.getString("language", "system"))
        .put("realtimeVoice", prefs.getBoolean("realtimeVoice", false))
        .put("backgroundNotifications", prefs.getBoolean("backgroundNotifications", true))
        .put("botColor", prefs.getBoolean("botColor", false))
        .put("spellCheck", prefs.getBoolean("spellCheck", true))
        .put("timeZone", prefs.getString("timeZone", null) ?: JSONObject.NULL)

    val theme get() = prefs.getString("theme", "system") ?: "system"
    val language get() = prefs.getString("language", "system") ?: "system"
    val backgroundNotifications get() = prefs.getBoolean("backgroundNotifications", true)

    @Synchronized
    fun update(key: String, value: Any?): JSONObject {
        val editor = prefs.edit()
        when (key) {
            "theme" -> {
                require(value in listOf("dark", "light", "system")) { "Invalid theme" }
                editor.putString(key, value as String)
            }
            "language" -> {
                require(value is String && value.length in 1..32 && value.matches(Regex("^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$|^system$"))) { "Invalid language" }
                editor.putString(key, value)
            }
            "realtimeVoice", "backgroundNotifications", "botColor", "spellCheck" -> {
                require(value is Boolean) { "Invalid setting" }
                editor.putBoolean(key, value)
            }
            "timeZone" -> {
                if (value == null || value == JSONObject.NULL) editor.remove(key)
                else {
                    require(value is String && value.length <= 64) { "Invalid time zone" }
                    editor.putString(key, value)
                }
            }
            else -> throw IllegalArgumentException("Unknown setting")
        }
        editor.commit()
        return snapshot()
    }

    /** The language the interface shows, as a BCP 47 tag. */
    fun resolvedLocale(): String {
        val chosen = language
        return if (chosen == "system") Locale.getDefault().toLanguageTag() else chosen
    }

    @Synchronized
    fun persistence(): JSONObject {
        persistence?.let { return it }
        val loaded = try { JSONObject(persistenceFile.readText()) } catch (_: Exception) { JSONObject() }
        persistence = loaded
        return loaded
    }

    /** Applies `[{op:"set",key,value}|{op:"remove",key}]` and writes the store atomically. */
    @Synchronized
    fun applyPersistence(operations: JSONArray) {
        val store = JSONObject(persistence().toString())
        for (index in 0 until operations.length()) {
            val operation = operations.getJSONObject(index)
            val key = operation.getString("key")
            require(key.length in 1..512) { "Invalid key" }
            when (operation.getString("op")) {
                "set" -> store.put(key, operation.opt("value") ?: JSONObject.NULL)
                "remove" -> store.remove(key)
                else -> throw IllegalArgumentException("Invalid operation")
            }
        }
        val temporary = File(persistenceFile.parentFile, "${persistenceFile.name}.tmp")
        temporary.writeText(store.toString())
        if (!temporary.renameTo(persistenceFile)) throw IllegalStateException("Could not save client state")
        persistence = store
    }

    @Synchronized
    fun clearPersistence() {
        persistence = JSONObject()
        persistenceFile.delete()
    }
}

object Text {
    fun chinese(context: Context): Boolean =
        GrokBotApp.of(context).settings.resolvedLocale().lowercase().startsWith("zh")

    fun t(context: Context, zh: String, en: String) = if (chinese(context)) zh else en

    /** A string resource in the language chosen in the app, which may differ from the system's. */
    fun string(context: Context, id: Int): String {
        val configuration = Configuration(context.resources.configuration)
        configuration.setLocale(Locale.forLanguageTag(GrokBotApp.of(context).settings.resolvedLocale()))
        return context.createConfigurationContext(configuration).getString(id)
    }
}
