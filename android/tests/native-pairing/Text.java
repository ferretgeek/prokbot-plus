package dev.grokbot.local;

import android.content.Context;
public final class Text {
    public static final Text INSTANCE = new Text();
    public String t(Context context, String zh, String en) { return en; }
}
