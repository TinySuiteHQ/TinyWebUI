# Security

New installs require an owner password before the server listens. Interactive
starts prompt for one; headless starts refuse to run until `tinywebui
set-password` has written a hash into the persistent config, or
`TINYWEBUI_PASSWORD` is provided. The bundled Compose file binds only to the
host's loopback interface. An explicit `authMode: "none"` is allowed only on a
loopback bind. For access from another machine, put the app behind HTTPS and
use password login or a trusted identity gateway. With password login behind
a reverse proxy, set `trustedProxyCidrs` to that proxy's address range and
forward `X-Forwarded-Proto: https` so session cookies receive the `Secure`
attribute. Do not publish the app's plain HTTP port directly to the network.

Pull requests, changes to `main`, release tags, and a weekly scheduled run are
scanned with Trivy. The workflow checks repository and Docker configuration,
source dependency vulnerabilities and exposed secrets, and the built default
hybrid Docker image for vulnerabilities and secrets. It fails on `CRITICAL` or
`HIGH` findings; vulnerability scans ignore issues without a fix available.

See [`.github/workflows/security.yml`](.github/workflows/security.yml) for the
enforced checks.

Please report security issues privately through
[GitHub Security Advisories](https://github.com/TinySuiteHQ/TinyWebUI/security/advisories/new)
rather than filing a public issue.
