// Dynamic config (not app.json) so android.googleServicesFile can fall back
// to an EAS file environment variable on build servers, where the real
// google-services.json is gitignored and never gets uploaded with the
// project archive — see documentation.md for the full story.
module.exports = {
  expo: {
    name: 'chat-app',
    slug: 'message-app',
    scheme: 'chatapp',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'dark',
    backgroundColor: '#1e2321',
    assetBundlePatterns: ['**/*'],
    web: {
      bundler: 'metro',
    },
    android: {
      package: 'com.chatapp.mobile',
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
      adaptiveIcon: {
        backgroundColor: '#1e2321',
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
