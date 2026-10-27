# Aristotle for Android

A Trusted Web Activity (TWA) built with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap).
The app is a thin shell that opens https://worldlybee.github.io/aristotle/ full screen in Chrome, so
**web updates reach the Android app instantly**. A new APK is only needed when the shell itself
changes (name, icon, colours, package settings).

- `twa-manifest.json`: the app description Bubblewrap builds from
- `assetlinks.json`: must be served at `https://worldlybee.github.io/.well-known/assetlinks.json`
  (from the `WorldlyBee.github.io` repo) so Android hides the browser address bar

## Rebuilding

```bash
npm i -g @bubblewrap/cli          # needs JDK 17 and the Android SDK
mkdir build && cp twa-manifest.json build/ && cd build
cp /path/to/android.keystore .     # the signing key: kept OUT of this public repo
bubblewrap update --skipVersionUpgrade
bubblewrap build                   # bump appVersion / appVersionCode first for a new release
```

The signing key (`android.keystore`) and its password are **not** in this repo. Keep them safe:
losing them means the installed app can't be updated (Play Store listings excepted, if Play App
Signing is used).
