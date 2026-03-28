/**
 * Expo Config Plugin: withSyncAdapter
 *
 * Adds the Android sync adapter manifest entries, XML resources,
 * permissions, and the NativeSyncModule bridge required for the
 * SilentSuite Kotlin sync adapter integration.
 *
 * Usage in app.json:
 *   "plugins": ["./plugins/withSyncAdapter"]
 *
 * This plugin is idempotent — safe to run on every prebuild.
 *
 * What this plugin generates:
 * - AndroidManifest.xml permissions (contacts, calendar, sync, accounts)
 * - AndroidManifest.xml sync adapter service declarations
 * - res/xml/ sync adapter descriptor files
 * - NativeSyncModule.kt (React Native <-> Android sync bridge)
 * - NativeSyncPackage.kt (React Native package registration)
 *
 * The actual Kotlin sync engine source files must be manually copied from
 * silentsuite-android/ into the android/ directory. See B4.2-INTEGRATION.md.
 */
const { withAndroidManifest, withDangerousMod, withMainApplication } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withSyncAdapter(config) {
  // Step 1: Add permissions and sync adapter services to AndroidManifest.xml
  config = withAndroidManifest(config, async (config) => {
    const manifest = config.modResults.manifest;

    // Ensure tools namespace is available
    if (!manifest.$) {
      manifest.$ = {};
    }
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    // Add required permissions
    const permissions = [
      'android.permission.READ_CONTACTS',
      'android.permission.WRITE_CONTACTS',
      'android.permission.READ_CALENDAR',
      'android.permission.WRITE_CALENDAR',
      'android.permission.READ_SYNC_SETTINGS',
      'android.permission.WRITE_SYNC_SETTINGS',
      'android.permission.AUTHENTICATE_ACCOUNTS',
      'android.permission.GET_ACCOUNTS',
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.ACCESS_WIFI_STATE',
    ];

    if (!manifest['uses-permission']) {
      manifest['uses-permission'] = [];
    }
    const existingPerms = new Set(manifest['uses-permission'].map((p) => p.$?.['android:name']));
    for (const perm of permissions) {
      if (!existingPerms.has(perm)) {
        manifest['uses-permission'].push({ $: { 'android:name': perm } });
      }
    }

    // Add sync adapter services to <application>
    const app = manifest.application?.[0];
    if (app) {
      if (!app.service) {
        app.service = [];
      }

      const existingServices = new Set(app.service.map((s) => s.$?.['android:name']));

      const servicesToAdd = [
        // Account Authenticator
        {
          $: {
            'android:name': 'io.silentsuite.sync.syncadapter.AccountAuthenticatorService',
            'android:exported': 'false',
          },
          'intent-filter': [{ action: [{ $: { 'android:name': 'android.accounts.AccountAuthenticator' } }] }],
          'meta-data': [
            {
              $: {
                'android:name': 'android.accounts.AccountAuthenticator',
                'android:resource': '@xml/authenticator',
              },
            },
          ],
        },
        // Address Book NullAuthenticatorService (must be exported for Android 11+ contacts visibility)
        {
          $: {
            'android:name': 'io.silentsuite.sync.syncadapter.NullAuthenticatorService',
            'android:exported': 'true',
          },
          'intent-filter': [{ action: [{ $: { 'android:name': 'android.accounts.AccountAuthenticator' } }] }],
          'meta-data': [
            {
              $: {
                'android:name': 'android.accounts.AccountAuthenticator',
                'android:resource': '@xml/account_authenticator_address_book',
              },
            },
          ],
        },
        // Address Books Sync Adapter
        {
          $: {
            'android:name': 'io.silentsuite.sync.syncadapter.AddressBooksSyncAdapterService',
            'android:exported': 'true',
            'android:process': ':sync',
            'tools:ignore': 'ExportedService',
          },
          'intent-filter': [{ action: [{ $: { 'android:name': 'android.content.SyncAdapter' } }] }],
          'meta-data': [
            {
              $: {
                'android:name': 'android.content.SyncAdapter',
                'android:resource': '@xml/sync_address_books',
              },
            },
          ],
        },
        // Contacts Sync Adapter
        {
          $: {
            'android:name': 'io.silentsuite.sync.syncadapter.ContactsSyncAdapterService',
            'android:exported': 'true',
            'android:process': ':sync',
            'tools:ignore': 'ExportedService',
          },
          'intent-filter': [{ action: [{ $: { 'android:name': 'android.content.SyncAdapter' } }] }],
          'meta-data': [
            {
              $: {
                'android:name': 'android.content.SyncAdapter',
                'android:resource': '@xml/sync_contacts',
              },
            },
            {
              $: {
                'android:name': 'android.provider.CONTACTS_STRUCTURE',
                'android:resource': '@xml/contacts',
              },
            },
          ],
        },
        // Calendar Sync Adapter
        {
          $: {
            'android:name': 'io.silentsuite.sync.syncadapter.CalendarsSyncAdapterService',
            'android:exported': 'true',
            'android:process': ':sync',
            'tools:ignore': 'ExportedService',
          },
          'intent-filter': [{ action: [{ $: { 'android:name': 'android.content.SyncAdapter' } }] }],
          'meta-data': [
            {
              $: {
                'android:name': 'android.content.SyncAdapter',
                'android:resource': '@xml/sync_calendars',
              },
            },
          ],
        },
        // Account Update Service
        {
          $: {
            'android:name': 'io.silentsuite.sync.AccountUpdateService',
            'android:exported': 'false',
            'android:enabled': 'true',
          },
        },
      ];

      for (const svc of servicesToAdd) {
        if (!existingServices.has(svc.$['android:name'])) {
          app.service.push(svc);
        }
      }

      // Add AddressBookProvider
      if (!app.provider) {
        app.provider = [];
      }
      const existingProviders = new Set(app.provider.map((p) => p.$?.['android:name']));
      if (!existingProviders.has('io.silentsuite.sync.syncadapter.AddressBookProvider')) {
        app.provider.push({
          $: {
            'android:name': 'io.silentsuite.sync.syncadapter.AddressBookProvider',
            'android:authorities': 'io.silentsuite.sync.addressbooks',
            'android:exported': 'false',
            'android:label': 'Address books',
            'android:multiprocess': 'false',
          },
        });
      }

      // Add NotificationHandlerActivity
      if (!app.activity) {
        app.activity = [];
      }
      const existingActivities = new Set(app.activity.map((a) => a.$?.['android:name']));
      if (!existingActivities.has('io.silentsuite.sync.syncadapter.SyncNotification$NotificationHandlerActivity')) {
        app.activity.push({
          $: {
            'android:name': 'io.silentsuite.sync.syncadapter.SyncNotification$NotificationHandlerActivity',
            'android:exported': 'false',
            'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
          },
        });
      }

      // Add PackageChangedReceiver
      if (!app.receiver) {
        app.receiver = [];
      }
      const existingReceivers = new Set(app.receiver.map((r) => r.$?.['android:name']));
      if (!existingReceivers.has('io.silentsuite.sync.PackageChangedReceiver')) {
        app.receiver.push({
          $: {
            'android:name': 'io.silentsuite.sync.PackageChangedReceiver',
            'android:exported': 'true',
          },
          'intent-filter': [{
            action: [
              { $: { 'android:name': 'android.intent.action.PACKAGE_ADDED' } },
              { $: { 'android:name': 'android.intent.action.PACKAGE_FULLY_REMOVED' } },
            ],
            data: [{ $: { 'android:scheme': 'package' } }],
          }],
        });
      }
    }

    return config;
  });

  // Step 2: Create sync adapter XML resources
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const resDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(resDir, { recursive: true });

      // Authenticator descriptor
      const authenticator = `<?xml version="1.0" encoding="utf-8"?>
<account-authenticator xmlns:android="http://schemas.android.com/apk/res/android"
    android:accountType="io.silentsuite.sync"
    android:icon="@mipmap/ic_launcher"
    android:smallIcon="@mipmap/ic_launcher"
    android:label="SilentSuite"
    android:accountPreferences="@xml/sync_prefs" />
`;

      // Contacts sync adapter
      const contactsSync = `<?xml version="1.0" encoding="utf-8"?>
<sync-adapter xmlns:android="http://schemas.android.com/apk/res/android"
    android:contentAuthority="com.android.contacts"
    android:accountType="io.silentsuite.sync"
    android:supportsUploading="true"
    android:isAlwaysSyncable="true"
    android:allowParallelSyncs="false"
    android:userVisible="true" />
`;

      // Calendar sync adapter
      const calendarSync = `<?xml version="1.0" encoding="utf-8"?>
<sync-adapter xmlns:android="http://schemas.android.com/apk/res/android"
    android:contentAuthority="com.android.calendar"
    android:accountType="io.silentsuite.sync"
    android:supportsUploading="true"
    android:isAlwaysSyncable="true"
    android:allowParallelSyncs="false"
    android:userVisible="true" />
`;

      // Sync preferences (minimal)
      const syncPrefs = `<?xml version="1.0" encoding="utf-8"?>
<PreferenceScreen xmlns:android="http://schemas.android.com/apk/res/android">
    <PreferenceCategory android:title="SilentSuite Sync" />
</PreferenceScreen>
`;

      // Address book authenticator descriptor
      const addressBookAuthenticator = `<?xml version="1.0" encoding="utf-8"?>
<account-authenticator xmlns:android="http://schemas.android.com/apk/res/android"
    android:accountType="io.silentsuite.sync.address_book"
    android:icon="@mipmap/ic_launcher"
    android:label="SilentSuite Address book"
    android:smallIcon="@mipmap/ic_launcher"
    android:accountPreferences="@xml/sync_prefs" />
`;

      // Address books sync adapter
      const addressBooksSync = `<?xml version="1.0" encoding="utf-8"?>
<sync-adapter xmlns:android="http://schemas.android.com/apk/res/android"
    android:accountType="io.silentsuite.sync"
    android:contentAuthority="io.silentsuite.sync.addressbooks"
    android:isAlwaysSyncable="true"
    android:supportsUploading="false" />
`;

      // Contacts structure descriptor
      const contactsStructure = `<?xml version="1.0" encoding="utf-8"?>
<ContactsAccountType>
    <EditSchema>
        <DataKind kind="name" maxOccurs="1" supportsDisplayName="true"
            supportsFamilyName="true" supportsMiddleName="true"
            supportsPhoneticFamilyName="true" supportsPhoneticGivenName="true"
            supportsPhoneticMiddleName="true" supportsPrefix="true" supportsSuffix="true" />
        <DataKind kind="phone">
            <Type type="mobile" /><Type type="home" /><Type type="work" />
            <Type type="fax_work" /><Type type="fax_home" /><Type type="pager" />
            <Type type="other" /><Type type="custom" />
        </DataKind>
        <DataKind kind="email">
            <Type type="home" /><Type type="work" /><Type type="other" />
            <Type type="mobile" /><Type type="custom" />
        </DataKind>
        <DataKind kind="photo" maxOccurs="1" />
        <DataKind kind="organization" maxOccurs="1" />
        <DataKind kind="im">
            <Type type="aim" /><Type type="msn" /><Type type="yahoo" />
            <Type type="skype" /><Type type="qq" /><Type type="google_talk" />
            <Type type="icq" /><Type type="jabber" /><Type type="custom" />
        </DataKind>
        <DataKind kind="nickname" maxOccurs="1" />
        <DataKind kind="note" maxOccurs="1" />
        <DataKind kind="group_membership" maxOccurs="1" />
        <DataKind kind="postal" needsStructured="true">
            <Type type="home" /><Type type="work" /><Type type="other" /><Type type="custom" />
        </DataKind>
        <DataKind kind="website" />
        <DataKind kind="event" dateWithTime="false">
            <Type maxOccurs="1" type="birthday" yearOptional="true" />
            <Type maxOccurs="1" type="anniversary" yearOptional="true" />
        </DataKind>
        <DataKind kind="relationship">
            <Type type="assistant" /><Type type="brother" /><Type type="child" />
            <Type type="domestic_partner" /><Type type="father" /><Type type="friend" />
            <Type type="manager" /><Type type="mother" /><Type type="parent" />
            <Type type="partner" /><Type type="relative" /><Type type="sister" />
            <Type type="spouse" /><Type type="custom" />
        </DataKind>
        <DataKind kind="sip_address" maxOccurs="1" />
    </EditSchema>
</ContactsAccountType>
`;

      fs.writeFileSync(path.join(resDir, 'authenticator.xml'), authenticator);
      fs.writeFileSync(path.join(resDir, 'account_authenticator_address_book.xml'), addressBookAuthenticator);
      fs.writeFileSync(path.join(resDir, 'sync_contacts.xml'), contactsSync);
      fs.writeFileSync(path.join(resDir, 'sync_address_books.xml'), addressBooksSync);
      fs.writeFileSync(path.join(resDir, 'sync_calendars.xml'), calendarSync);
      fs.writeFileSync(path.join(resDir, 'sync_prefs.xml'), syncPrefs);
      fs.writeFileSync(path.join(resDir, 'contacts.xml'), contactsStructure);

      return config;
    },
  ]);

  // Step 3: Generate NativeSyncModule.kt and NativeSyncPackage.kt
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const kotlinDir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', 'io', 'silentsuite', 'app'
      );
      fs.mkdirSync(kotlinDir, { recursive: true });

      // NativeSyncModule.kt — React Native bridge to Android sync framework
      const nativeSyncModule = `package io.silentsuite.app

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.os.Bundle
import android.provider.CalendarContract
import android.provider.ContactsContract
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

class NativeSyncModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val ACCOUNT_TYPE = "io.silentsuite.sync"
        private const val MODULE_NAME = "NativeSyncModule"
    }

    override fun getName(): String = MODULE_NAME

    /**
     * Trigger an immediate sync for all authorities (contacts, calendar).
     */
    @ReactMethod
    fun triggerSync(promise: Promise) {
        try {
            val am = AccountManager.get(reactApplicationContext)
            val accounts = am.getAccountsByType(ACCOUNT_TYPE)

            if (accounts.isEmpty()) {
                promise.reject("NO_ACCOUNT", "No SilentSuite sync account found")
                return
            }

            val account = accounts[0]
            val extras = Bundle().apply {
                putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)
                putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)
            }

            ContentResolver.requestSync(account, ContactsContract.AUTHORITY, extras)
            ContentResolver.requestSync(account, CalendarContract.AUTHORITY, extras)

            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SYNC_ERROR", "Failed to trigger sync: \${e.message}", e)
        }
    }

    /**
     * Get the current sync status for the SilentSuite account.
     */
    @ReactMethod
    fun getSyncStatus(promise: Promise) {
        try {
            val am = AccountManager.get(reactApplicationContext)
            val accounts = am.getAccountsByType(ACCOUNT_TYPE)

            val result: WritableMap = Arguments.createMap()

            if (accounts.isEmpty()) {
                result.putDouble("lastSyncTime", 0.0)
                result.putBoolean("isSyncing", false)
                result.putString("errorMessage", "No SilentSuite sync account")
                result.putInt("calendarCount", 0)
                result.putInt("contactCount", 0)
                result.putInt("taskCount", 0)
                promise.resolve(result)
                return
            }

            val account = accounts[0]

            val contactsSyncing = ContentResolver.isSyncActive(account, ContactsContract.AUTHORITY)
            val calendarSyncing = ContentResolver.isSyncActive(account, CalendarContract.AUTHORITY)
            val isSyncing = contactsSyncing || calendarSyncing

            // Get last sync time from account manager user data
            val lastSyncStr = am.getUserData(account, "last_sync_time")
            val lastSyncTime = lastSyncStr?.toDoubleOrNull() ?: 0.0

            // Count synced items
            val calendarCount = countCalendars(account)
            val contactCount = countContacts(account)

            result.putDouble("lastSyncTime", lastSyncTime)
            result.putBoolean("isSyncing", isSyncing)
            result.putNull("errorMessage")
            result.putInt("calendarCount", calendarCount)
            result.putInt("contactCount", contactCount)
            result.putInt("taskCount", 0) // Tasks not yet integrated

            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("STATUS_ERROR", "Failed to get sync status: \${e.message}", e)
        }
    }

    /**
     * Enable or disable bridge mode (add/remove the sync account).
     */
    @ReactMethod
    fun setBridgeMode(enabled: Boolean, promise: Promise) {
        try {
            val am = AccountManager.get(reactApplicationContext)
            val accounts = am.getAccountsByType(ACCOUNT_TYPE)

            if (enabled) {
                if (accounts.isEmpty()) {
                    // Create the sync account
                    val account = Account("SilentSuite", ACCOUNT_TYPE)
                    val success = am.addAccountExplicitly(account, null, null)
                    if (!success) {
                        promise.reject("ACCOUNT_ERROR", "Failed to create sync account")
                        return
                    }

                    // Enable auto-sync for contacts and calendar
                    ContentResolver.setIsSyncable(account, ContactsContract.AUTHORITY, 1)
                    ContentResolver.setSyncAutomatically(account, ContactsContract.AUTHORITY, true)
                    ContentResolver.addPeriodicSync(
                        account, ContactsContract.AUTHORITY, Bundle.EMPTY, 4 * 3600L
                    )

                    ContentResolver.setIsSyncable(account, CalendarContract.AUTHORITY, 1)
                    ContentResolver.setSyncAutomatically(account, CalendarContract.AUTHORITY, true)
                    ContentResolver.addPeriodicSync(
                        account, CalendarContract.AUTHORITY, Bundle.EMPTY, 4 * 3600L
                    )
                }
                promise.resolve(true)
            } else {
                // Remove all sync accounts
                for (account in accounts) {
                    am.removeAccountExplicitly(account)
                }
                promise.resolve(false)
            }
        } catch (e: Exception) {
            promise.reject("BRIDGE_ERROR", "Failed to set bridge mode: \${e.message}", e)
        }
    }

    private fun countCalendars(account: Account): Int {
        return try {
            val cr = reactApplicationContext.contentResolver
            val cursor = cr.query(
                CalendarContract.Calendars.CONTENT_URI,
                arrayOf(CalendarContract.Calendars._ID),
                "\${CalendarContract.Calendars.ACCOUNT_NAME} = ? AND \${CalendarContract.Calendars.ACCOUNT_TYPE} = ?",
                arrayOf(account.name, ACCOUNT_TYPE),
                null
            )
            val count = cursor?.count ?: 0
            cursor?.close()
            count
        } catch (e: Exception) {
            0
        }
    }

    private fun countContacts(account: Account): Int {
        return try {
            val cr = reactApplicationContext.contentResolver
            val cursor = cr.query(
                ContactsContract.RawContacts.CONTENT_URI,
                arrayOf(ContactsContract.RawContacts._ID),
                "\${ContactsContract.RawContacts.ACCOUNT_NAME} = ? AND \${ContactsContract.RawContacts.ACCOUNT_TYPE} = ?",
                arrayOf(account.name, ACCOUNT_TYPE),
                null
            )
            val count = cursor?.count ?: 0
            cursor?.close()
            count
        } catch (e: Exception) {
            0
        }
    }
}
`;

      // NativeSyncPackage.kt — Register the native module with React Native
      const nativeSyncPackage = `package io.silentsuite.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class NativeSyncPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(NativeSyncModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;

      fs.writeFileSync(path.join(kotlinDir, 'NativeSyncModule.kt'), nativeSyncModule);
      fs.writeFileSync(path.join(kotlinDir, 'NativeSyncPackage.kt'), nativeSyncPackage);

      return config;
    },
  ]);

  // Step 4: Register NativeSyncPackage in MainApplication
  config = withMainApplication(config, (config) => {
    const contents = config.modResults.contents;

    // Add import if not present
    if (!contents.includes('import io.silentsuite.app.NativeSyncPackage')) {
      config.modResults.contents = contents.replace(
        'import com.facebook.react.defaults.DefaultReactNativeHost',
        'import com.facebook.react.defaults.DefaultReactNativeHost\nimport io.silentsuite.app.NativeSyncPackage'
      );
    }

    // Add package to getPackages if not present
    if (!config.modResults.contents.includes('NativeSyncPackage()')) {
      config.modResults.contents = config.modResults.contents.replace(
        'packages.add(MainReactPackage())',
        'packages.add(MainReactPackage())\n              packages.add(NativeSyncPackage())'
      );
      // Alternative pattern for newer Expo templates
      if (!config.modResults.contents.includes('NativeSyncPackage()')) {
        config.modResults.contents = config.modResults.contents.replace(
          'PackageList(this).packages',
          'PackageList(this).packages.apply { add(NativeSyncPackage()) }'
        );
      }
    }

    return config;
  });

  return config;
}

module.exports = withSyncAdapter;
