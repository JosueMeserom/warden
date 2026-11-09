package io.github.josuemeserom.warden;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Locale;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * The central whitelist, inside the server. WardenGate already enforces it for everyone joining over Java; this covers
 * what doesn't go through the gate (Bedrock, via Geyser). It reads the same whitelist.json from WARDEN_HOME (default
 * ~/.config/warden) and reloads it as soon as it changes; language, domain and owner come from WARDEN_HOME/config.json.
 * The server's name is its folder: mc-<name>/serverfiles. Only years-old Bukkit API, so it survives new versions.
 */
public final class WardenList extends JavaPlugin implements Listener {
    private File file;
    private String server, language = "en", domain = null, owner = null;
    private long read = -1;
    private JsonObject list;

    @Override
    public void onEnable() {
        String env = System.getenv("WARDEN_HOME");
        File home = env != null ? new File(env) : new File(System.getProperty("user.home"), ".config/warden");
        file = new File(System.getProperty("wardenlist.file", new File(home, "whitelist.json").getPath()));
        try {
            JsonObject c = JsonParser.parseString(Files.readString(new File(home, "config.json").toPath(), StandardCharsets.UTF_8)).getAsJsonObject();
            if (c.has("language")) language = c.get("language").getAsString();
            if (c.has("domain") && !c.get("domain").isJsonNull()) domain = c.get("domain").getAsString();
            if (c.has("owner") && !c.get("owner").isJsonNull()) owner = c.get("owner").getAsString();
        } catch (Exception e) { /* no site config: English, no hints */ }
        server = getServer().getWorldContainer().getAbsoluteFile().toPath().normalize().getParent()
                .getFileName().toString().replaceFirst("^mc-", "");
        getServer().getPluginManager().registerEvents(this, this);
        getLogger().info("Central whitelist for «" + server + "»: " + file);
    }

    private boolean es() { return language.startsWith("es"); }

    private synchronized JsonObject load() throws Exception {
        long t = file.lastModified();
        if (t != read) {
            list = JsonParser.parseString(Files.readString(file.toPath(), StandardCharsets.UTF_8)).getAsJsonObject();
            read = t;
        }
        return list;
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onLogin(AsyncPlayerPreLoginEvent e) {
        JsonObject l;
        try {
            l = load();
        } catch (Exception ex) {
            if (!file.exists()) return;                          // no central list: nothing to enforce
            getLogger().warning("Can't read the whitelist: " + ex.getMessage());
            String who = owner != null ? owner : (es() ? "el administrador" : "the admin");
            e.disallow(AsyncPlayerPreLoginEvent.Result.KICK_OTHER, Component.text(es()
                    ? "La lista blanca no se puede leer ahora mismo: avisa a " + who + "."
                    : "The whitelist can't be read right now: tell " + who + ".", NamedTextColor.RED));
            return;
        }
        JsonObject required = l.has("servers") ? l.getAsJsonObject("servers") : new JsonObject();
        if (!required.has(server) || !required.get(server).getAsBoolean()) return;
        JsonObject players = l.has("players") ? l.getAsJsonObject("players") : new JsonObject();
        JsonElement j = players.get(e.getName().toLowerCase(Locale.ROOT));
        if (j != null && j.isJsonObject()) {
            for (JsonElement s : j.getAsJsonObject().getAsJsonArray("servers")) {
                String v = s.getAsString();
                if (v.equals("*") || v.equals(server)) return;
            }
        }
        getLogger().info(e.getName() + " is not on the whitelist of " + server);
        String address = domain != null ? server + "." + domain : null;
        String hint = es()
                ? (address != null ? "Desde Java, entra con " + address + " y te dará un código para el bot de Discord.\n" : "")
                  + "Desde Bedrock, o si no estás en ese Discord, pide al administrador del servidor que te añada."
                : (address != null ? "From Java, join " + address + " and you'll get a code for the Discord bot.\n" : "")
                  + "From Bedrock, or if you're not on that Discord server, ask the server admin to add you.";
        e.disallow(AsyncPlayerPreLoginEvent.Result.KICK_WHITELIST, Component.text()
                .append(Component.text((es() ? "No estás en la lista blanca de " : "You are not on the whitelist of ") + server + ".\n\n", NamedTextColor.YELLOW))
                .append(Component.text(hint, NamedTextColor.GRAY))
                .build());
    }
}
