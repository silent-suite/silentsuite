SilentSuite needs a whole domain or subdomain of its own (for example `cal.example.org`); it cannot live in a sub-path. Browsers only allow its encryption over HTTPS, so install a trusted certificate (Let's Encrypt) for that domain.

The install downloads the published SilentSuite images from `ghcr.io` and checks them against pinned SHA-256 digests.
