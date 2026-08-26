/**
 * Layers the signing identity onto app.json.
 *
 * The Apple team belongs to whoever is building, not to the app, so it comes from
 * `APPLE_TEAM_ID` in .env instead of tracked config. A fork sets its own and never
 * edits app.json. Unset, the team is simply absent and Xcode asks for one, which is
 * what a Simulator build or a fresh clone wants.
 *
 * Everything else lives in app.json, which Expo hands to this function as `config`.
 */
module.exports = ({ config }) => {
  const appleTeamId = process.env.APPLE_TEAM_ID

  if (!appleTeamId) {
    return config
  }

  return { ...config, ios: { ...config.ios, appleTeamId } }
}
