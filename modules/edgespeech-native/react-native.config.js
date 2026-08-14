// React Native autolinking configuration.
//
// This is a bare (non-Expo) C++ TurboModule that lives in the app repo and is
// linked as a local `file:` dependency. On iOS the module is provided through
// the podspec + codegenConfig.ios.modulesProvider. Android wiring (cxxModule*
// keys) is added when Android support lands — the shared cpp/ is already
// structured for it.
module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: __dirname + '/edgespeech.podspec',
      },
    },
  },
}
