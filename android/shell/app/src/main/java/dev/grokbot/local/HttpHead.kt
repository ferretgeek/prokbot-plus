package dev.grokbot.local

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/** One HTTP/1.1 message head. Bodies are streamed by the caller. */
class HttpHead(var startLine: String, val headers: MutableList<Pair<String, String>>) {
    private val parts get() = startLine.split(' ', limit = 3)
    val method get() = parts.getOrElse(0) { "" }
    val target get() = parts.getOrElse(1) { "" }
    val path get() = target.substringBefore('?')
    val status get() = parts.getOrElse(1) { "0" }.toIntOrNull() ?: 0

    operator fun get(name: String): String? = headers.firstOrNull { it.first.equals(name, true) }?.second
    fun all(name: String): List<String> = headers.filter { it.first.equals(name, true) }.map { it.second }
    fun requestLength(limit: Long): Long {
        if (this["Transfer-Encoding"] != null) throw HttpFailure(411, "Chunked request bodies are not supported")
        val values = all("Content-Length")
        if (values.isEmpty()) return 0
        val length = values.singleOrNull()?.takeIf { it.isNotEmpty() && it.all { c -> c in '0'..'9' } }?.toLongOrNull()
            ?: throw HttpFailure(400, "Invalid Content-Length")
        if (length > limit) throw HttpFailure(413, "Request body too large")
        return length
    }
    fun remove(name: String) { headers.removeAll { it.first.equals(name, true) } }
    operator fun set(name: String, value: String) { remove(name); headers.add(name to value) }

    fun cookie(name: String): String? = all("Cookie").asSequence()
        .flatMap { it.split(';').asSequence() }
        .map { it.trim() }
        .firstOrNull { it.startsWith("$name=") }
        ?.substringAfter('=')

    fun encode(): ByteArray {
        val text = StringBuilder(startLine).append("\r\n")
        for ((name, value) in headers) text.append(name).append(": ").append(value).append("\r\n")
        return text.append("\r\n").toString().toByteArray(Charsets.ISO_8859_1)
    }

    companion object {
        /** Reads a head; returns null when the peer closed before sending anything. */
        fun read(input: InputStream, limit: Int = 64 * 1024): HttpHead? {
            val lines = mutableListOf<String>()
            val line = ByteArrayOutputStream()
            var total = 0
            while (true) {
                val value = input.read()
                if (value < 0) {
                    if (total == 0) return null
                    throw IOException("Connection closed inside the message head")
                }
                if (++total > limit) throw IOException("Message head too large")
                if (value == '\n'.code) {
                    val text = line.toString(Charsets.ISO_8859_1.name()).trimEnd('\r')
                    line.reset()
                    if (text.isEmpty()) {
                        if (lines.isEmpty()) continue
                        break
                    }
                    lines += text
                } else line.write(value)
            }
            val headers = lines.drop(1).mapNotNull { header ->
                val colon = header.indexOf(':')
                if (colon <= 0) null else header.substring(0, colon).trim() to header.substring(colon + 1).trim()
            }.toMutableList()
            return HttpHead(lines.first(), headers)
        }
    }
}

object Http {
    private val reasons = mapOf(
        200 to "OK", 204 to "No Content", 400 to "Bad Request", 403 to "Forbidden", 404 to "Not Found",
        405 to "Method Not Allowed", 411 to "Length Required", 413 to "Payload Too Large",
        421 to "Misdirected Request", 500 to "Internal Server Error", 502 to "Bad Gateway",
        503 to "Service Unavailable",
    )

    fun respond(
        output: OutputStream,
        status: Int,
        contentType: String?,
        body: ByteArray,
        keepAlive: Boolean,
        extra: List<Pair<String, String>> = emptyList(),
        headOnly: Boolean = false,
    ) {
        val head = HttpHead("HTTP/1.1 $status ${reasons[status] ?: "Status"}", mutableListOf())
        if (contentType != null) head.headers += "Content-Type" to contentType
        head.headers += "Content-Length" to body.size.toString()
        head.headers += "X-Content-Type-Options" to "nosniff"
        head.headers += "Connection" to if (keepAlive) "keep-alive" else "close"
        head.headers += extra
        output.write(head.encode())
        if (!headOnly) output.write(body)
        output.flush()
    }

    fun json(output: OutputStream, status: Int, body: String, keepAlive: Boolean = true) =
        respond(output, status, "application/json; charset=utf-8", body.toByteArray(), keepAlive,
            listOf("Cache-Control" to "no-store"))

    fun error(output: OutputStream, status: Int, message: String, keepAlive: Boolean = false) =
        json(output, status, org.json.JSONObject().put("error", message).toString(), keepAlive)

    fun readBody(input: InputStream, head: HttpHead, limit: Long): ByteArray {
        val length = head.requestLength(limit)
        val body = ByteArray(length.toInt())
        var offset = 0
        while (offset < body.size) {
            val read = input.read(body, offset, body.size - offset)
            if (read < 0) throw IOException("Request body ended early")
            offset += read
        }
        return body
    }
}

class HttpFailure(val status: Int, message: String) : Exception(message)
