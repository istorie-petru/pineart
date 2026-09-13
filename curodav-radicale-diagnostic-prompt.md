# Diagnose: does curodav's Radicale/DAV setup actually need its own public hostname?

## Background

I just went through this exact confusion on a sibling project (Pineart), and
it turned out to be a non-issue there: I assumed a service (SearXNG) wasn't
reachable behind a Cloudflare Tunnel, and asked for it to be exposed at its
own public hostname to fix it. It turned out the tunnel was never in that
service's request path at all — the app's own backend called it over
loopback (127.0.0.1), process-to-process, with zero network hop through
Cloudflare. The actual blocker was a frontend UI gate (a nav item hidden
until a DB setting was flipped on), unrelated to networking entirely.

Before I do the same thing to curodav's Radicale setup, I want this checked
properly rather than assumed either way. Radicale is a different situation
in one important respect: CalDAV/CardDAV *clients* (a phone's Calendar app,
Thunderbird, a contacts app) speak the DAV protocol directly to Radicale —
they do not go through curodav's own web frontend the way a browser does.
That's a real, structural reason Radicale might need its own public
reachability, unlike SearXNG which was purely an internal dependency the
backend called on its own behalf.

## What I need answered

1. **How do curodav's own web UI features that touch calendars/contacts
   reach Radicale?** Read whatever backend code proxies or calls Radicale
   (grep for "radicale" across the backend). Is it a server-side HTTP call
   from curodav's backend process to Radicale over loopback (the SearXNG
   pattern — no tunnel involvement, works regardless of what's exposed
   publicly), or does the *browser* itself talk to Radicale directly (via
   some redirect, iframe, or client-side fetch to a Radicale URL)?

2. **Do actual external CalDAV/CardDAV clients need to reach Radicale
   directly, bypassing curodav's own frontend entirely?** This is the real
   question. If the intended use case is "point your phone's Calendar app at
   https://dav.example.com" as a standalone DAV server, then yes, Radicale
   genuinely needs public reachability — that's not the same mistake I made
   with SearXNG. Check curodav's own README/docs for how users are actually
   told to configure their DAV clients.

3. **Read `scripts/curodav-ctl` and `deploy/cloudflared/config.yml.template`
   (or equivalent) and check: is Radicale already given its own
   `hostname:`/`service:` ingress pair in the Cloudflare Tunnel config, the
   way Pineart's README describes as the correct pattern for "a future
   service that needs its own public hostname"? Or is it currently only
   bound to loopback with no route in at all?**

4. **If Radicale currently has no public route and no client actually needs
   direct DAV access** (i.e. it's purely an internal dependency like
   SearXNG), then exposing it publicly would be solving a problem that
   doesn't exist, and would introduce the same kind of consideration I hit
   with SearXNG: check whether Radicale's own auth/rate-limiting is
   sufficient to be safely internet-facing before recommending that path —
   don't assume it's fine by default.

## What I want back

A clear verdict: is this the SearXNG situation (internal-only, exposing it
publicly would be pointless and introduces new risk) or the genuinely
different situation (external DAV clients need direct access, so a public
hostname is a real requirement, not a workaround for a UI bug)? If the
latter, confirm whether that public route already exists and is correctly
configured, or is actually missing and needs to be added.
