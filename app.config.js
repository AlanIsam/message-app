// Dynamic config (not app.json) so android.googleServicesFile can fall back
// to an EAS file environment variable on build servers, where the real
// google-services.json is gitignored and never gets uploaded with the
// project archive — see documentation.md for the full story.
module.exports = {
  expo: {
    // Display name only — slug/scheme/package id are already tied to the
    // linked EAS project, Firebase Android app, and build credentials, so
    // they're deliberately left as-is (see documentation.md).
    name: 'Randau',
    slug: 'message-app',
    scheme: 'chatapp',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'dark',
    backgroundColor: '#1e2321',
    assetBundlePatterns: ['**/*'],
    icon: './assets/icon.png',
    web: {
      bundler: 'metro',
      favicon: './assets/icon.png',
    },
    android: {
      package: 'com.chatapp.mobile',
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#16a34a',
      },
    },
    plugins: [
      'expo-router',
      [
        'expo-notifications',
        {
          icon: './assets/notification-icon.png',
          color: '#22c55e',
        },
      ],
    ],
    extra: {
      router: {
        origin: false,
      },
      eas: {
        projectId: 'aca7eada-6165-4d89-8a38-908d54da23a7',
      },
    },
    owner: 'alanisams-team',
  },
}
