// expo/android/build.gradle declares `namespace "expo.core"`, while the actual Kotlin class
// lives at `expo.modules.ExpoModulesPackage`. Override `packageImportPath` / `packageInstance`
// so `:expo` stays autolinked into `:app` (bringing expo-secure-store, expo-haptics, etc.)
// while `PackageList.java` imports the real package name.
module.exports = {
  dependencies: {
    expo: {
      platforms: {
        android: {
          packageImportPath: 'import expo.modules.ExpoModulesPackage;',
          packageInstance: 'new ExpoModulesPackage()',
        },
      },
    },
  },
};
