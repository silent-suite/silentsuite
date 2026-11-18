package net.fortuna.ical4j.model;

import io.silentsuite.ical4j.SystemVTimeZones;
import net.fortuna.ical4j.data.CalendarBuilder;
import net.fortuna.ical4j.data.ParserException;
import net.fortuna.ical4j.model.component.VTimeZone;
import net.fortuna.ical4j.model.property.*;
import net.fortuna.ical4j.util.Configurator;
import net.fortuna.ical4j.util.ResourceLoader;
import net.fortuna.ical4j.util.TimeZoneCache;
import org.apache.commons.lang3.Validate;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.net.URLConnection;
import java.text.ParseException;
import java.time.*;
import java.util.TimeZone;
import java.util.*;

public class TimeZoneLoader {

    private static final String UPDATE_ENABLED = "net.fortuna.ical4j.timezone.update.enabled";
    private static final String UPDATE_CONNECT_TIMEOUT = "net.fortuna.ical4j.timezone.update.timeout.connect";
    private static final String UPDATE_READ_TIMEOUT = "net.fortuna.ical4j.timezone.update.timeout.read";
    private static final String UPDATE_PROXY_ENABLED = "net.fortuna.ical4j.timezone.update.proxy.enabled";
    private static final String UPDATE_PROXY_TYPE = "net.fortuna.ical4j.timezone.update.proxy.type";
    private static final String UPDATE_PROXY_HOST = "net.fortuna.ical4j.timezone.update.proxy.host";
    private static final String UPDATE_PROXY_PORT = "net.fortuna.ical4j.timezone.update.proxy.port";

    private static final String TZ_CACHE_IMPL = "net.fortuna.ical4j.timezone.cache.impl";

    private static final String DEFAULT_TZ_CACHE_IMPL = "net.fortuna.ical4j.util.JCacheTimeZoneCache";

    private static final String MESSAGE_MISSING_DEFAULT_TZ_CACHE_IMPL = "Error loading default cache implementation. Please ensure the JCache API dependency is included in the classpath, or override the cache implementation (e.g. via configuration: net.fortuna.ical4j.timezone.cache.impl=net.fortuna.ical4j.util.MapTimeZoneCache)";

    private static Proxy proxy = null;
    private static final Set<String> TIMEZONE_DEFINITIONS = new HashSet<String>();
    /** SilentSuite patch: start of the definitions generated for zones ical4j doesn't bundle. */
    private static final Instant GENERATED_FROM = Instant.parse("1900-01-01T00:00:00Z");

    static {
        TIMEZONE_DEFINITIONS.addAll(Arrays.asList(net.fortuna.ical4j.model.TimeZone.getAvailableIDs()));

        // Proxy configuration..
        try {
            if ("true".equals(Configurator.getProperty(UPDATE_PROXY_ENABLED).orElse("false"))) {
                final Proxy.Type type = Configurator.getEnumProperty(Proxy.Type.class, UPDATE_PROXY_TYPE).orElse(Proxy.Type.DIRECT);
                final String proxyHost = Configurator.getProperty(UPDATE_PROXY_HOST).orElse("");
                final int proxyPort = Configurator.getIntProperty(UPDATE_PROXY_PORT).orElse(-1);
                proxy = new Proxy(type, new InetSocketAddress(proxyHost, proxyPort));
            }
        }
        catch (Throwable e) {
            LoggerFactory.getLogger(TimeZoneLoader.class).warn(
                    "Error loading proxy server configuration: " + e.getMessage());
        }
    }

    private final String resourcePrefix;
    private final TimeZoneCache cache;

    public TimeZoneLoader(String resourcePrefix) {
        this(resourcePrefix, cacheInit());
    }

    public TimeZoneLoader(String resourcePrefix, TimeZoneCache cache) {
        this.resourcePrefix = resourcePrefix;
        this.cache = cache;
    }

    /**
     * Loads an existing VTimeZone from the classpath corresponding to the specified Java timezone.
     *
     * @throws ParseException
     */
    public VTimeZone loadVTimeZone(String id) throws IOException, ParserException, ParseException {
        Validate.notBlank(id, "Invalid TimeZone ID: [%s]", id);
        if (!cache.containsId(id)) {
            final URL resource = ResourceLoader.getResource(resourcePrefix + id + ".ics");
            if (resource != null) {
                try (InputStream in = resource.openStream()) {
                    final CalendarBuilder builder = new CalendarBuilder();
                    final Calendar calendar = builder.build(in);
                    final VTimeZone vTimeZone = (VTimeZone) calendar.getComponent(Component.VTIMEZONE);
                    // load any available updates for the timezone.. can be explicility disabled via configuration
                    if (!"false".equals(Configurator.getProperty(UPDATE_ENABLED).orElse("true"))) {
                        return updateDefinition(vTimeZone);
                    }
                    if (vTimeZone != null) {
                        cache.putIfAbsent(id, vTimeZone);
                    }
                }
            } else {
                return generateTimezoneForId(id);
            }
        }
        return cache.getTimezone(id);
    }

    /**
     * @param vTimeZone
     * @return
     */
    private VTimeZone updateDefinition(VTimeZone vTimeZone) throws IOException, ParserException {
        final TzUrl tzUrl = vTimeZone.getTimeZoneUrl();
        if (tzUrl != null) {
            final int connectTimeout = Configurator.getIntProperty(UPDATE_CONNECT_TIMEOUT).orElse(0);
            final int readTimeout = Configurator.getIntProperty(UPDATE_READ_TIMEOUT).orElse(0);

            URLConnection connection;
            URL url = tzUrl.getUri().toURL();

            if ("true".equals(Configurator.getProperty(UPDATE_PROXY_ENABLED).orElse("false")) && proxy != null) {
                connection = url.openConnection(proxy);
            } else {
                connection = url.openConnection();
            }

            connection.setConnectTimeout(connectTimeout);
            connection.setReadTimeout(readTimeout);

            final CalendarBuilder builder = new CalendarBuilder();

            final Calendar calendar = builder.build(connection.getInputStream());
            final VTimeZone updatedVTimeZone = (VTimeZone) calendar.getComponent(Component.VTIMEZONE);
            if (updatedVTimeZone != null) {
                return updatedVTimeZone;
            }
        }
        return vTimeZone;
    }

    private static VTimeZone generateTimezoneForId(String timezoneId) {
        if (!TIMEZONE_DEFINITIONS.contains(timezoneId)) {
            return null;
        }
        TimeZone javaTz = TimeZone.getTimeZone(timezoneId);

        ZoneId zoneId = ZoneId.of(javaTz.getID(), ZoneId.SHORT_IDS);

        // SilentSuite patch: generate the definition with SystemVTimeZones, which follows the
        // transitions themselves. Upstream converted the zone's transition rules to RRULEs and threw
        // a DateTimeException (LocalDate.withDayOfMonth) for a rule with a negative day-of-month
        // indicator, which Android's ZoneRules use for "last Sunday" rules. Europe/Kyiv, which
        // ical4j 3.0.20 doesn't bundle, has such rules, so any event in that zone without an
        // embedded VTIMEZONE failed to parse and stopped calendar sync. Upstream's addTransitions,
        // addTransitionRules, ZoneOffsetKey and the constants only they used are removed.
        // Offsets of tz database zones come from the platform rules anyway (TimeZone patch), so the
        // definition starts early enough for any event rather than covering all of history.
        final VTimeZone timezone = SystemVTimeZones.generate(zoneId, GENERATED_FROM);
        if (!timezoneId.equals(zoneId.getId())) {
            // keep the requested ID (as upstream) for aliases such as "PST"
            timezone.getProperties().remove(timezone.getTimeZoneId());
            timezone.getProperties().add(new TzId(timezoneId));
        }
        return timezone;
    }

    private static TimeZoneCache cacheInit() {
        Optional<TimeZoneCache> property = Configurator.getObjectProperty(TZ_CACHE_IMPL);
        return property.orElseGet(() -> {
            try {
                return (TimeZoneCache) Class.forName(DEFAULT_TZ_CACHE_IMPL).newInstance();
            } catch (InstantiationException | IllegalAccessException | ClassNotFoundException | NoClassDefFoundError e) {
                throw new RuntimeException(MESSAGE_MISSING_DEFAULT_TZ_CACHE_IMPL, e);
            }
        });
    }
}
