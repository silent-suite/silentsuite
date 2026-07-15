package io.silentsuite.sync.ui.setup

import android.content.Context
import android.net.ConnectivityManager
import android.os.Build

object ConnectivityPolicy {
    fun isConnected(context: Context): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            manager.activeNetwork?.let { manager.getNetworkCapabilities(it)?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) } == true
        } else {
            @Suppress("DEPRECATION") manager.activeNetworkInfo?.isConnected == true
        }
    }
}
