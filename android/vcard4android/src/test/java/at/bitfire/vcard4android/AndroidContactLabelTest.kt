package at.bitfire.vcard4android

import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidContactLabelTest {

    // Expected values are what commons-text 1.3 WordUtils.capitalize(String) returned for the
    // same inputs on 14 November 2026, before AndroidContact stopped using it.
    private val commonsText13 = listOf(
        "" to "",
        "my property" to "My Property",
        "a" to "A",
        "  leading and  double  spaces " to "  Leading And  Double  Spaces ",
        "tab\u0009separated\u0009not\u0009delimiter" to "Tab\u0009separated\u0009not\u0009delimiter",
        "new\u000aline" to "New\u000aline",
        "already Capital" to "Already Capital",
        "mIxEd cAsE" to "MIxEd CAsE",
        "123 abc" to "123 Abc",
        "-dash word" to "-dash Word",
        "école über" to "École Über",
        "ǆemal" to "ǅemal",
        "ǳ dz" to "ǲ Dz",
        "ß strasse" to "ß Strasse",
        "ı dotless" to "I Dotless",
        "straße" to "Straße",
        "αβγ δ" to "Αβγ Δ",
        "дом мир" to "Дом Мир",
        "𐐨 deseret" to "𐐀 Deseret",
        "日本 語" to "日本 語",
        "x nbsp" to "X nbsp",
        "emoji 😀 face" to "Emoji 😀 Face",
        "under_score kept" to "Under_score Kept",
    )

    @Test
    fun capitalizeWordsMatchesCommonsText13() {
        for ((input, expected) in commonsText13)
            assertEquals(input, expected, AndroidContact.capitalizeWords(input))
    }

    @Test
    fun xNameToLabelStripsPrefixAndCapitalizesWords() {
        assertEquals("My Property", AndroidContact.xNameToLabel("X-MY_PROPERTY"))
        assertEquals("Note To Self", AndroidContact.xNameToLabel("x-note_to_self"))
        assertEquals("  Double", AndroidContact.xNameToLabel("X-__DOUBLE"))
        assertEquals("", AndroidContact.xNameToLabel("X-"))
    }
}
