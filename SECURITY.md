# Security

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
