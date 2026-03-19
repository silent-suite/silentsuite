/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.vcard4android

import ezvcard.Ezvcard
import ezvcard.VCard
import ezvcard.VCardVersion
import ezvcard.parameter.AddressType
import ezvcard.parameter.EmailType
import ezvcard.parameter.ImageType
import ezvcard.parameter.TelephoneType
import ezvcard.property.*
import ezvcard.util.PartialDate
import org.apache.commons.lang3.StringUtils
import org.apache.commons.lang3.builder.HashCodeBuilder
import org.apache.commons.lang3.builder.ReflectionToStringBuilder
import java.io.IOException
import java.io.OutputStream
import java.io.Reader
import java.net.URI
import java.net.URISyntaxException
import java.util.*
import java.util.concurrent.atomic.AtomicInteger
import java.util.logging.Level

class Contact {

    var uid: String? = null
    var group = false

    /** list of UIDs of group members without urn:uuid prefix (only meaningful if [group] is true) */
    val members = LinkedList<String>()

    var displayName: String? = null
    var prefix: String? = null
    var givenName: String? = null
    var middleName: String? = null
    var familyName: String? = null
    var suffix: String? = null

    var phoneticGivenName: String? = null
    var phoneticMiddleName: String? = null
    var phoneticFamilyName: String? = null

    var nickName: Nickname? = null

    var organization: Organization? = null
    var jobTitle: String? = null           // VCard TITLE
    var jobDescription: String? = null     // VCard ROLE

    val phoneNumbers = LinkedList<LabeledProperty<Telephone>>()
    val emails = LinkedList<LabeledProperty<Email>>()
    val impps = LinkedList<LabeledProperty<Impp>>()
    val addresses = LinkedList<LabeledProperty<Address>>()
    val categories = LinkedList<String>()
    val urls = LinkedList<LabeledProperty<Url>>()
    val relations = LinkedList<Related>()

    var note: String? = null

    var anniversary: Anniversary? = null
    var birthDay: Birthday? = null

    var photo: ByteArray? = null

    /** unknown properties in text VCARD format */
    var unknownProperties: String? = null


    companion object {
        // productID (if set) will be used to generate a PRODID property.
        // You may set this statically from the calling application.
        var productID: String? = null

        const val PROPERTY_ADDRESSBOOKSERVER_KIND = "X-ADDRESSBOOKSERVER-KIND"
        const val PROPERTY_ADDRESSBOOKSERVER_MEMBER = "X-ADDRESSBOOKSERVER-MEMBER"

        const val PROPERTY_PHONETIC_FIRST_NAME = "X-PHONETIC-FIRST-NAME"
        const val PROPERTY_PHONETIC_MIDDLE_NAME = "X-PHONETIC-MIDDLE-NAME"
        const val PROPERTY_PHONETIC_LAST_NAME = "X-PHONETIC-LAST-NAME"
        const val PROPERTY_SIP = "X-SIP"

        val PHONE_TYPE_CALLBACK = TelephoneType.get("x-callback")!!
        val PHONE_TYPE_COMPANY_MAIN = TelephoneType.get("x-company_main")!!
        val PHONE_TYPE_RADIO = TelephoneType.get("x-radio")!!
        val PHONE_TYPE_ASSISTANT = TelephoneType.get("X-assistant")!!
        val PHONE_TYPE_MMS = TelephoneType.get("x-mms")!!
        /** Sometimes used to denote an "other" phone numbers. Only for compatibility – don't use it yourself! */
        val PHONE_TYPE_OTHER = TelephoneType.get("other")!!

        /** Custom email type to denote "mobile" email addresses. */
        val EMAIL_TYPE_MOBILE = EmailType.get("x-mobile")!!
        /** Sometimes used to denote an "other" email address. Only for compatibility – don't use it yourself! */
        val EMAIL_TYPE_OTHER = EmailType.get("other")!!

        /** Sometimes used to denote an "other" postal address. Only for compatibility – don't use it yourself! */
        val ADDRESS_TYPE_OTHER = AddressType.get("other")!!

        const val NICKNAME_TYPE_MAIDEN_NAME = "x-maiden-name"
        const val NICKNAME_TYPE_SHORT_NAME = "x-short-name"
        const val NICKNAME_TYPE_INITIALS = "x-initials"
        const val NICKNAME_TYPE_OTHER_NAME = "x-other-name"

        const val URL_TYPE_HOMEPAGE = "x-homepage"
        const val URL_TYPE_BLOG = "x-blog"
        const val URL_TYPE_PROFILE = "x-profile"
        const val URL_TYPE_FTP = "x-ftp"

        const val DATE_PARAMETER_OMIT_YEAR = "X-APPLE-OMIT-YEAR"
        const val DATE_PARAMETER_OMIT_YEAR_DEFAULT = 1604


        /**
         * Parses an InputStream that contains a vCard.
         *
         * @param reader     reader for the input stream containing the vCard (pay attention to the charset)
         * @param downloader will be used to download external resources like contact photos (may be null)
         * @return list of filled Event data objects (may have size 0) – doesn't return null
         * @throws IOException on I/O errors when reading the stream
         * @throws ezvcard.io.CannotParseException when the vCard can't be parsed
         */
        fun fromReader(reader: Reader, downloader: Downloader?): List<Contact>  {
            val vcards = Ezvcard.parse(reader).all()
            val contacts = LinkedList<Contact>()
            vcards?.forEach { contacts += fromVCard(it, downloader) }
            return contacts
        }

        private fun fromVCard(vCard: VCard, downloader: Downloader?): Contact {
            val c = Contact()

            // get X-ABLabels
            val labels = vCard.getExtendedProperties(LabeledProperty.PROPERTY_AB_LABEL)!!
            vCard.removeExtendedProperty(LabeledProperty.PROPERTY_AB_LABEL)

            fun findLabel(group: String?): String? {
                if (group == null)
                    return null
                return labels.firstOrNull { it.group.equals(group, true) }?.value
            }

            // process standard properties
            val toRemove = LinkedList<VCardProperty>()
            for (prop in vCard.properties) {
                var remove = true
                when (prop) {
                    is Uid -> c.uid = uriToUID(prop.value)
                    is Kind -> c.group = prop.isGroup
                    is Member -> uriToUID(prop.uri)?.let { c.members += it }

                    is FormattedName -> c.displayName = prop.value.trim()
                    is StructuredName -> {
                        c.prefix = StringUtils.trimToNull(prop.prefixes.joinToString(" "))
                        c.givenName = StringUtils.trimToNull(prop.given)
                        c.middleName = StringUtils.trimToNull(prop.additionalNames.joinToString(" "))
                        c.familyName = StringUtils.trimToNull(prop.family)
                        c.suffix = StringUtils.trimToNull(prop.suffixes.joinToString(" "))
                    }
                    is Nickname -> c.nickName = prop

                    is Organization -> c.organization = prop
                    is Title -> c.jobTitle = StringUtils.trimToNull(prop.value)
                    is Role -> c.jobDescription = StringUtils.trimToNull(prop.value)

                    is Telephone -> if (!prop.text.isNullOrBlank())
                        c.phoneNumbers += LabeledProperty(prop, findLabel(prop.group))
                    is Email -> if (!prop.value.isNullOrBlank())
                        c.emails += LabeledProperty(prop, findLabel(prop.group))
                    is Impp -> c.impps += LabeledProperty(prop, findLabel(prop.group))
                    is Address -> c.addresses += LabeledProperty(prop, findLabel(prop.group))

                    is Note -> c.note = if (c.note.isNullOrEmpty()) prop.value else "${c.note}\n\n\n${prop.value}"
                    is Url -> c.urls += LabeledProperty(prop, findLabel(prop.group))
                    is Categories -> c.categories.addAll(prop.values)

                    is Birthday -> c.birthDay = checkVCard3PartialDate(prop)
                    is Anniversary -> c.anniversary = checkVCard3PartialDate(prop)

                    is Related -> StringUtils.trimToNull(prop.text)?.let { c.relations += prop }
                    is Photo ->
                        c.photo = prop.data ?: prop.url?.let { url ->
                            downloader?.let {
                                Constants.log.info("Downloading photo from $url")
                                it.download(url, "image/*")
                            }
                        }

                    // remove binary properties because of potential OutOfMemory / TransactionTooLarge exceptions
                    is Logo, is Sound -> { /* remove = true */ }

                    // remove properties that don't apply anymore
                    is ProductId,
                    is Revision,
                    is SortString,
                    is Source -> {
                        /* remove = true */
                    }

                    else -> remove = false      // don't remove unknown properties
                }

                if (remove)
                    toRemove += prop
            }
            toRemove.forEach { vCard.removeProperty(it) }

            // process extended properties
            val extToRemove = LinkedList<RawProperty>()
            for (prop in vCard.extendedProperties) {
                var remove = true
                when (prop.propertyName) {
                    PROPERTY_ADDRESSBOOKSERVER_KIND ->
                        if (prop.value.equals(Kind.GROUP, true))
                            c.group = true

                    PROPERTY_ADDRESSBOOKSERVER_MEMBER ->
                        uriToUID(prop.value)?.let { c.members += it }

                    PROPERTY_PHONETIC_FIRST_NAME  -> c.phoneticGivenName = StringUtils.trimToNull(prop.value)
                    PROPERTY_PHONETIC_MIDDLE_NAME -> c.phoneticMiddleName = StringUtils.trimToNull(prop.value)
                    PROPERTY_PHONETIC_LAST_NAME   -> c.phoneticFamilyName = StringUtils.trimToNull(prop.value)

                    PROPERTY_SIP -> c.impps += LabeledProperty(Impp("sip", prop.value), findLabel(prop.group))

                    else -> remove = false      // don't remove unknown extended properties
                }

                if (remove)
                    extToRemove += prop
            }
            extToRemove.distinct().forEach { vCard.removeExtendedProperty(it.propertyName) }

            if (c.uid == null) {
                Constants.log.warning("Received vCard without UID, generating new one")
                c.uid = UUID.randomUUID().toString()
            }

            // remove properties which
            // - couldn't be parsed (and thus are treated as extended/unknown properties), and
            // - must occur once max.
            arrayOf("ANNIVERSARY", "BDAY", "KIND", "N", "PRODID", "REV", "UID").forEach {
                vCard.removeExtendedProperty(it)
            }

            // store all remaining properties into unknownProperties
            if (vCard.properties.isNotEmpty() || vCard.extendedProperties.isNotEmpty())
                try {
                    c.unknownProperties = vCard.write()
                } catch(e: Exception) {
                    Constants.log.warning("Couldn't serialize unknown properties, dropping them")
                }

            return c
        }

        private fun uriToUID(uriString: String?): String? {
            if (uriString == null)
                return null
            return try {
                val uri = URI(uriString)
                when {
                    uri.scheme == null ->
                        uri.schemeSpecificPart
                    uri.scheme.equals("urn", true) && uri.schemeSpecificPart.startsWith("uuid:", true) ->
                        uri.schemeSpecificPart.substring(5)
                    else ->
                        null
                }
            } catch(e: URISyntaxException) {
                Constants.log.warning("Invalid URI for UID: $uriString")
                uriString
            }
        }

        private fun<T: DateOrTimeProperty> checkVCard3PartialDate(property: T): T {
            property.date?.let { date ->
                property.getParameter(DATE_PARAMETER_OMIT_YEAR)?.let { omitYearStr ->
                    try {
                        val omitYear = Integer.parseInt(omitYearStr)
                        val cal = GregorianCalendar.getInstance()
                        cal.time = date
                        if (cal.get(GregorianCalendar.YEAR) == omitYear) {
                            val partial = PartialDate.builder()
                                    .date(cal.get(GregorianCalendar.DAY_OF_MONTH))
                                    .month(cal.get(GregorianCalendar.MONTH) + 1)
                                    .build()
                            property.partialDate = partial
                        }
                    } catch(e: NumberFormatException) {
                        Constants.log.log(Level.WARNING, "Unparseable $DATE_PARAMETER_OMIT_YEAR")
                    } finally {
                        property.removeParameter(DATE_PARAMETER_OMIT_YEAR)
                    }
                }
            }
            return property
        }

    }


    @Throws(IOException::class)
    fun write(vCardVersion: VCardVersion, groupMethod: GroupMethod, os: OutputStream) {
        var vCard = VCard()
        try {
            unknownProperties?.let { vCard = Ezvcard.parse(unknownProperties).first() }
        } catch (e: Exception) {
            Constants.log.fine("Couldn't parse original vCard with retained properties")
        }

        // UID
        uid?.let { vCard.uid = Uid(it) }
        // PRODID
        productID?.let { vCard.setProductId(it) }

        // group support
        if (group && groupMethod == GroupMethod.GROUP_VCARDS) {
            if (vCardVersion == VCardVersion.V4_0) {
                vCard.kind = Kind.group()
                members.forEach { vCard.members += Member("urn:uuid:$it") }
            } else {    // "vCard4 as vCard3" (Apple-style)
                vCard.setExtendedProperty(PROPERTY_ADDRESSBOOKSERVER_KIND, Kind.GROUP)
                members.forEach { vCard.addExtendedProperty(PROPERTY_ADDRESSBOOKSERVER_MEMBER, "urn:uuid:$it") }
            }
        }

        // FN
        var fn = displayName
        if (fn.isNullOrEmpty())
            organization?.let {
                for (part in it.values) {
                    fn = part
                    if (!fn.isNullOrEmpty())
                        break
                }
            }
        if (fn.isNullOrEmpty())
            nickName?.let { fn = it.values.firstOrNull() }
        if (fn.isNullOrEmpty())
            emails.firstOrNull()?.let { fn = it.property.value }
        if (fn.isNullOrEmpty())
            phoneNumbers.firstOrNull()?.let { fn = it.property.text }
        if (fn.isNullOrEmpty())
            fn = uid ?: ""
        vCard.setFormattedName(fn)

        // N
        if (prefix != null || familyName != null || middleName != null || givenName != null || suffix != null) {
            val n = StructuredName()
            prefix?.let { it.split(' ').forEach { singlePrefix -> n.prefixes += singlePrefix } }
            n.given = givenName
            middleName?.let { it.split(' ').forEach { singleName -> n.additionalNames += singleName } }
            n.family = familyName
            suffix?.let { it.split(' ').forEach { singleSuffix -> n.suffixes += singleSuffix } }
            vCard.structuredName = n

        } else if (vCardVersion == VCardVersion.V3_0) {
            // (only) vCard 3 requires N [RFC 2426 3.1.2]
            if (group && groupMethod == GroupMethod.GROUP_VCARDS) {
                val n = StructuredName()
                n.family = fn
                vCard.structuredName = n
            } else
                vCard.structuredName = StructuredName()
        }

        // NICKNAME
        nickName?.let { vCard.nickname = it }

        // phonetic names
        phoneticGivenName?.let { vCard.addExtendedProperty(PROPERTY_PHONETIC_FIRST_NAME, it) }
        phoneticMiddleName?.let { vCard.addExtendedProperty(PROPERTY_PHONETIC_MIDDLE_NAME, it) }
        phoneticFamilyName?.let { vCard.addExtendedProperty(PROPERTY_PHONETIC_LAST_NAME, it) }

        // ORG, TITLE, ROLE
        organization?.let { vCard.organization = it }
        jobTitle?.let { vCard.addTitle(it) }
        jobDescription?.let { vCard.addRole(it) }

        // will be used to count "davdroidXX." property groups
        val labelIterator = AtomicInteger()

        fun addLabel(labeledProperty: LabeledProperty<VCardProperty>) {
            labeledProperty.label?.let {
                val group = "group${labelIterator.incrementAndGet()}"
                labeledProperty.property.group = group

                val label = vCard.addExtendedProperty(LabeledProperty.PROPERTY_AB_LABEL, it)
                label.group = group
            }
        }

        // TEL
        for (labeledPhone in phoneNumbers) {
            val phone = labeledPhone.property
            vCard.addTelephoneNumber(phone)
            addLabel(labeledPhone)
        }

        // EMAIL
        for (labeledEmail in emails) {
            val email = labeledEmail.property
            vCard.addEmail(email)
            addLabel(labeledEmail)
        }

        // IMPP
        for (labeledImpp in impps) {
            val impp = labeledImpp.property
            vCard.addImpp(impp)
            addLabel(labeledImpp)
        }

        // ADR
        for (labeledAddress in addresses) {
            val address = labeledAddress.property
            vCard.addAddress(address)
            addLabel(labeledAddress)
        }

        // NOTE
        note?.let { vCard.addNote(it) }

        // URL
        for (labeledUrl in urls) {
            val url = labeledUrl.property
            vCard.addUrl(url)
            addLabel(labeledUrl)
        }

        // CATEGORIES
        if (!categories.isEmpty()) {
            val cat = Categories()
            cat.values.addAll(categories)
            vCard.categories = cat
        }

        // ANNIVERSARY, BDAY
        fun<T: DateOrTimeProperty> dateOrPartialDate(prop: T, generator: (Date) -> T): T? {
            if (vCardVersion == VCardVersion.V4_0 || prop.date != null)
                return prop
            else prop.partialDate?.let { partial ->
                // vCard 3: partial date with month and day, but without year
                if (partial.date != null && partial.month != null) {
                    return if (partial.year != null)
                        // partial date is a complete date
                        prop
                    else {
                        // vCard 3: partial date with month and day, but without year
                        val fakeCal = GregorianCalendar.getInstance()
                        fakeCal.set(DATE_PARAMETER_OMIT_YEAR_DEFAULT, partial.month - 1, partial.date)
                        val fakeProp = generator(fakeCal.time)
                        fakeProp.addParameter(DATE_PARAMETER_OMIT_YEAR, DATE_PARAMETER_OMIT_YEAR_DEFAULT.toString())
                        fakeProp
                    }
                }
            }
            return null
        }
        anniversary?.let { vCard.anniversary = dateOrPartialDate(it) { time -> Anniversary(time, false) } }
        birthDay?.let { vCard.birthday = dateOrPartialDate(it) { time -> Birthday(time, false) } }

        // RELATED
        relations.forEach { vCard.addRelated(it) }

        // PHOTO
        photo?.let { vCard.addPhoto(Photo(photo, ImageType.JPEG)) }

        // REV
        vCard.revision = Revision.now()

        // validate vCard and log results
        val validation = vCard.validate(vCardVersion)
        if (!validation.isEmpty) {
            val msgs = LinkedList<String>()
            for ((key, warnings) in validation)
                msgs += "  * " + key.javaClass.simpleName + " - " + warnings.joinToString(" | ")
            Constants.log.log(Level.WARNING, "vCard validation warnings", msgs.joinToString(","))
        }

        // generate VCARD
        Ezvcard .write(vCard)
                .version(vCardVersion)
                .versionStrict(false)      // allow vCard4 properties in vCard3s
                .caretEncoding(true)           // enable RFC 6868 support
                .prodId(productID == null)
                .go(os)
    }


    private fun compareFields(): Array<Any?> = arrayOf(
        uid,
        group,
        members,
        displayName, prefix, givenName, middleName, familyName, suffix,
        phoneticGivenName, phoneticMiddleName, phoneticFamilyName,
        nickName,
        organization, jobTitle, jobDescription,
        phoneNumbers, emails, impps, addresses,
        /* categories, */ urls, relations,
        note, anniversary, birthDay,
        photo
        /* unknownProperties */
    )

    override fun hashCode(): Int {
        val builder = HashCodeBuilder(29, 3).append(compareFields())
        return builder.toHashCode()
    }

    override fun equals(other: Any?) =
        if (other is Contact)
            compareFields().contentDeepEquals(other.compareFields())
        else
            false

    override fun toString(): String {
        val builder = ReflectionToStringBuilder(this)
        builder.setExcludeFieldNames("photo")
        return builder.toString()
    }


    interface Downloader {
        fun download(url: String, accepts: String): ByteArray?
    }

}
