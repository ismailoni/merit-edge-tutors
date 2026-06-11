# Deploying to Northflank

This app must be deployed as a Node.js web service, not as static hosting. The Node server serves the frontend pages and the `/api/*` backend routes from the same public service.

## Recommended Northflank setup

1. Create a **Combined Service** from this repository.
2. Choose **Dockerfile** as the build option and use the repository root as the build context.
3. Expose port `3000` as an HTTP public port.
4. Add a persistent volume mounted at `/data`.
5. Add the runtime variables below.
6. Deploy, then open `/settings` to finish configuration.

## Runtime variables

Set these runtime variables on the Northflank service:

```env
PORT=3000
MERIT_DB_PATH=/data/merit-edge.sqlite
MERIT_ADMIN_PASSWORD=replace-with-a-strong-temporary-admin-password
MERIT_DEFAULT_FORM_ID=ican-registration
```

`MERIT_ADMIN_PASSWORD` is only used when the database does not already contain an admin password. After the first successful login, change the admin password in the Settings page.

## Persistent storage

The SQLite database stores admin credentials, form configuration, and submissions. Mount a Northflank persistent volume at `/data`, and keep `MERIT_DB_PATH=/data/merit-edge.sqlite` so the database survives restarts and redeploys.

If you deploy without a persistent volume, the service can still start, but admin settings and submissions may be lost when the container is replaced.

## First production login

1. Visit `https://<your-northflank-domain>/settings`.
2. Log in with `MERIT_ADMIN_PASSWORD`.
3. Change the password immediately.
4. Save the Apps Script URL, Google Sheet ID, form status, closed message, and subject lists.
5. Submit a test registration from `/` and confirm it appears in `/dashboard`.

## Health checks and smoke tests

Use these URLs after deployment:

- `/` should render the public registration form.
- `/api/forms/ican-registration/config` should return JSON public form configuration.
- `/settings` should show the admin login.
- `/dashboard` should show the admin login and then registration data after authentication.
