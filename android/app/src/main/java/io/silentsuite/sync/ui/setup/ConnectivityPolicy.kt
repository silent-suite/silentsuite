package io.silentsuite.sync.ui.setup

import android.content.Context
import android.net.ConnectivityManager


object ConnectivityPolicy {
    fun isConnected(context: Context): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return manager.activeNetwork?.let { manager.getNetworkCapabilities(it)?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) } == true
    }
}
