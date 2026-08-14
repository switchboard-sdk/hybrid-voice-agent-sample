const reactNativeConfig = require('@react-native/eslint-config/flat')
const prettierConfig = require('eslint-config-prettier')

const sourceFiles = [
  '*.{js,ts,tsx}',
  'src/**/*.{js,jsx,ts,tsx}',
  'modules/**/src/**/*.{js,jsx,ts,tsx}',
  '__mocks__/**/*.{js,ts,tsx}',
  'scripts/**/*.js',
]

// ft-flow (Flow types plugin) is incompatible with ESLint 9 and not needed in a
// TypeScript project.
const filteredReactNativeConfig = reactNativeConfig.filter((config) => !config.plugins?.['ft-flow'])

module.exports = [
  {
    ignores: ['node_modules/**', 'ios/**', 'android/**', '.expo/**', 'modules/*/ios/Frameworks/**'],
  },
  ...filteredReactNativeConfig.map((config) => ({ ...config, files: sourceFiles })),
  prettierConfig,
  {
    files: sourceFiles,
    rules: {
      'react-native/no-inline-styles': 'off',
    },
  },
]
