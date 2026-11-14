package dev.grokbot.local;

import android.content.Context;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicInteger;

// Exercise the compiled production Pairing.verify on the JVM. Both listeners are loopback fixtures.
public final class PairingOriginProbe {
    public static void main(String[] args) throws Exception {
        AtomicInteger savedHits = new AtomicInteger(), otherHits = new AtomicInteger();
        String token = "synthetic-device-only";
        HttpServer saved = server(savedHits, token), other = server(otherHits, token);
        try {
            String origin = "http://127.0.0.1:" + saved.getAddress().getPort();
            Connection device = new Connection(origin, "fixture", token);
            Context context = new Context();
            Connection result = Pairing.INSTANCE.verify(context, origin + "/", device);
            if (!result.getDeviceId().equals(device.getDeviceId()) || savedHits.get() != 1) throw new AssertionError("same-origin retry");
            try {
                Pairing.INSTANCE.verify(context, "http://127.0.0.1:" + other.getAddress().getPort(), device);
                throw new AssertionError("changed origin accepted");
            } catch (Throwable e) {
                if (!(e instanceof PairingException) || !e.getMessage().contains("new pairing code")) throw e;
            }
            if (otherHits.get() != 0 || savedHits.get() != 1) throw new AssertionError("a changed origin received a request");
            System.out.println("PASS compiled Pairing.verify: same-origin requests=1, changed-origin requests=0, identity unchanged");
        } finally { saved.stop(0); other.stop(0); }
    }

    private static HttpServer server(AtomicInteger hits, String token) throws Exception {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 1);
        s.createContext("/connect/status", exchange -> {
            hits.incrementAndGet();
            boolean match = ("Bearer " + token).equals(exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.sendResponseHeaders(match ? 200 : 401, -1); exchange.close();
        });
        s.start(); return s;
    }
}
