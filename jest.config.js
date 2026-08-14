// iOS-only app, so pin the platform preset rather than running jest-expo's
// universal multi-platform projects.
module.exports = {
  preset: 'jest-expo/ios',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testMatch: ['**/src/**/*.(test|spec).(ts|tsx)'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts'],
}
