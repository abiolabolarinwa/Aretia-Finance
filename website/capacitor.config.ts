import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android and iPhone apps. They open the live wallet at aretiafinance.org inside a native shell, so the app and the website
 * are always the same pages and a web release reaches the app without a store release. Native-only features (device unlock,
 * push, phone wallet connection) are added as Capacitor plugins and only run inside the shell (see src/lib/nativeApp.ts).
 *
 * native-www/ is only the page shown when the site cannot be reached (no connection): it is not a copy of the website.
 */
const config: CapacitorConfig = {
  appId: 'org.aretiafinance.app',
  appName: 'Aretia Finance',
  webDir: 'native-www',
  server: {
    url: 'https://aretiafinance.org/wallet',
    cleartext: false,
    // Pages of Aretia itself open inside the app; any other address (a block explorer, a token's website) opens in the system browser.
    allowNavigation: ['aretiafinance.org', 'www.aretiafinance.org'],
    errorPath: 'index.html',
  },
  android: {
    allowMixedContent: false,
    // Android 15 draws apps edge to edge; without this the page would sit under the status bar and the navigation buttons.
    adjustMarginsForEdgeToEdge: 'auto',
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: 'automatic',
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
