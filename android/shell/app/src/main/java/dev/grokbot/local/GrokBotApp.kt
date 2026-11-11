package dev.grokbot.local

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

class GrokBotApp : Application() {
    lateinit var connections: ConnectionStore
        private set
    lateinit var settings: ClientSettings
        private set
    lateinit var gateway: LocalGateway
        private set

    /** The workspace activity while it exists; native calls that need a window use it. */
    @Volatile var host: MainActivity? = null
    /** The conversation shown in the workspace, so its own notifications stay quiet. */
    @Volatile var viewingAgentId: String? = null
    @Volatile var inForeground = false

    override fun onCreate() {
        super.onCreate()
        connections = ConnectionStore(this)
        settings = ClientSettings(this)
        Notifications.createChannels(this)
        gateway = LocalGateway(this)
        gateway.connection = connections.loadOrNull()
        gateway.start()
    }

    fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            Log.w("GrokBot", "No app can open ${uri.scheme} links")
        }
    }

    companion object {
        fun of(context: Context): GrokBotApp = context.applicationContext as GrokBotApp
    }
}
