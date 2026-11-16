package io.silentsuite.sync.ui.etebase

import android.content.Context
import android.os.Bundle
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.text.format.DateFormat
import android.text.format.DateUtils
import android.view.*
import android.widget.TextView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentManager
import androidx.fragment.app.FragmentPagerAdapter
import androidx.fragment.app.activityViewModels
import androidx.fragment.app.viewModels
import androidx.lifecycle.ViewModel
import androidx.viewpager.widget.ViewPager
import at.bitfire.ical4android.Event
import at.bitfire.ical4android.InvalidCalendarException
import at.bitfire.ical4android.Task
import at.bitfire.ical4android.TaskProvider
import at.bitfire.vcard4android.Contact
import io.silentsuite.sync.CachedCollection
import io.silentsuite.sync.CachedItem
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.resource.*
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.utils.EventEmailInvitation
import io.silentsuite.sync.utils.TaskProviderHandling
import com.etebase.client.CollectionAccessLevel
import com.google.android.material.tabs.TabLayout
import ezvcard.util.PartialDate
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.StringReader
import java.text.SimpleDateFormat
import java.util.*

/** Holds the opened entry across configuration changes, in process memory only. */
class CollectionItemContentViewModel : ViewModel() {
    var item: CachedItem? = null
}

class CollectionItemFragment : Fragment() {
    private val model: AccountViewModel by activityViewModels()
    private val collectionModel: CollectionViewModel by activityViewModels()

    private val retained: CollectionItemContentViewModel by viewModels()

    private lateinit var cachedItem: CachedItem

    private var emailInvitationEvent: Event? = null
    private var emailInvitationEventString: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The entry stays in process memory only: a rotation gets it back from the retained model,
        // and a screen restored without it returns to the list instead of showing nothing.
        if (::cachedItem.isInitialized) retained.item = cachedItem
        else retained.item?.let { cachedItem = it }
        if (!::cachedItem.isInitialized) {
            parentFragmentManager.popBackStack()
            return
        }
        if (savedInstanceState != null && childFragmentManager.fragments.isNotEmpty()) {
            // The restored tabs lost their in-memory entry; they are built again from the retained one.
            childFragmentManager.beginTransaction().apply {
                childFragmentManager.fragments.forEach { remove(it) }
            }.commitNowAllowingStateLoss()
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val ret = inflater.inflate(R.layout.journal_item_activity, container, false)
        setHasOptionsMenu(true)

        if (::cachedItem.isInitialized) {
            collectionModel.observe(this) {
                (activity as? BaseActivity?)?.supportActionBar?.title = it.meta.name
                if (container != null) {
                    initUi(inflater, ret, it)
                }
                // Restore depends on the collection type, which is only known once it loads.
                activity?.invalidateOptionsMenu()
            }
        }

        return ret
    }

    private fun initUi(inflater: LayoutInflater, v: View, cachedCollection: CachedCollection) {
        val viewPager = v.findViewById<ViewPager>(R.id.viewpager)
        viewPager.adapter = TabsAdapter(childFragmentManager, requireContext(), cachedCollection, cachedItem)

        val tabLayout = v.findViewById<TabLayout>(R.id.tabs)
        tabLayout.setupWithViewPager(viewPager)

        v.findViewById<View>(R.id.journal_list_item).visibility = View.GONE
    }

    fun allowSendEmail(event: Event?, icsContent: String) {
        emailInvitationEvent = event
        emailInvitationEventString = icsContent
        activity?.invalidateOptionsMenu()
    }

    override fun onCreateOptionsMenu(menu: Menu, inflater: MenuInflater) {
        inflater.inflate(R.menu.collection_item_fragment, menu)
        menu.setGroupVisible(R.id.journal_item_menu_event_invite, emailInvitationEvent != null)
        // Only calendars, tasks, and contacts have a local provider to restore into; notes do not.
        // A read-only address book cannot take a restored contact, and an entry screen the
        // framework recreated has no entry content left to restore.
        val cachedCol = collectionModel.value
        val readOnlyContacts = cachedCol != null && cachedCol.collectionType == Constants.ETEBASE_TYPE_ADDRESS_BOOK &&
            cachedCol.col.accessLevel == CollectionAccessLevel.ReadOnly
        menu.setGroupVisible(R.id.journal_item_menu_restore,
            cachedCol?.collectionType in RESTORABLE_TYPES && !readOnlyContacts && ::cachedItem.isInitialized)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        val accountHolder = model.value!!
        when (item.itemId) {
            R.id.on_send_event_invite -> {
                val account = accountHolder.account
                val intent = EventEmailInvitation(requireContext(), account).createIntent(emailInvitationEvent!!, emailInvitationEventString!!)
                // Attachment creation can fail, in which case no share Intent exists.
                // Newer AndroidX nullability annotations correctly expose that contract.
                intent?.let(::startActivity)
            }
            R.id.on_restore_item -> {
                if (collectionModel.value?.collectionType == Constants.ETEBASE_TYPE_ADDRESS_BOOK)
                    confirmContactRestore(accountHolder)
                else
                    restoreItem(accountHolder)
            }
        }
        return super.onOptionsItemSelected(item)
    }

    /** A contact is only written back after the user confirms; cancelling writes nothing. */
    private fun confirmContactRestore(accountHolder: AccountHolder) {
        MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.journal_item_restore_action)
                .setIcon(R.drawable.ic_restore_black)
                .setMessage(R.string.contact_restore_confirm_body)
                .setPositiveButton(R.string.journal_item_restore_action) { _, _ ->
                    if (isAdded) restoreItem(accountHolder)
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
    }

    fun restoreItem(accountHolder: AccountHolder) {
        // FIXME: This code makes the assumption that providers are all available. May not be true for tasks, and potentially others too.
        val context = requireContext()
        val account = accountHolder.account
        val cachedCol = collectionModel.value!!
        if (!::cachedItem.isInitialized) return
        val restored = when (cachedCol.collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR -> {
                val provider = context.contentResolver.acquireContentProviderClient(CalendarContract.CONTENT_URI)
                        ?: return
                try {
                    val localCalendar = LocalCalendar.findByName(account, provider, LocalCalendar.Factory, cachedCol.col.uid)
                            ?: return
                    val event = Event.eventsFromReader(StringReader(cachedItem.content))[0]
                    var localEvent = localCalendar.findByUid(event.uid!!)
                    if (localEvent != null) {
                        localEvent.updateAsDirty(event)
                    } else {
                        localEvent = LocalEvent(localCalendar, event, event.uid, null)
                        localEvent.addAsDirty()
                    }
                    true
                } finally {
                    provider.release()
                }
            }
            Constants.ETEBASE_TYPE_TASKS -> {
                TaskProviderHandling.getWantedTaskSyncProvider(context)?.let {
                    val provider = TaskProvider.acquire(context, it)
                            ?: return
                    try {
                        val localTaskList = LocalTaskList.findByName(account, provider, LocalTaskList.Factory, cachedCol.col.uid)
                                ?: return
                        val task = Task.tasksFromReader(StringReader(cachedItem.content))[0]
                        var localTask = localTaskList.findByUid(task.uid!!)
                        if (localTask != null) {
                            localTask.updateAsDirty(task)
                        } else {
                            localTask = LocalTask(localTaskList, task, task.uid, null)
                            localTask.addAsDirty()
                        }
                        true
                    } finally {
                        provider.close()
                    }
                } ?: false
            }
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> {
                val identity = CollectionLifecycleIdentity.from(arguments)
                if (cachedCol.col.accessLevel == CollectionAccessLevel.ReadOnly) {
                    MaterialAlertDialogBuilder(context)
                            .setIcon(R.drawable.ic_info_dark)
                            .setTitle(R.string.not_allowed_title)
                            .setMessage(R.string.contact_restore_read_only)
                            .setPositiveButton(android.R.string.ok, null)
                            .show()
                    return
                }
                if (identity?.account != account) return
                restoreContact(context, identity, cachedCol, cachedItem.content)
            }
            else -> false
        }
        // Report success only for a restore that happened; the menu hides Restore for other types.
        if (!restored) return

        val dialog = MaterialAlertDialogBuilder(context)
                .setTitle(R.string.journal_item_restore_action)
                .setIcon(R.drawable.ic_restore_black)
                .setMessage(R.string.journal_item_restore_dialog_body)
                .setPositiveButton(android.R.string.ok) { dialog, which ->
                    // dismiss
                }
                .create()
        dialog.show()
    }

    companion object {
        private val RESTORABLE_TYPES = setOf(
            Constants.ETEBASE_TYPE_CALENDAR,
            Constants.ETEBASE_TYPE_TASKS,
            Constants.ETEBASE_TYPE_ADDRESS_BOOK,
        )

        /** [identity] holds identifiers only; the entry content never goes into arguments. */
        fun newInstance(cachedItem: CachedItem, identity: CollectionLifecycleIdentity? = null): CollectionItemFragment {
            val ret = CollectionItemFragment()
            ret.cachedItem = cachedItem
            ret.arguments = identity?.toBundle()
            return ret
        }

        /**
         * Writes [vcard] back into the exact local address book of [cachedCollection] as a dirty
         * contact for the next upload. Nothing is written for another collection, a collection the
         * cached access level or the local address book marks read-only, or an account generation
         * that was replaced, which is checked again right before the write. The destination must be
         * the child address book recorded for this exact parent generation; one a previous
         * generation left behind, or one without a recorded owner, is never written.
         */
        internal fun restoreContact(
            context: Context,
            identity: CollectionLifecycleIdentity?,
            cachedCollection: CachedCollection,
            vcard: String
        ): Boolean {
            val addressBookUid = cachedCollection.col.uid
            if (identity == null || cachedCollection.collectionType != Constants.ETEBASE_TYPE_ADDRESS_BOOK ||
                identity.collectionType != Constants.ETEBASE_TYPE_ADDRESS_BOOK || identity.collectionUid != addressBookUid ||
                cachedCollection.col.accessLevel == CollectionAccessLevel.ReadOnly || !identity.validate(context)) return false
            val provider = context.contentResolver.acquireContentProviderClient(ContactsContract.RawContacts.CONTENT_URI)
                    ?: return false
            try {
                val manager = android.accounts.AccountManager.get(context)
                val owner = io.silentsuite.sync.syncadapter.SyncStatusStore(context)
                    .identity(identity.account, identity.creationId).storageKey
                fun exactChild(book: LocalAddressBook): Boolean = runCatching {
                    book.url == addressBookUid && book.mainAccountOrNull == identity.account &&
                        manager.getUserData(book.androidAccount, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_IDENTITY) == owner
                }.getOrDefault(false)
                val localAddressBook = manager.getAccountsByType(io.silentsuite.sync.App.addressBookAccountType)
                    .map { LocalAddressBook(context, it, provider) }
                    .singleOrNull { exactChild(it) } ?: return false
                if (localAddressBook.readOnly) return false
                val contact = Contact.fromReader(StringReader(vcard), null).firstOrNull() ?: return false
                // FIXME: restoring a contact group is not currently supported
                if (contact.group) return false
                if (!identity.validate(context) || !exactChild(localAddressBook) || localAddressBook.readOnly) return false
                var localContact = localAddressBook.findByUid(contact.uid!!) as LocalContact?
                if (localContact != null) {
                    localContact.updateAsDirty(contact)
                } else {
                    localContact = LocalContact(localAddressBook, contact, contact.uid, null)
                    localContact.createAsDirty()
                }
                return true
            } finally {
                provider.release()
            }
        }
    }
}

private class TabsAdapter(fm: FragmentManager, private val context: Context, private val cachedCollection: CachedCollection, private val cachedItem: CachedItem) : FragmentPagerAdapter(fm, BEHAVIOR_RESUME_ONLY_CURRENT_FRAGMENT) {

    override fun getCount(): Int {
        // FIXME: Make it depend on info enumType (only have non-raw for known types)
        return 3
    }

    override fun getPageTitle(position: Int): CharSequence? {
        return if (position == 0) {
            context.getString(R.string.journal_item_tab_main)
        } else if (position == 1) {
            context.getString(R.string.journal_item_tab_raw)
        } else {
            context.getString(R.string.journal_item_tab_revisions)
        }
    }

    override fun getItem(position: Int): Fragment {
        return if (position == 0) {
            PrettyFragment.newInstance(cachedCollection, cachedItem.content)
        } else if (position == 1) {
            TextFragment.newInstance(cachedItem.content)
        } else {
            ItemRevisionsListFragment.newInstance(cachedCollection, cachedItem)
        }
    }
}


class TextFragment : Fragment() {
    private lateinit var content: String
    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val v = inflater.inflate(R.layout.text_fragment, container, false)

        val tv = v.findViewById<View>(R.id.content) as TextView

        tv.text = content

        return v
    }

    companion object {
        fun newInstance(content: String): TextFragment {
            val ret = TextFragment()
            ret.content = content
            return ret
        }
    }
}

class PrettyFragment : Fragment() {
    private var asyncTask: Job? = null
    private lateinit var cachedCollection: CachedCollection
    private lateinit var content: String

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        var v: View? = null

        when (cachedCollection.collectionType) {
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> {
                // Filled in onViewCreated, once this view is the fragment's view.
                v = inflater.inflate(R.layout.contact_info, container, false)
            }
            Constants.ETEBASE_TYPE_CALENDAR -> {
                v = inflater.inflate(R.layout.event_info, container, false)
                asyncTask = loadEventTask(v)
            }
            Constants.ETEBASE_TYPE_TASKS -> {
                v = inflater.inflate(R.layout.task_info, container, false)
                asyncTask = loadTaskTask(v)
            }
            Constants.ETEBASE_TYPE_NOTES -> {
                // A note is Markdown text; show it as written rather than a blank tab.
                v = inflater.inflate(R.layout.text_fragment, container, false)
                v.findViewById<TextView>(R.id.content).text = content
            }
        }

        return v
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        if (cachedCollection.collectionType == Constants.ETEBASE_TYPE_ADDRESS_BOOK)
            asyncTask = loadContactTask(view)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        if (asyncTask != null)
            asyncTask!!.cancel()
    }

    private fun loadEventTask(view: View): Job {
        return lifecycleScope.launch {
            val event = withContext(Dispatchers.IO) {
                var result: Event? = null
                val inputReader = StringReader(content)

                try {
                    result = Event.eventsFromReader(inputReader, null)[0]
                } catch (e: InvalidCalendarException) {
                    e.printStackTrace()
                } catch (e: IOException) {
                    e.printStackTrace()
                }
                result
            }

            if (event != null) {
                    val loader = view.findViewById<View>(R.id.event_info_loading_msg)
                    loader.visibility = View.GONE
                    val contentContainer = view.findViewById<View>(R.id.event_info_scroll_view)
                    contentContainer.visibility = View.VISIBLE

                    setTextViewText(view, R.id.title, event.summary)

                    val dtStart = event.dtStart?.date?.time
                    // DTEND is optional: without it, the end follows from DURATION or DTSTART (RFC 5545 3.6.1)
                    val dtEnd = event.getEndDate(true)?.date?.time
                    if ((dtStart == null) || (dtEnd == null)) {
                        setTextViewText(view, R.id.when_datetime, getString(R.string.loading_error_title))
                    } else {
                        setTextViewText(view, R.id.when_datetime, getDisplayedDatetime(dtStart, dtEnd, event.isAllDay(), context))
                    }

                    setTextViewText(view, R.id.where, event.location)

                    val organizer = event.organizer
                    if (organizer != null) {
                        val tv = view.findViewById<View>(R.id.organizer) as TextView
                        tv.text = organizer.calAddress.toString().replaceFirst("mailto:".toRegex(), "")
                    } else {
                        val organizerView = view.findViewById<View>(R.id.organizer_container)
                        organizerView.visibility = View.GONE
                    }

                    setTextViewText(view, R.id.description, event.description)

                    var first = true
                    var sb = StringBuilder()
                    for (attendee in event.attendees) {
                        if (first) {
                            first = false
                            sb.append(getString(R.string.journal_item_attendees)).append(": ")
                        } else {
                            sb.append(", ")
                        }
                        sb.append(attendee.calAddress.toString().replaceFirst("mailto:".toRegex(), ""))
                    }
                    setTextViewText(view, R.id.attendees, sb.toString())

                    first = true
                    sb = StringBuilder()
                    for (alarm in event.alarms) {
                        if (first) {
                            first = false
                            sb.append(getString(R.string.journal_item_reminders)).append(": ")
                        } else {
                            sb.append(", ")
                        }
                        sb.append(alarm.trigger.value)
                    }
                    setTextViewText(view, R.id.reminders, sb.toString())

                    if (event.attendees.isNotEmpty()) {
                        (parentFragment as? CollectionItemFragment)?.allowSendEmail(event, content)
                    }
            }
        }
    }

    private fun loadTaskTask(view: View): Job {
        return lifecycleScope.launch {
            val task = withContext(Dispatchers.IO) {
                var result: Task? = null
                val inputReader = StringReader(content)

                try {
                    result = Task.tasksFromReader(inputReader)[0]
                } catch (e: InvalidCalendarException) {
                    e.printStackTrace()
                } catch (e: IOException) {
                    e.printStackTrace()
                }
                result
            }

            if (task != null) {
                    val loader = view.findViewById<View>(R.id.task_info_loading_msg)
                    loader.visibility = View.GONE
                    val contentContainer = view.findViewById<View>(R.id.task_info_scroll_view)
                    contentContainer.visibility = View.VISIBLE

                    setTextViewText(view, R.id.title, task.summary)

                    setTextViewText(view, R.id.where, task.location)

                    val organizer = task.organizer
                    if (organizer != null) {
                        val tv = view.findViewById<View>(R.id.organizer) as TextView
                        tv.text = organizer.calAddress.toString().replaceFirst("mailto:".toRegex(), "")
                    } else {
                        val organizerView = view.findViewById<View>(R.id.organizer_container)
                        organizerView.visibility = View.GONE
                    }

                    setTextViewText(view, R.id.description, task.description)
            }
        }
    }

    /**
     * Renders the contact into [view] only. The parse can finish before the coroutine first
     * suspends, so it may render right away; the view lifecycle scope cancels it with that view.
     */
    private fun loadContactTask(view: View): Job {
        return viewLifecycleOwner.lifecycleScope.launch {
            val contact = withContext(Dispatchers.IO) {
                var result: Contact? = null
                val reader = StringReader(content)

                try {
                    result = Contact.fromReader(reader, null)[0]
                } catch (e: IOException) {
                    e.printStackTrace()
                }
                result
            }

            if (contact != null) {
                    val loader = view.findViewById<View>(R.id.loading_msg)
                    loader.visibility = View.GONE
                    val contentContainer = view.findViewById<View>(R.id.content_container)
                    contentContainer.visibility = View.VISIBLE

                    val tv = view.findViewById<View>(R.id.display_name) as TextView
                    tv.text = contact.displayName

                    if (contact.group) {
                        showGroup(view, contact)
                    } else {
                        showContact(view, contact)
                    }
            }
        }
    }


    private fun showGroup(view: View, contact: Contact) {
        val mainCard = view.findViewById<View>(R.id.main_card) as ViewGroup

        addInfoItem(view.context, mainCard, getString(R.string.journal_item_member_count), null, contact.members.size.toString())

        for (member in contact.members) {
            addInfoItem(view.context, mainCard, getString(R.string.journal_item_member), null, member)
        }
    }


    private fun showContact(view: View, contact: Contact) {
        val mainCard = view.findViewById<View>(R.id.main_card) as ViewGroup
        val aboutCard = view.findViewById<View>(R.id.about_card) as ViewGroup
        aboutCard.findViewById<View>(R.id.title_container).visibility = View.VISIBLE

        // TEL
        for (labeledPhone in contact.phoneNumbers) {
            val types = labeledPhone.property.types
            val type = if (types.size > 0) types[0].value else null
            addInfoItem(view.context, mainCard, getString(R.string.journal_item_phone), type, labeledPhone.property.text)
        }

        // EMAIL
        for (labeledEmail in contact.emails) {
            val types = labeledEmail.property.types
            val type = if (types.size > 0) types[0].value else null
            addInfoItem(view.context, mainCard, getString(R.string.journal_item_email), type, labeledEmail.property.value)
        }

        // ORG, TITLE, ROLE
        if (contact.organization != null) {
            addInfoItem(view.context, aboutCard, getString(R.string.journal_item_organization), contact.jobTitle, contact.organization?.values!![0])
        }
        if (contact.jobDescription != null) {
            addInfoItem(view.context, aboutCard, getString(R.string.journal_item_job_description), null, contact.jobTitle)
        }

        // IMPP
        for (labeledImpp in contact.impps) {
            addInfoItem(view.context, mainCard, getString(R.string.journal_item_impp), labeledImpp.property.protocol, labeledImpp.property.handle)
        }

        // NICKNAME
        if (contact.nickName != null && !contact.nickName?.values?.isEmpty()!!) {
            addInfoItem(view.context, aboutCard, getString(R.string.journal_item_nickname), null, contact.nickName?.values!![0])
        }

        // ADR
        for (labeledAddress in contact.addresses) {
            val types = labeledAddress.property.types
            val type = if (types.size > 0) types[0].value else null
            addInfoItem(view.context, mainCard, getString(R.string.journal_item_address), type, labeledAddress.property.label)
        }

        // NOTE
        if (contact.note != null) {
            addInfoItem(view.context, aboutCard, getString(R.string.journal_item_note), null, contact.note)
        }

        // URL
        for (labeledUrl in contact.urls) {
            addInfoItem(view.context, aboutCard, getString(R.string.journal_item_website), null, labeledUrl.property.value)
        }

        // ANNIVERSARY
        if (contact.anniversary != null) {
            addInfoItem(view.context, aboutCard, getString(R.string.journal_item_anniversary), null, getDisplayedDate(contact.anniversary?.date, contact.anniversary?.partialDate))
        }
        // BDAY
        if (contact.birthDay != null) {
            addInfoItem(view.context, aboutCard, getString(R.string.journal_item_birthday), null, getDisplayedDate(contact.birthDay?.date, contact.birthDay?.partialDate))
        }

        // RELATED
        for (related in contact.relations) {
            val types = related.types
            val type = if (types.size > 0) types[0].value else null
            addInfoItem(view.context, aboutCard, getString(R.string.journal_item_relation), type, related.text)
        }

        // PHOTO
        // if (contact.photo != null)
    }

    private fun getDisplayedDate(date: Date?, partialDate: PartialDate?): String? {
        if (date != null) {
            val epochDate = date.time
            return getDisplayedDatetime(epochDate, epochDate, true, context)
        } else if (partialDate != null){
            val formatter = SimpleDateFormat("d MMMM", Locale.getDefault())
            val calendar = GregorianCalendar()
            calendar.set(Calendar.DAY_OF_MONTH, partialDate.date!!)
            calendar.set(Calendar.MONTH, partialDate.month!! - 1)
            return formatter.format(calendar.time)
        }

        return null
    }

    companion object {
        fun newInstance(cachedCollection: CachedCollection, content: String): PrettyFragment {
            val ret = PrettyFragment()
            ret.cachedCollection = cachedCollection
            ret.content = content
            return ret
        }

        private fun addInfoItem(context: Context, parent: ViewGroup, type: String, label: String?, value: String?): View {
            val layout = parent.findViewById<View>(R.id.container) as ViewGroup
            val infoItem = LayoutInflater.from(context).inflate(R.layout.contact_info_item, layout, false)
            layout.addView(infoItem)
            setTextViewText(infoItem, R.id.type, type)
            setTextViewText(infoItem, R.id.title, label)
            setTextViewText(infoItem, R.id.content, value)
            parent.visibility = View.VISIBLE

            return infoItem
        }

        private fun setTextViewText(parent: View, id: Int, text: String?) {
            val tv = parent.findViewById<View>(id) as TextView
            if (text == null) {
                tv.visibility = View.GONE
            } else {
                tv.text = text
            }
        }

        fun getDisplayedDatetime(startMillis: Long, endMillis: Long, allDay: Boolean, context: Context?): String? {
            // Configure date/time formatting.
            val flagsDate = DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_WEEKDAY
            var flagsTime = DateUtils.FORMAT_SHOW_TIME
            if (DateFormat.is24HourFormat(context)) {
                flagsTime = flagsTime or DateUtils.FORMAT_24HOUR
            }

            val datetimeString: String
            if (allDay) {
                // For multi-day allday events or single-day all-day events that are not
                // today or tomorrow, use framework formatter.

                // We need to remove 24hrs because full day events are from the start of a day until the start of the next
                var adjustedEnd = endMillis - 24 * 60 * 60 * 1000;
                if (adjustedEnd < startMillis) {
                    adjustedEnd = startMillis;
                }
                val f = Formatter(StringBuilder(50), Locale.getDefault())
                datetimeString = DateUtils.formatDateRange(context, f, startMillis,
                        adjustedEnd, flagsDate).toString()
            } else {
                // For multiday events, shorten day/month names.
                // Example format: "Fri Apr 6, 5:00pm - Sun, Apr 8, 6:00pm"
                val flagsDatetime = flagsDate or flagsTime or DateUtils.FORMAT_ABBREV_MONTH or
                        DateUtils.FORMAT_ABBREV_WEEKDAY
                datetimeString = DateUtils.formatDateRange(context, startMillis, endMillis,
                        flagsDatetime)
            }
            return datetimeString
        }
    }
}
