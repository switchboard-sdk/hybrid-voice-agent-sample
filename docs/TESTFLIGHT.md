# TestFlight

Builds are manual, and deliberately not on CI: there is no iOS pipeline to
extend, and every hosted run would re-download the frameworks and archive a very
large app.

```bash
npm run testflight
```

That bumps the build number, prebuilds, archives, exports, validates and uploads.
Expect it to take a while — the vendored frameworks are most of the build.

Signing is automatic. Xcode creates the distribution certificate and the App
Store provisioning profile on the first run and registers the bundle ID,
authenticated by an App Store Connect API key rather than a signed-in Xcode. Put
the key ID and its issuer ID in `.env.appstore`, which is not tracked:

```
ASC_KEY_ID=...
ASC_ISSUER_ID=...
```

The team itself is `APPLE_TEAM_ID` in `.env`, not `app.json` — it belongs to
whoever is building rather than to the app, so a fork sets its own and leaves
tracked config alone. `app.config.js` layers it on at build time, and `expo
prebuild` reads the same variable, so a device build gets the team without a
second copy of it anywhere. Nothing there is `EXPO_PUBLIC_`, so none of it reaches
the JS bundle.

The `.p8` itself goes in `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8`.
Apple serves it once, on creation, and that path is the only one both `xcodebuild`
and `altool` look in.

The build number in `app.json` bumps on every upload, because App Store Connect
refuses one it has already seen for a version. Commit the bump. `--no-bump`
re-uploads under the current number, `--skip-prebuild` archives `ios/` as it
stands, and `--skip-upload` stops after validation with the `.ipa` on disk.

**Internal testers skip beta review.** An internal tester is an App Store Connect
user on the team, so adding one is an invitation there rather than a submission to
Apple. External testers need review instead — a day or two of waiting.

The `.ipa` is around 300 MB, which is over the threshold for installing over
cellular, so a first install needs WiFi. The language model is not in it: the app
fetches that on first launch, which is a second download and also WiFi-sized. A
tester wants both done before they need the app, not while they are holding it.

## Before the first upload

The signing and upload above run unattended. These do not, and none of them are
in the repo:

- An App Store Connect **app record**, whose name must be unique across the store
  and whose bundle ID is fixed once a build lands against it.
- An **App Store Connect API key** with the App Manager role, from Users and
  Access > Integrations.
- **Testers**, invited in App Store Connect and assigned to an internal group.
