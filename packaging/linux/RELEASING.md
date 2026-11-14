# Linux releases on GitLab

A `v*` tag pipeline builds a signed OSTree repository and a
`GnomeLegionLight.flatpak` bundle. The manual `publish-release` job deploys the
repository to GitLab Pages at
`https://kestermckinney.gitlab.io/gnomelegionlight/flatpak/`.

## One-time setup

1. Create the **public** GitLab project `kestermckinney/gnomelegionlight` (the
   Flatpak app ID `io.gitlab.kestermckinney.GnomeLegionLight` must resolve to it;
   the Flathub linter checks it) and push this repository.
2. Enable GitLab Pages with public access and disable **Use unique domain** so the
   stable URL above serves the repository without redirects.
3. Protect `v*` tags and add protected CI/CD variables. This project signs with the
   same key as Legion Light (its public key is in `gnomelegionlight.flatpakrepo`),
   so copy the values from the Legion Light project:

   | Variable | Type | Contents |
   | --- | --- | --- |
   | `FLATPAK_GPG_PRIVATE_KEY` | File | `LegionLight/.release-secrets/flatpak-signing-private.asc` |
   | `FLATPAK_GPG_KEY_ID` | Variable | `LegionLight/.release-secrets/fingerprint.txt` |
   | `FLATPAK_GPG_PASSPHRASE` | Masked variable | Only if the key has a passphrase (this one has none) |

   Never commit the private key. CI refuses to sign with any key other than the
   one embedded in `gnomelegionlight.flatpakrepo`.
4. Use a runner that can run Flatpak/bubblewrap builds (a self-managed Docker runner
   may need privileged mode).

## Cut a release

1. Make sure `Cargo.lock` pins a pushed `legion_light` commit
   (`cargo update -p legion_light` after pushing Legion Light).
2. Bump `version` in `Cargo.toml` and `shell-extension/metadata.json`, and add a
   `<release>` to `packaging/linux/io.gitlab.kestermckinney.GnomeLegionLight.metainfo.xml`.
3. Commit, push, then tag: `git tag v0.1.0 && git push origin v0.1.0`.
   CI checks that the tag matches `Cargo.toml`.
4. Review the `flatpak-release` artifacts, then run `publish-release`.

## Local build

```bash
./packaging/linux/build-flatpak.sh setup          # once
GLL_REF=local ./packaging/linux/build-flatpak.sh install   # build working tree and install
flatpak run io.gitlab.kestermckinney.GnomeLegionLight --setup
```

`GLL_REF` selects the source: `latest` tag (default), `local` working tree, `pinned`
manifest commit, or any tag/branch/SHA. For a signed local repo set `GPG_KEY_ID`,
`GPG_HOMEDIR`, `APP_REPO_URL`, then run `repo` and `bundle`.

## Known limits

- Crates and the `legion_light` library are downloaded during the Flatpak build
  (`--share=network`). Flathub would require offline sources from
  `flatpak-cargo-generator`.
- The Flathub linter flags `--device=all` and the write access to
  `xdg-data/gnome-shell/extensions`; the self-hosted repo has no such gate.
- A Flatpak cannot install a shell extension when it is installed. The user opens
  Legion Light once (`--setup`) and logs in again; later updates are copied by the
  daemon and load at the next login.
