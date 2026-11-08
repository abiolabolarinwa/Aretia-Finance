# Aretia mobile app (Android and iPhone)

The apps are a Capacitor shell (`capacitor.config.ts`, `android/`, `ios/`). They open the live wallet at
`https://aretiafinance.org/wallet` inside the app, so the website and the app are always the same pages and a web release reaches
the app without a store release. `native-www/index.html` is only the "can't connect" page shown when the site cannot be reached.

The website is unchanged by any of this. Code that only belongs in the app asks `isNativeApp()` (`src/lib/nativeApp.ts`) first.

## Run it on Android

1. Install [Android Studio](https://developer.android.com/studio) (it brings Java and the Android SDK).
2. From `website/`: `npm ci`, then `npm run app:sync`, then `npm run app:android` (opens the project in Android Studio).
3. Press Run, with an emulator or a phone in developer mode plugged in.

## Run it on iPhone

Needs a Mac with Xcode and CocoaPods. From `website/`: `npm ci`, `npm run app:sync`, `npm run app:ios`, then Run in Xcode.

## Not done yet

- Solana wallet connection from inside the app (Phantom and others cannot be injected into the page; needs Mobile Wallet Adapter on
  Android and WalletConnect or a wallet hand-off on iPhone).
- Push alerts, device unlock, store listings, app signing and release builds.
- Nothing here has been run on a device yet: the project files were generated and the website build was checked, but no one has
  launched the app.

## Regenerating the icons and splash screens

`resources/` holds the source images. `npx capacitor-assets generate --android --ios` rebuilds the native icons from them.
