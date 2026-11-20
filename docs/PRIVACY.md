# Privacy notice

Last updated: 19 November 2026.

This notice describes DvalinCode's CLI, desktop app, and public documentation
website. Local storage does not mean every feature operates offline.

## Local application data

Configuration, provider credentials when saved, sessions, and audit records
are stored on the machine running DvalinCode, generally under `~/.dvalincode/`.
Workspace files, scanner output, remediation worktrees, exports, and test
results may also be written in locations selected by the workflow. These
records can contain prompts, source context, file paths, tool output, and
other sensitive project information. Protect them with operating-system file
permissions and review them before sharing or publishing them.

The application does not include a general-purpose analytics or advertising
SDK. The public documentation website has separate visit analytics described
below. Maintainers do not receive local sessions or audit logs automatically
through an application telemetry service.

## Network use and third parties

| Feature | Data and destination |
| --- | --- |
| AI models | Prompts, selected source context, conversation content, and tool results may be sent to the configured model endpoint. Local endpoints are available; hosted providers apply their own processing and retention policies. |
| Built-in scanner | Inspects local development files without requiring a model API key. |
| External scanners | User-installed engines have their own network behavior. Semgrep may fetch rules; Trivy may fetch advisory data; OSV-Scanner may contact advisory services. The Semgrep command sets `--metrics off`. |
| Optional Snyk engines | Not in the default scanner set. Snyk Code sends source for remote analysis; dependency scanning may transmit dependency information. These engines require explicit selection and Snyk credentials. |
| Web search and fetch | Search terms go to the selected search service; fetched URLs go to their target hosts. Free web search is enabled by default and can use Exa without an API key when the search tool runs. Users can disable free search in Settings → LLM Providers → Web search, or configure another backend. |
| GitHub and integrations | Requested repository operations, remote MCP tools, and other configured integrations send the information required for the operation to the selected service. Review their configuration and permissions. |
| Updates and installation | CLI update commands and supported macOS desktop startup checks contact GitHub for release metadata. Desktop update downloads require confirmation; `DVALINCODE_GUI_DISABLE_UPDATE=1` disables the macOS desktop check. Windows setup may download and install Microsoft's WebView2 Runtime if it is missing. |

These services receive ordinary connection metadata such as the source IP
address. DvalinCode cannot set their retention periods or delete copies held
by an external provider. Review the policies of the particular services you
enable, including [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement),
[OpenAI](https://openai.com/policies/privacy-policy/),
[Anthropic](https://www.anthropic.com/legal/privacy),
[Snyk](https://snyk.io/policies/privacy/), and
[Exa](https://exa.ai/privacy). Other providers, scanners, MCP servers, and
custom endpoints have their own policies. A local model does not by itself
disable search, updates, external scanners, or integration traffic.

Organization policy can constrain supported network operations. Its limits
and documented exemptions are described in the
[egress threat model](EGRESS-THREAT-MODEL.md); it is not a guarantee that
arbitrary user-installed programs cannot access the network.

## Documentation website

The `dvalincode.dev` documentation website is hosted through GitHub Pages and
loads GoatCounter for page-visit statistics, including page paths, referrers,
and browser/device information. This is separate from application usage and
does not upload workspace files or application sessions. See
[GoatCounter's privacy policy](https://www.goatcounter.com/help/privacy) and
GitHub's privacy policy for their processing practices.

## Control, deletion, and contact

Choose the providers and integrations appropriate for your data, disable
unwanted search and update features, and avoid putting secrets into prompts
or exported reports. Stop the application before removing its local data;
back up anything you need first. Uninstalling the executable may leave user
configuration, sessions, audit logs, and workspace artifacts in place.
Requests about data already sent to another service must be directed to that
service.

For project privacy questions, contact
[the maintainer](https://github.com/arthurpanhku). Use
[private vulnerability reporting](https://github.com/arthurpanhku/dvalincode/security/advisories/new)
for sensitive security disclosures; do not post private data in public issues.
