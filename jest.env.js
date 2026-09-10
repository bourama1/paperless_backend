// Clear TLS cert paths so test runs on developer machines don't attempt
// to open cert files that only exist on the production server.
delete process.env.SSL_PFX_PATH;
delete process.env.SSL_PFX_PASSPHRASE;
delete process.env.SSL_CERT_PATH;
delete process.env.SSL_KEY_PATH;
