package io.silentsuite.sync.utils

import android.content.Context
import android.content.SharedPreferences
import androidx.preference.PreferenceManager

/**
 * Replacement for Anko's defaultSharedPreferences.
 * Extension property on Context to get default SharedPreferences.
 */
val Context.defaultSharedPreferences: SharedPreferences
    get() = PreferenceManager.getDefaultSharedPreferences(this)
