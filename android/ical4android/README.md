
[![build status](https://gitlab.com/bitfireAT/ical4android/badges/master/build.svg)](https://gitlab.com/bitfireAT/ical4android/builds)


# ical4android

ical4android is a library for Android that brings together iCalendar and Android.
It's a framework for

* parsing and generating iCalendar resources (using [ical4j](https://github.com/ical4j/ical4j))
  from/into data classes that are compatible with the Android Calendar Provider and
  third-party task providers,
* accessing the Android Calendar Provider (and third-party task providers) over a unified API.

It has been primarily developed for:

* [DAVx⁵](https://www.davx5.com)
* [ICSx⁵](https://icsx5.bitfire.at)

_This software is not affiliated to, nor has it been authorized, sponsored or otherwise approved
by Google LLC. Android is a trademark of Google LLC._

Generated KDoc: https://bitfireAT.gitlab.io/ical4android/dokka/ical4android/

Discussion: https://forums.bitfire.at/category/18/libraries

## How to use

You can use [jitpack.io to include ical4android](https://jitpack.io/#com.gitlab.bitfireAT/ical4android):

    allprojects {
        repositories {
            maven { url 'https://jitpack.io' }
        }
    }
    dependencies {
        implementation 'com.gitlab.bitfireAT:ical4android:<version>'  // see tags for latest version, like 1.0
        //implementation 'com.gitlab.bitfireAT:ical4android:master-SNAPSHOT'  // alternative
    }



## Contact

```
bitfire web engineering – Stockmann, Hirner GesnbR
Florastraße 27
2540 Bad Vöslau, AUSTRIA
```

Email: [play@bitfire.at](mailto:play@bitfire.at) (do not use this)


## License 

Copyright (C) bitfire web engineering (Ricki Hirner, Bernhard Stockmann) and contributors.

This program comes with ABSOLUTELY NO WARRANTY. This is free software, and you are welcome
to redistribute it under the conditions of the [GNU GPL v3](https://www.gnu.org/licenses/gpl-3.0.html).

