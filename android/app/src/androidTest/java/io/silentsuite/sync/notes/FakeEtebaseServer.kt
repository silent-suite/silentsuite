package io.silentsuite.sync.notes

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * An in-process stand-in for the Etebase server that answers the calls a Notes sync makes (signup,
 * collection create, collection list and fetch, item upload, item list and fetch), so the real
 * binding, runner, shared collection refresh, and local cache all run unchanged in a runtime test. It
 * answers from an OkHttp interceptor, so no socket is opened and no host is resolved.
 *
 * Collections and items are stored as uploaded, still encrypted, and listed back in the order they
 * last changed, a page at a time ([collectionPageSize], [itemPageSize]). Uploads of notes behave as
 * the project's server does (`server/etebase_server/fastapi/routers/collection.py`, item_create and
 * item_bulk_common): a transaction checks each item's etag against the item's current revision and
 * fails as a whole with 409, a batch does not check, an upload of the revision that is already
 * current succeeds without a change, an upload with a sync token that is not the collection's current
 * one gets 409, and a read-only member gets 403. The collection's own item is the exception: it is
 * taken as it comes, as a new revision of the collection, with no etag or revision check. [answer],
 * [loseAnswer] and [answerAsFor] make it misbehave on purpose.
 *
 * [hold] parks the next matching request until the test releases it, which is how a test puts a
 * request in flight. A parked request ignores thread interrupts, like a blocking socket read, so a
 * cancelled run sees its response arrive and must decide itself not to write. With
 * `swallowInterrupt`, the interrupt is also gone by the time the answer arrives, as when the
 * network stack consumes it.
 */
class FakeEtebaseServer(val baseUrl: String = "https://etebase-fake.invalid/") : Interceptor {
    private val host = baseUrl.toHttpUrl().host
    private val lock = Any()

    /** Every change bumps this; list stokens are "s<counter>", item stokens "i<counter>". */
    private var counter = 0L

    /** The most collections one list answer holds; the real server's default is 50. */
    @Volatile var collectionPageSize = 50

    /** The most items one item list answer holds; the real server's default is 50. */
    @Volatile var itemPageSize = 50

    /** How a listing that never finishes misbehaves: every answer says "not done", and it either ... */
    enum class Stall {
        /** ... gives no cursor for the next page, or */
        NO_CURSOR,

        /** ... gives back the cursor it was asked with (a fixed one when it was asked without). */
        SAME_CURSOR,
    }

    /** While set, the collection listing never finishes. */
    @Volatile var stalledCollectionList: Stall? = null

    private val stalledItemLists = ConcurrentHashMap<String, Stall>()

    /** Answers given by each stalled listing so far. */
    private val stalledAnswers = HashMap<String, Int>()

    /** Makes the item listing of [uid] never finish, or lets it finish again with null. */
    fun stallItemList(uid: String, how: Stall?) {
        if (how == null) stalledItemLists.remove(uid) else stalledItemLists[uid] = how
    }

    private class StoredItem(val body: Map<String, Any?>, val changedAt: Long)

    private class StoredCollection(
        val uid: String,
        var body: Map<String, Any?>,
        var changedAt: Long,
        var itemStoken: String,
        /** Left out of a listing that starts from a cursor, the way a membership change can be missed. */
        var hiddenFromIncremental: Boolean,
        var removedAt: Long? = null,
        /** By item uid; an item uploaded again moves to the end. */
        val items: LinkedHashMap<String, StoredItem> = LinkedHashMap(),
        /** The server's access levels: 0 read-only, 1 admin, 2 read-write. */
        var accessLevel: Long = 1L,
    )

    private val collections = LinkedHashMap<String, StoredCollection>()

    /** "<method> <path>?<query>" of every request, in order. */
    val requests: MutableList<String> = CopyOnWriteArrayList()

    inner class Hold internal constructor(
        private val predicate: (String, String) -> Boolean,
        internal val swallowInterrupt: Boolean,
        skip: Int,
        internal val answerFirst: Boolean,
    ) {
        internal val arrivedLatch = CountDownLatch(1)
        internal val releaseLatch = CountDownLatch(1)
        private val toSkip = AtomicInteger(skip)
        @Volatile internal var taken = false

        /** The parked request as [requests] records it, once it has arrived. */
        @Volatile var request: String? = null
            internal set

        internal fun matches(method: String, path: String) = predicate(method, path)

        /** True for the request this hold parks; the matching ones before it pass. */
        internal fun take(): Boolean {
            if (toSkip.getAndDecrement() > 0) return false
            taken = true
            return true
        }

        /** Waits until the held request has reached the server. */
        fun awaitArrival(seconds: Long = 30) {
            check(arrivedLatch.await(seconds, TimeUnit.SECONDS)) { "the held request never arrived" }
        }

        /** Whether the held request reaches the server within [millis]. */
        fun arrivesWithin(millis: Long): Boolean = arrivedLatch.await(millis, TimeUnit.MILLISECONDS)

        fun release() = releaseLatch.countDown()
    }

    private val holds = CopyOnWriteArrayList<Hold>()

    /**
     * An answer given instead of the route's own: a status with an error body, a dropped connection, the
     * route's answer lost after it was applied, or the answer the route gives for another path.
     */
    private class Scripted(
        val method: String,
        val path: Regex,
        var times: Int,
        val code: Int? = null,
        val lose: Boolean = false,
        val answerFor: String? = null,
    )

    private val scripted = CopyOnWriteArrayList<Scripted>()

    /** The number of items in each upload the stand-in routed, in order; a scripted answer is not counted. */
    val uploadSizes: MutableList<Int> = CopyOnWriteArrayList()

    /**
     * Answers the next [times] requests whose method and path match with [code] and an error body,
     * without applying them; [code] null drops the connection before anything is applied instead.
     */
    fun answer(method: String, pathPattern: Regex, code: Int?, times: Int = 1) {
        scripted += Scripted(method, pathPattern, times, code = code)
    }

    /** The next [times] matching requests are applied, and then their answer is lost: the connection drops. */
    fun loseAnswer(method: String, pathPattern: Regex, times: Int = 1) {
        scripted += Scripted(method, pathPattern, times, lose = true)
    }

    /** The next [times] requests for [path] get the answer the server gives for [otherPath], as a server that mixes up rows would. */
    fun answerAsFor(method: String, path: String, otherPath: String, times: Int = 1) {
        scripted += Scripted(method, Regex(Regex.escape(path)), times, answerFor = otherPath)
    }

    /**
     * Parks the next request whose method and path (after "/api/v1/") match, until released. With
     * [skip], that many matching requests pass first, so a later page of a listing can be parked.
     * With [answerFirst], the answer is built from the server's state when the request arrives and
     * is then parked on its way back, so what it carries can be out of date once it is released.
     */
    fun hold(method: String, pathPattern: Regex, swallowInterrupt: Boolean = false, skip: Int = 0, answerFirst: Boolean = false): Hold =
        Hold({ m, p -> m == method && pathPattern.matches(p) }, swallowInterrupt, skip, answerFirst).also { holds += it }

    /** Adds a collection the account can see, as if it was just shared with this account and accepted. */
    fun addCollection(collectionIn: Map<String, Any?>, hiddenFromIncremental: Boolean = false) = synchronized(lock) {
        store(collectionIn, hiddenFromIncremental)
    }

    /**
     * As if an invitation to [uid] was just accepted: the collection changes now, but a listing that
     * starts from an earlier cursor does not show it, only one from scratch does. This is the case
     * the forced collection refresh after an acceptance exists for.
     */
    fun acceptedFromInvitation(uid: String) = synchronized(lock) {
        val stored = collections.getValue(uid)
        stored.hiddenFromIncremental = true
        stored.changedAt = ++counter
    }

    /**
     * As if the account lost access to [uid] (the owner removed it, or it was deleted): later
     * listings leave it out, and only one that starts from an earlier cursor reports the removal.
     */
    fun removeMembership(uid: String) = synchronized(lock) {
        collections.getValue(uid).removedAt = ++counter
    }

    /** As if the owner changed this account's access to [uid]; a listing from an earlier cursor shows it. */
    fun setAccessLevel(uid: String, level: Long) = synchronized(lock) {
        val stored = collections.getValue(uid)
        stored.accessLevel = level
        stored.changedAt = ++counter
    }

    /** The uids of the items the server holds in [uid], deleted ones included. */
    fun itemUids(uid: String): Set<String> = synchronized(lock) { collections.getValue(uid).items.keys.toSet() }

    /** A new item stoken for a collection, as if another device changed its notes. */
    fun touchItems(uid: String) = synchronized(lock) {
        val stored = collections.getValue(uid)
        stored.itemStoken = "i${++counter}"
        stored.changedAt = counter
    }

    fun collectionUids(): Set<String> = synchronized(lock) { collections.keys.toSet() }

    /** The item cursor a full fetch of [uid] ends at. */
    fun itemStoken(uid: String): String = synchronized(lock) { collections.getValue(uid).itemStoken }

    /** Lets every parked request go, so no test leaves a Notes worker waiting. */
    fun releaseAll() = holds.forEach { it.release() }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.url.host != host) throw IOException("the fake Etebase server has no route to ${request.url.host}")
        val path = request.url.encodedPath.removePrefix("/api/v1/")
        val line = "${request.method} $path" + (request.url.encodedQuery?.let { "?$it" } ?: "")
        requests += line
        // Requests of different accounts arrive on different threads.
        val hold = synchronized(holds) {
            holds.firstOrNull { !it.taken && it.matches(request.method, path) }?.takeIf { it.take() }
        }
        if (hold != null && !hold.answerFirst) park(hold, line)
        val body = request.body?.let { Buffer().also(it::writeTo).readByteArray() }
        val script = synchronized(scripted) {
            scripted.firstOrNull { it.times > 0 && it.method == request.method && it.path.matches(path) }?.also { it.times-- }
        }
        if (script != null && !script.lose && script.answerFor == null) {
            if (hold != null && hold.answerFirst) park(hold, line)
            if (script.code == null) throw IOException("the fake Etebase server dropped the connection")
            return respond(request, script.code, TestMsgPack.encode(linkedMapOf("code" to "scripted", "detail" to "a scripted answer")))
        }
        val routed = script?.answerFor ?: path
        val (code, payload) = synchronized(lock) { route(request.method, routed, request.url, body) }
        if (hold != null && hold.answerFirst) park(hold, line)
        if (script?.lose == true) throw IOException("the fake Etebase server dropped the connection after applying the request")
        return respond(request, code, payload)
    }

    private fun respond(request: okhttp3.Request, code: Int, payload: ByteArray): Response {
        return Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(if (code < 300) "OK" else "Error")
            .body(payload.toResponseBody("application/msgpack".toMediaType()))
            .build()
    }

    private fun park(hold: Hold, line: String) {
        hold.request = line
        hold.arrivedLatch.countDown()
        awaitUninterruptibly(hold.releaseLatch, hold.swallowInterrupt)
    }

    private fun awaitUninterruptibly(latch: CountDownLatch, swallowInterrupt: Boolean) {
        var interrupted = false
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        while (latch.count > 0 && System.nanoTime() < deadline) {
            try {
                latch.await(100, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                interrupted = true
            }
        }
        if (swallowInterrupt) Thread.interrupted() else if (interrupted) Thread.currentThread().interrupt()
    }

    @Suppress("UNCHECKED_CAST")
    private fun route(method: String, path: String, url: HttpUrl, body: ByteArray?): Pair<Int, ByteArray> = when {
        method == "POST" && path == "authentication/signup/" -> {
            val input = TestMsgPack.decode(body!!) as Map<String, Any?>
            val user = input["user"] as Map<String, Any?>
            201 to TestMsgPack.encode(linkedMapOf(
                "token" to "fake-token",
                "user" to linkedMapOf(
                    "username" to user["username"],
                    "email" to user["email"],
                    "pubkey" to input["pubkey"],
                    "encryptedContent" to input["encryptedContent"],
                ),
            ))
        }
        method == "POST" && path == "collection/" -> {
            store(TestMsgPack.decode(body!!) as Map<String, Any?>, hiddenFromIncremental = false)
            201 to ByteArray(0)
        }
        method == "POST" && path == "collection/list_multi/" -> {
            val stoken = url.queryParameter("stoken")
            val page = listCollections(stoken)
            stalledCollectionList?.let { stalled("collections", it, page, stoken ?: "f0") } ?: (200 to TestMsgPack.encode(page))
        }
        method == "POST" && ITEM_UPLOAD.matches(path) -> {
            val match = ITEM_UPLOAD.find(path)!!
            val stored = collections[match.groupValues[1]]
            val input = TestMsgPack.decode(body!!) as Map<String, Any?>
            uploadSizes += (input["items"] as List<*>).size
            val stoken = url.queryParameter("stoken")
            when {
                stored == null || stored.removedAt != null -> noCollection()
                stored.accessLevel == 0L -> 403 to TestMsgPack.encode(linkedMapOf(
                    "code" to "no_write_access", "detail" to "You need write access to write to this collection"))
                stoken != null && stoken != stored.itemStoken ->
                    409 to TestMsgPack.encode(linkedMapOf("code" to "stale_stoken", "detail" to "Stoken is too old"))
                else -> upload(stored, input, validateEtag = match.groupValues[2] == "transaction")
            }
        }
        method == "GET" && ITEM_LIST.matches(path) -> {
            val stored = collections[ITEM_LIST.find(path)!!.groupValues[1]]
            if (stored == null || stored.removedAt != null) {
                noCollection()
            } else {
                val stoken = url.queryParameter("stoken")
                val page = listItems(stored, stoken)
                stalledItemLists[stored.uid]?.let { stalled("items ${stored.uid}", it, page, stoken ?: "i0") } ?: (200 to TestMsgPack.encode(page))
            }
        }
        method == "GET" && ITEM_GET.matches(path) -> {
            val match = ITEM_GET.find(path)!!
            val stored = collections[match.groupValues[1]]
            val item = stored?.items?.get(match.groupValues[2])
            when {
                stored == null || stored.removedAt != null -> noCollection()
                // The project's server has no 404 for this: queryset.get raises, and the answer is a 500.
                item == null -> 500 to TestMsgPack.encode(linkedMapOf("code" to "server_error", "detail" to "Internal Server Error"))
                else -> 200 to TestMsgPack.encode(item.body)
            }
        }
        method == "GET" && COLLECTION_GET.matches(path) -> {
            val stored = collections[COLLECTION_GET.find(path)!!.groupValues[1]]
            if (stored == null || stored.removedAt != null) noCollection() else 200 to TestMsgPack.encode(collectionOut(stored))
        }
        else -> 404 to TestMsgPack.encode(linkedMapOf("code" to "not_found", "detail" to "$method $path"))
    }

    /**
     * item_bulk_common and item_create: all or nothing, and with [validateEtag] each item's etag must
     * name the item's current revision, unless the item is already at the revision being uploaded.
     */
    @Suppress("UNCHECKED_CAST")
    private fun upload(stored: StoredCollection, input: Map<String, Any?>, validateEtag: Boolean): Pair<Int, ByteArray> {
        val items = input["items"] as List<Map<String, Any?>>
        // The collection's own item is taken as it comes, below; only notes are checked against an etag.
        val errors = items.filter { it["uid"] != stored.uid }.mapNotNull { item ->
            val uid = item["uid"] as String
            val current = stored.items[uid]?.let { revisionOf(it.body) }
            when {
                current == revisionOf(item) -> null
                validateEtag && current != item["etag"] -> linkedMapOf("code" to "wrong_etag",
                    "detail" to "Wrong etag. Expected $current got ${item["etag"]}", "field" to uid)
                else -> null
            }
        }
        if (errors.isNotEmpty()) {
            return 409 to TestMsgPack.encode(linkedMapOf("code" to "item_failed", "detail" to "Items failed to validate", "errors" to errors))
        }
        for (item in items) {
            val uid = item["uid"] as String
            if (uid == stored.uid) {
                // The collection's own item: a new revision of the collection, not a note.
                stored.body = LinkedHashMap(stored.body).apply { put("item", item) }
                stored.changedAt = ++counter
                continue
            }
            if (stored.items[uid]?.let { revisionOf(it.body) } == revisionOf(item)) continue
            stored.items.remove(uid)
            stored.items[uid] = StoredItem(item.filterKeys { it != "etag" }, ++counter)
            stored.itemStoken = "i$counter"
            stored.changedAt = counter
        }
        return 200 to ByteArray(0)
    }

    @Suppress("UNCHECKED_CAST")
    private fun revisionOf(item: Map<String, Any?>): String? = (item["content"] as? Map<String, Any?>)?.get("uid") as? String

    @Suppress("UNCHECKED_CAST")
    private fun collectionOut(stored: StoredCollection): Map<String, Any?> = linkedMapOf(
        "collectionType" to stored.body["collectionType"],
        "collectionKey" to stored.body["collectionKey"],
        "accessLevel" to stored.accessLevel,
        "stoken" to stored.itemStoken,
        "item" to (stored.body["item"] as Map<String, Any?>).filterKeys { it != "etag" },
    )

    @Suppress("UNCHECKED_CAST")
    private fun store(collectionIn: Map<String, Any?>, hiddenFromIncremental: Boolean) {
        val item = collectionIn["item"] as Map<String, Any?>
        val uid = item["uid"] as String
        counter++
        collections[uid] = StoredCollection(uid, collectionIn, counter, "i$counter", hiddenFromIncremental)
    }

    private fun noCollection() =
        404 to TestMsgPack.encode(linkedMapOf("code" to "not_found", "detail" to "Collection does not exist"))

    /**
     * The page a stalled listing answers with: the real rows, but never done. After [STALL_LIMIT]
     * such answers the listing fails instead, so a client that never gives up still ends and its
     * test fails on the number of requests, not on a timeout.
     */
    private fun stalled(listing: String, how: Stall, page: Map<String, Any?>, sameCursor: String): Pair<Int, ByteArray> {
        val answers = (stalledAnswers[listing] ?: 0) + 1
        stalledAnswers[listing] = answers
        if (answers > STALL_LIMIT) {
            return 500 to TestMsgPack.encode(linkedMapOf("code" to "stalled", "detail" to "The client kept asking"))
        }
        val answer = LinkedHashMap(page)
        answer["stoken"] = if (how == Stall.NO_CURSOR) null else sameCursor
        answer["done"] = false
        return 200 to TestMsgPack.encode(answer)
    }

    /**
     * One page of a collection's items that changed after [stoken], oldest change first. The last
     * page ends at the collection's own item stoken, so a full fetch leaves the two equal.
     */
    private fun listItems(stored: StoredCollection, stoken: String?): Map<String, Any?> {
        val since = stoken?.removePrefix("i")?.toLongOrNull()
        val changed = stored.items.values.filter { since == null || it.changedAt > since }
        val page = changed.take(itemPageSize)
        val done = changed.size <= itemPageSize
        return linkedMapOf(
            "data" to page.map { it.body },
            "stoken" to if (done) stored.itemStoken else "i${page.last().changedAt}",
            "done" to done,
        )
    }

    /**
     * One page of the collections that changed after [stoken], oldest change first. A listing from
     * scratch continues with "f" cursors until its last page, so its later pages still show what a
     * listing from an earlier "s" cursor leaves out.
     */
    @Suppress("UNCHECKED_CAST")
    private fun listCollections(stoken: String?): Map<String, Any?> {
        val fromScratch = stoken == null || stoken.startsWith("f")
        val since = stoken?.drop(1)?.toLongOrNull()
        val changed = collections.values
            .filter { it.removedAt == null && (since == null || it.changedAt > since) && (fromScratch || !it.hiddenFromIncremental) }
            .sortedBy { it.changedAt }
        val page = changed.take(collectionPageSize)
        val done = changed.size <= collectionPageSize
        val data = page.map(::collectionOut)
        val next = if (done) "s$counter" else (if (fromScratch) "f" else "s") + page.last().changedAt
        val result = linkedMapOf<String, Any?>("data" to data, "stoken" to next, "done" to done)
        if (since != null && !fromScratch) {
            val removed = collections.values.filter { (it.removedAt ?: 0) > since }.map { linkedMapOf("uid" to it.uid) }
            if (removed.isNotEmpty()) result["removedMemberships"] = removed
        }
        return result
    }

    private companion object {
        val ITEM_LIST = Regex("collection/([^/]+)/item/")
        val ITEM_UPLOAD = Regex("collection/([^/]+)/item/(batch|transaction)/")
        val ITEM_GET = Regex("collection/([^/]+)/item/([^/]+)/")
        val COLLECTION_GET = Regex("collection/([^/]+)/")
        const val STALL_LIMIT = 20
    }
}

/**
 * The msgpack subset the Etebase API uses: nil, booleans, integers, strings, binary, arrays, and
 * maps with string keys. Decoded maps keep their order, and binary comes back as [ByteArray].
 */
object TestMsgPack {
    fun decode(bytes: ByteArray): Any? {
        val reader = Reader(bytes)
        val value = reader.read()
        check(reader.offset == bytes.size) { "trailing bytes after the msgpack value" }
        return value
    }

    fun encode(value: Any?): ByteArray = ByteArrayOutputStream().also { write(it, value) }.toByteArray()

    private class Reader(val b: ByteArray) {
        var offset = 0

        private fun u8() = b[offset++].toInt() and 0xff
        private fun uint(bytes: Int): Long {
            var v = 0L
            repeat(bytes) { v = (v shl 8) or u8().toLong() }
            return v
        }
        private fun bytes(n: Int) = b.copyOfRange(offset, offset + n).also { offset += n }
        private fun str(n: Int) = String(bytes(n), Charsets.UTF_8)
        private fun array(n: Int) = List(n) { read() }
        private fun map(n: Int): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            repeat(n) { m[read() as String] = read() }
            return m
        }

        fun read(): Any? {
            val t = u8()
            return when {
                t <= 0x7f -> t.toLong()
                t in 0x80..0x8f -> map(t and 0x0f)
                t in 0x90..0x9f -> array(t and 0x0f)
                t in 0xa0..0xbf -> str(t and 0x1f)
                t >= 0xe0 -> (t - 0x100).toLong()
                else -> when (t) {
                    0xc0 -> null
                    0xc2 -> false
                    0xc3 -> true
                    0xc4 -> bytes(uint(1).toInt())
                    0xc5 -> bytes(uint(2).toInt())
                    0xc6 -> bytes(uint(4).toInt())
                    0xcc -> uint(1)
                    0xcd -> uint(2)
                    0xce -> uint(4)
                    0xcf -> uint(8)
                    0xd0 -> uint(1).toByte().toLong()
                    0xd1 -> uint(2).toShort().toLong()
                    0xd2 -> uint(4).toInt().toLong()
                    0xd3 -> uint(8)
                    0xd9 -> str(uint(1).toInt())
                    0xda -> str(uint(2).toInt())
                    0xdb -> str(uint(4).toInt())
                    0xdc -> array(uint(2).toInt())
                    0xdd -> array(uint(4).toInt())
                    0xde -> map(uint(2).toInt())
                    0xdf -> map(uint(4).toInt())
                    else -> throw IllegalArgumentException("msgpack type 0x${t.toString(16)} is not used by the Etebase API")
                }
            }
        }
    }

    private fun header(out: ByteArrayOutputStream, n: Int, fix: Int, fixMax: Int, c16: Int, c32: Int) {
        when {
            n <= fixMax -> out.write(fix or n)
            n <= 0xffff -> { out.write(c16); out.write(n ushr 8); out.write(n) }
            else -> { out.write(c32); for (s in intArrayOf(24, 16, 8, 0)) out.write(n ushr s) }
        }
    }

    private fun write(out: ByteArrayOutputStream, value: Any?) {
        when (value) {
            null -> out.write(0xc0)
            is Boolean -> out.write(if (value) 0xc3 else 0xc2)
            is Int -> write(out, value.toLong())
            is Long -> when {
                value in 0..0x7f -> out.write(value.toInt())
                value in -32..-1 -> out.write(value.toInt() and 0xff)
                value >= 0 -> { out.write(0xcf); for (s in 56 downTo 0 step 8) out.write((value ushr s).toInt()) }
                else -> { out.write(0xd3); for (s in 56 downTo 0 step 8) out.write((value ushr s).toInt()) }
            }
            is String -> {
                val bytes = value.toByteArray(Charsets.UTF_8)
                if (bytes.size <= 31) out.write(0xa0 or bytes.size) else header(out, bytes.size, 0, -1, 0xda, 0xdb)
                out.write(bytes)
            }
            is ByteArray -> {
                if (value.size <= 0xff) { out.write(0xc4); out.write(value.size) } else header(out, value.size, 0, -1, 0xc5, 0xc6)
                out.write(value)
            }
            is List<*> -> { header(out, value.size, 0x90, 15, 0xdc, 0xdd); value.forEach { write(out, it) } }
            is Map<*, *> -> {
                header(out, value.size, 0x80, 15, 0xde, 0xdf)
                for ((k, v) in value) { write(out, k as String); write(out, v) }
            }
            else -> throw IllegalArgumentException("cannot encode ${value.javaClass}")
        }
    }
}
