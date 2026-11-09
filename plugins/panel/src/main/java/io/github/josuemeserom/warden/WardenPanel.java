package io.github.josuemeserom.warden;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.papermc.paper.event.player.AsyncChatEvent;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.attribute.Attribute;
import org.bukkit.attribute.AttributeInstance;
import org.bukkit.Material;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.Damageable;
import org.bukkit.inventory.meta.EnchantmentStorageMeta;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerAdvancementDoneEvent;
import org.bukkit.event.player.PlayerBedEnterEvent;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.block.Container;
import org.bukkit.entity.EntityType;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockIgniteEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.CreatureSpawnEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.PlayerBucketEmptyEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.block.DoubleChest;
import java.util.HashMap;
import java.util.Set;
import java.util.stream.Collectors;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Live data for the web panel, read-only: an HTTP server on 127.0.0.1 (the server port + 20000) that requires the key in
 * plugins/WardenPanel/key (created on first start, mode 600). Actions (kick, ban…) don't go through here: the panel sends
 * them as console commands, the same on Paper and on Fabric.
 *   GET /status           TPS, memory, worlds and online players (position, health, food, ping…)
 *   GET /events?since=N   what happened: joins, leaves, deaths, advancements, chat, dimension changes, beds
 *   GET /inventory?uuid=U inventory, armor, offhand and ender chest of an online player
 *   GET /counters         (and resets them) stone broken per player and blocks placed/broken per 16×16 zone
 * For investigating it also records: valuable ores, lava, fire, TNT, withers, powerful commands (from a closed list:
 * never login plugins' commands nor private messages) and what is taken out of containers. All with their location.
 */
public final class WardenPanel extends JavaPlugin implements Listener {
    private static final int MAX_EVENTS = 500;
    private final Gson gson = new Gson();
    private final ArrayDeque<JsonObject> events = new ArrayDeque<>();
    private final Map<UUID, Long> onlineSince = new ConcurrentHashMap<>();
    private long lastId = 0;
    private byte[] key;
    private HttpServer http;

    @Override
    public void onEnable() {
        try {
            File f = new File(getDataFolder(), "key");
            File old = new File(getDataFolder(), "clave");                   // its name before 2026-11
            if (!f.exists() && old.exists()) old.renameTo(f);
            if (!f.exists()) {
                getDataFolder().mkdirs();
                byte[] b = new byte[32];
                new SecureRandom().nextBytes(b);
                Files.writeString(f.toPath(), HexFormat.of().formatHex(b));
                Files.setPosixFilePermissions(f.toPath(), PosixFilePermissions.fromString("rw-------"));
            }
            key = Files.readString(f.toPath()).trim().getBytes(StandardCharsets.UTF_8);
            int port = Integer.getInteger("wardenpanel.port", Bukkit.getPort() + 20000);
            http = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            http.createContext("/", this::handle);
            http.setExecutor(Executors.newFixedThreadPool(2, r -> { Thread t = new Thread(r, "WardenPanel"); t.setDaemon(true); return t; }));
            http.start();
            long now = System.currentTimeMillis();
            for (Player p : Bukkit.getOnlinePlayers()) onlineSince.put(p.getUniqueId(), now);
            getServer().getPluginManager().registerEvents(this, this);
            getLogger().info("Panel data on 127.0.0.1:" + port);
        } catch (IOException e) {
            getLogger().severe("Can't open the panel's HTTP server: " + e.getMessage());
        }
    }

    @Override
    public void onDisable() {
        if (http != null) http.stop(0);
    }

    // ─────────────────────── HTTP ───────────────────────

    private void handle(HttpExchange x) throws IOException {
        try (x) {
            String a = x.getRequestHeaders().getFirst("Authorization");
            byte[] given = (a == null ? "" : a.replaceFirst("^Bearer ", "")).getBytes(StandardCharsets.UTF_8);
            if (!MessageDigest.isEqual(given, key)) { respond(x, 401, "{}"); return; }
            if (!"GET".equals(x.getRequestMethod())) { respond(x, 405, "{}"); return; }
            String route = x.getRequestURI().getPath();
            if (route.equals("/status")) {
                JsonObject e = Bukkit.getScheduler().callSyncMethod(this, this::status).get(5, TimeUnit.SECONDS);
                respond(x, 200, gson.toJson(e));
            } else if (route.equals("/inventory")) {
                String q = x.getRequestURI().getQuery();
                UUID u = UUID.fromString(q != null && q.startsWith("uuid=") ? q.substring(5) : "");
                JsonObject e = Bukkit.getScheduler().callSyncMethod(this, () -> inventory(u)).get(5, TimeUnit.SECONDS);
                respond(x, e == null ? 404 : 200, e == null ? "{}" : gson.toJson(e));
            } else if (route.equals("/counters")) {
                respond(x, 200, gson.toJson(takeCounters()));
            } else if (route.equals("/events")) {
                String q = x.getRequestURI().getQuery();
                long since = q != null && q.startsWith("since=") ? Long.parseLong(q.substring(6)) : 0;
                respond(x, 200, gson.toJson(eventsSince(since)));
            } else {
                respond(x, 404, "{}");
            }
        } catch (Exception e) {
            try { respond(x, 500, "{}"); } catch (IOException ignored) { }
        }
    }

    private static void respond(HttpExchange x, int code, String json) throws IOException {
        byte[] b = json.getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        x.sendResponseHeaders(code, b.length);
        try (OutputStream o = x.getResponseBody()) { o.write(b); }
    }

    // ─────────────────────── Status (on the server thread) ───────────────────────

    private JsonObject status() {
        JsonObject e = new JsonObject();
        e.addProperty("version", Bukkit.getMinecraftVersion());
        e.addProperty("server", Bukkit.getName() + " " + Bukkit.getVersion());
        JsonArray tps = new JsonArray();
        for (double t : Bukkit.getTPS()) tps.add(Math.round(t * 100) / 100.0);
        e.add("tps", tps);
        e.addProperty("mspt", Math.round(Bukkit.getAverageTickTime() * 100) / 100.0);
        e.addProperty("max", Bukkit.getMaxPlayers());
        e.addProperty("motd", plain(Bukkit.motd()));
        e.addProperty("defaultMode", Bukkit.getDefaultGameMode().name().toLowerCase());
        e.addProperty("startedAt", ManagementFactory.getRuntimeMXBean().getStartTime());
        Runtime r = Runtime.getRuntime();
        JsonObject m = new JsonObject();
        m.addProperty("used", r.totalMemory() - r.freeMemory());
        m.addProperty("max", r.maxMemory());
        e.add("memory", m);
        JsonArray worlds = new JsonArray();
        for (World w : Bukkit.getWorlds()) {
            JsonObject o = new JsonObject();
            o.addProperty("name", w.getName());
            o.addProperty("type", w.getEnvironment().name().toLowerCase());
            o.addProperty("difficulty", w.getDifficulty().name().toLowerCase());
            o.addProperty("entities", w.getEntityCount());
            o.addProperty("chunks", w.getChunkCount());
            o.addProperty("time", w.getTime());
            o.addProperty("rain", w.hasStorm());
            worlds.add(o);
        }
        e.add("worlds", worlds);
        JsonArray js = new JsonArray();
        for (Player p : Bukkit.getOnlinePlayers()) {
            JsonObject o = new JsonObject();
            o.addProperty("uuid", p.getUniqueId().toString());
            o.addProperty("name", p.getName());
            o.addProperty("world", p.getWorld().getName());
            o.addProperty("dimension", p.getWorld().getEnvironment().name().toLowerCase());
            o.addProperty("x", p.getLocation().getBlockX());
            o.addProperty("y", p.getLocation().getBlockY());
            o.addProperty("z", p.getLocation().getBlockZ());
            o.addProperty("health", Math.round(p.getHealth() * 10) / 10.0);
            AttributeInstance mh = p.getAttribute(Attribute.MAX_HEALTH);
            o.addProperty("maxHealth", mh == null ? 20 : mh.getValue());
            o.addProperty("food", p.getFoodLevel());
            o.addProperty("level", p.getLevel());
            o.addProperty("ping", p.getPing());
            o.addProperty("mode", p.getGameMode().name().toLowerCase());
            o.addProperty("op", p.isOp());
            o.addProperty("since", onlineSince.getOrDefault(p.getUniqueId(), System.currentTimeMillis()));
            js.add(o);
        }
        e.add("players", js);
        e.add("rules", rules(Bukkit.getWorlds().get(0)));
        return e;
    }

    // ─────────────────────── Inventory (on the server thread) ───────────────────────

    // Same format the panel reads from the .dat files: { slot, id, n, name, enchantments, damage, maxDamage }.
    private JsonObject item(ItemStack i, int slot) {
        if (i == null || i.getType() == Material.AIR) return null;
        JsonObject o = new JsonObject();
        o.addProperty("slot", slot);
        o.addProperty("id", i.getType().getKey().toString());
        o.addProperty("n", i.getAmount());
        ItemMeta m = i.getItemMeta();
        if (m != null) {
            if (m.hasDisplayName()) o.addProperty("name", plain(m.displayName()));
            JsonObject en = new JsonObject();
            Map<Enchantment, Integer> e = m instanceof EnchantmentStorageMeta l ? l.getStoredEnchants() : m.getEnchants();
            e.forEach((k, v) -> en.addProperty(k.getKey().toString(), v));
            if (en.size() > 0) o.add("enchantments", en);
            if (m instanceof Damageable d && d.hasDamage()) o.addProperty("damage", d.getDamage());
        }
        if (i.getType().getMaxDurability() > 0) o.addProperty("maxDamage", i.getType().getMaxDurability());
        return o;
    }

    private JsonArray items(ItemStack[] c, int base) {
        JsonArray a = new JsonArray();
        for (int k = 0; k < c.length; k++) { JsonObject o = item(c[k], base + k); if (o != null) a.add(o); }
        return a;
    }

    private JsonObject inventory(UUID u) {
        Player p = Bukkit.getPlayer(u);
        if (p == null) return null;
        JsonObject e = new JsonObject();
        e.add("inventory", items(p.getInventory().getStorageContents(), 0));
        e.add("armor", items(p.getInventory().getArmorContents(), 100));      // 100 boots … 103 helmet, as in the .dat files
        JsonArray offhand = new JsonArray();
        JsonObject o = item(p.getInventory().getItemInOffHand(), -106);
        if (o != null) offhand.add(o);
        e.add("offhand", offhand);
        e.add("ender", items(p.getEnderChest().getContents(), 0));
        e.addProperty("live", true);
        return e;
    }

    // ─────────────────────── Game rules ───────────────────────

    // Every rule this version knows, with its value. The name is the registry key («keep_inventory»): that's what
    // /gamerule understands since Mojang renamed them (26.x; the old name, «keepInventory», no longer works).
    @SuppressWarnings({"unchecked", "rawtypes"})
    private JsonArray rules(World w) {
        JsonArray a = new JsonArray();
        try {
            for (GameRule<?> r : org.bukkit.Registry.GAME_RULE) {
                Object v = w.getGameRuleValue((GameRule) r);
                if (v == null) continue;
                JsonObject o = new JsonObject();
                o.addProperty("name", r.getKey().getKey());
                if (v instanceof Boolean b) o.addProperty("value", b); else o.addProperty("value", String.valueOf(v));
                a.add(o);
            }
        } catch (Throwable t) { /* a version that changes the game rule API: the panel just goes without them */ }
        return a;
    }

    // ─────────────────────── For investigating ───────────────────────

    private static Set<Material> materials(String... names) {
        Set<Material> r = new java.util.HashSet<>();
        for (String n : names) { Material m = Material.matchMaterial(n); if (m != null) r.add(m); }
        return r;
    }
    private static final Set<Material> ORES = materials("diamond_ore", "deepslate_diamond_ore", "ancient_debris", "emerald_ore", "deepslate_emerald_ore");
    private static final Set<Material> STONE = materials("stone", "deepslate", "tuff", "granite", "diorite", "andesite", "netherrack", "basalt", "blackstone", "calcite");
    // Commands that give power (only these are recorded: so passwords and private messages never are).
    private static final Set<String> POWERFUL = Set.of("op", "deop", "gamemode", "gm", "give", "summon", "tp", "teleport", "fill", "setblock", "clone",
        "kill", "ban", "ban-ip", "pardon", "pardon-ip", "kick", "whitelist", "gamerule", "difficulty", "execute", "effect", "enchant", "xp", "experience",
        "item", "loot", "stop", "reload", "attribute", "data", "spawnpoint", "setworldspawn", "worldborder", "fawe", "we", "worldedit", "lp", "luckperms", "invsee", "endersee");

    private final Map<String, Integer> stone = new HashMap<>();
    private final Map<String, Map<String, int[]>> zones = new HashMap<>();     // «world|cx|cz» → player → [placed, broken]
    private final Map<UUID, Map<String, Integer>> opened = new ConcurrentHashMap<>();

    private synchronized void count(Block b, Player p, int which) {
        String k = b.getWorld().getName() + "|" + (b.getX() >> 4) + "|" + (b.getZ() >> 4);
        zones.computeIfAbsent(k, x -> new HashMap<>()).computeIfAbsent(p.getName(), x -> new int[2])[which]++;
    }
    private synchronized JsonObject takeCounters() {
        JsonObject r = new JsonObject(), st = new JsonObject(), zo = new JsonObject();
        stone.forEach(st::addProperty);
        zones.forEach((k, m) -> { JsonObject z = new JsonObject(); m.forEach((j, v) -> { JsonArray a = new JsonArray(); a.add(v[0]); a.add(v[1]); z.add(j, a); }); zo.add(k, z); });
        r.add("stone", st); r.add("zones", zo);
        stone.clear(); zones.clear();
        return r;
    }

    private static final org.bukkit.block.BlockFace[] FACES = { org.bukkit.block.BlockFace.UP, org.bukkit.block.BlockFace.DOWN, org.bukkit.block.BlockFace.NORTH,
        org.bukkit.block.BlockFace.SOUTH, org.bukkit.block.BlockFace.EAST, org.bukkit.block.BlockFace.WEST };
    private static boolean exposed(Block b) {
        for (org.bukkit.block.BlockFace c : FACES) { Material m = b.getRelative(c).getType(); if (m.isAir() || m == Material.WATER || m == Material.LAVA) return true; }
        return false;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBreak(BlockBreakEvent e) {
        Material m = e.getBlock().getType();
        // «hidden»: no face touching air, water or lava. Whoever goes straight for those sees through stone; ores in
        // caves (in plain sight) are legitimate and don't count towards suspicion.
        if (ORES.contains(m)) record("ore", e.getPlayer(), m.getKey() + (exposed(e.getBlock()) ? "" : "|hidden"), e.getBlock().getLocation());
        if (STONE.contains(m)) synchronized (this) { stone.merge(e.getPlayer().getName(), 1, Integer::sum); }
        count(e.getBlock(), e.getPlayer(), 1);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlace(BlockPlaceEvent e) {
        count(e.getBlock(), e.getPlayer(), 0);
        if (e.getBlock().getType() == Material.TNT) record("tnt", e.getPlayer(), null, e.getBlock().getLocation());
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBucketEmpty(PlayerBucketEmptyEvent e) {
        if (e.getBucket() == Material.LAVA_BUCKET) record("lava", e.getPlayer(), null, e.getBlock().getLocation());
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onIgnite(BlockIgniteEvent e) {
        if (e.getPlayer() == null || e.getCause() != BlockIgniteEvent.IgniteCause.FLINT_AND_STEEL) return;
        Block below = e.getBlock().getRelative(org.bukkit.block.BlockFace.DOWN);       // obsidian: almost always a portal
        record("fire", e.getPlayer(), below.getType().getKey().toString(), e.getBlock().getLocation());
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onSpawn(CreatureSpawnEvent e) {
        if (e.getEntityType() != EntityType.WITHER || e.getSpawnReason() != CreatureSpawnEvent.SpawnReason.BUILD_WITHER) return;
        Player near = null; double d = 100;
        for (Player p : e.getLocation().getWorld().getPlayers()) { double x = p.getLocation().distanceSquared(e.getLocation()); if (x < d) { d = x; near = p; } }
        if (near != null) record("wither", near, null, e.getLocation());
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCommand(PlayerCommandPreprocessEvent e) {
        String c = e.getMessage().replaceFirst("^/", "").toLowerCase(java.util.Locale.ROOT);
        String cmd = c.split(" ", 2)[0].replaceFirst("^[a-z0-9_]+:", "");
        if (POWERFUL.contains(cmd) || cmd.startsWith("/")) record("command", e.getPlayer(), e.getMessage().length() > 200 ? e.getMessage().substring(0, 200) : e.getMessage());
    }

    // Containers: what is inside on opening; on closing, whatever is missing is recorded («take»).
    private static boolean isBlock(InventoryHolder h) { return h instanceof Container || h instanceof DoubleChest; }
    private static Map<String, Integer> contents(Inventory i) {
        Map<String, Integer> r = new HashMap<>();
        for (ItemStack it : i.getContents()) if (it != null && it.getType() != Material.AIR) r.merge(it.getType().getKey().toString(), it.getAmount(), Integer::sum);
        return r;
    }
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onOpen(InventoryOpenEvent e) {
        if (e.getPlayer() instanceof Player p && isBlock(e.getInventory().getHolder(false))) opened.put(p.getUniqueId(), contents(e.getInventory()));
    }
    @EventHandler(priority = EventPriority.MONITOR)
    public void onClose(InventoryCloseEvent e) {
        if (!(e.getPlayer() instanceof Player p)) return;
        Map<String, Integer> before = opened.remove(p.getUniqueId());
        if (before == null || e.getInventory().getLocation() == null) return;
        Map<String, Integer> after = contents(e.getInventory());
        String taken = before.entrySet().stream().filter(x -> x.getValue() > after.getOrDefault(x.getKey(), 0))
            .map(x -> (x.getValue() - after.getOrDefault(x.getKey(), 0)) + " " + x.getKey()).collect(Collectors.joining(", "));
        if (!taken.isEmpty()) record("take", p, taken.length() > 300 ? taken.substring(0, 300) : taken, e.getInventory().getLocation());
    }

    // ─────────────────────── Events ───────────────────────

    private synchronized JsonObject eventsSince(long since) {
        JsonObject r = new JsonObject();
        JsonArray a = new JsonArray();
        for (JsonObject o : events) if (o.get("id").getAsLong() > since) a.add(o);
        r.addProperty("last", lastId);
        r.add("events", a);
        return r;
    }

    private void record(String type, Player p, String text) { record(type, p, text, p.getLocation()); }

    private synchronized void record(String type, Player p, String text, Location l) {
        JsonObject o = new JsonObject();
        o.addProperty("id", ++lastId);
        o.addProperty("t", System.currentTimeMillis());
        o.addProperty("type", type);
        o.addProperty("player", p.getName());
        o.addProperty("world", l.getWorld().getName());
        o.addProperty("x", l.getBlockX()); o.addProperty("y", l.getBlockY()); o.addProperty("z", l.getBlockZ());
        if (text != null) o.addProperty("text", text);
        events.addLast(o);
        while (events.size() > MAX_EVENTS) events.removeFirst();
    }

    private static String plain(Component c) {
        return c == null ? null : PlainTextComponentSerializer.plainText().serialize(c);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent e) {
        onlineSince.put(e.getPlayer().getUniqueId(), System.currentTimeMillis());
        record("join", e.getPlayer(), null);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent e) {
        Long since = onlineSince.remove(e.getPlayer().getUniqueId());
        record("leave", e.getPlayer(), since == null ? null : String.valueOf(System.currentTimeMillis() - since));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDeath(PlayerDeathEvent e) {
        record("death", e.getEntity(), plain(e.deathMessage()));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onAdvancement(PlayerAdvancementDoneEvent e) {
        if (e.getAdvancement().getDisplay() == null || !e.getAdvancement().getDisplay().doesAnnounceToChat()) return;
        record("advancement", e.getPlayer(), plain(e.getAdvancement().getDisplay().title()));
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onChat(AsyncChatEvent e) {
        record("chat", e.getPlayer(), plain(e.message()));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onTravel(PlayerChangedWorldEvent e) {
        record("travel", e.getPlayer(), e.getPlayer().getWorld().getEnvironment().name().toLowerCase());
    }

    // If they can't sleep (daytime, monsters nearby…), the event comes cancelled.
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBed(PlayerBedEnterEvent e) {
        record("sleep", e.getPlayer(), null);
    }
}
