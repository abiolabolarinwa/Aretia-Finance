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

## First device test (Android)

Before you start: create a free WalletConnect project at dashboard.reown.com, allow `aretiafinance.org` for it, and set
`PUBLIC_WALLETCONNECT_PROJECT_ID` in the Cloudflare Pages build settings. The app loads the live site, so the site must have been
rebuilt with that setting before the phone wallet option appears. Have Phantom (or Solflare) installed on the phone.

1. Phone: Settings, About phone, tap Build number 7 times; then Settings, Developer options, turn on USB debugging. Plug the phone in
   and accept the prompt on it. (An emulator also works, but it has no wallet apps, so it only proves the shell, not the wallet.)
2. PC: `cd website`, `npm ci`, `npm run app:sync`, `npm run app:android`. Wait for Android Studio to finish "Gradle sync".
3. Pick your phone in the device list at the top and press Run (the green triangle).
4. Check, and write down what happens:
   - The app opens on the Aretia wallet (dashboard) with the black sidebar, not the "can't connect" page.
   - Markets, a token page (panel hide and show), Pay, Launch, Launch Box and Favourites open and scroll.
   - Links to block explorers open in the phone's browser, not inside the app.
   - Switch the phone to airplane mode and reopen the app: the "can't connect" page shows and Try again works afterwards.
5. Connect a wallet: Connect wallet, choose "WalletConnect (phone wallets)", tap Phantom. Phantom should open and ask to connect.
   Approve, and you should land back in Aretia showing your address. Then try signing something small (Favourites sign-in is the
   safest first one; do not start with a swap).

If something fails, send: what you tapped, what you expected, what happened, a screenshot, and (Android Studio, Logcat tab, filter
`Capacitor` or `chromium`) the red lines around the failure. For a wallet that did not open, say which wallet and whether the
"Copy the link" button worked in it.

## Not done yet

- Solana wallet connection from inside the app (Phantom and others cannot be injected into the page; needs Mobile Wallet Adapter on
  Android and WalletConnect or a wallet hand-off on iPhone).
- Push alerts, device unlock, store listings, app signing and release builds.
- Nothing here has been run on a device yet: the project files were generated and the website build was checked, but no one has
  launched the app.

## Regenerating the icons and splash screens

`resources/` holds the source images. `npx capacitor-assets generate --android --ios` rebuilds the native icons from them.
