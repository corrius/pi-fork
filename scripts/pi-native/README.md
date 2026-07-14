# Pi native stack validation

`validate-stack.sh` reproduces the safe part of the local Pi native update pipeline. It resolves an official Pi release, creates a temporary checkout from its tag, replays the native-compaction stack with `cherry-pick`, and runs checks, the build, the full test suite, and a CLI smoke test.

It does not rebase, force-push, install Pi, or modify the stack branch.

```bash
./scripts/pi-native/validate-stack.sh
./scripts/pi-native/validate-stack.sh --version 0.80.6
```

The latest `@earendil-works/pi-coding-agent` npm version is used when `--version` is omitted. URLs, branch, and base commit can be overridden with the environment variables shown by `--help`.

The `pi-native-stack.yml` workflow polls npm and the remote stack hourly, and it can also be run manually for a specific version. Successful `official version + stack revision` combinations are cached, so unchanged scheduled runs finish without rebuilding.
